/**
 * upto from the buyer SDK on the private Stellar network (docker compose --profile stellar up -d):
 * a seller built with the Rail402 seller helpers settles metered HTTP calls and MCP tool calls
 * through Rail402 running in this process, with the settlement contract deployed per run. Zero,
 * partial and maximum charges move exactly the charged amount; the budget reserves the cap before
 * signing and returns the rest only after the chain proves the settlement. Sellers whose 402 names
 * a settlement authority, recipient or contract outside the policy are refused before or inside the
 * signer, with nothing signed.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Account, Keypair, MuxedAccount } from "@stellar/stellar-sdk";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { TESTNET } from "@rail402.dev/stellar";
import { UptoStellarScheme } from "@rail402.dev/upto/client";
import {
  LocalNetwork,
  randomContractId,
  type IssuedAsset,
  type LocalUptoContract,
} from "@rail402.dev/testkit";
import {
  KeyHolder,
  createBuyer,
  exactScheme,
  isPaymentError,
  toAtomic,
  uptoScheme,
  type Buyer,
  type BuyerOptions,
  type PaymentError,
  type PaymentEvent,
  type StellarSchemeAdapter,
} from "@rail402.dev/sdk";
import type { RunningRail402 } from "./service.ts";
import { startUptoEnvironment, type UptoEnvironment, type UptoSeller } from "./upto-seller.ts";

const net = new LocalNetwork();
const available = await net.available();
/** The seller's cap per call: 0.05 of the 7-decimal test token. */
const CAP = 500_000n;
/**
 * The ledger close time Horizon reports to this process, which the facilitator's expiry bound uses.
 * The private network closes a ledger every second and the facilitator's ledger reading may be a few
 * seconds old, so the buyer estimates a longer close time (BUYER_LEDGER_SECONDS) than the facilitator:
 * its authorization then expires well inside the facilitator's bound.
 */
const LEDGER_SECONDS = 2;
const BUYER_LEDGER_SECONDS = 5;

async function failure(promise: Promise<unknown>): Promise<PaymentError> {
  try {
    await promise;
  } catch (error) {
    if (isPaymentError(error)) return error;
    throw error;
  }
  throw new Error("expected a PaymentError");
}

