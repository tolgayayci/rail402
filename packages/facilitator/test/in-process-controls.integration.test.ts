/**
 * What an in-process facilitator offers in place of the service's access keys, limits and metering,
 * on the private Stellar network, with every request to a Rail402 host refused:
 *
 * - authentication is the host application's: it maps its own credential to a `CallerContext` and runs
 *   the settlement inside `withCaller`, or refuses the request;
 * - each caller's hourly sponsor budget and service fee come with that context (`withCaller`);
 * - `SponsorBudget` bounds what the sponsor spends per hour on the network, `SettleLimits` how many
 *   settlements one payer may start;
 * - `assets` decides which tokens are settled;
 * - the settlement ledger records each settlement's caller and service fee (`usageSince`).
 *
 * Needs `docker compose --profile stellar up -d`.
 */
import https from "node:https";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  MemorySettlementLedger,
  SettleLimits,
  SponsorBudget,
  acceptedAsset,
  createStellarFacilitator,
  deriveChannelKeypairs,
  inProcessClient,
  provisionChannels,
  withCaller,
  type CallerContext,
  type NetworkSetup,
} from "@rail402.dev/facilitator";
import {
  LocalNetwork,
  guardEgress,
  requirementsFor,
  type EgressGuard,
  type IssuedAsset,
} from "@rail402.dev/testkit";

const net = new LocalNetwork();
const available = await net.available();
const NETWORK = "stellar:testnet";
const PRICE = 1_000_000n;
const MAX_FEE = 2_000_000;
const INCLUSION_FEE = 100;
/** What one exact settlement reserves against the hourly budgets: the fee ceiling plus one bid. */
const RESERVATION = BigInt(MAX_FEE + INCLUSION_FEE);

/** A per-minute counter standing in for the host's limiter store. */
function counter() {
  const counts = new Map<string, number>();
  return (key: string, perMinute: number) => {
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    return next > perMinute ? 30 : 0;
  };
}

async function sponsorWithChannels(): Promise<Keypair> {
  const sponsor = Keypair.random();
  await net.fund(sponsor);
  await provisionChannels({
    server: net.server,
    passphrase: net.passphrase,
    sponsor,
    channels: deriveChannelKeypairs(sponsor, NETWORK, 2),
  });
  return sponsor;
}

