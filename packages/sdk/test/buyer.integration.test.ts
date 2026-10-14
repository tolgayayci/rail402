/**
 * The buyer end to end on the private Stellar network (docker compose --profile stellar up -d):
 * stock @x402/express and @x402/mcp sellers settle through Rail402 running in this process, and
 * the SDK pays them with the unmodified @x402/stellar exact client signing through the guard. The
 * upstream client only reaches an https RPC, so the local RPC is fronted by a TLS proxy.
 */
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Keypair } from "@stellar/stellar-sdk";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { paymentMiddleware } from "@x402/express";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { ExactStellarScheme as ExactStellarServer } from "@x402/stellar/exact/server";
import { TESTNET } from "@rail402.dev/stellar";
import { LocalNetwork, startTlsRpcProxy, type IssuedAsset, type TlsRpcProxy } from "@rail402.dev/testkit";
import {
  KeyHolder,
  createBuyer,
  isPaymentError,
  type Buyer,
  type BuyerOptions,
  type PaymentEvent,
} from "@rail402.dev/sdk";
import { startMcpSeller, type McpSeller } from "./mcp-seller.ts";
import { startRail402, type RunningRail402 } from "./service.ts";

const net = new LocalNetwork();
const available = await net.available();

describe.skipIf(!available)("buyer on the local network", () => {
  let usdc: IssuedAsset;
  let rail402: RunningRail402;
  let proxy: TlsRpcProxy;
  let seller: Keypair;
  let sellerServer: Server;
  let sellerUrl: string;
  let sellerPort: number;
  const mcpSellers: McpSeller[] = [];

  beforeAll(async () => {
    usdc = await net.issueAsset("USDC");
    [rail402, proxy] = await Promise.all([startRail402(net, usdc), startTlsRpcProxy(net.rpcUrl)]);
    proxy.trust();
    [seller] = (await net.holders(usdc, 1, "0")) as [Keypair];

    const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: rail402.url }))
      .register(TESTNET, new ExactStellarServer())
      .registerExtension(bazaarResourceServerExtension);
    const app = express();
    app.use(
      paymentMiddleware(
        {
          "GET /weather": {
            accepts: {
              scheme: "exact",
              price: { amount: "150000", asset: usdc.sac },
              network: TESTNET,
              payTo: seller.publicKey(),
            },
            description: "Current weather for a city",
            mimeType: "application/json",
            extensions: declareDiscoveryExtension({
              input: { city: "Ankara" },
              inputSchema: {
                properties: { city: { type: "string", description: "City name" } },
                required: ["city"],
              },
              output: { example: { temperature: 21, conditions: "sunny" } },
            }),
          },
          "GET /premium": {
            accepts: {
              scheme: "exact",
              price: { amount: "9000000", asset: usdc.sac },
              network: TESTNET,
              payTo: seller.publicKey(),
            },
            description: "An expensive report",
          },
        },
        resourceServer,
      ),
    );
    app.get("/weather", (request, response) => {
      response.json({ city: request.query["city"] ?? null, temperature: 21, conditions: "sunny" });
    });
    app.get("/premium", (_request, response) => {
      response.json({ report: "…" });
    });
    app.get("/health", (_request, response) => {
      response.json({ ok: true });
    });
    sellerServer = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => sellerServer.once("listening", resolve));
    sellerPort = (sellerServer.address() as AddressInfo).port;
    sellerUrl = `http://127.0.0.1:${String(sellerPort)}`;
  });

  afterAll(async () => {
    for (const mcp of mcpSellers) await mcp.close();
    await new Promise((resolve) => sellerServer.close(resolve));
    await Promise.all([rail402.stop(), proxy.close()]);
  });

  const buyerFor = async (payer: Keypair, overrides: Partial<BuyerOptions> = {}): Promise<Buyer> =>
    createBuyer({
      network: TESTNET,
      signer: KeyHolder.fromSecret(payer.secret()),
      rpcUrl: proxy.url,
      bazaarUrl: rail402.url,
      facilitatorUrl: rail402.url,
      policy: {
        assets: [{ asset: usdc.sac, symbol: "USDC", decimals: 7, perCall: "0.5", sessionTotal: "2" }],
      },
      egress: {
        schemes: ["http:"],
        ports: [sellerPort, ...mcpSellers.map((mcp) => mcp.port)],
        allowPrivateNetwork: "loopback",
      },
      ...overrides,
    });

  it("pays an HTTP resource by URL with the stock client, without custody", async () => {
    const [payer] = (await net.holders(usdc, 1, "10")) as [Keypair];
    const events: PaymentEvent[] = [];
    const buyer = await buyerFor(payer, { onEvent: (event) => events.push(event) });
    const [payerBefore, sellerBefore, sponsorBefore] = await Promise.all([
      net.tokenBalance(usdc.sac, payer.publicKey()),
      net.tokenBalance(usdc.sac, seller.publicKey()),
      net.tokenBalance(usdc.sac, rail402.sponsor).catch(() => 0n),
    ]);

    const result = await buyer.pay(
      { kind: "http", url: `${sellerUrl}/weather`, query: { city: "Ankara" } },
      { maxAmount: { amount: "0.05", asset: "USDC" }, idempotencyKey: "weather-ankara-1" },
    );
    expect(result.paid).toBe(true);
    expect(result.response).toMatchObject({ status: 200, json: { city: "Ankara", conditions: "sunny" } });
    expect(result.payment).toMatchObject({
      status: "settled",
      asset: "USDC",
      authorized: { amount: "0.015", atomic: "150000" },
      payTo: seller.publicKey(),
      payer: payer.publicKey(),
      verifiedOnChain: true,
    });
    const hash = result.payment?.transaction ?? "";
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.payment?.explorerUrl).toBe(`https://stellar.expert/explorer/testnet/tx/${hash}`);
    expect(result.budget?.assets[0]).toMatchObject({ spent: "0.015", pending: "0", remaining: "1.985" });

    expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(payerBefore - 150_000n);
    expect(await net.tokenBalance(usdc.sac, seller.publicKey())).toBe(sellerBefore + 150_000n);
    expect(await net.tokenBalance(usdc.sac, rail402.sponsor).catch(() => 0n)).toBe(sponsorBefore);
    expect(events.filter((event) => event.type === "signed")).toHaveLength(1);

    // The same key again: the stored result, no second payment.
    const replay = await buyer.pay(
      { kind: "http", url: `${sellerUrl}/weather`, query: { city: "Ankara" } },
      { maxAmount: { amount: "0.05", asset: "USDC" }, idempotencyKey: "weather-ankara-1" },
    );
    expect(replay).toMatchObject({ replayed: true, payment: { transaction: hash } });
    expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(payerBefore - 150_000n);

    const report = await buyer.inspectTransaction(hash);
    expect(report).toMatchObject({
      hash,
      status: "SUCCESS",
      x402: { shape: "exact" },
      facilitator: { url: rail402.url, attributed: true },
      transfers: [
        {
          contract: usdc.sac,
          symbol: "USDC",
          from: payer.publicKey(),
          to: seller.publicKey(),
          amount: { atomic: "150000", decimal: "0.015" },
        },
      ],
      authorizations: [{ address: payer.publicKey(), signed: true, subInvocations: 0 }],
    });
    expect(report.feeBump?.outerHash).toBe(hash);
    expect(JSON.stringify(report)).not.toMatch(/AAAA[A-Za-z0-9+/]{60,}/);
    await buyer.close();
  });

  it("serves a free resource and refuses a price above the cap with balances unchanged", async () => {
    const [payer] = (await net.holders(usdc, 1, "10")) as [Keypair];
    const buyer = await buyerFor(payer);
    const free = await buyer.pay(
      { kind: "http", url: `${sellerUrl}/health` },
      { maxAmount: { amount: "0.05" } },
    );
    expect(free).toMatchObject({ paid: false, response: { json: { ok: true } } });

    const before = await net.tokenBalance(usdc.sac, payer.publicKey());
    const error: unknown = await buyer
      .pay({ kind: "http", url: `${sellerUrl}/premium` }, { maxAmount: { amount: "5" } })
      .catch((caught: unknown) => caught);
    expect(isPaymentError(error) && error.code).toBe("payment_per_call_cap_exceeded");
    expect(isPaymentError(error) && error.details).toMatchObject({
      price: "0.9",
      cap: "0.5",
      requested: "5",
    });
    expect(await net.tokenBalance(usdc.sac, payer.publicKey())).toBe(before);
    await buyer.close();
  });

  it("finds the cataloged resource and pays it through its listing", async () => {
    await rail402.runtime.bazaar?.catalog.checkOrigins();
    await rail402.runtime.bazaar?.catalog.enrich();
    await rail402.runtime.bazaar?.search.refresh();
    const [payer] = (await net.holders(usdc, 1, "10")) as [Keypair];
    const buyer = await buyerFor(payer);

    const list = await buyer.list({ payTo: seller.publicKey() });
    const hit = list.hits.find((candidate) => candidate.resource === `${sellerUrl}/weather`);
    expect(hit).toMatchObject({
      type: "http",
      method: "GET",
      owner: seller.publicKey(),
      trust: "origin_verified",
      callable: true,
      withinPolicy: true,
      prices: [{ amount: "0.015", asset: "USDC", receivable: true }],
    });

    const viaListing = await buyer.payListing(
      hit?.listingId ?? "",
      { query: { city: "Izmir" } },
      {
        maxAmount: { amount: "0.05" },
      },
    );
    expect(viaListing).toMatchObject({ paid: true, payment: { status: "settled", verifiedOnChain: true } });

    const found = await buyer.searchAndPay("current weather for a city", {
      maxAmount: { amount: "0.05" },
      call: { query: { city: "Van" } },
    });
    expect(found.chosen.resource).toBe(`${sellerUrl}/weather`);
    expect(found).toMatchObject({ paid: true, response: { json: { city: "Van" } } });
    expect((await buyer.budget()).assets[0]).toMatchObject({ spent: "0.03" });
    await buyer.close();
  });

  it.each(["stateless", "sse"] as const)(
    "pays a stock @x402/mcp tool (%s) settled on chain",
    async (mode) => {
      const mcp = await startMcpSeller({
        mode,
        facilitator: new HTTPFacilitatorClient({ url: rail402.url }),
        payTo: seller.publicKey(),
        asset: usdc.sac,
        amount: "250000",
      });
      mcpSellers.push(mcp);
      const [payer] = (await net.holders(usdc, 1, "10")) as [Keypair];
      const buyer = await buyerFor(payer);
      const before = await net.tokenBalance(usdc.sac, seller.publicKey());
      const result = await buyer.pay(
        {
          kind: "mcp",
          url: mcp.url,
          toolName: "forecast",
          arguments: { city: "Trabzon" },
          ...(mode === "sse" ? { transport: "sse" } : {}),
        },
        { maxAmount: { amount: "0.05" } },
      );
      expect(result).toMatchObject({
        paid: true,
        response: { kind: "mcp", isError: false, content: [{ text: "Sunny in Trabzon" }] },
        payment: { status: "settled", verifiedOnChain: true, authorized: { amount: "0.025" } },
      });
      expect(await net.tokenBalance(usdc.sac, seller.publicKey())).toBe(before + 250_000n);
      expect(mcp.calls.filter((call) => call.paid)).toHaveLength(1);
      await buyer.close();
    },
  );
});
