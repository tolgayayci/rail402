/**
 * What a publishable Rail402 tarball must look like, as pure checks over its manifest and file list,
 * plus the checks over a clean install made from the tarballs alone. Every function returns a list
 * of problems; an empty list passes.
 */

/** The fields of a packed package.json these checks read. */
export interface PackedManifest {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly license?: unknown;
  readonly private?: unknown;
  readonly files?: unknown;
  readonly main?: unknown;
  readonly types?: unknown;
  readonly bin?: unknown;
  readonly exports?: unknown;
  readonly dependencies?: unknown;
  readonly devDependencies?: unknown;
  readonly peerDependencies?: unknown;
  readonly optionalDependencies?: unknown;
  readonly peerDependenciesMeta?: unknown;
}

export const SCOPE = "@rail402.dev/";
export const LICENSE = "Apache-2.0";

/** Files every tarball carries at its root besides the directories its `files` field names. */
const ROOT_FILES = new Set(["package.json", "README.md", "LICENSE"]);
/** Specifiers that only mean something inside the workspace. */
const LOCAL_SPEC = /^(?:workspace|catalog|link|file|portal):/;
/** Export conditions resolved inside this repository only; they point at sources that are not shipped. */
const SOURCE_CONDITION = "@rail402/source";
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The manifest as published: the expected name and lockstep version, the licence, no workspace-only
 * specifiers, Rail402 dependencies pinned to the same version, every peer optional, and no export
 * condition that only resolves inside this repository.
 */
export function manifestProblems(
  manifest: PackedManifest,
  expected: { name: string; version: string },
): string[] {
  const problems: string[] = [];
  if (manifest.name !== expected.name)
    problems.push(`name is ${String(manifest.name)}, not ${expected.name}`);
  if (manifest.version !== expected.version) {
    problems.push(`version is ${String(manifest.version)}, not ${expected.version}`);
  }
  if (manifest.license !== LICENSE) problems.push(`license is ${String(manifest.license)}, not ${LICENSE}`);
  if (manifest.private === true) problems.push("the package is private");
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, spec] of Object.entries(record(manifest[field]))) {
      if (typeof spec !== "string") {
        problems.push(`${field}.${name} is not a version string`);
        continue;
      }
      if (LOCAL_SPEC.test(spec)) problems.push(`${field}.${name} keeps the workspace specifier "${spec}"`);
      if (field !== "devDependencies" && name.startsWith(SCOPE) && spec !== expected.version) {
        problems.push(`${field}.${name} is "${spec}", not the lockstep version ${expected.version}`);
      }
    }
  }
  if (JSON.stringify(manifest.exports ?? {}).includes(`"${SOURCE_CONDITION}"`)) {
    problems.push(
      `exports keeps the repository-only "${SOURCE_CONDITION}" condition, which points at unpublished sources`,
    );
  }
  const meta = record(manifest.peerDependenciesMeta);
  for (const name of Object.keys(record(manifest.peerDependencies))) {
    if (record(meta[name])["optional"] !== true) {
      problems.push(`peerDependencies.${name} is not optional: every install would demand it`);
    }
  }
  return problems;
}

