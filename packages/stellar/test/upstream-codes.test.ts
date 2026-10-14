/**
 * The facilitator passes codes from the upstream @x402/stellar scheme through to callers, so every code
 * the installed version can return must be registered. This scans the installed package, so upgrading
 * @x402/stellar fails here until any new code is added to the registry.
 */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { exactStellarCodes } from "@rail402.dev/stellar";

const PATTERNS = [
  /\b((?:invalid|settle)_(?:exact|upto)_stellar_[a-z0-9_]+)\b/g,
  /invalidVerifyResponse\(\s*"([a-z0-9_]+)"/g,
  /(?:invalidReason|errorReason)\s*(?::|\?\?)\s*"([a-z0-9_]+)"/g,
];

function upstreamCodes(): Set<string> {
  const require = createRequire(import.meta.url);
  // The package exports no package.json; its entry point lives under dist/.
  const entry = require.resolve("@x402/stellar");
  const dist = entry.slice(0, entry.lastIndexOf(`${sep}dist${sep}`) + `${sep}dist`.length);
  const found = new Set<string>();
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:m?js|cjs)$/.test(entry.name)) {
        const source = readFileSync(path, "utf8");
        for (const pattern of PATTERNS) {
          for (const match of source.matchAll(pattern)) found.add(match[1] ?? "");
        }
      }
    }
  };
  walk(dist);
  return found;
}

describe("installed @x402/stellar", () => {
  const codes = upstreamCodes();

  it("is scanned (a scan that finds nothing proves nothing)", () => {
    expect(codes.size).toBeGreaterThanOrEqual(25);
  });

  it("returns only registered codes", () => {
    const unregistered = [...codes].filter((code) => !Object.hasOwn(exactStellarCodes, code)).sort();
    expect(unregistered, "register these codes in packages/stellar/src/codes.ts").toEqual([]);
  });
});
