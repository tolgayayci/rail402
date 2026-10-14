/**
 * The rail402 bin end to end on the private Stellar network: each command is spawned as a user runs
 * it, configured through flags and the environment, and pays stock @x402/express and @x402/mcp
 * sellers that settle through Rail402 running in this process. The Stellar RPC is fronted by a TLS
 * proxy (the upstream client only reaches an https RPC), trusted through NODE_EXTRA_CA_CERTS.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { Keypair } from "@stellar/stellar-sdk";
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

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface Document {
  v: number;
  ok: boolean;
  command: string;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

describe.skipIf(!available)("rail402 on the local network", () => {
  let tusd: IssuedAsset;
  let rail402: RunningRail402;
  let proxy: TlsRpcProxy;
  let seller: Keypair;
  let payer: Keypair;
  let sellerServer: Server;
  let sellerUrl: string;
  let mcpSeller: McpSeller;
  let directory: string;
  let env: Record<string, string>;
  const outputs: string[] = [];

  const rail = (args: readonly string[], input?: string): Promise<Run> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--conditions=@rail402/source", bin, ...args], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      child.on("error", reject);
      child.on("close", (status) => {
        outputs.push(stdout, stderr);
        resolve({ status, stdout, stderr });
      });
      child.stdin.end(input ?? "");
    });
  /** Runs a command with --json and returns its one document. */
  const json = async (
    args: readonly string[],
    input?: string,
  ): Promise<Document & { status: number | null }> => {
    const run = await rail([...args, "--json"], input);
    const lines = run.stdout.trim().split("\n");
    expect(lines, run.stderr).toHaveLength(1);
    return { ...(JSON.parse(lines[0] ?? "") as Document), status: run.status };
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

    directory = mkdtempSync(join(tmpdir(), "rail402-cli-it-"));
    const caFile = join(directory, "rpc-ca.pem");
    writeFileSync(caFile, proxy.certificate);
    env = {
      PATH: process.env["PATH"] ?? "",
      HOME: directory,
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_STATE_HOME: join(directory, "state"),
      NODE_EXTRA_CA_CERTS: caFile,
      RAIL402_RPC_URL: proxy.url,
      RAIL402_BAZAAR_URL: rail402.url,
      RAIL402_FRIENDBOT_URL: net.friendbotUrl,
      RAIL402_ASSETS: `TUSD:${tusd.sac}:7`,
      RAIL402_MAX_PER_CALL: "0.5 TUSD",
      RAIL402_MAX_TOTAL: "2 TUSD",
      RAIL402_ALLOW_HTTP: "true",
      RAIL402_ALLOW_PRIVATE_NETWORK: "loopback",
      RAIL402_ALLOWED_PORTS: `${String(sellerPort)},${String(mcpSeller.port)}`,
    };
  });

  afterAll(async () => {
    await mcpSeller.close();
    await new Promise((resolve) => sellerServer.close(resolve));
    await Promise.all([rail402.stop(), proxy.close()]);
    rmSync(directory, { recursive: true, force: true });
  });

  it("imports the payer's key from stdin and reads its account", async () => {
    const imported = await json(["keys", "import"], `${payer.secret()}\n`);
    expect(imported).toMatchObject({
      status: 0,
      ok: true,
      result: {
        address: payer.publicKey(),
        keyFile: join(directory, "config", "rail402", "keys", "stellar-testnet.key"),
      },
    });
    const status = await json(["account", "status"]);
    expect(status.result).toMatchObject({
      address: payer.publicKey(),
      exists: true,
      assets: [
        // The private network has no USDC contract: nothing can be read for it.
        { asset: "USDC", trustline: null },
        { asset: "TUSD", trustline: true, authorized: true, balance: "10" },
      ],
    });
  });

  it("onboards a new key with Friendbot and a trustline", async () => {
    const created = await json(["keys", "new", "--name", "fresh"]);
    const { address, keyFile } = created.result as { address: string; keyFile: string };
    const setup = await json(["account", "setup", "--asset", "TUSD", "--key-file", keyFile]);
    expect(setup).toMatchObject({
      status: 0,
      result: { address, funded: "friendbot", trustline: "added", bought: null },
    });
    expect((setup.result?.["transactions"] as string[])[0]).toMatch(/^[0-9a-f]{64}$/);
    const again = await json(["account", "setup", "--asset", "TUSD", "--key-file", keyFile]);
    expect(again.result).toMatchObject({ funded: "existing", trustline: "existing", transactions: [] });
    const status = await json(["account", "status", address]);
    expect(status.result).toMatchObject({
      assets: [{ asset: "USDC" }, { asset: "TUSD", trustline: true, balance: "0" }],
    });
  });

  it("checks the seller the way the catalog will, and quotes it", async () => {
    const check = await json(["seller", "check", `${sellerUrl}/weather?city=Ankara`]);
    expect(check).toMatchObject({
      status: 0,
      result: {
        ok: true,
        type: "http",
        status: 402,
        validation: { catalogable: true, preview: { method: "GET", payTo: seller.publicKey() } },
        receivable: [{ payTo: seller.publicKey(), receivable: true }],
        findings: [],
      },
    });
    const quote = await json([
      "quote",
      `${sellerUrl}/weather`,
      "--query",
      "city=Ankara",
      "--max",
      "0.05 TUSD",
    ]);
    expect(quote.result).toMatchObject({
      paymentRequired: true,
      chosen: 0,
      options: [{ amount: "0.015", asset: "TUSD", acceptable: true }],
    });
  });

  let transaction = "";

  it("pays without custody, replays a repeated key without paying, and refuses a low cap", async () => {
    const [payerBefore, sellerBefore, sponsorBefore] = await Promise.all([
      balance(payer.publicKey()),
      balance(seller.publicKey()),
      balance(rail402.sponsor),
    ]);
    const args = [
      "pay",
      `${sellerUrl}/weather`,
      "--query",
      "city=Ankara",
      "--max",
      "0.05",
      "--asset",
      "TUSD",
      "--idempotency-key",
      "cli-weather-1",
    ];
    const paid = await json(args);
    expect(paid).toMatchObject({
      status: 0,
      ok: true,
      command: "pay",
      result: {
        paid: true,
        replayed: false,
        payment: {
          status: "settled",
          verifiedOnChain: true,
          asset: "TUSD",
          payer: payer.publicKey(),
          payTo: seller.publicKey(),
          authorized: { amount: "0.015", atomic: "150000" },
        },
        response: { kind: "http", status: 200, json: { city: "Ankara", conditions: "sunny" } },
      },
    });
    transaction = (paid.result?.["payment"] as { transaction: string }).transaction;
    expect(transaction).toMatch(/^[0-9a-f]{64}$/);
    expect(await balance(payer.publicKey())).toBe(payerBefore - 150_000n);
    expect(await balance(seller.publicKey())).toBe(sellerBefore + 150_000n);
    expect(await balance(rail402.sponsor)).toBe(sponsorBefore);

    const replay = await json(args);
    expect(replay).toMatchObject({ status: 0, result: { replayed: true, payment: { transaction } } });
    expect(await balance(payer.publicKey())).toBe(payerBefore - 150_000n);

    const low = await json(["pay", `${sellerUrl}/weather`, "--query", "city=Van", "--max", "0.01 TUSD"]);
    expect(low).toMatchObject({
      status: 3,
      ok: false,
      error: { code: "payment_per_call_cap_exceeded", paid: "none", retryable: false },
    });
    expect(await balance(payer.publicKey())).toBe(payerBefore - 150_000n);

    const human = await rail(["pay", `${sellerUrl}/weather`, "--query", "city=Van", "--max", "0.01 TUSD"]);
    expect(human.status).toBe(3);
    expect(human.stdout).toBe("");
    expect(human.stderr).toContain("error: payment_per_call_cap_exceeded:");
  });

  it("explains the settlement transaction and attributes it to the facilitator", async () => {
    const report = await json(["tx", transaction]);
    expect(report).toMatchObject({
      status: 0,
      result: {
        status: "SUCCESS",
        x402: { shape: "exact" },
        facilitator: { url: rail402.url, attributed: true },
        transfers: [{ from: payer.publicKey(), to: seller.publicKey(), amount: { atomic: "150000" } }],
        explorerUrl: `https://stellar.expert/explorer/testnet/tx/${transaction}`,
      },
    });
    const missing = await json(["tx", "0".repeat(64)]);
    expect(missing).toMatchObject({ status: 7, error: { code: "transaction_not_found" } });
  });

  it("finds the cataloged resource and purchases it through its listing", async () => {
    let listingId: string | undefined;
    for (let attempt = 0; attempt < 20 && listingId === undefined; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 500));
      await rail402.runtime.bazaar?.catalog.checkOrigins();
      await rail402.runtime.bazaar?.catalog.enrich();
      await rail402.runtime.bazaar?.search.refresh();
      const found = await json(["search", "current", "weather", "for", "a", "city", "--type", "http"]);
      expect(found.status).toBe(0);
      listingId = (found.result?.["hits"] as { resource: string; listingId: string }[]).find(
        (candidate) => candidate.resource === `${sellerUrl}/weather`,
      )?.listingId;
    }
    expect(listingId).toBeDefined();

    const resources = await json(["resources", "--type", "http", "--pay-to", seller.publicKey()]);
    expect(resources.result).toMatchObject({ hits: [{ listingId }], pagination: { total: 1 } });
    const listing = await json(["listing", listingId ?? "", "--versions"]);
    expect(listing.result).toMatchObject({ listing: { state: "published", owner: seller.publicKey() } });
    expect((listing.result?.["versions"] as unknown[])[0]).toMatchObject({
      version: 1,
      cause: "settlement",
      transaction,
    });

    const purchase = await json([
      "purchase",
      "current weather for a city",
      "--type",
      "http",
      "--pick",
      listingId ?? "",
      "--query",
      "city=Izmir",
      "--max",
      "0.05 TUSD",
    ]);
    expect(purchase).toMatchObject({
      status: 0,
      result: {
        chosen: { listingId },
        payment: { status: "settled", verifiedOnChain: true },
        response: { json: { city: "Izmir" } },
      },
    });
  });

  it("pays a stock @x402/mcp tool, and the session shows everything spent", async () => {
    const before = await balance(seller.publicKey());
    const paid = await json([
      "pay",
      mcpSeller.url,
      "--tool",
      "forecast",
      "--args",
      '{"city":"Trabzon"}',
      "--max",
      "0.05 TUSD",
    ]);
    expect(paid).toMatchObject({
      status: 0,
      result: {
        payment: { status: "settled", verifiedOnChain: true, authorized: { amount: "0.025" } },
        response: { kind: "mcp", isError: false, content: [{ type: "text", text: "Sunny in Trabzon" }] },
      },
    });
    expect(await balance(seller.publicKey())).toBe(before + 250_000n);

    const session = await json(["session", "show"]);
    expect(session.result).toMatchObject({
      payer: payer.publicKey(),
      assets: [
        { asset: "USDC", spent: "0" },
        { asset: "TUSD", spent: "0.055", pending: "0", remaining: "1.945" },
      ],
    });
    const human = await rail(["session", "show"]);
    expect(human.stdout).toContain("TUSD: spent 0.055, pending 0, remaining 1.945 of 2");

    // No command ever printed the key.
    const everything = outputs.join("");
    expect(everything).not.toContain(payer.secret());
    expect(everything).not.toMatch(/S[A-Z2-7]{55}/);
  });
});
