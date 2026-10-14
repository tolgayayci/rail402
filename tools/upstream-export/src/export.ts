/**
 * Plans the export of this repository's upto mechanism and settlement contract into an x402
 * checkout, compares the plan with what the checkout holds, and applies it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ENTRY_POINTS,
  IGNORED_DIRECTORIES,
  LOCAL_ONLY,
  MANAGED_DIRECTORIES,
  MECHANISM,
  SCANNED,
  STELLAR_MODULES,
  mapPath,
} from "./layout.ts";
import { exportedNames, transformImports } from "./transform.ts";

/** Formats a TypeScript file the way the x402 checkout's lint rules require. */
export type Formatter = (
  text: string,
  path: string,
) => Promise<{ readonly text: string; readonly problems: readonly string[] }>;

export interface PlannedFile {
  /** Path in this repository. */
  readonly source: string;
  /** Path in the x402 checkout. */
  readonly target: string;
  readonly content: Buffer;
}

export interface Plan {
  readonly files: readonly PlannedFile[];
  /** Files that could not be exported as they are; the export is refused while there are any. */
  readonly problems: readonly string[];
}

export type DriftStatus = "unchanged" | "changed" | "missing" | "extra";

export interface Drift {
  readonly status: DriftStatus;
  /** Path in the x402 checkout. */
  readonly target: string;
  /** Path in this repository (absent for `extra`). */
  readonly source?: string;
}

export interface Comparison {
  readonly files: readonly Drift[];
  /** Missing mechanism wiring: `package.json` exports and tsup entries for `upto/*`. */
  readonly wiring: readonly string[];
}

/** Text that belongs to this repository and must not appear in an exported file. */
const LOCAL_TEXT = /rail402/i;

/**
 * Builds every exported file from the working tree of `root` (tracked and untracked, not
 * ignored) for the checkout at `target`.
 */
export async function planExport(root: string, target: string, format: Formatter): Promise<Plan> {
  const problems: string[] = [];
  const files: PlannedFile[] = [];
  const sources = listRepositoryFiles(root);
  const stellarExports = indexStellarExports(target);
  const packageEntries = indexPackageEntries(root);

  for (const source of sources) {
    const mapped = mapPath(source);
    if (mapped === undefined) {
      if (!LOCAL_ONLY.has(source)) {
        problems.push(`${source}: not mapped to the x402 checkout; add it to the layout or to LOCAL_ONLY`);
      }
      continue;
    }
    const raw = readFileSync(join(root, source));
    if (mapped.kind === "verbatim") {
      files.push({ source, target: mapped.to, content: raw });
      continue;
    }
    const transformed = transformImports(raw.toString("utf8"), source, mapped.to, {
      mapPath: (path) => mapPath(path)?.to,
      packageEntry: (specifier) => packageEntries.get(specifier),
      stellarExport: (name) => stellarExports.get(name),
    });
    if (transformed.problems.length > 0) {
      problems.push(...transformed.problems);
      continue;
    }
    const formatted = await format(transformed.text, mapped.to);
    problems.push(...formatted.problems.map((problem) => `${mapped.to}:${problem}`));
    files.push({ source, target: mapped.to, content: Buffer.from(formatted.text, "utf8") });
  }

  for (const file of files) {
    if (LOCAL_TEXT.test(file.content.toString("utf8"))) {
      problems.push(
        `${file.source}: mentions ${LOCAL_TEXT.source}, which means nothing in the x402 checkout`,
      );
    }
  }
  return { files, problems };
}

/** Compares a plan with the checkout at `target`. */
export function compareExport(plan: Plan, target: string): Comparison {
  const planned = new Set(plan.files.map((file) => file.target));
  const files: Drift[] = plan.files.map((file) => {
    const path = join(target, file.target);
    if (!existsSync(path)) return { status: "missing", target: file.target, source: file.source };
    return {
      status: readFileSync(path).equals(file.content) ? "unchanged" : "changed",
      target: file.target,
      source: file.source,
    };
  });
  for (const directory of MANAGED_DIRECTORIES) {
    for (const path of walk(target, directory)) {
      if (!planned.has(path)) files.push({ status: "extra", target: path });
    }
  }
  return { files: files.sort((a, b) => a.target.localeCompare(b.target)), wiring: checkWiring(target) };
}

/** Writes changed and missing files and removes extra ones. */
export function applyExport(plan: Plan, comparison: Comparison, target: string): void {
  const content = new Map(plan.files.map((file) => [file.target, file.content]));
  for (const drift of comparison.files) {
    const path = join(target, drift.target);
    if (drift.status === "extra") rmSync(path);
    else if (drift.status !== "unchanged") {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content.get(drift.target) ?? Buffer.alloc(0));
    }
  }
}

/** Files of the scanned directories that git would commit: tracked, or untracked and not ignored. */
function listRepositoryFiles(root: string): string[] {
  const output = execFileSync(
    "git",
    ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...SCANNED],
    { encoding: "utf8" },
  );
  return [...new Set(output.split("\0").filter((path) => path !== ""))]
    .filter((path) => existsSync(join(root, path)))
    .sort();
}

/** Which mechanism module exports each name that `@x402/stellar` offers. */
function indexStellarExports(target: string): Map<string, string> {
  const exports = new Map<string, string>();
  for (const module of STELLAR_MODULES) {
    const path = join(target, module);
    if (!existsSync(path)) {
      throw new Error(`${path} does not exist: --target must be an x402-foundation/x402 checkout`);
    }
    for (const name of exportedNames(readFileSync(path, "utf8"))) {
      if (!exports.has(name)) exports.set(name, module);
    }
  }
  return exports;
}

/** Source entry points of the workspace packages this repository's exported files import. */
function indexPackageEntries(root: string): Map<string, string> {
  const manifest = JSON.parse(readFileSync(join(root, "packages/upto/package.json"), "utf8")) as {
    name: string;
    exports: Record<string, Record<string, string>>;
  };
  const entries = new Map<string, string>();
  for (const [subpath, conditions] of Object.entries(manifest.exports)) {
    const source = conditions["@rail402/source"];
    if (source === undefined) continue;
    entries.set(
      subpath === "." ? manifest.name : `${manifest.name}/${subpath.slice(2)}`,
      join("packages/upto", source).replaceAll("\\", "/"),
    );
  }
  return entries;
}

/** The files under `directory` of `root`, relative to `root`, skipping build output. */
function walk(root: string, directory: string): string[] {
  const absolute = join(root, directory);
  if (!existsSync(absolute)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (IGNORED_DIRECTORIES.has(entry.name)) continue;
    const path = `${directory}${entry.name}`;
    if (entry.isDirectory()) files.push(...walk(root, `${path}/`));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

/** The mechanism must publish `./upto/{client,server,facilitator}` and build each entry. */
function checkWiring(target: string): string[] {
  const findings: string[] = [];
  const manifestPath = join(target, MECHANISM, "package.json");
  const tsupPath = join(target, MECHANISM, "tsup.config.ts");
  const manifest = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, "utf8")) as { exports?: Record<string, unknown> })
    : {};
  const tsup = existsSync(tsupPath) ? readFileSync(tsupPath, "utf8") : "";
  for (const entry of ENTRY_POINTS) {
    if (manifest.exports?.[`./${entry}`] === undefined) {
      findings.push(`${MECHANISM}/package.json: no "./${entry}" export`);
    }
    if (!tsup.includes(`"${entry}/index": "src/${entry}/index.ts"`)) {
      findings.push(`${MECHANISM}/tsup.config.ts: no "${entry}/index" entry`);
    }
  }
  return findings;
}
