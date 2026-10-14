/**
 * Seller helpers end to end on the private Stellar network (docker compose --profile stellar up -d): a
 * seller declared only with @rail402.dev/sdk/seller, on stock @x402/express and @x402/mcp, is paid by
 * the SDK and cataloged by Rail402 running in this process; the listings match the declarations and
 * validate under the catalog's own rules.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { Keypair } from "@stellar/stellar-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { PaymentRequired } from "@x402/core/types";
import { paymentMiddleware } from "@x402/express";
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { createPaymentWrapper } from "@x402/mcp";
import { ExactStellarScheme as ExactStellarServer } from "@x402/stellar/exact/server";
import { TESTNET } from "@rail402.dev/stellar";
import {
  LocalNetwork,
  deploySimpleAccount,
  randomContractId,
  startTlsRpcProxy,
  type IssuedAsset,
  type TlsRpcProxy,
} from "@rail402.dev/testkit";
import { KeyHolder, createBuyer, type Buyer } from "@rail402.dev/sdk";
import {
  assetDecimals,
  checkSellerOrigin,
  isSellerError,
  exact,
  httpRoute,
  mcpPaymentConfig,
  mcpTool,
  param,
  validateListing,
  withSettleDedupe,
  type CheckSellerOriginOptions,
  type HttpRouteDeclaration,
  type McpToolDeclaration,
  type RepeatEvent,
  type SellerError,
} from "@rail402.dev/sdk/seller";
import { startRail402, type RunningRail402 } from "./service.ts";

const net = new LocalNetwork();
const available = await net.available();

interface DiscoveryItem {
  readonly resource: string;
  readonly type: string;
  readonly accepts: PaymentRequired["accepts"];
  readonly description?: string;
  readonly serviceName?: string;
  readonly tags?: string[];
  readonly extensions: Record<string, Record<string, unknown>>;
  readonly rail402: { readonly method?: string; readonly toolName?: string; readonly trust: string };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? undefined : (JSON.parse(text) as unknown);
}

describe.skipIf(!available)("seller helpers on the local network", () => {
  let usdc: IssuedAsset;
  let rail402: RunningRail402;
  let proxy: TlsRpcProxy;
  let seller: Keypair;
  let orphan: Keypair;
  let httpServer: Server;
  let mcpServer: Server;
  let sellerUrl: string;
  let mcpUrl: string;
  let forecast: HttpRouteDeclaration;
  let translate: HttpRouteDeclaration;
  let unreceivable: HttpRouteDeclaration;
  let report: HttpRouteDeclaration;
  let airQuality: McpToolDeclaration;
  const signatures: string[] = [];
  const repeats: RepeatEvent[] = [];
  let mcpCalls = 0;
  let reportsServed = 0;

  beforeAll(async () => {
    usdc = await net.issueAsset("USDC");
    [rail402, proxy] = await Promise.all([startRail402(net, usdc), startTlsRpcProxy(net.rpcUrl)]);
    proxy.trust();
    [seller] = (await net.holders(usdc, 1, "0")) as [Keypair];
    orphan = Keypair.random();
    await net.fund(orphan);

    // The price converts with the token's on-chain decimals.
    const decimals = await assetDecimals(usdc.sac, { network: TESTNET, rpcUrl: net.rpcUrl, allowHttp: true });
    const pay = (amount: string, payTo = seller.publicKey()) =>
      exact({ network: TESTNET, payTo, price: { amount, asset: usdc.sac, decimals } });

    forecast = httpRoute({
      method: "GET",
      path: "/forecast/:city",
      description: "Seven-day weather forecast for a city",
      payment: pay("0.02"),
      pathParams: { city: param.string({ description: "City name", example: "Ankara", maxLength: 64 }) },
      query: { days: param.integer({ description: "Number of days", minimum: 1, maximum: 7, example: 3 }) },
      output: { example: { city: "Ankara", days: [{ high: 21, low: 9 }] } },
      serviceName: "Local Weather",
      tags: ["weather"],
    });
    translate = httpRoute({
      method: "POST",
      path: "/translate",
      description: "Translate text into another language",
      payment: pay("0.03"),
      body: {
        type: "json",
        params: {
          text: param.string({ description: "Text to translate", required: true, example: "merhaba" }),
          target: param.string({
            description: "Target language, ISO 639-1",
            required: true,
            example: "en",
            pattern: "^[a-z]{2}$",
          }),
        },
      },
      output: { example: { text: "hello" } },
    });
    unreceivable = httpRoute({
      method: "GET",
      path: "/orphan",
      description: "A resource whose payTo cannot receive the asset",
      payment: pay("0.01", orphan.publicKey()),
      output: { example: { ok: true } },
    });

    report = httpRoute({
      method: "GET",
      path: "/report",
      description: "A daily market report, settled before it is generated",
      payment: exact({
        network: TESTNET,
        payTo: seller.publicKey(),
        price: { amount: "0.01", asset: usdc.sac, decimals },
        paymentFlow: "upfront",
      }),
      output: { example: { report: "…" } },
    });

    const resourceServer = new x402ResourceServer(
      withSettleDedupe(new HTTPFacilitatorClient({ url: rail402.url }), {
        onRepeat: (event) => repeats.push(event),
      }),
    )
      .register(TESTNET, new ExactStellarServer())
      .registerExtension(bazaarResourceServerExtension);

    const app = express();
    app.use((request, _response, next) => {
      const signature = request.headers["payment-signature"];
      if (typeof signature === "string") signatures.push(signature);
      next();
    });
    app.use(
      paymentMiddleware(
        {
          [forecast.key]: forecast.config,
          [translate.key]: translate.config,
          [unreceivable.key]: unreceivable.config,
          [report.key]: report.config,
        },
        resourceServer,
      ),
    );
    app.use(express.json());
    app.get("/forecast/:city", (request, response) => {
      response.json({ city: request.params.city, days: [{ high: 21, low: 9 }] });
    });
    app.post("/translate", (request, response) => {
      const body = request.body as { text?: string };
      response.json({ text: body.text === "merhaba" ? "hello" : "?" });
    });
    app.get("/report", (_request, response) => {
      reportsServed++;
      response.json({ report: "markets closed higher" });
    });
    app.get("/orphan", (_request, response) => {
      response.json({ ok: true });
    });
    httpServer = createServer(app);
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    sellerUrl = `http://127.0.0.1:${String((httpServer.address() as AddressInfo).port)}`;

    // The MCP seller: the tool's zod shape and payment configuration both come from its declaration.
    mcpServer = createServer();
    await new Promise<void>((resolve) => mcpServer.listen(0, "127.0.0.1", resolve));
    mcpUrl = `http://127.0.0.1:${String((mcpServer.address() as AddressInfo).port)}/mcp`;
    airQuality = mcpTool({
      endpoint: mcpUrl,
      toolName: "air_quality",
      description: "Air quality index for a city",
      payment: pay("0.025"),
      arguments: {
        city: param.string({ description: "City name", required: true, example: "Izmir" }),
        pollutant: param.enum(["pm25", "pm10", "o3"], {
          description: "Pollutant to report",
          example: "pm25",
        }),
      },
      output: { example: { city: "Izmir", aqi: 42 } },
      transport: "streamable-http",
    });
    await resourceServer.initialize();
    const paid = createPaymentWrapper(resourceServer, await mcpPaymentConfig(resourceServer, airQuality));
    const handler = paid((args: { city: string; pollutant?: string }) => {
      mcpCalls++;
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ city: args.city, aqi: 42 }) }],
      };
    });
    mcpServer.on("request", (request: IncomingMessage, response) => {
      void (async () => {
        const server = new McpServer({ name: "air", version: "1.0.0" });
        server.registerTool(
          airQuality.toolName,
          { description: airQuality.description, inputSchema: airQuality.zodShape },
          (args, extra) => handler(args as { city: string; pollutant?: string }, extra),
        );
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        response.on("close", () => {
          void transport.close();
          void server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(request, response, await readJson(request));
      })().catch(() => {
        if (!response.headersSent) response.writeHead(500).end();
      });
    });
  });

  afterAll(async () => {
    for (const server of [httpServer, mcpServer]) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await Promise.all([rail402.stop(), proxy.close()]);
  });

  const buyerFor = async (payer: Keypair): Promise<Buyer> =>
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
        ports: [new URL(sellerUrl).port, new URL(mcpUrl).port].map(Number),
        allowPrivateNetwork: "loopback",
      },
    });

  it("refuses to price in a contract whose decimals it cannot read", async () => {
    const deployer = Keypair.random();
    await net.fund(deployer);
    const notAToken = await deploySimpleAccount(net, deployer, Keypair.random());
    const unreadable = async (asset: string, rpcUrl = net.rpcUrl) => {
      const error: unknown = await assetDecimals(asset, { network: TESTNET, rpcUrl, allowHttp: true }).catch(
        (caught: unknown) => caught,
      );
      expect(isSellerError(error), asset).toBe(true);
      return error as SellerError;
    };
    for (const [asset, rpcUrl] of [
      [notAToken, net.rpcUrl],
      [randomContractId(), net.rpcUrl],
      [usdc.sac, "http://127.0.0.1:1/rpc"],
    ] as const) {
      const error = await unreadable(asset, rpcUrl);
      expect(error.code, asset).toBe("seller_asset_unreadable");
      expect(error.reason, asset).toEqual(expect.any(String));
      expect(error.details, asset).toMatchObject({ asset });
    }
  });

  it("passes its own checks before selling", async () => {
    for (const declared of [forecast, translate]) {
      const report = await validateListing(declared, {
        network: TESTNET,
        concreteUrl: `${sellerUrl}${declared.examplePath}`,
        allowLoopback: true,
      });
      expect(report).toMatchObject({ catalogable: true, dropped: [], lint: [] });
    }
    const checks: CheckSellerOriginOptions = {
      network: TESTNET,
      rpcUrl: net.rpcUrl,
      facilitatorUrl: rail402.url,
      allowLoopback: true,
    };
    const http = await checkSellerOrigin(`${sellerUrl}/forecast/Izmir`, checks);
    expect(http).toMatchObject({
      ok: true,
      findings: [],
      receivable: [{ asset: usdc.sac, payTo: seller.publicKey(), receivable: true }],
      validation: {
        catalogable: true,
        lint: [],
        preview: { routeTemplate: "/forecast/:city", amount: "200000" },
      },
    });
    const body = await checkSellerOrigin(`${sellerUrl}/translate`, { ...checks, method: "POST" });
    expect(body).toMatchObject({ ok: true, validation: { preview: { method: "POST" } } });
    const tool = await checkSellerOrigin(mcpUrl, {
      ...checks,
      toolName: "air_quality",
      arguments: { city: "Izmir" },
    });
    expect(tool).toMatchObject({
      ok: true,
      type: "mcp",
      validation: { catalogable: true, lint: [], preview: { type: "mcp", toolName: "air_quality" } },
    });
    expect(mcpCalls).toBe(0);

    const orphaned = await checkSellerOrigin(`${sellerUrl}/orphan`, checks);
    expect(orphaned).toMatchObject({
      ok: false,
      validation: { catalogable: true },
      findings: [{ code: "seller_asset_not_receivable", details: { payTo: orphan.publicKey() } }],
    });
  });

  it("is paid by the SDK and cataloged with the declared metadata", async () => {
    const [payer] = (await net.holders(usdc, 1, "10")) as [Keypair];
    const buyer = await buyerFor(payer);
    const before = await net.tokenBalance(usdc.sac, seller.publicKey());

    const weather = await buyer.pay(
      { kind: "http", url: `${sellerUrl}/forecast/Izmir`, query: { days: "3" } },
      { maxAmount: { amount: "0.05" } },
    );
    expect(weather).toMatchObject({ paid: true, response: { status: 200, json: { city: "Izmir" } } });
    const translated = await buyer.pay(
      {
        kind: "http",
        url: `${sellerUrl}/translate`,
        method: "POST",
        body: { text: "merhaba", target: "en" },
      },
      { maxAmount: { amount: "0.05" } },
    );
    expect(translated).toMatchObject({ paid: true, response: { json: { text: "hello" } } });
    const air = await buyer.pay(
      { kind: "mcp", url: mcpUrl, toolName: "air_quality", arguments: { city: "Izmir", pollutant: "pm25" } },
      { maxAmount: { amount: "0.05" } },
    );
    expect(air).toMatchObject({ paid: true, response: { kind: "mcp", isError: false } });
    expect(mcpCalls).toBe(1);
    expect(await net.tokenBalance(usdc.sac, seller.publicKey())).toBe(before + 750_000n);
    expect(repeats).toEqual([]);
    await buyer.close();

    await rail402.runtime.bazaar?.catalog.checkOrigins();
    const response = await fetch(`${rail402.url}/discovery/resources?payTo=${seller.publicKey()}&limit=20`);
    const { items } = (await response.json()) as { items: DiscoveryItem[] };
    const byResource = new Map(items.map((item) => [item.resource, item]));

    const weatherItem = byResource.get(`${sellerUrl}/forecast/:city`);
    expect(weatherItem).toMatchObject({
      type: "http",
      description: forecast.config.description,
      serviceName: "Local Weather",
      tags: ["weather"],
      accepts: [{ amount: "200000", asset: usdc.sac, payTo: seller.publicKey() }],
      extensions: { bazaar: { routeTemplate: "/forecast/:city" } },
      rail402: { method: "GET", trust: "origin_verified" },
    });
    const declared = forecast.config.extensions?.["bazaar"] as { info: { input: Record<string, unknown> } };
    const listed = weatherItem?.extensions["bazaar"] as { info: { input: Record<string, unknown> } };
    expect(listed.info.input["queryParams"]).toEqual(declared.info.input["queryParams"]);

    expect(byResource.get(`${sellerUrl}/translate`)).toMatchObject({
      rail402: { method: "POST", trust: "origin_verified" },
      extensions: {
        bazaar: { info: { input: { bodyType: "json", body: { text: "merhaba", target: "en" } } } },
      },
    });

    const toolItem = byResource.get(mcpUrl);
    expect(toolItem).toMatchObject({
      type: "mcp",
      rail402: { toolName: "air_quality", trust: "origin_verified" },
    });
    const toolInfo = toolItem?.extensions["bazaar"] as { info: { input: Record<string, unknown> } };
    expect(toolInfo.info.input["inputSchema"]).toEqual(airQuality.inputSchema);

    // Each listing, as the catalog publishes it, validates under the catalog's rules.
    for (const [item, url] of [
      [weatherItem, `${sellerUrl}/forecast/Izmir`],
      [byResource.get(`${sellerUrl}/translate`), `${sellerUrl}/translate`],
      [toolItem, mcpUrl],
    ] as const) {
      const report = await validateListing(
        {
          x402Version: 2,
          resource: { url, description: item?.description ?? "" },
          accepts: item?.accepts ?? [],
          extensions: item?.extensions ?? {},
        },
        { network: TESTNET, allowLoopback: true },
      );
      expect(report).toMatchObject({ catalogable: true, dropped: [], lint: [] });
    }
  });

  it("does not serve a replayed payment signature again", async () => {
    const [signature] = signatures;
    expect(signature).toBeDefined();
    const before = await net.tokenBalance(usdc.sac, seller.publicKey());
    const replay = await fetch(`${sellerUrl}/forecast/Izmir?days=3`, {
      headers: { "payment-signature": signature ?? "" },
    });
    // Verified before the handler: the facilitator refuses the used authorization.
    expect(replay.status).toBe(402);
    expect(await replay.text()).not.toContain("Izmir");
    expect(await net.tokenBalance(usdc.sac, seller.publicKey())).toBe(before);
  });

  it("serves an upfront settlement once when the facilitator answers its repeat", async () => {
    const [payer] = (await net.holders(usdc, 1, "10")) as [Keypair];
    const buyer = await buyerFor(payer);
    signatures.length = 0;
    const paid = await buyer.pay(
      { kind: "http", url: `${sellerUrl}/report` },
      { maxAmount: { amount: "0.05" } },
    );
    expect(paid).toMatchObject({ paid: true, response: { status: 200 } });
    await buyer.close();
    expect(reportsServed).toBe(1);
    const [signature] = signatures.slice(-1);
    const before = await net.tokenBalance(usdc.sac, seller.publicKey());

    // An upfront flow settles without verifying first, and the facilitator answers a repeated
    // settlement idempotently: the seller's dedupe is what keeps the report from being served twice.
    const replay = await fetch(`${sellerUrl}/report`, { headers: { "payment-signature": signature ?? "" } });
    expect(replay.status).toBe(402);
    expect(await replay.text()).not.toContain("markets");
    expect(reportsServed).toBe(1);
    expect(repeats).toHaveLength(1);
    expect(repeats[0]).toMatchObject({ transaction: paid.payment?.transaction, network: TESTNET });
    expect(await net.tokenBalance(usdc.sac, seller.publicKey())).toBe(before);
  });
});
