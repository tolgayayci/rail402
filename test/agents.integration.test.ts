/**
 * The agent payment path end to end on the private Stellar network (docker compose --profile stellar
 * up -d): the demo seller (paid HTTP routes and paid MCP tools, declared with the seller helpers)
 * settles through Rail402 running in this process. Its first settlements catalog an HTTP API and an
 * MCP tool; both are then discovered by search and paid through their listings from the SDK, the
 * example SDK buyer, the example MCP agent (which starts rail402-mcp over stdio and knows no endpoint)
 * and the rail402 CLI. Every payment names its transaction and its stellar.expert link, the seller
 * receives exactly what was paid, and the fee sponsor's token balance never moves.
 *
 * The Stellar RPC is fronted by a TLS proxy (the upstream x402 client only reaches an https RPC),
 * trusted in this process and, for spawned processes, through NODE_EXTRA_CA_CERTS.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Keypair } from "@stellar/stellar-sdk";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createSeller } from "@rail402.dev/demo-seller";
import { KeyHolder, createBuyer, type Buyer, type CallResult, type Receipt } from "@rail402.dev/sdk";
import { TESTNET } from "@rail402.dev/stellar";
import { LocalNetwork, startTlsRpcProxy, type IssuedAsset, type TlsRpcProxy } from "@rail402.dev/testkit";
import { startRail402, type RunningRail402 } from "../packages/sdk/test/service.ts";

const net = new LocalNetwork();
const available = await net.available();

const source = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const MCP_BIN = source("packages/mcp/src/bin.ts");
const CLI_BIN = source("packages/cli/src/bin.ts");
const SDK_EXAMPLE = source("examples/sdk-buyer/src/index.ts");
const MCP_EXAMPLE = source("examples/mcp-agent/src/index.ts");

/** 0.001 TUSD: every demo seller route and tool used here costs this much. */
const PRICE = 10_000n;
const HASH = /^[0-9a-f]{64}$/;

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface Paid {
  readonly surface: string;
  readonly transaction: string;
  readonly explorerUrl: string;
}

