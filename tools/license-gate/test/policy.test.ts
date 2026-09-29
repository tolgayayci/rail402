import { describe, expect, it } from "vitest";
import { judge, parseSpdx } from "@rail402.dev/license-gate";

const pkg = (license: string, name = "some-package") => ({ name, version: "1.0.0", license });

describe("parseSpdx", () => {
  it("parses compound expressions with precedence AND over OR", () => {
    expect(parseSpdx("MIT OR Apache-2.0 AND BSD-3-Clause")).toEqual({
      kind: "or",
      left: { kind: "id", id: "MIT" },
      right: {
        kind: "and",
        left: { kind: "id", id: "Apache-2.0" },
        right: { kind: "id", id: "BSD-3-Clause" },
      },
    });
  });

  it("treats WITH exceptions as the base licence", () => {
    expect(parseSpdx("(Apache-2.0 WITH LLVM-exception)")).toEqual({ kind: "id", id: "Apache-2.0" });
  });

  it("rejects malformed expressions", () => {
    expect(() => parseSpdx("")).toThrow();
    expect(() => parseSpdx("MIT OR")).toThrow();
    expect(() => parseSpdx("(MIT")).toThrow();
  });
});

describe("judge", () => {
  it("accepts permissive licences in production", () => {
    for (const license of ["MIT", "Apache-2.0", "BSD-3-Clause", "ISC", "(MIT OR CC0-1.0)"]) {
      expect(judge(pkg(license), "production"), license).toEqual({ ok: true });
    }
  });

  it("rejects copyleft everywhere", () => {
    for (const license of ["AGPL-3.0-or-later", "GPL-2.0-only", "LGPL-3.0-or-later", "SSPL-1.0"]) {
      expect(judge(pkg(license), "production").ok, license).toBe(false);
      expect(judge(pkg(license), "development").ok, license).toBe(false);
    }
  });

  it("accepts a dual licence when one branch is permissive", () => {
    expect(judge(pkg("GPL-2.0-only OR MIT"), "production")).toEqual({ ok: true });
  });

  it("refuses a conjunction that includes copyleft", () => {
    expect(judge(pkg("MIT AND GPL-3.0-only"), "production").ok).toBe(false);
  });

  it("allows listed dev-only exceptions but never in production", () => {
    expect(judge(pkg("MPL-2.0", "lightningcss"), "development")).toEqual({ ok: true });
    expect(judge(pkg("MPL-2.0", "lightningcss"), "production").ok).toBe(false);
    expect(judge(pkg("MPL-2.0", "other"), "development").ok).toBe(false);
  });

  it("refuses denied packages whatever they declare", () => {
    expect(judge(pkg("Apache-2.0", "sharp"), "production").ok).toBe(false);
    expect(judge(pkg("MIT", "@openzeppelin/relayer-sdk"), "development").ok).toBe(false);
  });

  it("fails closed on unknown or missing licences", () => {
    expect(judge(pkg("UNKNOWN"), "production").ok).toBe(false);
    expect(judge(pkg("SEE LICENSE IN LICENSE.md"), "development").ok).toBe(false);
  });
});
