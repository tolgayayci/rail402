/**
 * What an `exact` settlement reserves against the hourly budgets, and the bound the sponsor holds its
 * fee bump to. Upstream lets the inner transaction cost `resource fee + one inclusion bid` up to the
 * ceiling; the fee bump pays the bid once more, so the worst case is the ceiling plus the highest bid.
 */
import { describe, expect, it } from "vitest";
import { Account, Keypair, Networks, Operation, TransactionBuilder, type rpc } from "@stellar/stellar-sdk";
import type { SettleResponse } from "@x402/core/types";
import {
  MemoryChannelPool,
  MemorySettlementLedger,
  SettlementEngine,
  type ClaimDetails,
  type NetworkPolicy,
  type SettlementLedger,
  type SubmissionContext,
} from "@rail402.dev/facilitator";

const NETWORK = "stellar:testnet";
const CEILING = 100_000;
const BID = 300;

function setup() {
  const memory = new MemorySettlementLedger();
  const claims: ClaimDetails[] = [];
  const ledger: SettlementLedger = Object.assign(Object.create(memory) as SettlementLedger, {
    claim: (...args: Parameters<SettlementLedger["claim"]>) => {
      claims.push(args[4] ?? {});
      return memory.claim(...args);
    },
  });
  const channel = Keypair.random();
  const sponsor = Keypair.random();
  const engine = new SettlementEngine({
    network: NETWORK,
    passphrase: Networks.TESTNET,
    rpcUrl: "http://127.0.0.1:1/rpc",
    server: {} as rpc.Server,
    policy: { maxTransactionFeeStroops: CEILING, inclusionFeeStroops: BID } as NetworkPolicy,
    ledger,
    channels: new MemoryChannelPool([channel.publicKey()]),
    channelKeys: new Map([[channel.publicKey(), channel]]),
    sponsor,
    timing: { confirmTimeoutMs: 0 },
    guard: {
      admit: () => Promise.resolve({ ok: true }),
      limits: () => [{ scope: "network", capStroops: 10_000_000n, since: new Date(0) }],
    },
  });
  return { engine, memory, claims, channel, sponsor };
}

/** A fee bump of a one-operation transaction from `channel`, costing `2 x baseFee`. */
function feeBump(channel: Keypair, sponsor: Keypair, baseFee: number): string {
  const inner = new TransactionBuilder(new Account(channel.publicKey(), "1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.bumpSequence({ bumpTo: "0" }))
    .setTimeout(60)
    .build();
  inner.sign(channel);
  return TransactionBuilder.buildFeeBumpTransaction(
    sponsor.publicKey(),
    String(baseFee),
    inner,
    Networks.TESTNET,
  ).toXDR();
}

const failure: SettleResponse = {
  success: false,
  errorReason: "settle_exact_stellar_fee_bump_signing_failed",
  transaction: "",
  network: NETWORK,
};

describe("exact fee reservation", () => {
  it("reserves the fee ceiling plus one inclusion bid, the fee bump's worst case", async () => {
    const { engine, claims, channel, sponsor } = setup();
    let signed: string | undefined;
    await engine.execute(
      {
        scheme: "exact",
        key: engine.keyOf("GPAYER", 1n),
        fingerprint: { payloadHash: "p", requestHash: "r" },
        payer: "GPAYER",
      },
      {
        submit: async (context: SubmissionContext) => {
          // Exactly the reservation: 2 x 50,150 = ceiling + bid.
          const result = await context.feeBumpSigner.signTransaction(
            feeBump(channel, sponsor, (CEILING + BID) / 2),
            { networkPassphrase: Networks.TESTNET },
          );
          signed = result.error === undefined ? result.signedTxXdr : undefined;
          return failure;
        },
        unsigned: (result) => Promise.resolve(result),
      },
    );
    expect(claims[0]?.reserveFeeStroops).toBe(BigInt(CEILING + BID));
    expect(signed).toBeDefined();
  });

  it("refuses to sign a fee bump that costs more than the settlement reserved", async () => {
    const { engine, memory, channel, sponsor } = setup();
    let error: string | undefined;
    const key = engine.keyOf("GPAYER", 2n);
    const result = await engine.execute(
      {
        scheme: "exact",
        key,
        fingerprint: { payloadHash: "p", requestHash: "r" },
        payer: "GPAYER",
      },
      {
        submit: async (context: SubmissionContext) => {
          const answer = await context.feeBumpSigner.signTransaction(
            feeBump(channel, sponsor, (CEILING + BID) / 2 + 1),
            { networkPassphrase: Networks.TESTNET },
          );
          error = answer.error?.message;
          return failure;
        },
        unsigned: (response) => Promise.resolve(response),
      },
    );
    expect(error).toMatch(/costs more than the settlement reserved/);
    expect(result.errorReason).toBe("settle_exact_stellar_fee_bump_signing_failed");
    // Nothing was signed or recorded: the claim is dropped and the payment may be retried.
    expect(await memory.find(key)).toBeUndefined();
  });
});
