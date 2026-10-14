/**
 * Secret canary scan of the spawned rail402 bin on the private Stellar network: the canary seed is
 * imported from stdin, then pays stock sellers through Rail402 across a settled payment and its
 * replay, a refusal, a resource that fails after payment, a failed settlement, a redirect after
 * payment, a paid MCP tool and a resource and a tool that echo the payment into their answer, in
 * JSON and text output with --verbose, followed by session, tx and key commands (one with the key in
 * the environment). Every byte on stdout and stderr, the SQLite ledger files and what the decoy
 * origin received must hold no secret.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalNetwork, SecretScanner } from "@rail402.dev/testkit";
import { decoyUnpaid, startSecretWorld, type SecretWorld } from "../../sdk/test/secret-fixture.ts";

const net = new LocalNetwork();
const available = await net.available();
const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

describe.skipIf(!available)("secret canary scan of the rail402 CLI on the local network", () => {
  let world: SecretWorld;
  let scanner: SecretScanner;
  let directory: string;
  let env: Record<string, string>;

  const rail = (args: readonly string[], input = "", extra: Record<string, string> = {}): Promise<Run> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--conditions=@rail402/source", bin, ...args], {
        env: { ...env, ...extra },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
      child.on("error", reject);
      child.on("close", (status) => {
        const label = args.join(" ").slice(0, 80);
        scanner.capture(`stdout ${label}`, stdout);
        scanner.capture(`stderr ${label}`, stderr);
        resolve({ status, stdout, stderr });
      });
      child.stdin.end(input);
    });
  const document = (run: Run) => JSON.parse(run.stdout.trim()) as Record<string, unknown>;

  beforeAll(async () => {
    world = await startSecretWorld(net);
    scanner = new SecretScanner(world.payer.secret());
    directory = mkdtempSync(join(tmpdir(), "rail402-cli-secrets-"));
    const caFile = join(directory, "rpc-ca.pem");
    writeFileSync(caFile, world.proxy.certificate);
    env = {
      PATH: process.env["PATH"] ?? "",
      HOME: directory,
      XDG_CONFIG_HOME: join(directory, "config"),
      XDG_STATE_HOME: join(directory, "state"),
      NODE_EXTRA_CA_CERTS: caFile,
      RAIL402_RPC_URL: world.proxy.url,
      RAIL402_BAZAAR_URL: world.rail402.url,
      RAIL402_ASSETS: `TUSD:${world.asset.sac}:7`,
      RAIL402_MAX_PER_CALL: "0.5 TUSD",
      RAIL402_MAX_TOTAL: "2 TUSD",
      RAIL402_ALLOW_HTTP: "true",
      RAIL402_ALLOW_PRIVATE_NETWORK: "loopback",
      RAIL402_ALLOWED_PORTS: world.ports.join(","),
    };
  });

  afterAll(async () => {
    await world.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("imports the canary key without printing it", async () => {
    for (const format of [["--json"], []]) {
      const run = await rail(
        ["keys", "import", "--name", `canary${String(format.length)}`, ...format],
        `${world.payer.secret()}\n`,
      );
      expect(run.status).toBe(0);
    }
    const imported = await rail(["keys", "import", "--json"], `${world.payer.secret()}\n`);
    expect(document(imported)).toMatchObject({ ok: true, result: { address: world.payer.publicKey() } });
  });

  it("pays through every outcome in JSON and text output", async () => {
    const url = (path: string) => `${world.sellerUrl}${path}`;
    const max = ["--max", "0.05 TUSD"];
    const paid = await rail([
      "pay",
      url("/weather"),
      "--query",
      "city=Van",
      ...max,
      "--idempotency-key",
      "canary-cli-1",
      "--json",
      "--verbose",
    ]);
    expect(document(paid)).toMatchObject({ ok: true, result: { payment: { status: "settled" } } });
    expect(paid.stderr).toContain('"type":"signed"');
    const hash = (document(paid)["result"] as { payment: { transaction: string } }).payment.transaction;
    await rail([
      "pay",
      url("/weather"),
      "--query",
      "city=Van",
      ...max,
      "--idempotency-key",
      "canary-cli-1",
      "--verbose",
    ]);
    await rail(["pay", url("/weather"), "--query", "city=Mus", ...max, "--verbose"]);
    await rail(["pay", url("/premium"), ...max, "--json", "--verbose"]);
    const broken = await rail(["pay", url("/broken"), ...max, "--json", "--verbose"]);
    expect(document(broken)).toMatchObject({ error: { code: "payment_settlement_unconfirmed" } });
    const unsettled = await rail(["pay", url("/unsettled"), ...max, "--verbose"]);
    expect(unsettled.stderr).toContain("payment_rejected");
    const echoed = await rail(["pay", url("/echo"), ...max, "--json", "--verbose"]);
    expect(document(echoed)).toMatchObject({ ok: true, result: { payment: { status: "settled" } } });
    await rail(["pay", url("/echo"), ...max, "--verbose"]);
    const redirect = await rail(["pay", url("/redirect"), ...max, "--json", "--verbose"]);
    expect(document(redirect)).toMatchObject({ error: { code: "payment_redirect_after_payment" } });
    await rail([
      "pay",
      world.mcpSeller.url,
      "--tool",
      "forecast",
      "--args",
      '{"city":"Rize"}',
      ...max,
      "--verbose",
    ]);
    await rail(["pay", world.mcpSeller.url, "--tool", "echo-payment", ...max, "--json"]);
    await rail(["tx", hash, "--json"]);
    await rail(["tx", hash]);
    for (const format of [["--json"], []]) {
      await rail(["session", "show", ...format]);
      await rail(["session", "reconcile", ...format]);
      await rail(["keys", "show", ...format]);
    }
    const fromEnv = await rail(["session", "show", "--json"], "", {
      RAIL402_SECRET_KEY: world.payer.secret(),
    });
    expect(document(fromEnv)).toMatchObject({ ok: true });
    await rail(["--help"]);
    await rail(["pay", "--help"]);
  });

  it("leaks nothing on stdout, stderr or in the ledger", () => {
    expect(world.paymentHeaders.length).toBeGreaterThanOrEqual(4);
    expect(world.decoy.requests).toHaveLength(0);
    expect(decoyUnpaid(world.decoy)).toBe(true);
    world.addReceivedPayments(scanner);
    const ledger = join(directory, "state", "rail402", "ledger.sqlite");
    expect(existsSync(ledger)).toBe(true);
    for (const suffix of ["", "-wal", "-shm"]) {
      if (existsSync(ledger + suffix)) scanner.capture(`ledger file${suffix}`, readFileSync(ledger + suffix));
    }
    expect(scanner.needles).toBeGreaterThan(30);
    scanner.assertClean();
  });
});