describe.skipIf(!available)("in-process controls: caller, budgets, limits, assets and fees", () => {
  let guard: EgressGuard;
  let usdc: IssuedAsset;
  let eurc: IssuedAsset;
  let seller: Keypair;
  let ledger: MemorySettlementLedger;
  let client: FacilitatorClient;
  let sponsorBalance: bigint | undefined;

  /** The host application's own credentials: each maps to the caller its settlements run as. */
  const callers = new Map<string, CallerContext>([
    [
      "alice-secret",
      { subject: "key:alice", sponsorBudgetStroopsPerHour: RESERVATION, serviceFeeUsd: "0.001" },
    ],
    ["bob-secret", { subject: "key:bob", serviceFeeUsd: "0.0025" }],
  ]);

  /**
   * The host's settle route: authentication is the host's own; the facilitator learns who asks only
   * through `withCaller`.
   */
  async function hostSettle(request: Request): Promise<Response> {
    const caller = callers.get(request.headers.get("x-api-key") ?? "");
    if (caller === undefined) return Response.json({ error: "unauthorized" }, { status: 401 });
    const { payload, requirements } = (await request.json()) as {
      payload: PaymentPayload;
      requirements: PaymentRequirements;
    };
    return Response.json(await withCaller(caller, () => client.settle(payload, requirements)));
  }

  const settleAs = async (key: string | undefined, payer: Keypair) => {
    const requirements = requirementsFor(usdc.sac, seller.publicKey(), PRICE) as PaymentRequirements;
    const payload = (await net.payment(
      payer,
      requirementsFor(usdc.sac, seller.publicKey(), PRICE),
    )) as PaymentPayload;
    const response = await hostSettle(
      new Request("http://host.local/settle", {
        method: "POST",
        headers: { "content-type": "application/json", ...(key === undefined ? {} : { "x-api-key": key }) },
        body: JSON.stringify({ payload, requirements }),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  beforeAll(async () => {
    guard = guardEgress();
    [usdc, eurc] = await Promise.all([net.issueAsset("USDC"), net.issueAsset("EURC")]);
    [seller] = (await net.holders(usdc, 1, "0")) as [Keypair];
    const sponsor = await sponsorWithChannels();
    ledger = new MemorySettlementLedger();
    sponsorBalance = 10_000_000_000n;
    const setup: NetworkSetup = {
      network: NETWORK,
      rpcUrl: net.rpcUrl,
      sponsorSecret: sponsor.secret(),
      channelCount: 2,
      ledger,
      assets: [acceptedAsset({ contract: usdc.sac, symbol: "USDC", decimals: 7 }, { minAmount: 1_000n })],
      policy: { maxTransactionFeeStroops: MAX_FEE, inclusionFeeStroops: INCLUSION_FEE },
      guard: new SettleLimits({
        network: NETWORK,
        inner: new SponsorBudget({
          network: NETWORK,
          ledger,
          balance: () => sponsorBalance,
          minBalanceStroops: 1_000_000_000n,
          refuseWhileUnknown: true,
          maxSpendPerHourStroops: 10n * RESERVATION,
        }),
        take: counter(),
        payerPerMinute: 1,
        failClosed: true,
      }),
    };
    client = inProcessClient(createStellarFacilitator({ networks: [setup] }));
  }, 180_000);

  afterAll(() => {
    guard.restore();
  });

  it("refuses the host's request without a credential it knows, before the facilitator is asked", async () => {
    const [payer] = (await net.holders(usdc, 1, "10")) as [Keypair];
    expect((await settleAs(undefined, payer)).status).toBe(401);
    expect((await settleAs("wrong", payer)).status).toBe(401);
    expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(100_000_000n);
  });

  it("refuses a token outside the accepted assets", async () => {
    const [payer, eurcSeller] = (await net.holders(eurc, 2, "10")) as [Keypair, Keypair];
    const requirements = requirementsFor(eurc.sac, eurcSeller.publicKey(), PRICE);
    const payload = (await net.payment(payer, requirements)) as PaymentPayload;
    expect(await client.verify(payload, requirements as PaymentRequirements)).toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_stellar_requirements_asset_not_accepted",
    });
    expect(await client.settle(payload, requirements as PaymentRequirements)).toMatchObject({
      success: false,
      errorReason: "invalid_exact_stellar_requirements_asset_not_accepted",
    });
  });

  it("holds a caller to its own hourly sponsor budget and a payer to its settlement rate", async () => {
    const [first, second, third] = (await net.holders(usdc, 3, "10")) as [Keypair, Keypair, Keypair];
    expect((await settleAs("alice-secret", first)).body).toMatchObject({ success: true });
    // Alice's budget holds one reservation, and her first settlement committed part of it.
    expect((await settleAs("alice-secret", second)).body).toMatchObject({
      success: false,
      errorReason: "settle_exact_stellar_caller_budget_exhausted",
    });
    // Bob brings no budget of his own; the payer `first` already started a settlement this minute.
    expect((await settleAs("bob-secret", first)).body).toMatchObject({
      success: false,
      errorReason: "settle_exact_stellar_payer_rate_limited",
    });
    expect((await settleAs("bob-secret", third)).body).toMatchObject({ success: true });
  });

  it("refuses every settlement while the sponsor is below its reserve floor", async () => {
    const [payer] = (await net.holders(usdc, 1, "10")) as [Keypair];
    sponsorBalance = 1n;
    try {
      expect((await settleAs("bob-secret", payer)).body).toMatchObject({
        success: false,
        errorReason: "settle_exact_stellar_sponsor_unavailable",
      });
    } finally {
      sponsorBalance = 10_000_000_000n;
    }
  });

  it("records each settlement's caller and the service fee priced for it", async () => {
    const since = new Date(Date.now() - 3_600_000);
    const usage = new Map((await ledger.usageSince(undefined, since)).map((row) => [row.caller, row]));
    expect(usage.get("key:alice")).toMatchObject({ network: NETWORK, succeeded: 1 });
    expect(usage.get("key:bob")).toMatchObject({ network: NETWORK, succeeded: 1 });
    expect(Number(usage.get("key:alice")?.serviceFeeUsd)).toBe(0.001);
    expect(Number(usage.get("key:bob")?.serviceFeeUsd)).toBe(0.0025);
    expect(usage.get("key:alice")?.sponsoredFeeStroops).toBeGreaterThan(0n);
    expect(await ledger.committedFeesSince(NETWORK, since, "key:alice")).toBeLessThanOrEqual(RESERVATION);
  });

  it("never asked a Rail402 host", async () => {
    expect(guard.attempts).toEqual([]);
    // The guard itself refuses such a request, through fetch and through a plain socket.
    await expect(fetch("https://testnet.rail402.dev/supported")).rejects.toThrow();
    await expect(
      new Promise((resolve, reject) => {
        https.get("https://demo.rail402.dev/", resolve).on("error", reject);
      }),
    ).rejects.toThrow(/refused/);
    expect(guard.attempts).toEqual(["fetch testnet.rail402.dev", "connect demo.rail402.dev"]);
  });
});

describe.skipIf(!available)("in-process controls: the network's hourly sponsor budget", () => {
  it("refuses once the hourly fee budget is committed", async () => {
    const guard = guardEgress();
    try {
      const usdc = await net.issueAsset("USDC");
      const [seller] = (await net.holders(usdc, 1, "0")) as [Keypair];
      const sponsor = await sponsorWithChannels();
      const ledger = new MemorySettlementLedger();
      const client = inProcessClient(
        createStellarFacilitator({
          networks: [
            {
              network: NETWORK,
              rpcUrl: net.rpcUrl,
              sponsorSecret: sponsor.secret(),
              channelCount: 2,
              ledger,
              assets: [acceptedAsset({ contract: usdc.sac, symbol: "USDC", decimals: 7 })],
              policy: { maxTransactionFeeStroops: MAX_FEE, inclusionFeeStroops: INCLUSION_FEE },
              // Room for one reservation: the first settlement's committed fee leaves too little.
              guard: new SponsorBudget({
                network: NETWORK,
                ledger,
                balance: () => 10_000_000_000n,
                minBalanceStroops: 0n,
                maxSpendPerHourStroops: RESERVATION + 1n,
              }),
            },
          ],
        }),
      );
      const requirements = requirementsFor(usdc.sac, seller.publicKey(), PRICE);
      const [first, second] = (await net.holders(usdc, 2, "10")) as [Keypair, Keypair];
      const pay = async (payer: Keypair) =>
        client.settle(await net.payment(payer, requirements), requirements);
      expect(await pay(first)).toMatchObject({ success: true });
      expect(await pay(second)).toMatchObject({
        success: false,
        errorReason: "settle_exact_stellar_sponsor_unavailable",
      });
      expect(await net.tokenBalance(usdc.sac, second.publicKey())).toBe(100_000_000n);
      expect(guard.attempts).toEqual([]);
    } finally {
      guard.restore();
    }
  });
});