describe.skipIf(!available)("upto from the SDK on the local network", () => {
  let env: UptoEnvironment;
  let usdc: IssuedAsset;
  let contract: LocalUptoContract;
  let rail402: RunningRail402;
  let seller: Keypair;
  let shop: UptoSeller;
  let authority: string;
  let impostor: Server;
  let impostorUrl: string;
  let impostorPort: number;
  /** What the impostor seller's 402 advertises. */
  let impostorOption: PaymentRequirements;

  beforeAll(async () => {
    env = await startUptoEnvironment(net, { ledgerSeconds: LEDGER_SECONDS, maxTimeoutSeconds: 60 });
    ({ asset: usdc, contract, rail402, seller, shop, authority } = env);

    impostor = createServer((_request, response) => {
      response
        .writeHead(402, {
          "payment-required": encodePaymentRequiredHeader({
            x402Version: 2,
            error: "Payment required",
            resource: { url: impostorUrl },
            accepts: [impostorOption],
          }),
        })
        .end("{}");
    });
    await new Promise<void>((resolve) => impostor.listen(0, "127.0.0.1", resolve));
    impostorPort = (impostor.address() as AddressInfo).port;
    impostorUrl = `http://127.0.0.1:${String(impostorPort)}/report`;
  }, 180_000);

  afterAll(async () => {
    impostor.closeAllConnections();
    await new Promise((resolve) => impostor.close(resolve));
    await env.stop();
  });

  const buyerFor = (payer: Keypair, overrides: Partial<BuyerOptions> = {}): Promise<Buyer> =>
    createBuyer({
      network: TESTNET,
      signer: KeyHolder.fromSecret(payer.secret()),
      rpcUrl: net.rpcUrl,
      bazaarUrl: rail402.url,
      facilitatorUrl: rail402.url,
      policy: {
        assets: [{ asset: usdc.sac, symbol: "USDC", decimals: 7, perCall: "0.1", sessionTotal: "1" }],
        uptoContracts: [contract.address],
      },
      egress: { schemes: ["http:"], ports: [shop.port, impostorPort], allowPrivateNetwork: "loopback" },
      schemes: [
        exactScheme(),
        uptoScheme({ contract: contract.address, ledgerSeconds: BUYER_LEDGER_SECONDS }),
      ],
      ...overrides,
    });
  const balance = (holder: string) => net.tokenBalance(usdc.sac, holder).catch(() => 0n);
  const metered = (charge: bigint) => ({
    kind: "http" as const,
    url: `${shop.url}/metered`,
    query: { charge: charge.toString() },
  });
  const cap = { amount: "0.1", asset: "USDC" };

  it.each([
    ["partial", 125_000n],
    ["maximum", CAP],
    ["zero", 0n],
  ])(
    "pays a %s charge: only the charge moves, and the rest of the cap returns after proof",
    async (_name, charge) => {
      const payer = await net.holder(usdc, "1");
      const events: PaymentEvent[] = [];
      const buyer = await buyerFor(payer, { onEvent: (event) => events.push(event) });
      const [payerBefore, sellerBefore, sponsorBefore] = await Promise.all([
        balance(payer.publicKey()),
        balance(seller.publicKey()),
        balance(rail402.sponsor),
      ]);

      const result = await buyer.pay(metered(charge), { maxAmount: cap });
      expect(result.response).toMatchObject({ status: 200, json: { charged: charge.toString() } });
      expect(result.payment).toMatchObject({
        status: "settled",
        scheme: "upto",
        authorized: { atomic: CAP.toString() },
        settled: { atomic: charge.toString() },
        payTo: seller.publicKey(),
        verifiedOnChain: true,
      });
      expect(result.payment?.transaction).toMatch(/^[0-9a-f]{64}$/);

      // Non-custodial and exact: the payer loses the charge, the seller gains it, nobody else moves.
      expect(await balance(payer.publicKey())).toBe(payerBefore - charge);
      expect(await balance(seller.publicKey())).toBe(sellerBefore + charge);
      expect(await balance(rail402.sponsor)).toBe(sponsorBefore);
      expect(await balance(authority)).toBe(0n);

      // The cap was reserved before signing; after proof only the charge is spent.
      expect(events.find((event) => event.type === "reserved")).toMatchObject({ amount: CAP.toString() });
      const reservedAt = events.findIndex((event) => event.type === "reserved");
      const signedAt = events.findIndex((event) => event.type === "signed");
      expect(reservedAt).toBeGreaterThanOrEqual(0);
      expect(signedAt).toBeGreaterThan(reservedAt);
      if (charge < CAP) {
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "released",
            reason: "settled_below_cap",
            amount: (CAP - charge).toString(),
          }),
        );
      }
      const [budget] = (await buyer.budget()).assets;
      expect(budget).toMatchObject({ pending: "0" });
      expect(toAtomic(budget?.spent ?? "", 7)).toBe(charge);

      const report = await buyer.inspectTransaction(result.payment?.transaction ?? "");
      expect(report.x402.shape).toBe("upto");
      expect(report.facilitator).toMatchObject({ attributed: true });
      await buyer.close();
    },
  );

  it("keeps the remainder pending until reconciliation proves the settlement", async () => {
    const payer = await net.holder(usdc, "1");
    const buyer = await buyerFor(payer, { verify: "off" });
    const result = await buyer.pay(metered(100_000n), { maxAmount: cap });
    expect(result.payment).toMatchObject({ settled: { atomic: "100000" }, verifiedOnChain: false });
    expect((await buyer.budget()).assets[0]).toMatchObject({ spent: "0.01", pending: "0.04" });

    // The authorization expires about a minute after signing; then the transfer settles the row.
    await expect
      .poll(
        async () => {
          await buyer.reconcile();
          return (await buyer.budget()).assets[0]?.pending;
        },
        { timeout: 90_000, interval: 3_000 },
      )
      .toBe("0");
    expect((await buyer.budget()).assets[0]).toMatchObject({ spent: "0.01" });
    await buyer.close();
  }, 120_000);

  it("pays a metered MCP tool for its charge, and a stock-wrapped upto tool for the cap", async () => {
    const payer = await net.holder(usdc, "1");
    const buyer = await buyerFor(payer);
    const sellerBefore = await balance(seller.publicKey());

    const metered = await buyer.pay(
      { kind: "mcp", url: shop.mcpUrl, toolName: "tokens", arguments: { prompt: "rain", charge: 42_000 } },
      { maxAmount: cap },
    );
    expect(metered.response).toMatchObject({ kind: "mcp", isError: false });
    expect(metered.payment).toMatchObject({
      scheme: "upto",
      settled: { atomic: "42000" },
      verifiedOnChain: true,
    });
    // The charge is settlement data; it never reaches the buyer.
    expect(JSON.stringify(metered.response)).not.toContain("rail402/upto-charge");

    const stock = await buyer.pay(
      { kind: "mcp", url: shop.mcpUrl, toolName: "summary", arguments: { topic: "rain" } },
      { maxAmount: cap },
    );
    expect(stock.payment).toMatchObject({ settled: { atomic: CAP.toString() }, verifiedOnChain: true });
    expect(await balance(seller.publicKey())).toBe(sellerBefore + 42_000n + CAP);
    expect((await buyer.budget()).assets[0]).toMatchObject({ spent: "0.0542", pending: "0" });
    await buyer.close();
  });

  it("finds the upto listings in the Bazaar and pays one through its listing", async () => {
    const payer = await net.holder(usdc, "1");
    const buyer = await buyerFor(payer);
    await rail402.runtime.bazaar?.catalog.checkOrigins();
    await expect
      .poll(async () => (await buyer.list({ type: "http", payTo: seller.publicKey() })).hits.length, {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
    const [hit] = (await buyer.list({ type: "http", payTo: seller.publicKey() })).hits;
    expect(hit?.prices).toContainEqual(
      expect.objectContaining({ scheme: "upto", atomic: CAP.toString(), payTo: seller.publicKey() }),
    );
    const result = await buyer.payListing(
      hit?.listingId ?? "",
      { query: { charge: "7000" } },
      { maxAmount: cap },
    );
    expect(result.payment).toMatchObject({
      scheme: "upto",
      settled: { atomic: "7000" },
      verifiedOnChain: true,
    });
    await buyer.close();
  });

  describe("sellers outside the policy", () => {
    const option = (overrides: Partial<PaymentRequirements>): PaymentRequirements => ({
      scheme: "upto",
      network: TESTNET,
      asset: usdc.sac,
      amount: CAP.toString(),
      payTo: seller.publicKey(),
      maxTimeoutSeconds: 60,
      extra: { areFeesSponsored: true, facilitatorAddress: authority },
      ...overrides,
    });

    /** Pays the impostor and checks that nothing was signed or reserved. */
    async function refused(buyer: Buyer, events: PaymentEvent[]): Promise<PaymentError> {
      const error = await failure(buyer.pay({ kind: "http", url: impostorUrl }, { maxAmount: cap }));
      expect(error.paid).toBe("none");
      expect(events.some((event) => event.type === "signed")).toBe(false);
      expect((await buyer.budget()).assets[0]).toMatchObject({ spent: "0", pending: "0" });
      return error;
    }

    it("refuses a seller naming itself as the settlement authority, before signing", async () => {
      impostorOption = option({ extra: { areFeesSponsored: true, facilitatorAddress: seller.publicKey() } });
      const events: PaymentEvent[] = [];
      const buyer = await buyerFor(await net.holder(usdc, "1"), { onEvent: (event) => events.push(event) });
      expect(await refused(buyer, events)).toMatchObject({ code: "payment_facilitator_not_permitted" });
    });

    it("refuses an authority outside the allowed facilitators, and a muxed recipient", async () => {
      const payer = await net.holder(usdc, "1");
      const events: PaymentEvent[] = [];
      const buyer = await buyerFor(payer, {
        onEvent: (event) => events.push(event),
        policy: {
          assets: [{ asset: usdc.sac, symbol: "USDC", decimals: 7, perCall: "0.1", sessionTotal: "1" }],
          uptoContracts: [contract.address],
          uptoFacilitators: [authority],
        },
      });
      impostorOption = option({
        extra: { areFeesSponsored: true, facilitatorAddress: Keypair.random().publicKey() },
      });
      expect(await refused(buyer, events)).toMatchObject({ code: "payment_facilitator_not_permitted" });
      impostorOption = option({
        payTo: new MuxedAccount(new Account(seller.publicKey(), "0"), "9").accountId(),
      });
      expect(await refused(buyer, events)).toMatchObject({ code: "payment_recipient_not_permitted" });
    });

    it("refuses inside the signer a client that follows a contract the 402 advertises", async () => {
      const evil = randomContractId();
      impostorOption = option({
        extra: { areFeesSponsored: true, facilitatorAddress: authority, settlementContract: evil },
      });
      // A naive client that trusts the seller's contract instead of the pinned one.
      const naive: StellarSchemeAdapter = {
        ...uptoScheme({ contract: contract.address }),
        createClient: (signer, connection) => ({
          scheme: "upto",
          createPaymentPayload: (version, requirements, context) => {
            const advertised = requirements.extra["settlementContract"];
            return new UptoStellarScheme(signer, {
              ...(connection.latestLedger === undefined ? {} : { latestLedger: connection.latestLedger }),
              contracts: typeof advertised === "string" ? advertised : contract.address,
            }).createPaymentPayload(version, requirements, context);
          },
        }),
      };
      const events: PaymentEvent[] = [];
      const buyer = await buyerFor(await net.holder(usdc, "1"), {
        schemes: [naive],
        onEvent: (event) => events.push(event),
      });
      expect(await refused(buyer, events)).toMatchObject({ code: "payment_authorization_rejected" });
    });
  });
});