/** Directory prefixes the `files` field allows, besides the root files. */
function allowedDirectories(manifest: PackedManifest): string[] {
  return (Array.isArray(manifest.files) ? manifest.files : [])
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.replace(/^\.\//, "").replace(/\/+$/, ""));
}

/**
 * The tarball's files: package.json, README.md and LICENSE at the root, everything else inside a
 * directory the `files` field names; no sources, tests, environment files or source maps outside
 * `dist`.
 */
export function fileProblems(files: readonly string[], manifest: PackedManifest): string[] {
  const problems: string[] = [];
  const directories = allowedDirectories(manifest);
  const present = new Set(files);
  for (const required of ROOT_FILES) {
    if (!present.has(required)) problems.push(`${required} is missing`);
  }
  for (const file of files) {
    if (ROOT_FILES.has(file)) continue;
    const base = file.split("/").pop() ?? file;
    if (!directories.some((directory) => file.startsWith(`${directory}/`))) {
      problems.push(`${file} is outside the published directories (${directories.join(", ")})`);
    }
    if (/^(?:src|test|tests)\//.test(file)) problems.push(`${file}: sources and tests are not published`);
    if (base.startsWith(".env")) problems.push(`${file}: environment files are never published`);
    if (/\.(?:test|spec)\.[cm]?[jt]s$/.test(base)) problems.push(`${file}: a test file is published`);
    if (base.endsWith(".map") && !file.startsWith("dist/"))
      problems.push(`${file}: a source map outside dist`);
  }
  return problems;
}

/**
 * The `exports` a package publishes: its repository `exports` without the source condition. A
 * package's `publishConfig.exports` must equal this, so the published manifest never names sources.
 */
export function publishedExports(exports: unknown): unknown {
  if (typeof exports !== "object" || exports === null) return exports;
  if (Array.isArray(exports)) return exports.map(publishedExports);
  return Object.fromEntries(
    Object.entries(exports)
      .filter(([key]) => key !== SOURCE_CONDITION)
      .map(([key, value]) => [key, publishedExports(value)]),
  );
}

/** Every file target named by `exports` (except the repository-only source condition). */
export function exportTargets(exports: unknown): { subpath: string; condition: string; target: string }[] {
  const targets: { subpath: string; condition: string; target: string }[] = [];
  const walk = (subpath: string, value: unknown, condition: string) => {
    if (typeof value === "string") {
      if (condition !== SOURCE_CONDITION) targets.push({ subpath, condition, target: value });
      return;
    }
    for (const [key, inner] of Object.entries(record(value))) walk(subpath, inner, key);
  };
  if (typeof exports === "string") return [{ subpath: ".", condition: "default", target: exports }];
  for (const [subpath, value] of Object.entries(record(exports))) walk(subpath, value, "default");
  return targets;
}

/** Export subpaths that load a module, in order ("." first). */
export function importableSubpaths(manifest: PackedManifest): string[] {
  const subpaths = [...new Set(exportTargets(manifest.exports).map((entry) => entry.subpath))];
  return subpaths.filter((subpath) => !subpath.endsWith(".json") && !subpath.includes("*"));
}

/** The installed bins: name → packed path. */
export function binsOf(manifest: PackedManifest): Record<string, string> {
  const bin = manifest.bin;
  if (typeof bin === "string" && typeof manifest.name === "string") {
    return { [manifest.name.split("/").pop() ?? manifest.name]: bin };
  }
  return Object.fromEntries(
    Object.entries(record(bin)).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

/**
 * Entry points resolve to shipped files: every export target, `main`, `types`, and each bin, which
 * must also start with a node shebang. `read` returns a shipped file's text, or undefined.
 */
export function entryPointProblems(
  manifest: PackedManifest,
  files: readonly string[],
  read: (file: string) => string | undefined,
): string[] {
  const problems: string[] = [];
  const present = new Set(files);
  const shipped = (target: string) => present.has(target.replace(/^\.\//, ""));
  const targets = exportTargets(manifest.exports);
  if (targets.length === 0) problems.push("exports names no entry point");
  for (const { subpath, condition, target } of targets) {
    if (!shipped(target))
      problems.push(`exports["${subpath}"].${condition} → ${target} is not in the tarball`);
  }
  for (const field of ["main", "types"] as const) {
    const target = manifest[field];
    if (typeof target === "string" && !shipped(target))
      problems.push(`${field} → ${target} is not in the tarball`);
  }
  for (const [name, target] of Object.entries(binsOf(manifest))) {
    if (!shipped(target)) {
      problems.push(`bin ${name} → ${target} is not in the tarball`);
      continue;
    }
    if (!(read(target.replace(/^\.\//, "")) ?? "").startsWith("#!/usr/bin/env node\n")) {
      problems.push(`bin ${name} → ${target} does not start with "#!/usr/bin/env node"`);
    }
  }
  return problems;
}

/** The parts of an npm v3 package-lock.json these checks read. */
export interface PackageLock {
  readonly lockfileVersion?: number;
  readonly packages?: Record<
    string,
    {
      readonly version?: string;
      readonly resolved?: string;
      readonly dev?: boolean;
      readonly license?: unknown;
    }
  >;
}

/** The package name of a lockfile path such as `node_modules/a/node_modules/@b/c`. */
export function lockName(path: string): string {
  const at = path.lastIndexOf("node_modules/");
  return at < 0 ? path : path.slice(at + "node_modules/".length);
}

/**
 * The clean install: every Rail402 package came from a local tarball (never the registry, where
 * older, deprecated versions of some names exist), at the lockstep version, once.
 */
export function lockProblems(
  lock: PackageLock,
  expected: { names: readonly string[]; version: string },
): string[] {
  const problems: string[] = [];
  const seen = new Map<string, number>();
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (path === "") continue;
    const name = lockName(path);
    if (!name.startsWith(SCOPE)) continue;
    seen.set(name, (seen.get(name) ?? 0) + 1);
    if (!(entry.resolved ?? "").startsWith("file:")) {
      problems.push(`${path} resolved from ${entry.resolved ?? "the registry"}, not a local tarball`);
    }
    if (entry.version !== expected.version) {
      problems.push(`${path} is ${entry.version ?? "unversioned"}, not ${expected.version}`);
    }
  }
  for (const name of expected.names) {
    if (!seen.has(name)) problems.push(`${name} is not installed`);
  }
  for (const [name, count] of seen) {
    if (count > 1) problems.push(`${name} is installed ${String(count)} times`);
    if (!expected.names.includes(name)) problems.push(`${name} is installed but was not packed`);
  }
  return problems;
}

/** A package.json licence field as one SPDX expression (`license`, a legacy object, or `licenses`). */
export function licenseOf(manifest: { license?: unknown; licenses?: unknown }): string {
  const { license, licenses } = manifest;
  if (typeof license === "string" && license.trim() !== "") return license.trim();
  const type = record(license)["type"];
  if (typeof type === "string") return type;
  if (Array.isArray(licenses)) {
    const types = licenses
      .map((entry) => record(entry)["type"])
      .filter((t): t is string => typeof t === "string");
    if (types.length > 0) return types.length === 1 ? (types[0] ?? "") : `(${types.join(" OR ")})`;
  }
  return "UNKNOWN";
}
