/**
 * Self-facilitation: a stock x402ResourceServer uses the facilitator in-process, with no HTTP hop.
 * Needs `docker compose --profile stellar up -d`.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { x402ResourceServer } from "@x402/core/server";
import type { PaymentPayload } from "@x402/core/types";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import {
  acceptedAsset,
  createStellarFacilitator,
  deriveChannelKeypairs,
  inProcessClient,
  provisionChannels,
} from "@rail402.dev/facilitator";
import { LocalNetwork, requirementsFor, type IssuedAsset } from "@rail402.dev/testkit";

const net = new LocalNetwork();
const available = await net.available();

describe.skipIf(!available)("in-process facilitator inside a stock resource server", () => {
  let usdc: IssuedAsset;
  let seller: Keypair;
  let resourceServer: x402ResourceServer;

  beforeAll(async () => {
    usdc = await net.issueAsset("USDC");
    const sponsor = Keypair.random();
    await net.fund(sponsor);
    await provisionChannels({
      server: net.server,
      passphrase: net.passphrase,
      sponsor,
      channels: deriveChannelKeypairs(sponsor, "stellar:testnet", 2),
    });
    [seller] = (await net.holders(usdc, 1, "0")) as [Keypair];

    const facilitator = createStellarFacilitator({
      networks: [
        {
          network: "stellar:testnet",
          rpcUrl: net.rpcUrl,
          sponsorSecret: sponsor.secret(),
          channelCount: 2,
          assets: [acceptedAsset({ contract: usdc.sac, symbol: "USDC", decimals: 7 })],
          policy: { maxTransactionFeeStroops: 2_000_000 },
        },
      ],
    });
    resourceServer = new x402ResourceServer(inProcessClient(facilitator)).register(
      "stellar:testnet",
      new ExactStellarScheme(),
    );
    await resourceServer.initialize();
  });

  it("builds requirements, verifies and settles without an HTTP facilitator", async () => {
    const [requirements] = await resourceServer.buildPaymentRequirements({
      scheme: "exact",
      network: "stellar:testnet",
      payTo: seller.publicKey(),
      price: { amount: "250000", asset: usdc.sac },
    });
    if (requirements === undefined) throw new Error("no requirements built");
    expect(requirements.extra).toMatchObject({ areFeesSponsored: true });

    const [payer] = (await net.holders(usdc, 1, "10")) as [Keypair];
    const payload = (await net.payment(
      payer,
      requirementsFor(
        usdc.sac,
        seller.publicKey(),
        BigInt(requirements.amount),
        requirements.maxTimeoutSeconds,
      ),
    )) as PaymentPayload;

    expect(await resourceServer.verifyPayment(payload, requirements)).toMatchObject({ isValid: true });
    const settled = await resourceServer.settlePayment(payload, requirements);
    expect(settled).toMatchObject({ success: true, payer: payer.publicKey() });
    expect(await net.tokenBalance(usdc.sac, seller.publicKey())).toBe(250_000n);
  });
});
