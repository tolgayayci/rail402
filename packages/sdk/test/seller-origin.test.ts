import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { decodePaymentRequiredHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import { x402ResourceServer } from "@x402/core/server";
import { paymentMiddleware } from "@x402/express";
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { PUBNET, TESTNET } from "@rail402.dev/stellar";
import { MAX_RECEIVABLE_CHECKS, checkSellerOrigin, exact, httpRoute, param } from "@rail402.dev/sdk/seller";
import { acceptingFacilitator, startMcpSeller, type McpSeller } from "./mcp-seller.ts";
import { TX_HASH } from "./flow-harness.ts";

const payTo = Keypair.random().publicKey();

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

function supportedServer(body: unknown): Server {
  return createServer((request, response) => {
    if (request.url === "/supported") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
      return;
    }
    response.writeHead(404).end();
  });
}

describe("checkSellerOrigin", () => {
  const route = httpRoute({
    method: "GET",
    path: "/forecast/:city",
    description: "Seven-day weather forecast for a city",
    payment: exact({ network: TESTNET, payTo, price: "$0.01" }),
    pathParams: { city: param.string({ description: "City name", example: "Ankara" }) },
    output: { example: { city: "Ankara", high: 21 } },
  });
  const servers: Server[] = [];
  let seller = "";
  let goodFacilitator = "";
  let poorFacilitator = "";
  let mcp: McpSeller;

  beforeAll(async () => {
    const facilitator = acceptingFacilitator(TX_HASH);
    const resourceServer = new x402ResourceServer(facilitator)
      .register(TESTNET, new ExactStellarScheme())
      .registerExtension(bazaarResourceServerExtension);
    const app = express();
    app.use(paymentMiddleware({ [route.key]: route.config }, resourceServer));
    app.get("/forecast/:city", (request, response) => {
      response.json({ city: request.params.city, high: 21 });
    });
    app.get("/health", (_request, response) => {
      response.json({ ok: true });
    });
    const sellerServer = createServer(app);
    const good = supportedServer({
      kinds: [{ x402Version: 2, scheme: "exact", network: TESTNET, extra: { areFeesSponsored: true } }],
      extensions: ["bazaar"],
      signers: {},
    });
    const poor = supportedServer({
      kinds: [{ x402Version: 2, scheme: "exact", network: TESTNET, extra: {} }],
      extensions: [],
      signers: {},
    });
    servers.push(sellerServer, good, poor);
    [seller, goodFacilitator, poorFacilitator] = await Promise.all([
      listen(sellerServer),
      listen(good),
      listen(poor),
    ]);
    mcp = await startMcpSeller({
      mode: "stateless",
      facilitator,
      payTo,
      asset: route.options[0]?.price.asset ?? "",
      amount: "1000",
    });
  });

  afterAll(async () => {
    await mcp.close();
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("validates a helper-declared route's live 402 and the facilitator", async () => {
    const report = await checkSellerOrigin(`${seller}/forecast/Izmir`, {
      network: TESTNET,
      facilitatorUrl: goodFacilitator,
      allowLoopback: true,
    });
    expect(report).toMatchObject({
      type: "http",
      ok: true,
      status: 402,
      findings: [],
      validation: {
        catalogable: true,
        dropped: [],
        lint: [],
        preview: { type: "http", method: "GET", routeTemplate: "/forecast/:city", payTo, amount: "100000" },
      },
      domain: { claimsOwner: false },
    });
    expect(report.validation?.preview?.resource).toBe(`${seller}/forecast/:city`);
  });

  it("reports a facilitator without sponsored fees or the bazaar extension", async () => {
    const report = await checkSellerOrigin(`${seller}/forecast/Izmir`, {
      facilitatorUrl: poorFacilitator,
      allowLoopback: true,
    });
    expect(report.ok).toBe(false);
    expect(report.findings.map((finding) => finding.code)).toEqual([
      "seller_facilitator_unsupported",
      "seller_facilitator_unsupported",
    ]);
    const unreachable = await checkSellerOrigin(`${seller}/forecast/Izmir`, {
      facilitatorUrl: `${seller}/missing`,
      allowLoopback: true,
    });
    expect(unreachable.findings[0]).toMatchObject({ code: "seller_facilitator_unsupported" });
  });

  it("reads receivability for a bounded number of distinct options, a few at a time", async () => {
    const real = await fetch(`${seller}/forecast/Izmir`);
    const required = decodePaymentRequiredHeader(real.headers.get("payment-required") ?? "");
    const [option] = required.accepts;
    if (option === undefined) throw new Error("no option");
    // 40 options naming 30 distinct asset contracts: a 402 crafted to make the check do RPC work.
    const assets = Array.from({ length: 30 }, () => StrKey.encodeContract(Keypair.random().rawPublicKey()));
    const many = encodePaymentRequiredHeader({
      ...required,
      accepts: Array.from({ length: 40 }, (_, index) => ({ ...option, asset: assets[index % 30] ?? "" })),
    });
    const crafted = createServer((_request, response) => {
      response.writeHead(402, { "payment-required": many }).end();
    });
    let calls = 0;
    let active = 0;
    let peak = 0;
    const rpcServer = createServer((request, response) => {
      calls++;
      active++;
      peak = Math.max(peak, active);
      request.resume();
      request.on("end", () => {
        setTimeout(() => {
          active--;
          response
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32_603, message: "unavailable" } }));
        }, 10);
      });
    });
    servers.push(crafted, rpcServer);
    const [craftedUrl, rpcUrl] = await Promise.all([listen(crafted), listen(rpcServer)]);
    const report = await checkSellerOrigin(`${craftedUrl}/forecast/Izmir`, {
      network: TESTNET,
      rpcUrl,
      allowLoopback: true,
    });
    expect(report.receivable).toHaveLength(30);
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThanOrEqual(MAX_RECEIVABLE_CHECKS * 4);
    // Four pairs at a time, each a few reads (the asset's metadata and the account's trustline).
    expect(peak).toBeLessThanOrEqual(16);
  });

  it("reports a resource that does not ask for payment", async () => {
    expect(await checkSellerOrigin(`${seller}/health`, { allowLoopback: true })).toMatchObject({
      ok: false,
      status: 200,
      findings: [{ code: "seller_origin_not_payment_required" }],
    });
  });

  it("does not reach loopback unless allowed, and flags http on pubnet", async () => {
    const refused = await checkSellerOrigin(`${seller}/forecast/Izmir`);
    expect(refused).toMatchObject({
      ok: false,
      findings: [{ code: "seller_origin_unreachable", details: { cause: "egress_destination_not_allowed" } }],
    });
    const pubnet = await checkSellerOrigin(`${seller}/forecast/Izmir`, {
      network: PUBNET,
      allowLoopback: true,
    });
    expect(pubnet.findings.map((finding) => finding.code)).toEqual([
      "seller_endpoint_invalid",
      "seller_origin_unreachable",
    ]);
  });

  it("makes the unpaid request under a caller's egress policy when one is given", async () => {
    const httpsOnly = { schemes: ["https:"], ports: [443], allowPrivateNetwork: false } as const;
    const refused = await checkSellerOrigin(`${seller}/forecast/Izmir`, {
      allowLoopback: true,
      egress: httpsOnly,
    });
    expect(refused).toMatchObject({
      ok: false,
      findings: [{ code: "seller_origin_unreachable", details: { cause: "egress_scheme_not_allowed" } }],
    });
    const tool = await checkSellerOrigin(mcp.url, {
      toolName: "forecast",
      arguments: { city: "Van" },
      allowLoopback: true,
      egress: httpsOnly,
    });
    expect(tool.findings[0]).toMatchObject({
      code: "seller_origin_unreachable",
      details: { cause: "egress_scheme_not_allowed" },
    });
    const port = Number(new URL(seller).port);
    const allowed = await checkSellerOrigin(`${seller}/forecast/Izmir`, {
      facilitatorUrl: goodFacilitator,
      allowLoopback: true,
      egress: { schemes: ["http:"], ports: [port], allowPrivateNetwork: "loopback" },
    });
    expect(allowed).toMatchObject({ ok: true, status: 402, findings: [] });
  });

  it("checks an MCP tool with an unpaid tools/call", async () => {
    const paid = await checkSellerOrigin(mcp.url, {
      toolName: "forecast",
      arguments: { city: "Van" },
      allowLoopback: true,
    });
    // The stock test seller declares no discovery metadata, so nothing would be cataloged.
    expect(paid).toMatchObject({
      type: "mcp",
      ok: false,
      paymentRequired: { accepts: [{ payTo, amount: "1000" }] },
      validation: { catalogable: false, code: "seller_discovery_missing" },
    });
    expect(mcp.calls.at(-1)).toEqual({ tool: "forecast", paid: false });
    const free = await checkSellerOrigin(mcp.url, {
      toolName: "echo",
      arguments: { text: "hi" },
      allowLoopback: true,
    });
    expect(free.findings).toMatchObject([{ code: "seller_origin_not_payment_required" }]);
  });
});
