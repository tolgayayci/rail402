import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { mergeCodes, type CodeSet } from "@rail402.dev/errors";
import { allCodes, codeGroups } from "@rail402.dev/service/codes";
import { allClientCodes, clientCodeGroups } from "../src/client-codes.ts";
import { REPO_ROOT } from "../src/evidence.ts";

const DEFINITION = /export const (\w+) = defineCodes\(/g;

/** Every `export const X = defineCodes(…)` in the sources of every app and package, as `{ name, file }`. */
function definedCodeSets(): { name: string; file: string }[] {
  const found: { name: string; file: string }[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith(".ts")) {
        for (const match of readFileSync(path, "utf8").matchAll(DEFINITION)) {
          found.push({ name: match[1] ?? "", file: relative(REPO_ROOT, path) });
        }
      }
    }
  };
  for (const top of ["apps", "packages"]) {
    for (const project of readdirSync(join(REPO_ROOT, top))) {
      const source = join(REPO_ROOT, top, project, "src");
      try {
        if (statSync(source).isDirectory()) walk(source);
      } catch {
        // a project without sources
      }
    }
  }
  return found;
}

const groups = [...codeGroups, ...clientCodeGroups];

describe("the workspace code registry", () => {
  it("documents every code set defined anywhere, as a service or a client set", () => {
    const sets = definedCodeSets();
    expect(sets.map((set) => set.name)).toEqual(
      expect.arrayContaining(["exactStellarCodes", "paymentCodes"]),
    );
    const registered = new Set(groups.map((group) => group.set));
    const missing = sets.filter((set) => !registered.has(set.name));
    expect(
      missing,
      "add service sets to codeGroups in apps/rail402/src/codes.ts and client sets to clientCodeGroups in tools/conformance/src/client-codes.ts",
    ).toEqual([]);
  });

  it("documents each client set's codes exactly, from the package that exports it", async () => {
    for (const group of clientCodeGroups) {
      const module = (await import(group.package)) as Record<string, CodeSet | undefined>;
      const set = module[group.set];
      expect(set, `${group.set} is not exported by ${group.package}`).toBeDefined();
      expect(Object.keys(group.codes).sort(), group.set).toEqual(Object.keys(set ?? {}).sort());
    }
    expect(new Set(clientCodeGroups.map((group) => group.id)).size).toBe(clientCodeGroups.length);
  });

  it("never gives two sets, service or client, the same code", () => {
    const sets = new Map<string, CodeSet>();
    for (const group of groups) sets.set(`${group.package}#${group.set}`, group.codes);
    expect(() => mergeCodes(...sets.values())).not.toThrow();
    const clash = Object.keys(allClientCodes).filter((code) => Object.hasOwn(allCodes, code));
    expect(clash).toEqual([]);
  });

  it("gives every client code a non-empty default reason and, for payment codes, a paid value", () => {
    for (const group of clientCodeGroups) {
      for (const [code, spec] of Object.entries(group.codes)) {
        expect(spec.reason.trim(), code).not.toBe("");
        expect(spec.reason.length, code).toBeLessThanOrEqual(300);
        if (group.id !== "seller")
          expect(group.paid(code), code).toMatch(/^(none|not_settled|settled|unknown)$/);
      }
    }
  });

  it("lists every code once on the error-code reference page", () => {
    // The code tables, without the coverage section that repeats some codes.
    const page = readFileSync(join(REPO_ROOT, "docs/reference/error-codes.mdx"), "utf8").split(
      "\n## Coverage\n",
    )[0] as string;
    const listed = [...page.matchAll(/^\| `([a-z0-9_]+)` +\|/gm)].map((match) => match[1] ?? "");
    const all = [...Object.keys(allCodes), ...Object.keys(allClientCodes)];
    expect(
      all.filter((code) => !listed.includes(code)),
      "run pnpm report",
    ).toEqual([]);
    expect(listed.length, "a code is listed twice").toBe(new Set(listed).size);
  });
});
