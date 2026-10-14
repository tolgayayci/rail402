/**
 * upto from the rail402 bin on the private Stellar network: each command is spawned as a user runs
 * it and pays a seller built with the Rail402 seller helpers, which settles through Rail402 running
 * in this process with the settlement contract deployed for this run. Quotes show the cap; zero,
 * partial and maximum charges move exactly the charge; the shared SQLite budget reserves the cap and
 * keeps only what the chain proves was charged; `tx` recognises the settlement; a seller naming
 * itself as the settlement authority is refused before anything is signed.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Keypair } from "@stellar/stellar-sdk";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import { TESTNET } from "@rail402.dev/stellar";
import { LocalNetwork } from "@rail402.dev/testkit";
import { startUptoEnvironment, type UptoEnvironment } from "../../sdk/test/upto-seller.ts";

const net = new LocalNetwork();
const available = await net.available();
const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
const CAP = 500_000n;

interface Document {
  ok: boolean;
  command: string;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
  status: number | null;
}

describe.skipIf(!available)("rail402 pays upto resources on the local network", () => {
  let env: UptoEnvironment;
  let payer: Keypair;
  let directory: string;
  let variables: Record<string, string>;
  let impostor: Server;
  let impostorUrl: string;

  const json = (args: readonly string[]): Promise<Document> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--conditions=@rail402/source", bin, ...args, "--json"], {
        env: variables,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      child.on("error", reject);
      child.on("close", (status) => {
        const lines = stdout.trim().split("\n");
        if (lines.length !== 1) {
          reject(new Error(`expected one JSON document, got: ${stdout}\n${stderr}`));
          return;
        }
        resolve({ ...(JSON.parse(lines[0] ?? "") as Omit<Document, "status">), status });
      });
    });
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

    directory = mkdtempSync(join(tmpdir(), "rail402-cli-upto-"));
    variables = {
      PATH: process.env["PATH"] ?? "",
      HOME: directory,
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_STATE_HOME: join(directory, "state"),
      RAIL402_SECRET_KEY: payer.secret(),
      RAIL402_RPC_URL: net.rpcUrl,
      RAIL402_BAZAAR_URL: env.rail402.url,
      RAIL402_ASSETS: `TUSD:${env.asset.sac}:7`,
      RAIL402_MAX_PER_CALL: "0.1 TUSD",
      RAIL402_MAX_TOTAL: "1 TUSD",
      RAIL402_UPTO_CONTRACTS: env.contract.address,
      RAIL402_ALLOW_HTTP: "true",
      RAIL402_ALLOW_PRIVATE_NETWORK: "loopback",
      RAIL402_ALLOWED_PORTS: `${String(env.shop.port)},${String(impostorPort)}`,
    };
  }, 180_000);

  afterAll(async () => {
    impostor.closeAllConnections();
    await new Promise((resolve) => impostor.close(resolve));
    await env.stop();
    rmSync(directory, { recursive: true, force: true });
  });

  it("quotes the cap of an upto resource without signing", async () => {
    const quote = await json([
      "quote",
      `${env.shop.url}/metered`,
      "--query",
      "charge=1",
      "--max",
      "0.1 TUSD",
    ]);
    expect(quote).toMatchObject({
      status: 0,
      result: {
        paymentRequired: true,
        chosen: 0,
        options: [{ scheme: "upto", amount: "0.05", asset: "TUSD", acceptable: true }],
      },
    });
  });

  const transactions: string[] = [];

  it.each([
    ["zero", 0n],
    ["partial", 125_000n],
    ["maximum", CAP],
  ])("pays a %s charge and moves exactly that", async (_name, charge) => {
    const [payerBefore, sellerBefore] = await Promise.all([
      balance(payer.publicKey()),
      balance(env.seller.publicKey()),
    ]);
    const paid = await json([
      "pay",
      `${env.shop.url}/metered`,
      "--query",
      `charge=${charge.toString()}`,
      "--max",
      "0.1 TUSD",
    ]);
    expect(paid).toMatchObject({
      status: 0,
      ok: true,
      result: {
        paid: true,
        payment: {
          status: "settled",
          scheme: "upto",
          authorized: { atomic: CAP.toString() },
          settled: { atomic: charge.toString() },
          verifiedOnChain: true,
        },
        response: { status: 200, json: { charged: charge.toString() } },
      },
    });
    transactions.push((paid.result?.["payment"] as { transaction: string }).transaction);
    expect(await balance(payer.publicKey())).toBe(payerBefore - charge);
    expect(await balance(env.seller.publicKey())).toBe(sellerBefore + charge);
    expect(await balance(env.authority)).toBe(0n);
  });

  it("pays a metered MCP tool for its charge", async () => {
    const paid = await json([
      "pay",
      env.shop.mcpUrl,
      "--tool",
      "tokens",
      "--args",
      '{"prompt":"rain","charge":42000}',
      "--max",
      "0.1 TUSD",
    ]);
    expect(paid).toMatchObject({
      status: 0,
      result: {
        payment: { scheme: "upto", settled: { atomic: "42000" }, verifiedOnChain: true },
        response: { kind: "mcp", isError: false },
      },
    });
  });

  it("keeps only the proven charges in the shared budget", async () => {
    // 0 + 0.0125 + 0.05 + 0.0042: every cap was reserved, and each remainder came back after proof.
    const session = await json(["session", "show"]);
    expect(session.result).toMatchObject({
      payer: payer.publicKey(),
      assets: [
        { asset: "USDC", spent: "0" },
        { asset: "TUSD", spent: "0.0667", pending: "0", remaining: "0.9333" },
      ],
    });
  });

  it("explains an upto settlement transaction", async () => {
    const report = await json(["tx", transactions[1] ?? ""]);
    expect(report).toMatchObject({
      status: 0,
      result: { status: "SUCCESS", x402: { shape: "upto" } },
    });
  });

  it("buys the upto listing through the Bazaar", async () => {
    // The listing must be verified and indexed before a search-based purchase can pick it.
    const bazaar = env.rail402.runtime.bazaar;
    await bazaar?.catalog.checkOrigins();
    await bazaar?.catalog.enrich();
    await bazaar?.search.refresh();
    const purchase = await json([
      "purchase",
      "metered report",
      "--type",
      "http",
      "--query",
      "charge=3000",
      "--max",
      "0.1 TUSD",
    ]);
    // The error code is in the expectation, so a refusal names its cause.
    expect({ status: purchase.status, error: purchase.error?.["code"] }).toEqual({
      status: 0,
      error: undefined,
    });
    expect(purchase).toMatchObject({
      status: 0,
      result: {
        chosen: { type: "http" },
        payment: { scheme: "upto", settled: { atomic: "3000" }, verifiedOnChain: true },
      },
    });
  });

  it("refuses a seller that names itself as the settlement authority, signing nothing", async () => {
    const before = await balance(payer.publicKey());
    const refused = await json(["pay", impostorUrl, "--max", "0.1 TUSD"]);
    expect(refused).toMatchObject({
      status: 3,
      ok: false,
      error: { code: "payment_facilitator_not_permitted", paid: "none" },
    });
    expect(await balance(payer.publicKey())).toBe(before);
  });
});
