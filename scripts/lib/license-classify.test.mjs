import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classify, classifyAtom, atomsOf, isCompound } from "./license-classify.mjs";

const policy = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../license-policy.json"), "utf8"),
);

const pkg = (license, name = "some-dep", version = "1.0.0") => ({ name, version, license });
const verdictOf = (license, p = policy) => classify(pkg(license), p).verdict;

describe("license gate — fail closed", () => {
  it("blocks every strong-copyleft family on the block list", () => {
    for (const license of [
      "AGPL-3.0-or-later",
      "AGPL-3.0-only",
      "AGPL-1.0-only",
      "GPL-3.0-only",
      "GPL-2.0-or-later",
      "SSPL-1.0",
      "BUSL-1.1",
      "Elastic-2.0",
      "Commons-Clause",
    ]) {
      expect(verdictOf(license), `${license} must be BLOCKED`).toBe("BLOCKED");
    }
  });

  it("blocks AGPL — the specific license behind the OpenZeppelin Relayer stack", () => {
    // That codebase is unusable here; AGPL's network clause applies to a service
    // serving third parties. This is the single most important assertion in this file.
    expect(verdictOf("AGPL-3.0-or-later")).toBe("BLOCKED");
  });

  it("blocks unknown, undeclared, and UNLICENSED packages (fail closed, not open)", () => {
    expect(verdictOf("UNKNOWN")).toBe("BLOCKED");
    expect(verdictOf("UNLICENSED")).toBe("BLOCKED");
    expect(verdictOf("")).toBe("BLOCKED");
    expect(classify({ name: "x", version: "1.0.0" }, policy).verdict).toBe("BLOCKED");
    // A licence nobody has heard of must NOT be silently allowed.
    expect(verdictOf("WTFPL-9.9")).toBe("UNKNOWN");
  });

  it("allows exactly the permissive set from the license policy", () => {
    for (const license of [
      "MIT",
      "Apache-2.0",
      "BSD-2-Clause",
      "BSD-3-Clause",
      "ISC",
      "0BSD",
      "Zlib",
      "Unlicense",
      "CC0-1.0",
      "BlueOak-1.0.0",
      "Python-2.0",
    ]) {
      expect(verdictOf(license), `${license} must be ALLOWED`).toBe("ALLOWED");
    }
  });
});

describe("license gate — ordering hazards", () => {
  it("does NOT let the GPL- prefix swallow LGPL- (weak copyleft is review, not blocked)", () => {
    // Regression guard: `"LGPL-3.0-only".startsWith("GPL-")` is false, but a careless
    // `.includes("GPL")` check would wrongly block it — and a careless prefix ORDER would
    // wrongly block it too. Both are real mistakes; this pins the correct behaviour.
    expect(verdictOf("LGPL-3.0-only")).toBe("REVIEW");
    expect(verdictOf("LGPL-2.1-or-later")).toBe("REVIEW");
    expect(classifyAtom("LGPL-3.0-only", policy)).toBe("REVIEW");
    expect(classifyAtom("GPL-3.0-only", policy)).toBe("BLOCKED");
  });

  it("routes weak-copyleft and unusual licenses to REVIEW", () => {
    for (const license of ["MPL-2.0", "EPL-2.0", "CDDL-1.0", "PostgreSQL", "CC-BY-4.0"]) {
      expect(verdictOf(license), `${license} must be REVIEW`).toBe("REVIEW");
    }
  });
});

describe("license gate — SPDX expressions", () => {
  it("treats any compound expression as REVIEW even when both halves are permissive", () => {
    // Policy: "dual licenses" are flagged for human review. Picking a half is a
    // project decision that must be recorded, not one the gate makes silently.
    expect(verdictOf("(MIT OR Apache-2.0)")).toBe("REVIEW");
    expect(verdictOf("MIT OR ISC")).toBe("REVIEW");
  });

  it("blocks a compound expression if ANY half is blocked", () => {
    expect(verdictOf("(MIT OR AGPL-3.0-only)")).toBe("BLOCKED");
    expect(verdictOf("Apache-2.0 AND GPL-3.0-only")).toBe("BLOCKED");
  });

  it("parses SPDX operators and parentheses", () => {
    expect(atomsOf("(MIT OR Apache-2.0)")).toEqual(["MIT", "Apache-2.0"]);
    expect(atomsOf("Apache-2.0 WITH LLVM-exception")).toEqual(["Apache-2.0", "LLVM-exception"]);
    expect(isCompound("MIT")).toBe(false);
    expect(isCompound("(MIT OR Apache-2.0)")).toBe(true);
  });
});

describe("license gate — acknowledgements", () => {
  const withAck = ack => ({ ...policy, acknowledged: ack });

  it("lets a human acknowledge a REVIEW-class license, by name or name@version", () => {
    expect(classify(pkg("MPL-2.0", "mozzy"), withAck({ mozzy: "reviewed: file-level copyleft only" })).verdict).toBe(
      "ACKNOWLEDGED",
    );
    expect(classify(pkg("MPL-2.0", "mozzy", "2.3.4"), withAck({ "mozzy@2.3.4": "reviewed" })).verdict).toBe(
      "ACKNOWLEDGED",
    );
  });

  it("does NOT apply an acknowledgement meant for a different version", () => {
    expect(classify(pkg("MPL-2.0", "mozzy", "9.9.9"), withAck({ "mozzy@2.3.4": "reviewed" })).verdict).toBe("REVIEW");
  });

  it("REFUSES to let an acknowledgement launder a blocked license", () => {
    // The block list is absolute: hard prohibitions are "never overridden by anything, including
    // the spec or the human asking casually". An acknowledgement entry must not become a bypass.
    const result = classify(pkg("AGPL-3.0-or-later", "sneaky"), withAck({ sneaky: "please just let me ship" }));
    expect(result.verdict).toBe("BLOCKED");
    expect(result.detail).toMatch(/never be acknowledged/i);
  });
});

describe("license gate — policy file integrity", () => {
  it("keeps the allow/review/block sets disjoint", () => {
    const overlap = (a, b) => a.filter(x => b.includes(x));
    expect(overlap(policy.allow, policy.block)).toEqual([]);
    expect(overlap(policy.allow, policy.review)).toEqual([]);
    expect(overlap(policy.review, policy.block)).toEqual([]);
  });

  it("ships no acknowledgement for any blocked license", () => {
    for (const key of Object.keys(policy.acknowledged ?? {})) {
      const name = key.split("@").filter(Boolean)[0];
      expect(policy.block).not.toContain(name);
    }
  });
});
