/**
 * rail402-mcp end to end on the private Stellar network: the bin is spawned over stdio exactly as an
 * MCP host runs it, configured only through the environment, and pays stock @x402/express and
 * @x402/mcp sellers that settle through Rail402 running in this process. The Stellar RPC is fronted
 * by a TLS proxy (the upstream client only reaches an https RPC), trusted through NODE_EXTRA_CA_CERTS.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Keypair } from "@stellar/stellar-sdk";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { paymentMiddleware } from "@x402/express";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { ExactStellarScheme as ExactStellarServer } from "@x402/stellar/exact/server";
import { TESTNET } from "@rail402.dev/stellar";
import { LocalNetwork, startTlsRpcProxy, type IssuedAsset, type TlsRpcProxy } from "@rail402.dev/testkit";
import { startMcpSeller, type McpSeller } from "../../sdk/test/mcp-seller.ts";
import { startRail402, type RunningRail402 } from "../../sdk/test/service.ts";

const net = new LocalNetwork();
const available = await net.available();
const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));

interface Output {
  ok: boolean;
  [key: string]: unknown;
}

describe.skipIf(!available)("rail402-mcp on the local network", () => {
  let tusd: IssuedAsset;
  let rail402: RunningRail402;
  let proxy: TlsRpcProxy;
  let seller: Keypair;
  let payer: Keypair;
  let sellerServer: Server;
  let sellerUrl: string;
  let mcpSeller: McpSeller;
  let client: Client;
  let directory: string;
  const stderr: string[] = [];

  const call = async (name: string, args: Record<string, unknown>): Promise<Output> => {
    const result = await client.callTool({ name, arguments: args });
    const output = result.structuredContent as Output | undefined;
    expect(result.isError).toBe(output?.ok === false);
    return output as Output;
  };
  const balance = (holder: string) => net.tokenBalance(tusd.sac, holder).catch(() => 0n);

  beforeAll(async () => {
    tusd = await net.issueAsset("TUSD");
    [rail402, proxy] = await Promise.all([startRail402(net, tusd), startTlsRpcProxy(net.rpcUrl)]);
    [seller] = (await net.holders(tusd, 1, "0")) as [Keypair];
    [payer] = (await net.holders(tusd, 1, "10")) as [Keypair];

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
              price: { amount: "150000", asset: tusd.sac },
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
        },
        resourceServer,
      ),
    );
    app.get("/weather", (request, response) => {
      response.json({ city: request.query["city"] ?? null, temperature: 21, conditions: "sunny" });
    });
    app.get("/health", (_request, response) => {
      response.json({ ok: true });
    });
    sellerServer = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => sellerServer.once("listening", resolve));
    const sellerPort = (sellerServer.address() as AddressInfo).port;
    sellerUrl = `http://127.0.0.1:${String(sellerPort)}`;
    mcpSeller = await startMcpSeller({
      mode: "stateless",
      facilitator: new HTTPFacilitatorClient({ url: rail402.url }),
      payTo: seller.publicKey(),
      asset: tusd.sac,
      amount: "250000",
    });

    directory = mkdtempSync(join(tmpdir(), "rail402-mcp-it-"));
    const keyFile = join(directory, "buyer.key");
    writeFileSync(keyFile, payer.secret(), { mode: 0o600 });
    const caFile = join(directory, "rpc-ca.pem");
    writeFileSync(caFile, proxy.certificate);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--conditions=@rail402/source", bin],
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: directory,
        NODE_EXTRA_CA_CERTS: caFile,
        RAIL402_NETWORK: TESTNET,
        RAIL402_RPC_URL: proxy.url,
        RAIL402_BAZAAR_URL: rail402.url,
        RAIL402_SECRET_KEY_FILE: keyFile,
        RAIL402_ASSETS: `TUSD:${tusd.sac}:7`,
        RAIL402_MAX_PER_CALL: "0.5 TUSD",
        RAIL402_MAX_TOTAL: "2 TUSD",
        RAIL402_ALLOW_HTTP: "true",
        RAIL402_ALLOW_PRIVATE_NETWORK: "loopback",
        RAIL402_ALLOWED_PORTS: `${String(sellerPort)},${String(mcpSeller.port)}`,
        RAIL402_LEDGER_PATH: join(directory, "ledger.sqlite"),
        RAIL402_LOG_LEVEL: "info",
      },
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
    client = new Client({ name: "rail402-mcp-it", version: "1" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client.close();
    await mcpSeller.close();
    await new Promise((resolve) => sellerServer.close(resolve));
    await Promise.all([rail402.stop(), proxy.close()]);
    rmSync(directory, { recursive: true, force: true });
  });

  it("reports the payer, the policy and an empty budget", async () => {
    const output = await call("get_budget", {});
    expect(output).toMatchObject({
      ok: true,
      network: TESTNET,
      payer: payer.publicKey(),
      payments: "enabled",
      budget: {
        assets: [{ asset: "USDC" }, { asset: "TUSD", perCallCap: "0.5", sessionCap: "2", spent: "0" }],
      },
    });
  });

  it("pays an HTTP resource by URL without custody, and replays a repeated key without paying", async () => {
    const [payerBefore, sellerBefore, sponsorBefore] = await Promise.all([
      balance(payer.publicKey()),
      balance(seller.publicKey()),
      balance(rail402.sponsor),
    ]);
    const args = {
      resource: `${sellerUrl}/weather`,
      query: { city: "Ankara" },
      spendingCap: { amount: "0.05", asset: "TUSD" },
      idempotencyKey: "mcp-weather-ankara-1",
    };
    const output = await call("pay_and_call", args);
    expect(output).toMatchObject({
      ok: true,
      paid: true,
      replayed: false,
      target: { type: "http", method: "GET", listingId: null },
      payment: {
        status: "settled",
        verifiedOnChain: true,
        asset: "TUSD",
        payer: payer.publicKey(),
        payTo: seller.publicKey(),
        authorized: { amount: "0.015", atomic: "150000" },
      },
      response: { kind: "http", status: 200, json: { city: "Ankara", conditions: "sunny" } },
    });
    const payment = output["payment"] as { transaction: string; explorerUrl: string };
    expect(payment.transaction).toMatch(/^[0-9a-f]{64}$/);
    expect(payment.explorerUrl).toContain(payment.transaction);
    expect(await balance(payer.publicKey())).toBe(payerBefore - 150_000n);
    expect(await balance(seller.publicKey())).toBe(sellerBefore + 150_000n);
    expect(await balance(rail402.sponsor)).toBe(sponsorBefore);

    const replay = await call("pay_and_call", args);
    expect(replay).toMatchObject({ ok: true, replayed: true, payment: { transaction: payment.transaction } });
    expect(await balance(payer.publicKey())).toBe(payerBefore - 150_000n);
  });

  it("refuses a price above the caller's cap before signing", async () => {
    const before = await balance(payer.publicKey());
    const output = await call("pay_and_call", {
      resource: `${sellerUrl}/weather`,
      query: { city: "Van" },
      spendingCap: { amount: "0.01", asset: "TUSD" },
    });
    expect(output).toMatchObject({
      ok: false,
      error: { code: "payment_per_call_cap_exceeded", paid: "none", details: { price: "0.015" } },
    });
    expect(await balance(payer.publicKey())).toBe(before);
  });

  it("finds the cataloged resource by search and pays it through its listing", async () => {
    // Cataloging follows the settlement asynchronously; wait until the listing is searchable.
    let result: { resource: string; listingId: string } | undefined;
    for (let attempt = 0; attempt < 20 && result === undefined; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 500));
      await rail402.runtime.bazaar?.catalog.checkOrigins();
      await rail402.runtime.bazaar?.catalog.enrich();
      await rail402.runtime.bazaar?.search.refresh();
      const found = await call("search_stellar_resources", {
        query: "current weather for a city",
        type: "http",
      });
      expect(found).toMatchObject({ ok: true, network: TESTNET });
      result = (found["results"] as { resource: string; listingId: string }[]).find(
        (candidate) => candidate.resource === `${sellerUrl}/weather`,
      );
    }
    expect(result).toMatchObject({
      callable: true,
      withinPolicy: true,
      prices: [{ amount: "0.015", asset: "TUSD", payTo: seller.publicKey() }],
    });

    const output = await call("pay_and_call", {
      listingId: result?.listingId,
      query: { city: "Izmir" },
      spendingCap: { amount: "0.05", asset: "TUSD" },
    });
    expect(output).toMatchObject({
      ok: true,
      paid: true,
      target: { type: "http", listingId: result?.listingId, resource: `${sellerUrl}/weather` },
      payment: { status: "settled", verifiedOnChain: true },
      response: { json: { city: "Izmir" } },
    });
  });

  it("pays a stock @x402/mcp tool by endpoint and tool name", async () => {
    const before = await balance(seller.publicKey());
    const output = await call("pay_and_call", {
      resource: mcpSeller.url,
      toolName: "forecast",
      arguments: { city: "Trabzon" },
      spendingCap: { amount: "0.05", asset: "TUSD" },
    });
    expect(output).toMatchObject({
      ok: true,
      paid: true,
      target: { type: "mcp", toolName: "forecast" },
      payment: { status: "settled", verifiedOnChain: true, authorized: { amount: "0.025" } },
      response: { kind: "mcp", isError: false, content: [{ type: "text", text: "Sunny in Trabzon" }] },
    });
    expect(await balance(seller.publicKey())).toBe(before + 250_000n);

    const budget = await call("get_budget", {});
    expect(budget).toMatchObject({
      budget: {
        assets: [
          { asset: "USDC", spent: "0" },
          { asset: "TUSD", spent: "0.055", pending: "0" },
        ],
      },
    });
    // Logs are on stderr and never carry the key.
    expect(stderr.join("")).not.toContain(payer.secret());
  });
});
