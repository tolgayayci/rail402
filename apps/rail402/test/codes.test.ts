import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CodeSet } from "@rail402.dev/errors";
import { allCodes, codeGroups, isRail402Code } from "@rail402.dev/service";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

// Every code set defined anywhere in the repository must be documented either here (codes the service
// returns) or in tools/conformance/src/client-codes.ts (codes the SDK, MCP server and CLI raise);
// tools/conformance/test/code-registry.test.ts scans the sources for both.
describe("the code registry", () => {
  it("documents each set's codes exactly once, and nothing else", async () => {
    const bySet = new Map<string, string[]>();
    for (const group of codeGroups) {
      bySet.set(group.set, [...(bySet.get(group.set) ?? []), ...Object.keys(group.codes)]);
    }
    for (const [name, documented] of bySet) {
      const group = codeGroups.find((candidate) => candidate.set === name);
      const module = (await import(group?.package ?? "")) as Record<string, CodeSet | undefined>;
      const set = module[name];
      expect(set, `${name} is not exported by ${group?.package ?? "?"}`).toBeDefined();
      expect([...documented].sort(), name).toEqual(Object.keys(set ?? {}).sort());
    }
  });

  it("merges exactly the documented codes into allCodes", () => {
    const documented = codeGroups.flatMap((group) => Object.keys(group.codes));
    expect(new Set(documented).size).toBe(documented.length);
    expect(documented.sort()).toEqual(Object.keys(allCodes).sort());
    expect(isRail402Code("invalid_payload")).toBe(true);
    expect(isRail402Code("toString")).toBe(false);
  });

  it("gives every code a non-empty default reason", () => {
    for (const [code, spec] of Object.entries(allCodes)) {
      expect(spec.reason.trim(), code).not.toBe("");
      expect(spec.reason.length, code).toBeLessThanOrEqual(300);
    }
  });

  it("lists every code on the error-code reference page", () => {
    const page = readFileSync(join(ROOT, "docs/reference/error-codes.mdx"), "utf8");
    const listed = new Set([...page.matchAll(/^\| `([a-z0-9_]+)` +\|/gm)].map((match) => match[1]));
    const missing = Object.keys(allCodes).filter((code) => !listed.has(code));
    expect(missing, "run pnpm report").toEqual([]);
  });
});
