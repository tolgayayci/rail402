import { globSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadWatchList, parseWatchList } from "../src/watch-list.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const list = loadWatchList();

/** The `catalog:` block of pnpm-workspace.yaml as name → version (flat `"name": version` lines). */
function catalog(): Map<string, string> {
  const text = readFileSync(`${ROOT}pnpm-workspace.yaml`, "utf8");
  const block = /^catalog:\n((?:[ \t]+.*\n|\n)*)/m.exec(text)?.[1] ?? "";
  const entries = new Map<string, string>();
  for (const line of block.split("\n")) {
    const match = /^\s+"?([^"#:\s]+)"?:\s*([^\s#]+)/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) entries.set(match[1], match[2]);
  }
  return entries;
}

const matches = (pattern: string) => globSync(pattern, { cwd: ROOT });

describe("the watch list", () => {
  it("pins every upstream package of the pnpm catalog at the catalog's version, and nothing else", () => {
    const pinned = new Map(list.packages.map((entry) => [entry.name, entry.pinned]));
    const upstream = new Map(
      [...catalog()].filter(([name]) => name.startsWith("@x402/") || name === "@stellar/stellar-sdk"),
    );
    expect(upstream.size).toBeGreaterThan(0);
    expect(pinned).toEqual(upstream);
  });

  it("pins every upstream package through the default catalog only: no override, named catalog or direct pin", () => {
    const upstream = (name: string) => name.startsWith("@x402/") || name === "@stellar/stellar-sdk";
    const workspace = readFileSync(`${ROOT}pnpm-workspace.yaml`, "utf8");
    // A named catalog or an override could resolve another version than the one the watch list pins.
    expect(workspace).not.toMatch(/^catalogs:/m);
    const pins = catalog();
    const direct: string[] = [];
    // Overrides may hold transitive dependencies at fixed releases, never an upstream package.
    const overrides = /^overrides:\n((?: {2}.*\n?)*)/m.exec(workspace)?.[1] ?? "";
    for (const line of overrides.split("\n")) {
      const name = /^ {2}"?([^":]+)"?:/.exec(line)?.[1];
      if (name !== undefined && upstream(name.replace(/@[^@/]*$/, "") || name))
        direct.push(`pnpm-workspace.yaml: overrides ${name}`);
    }
    for (const file of ["package.json", ...matches("{apps,examples,packages,tools}/*/package.json")]) {
      const manifest = JSON.parse(readFileSync(`${ROOT}${file}`, "utf8")) as Record<string, unknown>;
      const pnpm = manifest["pnpm"] as { overrides?: Record<string, string> } | undefined;
      for (const name of Object.keys(pnpm?.overrides ?? {})) {
        if (upstream(name.replace(/@[^@/]*$/, "") || name)) direct.push(`${file}: pnpm.overrides ${name}`);
      }
      for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
        const deps = (manifest[field] ?? {}) as Record<string, string>;
        for (const [name, version] of Object.entries(deps)) {
          if (!upstream(name) || field === "peerDependencies") continue;
          // The examples are standalone npm projects: they pin the catalog's exact version instead.
          const expected = file.startsWith("examples/") ? pins.get(name) : "catalog:";
          if (version !== expected) direct.push(`${file}: ${field} ${name} ${version}`);
        }
      }
    }
    expect(direct).toEqual([]);
  });

  it("names a baseline release that matches the pinned @x402/stellar", () => {
    const stellar = list.packages.find((entry) => entry.name === "@x402/stellar");
    expect(list.upstream.baselineRef).toBe(`npm-@x402/stellar@v${stellar?.pinned}`);
  });

  it("matches files with every component path, test and docs pattern", () => {
    const empty: string[] = [];
    for (const [id, component] of Object.entries(list.components)) {
      for (const pattern of [...component.paths, ...component.tests, ...component.docs]) {
        if (matches(pattern).length === 0) empty.push(`${id}: ${pattern}`);
      }
    }
    expect(empty).toEqual([]);
  });

  it("uses every component", () => {
    const used = new Set(
      [...list.files, ...list.pending, ...list.paths, ...list.packages, ...list.urls].flatMap(
        (entry) => entry.affects,
      ),
    );
    expect([...used].sort()).toEqual(Object.keys(list.components).sort());
  });

  it("refuses unknown components, duplicates, short SHAs and paths outside the repository", () => {
    const raw = JSON.parse(readFileSync(new URL("../watch.json", import.meta.url), "utf8")) as {
      files: Record<string, unknown>[];
    };
    const [first] = raw.files;
    const refusal = (files: Record<string, unknown>[]) => {
      try {
        parseWatchList({ ...raw, files });
        return "";
      } catch (error) {
        return (error as Error).message;
      }
    };
    expect(refusal([{ ...first, pinnedCommit: "e187dda1" }])).toContain("a full 40-character hex SHA");
    expect(refusal([{ ...first, path: "../outside.md" }])).toContain("a relative path inside the repository");
    expect(refusal([{ ...first, affects: ["nowhere"] }])).toContain('affects an unknown component "nowhere"');
    expect(refusal([{ ...first }, { ...first }])).toContain("specs/x402-specification-v2.md is listed twice");
    expect(refusal([{ ...first }])).toBe("");
  });
});
