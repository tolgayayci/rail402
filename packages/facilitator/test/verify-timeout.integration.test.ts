/**
 * The upstream `exact` verifier builds its own RPC client from the URL alone, without the call timeout
 * of Rail402's clients. On the private Stellar network behind a proxy that holds every simulation, a
 * `/verify` must still answer within the RPC timeout, with the retryable `unexpected_verify_error`, and
 * nothing may be signed or submitted.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import type { PaymentPayload } from "@x402/core/types";
import {
  MemorySettlementLedger,
  RpcPool,
  acceptedAsset,
  createStellarFacilitator,
  deriveChannelKeypairs,
  provisionChannels,
} from "@rail402.dev/facilitator";
import {
  LocalNetwork,
  requirementsFor,
  startRpcProxy,
  type IssuedAsset,
  type RpcProxy,
} from "@rail402.dev/testkit";

const net = new LocalNetwork();
const available = await net.available();
const NETWORK = "stellar:testnet";
const TIMEOUT_MS = 1_500;

describe.skipIf(!available)("upstream verification against a provider that stops answering", () => {
  let usdc: IssuedAsset;
  let sponsor: Keypair;
  let seller: Keypair;
  let proxy: RpcProxy;

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
    [seller] = (await net.holders(usdc, 1, "0")) as [Keypair];
    proxy = await startRpcProxy(net.rpcUrl);
  });

  afterAll(async () => {
    await proxy.close();
  });

  it("answers unexpected_verify_error within the RPC timeout, and signs nothing", async () => {
    const facilitator = createStellarFacilitator({
      networks: [
        {
          network: NETWORK,
          rpcUrl: proxy.url,
          rpc: new RpcPool([{ alias: "primary", url: proxy.url }], { timeoutMs: TIMEOUT_MS }),
          sponsorSecret: sponsor.secret(),
          channelCount: 1,
          assets: [acceptedAsset({ contract: usdc.sac, symbol: "USDC", decimals: 7 })],
          policy: { maxTransactionFeeStroops: 2_000_000 },
          ledger: new MemorySettlementLedger(),
        },
      ],
    });
    const [payer] = (await net.holders(usdc, 1, "100")) as [Keypair];
    const terms = requirementsFor(usdc.sac, seller.publicKey(), 1_000_000n, 120);
    const payload = (await net.payment(payer, terms)) as PaymentPayload;

    proxy.holdResponses("simulateTransaction");
    try {
      const started = Date.now();
      const verified = await facilitator.core.verify(payload, terms);
      const elapsed = Date.now() - started;
      expect(verified).toMatchObject({
        isValid: false,
        invalidReason: "unexpected_verify_error",
        payer: payer.publicKey(),
      });
      expect(verified.invalidMessage).toContain("did not answer verification within 1.5 seconds");
      // Bounded by the deadline, not by the platform's fetch default (minutes).
      expect(elapsed).toBeGreaterThanOrEqual(TIMEOUT_MS - 50);
      expect(elapsed).toBeLessThan(TIMEOUT_MS + 5_000);
    } finally {
      await proxy.releaseHeld();
    }
    expect(proxy.sent).toEqual([]);

    // Once the provider answers again, the same payment verifies: it was never judged.
    const again = await facilitator.core.verify(payload, terms);
    expect(again).toMatchObject({ isValid: true, payer: payer.publicKey() });
  });
});
