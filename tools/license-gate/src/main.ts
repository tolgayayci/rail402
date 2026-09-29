/**
 * Runs the licence gate over the installed dependency tree. Exits non-zero on any violation.
 *
 *   pnpm license:gate                   check production and development closures
 *   pnpm license:gate --report          also print every licence with its package count
 *   pnpm license:report                 write docs/dependency-licenses.md
 *   pnpm license:gate --check-report    also fail when docs/dependency-licenses.md is stale
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { judge, type PackageLicense } from "./policy.ts";
import { renderReport } from "./report.ts";

const REPORT = new URL("../../../docs/dependency-licenses.md", import.meta.url);

interface PnpmLicenseEntry {
  readonly name: string;
  readonly versions: readonly string[];
  readonly license: string;
}

function listLicenses(production: boolean, filter?: string): PackageLicense[] {
  const args = [
    ...(filter === undefined ? [] : ["--filter", filter]),
    "licenses",
    "list",
    "--json",
    ...(production ? ["--prod"] : []),
  ];
  const output = execFileSync("pnpm", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  // pnpm prints a plain message instead of JSON when the closure is empty.
  if (!output.trimStart().startsWith("{")) return [];
  const grouped = JSON.parse(output) as Record<string, readonly PnpmLicenseEntry[]>;
  return Object.values(grouped).flatMap((entries) =>
    entries.flatMap((entry) =>
      entry.versions.map((version) => ({ name: entry.name, version, license: entry.license })),
    ),
  );
}

const production = listLicenses(true);
const everything = listLicenses(false);
const productionKeys = new Set(production.map((p) => `${p.name}@${p.version}`));

const failures: string[] = [];
for (const pkg of production) {
  const verdict = judge(pkg, "production");
  if (!verdict.ok)
    failures.push(`[production] ${pkg.name}@${pkg.version} (${pkg.license}): ${verdict.problem}`);
}
for (const pkg of everything) {
  if (productionKeys.has(`${pkg.name}@${pkg.version}`)) continue;
  const verdict = judge(pkg, "development");
  if (!verdict.ok)
    failures.push(`[development] ${pkg.name}@${pkg.version} (${pkg.license}): ${verdict.problem}`);
}

if (process.argv.includes("--report")) {
  const counts = new Map<string, number>();
  for (const pkg of everything) counts.set(pkg.license, (counts.get(pkg.license) ?? 0) + 1);
  for (const [license, count] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`${String(count).padStart(5)}  ${license}`);
  }
}

if (process.argv.includes("--write-report") || process.argv.includes("--check-report")) {
  const path = fileURLToPath(REPORT);
  const report = await format(
    renderReport({ service: listLicenses(true, "@rail402.dev/service"), production, everything }),
    { ...(await resolveConfig(path)), filepath: path },
  );
  if (process.argv.includes("--write-report")) {
    writeFileSync(REPORT, report);
    console.log("licence report written to docs/dependency-licenses.md");
  } else {
    let committed = "";
    try {
      committed = readFileSync(REPORT, "utf8");
    } catch {
      // A missing report is stale.
    }
    if (committed !== report) {
      failures.push("docs/dependency-licenses.md is out of date: run pnpm license:report");
    }
  }
}

if (failures.length > 0) {
  console.error(`licence gate: ${failures.length} violation(s)`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(
  `licence gate: ok (${production.length} production, ${everything.length - production.length} development packages)`,
);
