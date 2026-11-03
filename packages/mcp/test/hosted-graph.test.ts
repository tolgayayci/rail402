/**
 * `rail402-mcp --hosted` loads discovery code only: the module graph of a running hosted process,
 * recorded by a resolve hook in a child process, holds none of the SDK's key loading, signing guard,
 * budget ledgers, payment flows or scheme clients, and none of the MCP server's payment tools.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const BIN = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
const TRACER = fileURLToPath(new URL("fixtures/trace-imports.ts", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "rail402-mcp-graph-"));

/** Modules whose presence would mean the process can load a key, sign or spend. */
const PAYMENT_MODULES: readonly RegExp[] = [
  /\/packages\/sdk\/src\/(keys|account|buyer|buyer-core|browser|index|node|config|confirm)\.ts$/,
  /\/packages\/sdk\/src\/flow\//,
  /\/packages\/sdk\/src\/policy\/(guard|ledger|memory-ledger|storage-ledger|budget|reconcile|decide)\.ts$/,
  /\/packages\/sdk\/src\/(schemes|sqlite|seller|inspect)\//,
  /\/packages\/upto\/src\/client\//,
  /\/@x402\/stellar\/dist\/esm\/exact\/client\//,
  /\/packages\/mcp\/src\/(tools|confirm-scope|runtime|main|config|stdio)\.ts$/,
];

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * Runs bin.ts with `args` under the tracer and returns every module URL it resolved. With `until`, the
 * process is stopped with SIGTERM once its stderr contains that text.
 */
function trace(name: string, args: readonly string[], env: Record<string, string>, until?: string) {
  const out = join(scratch, `${name}.json`);
  const child = spawn(process.execPath, ["--conditions=@rail402/source", "--import", TRACER, BIN, ...args], {
    env: { PATH: process.env["PATH"] ?? "", RAIL402_TRACE_OUT: out, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let stopped = false;
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    if (until !== undefined && !stopped && stderr.includes(until)) {
      stopped = true;
      child.kill("SIGTERM");
    }
  });
  child.stdout.resume();
  return new Promise<{ modules: string[]; code: number | null; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      try {
        resolve({ modules: JSON.parse(readFileSync(out, "utf8")) as string[], code, stderr });
      } catch (error) {
        reject(new Error(`no trace (exit ${String(code)}): ${stderr}`, { cause: error }));
      }
    });
  });
}

const offenders = (modules: readonly string[]) =>
  modules.filter((url) => PAYMENT_MODULES.some((pattern) => pattern.test(url)));

describe("the hosted module graph", () => {
  it("loads no key, signer, ledger or payment module in hosted mode", async () => {
    const { modules, code, stderr } = await trace(
      "hosted",
      ["--hosted"],
      {
        RAIL402_MCP_UPSTREAM: "http://127.0.0.1:9",
        PUBLIC_HOSTS: "mcp.example",
        TRUSTED_PROXY_HOPS: "0",
        HOST: "127.0.0.1",
        PORT: "0",
        METRICS_PORT: "0",
      },
      '"msg":"serving"',
    );
    expect(stderr).toContain('"mode":"hosted"');
    expect(code).toBe(0);
    // The trace saw the hosted code and the discovery entry it is built on...
    expect(modules.some((url) => url.endsWith("/packages/mcp/src/hosted-server.ts"))).toBe(true);
    expect(modules.some((url) => url.endsWith("/packages/sdk/src/discovery-entry.ts"))).toBe(true);
    // ...and nothing that can pay.
    expect(offenders(modules)).toEqual([]);
  }, 30_000);

  it("does see the payment modules when the local server starts, so the check can fail", async () => {
    const { modules, code } = await trace("local", ["--version"], {});
    expect(code).toBe(0);
    const found = offenders(modules);
    expect(found.some((url) => url.endsWith("/packages/sdk/src/keys.ts"))).toBe(true);
    expect(found.some((url) => url.endsWith("/packages/sdk/src/policy/guard.ts"))).toBe(true);
    expect(found.some((url) => /\/packages\/sdk\/src\/flow\//.test(url))).toBe(true);
  }, 30_000);
});
