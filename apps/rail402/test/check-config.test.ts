/**
 * The configuration preflight, run from source as `node dist/check-config.js` runs from the build. It
 * never touches a network, so the RPC URLs point nowhere.
 */
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { COLD_SIGNER, sponsorKeyFile } from "./secret-fixtures.ts";

const CHECK_CONFIG = fileURLToPath(new URL("../src/check-config.ts", import.meta.url));

function checkConfig(env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--conditions=@rail402/source", CHECK_CONFIG],
      { env: { PATH: process.env["PATH"] ?? "", ...env }, timeout: 60_000 },
      (error, stdout, stderr) => {
        resolve({
          code: error === null ? 0 : typeof error.code === "number" ? error.code : 1,
          stdout,
          stderr,
        });
      },
    );
  });
}

const testnet = {
  STORE: "memory",
  TESTNET_RPC_URL: "http://127.0.0.1:1/rpc",
  TESTNET_SPONSOR_SECRET: Keypair.random().secret(),
};

describe("check-config", () => {
  it("exits 0 and reports the networks and their settings digests when the service would start", async () => {
    const result = await checkConfig(testnet);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(report).toMatchObject({ ok: true, networks: ["stellar:testnet"], store: "memory" });
    expect((report["settings"] as Record<string, string>)["stellar:testnet"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("exits 78 with the code the service would stop with", async () => {
    const result = await checkConfig({
      ...testnet,
      NETWORKS: "stellar:testnet,stellar:pubnet",
      METRICS_PRIVATE_TOKEN_SHA256: "c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff",
      PUBNET_RPC_SINGLE_PROVIDER: "true",
      PUBNET_RPC_URL: "https://127.0.0.1:1/rpc",
      PUBNET_SPONSOR_SECRET_FILE: sponsorKeyFile(Keypair.random().secret()),
      PUBNET_SPONSOR_COLD_SIGNER: COLD_SIGNER,
      PUBNET_REQUIRE_API_KEY: "false",
      PUBNET_RATE_LIMIT_PER_MINUTE: "60",
      PUBNET_KEYLESS_SPONSOR_BUDGET_XLM_PER_HOUR: "1",
      PUBNET_MAX_SPONSOR_SPEND_XLM_PER_HOUR: "10",
    });
    expect(result.code).toBe(78);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^rail402: config_pubnet_fee_ceiling_missing: PUBNET_MAX_TX_FEE_STROOPS /);
  });

  it.each([
    [{ TESTNET_SPONSOR_SECRET: "" }, "config_sponsor_secret_missing", "TESTNET_SPONSOR_SECRET"],
    [{ TESTNET_RPC_URL: "" }, "config_rpc_missing", "TESTNET_RPC_URL"],
  ])("exits 78 with %j unset", async (unset, code, variable) => {
    const result = await checkConfig({ ...testnet, ...unset });
    expect(result.code).toBe(78);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(new RegExp(`^rail402: ${code}: ${variable} `));
  });

  it("refuses a pubnet secret from the environment", async () => {
    const result = await checkConfig({
      ...testnet,
      NETWORKS: "stellar:testnet,stellar:pubnet",
      PUBNET_SPONSOR_SECRET: Keypair.random().secret(),
    });
    expect(result.code).toBe(78);
    expect(result.stderr).toMatch(/^rail402: config_secret_in_env: PUBNET_SPONSOR_SECRET /);
  });

  it("codes a malformed value config_invalid and never echoes a secret", async () => {
    const result = await checkConfig({ ...testnet, TESTNET_SPONSOR_SECRET: "SNOTASECRET" });
    expect(result.code).toBe(78);
    expect(result.stderr).toMatch(/^rail402: config_invalid: invalid configuration:/);
    expect(result.stderr).toContain("TESTNET_SPONSOR_SECRET");
    expect(result.stderr).not.toContain("SNOTASECRET");
  });
});
