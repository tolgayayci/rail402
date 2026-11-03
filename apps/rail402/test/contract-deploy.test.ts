/**
 * The pubnet guards of the contract deploy script, which refuse before any transaction (and before
 * Docker or the network is used). Nothing here is ever sent.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DEPLOY = join(ROOT, "scripts/contracts/deploy.sh");
const FIXTURE = join(ROOT, "packages/testkit/fixtures/x402_upto_stellar.wasm");
const directory = mkdtempSync(join(tmpdir(), "rail402-deploy-"));
const secret = join(directory, "deployer");
writeFileSync(secret, Keypair.random().secret(), { mode: 0o600 });
const other = join(directory, "other.wasm");
writeFileSync(other, "not the attested release");

function deploy(args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      "bash",
      [DEPLOY, ...args],
      { cwd: ROOT, env: { PATH: process.env["PATH"] ?? "", HOME: directory } },
      (error, _stdout, stderr) => {
        resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : 1, stderr });
      },
    );
  });
}

const pubnet = ["--network", "pubnet", "--deployer-secret-file", secret];

describe("deploy.sh --network pubnet", () => {
  it.each([
    ["without an RPC", [...pubnet, "--release-wasm", FIXTURE], /give --rpc-url/],
    [
      "over plain http",
      [...pubnet, "--rpc-url", "http://rpc.example", "--release-wasm", FIXTURE],
      /must use https/,
    ],
    ["without the release wasm", [...pubnet, "--rpc-url", "https://rpc.example"], /give --release-wasm/],
    [
      "for a test token",
      [...pubnet, "--rpc-url", "https://rpc.example", "--release-wasm", FIXTURE, "--contract", "test-token"],
      /only the upto contract/,
    ],
    [
      "with Friendbot",
      [...pubnet, "--rpc-url", "https://rpc.example", "--release-wasm", FIXTURE, "--fund"],
      /--fund is for test networks/,
    ],
  ])("refuses to deploy %s", async (_label, args, pattern) => {
    const result = await deploy(args);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(pattern);
  });

  it("refuses pubnet bytes that differ from the attested release", async () => {
    const result = await deploy([
      ...pubnet,
      "--rpc-url",
      "https://rpc.example/KEY123",
      "--release-wasm",
      other,
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/not the committed fixture .*refusing to deploy other bytes to pubnet/);
    expect(result.stderr).not.toContain("KEY123");
  });

  it("keeps the pubnet options away from test networks", async () => {
    const result = await deploy([
      "--network",
      "testnet",
      "--deployer-secret-file",
      secret,
      "--release-wasm",
      FIXTURE,
    ]);
    expect(result.stderr).toMatch(/are for pubnet/);
  });
});
