#!/usr/bin/env node
/**
 * Generate THIRD_PARTY_NOTICES.md — the full transitive inventory required by the license policy
 * ("Generate THIRD_PARTY_NOTICES at build") and by Apache-2.0 attribution practice.
 *
 * Reuses the same `pnpm licenses list --json` source as the gate, so the notices file and the
 * gate verdicts can never disagree about what is actually installed.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "THIRD_PARTY_NOTICES.md");

let raw = "";
try {
  raw = execFileSync("pnpm", ["licenses", "list", "--json", "--recursive"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch {
  raw = "";
}

const parsed = raw.trim() ? JSON.parse(raw) : {};

/**
 * Collapse a platform-specific prebuilt binary to its package family.
 *
 * `pnpm licenses list` reports what is *installed*, and optional binary dependencies differ by
 * platform: a macOS install has `@esbuild/darwin-arm64`, a Linux CI runner has `@esbuild/linux-x64`.
 * Attribution that changed with the builder's laptop would make `--check` unsatisfiable on both at
 * once — which is exactly how this was caught, with the file green locally and red on CI.
 *
 * Every variant of these families ships under the same license from the same project, so recording
 * the family once is both accurate attribution and a pure function of the dependency tree, which is
 * what the tracked file claims to be.
 */
const PLATFORM_VARIANT =
  /^(.*?)-?(?:aix|android|darwin|freebsd|linux|openharmony|sunos|win32|windows)(?:-(?:arm64|arm|ia32|x64|x86|32|64|loong64|mips64el|ppc64|riscv64|s390x|wasm32))?(?:-(?:gnu|gnueabihf|eabihf|musl|msvc))?$/;

const familyName = name => {
  const at = name.lastIndexOf("/");
  const scope = at === -1 ? "" : name.slice(0, at + 1);
  const leaf = at === -1 ? name : name.slice(at + 1);
  const m = PLATFORM_VARIANT.exec(leaf);
  if (!m) return name;
  return `${scope}${m[1] ? `${m[1]}-` : ""}*`;
};

/**
 * Optional dependencies scoped to one OS, listed unconditionally.
 *
 * `pnpm licenses list` reports what is installed, and an `os`-restricted optional dependency is
 * simply absent everywhere else — `fsevents` installs on macOS and not on Linux, so the two hosts
 * produce inventories that differ by a whole package rather than by a platform-suffixed variant that
 * `familyName()` could collapse. Attribution is a property of the dependency tree, which contains
 * these packages on every host, so they are emitted from this table and filtered out of the scan to
 * avoid double-counting. Keep in step with `pnpm-lock.yaml`.
 */
const PLATFORM_ONLY = [
  { name: "fsevents", version: "2.3.3", license: "MIT", homepage: "https://github.com/fsevents/fsevents" },
];
const PLATFORM_ONLY_NAMES = new Set(PLATFORM_ONLY.map(p => p.name));

/** @type {Map<string, {name:string, version:string, homepage:string}[]>} */
const byLicense = new Map();
const add = (license, entry) => {
  const key = (license ?? entry.license ?? "UNKNOWN").trim() || "UNKNOWN";
  const versions = entry.versions ?? (entry.version ? [entry.version] : ["*"]);
  const list = byLicense.get(key) ?? [];
  const name = familyName(entry.name ?? "<unnamed>");
  // A collapsed family is recorded once, without a version: which prebuilt variants an install
  // pulls in is a property of the machine, not of the dependency tree.
  const collapsed = name !== (entry.name ?? "<unnamed>");
  for (const version of collapsed ? ["*"] : versions) {
    list.push({
      name,
      version: String(version),
      homepage: entry.homepage ?? entry.repository ?? "",
    });
  }
  byLicense.set(key, list);
};

// Drop anything whose presence depends on the host OS from the scan...
const hostIndependent = entry => !PLATFORM_ONLY_NAMES.has(entry.name);

if (Array.isArray(parsed)) {
  for (const entry of parsed.filter(hostIndependent)) add(entry.license, entry);
} else {
  for (const [license, entries] of Object.entries(parsed)) {
    for (const entry of (entries ?? []).filter(hostIndependent)) add(license, entry);
  }
}

// ...and add it back from the table, so every host renders the same inventory.
for (const p of PLATFORM_ONLY) add(p.license, p);

// Deduplicate BEFORE counting. A collapsed platform family contributes one entry per variant the
// local machine happened to install, so a total taken over the raw lists still tracks the builder's
// platform even though the rendered rows do not — which is how this file stayed green on macOS and
// red on a Linux runner after the families were already collapsed. The count must be a property of
// the deduplicated set, exactly like the rows it summarises.
const deduped = [...byLicense.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([license, pkgs]) => {
    const seen = new Set();
    const unique = pkgs
      .filter(p => {
        const k = `${p.name}@${p.version}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return { license, unique };
  });

const total = deduped.reduce((n, s) => n + s.unique.length, 0);

const sections = deduped
  .map(({ license, unique }) => {
    const rows = unique
      .map(p => {
        // A collapsed platform family carries no meaningful single version — see familyName().
        const label = p.version === "*" ? p.name : `${p.name}@${p.version}`;
        return `- \`${label}\`${p.homepage ? ` — ${p.homepage}` : ""}`;
      })
      .join("\n");
    return `## ${license}\n\n${unique.length} package-version(s).\n\n${rows}\n`;
  })
  .join("\n");

const contents = `# Third-Party Notices

<!-- GENERATED by scripts/generate-notices.mjs — do not edit by hand. Run \`pnpm notices\`. -->

This project is licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.

The following third-party packages are present in the full transitive dependency tree.
Every entry has been checked against \`license-policy.json\` by \`pnpm license:gate\`; per-package
verdicts are recorded in \`docs/licenses.md\`.

**Total:** ${total} package-version(s) across ${byLicense.size} distinct license expression(s).

<!-- No generation timestamp on purpose: this file is a pure function of the dependency tree, which
     is what lets \`pnpm notices:check\` verify it is current and keeps it out of every unrelated
     diff. Git history already records when it changed. -->

${sections}`;

if (process.argv.includes("--check")) {
  // Attribution has to travel with the source (Apache-2.0). The file is tracked
  // rather than gitignored, so it can go stale the moment a dependency changes — this is what
  // notices a stale one before a release does.
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (current !== contents) {
    console.error(
      "generate-notices: THIRD_PARTY_NOTICES.md is out of date. Run `pnpm notices` and commit the result.",
    );
    process.exit(1);
  }
  console.log(`generate-notices: THIRD_PARTY_NOTICES.md is current (${total} package-versions)`);
} else {
  writeFileSync(OUT, contents);
  console.log(`generate-notices: wrote THIRD_PARTY_NOTICES.md (${total} package-versions)`);
}
