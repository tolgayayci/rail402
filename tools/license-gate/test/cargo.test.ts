import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cargoBinary, findCargoWorkspaces, normaliseCargoLicense, parseCargoMetadata } from "../src/cargo.ts";
import { judge } from "../src/policy.ts";
import { renderReport } from "../src/report.ts";

describe("normaliseCargoLicense", () => {
  it("rewrites the legacy slash notation as OR", () => {
    expect(normaliseCargoLicense("MIT/Apache-2.0")).toBe("MIT OR Apache-2.0");
    expect(normaliseCargoLicense("Apache-2.0 / MIT")).toBe("Apache-2.0 OR MIT");
  });

  it("keeps SPDX expressions and marks a missing licence as unknown", () => {
    expect(normaliseCargoLicense("(MIT OR Apache-2.0) AND Unicode-3.0")).toBe(
      "(MIT OR Apache-2.0) AND Unicode-3.0",
    );
    expect(normaliseCargoLicense(null)).toBe("UNKNOWN");
    expect(normaliseCargoLicense(" ")).toBe("UNKNOWN");
  });
});

describe("Rust licences under the policy", () => {
  const verdict = (license: string | null) =>
    judge({ name: "crate", version: "1.0.0", license: normaliseCargoLicense(license) }, "production").ok;

  it("accepts the licences found in soroban-sdk's tree", () => {
    for (const license of [
      "MIT OR Apache-2.0",
      "MIT/Apache-2.0",
      "Apache-2.0 WITH LLVM-exception",
      "(MIT OR Apache-2.0) AND Unicode-3.0",
      "MIT OR Apache-2.0 OR BSD-1-Clause",
      "Unlicense OR MIT",
      "BSD-3-Clause",
    ]) {
      expect(verdict(license), license).toBe(true);
    }
  });

  it("refuses copyleft, unknown and licence-file-only crates", () => {
    expect(verdict("GPL-3.0-only")).toBe(false);
    expect(verdict("AGPL-3.0-or-later")).toBe(false);
    expect(verdict("MPL-2.0")).toBe(false);
    expect(verdict(null)).toBe(false);
  });
});

describe("parseCargoMetadata", () => {
  it("reads name, version and licence of every package", () => {
    const json = JSON.stringify({
      packages: [
        { name: "soroban-sdk", version: "28.0.0", license: "Apache-2.0", license_file: null },
        { name: "legacy", version: "0.1.0", license: "MIT/Apache-2.0", license_file: null },
        { name: "mystery", version: "0.0.1", license: null, license_file: "LICENSE" },
      ],
    });
    expect(parseCargoMetadata(json)).toEqual([
      { name: "soroban-sdk", version: "28.0.0", license: "Apache-2.0" },
      { name: "legacy", version: "0.1.0", license: "MIT OR Apache-2.0" },
      { name: "mystery", version: "0.0.1", license: "UNKNOWN" },
    ]);
  });
});

describe("findCargoWorkspaces", () => {
  it("finds manifests with a lockfile and skips build output", () => {
    const root = mkdtempSync(join(tmpdir(), "license-gate-"));
    const crate = (path: string, lock: boolean) => {
      mkdirSync(join(root, path), { recursive: true });
      writeFileSync(join(root, path, "Cargo.toml"), "");
      if (lock) writeFileSync(join(root, path, "Cargo.lock"), "");
    };
    crate("contracts/stellar/upto", true);
    crate("contracts/testing/policy", true);
    crate("contracts/testing/policy/member", false);
    crate("contracts/stellar/upto/target/package/copy", true);
    expect(findCargoWorkspaces(root)).toEqual(["contracts/stellar/upto", "contracts/testing/policy"]);
    expect(findCargoWorkspaces(join(root, "missing"))).toEqual([]);
  });
});

describe("renderReport with contracts", () => {
  it("adds a summary row and a licence table per workspace", () => {
    const report = renderReport({
      service: [],
      production: [],
      everything: [],
      contracts: [
        {
          path: "contracts/stellar/upto",
          packages: [
            { name: "a", version: "1.0.0", license: "MIT OR Apache-2.0" },
            { name: "b", version: "1.0.0", license: "MIT OR Apache-2.0" },
            { name: "c", version: "1.0.0", license: "BSD-3-Clause" },
          ],
        },
      ],
    });
    expect(report).toContain("| Contract contracts/stellar/upto (Rust) | 3 |");
    expect(report).toContain("### contracts/stellar/upto");
    expect(report).toContain("| MIT OR Apache-2.0 | 2 |");
  });
});

describe("cargoBinary", () => {
  it("prefers $CARGO, then rustup's install location, then PATH", () => {
    expect(cargoBinary({ CARGO: "/opt/cargo" })).toBe("/opt/cargo");
    const home = mkdtempSync(join(tmpdir(), "cargo-home-"));
    expect(cargoBinary({ CARGO_HOME: home })).toBe("cargo");
    mkdirSync(join(home, "bin"));
    writeFileSync(join(home, "bin", "cargo"), "");
    expect(cargoBinary({ CARGO_HOME: home })).toBe(join(home, "bin", "cargo"));
  });
});
