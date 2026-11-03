/**
 * Per-payer and per-payTo settlement limits against forged payloads, on the private Stellar network.
 *
 * The payer and the payTo are read from bytes anyone can send. A payload that names a seller as its
 * recipient but carries a garbage signature must not use up that seller's quota (or a wallet's), or
 * anyone could lock a seller out of settlement for free. The limits count only payments that proved
 * the payer's signature, just before the sponsor signs.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  SettleLimits,
  acceptedAsset,
  createStellarFacilitator,
  deriveChannelKeypairs,
  provisionChannels,
} from "@rail402.dev/facilitator";
import { LocalNetwork, requirementsFor, type IssuedAsset } from "@rail402.dev/testkit";

const net = new LocalNetwork();
const available = await net.available();
const NETWORK = "stellar:testnet";
const PRICE = 1_000_000n;

/** A per-minute counter like the service's limiter, recording every key it counts. */
function counter() {
  const counts = new Map<string, number>();
  const taken: string[] = [];
  const take = (key: string, perMinute: number) => {
    taken.push(key);
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    return next > perMinute ? 30 : 0;
  };
  return { take, taken };
}

/** The payment with its payer's authorization signature replaced by garbage bytes. */
function forge(payload: PaymentPayload): PaymentPayload {
  const envelope = xdr.TransactionEnvelope.fromXDR(
    (payload.payload as { transaction: string }).transaction,
    "base64",
  );
  const operation = envelope.v1().tx().operations()[0];
  const entry = operation?.body().invokeHostFunctionOp().auth()[0];
  if (entry === undefined) throw new Error("the payment carries no authorization");
  entry
    .credentials()
    .address()
    .signature(nativeToScVal([{ public_key: Buffer.alloc(32, 1), signature: Buffer.alloc(64, 2) }]));
  return { ...payload, payload: { transaction: envelope.toXDR("base64") } };
}

describe.skipIf(!available)("per-party settlement limits", () => {
  let usdc: IssuedAsset;
  let sponsor: Keypair;
  let seller: Keypair;

  beforeAll(async () => {
    usdc = await net.issueAsset("USDC");
    sponsor = Keypair.random();
    await net.fund(sponsor);
    await provisionChannels({
      server: net.server,
      passphrase: net.passphrase,
      sponsor,
      channels: deriveChannelKeypairs(sponsor, NETWORK, 2),
    });
    [seller] = (await net.holders(usdc, 1, "0")) as [Keypair];
  });

  const facilitatorWith = (limits: SettleLimits) =>
    createStellarFacilitator({
      networks: [
        {
          network: NETWORK,
          rpcUrl: net.rpcUrl,
          sponsorSecret: sponsor.secret(),
          channelCount: 2,
          assets: [acceptedAsset({ contract: usdc.sac, symbol: "USDC", decimals: 7 })],
          policy: { maxTransactionFeeStroops: 2_000_000 },
          guard: limits,
          timing: { pollIntervalMs: 250, reconcileIdleMs: 0 },
        },
      ],
    });

  it("forged payloads naming a payTo or a payer use none of their quota", async () => {
    const { take, taken } = counter();
    const facilitator = facilitatorWith(
      new SettleLimits({ network: NETWORK, take, payerPerMinute: 1, payToPerMinute: 1, failClosed: true }),
    );
    const terms = requirementsFor(usdc.sac, seller.publicKey(), PRICE);
    const requirements = terms as PaymentRequirements;
    const [victim] = (await net.holders(usdc, 1, "100")) as [Keypair];
    // Three forged settlements in the victim's name to the seller, each well past both limits of 1.
    for (let i = 0; i < 3; i++) {
      const payload = (await net.payment(victim, terms)) as PaymentPayload;
      const forged = await facilitator.core.settle(forge(payload), requirements);
      expect(forged.success).toBe(false);
      expect(forged.errorReason).toBe("invalid_exact_stellar_payload_invalid_signature");
    }
    expect(taken).toEqual([]);

    // The victim's own genuine payment to the seller still settles.
    const genuine = await facilitator.core.settle(await net.payment(victim, terms), requirements);
    expect(genuine.errorReason).toBeUndefined();
    expect(genuine.success).toBe(true);
    expect(taken).toEqual([
      `n:${NETWORK}|payer:${victim.publicKey()}`,
      `n:${NETWORK}|public|payto:${seller.publicKey()}`,
    ]);

    // Genuine payments do count: a second one to the same payTo within the minute is refused.
    const [other] = (await net.holders(usdc, 1, "100")) as [Keypair];
    const limited = await facilitator.core.settle(await net.payment(other, terms), requirements);
    expect(limited.success).toBe(false);
    expect(limited.errorReason).toBe("settle_exact_stellar_payto_rate_limited");
    expect(limited.errorMessage).toMatch(/payTo received too many settlements/);
  }, 120_000);
});