describe.skipIf(!available)("agents pay the demo seller on the local network", () => {
  let tusd: IssuedAsset;
  let rail402: RunningRail402;
  let proxy: TlsRpcProxy;
  let seller: Keypair;
  let payer: Keypair;
  let sellerServer: Server;
  let sellerUrl: string;
  let buyer: Buyer;
  let directory: string;
  let env: Record<string, string>;
  let httpListing = "";
  let mcpListing = "";
  let sellerBefore = 0n;
  let sponsorBefore = 0n;
  const payments: Paid[] = [];

  const balance = (holder: string) => net.tokenBalance(tusd.sac, holder).catch(() => 0n);

  /** Records a settled payment and checks that its transaction opens on stellar.expert. */
  const settled = (surface: string, payment: Receipt | null | undefined): Paid => {
    expect(payment, surface).toMatchObject({
      status: "settled",
      verifiedOnChain: true,
      asset: "TUSD",
      payer: payer.publicKey(),
      payTo: seller.publicKey(),
      authorized: { atomic: PRICE.toString() },
    });
    const transaction = payment?.transaction ?? "";
    expect(transaction, surface).toMatch(HASH);
    expect(payment?.explorerUrl, surface).toBe(`https://stellar.expert/explorer/testnet/tx/${transaction}`);
    const paid = { surface, transaction, explorerUrl: payment?.explorerUrl ?? "" };
    payments.push(paid);
    return paid;
  };

  const run = (args: readonly string[], extra: Record<string, string> = {}): Promise<Run> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--conditions=@rail402/source", ...args], {
        env: { ...env, ...extra },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      child.on("error", reject);
      child.on("close", (status) => {
        resolve({ status, stdout, stderr });
      });
    });

  /** The JSON lines a spawned example printed, by step. */
  const steps = (output: Run): Map<string, Record<string, unknown>> =>
    new Map(
      output.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .map((step) => [String(step["step"]), step]),
    );

  /** Runs a rail402 command with --json and returns its one document. */
  const cli = async (args: readonly string[]): Promise<Record<string, unknown>> => {
    const output = await run([CLI_BIN, ...args, "--json"]);
    const lines = output.stdout.trim().split("\n");
    expect(lines, output.stderr).toHaveLength(1);
    return { status: output.status, ...(JSON.parse(lines[0] ?? "") as Record<string, unknown>) };
  };

  beforeAll(async () => {
    tusd = await net.issueAsset("TUSD");
    [rail402, proxy] = await Promise.all([startRail402(net, tusd), startTlsRpcProxy(net.rpcUrl)]);
    proxy.trust();
    [seller] = (await net.holders(tusd, 1, "0")) as [Keypair];
    [payer] = (await net.holders(tusd, 1, "10")) as [Keypair];

    sellerServer = createSeller({
      payTo: seller.publicKey(),
      facilitator: new HTTPFacilitatorClient({ url: rail402.url }),
      asset: { contract: tusd.sac, decimals: 7 },
    }).listen(0, "127.0.0.1");
    await new Promise((resolve) => sellerServer.once("listening", resolve));
    const sellerPort = (sellerServer.address() as AddressInfo).port;
    sellerUrl = `http://127.0.0.1:${String(sellerPort)}`;

    buyer = await createBuyer({
      network: TESTNET,
      signer: KeyHolder.fromSecret(payer.secret()),
      rpcUrl: proxy.url,
      bazaarUrl: rail402.url,
      facilitatorUrl: rail402.url,
      policy: {
        assets: [{ asset: tusd.sac, symbol: "TUSD", decimals: 7, perCall: "0.5", sessionTotal: "2" }],
      },
      egress: { schemes: ["http:"], ports: [sellerPort], allowPrivateNetwork: "loopback" },
    });

    directory = mkdtempSync(join(tmpdir(), "rail402-agents-it-"));
    const keyFile = join(directory, "payer.key");
    writeFileSync(keyFile, payer.secret(), { mode: 0o600 });
    const caFile = join(directory, "rpc-ca.pem");
    writeFileSync(caFile, proxy.certificate);
    env = {
      PATH: process.env["PATH"] ?? "",
      HOME: directory,
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_STATE_HOME: join(directory, "state"),
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
      RAIL402_ALLOWED_PORTS: String(sellerPort),
      RAIL402_LOG_LEVEL: "warn",
    };
    [sellerBefore, sponsorBefore] = await Promise.all([
      balance(seller.publicKey()),
      balance(rail402.sponsor),
    ]);
  });

  afterAll(async () => {
    await buyer.close();
    sellerServer.closeAllConnections();
    await new Promise((resolve) => sellerServer.close(resolve));
    await Promise.all([rail402.stop(), proxy.close()]);
    rmSync(directory, { recursive: true, force: true });
    if (payments.length > 0) {
      console.log(
        payments
          .map((paid) => `${paid.surface.padEnd(28)} ${paid.transaction} ${paid.explorerUrl}`)
          .join("\n"),
      );
    }
  });

  it("catalogs the HTTP API and the MCP tool after their first settlements", async () => {
    const weather: CallResult = await buyer.pay(
      { kind: "http", url: `${sellerUrl}/weather`, query: { city: "Ankara" } },
      { maxAmount: { amount: "0.01", asset: "TUSD" } },
    );
    settled("sdk pay http by url", weather.payment);
    expect(weather.response).toMatchObject({ status: 200, json: { city: "Ankara" } });

    const air: CallResult = await buyer.pay(
      { kind: "mcp", url: `${sellerUrl}/mcp`, toolName: "air_quality", arguments: { city: "Izmir" } },
      { maxAmount: { amount: "0.01", asset: "TUSD" } },
    );
    settled("sdk pay mcp by endpoint", air.payment);
    expect(air.response).toMatchObject({ kind: "mcp", isError: false, structuredContent: { city: "Izmir" } });

    // Cataloging follows each settlement asynchronously; wait until both listings are searchable.
    for (let attempt = 0; attempt < 30 && (httpListing === "" || mcpListing === ""); attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 500));
      await rail402.runtime.bazaar?.catalog.checkOrigins();
      await rail402.runtime.bazaar?.catalog.enrich();
      await rail402.runtime.bazaar?.search.refresh();
      const http = await buyer.search("current weather for a city", { type: "http" });
      httpListing = http.hits.find((hit) => hit.resource === `${sellerUrl}/weather`)?.listingId ?? "";
      const mcp = await buyer.search("air quality for a city", { type: "mcp" });
      mcpListing = mcp.hits.find((hit) => hit.toolName === "air_quality")?.listingId ?? "";
    }
    expect(httpListing).not.toBe("");
    expect(mcpListing).not.toBe("");

    // The tool's listing carries the helper-declared, described arguments, keyed by endpoint and tool.
    const listing = await buyer.listing(mcpListing);
    expect(listing).toMatchObject({
      state: "published",
      type: "mcp",
      resource: `${sellerUrl}/mcp`,
      toolName: "air_quality",
      owner: seller.publicKey(),
      callable: true,
    });
  });

  it("SDK: searches and pays the HTTP API through its listing", async () => {
    const found = await buyer.searchAndPay("current weather for a city", {
      maxAmount: { amount: "0.01", asset: "TUSD" },
      filters: { type: "http" },
      call: { query: { city: "Istanbul" } },
    });
    expect(found.chosen.listingId).toBe(httpListing);
    settled("sdk searchAndPay http", found.payment);
    expect(found.response).toMatchObject({ status: 200, json: { city: "Istanbul" } });
  });

  it("the SDK buyer example pays by URL, then by search", async () => {
    const output = await run([SDK_EXAMPLE, `${sellerUrl}/weather?city=Bursa`, "current weather for a city"], {
      MAX_AMOUNT: "0.01 TUSD",
    });
    expect(output.status, output.stderr).toBe(0);
    const printed = steps(output);
    settled("example sdk-buyer pay", printed.get("pay")?.["payment"] as Receipt);
    expect(printed.get("searchAndPay")).toMatchObject({ listingId: httpListing });
    settled("example sdk-buyer search", printed.get("searchAndPay")?.["payment"] as Receipt);
  });

  it("MCP server: the example agent discovers the MCP tool and pays it with no endpoint configured", async () => {
    const output = await run([MCP_EXAMPLE, "air quality for a city"], {
      RAIL402_MCP_COMMAND: `${process.execPath} --conditions=@rail402/source ${MCP_BIN}`,
      SPENDING_CAP: "0.01",
      SPENDING_CAP_ASSET: "TUSD",
    });
    expect(output.status, output.stderr).toBe(0);
    const printed = steps(output);
    expect(printed.get("search")).toMatchObject({ chosen: mcpListing });
    const result = printed.get("pay_and_call")?.["result"] as Record<string, unknown>;
    expect(result).toMatchObject({
      ok: true,
      paid: true,
      target: { type: "mcp", toolName: "air_quality", listingId: mcpListing },
      response: { kind: "mcp", isError: false, structuredContent: { city: "Istanbul", pollutant: "pm25" } },
    });
    const paid = settled("example mcp-agent pay_and_call", result["payment"] as Receipt);
    expect(printed.get("done")).toEqual({
      step: "done",
      transaction: paid.transaction,
      explorerUrl: paid.explorerUrl,
    });
  });

  it("CLI: purchases both listings and explains the transactions", async () => {
    const tool = await cli([
      "purchase",
      "air quality for a city",
      "--pick",
      mcpListing,
      "--args",
      '{"city":"Van","pollutant":"o3"}',
      "--max",
      "0.01 TUSD",
    ]);
    expect(tool).toMatchObject({ status: 0, ok: true, command: "purchase" });
    const toolResult = tool["result"] as { payment: Receipt; response: unknown };
    expect(toolResult.response).toMatchObject({ structuredContent: { city: "Van", pollutant: "o3" } });
    const toolPaid = settled("cli purchase mcp", toolResult.payment);

    const api = await cli([
      "purchase",
      "current weather for a city",
      "--pick",
      httpListing,
      "--query",
      "city=Trabzon",
      "--max",
      "0.01 TUSD",
    ]);
    expect(api).toMatchObject({ status: 0, ok: true, result: { response: { json: { city: "Trabzon" } } } });
    settled("cli purchase http", (api["result"] as { payment: Receipt }).payment);

    const report = await cli(["tx", toolPaid.transaction]);
    expect(report).toMatchObject({
      status: 0,
      result: {
        status: "SUCCESS",
        x402: { shape: "exact" },
        facilitator: { url: rail402.url, attributed: true },
        transfers: [
          { from: payer.publicKey(), to: seller.publicKey(), amount: { atomic: PRICE.toString() } },
        ],
        explorerUrl: toolPaid.explorerUrl,
      },
    });
  });

  it("paid the seller exactly what was settled, from the payer, never from the sponsor", async () => {
    expect(new Set(payments.map((paid) => paid.transaction)).size).toBe(payments.length);
    expect(payments).toHaveLength(8);
    expect(await balance(seller.publicKey())).toBe(sellerBefore + PRICE * BigInt(payments.length));
    expect(await balance(rail402.sponsor)).toBe(sponsorBefore);
  });
});
