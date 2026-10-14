/**
 * Licences of the Rust dependency trees under `contracts/`. Each directory holding both a
 * `Cargo.toml` and a `Cargo.lock` is a separate Cargo workspace; its resolved packages come from
 * `cargo metadata --locked`, so a lockfile that would need changes fails instead of being updated.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import type { PackageLicense } from "./policy.ts";

export interface CargoWorkspace {
  /** Directory of the workspace, relative to the repository root. */
  readonly path: string;
  readonly packages: readonly PackageLicense[];
}

interface CargoMetadata {
  readonly packages: readonly {
    readonly name: string;
    readonly version: string;
    readonly license: string | null;
    readonly license_file: string | null;
  }[];
}

const SKIP = new Set(["target", "node_modules", ".git"]);

/** Directories under `dir` that are Cargo workspace roots (a manifest next to a lockfile). */
export function findCargoWorkspaces(root: string, dir = "contracts"): string[] {
  const absolute = join(root, dir);
  if (!existsSync(absolute)) return [];
  const found: string[] = [];
  const walk = (current: string): void => {
    if (existsSync(join(current, "Cargo.toml")) && existsSync(join(current, "Cargo.lock"))) {
      found.push(relative(root, current));
    }
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory() && !SKIP.has(entry.name)) walk(join(current, entry.name));
    }
  };
  walk(absolute);
  return found.sort();
}

/**
 * Cargo's legacy `A/B` licence notation means "A or B" and predates SPDX expressions; it is
 * rewritten to `A OR B`. A package without a licence expression (only `license-file`, or nothing)
 * is reported as `UNKNOWN` so the policy refuses it.
 */
export function normaliseCargoLicense(license: string | null): string {
  if (license === null || license.trim() === "") return "UNKNOWN";
  return license
    .split(/\s*\/\s*/)
    .map((part) => part.trim())
    .join(" OR ");
}

/** Parses `cargo metadata --format-version 1` output into package licences. */
export function parseCargoMetadata(json: string): PackageLicense[] {
  const metadata = JSON.parse(json) as CargoMetadata;
  return metadata.packages.map((pkg) => ({
    name: pkg.name,
    version: pkg.version,
    license: normaliseCargoLicense(pkg.license),
  }));
}

/**
 * The cargo binary: `$CARGO`, then rustup's default location (`$CARGO_HOME/bin`, `~/.cargo/bin`),
 * which shells that never sourced `~/.cargo/env` do not have on PATH, then plain `cargo`.
 */
export function cargoBinary(env: NodeJS.ProcessEnv = process.env): string {
  if (env["CARGO"] !== undefined && env["CARGO"] !== "") return env["CARGO"];
  const home = env["CARGO_HOME"] ?? join(homedir(), ".cargo");
  const installed = join(home, "bin", "cargo");
  return existsSync(installed) ? installed : "cargo";
}

/** Resolves every package of the workspace at `path` (relative to `root`). */
export function listCargoLicenses(root: string, path: string): CargoWorkspace {
  const output = execFileSync(
    cargoBinary(),
    ["metadata", "--locked", "--format-version", "1", "--manifest-path", join(root, path, "Cargo.toml")],
    // Run from the repository root so a workspace's rust-toolchain.toml does not select (and
    // install) its pinned toolchain just to read metadata.
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
  );
  return { path, packages: parseCargoMetadata(output) };
}
