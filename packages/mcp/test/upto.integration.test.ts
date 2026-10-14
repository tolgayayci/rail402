/**
 * upto through rail402-mcp on the private Stellar network: the bin is spawned over stdio as an MCP
 * host runs it and pays, with pay_and_call, a seller built with the Rail402 seller helpers that
 * settles through Rail402 running in this process (settlement contract deployed for this run). Zero,
 * partial and maximum charges move exactly the charge, a metered MCP tool is paid for its charge,
 * get_budget shows the cap reserved and only the proven charges spent, and a seller naming itself as
 * the settlement authority is refused before anything is signed.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Keypair } from "@stellar/stellar-sdk";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { TESTNET } from "@rail402.dev/stellar";
import { LocalNetwork } from "@rail402.dev/testkit";
import { startUptoEnvironment, type UptoEnvironment } from "../../sdk/test/upto-seller.ts";

const net = new LocalNetwork();
const available = await net.available();
const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
const CAP = 500_000n;

interface Output {
  ok: boolean;
  [key: string]: unknown;
}

describe.skipIf(!available)("rail402-mcp pays upto resources on the local network", () => {
  let env: UptoEnvironment;
  let payer: Keypair;
  let client: Client;
  let directory: string;
  let impostor: Server;
  let impostorUrl: string;
  const cap = { amount: "0.1", asset: "TUSD" };

  const call = async (name: string, args: Record<string, unknown>): Promise<Output> => {
    const result = await client.callTool({ name, arguments: args });
    const output = result.structuredContent as Output | undefined;
    expect(result.isError).toBe(output?.ok === false);
    return output as Output;
  };
  const balance = (holder: string) => net.tokenBalance(env.asset.sac, holder).catch(() => 0n);

  beforeAll(async () => {
    env = await startUptoEnvironment(net, { code: "TUSD" });
    payer = await net.holder(env.asset, "1");

    impostor = createServer((_request, response) => {
      response
        .writeHead(402, {
          "payment-required": encodePaymentRequiredHeader({
            x402Version: 2,
            error: "Payment required",
            resource: { url: impostorUrl },
            accepts: [
              {
                scheme: "upto",
                network: TESTNET,
                asset: env.asset.sac,
                amount: CAP.toString(),
                payTo: env.seller.publicKey(),
                maxTimeoutSeconds: 120,
                extra: { areFeesSponsored: true, facilitatorAddress: env.seller.publicKey() },
              },
            ],
          }),
        })
        .end("{}");
    });
    await new Promise<void>((resolve) => impostor.listen(0, "127.0.0.1", resolve));
    const impostorPort = (impostor.address() as AddressInfo).port;
    impostorUrl = `http://127.0.0.1:${String(impostorPort)}/report`;

    directory = mkdtempSync(join(tmpdir(), "rail402-mcp-upto-"));
    const keyFile = join(directory, "buyer.key");
    writeFileSync(keyFile, payer.secret(), { mode: 0o600 });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--conditions=@rail402/source", bin],
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: directory,
        RAIL402_NETWORK: TESTNET,
        RAIL402_RPC_URL: net.rpcUrl,
        RAIL402_BAZAAR_URL: env.rail402.url,
        RAIL402_SECRET_KEY_FILE: keyFile,
        RAIL402_ASSETS: `TUSD:${env.asset.sac}:7`,
        RAIL402_MAX_PER_CALL: "0.1 TUSD",
        RAIL402_MAX_TOTAL: "1 TUSD",
        RAIL402_UPTO_CONTRACTS: env.contract.address,
        RAIL402_ALLOW_HTTP: "true",
        RAIL402_ALLOW_PRIVATE_NETWORK: "loopback",
        RAIL402_ALLOWED_PORTS: `${String(env.shop.port)},${String(impostorPort)}`,
        RAIL402_LEDGER_PATH: join(directory, "ledger.sqlite"),
      },
      stderr: "pipe",
    });
    client = new Client(
      { name: "rail402-mcp-upto-it", version: "1" },
      { versionNegotiation: { mode: "auto" } },
    );
    await client.connect(transport);
  }, 180_000);

  afterAll(async () => {
    await client.close();
    impostor.closeAllConnections();
    await new Promise((resolve) => impostor.close(resolve));
    await env.stop();
    rmSync(directory, { recursive: true, force: true });
  });

  it("shows upto enabled with the pinned settlement contract", async () => {
    const budget = await call("get_budget", {});
    expect(budget).toMatchObject({
      ok: true,
      policy: {
        schemes: ["exact", "upto"],
        uptoContracts: [env.contract.address],
        uptoFacilitators: "any",
      },
    });
  });

  it.each([
    ["zero", 0n],
    ["partial", 125_000n],
    ["maximum", CAP],
  ])("pays a %s charge with pay_and_call and moves exactly that", async (_name, charge) => {
    const [payerBefore, sellerBefore] = await Promise.all([
      balance(payer.publicKey()),
      balance(env.seller.publicKey()),
    ]);
    const output = await call("pay_and_call", {
      resource: `${env.shop.url}/metered`,
      query: { charge: charge.toString() },
      spendingCap: cap,
    });
    expect(output).toMatchObject({
      ok: true,
      paid: true,
      payment: {
        status: "settled",
        scheme: "upto",
        authorized: { amount: "0.05", atomic: CAP.toString() },
        settled: { atomic: charge.toString() },
        verifiedOnChain: true,
      },
      response: { kind: "http", status: 200, json: { charged: charge.toString() } },
    });
    expect(await balance(payer.publicKey())).toBe(payerBefore - charge);
    expect(await balance(env.seller.publicKey())).toBe(sellerBefore + charge);
    expect(await balance(env.authority)).toBe(0n);
  });

  it("pays a metered MCP tool for its charge", async () => {
    const output = await call("pay_and_call", {
      resource: env.shop.mcpUrl,
      toolName: "tokens",
      arguments: { prompt: "rain", charge: 42_000 },
      spendingCap: cap,
    });
    expect(output).toMatchObject({
      ok: true,
      payment: { scheme: "upto", settled: { atomic: "42000" }, verifiedOnChain: true },
      response: { kind: "mcp", isError: false },
    });
  });

  it("reports only the proven charges as spent", async () => {
    const budget = await call("get_budget", {});
    expect(budget).toMatchObject({
      ok: true,
      budget: {
        assets: [
          { asset: "USDC", spent: "0" },
          { asset: "TUSD", spent: "0.0667", pending: "0" },
        ],
      },
    });
  });

  it("refuses a seller naming itself as the settlement authority, signing nothing", async () => {
    const before = await balance(payer.publicKey());
    const output = await call("pay_and_call", { resource: impostorUrl, spendingCap: cap });
    expect(output).toMatchObject({
      ok: false,
      error: { code: "payment_facilitator_not_permitted", paid: "none" },
    });
    expect(await balance(payer.publicKey())).toBe(before);
  });
});
