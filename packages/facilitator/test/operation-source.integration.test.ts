/**
 * An `exact` payment whose operation sets its own source account. The payer's authorization does not
 * cover the operation source, and settlement keeps it while no account but the facilitator's can sign
 * the rebuilt transaction, so the network would refuse it after the envelope was recorded. It is
 * refused before anything is claimed: it never verifies, holds no channel and commits no fee.
 * Needs `docker compose --profile stellar up -d`.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { Keypair, xdr } from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  MemoryChannelPool,
  MemorySettlementLedger,
  acceptedAsset,
  createStellarFacilitator,
  deriveChannelKeypairs,
  provisionChannels,
} from "@rail402.dev/facilitator";
import { LocalNetwork, requirementsFor, type IssuedAsset } from "@rail402.dev/testkit";

const net = new LocalNetwork();
const available = await net.available();
const NETWORK = "stellar:testnet";

function withOperationSource(payload: PaymentPayload, source: Keypair): PaymentPayload {
  const envelope = xdr.TransactionEnvelope.fromXDR(
    (payload.payload as { transaction: string }).transaction,
    "base64",
  );
  const operation = envelope.v1().tx().operations()[0];
  if (operation === undefined) throw new Error("no operation");
  operation.sourceAccount(xdr.MuxedAccount.keyTypeEd25519(source.rawPublicKey()));
  return { ...payload, payload: { transaction: envelope.toXDR("base64") } };
}

describe.skipIf(!available)("an exact payment with its own operation source", () => {
  let usdc: IssuedAsset;
  let sponsor: Keypair;
  let seller: Keypair;
  let payer: Keypair;

  beforeAll(async () => {
    usdc = await net.issueAsset("USDC");
    sponsor = Keypair.random();
    await net.fund(sponsor);
    await provisionChannels({
      server: net.server,
      passphrase: net.passphrase,
      sponsor,
      channels: deriveChannelKeypairs(sponsor, NETWORK, 1),
    });
    [seller, payer] = (await net.holders(usdc, 2, "10")) as [Keypair, Keypair];
  }, 120_000);

  it("is refused at verify and settle, before any claim, channel or fee", async () => {
    const ledger = new MemorySettlementLedger();
    const channels = new MemoryChannelPool(
      deriveChannelKeypairs(sponsor, NETWORK, 1).map((keypair) => keypair.publicKey()),
    );
    const facilitator = createStellarFacilitator({
      networks: [
        {
          network: NETWORK,
          rpcUrl: net.rpcUrl,
          sponsorSecret: sponsor.secret(),
          channelCount: 1,
          assets: [acceptedAsset({ contract: usdc.sac, symbol: "USDC", decimals: 7 })],
          policy: { maxTransactionFeeStroops: 2_000_000 },
          ledger,
          channels,
          timing: { pollIntervalMs: 500, confirmTimeoutMs: 4_000, channelWaitMs: 500 },
        },
      ],
    });
    const requirements = requirementsFor(
      usdc.sac,
      seller.publicKey(),
      1_000_000n,
      120,
    ) as unknown as PaymentRequirements;
    const before = await net.nativeBalance(sponsor.publicKey());

    for (const source of [payer, Keypair.random()]) {
      const payload = withOperationSource(await net.payment(payer, requirements as never), source);
      const verified = await facilitator.core.verify(payload, requirements);
      expect(verified).toMatchObject({
        isValid: false,
        invalidReason: "invalid_exact_stellar_payload_operation_source_set",
        payer: payer.publicKey(),
      });
      const settled = await facilitator.core.settle(payload, requirements);
      expect(settled).toMatchObject({
        success: false,
        errorReason: "invalid_exact_stellar_payload_operation_source_set",
      });
    }
    expect(await ledger.unfinished(NETWORK)).toEqual([]);
    expect(await channels.inUse()).toBe(0);
    expect(await ledger.committedFeesSince(NETWORK, new Date(Date.now() - 3_600_000))).toBe(0n);

    // A genuine payment settles on the channel right away.
    const genuine = (await net.payment(payer, requirements as never)) as unknown as PaymentPayload;
    expect(await facilitator.core.settle(genuine, requirements)).toMatchObject({ success: true });
    expect(await net.nativeBalance(sponsor.publicKey())).toBeLessThan(before);
  }, 120_000);
});
