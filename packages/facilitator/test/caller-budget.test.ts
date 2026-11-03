/**
 * The engine's admission: each caller is held to its own hourly sponsor budget as well as the
 * network's, checked with the claim, and every claim records its caller.
 */
import { describe, expect, it } from "vitest";
import { Keypair, Networks, type rpc } from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  MemoryChannelPool,
  MemorySettlementLedger,
  SettlementEngine,
  SponsorBudget,
  withCaller,
  type ClaimDetails,
  type NetworkPolicy,
  type PreflightedPayment,
  type SettlementLedger,
} from "@rail402.dev/facilitator";

const NETWORK = "stellar:testnet";
const payload = {
  x402Version: 2,
  accepted: {},
  payload: { transaction: "AAAA" },
} as unknown as PaymentPayload;
const requirements = {
  scheme: "exact",
  network: NETWORK,
  asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  payTo: "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO",
  amount: "1",
  maxTimeoutSeconds: 60,
  extra: {},
} as PaymentRequirements;
let nonce = 0;
const payment = () =>
  ({
    transfer: { from: "GPAYER" },
    authorization: { nonce: BigInt(++nonce) },
  }) as unknown as PreflightedPayment;

function setup(options: { keyless?: bigint } = {}) {
  const memory = new MemorySettlementLedger();
  const claims: ClaimDetails[] = [];
  const ledger: SettlementLedger = Object.assign(Object.create(memory) as SettlementLedger, {
    claim: (...args: Parameters<SettlementLedger["claim"]>) => {
      claims.push(args[4] ?? {});
      return memory.claim(...args);
    },
  });
  const channel = Keypair.random();
  const channels = new MemoryChannelPool([channel.publicKey()]);
  const refusals: string[] = [];
  const engine = new SettlementEngine({
    network: NETWORK,
    passphrase: Networks.TESTNET,
    rpcUrl: "http://127.0.0.1:1/rpc",
    server: {} as rpc.Server,
    policy: { maxTransactionFeeStroops: 100_000 } as NetworkPolicy,
    ledger,
    channels,
    channelKeys: new Map([[channel.publicKey(), channel]]),
    sponsor: Keypair.random(),
    timing: { channelWaitMs: 0 },
    guard: new SponsorBudget({
      network: NETWORK,
      ledger,
      balance: () => 10_000_000_000n,
      minBalanceStroops: 0n,
      maxSpendPerHourStroops: 1_000_000n,
      ...(options.keyless === undefined ? {} : { keylessSpendPerHourStroops: options.keyless }),
      onRefusal: (limit) => refusals.push(limit),
    }),
  });
  // Keep the only channel busy: an admitted settlement stops at the lease, its claim recorded first.
  void channels.acquire(0);
  return { engine, memory, claims, refusals };
}

/** Fees committed for `caller`, as earlier settlements of it left them. */
async function commit(memory: MemorySettlementLedger, caller: string, fee: string) {
  const { record } = await memory.claim(
    { network: NETWORK, payer: `G${caller}`, nonce: String(++nonce) },
    { payloadHash: "x", requestHash: String(nonce) },
    "o",
    60_000,
    { caller },
  );
  await memory.recordEnvelope(record.id, "o", {
    channel: "GCH",
    transactionHash: nonce.toString(16).padStart(64, "0"),
    innerTransactionHash: "b".repeat(64),
    envelopeXdr: "AAAA",
    validUntil: 1,
    maxFeeStroops: fee,
  });
}

describe("per-party refusals", () => {
  it.each([
    ["payer_rate", "settle_exact_stellar_payer_rate_limited"],
    ["payto_rate", "settle_exact_stellar_payto_rate_limited"],
    ["payer_cooldown", "settle_exact_stellar_payer_cooldown"],
  ] as const)("answers a %s refusal with %s, and passes the payTo to the guard", async (limit, code) => {
    const seen: (string | undefined)[] = [];
    const channel = Keypair.random();
    const engine = new SettlementEngine({
      network: NETWORK,
      passphrase: Networks.TESTNET,
      rpcUrl: "http://127.0.0.1:1/rpc",
      server: {} as rpc.Server,
      policy: { maxTransactionFeeStroops: 100_000 } as NetworkPolicy,
      ledger: new MemorySettlementLedger(),
      channels: new MemoryChannelPool([channel.publicKey()]),
      channelKeys: new Map([[channel.publicKey(), channel]]),
      sponsor: Keypair.random(),
      guard: {
        admit: (context) => {
          seen.push(context?.payTo);
          return Promise.resolve({ ok: false, reason: "limited", limit });
        },
      },
    });
    expect(await engine.settle(payload, requirements, payment())).toMatchObject({
      success: false,
      errorReason: code,
      errorMessage: "limited",
    });
    expect(seen).toEqual([requirements.payTo]);
  });
});

describe("caller budgets", () => {
  it("records the caller of every claim, public when none is set", async () => {
    const { engine, claims } = setup();
    await withCaller({ subject: "key:acme-prod-1" }, () => engine.settle(payload, requirements, payment()));
    await engine.settle(payload, requirements, payment());
    expect(claims.map((claim) => claim.caller)).toEqual(["key:acme-prod-1", "public"]);
    // The reservation is the fee ceiling, against the network budget.
    expect(claims[0]).toMatchObject({
      reserveFeeStroops: 100_000n,
      limits: [{ scope: "network", capStroops: 1_000_000n }],
    });
  });

  it("stops one key at its hourly sponsor budget while another key keeps settling", async () => {
    const { engine, memory, refusals } = setup();
    await commit(memory, "key:a", "250000");
    const budget = 300_000n;
    const refused = await withCaller({ subject: "key:a", sponsorBudgetStroopsPerHour: budget }, () =>
      engine.settle(payload, requirements, payment()),
    );
    expect(refused).toMatchObject({
      success: false,
      errorReason: "settle_exact_stellar_caller_budget_exhausted",
    });
    expect(refused.errorMessage).toMatch(/caller's hourly fee budget/);
    const other = await withCaller({ subject: "key:b", sponsorBudgetStroopsPerHour: budget }, () =>
      engine.settle(payload, requirements, payment()),
    );
    // Admitted: it gets as far as the (busy) channel pool.
    expect(other.errorReason).toBe("settle_exact_stellar_channel_unavailable");
    expect(refusals).toEqual(["caller_budget"]);
  });

  it("holds keyless callers to one shared budget, never a key holder", async () => {
    const { engine, memory } = setup({ keyless: 150_000n });
    await commit(memory, "public", "100000");
    expect((await engine.settle(payload, requirements, payment())).errorReason).toBe(
      "settle_exact_stellar_caller_budget_exhausted",
    );
    const keyed = await withCaller({ subject: "key:c" }, () =>
      engine.settle(payload, requirements, payment()),
    );
    expect(keyed.errorReason).toBe("settle_exact_stellar_channel_unavailable");
  });

  it("refuses with the network code once the network budget would be exceeded", async () => {
    const { engine, memory } = setup();
    await commit(memory, "key:d", "950000");
    expect(
      (await withCaller({ subject: "key:e" }, () => engine.settle(payload, requirements, payment())))
        .errorReason,
    ).toBe("settle_exact_stellar_sponsor_unavailable");
  });
});
