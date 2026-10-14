/**
 * Secret canary scan of the spawned rail402-mcp bin on the private Stellar network: the canary key
 * file pays stock sellers through Rail402 across a settled payment, a refusal, a resource that fails
 * after payment, a failed settlement, a redirect after payment, paid MCP tools and a resource and a
 * tool that echo the payment into their answer, with logs at trace level. Every JSON-RPC frame the server sent, its stderr, its SQLite ledger files and what the decoy
 * origin received must hold no secret.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { TESTNET } from "@rail402.dev/stellar";
import { LocalNetwork, SecretScanner, schemaFindings } from "@rail402.dev/testkit";
import { decoyUnpaid, startSecretWorld, type SecretWorld } from "../../sdk/test/secret-fixture.ts";

const net = new LocalNetwork();
const available = await net.available();
const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));

describe.skipIf(!available)("secret canary scan of rail402-mcp on the local network", () => {
  let world: SecretWorld;
  let scanner: SecretScanner;
  let client: Client;
  let directory: string;
  const frames: string[] = [];
  const stderr: string[] = [];

  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    return result.structuredContent as Record<string, unknown>;
  };

  beforeAll(async () => {
    world = await startSecretWorld(net);
    scanner = new SecretScanner(world.payer.secret());
    directory = mkdtempSync(join(tmpdir(), "rail402-mcp-secrets-"));
    const keyFile = join(directory, "canary.key");
    writeFileSync(keyFile, world.payer.secret(), { mode: 0o600 });
    const caFile = join(directory, "rpc-ca.pem");
    writeFileSync(caFile, world.proxy.certificate);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--conditions=@rail402/source", bin],
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: directory,
        NODE_EXTRA_CA_CERTS: caFile,
        RAIL402_NETWORK: TESTNET,
        RAIL402_RPC_URL: world.proxy.url,
        RAIL402_BAZAAR_URL: world.rail402.url,
        RAIL402_SECRET_KEY_FILE: keyFile,
        RAIL402_ASSETS: `TUSD:${world.asset.sac}:7`,
        RAIL402_MAX_PER_CALL: "0.5 TUSD",
        RAIL402_MAX_TOTAL: "2 TUSD",
        RAIL402_ALLOW_HTTP: "true",
        RAIL402_ALLOW_PRIVATE_NETWORK: "loopback",
        RAIL402_ALLOWED_PORTS: world.ports.join(","),
        RAIL402_LEDGER_PATH: join(directory, "ledger.sqlite"),
        RAIL402_LOG_LEVEL: "trace",
      },
      stderr: "pipe",
    });
    transport.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString("utf8")));
    client = new Client({ name: "secret-scan", version: "1" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(transport);
    // Every frame the server sends, as it arrived.
    const deliver = transport.onmessage?.bind(transport);
    transport.onmessage = (...args: Parameters<NonNullable<typeof transport.onmessage>>) => {
      frames.push(JSON.stringify(args[0]));
      deliver?.(...args);
    };
  });

  afterAll(async () => {
    await client.close();
    await world.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("publishes clean tool schemas", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(schemaFindings(tool.inputSchema), tool.name).toEqual([]);
      expect(schemaFindings(tool.outputSchema, { allow: ["maxAuthorizationSeconds"] }), tool.name).toEqual(
        [],
      );
    }
  });

  it("pays through every outcome", async () => {
    const cap = { amount: "0.05", asset: "TUSD" };
    const http = (path: string, extra: Record<string, unknown> = {}) =>
      call("pay_and_call", {
        resource: `${world.sellerUrl}${path}`,
        query: { city: "Van" },
        spendingCap: cap,
        ...extra,
      });
    expect(await http("/weather", { idempotencyKey: "canary-mcp-1" })).toMatchObject({
      ok: true,
      payment: { status: "settled" },
    });
    expect(await http("/weather", { idempotencyKey: "canary-mcp-1" })).toMatchObject({ replayed: true });
    expect(await http("/premium")).toMatchObject({ error: { code: "payment_per_call_cap_exceeded" } });
    expect(await http("/broken")).toMatchObject({ error: { code: "payment_settlement_unconfirmed" } });
    expect(await http("/unsettled")).toMatchObject({ error: { code: "payment_rejected" } });
    expect(await http("/redirect")).toMatchObject({ error: { code: "payment_redirect_after_payment" } });
    expect(await http("/echo", { idempotencyKey: "canary-mcp-echo" })).toMatchObject({
      ok: true,
      payment: { status: "settled" },
    });
    await http("/echo", { idempotencyKey: "canary-mcp-echo" });
    expect(
      await call("pay_and_call", {
        resource: world.mcpSeller.url,
        toolName: "forecast",
        arguments: { city: "Rize" },
        spendingCap: cap,
      }),
    ).toMatchObject({ ok: true, payment: { status: "settled" } });
    await call("pay_and_call", { resource: world.mcpSeller.url, toolName: "broken", spendingCap: cap });
    expect(
      await call("pay_and_call", {
        resource: world.mcpSeller.url,
        toolName: "echo-payment",
        spendingCap: cap,
      }),
    ).toMatchObject({ ok: true, payment: { status: "settled" } });
    await call("get_budget", {});
  });

  it("leaks nothing into frames, logs or the ledger", () => {
    expect(world.paymentHeaders.length).toBeGreaterThanOrEqual(4);
    expect(world.decoy.requests).toHaveLength(0);
    expect(decoyUnpaid(world.decoy)).toBe(true);
    world.addReceivedPayments(scanner);
    expect(frames.length).toBeGreaterThan(8);
    scanner.capture("json-rpc frames", frames.join("\n"));
    const logs = stderr.join("");
    expect(logs).toContain('"payment event"');
    scanner.capture("stderr (trace)", logs);
    const file = join(directory, "ledger.sqlite");
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(file + suffix)) scanner.capture(`ledger file${suffix}`, readFileSync(file + suffix));
    }
    expect(scanner.needles).toBeGreaterThan(30);
    scanner.assertClean();
  });
});
