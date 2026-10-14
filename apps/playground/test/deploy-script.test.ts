import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { PAY_TO } from "./support.ts";

const SCRIPT = fileURLToPath(new URL("../../../deploy/playground.sh", import.meta.url));

/** Runs the deploy script with a `railway` on PATH that records any call it gets. */
function run(...args: string[]) {
  const bin = mkdtempSync(join(tmpdir(), "playground-deploy-"));
  const calls = join(bin, "railway-called");
  writeFileSync(join(bin, "railway"), `#!/usr/bin/env bash\necho "$@" >> "${calls}"\nexit 1\n`);
  chmodSync(join(bin, "railway"), 0o755);
  const result = spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env["PATH"] ?? ""}`, HOME: bin },
  });
  return { status: result.status, out: result.stdout + result.stderr, railwayCalled: existsSync(calls) };
}

describe("the Playground deploy script", () => {
  it("lists every step of a deploy in a dry run without calling Railway", () => {
    const result = run("--dry-run", PAY_TO);
    expect(result.status, result.out).toBe(0);
    expect(result.railwayCalled).toBe(false);
    for (const step of [
      "railway init --name rail402-playground --json",
      "railway config apply --file",
      ".railway/playground.ts --yes",
      `railway variable set PLAYGROUND_PAY_TO=${PAY_TO} --service playground`,
      "railway variable set RAIL402_COMMIT=",
      "railway up",
      "--service playground",
      "railway domain --service playground --port 8080",
    ]) {
      expect(result.out).toContain(step);
    }
  });

  it("refuses a secret seed without printing it", () => {
    const seed = Keypair.random().secret();
    const result = run("--dry-run", seed);
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("that is a secret seed");
    expect(result.out).not.toContain(seed);
    expect(result.railwayCalled).toBe(false);
  });

  it("refuses a missing or malformed account, and the facilitator's production project", () => {
    for (const args of [
      ["--dry-run"],
      ["--dry-run", "GABC"],
      ["--dry-run", PAY_TO, "rail402-stellar-prod"],
    ]) {
      const result = run(...args);
      expect(result.status, args.join(" ")).not.toBe(0);
      expect(result.out).toMatch(/^error: /m);
      expect(result.railwayCalled).toBe(false);
    }
  });
});
