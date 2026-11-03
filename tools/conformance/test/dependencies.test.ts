import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/evidence.ts";

const lockfile = readFileSync(join(REPO_ROOT, "pnpm-lock.yaml"), "utf8");

/**
 * The first release of each dependency without the advisories published against earlier versions.
 * The dependency scan in CI finds new advisories; this list keeps fixed ones from coming back through
 * a lockfile change that is not scanned before review.
 */
const FIXED_IN: Readonly<Record<string, string>> = {
  axios: "1.20.0",
  "follow-redirects": "1.16.1",
  hono: "4.13.13",
  "ip-address": "10.7.4",
  "source-map-js": "1.2.2",
  "@modelcontextprotocol/sdk": "1.32.1",
  "@modelcontextprotocol/server": "2.3.1",
  "@modelcontextprotocol/client": "2.3.1",
  vite: "8.3.5",
  vitest: "5.0.5",
  "@vitest/mocker": "5.0.5",
};

/** Every version of `name` in the lockfile's packages section. */
function lockedVersions(name: string): string[] {
  const escaped = name.replace(/[/.@-]/g, "\\$&");
  const pattern = new RegExp(`^ {2}'?${escaped}@(\\d+\\.\\d+\\.\\d+)[^:]*'?:$`, "gm");
  return [...new Set([...lockfile.matchAll(pattern)].map((match) => match[1] ?? ""))];
}

function atLeast(version: string, minimum: string): boolean {
  const a = version.split(".").map(Number);
  const b = minimum.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

describe("the locked dependencies", () => {
  it("lock no version with a published advisory fixed in a later release", () => {
    for (const [name, minimum] of Object.entries(FIXED_IN)) {
      const versions = lockedVersions(name);
      expect(versions.length, `${name} is locked`).toBeGreaterThan(0);
      for (const version of versions) expect(atLeast(version, minimum), `${name}@${version}`).toBe(true);
    }
  });

  it("keep the Stellar SDK on the 16.x line @x402/stellar depends on", () => {
    const versions = lockedVersions("@stellar/stellar-sdk");
    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) expect(version, version).toMatch(/^16\./);
  });
});
