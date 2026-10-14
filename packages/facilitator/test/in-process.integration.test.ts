/**
 * Self-facilitation: a stock x402ResourceServer uses the facilitator in-process, with no HTTP hop,
 * for `exact` and for `upto` (the settlement contract deployed per run). Needs
 * `docker compose --profile stellar up -d`.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { x402ResourceServer } from "@x402/core/server";
import type { PaymentPayload } from "@x402/core/types";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { createEd25519Signer } from "@x402/stellar";
import { UptoStellarScheme as UptoClient } from "@rail402.dev/upto/client";
import { UptoStellarScheme as UptoServer } from "@rail402.dev/upto/server";
import {
  acceptedAsset,
  createStellarFacilitator,
  deriveAuthorityKeypair,
  deriveChannelKeypairs,
  inProcessClient,
  provisionAuthority,
  provisionChannels,
} from "@rail402.dev/facilitator";
import {
  LocalNetwork,
  deployUpto,
  requirementsFor,
  type IssuedAsset,
  type LocalUptoContract,
} from "@rail402.dev/testkit";

const net = new LocalNetwork();
const available = await net.available();

describe.skipIf(!available)("in-process facilitator inside a stock resource server", () => {
  let usdc: IssuedAsset;
  let seller: Keypair;
  let resourceServer: x402ResourceServer;
  let contract: LocalUptoContract;
  let authority: string;

  beforeAll(async () => {
    [usdc, contract] = await Promise.all([net.issueAsset("USDC"), deployUpto(net)]);
    const sponsor = Keypair.random();
    await net.fund(sponsor);
    await provisionChannels({
      server: net.server,
      passphrase: net.passphrase,
      sponsor,
      channels: deriveChannelKeypairs(sponsor, "stellar:testnet", 2),
    });
    const authorityKey = deriveAuthorityKeypair(sponsor, "stellar:testnet");
    await provisionAuthority({
      server: net.server,
      passphrase: net.passphrase,
      sponsor,
      authority: authorityKey,
    });
    authority = authorityKey.publicKey();
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
          upto: { contract: contract.address, contractWasmHash: contract.wasmHash, ledgerSeconds: 5 },
        },
      ],
    });
    resourceServer = new x402ResourceServer(inProcessClient(facilitator))
      .register("stellar:testnet", new ExactStellarScheme())
      .register("stellar:testnet", new UptoServer());
    await resourceServer.initialize();
  }, 180_000);

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

  it("settles part of an upto cap chosen after the request, without an HTTP facilitator", async () => {
    const [requirements] = await resourceServer.buildPaymentRequirements({
      scheme: "upto",
      network: "stellar:testnet",
      payTo: seller.publicKey(),
      price: { amount: "1000000", asset: usdc.sac },
    });
    if (requirements === undefined) throw new Error("no requirements built");
    expect(requirements.extra).toMatchObject({ areFeesSponsored: true, facilitatorAddress: authority });

    const [payer] = (await net.holders(usdc, 1, "10")) as [Keypair];
    const client = new UptoClient(createEd25519Signer(payer.secret(), "stellar:testnet"), {
      rpcConfig: { url: net.rpcUrl },
      contracts: contract.address,
      ledgerSeconds: 5,
    });
    const created = await client.createPaymentPayload(2, requirements);
    const payload: PaymentPayload = { x402Version: 2, accepted: requirements, payload: created.payload };

    expect(await resourceServer.verifyPayment(payload, requirements)).toMatchObject({ isValid: true });
    const before = await net.tokenBalance(usdc.sac, seller.publicKey());
    const settled = await resourceServer.settlePayment(payload, requirements, undefined, undefined, {
      amount: "400000",
    });
    expect(settled).toMatchObject({ success: true, payer: payer.publicKey(), amount: "400000" });
    expect(await net.tokenBalance(usdc.sac, seller.publicKey())).toBe(before + 400_000n);
  });
});
