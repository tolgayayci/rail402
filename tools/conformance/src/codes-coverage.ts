/**
 * Compares the codes the test suites exercised (recorded by `pnpm test` and `pnpm test:integration` in
 * `.work/codes-coverage.json`) with every registered code.
 *
 *   pnpm codes:coverage [--json] [--write]
 *
 * Exits 1 when the integration suites saw a code that is not registered. Unit suites may define
 * throwaway code sets to test the error helpers themselves, so their unregistered codes are listed only.
 *
 * `--write` records the result in tools/conformance/codes-coverage.json, which the error-code page
 * renders: the registry at that moment, the codes each suite raised while it ran, the codes the recorded
 * conformance runs met, and the codes a test names in quotes (refusals built as plain values, such as
 * a seller helper's findings or an upto rule's rejection, never pass the recorder). It needs a full run
 * of both suites. Every registered code the record does not
 * show exercised must have a justification in codes-unexercised.ts (checked by the unit tests).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { allCodes } from "@rail402.dev/service/codes";
import { allClientCodes } from "./client-codes.ts";
import { REPO_ROOT } from "./evidence.ts";
import { loadEvidenceSet, type EvidenceSet } from "./evidence-set.ts";
import { COVERAGE_FILE } from "./recorder/global-setup.ts";

export interface CodesCoverage {
  readonly registered: number;
  readonly exercised: number;
  readonly projects: Readonly<Record<string, readonly string[]>>;
  readonly unexercised: readonly string[];
  /** Unregistered codes seen, per project. */
  readonly unregistered: Readonly<Record<string, readonly string[]>>;
}

/** The service's codes and the client packages' codes: both are registered and documented. */
const isRegistered = (code: string) => Object.hasOwn(allCodes, code) || Object.hasOwn(allClientCodes, code);

export function codesCoverage(projects: Readonly<Record<string, readonly string[]>>): CodesCoverage {
  const registered = [...Object.keys(allCodes), ...Object.keys(allClientCodes)].sort();
  const seen = new Set(Object.values(projects).flat());
  return {
    registered: registered.length,
    exercised: registered.filter((code) => seen.has(code)).length,
    projects,
    unexercised: registered.filter((code) => !seen.has(code)),
    unregistered: Object.fromEntries(
      Object.entries(projects).map(([name, codes]) => [name, codes.filter((code) => !isRegistered(code))]),
    ),
  };
}

/** The committed coverage record, rendered on the error-code page. */
export const COVERAGE_RECORD = join(REPO_ROOT, "tools/conformance/codes-coverage.json");

const codeList = z.array(z.string().regex(/^[a-z0-9_]+$/));
export const coverageRecordSchema = z.strictObject({
  recordedAt: z.iso.datetime(),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  /** Every registered code when the record was made. */
  registered: codeList,
  exercised: z.strictObject({
    unit: codeList,
    integration: codeList,
    evidence: codeList,
    /** Codes a test file names as a string literal. */
    named: codeList,
  }),
});
export type CoverageRecord = z.infer<typeof coverageRecordSchema>;

export function readCoverageRecord(path = COVERAGE_RECORD): CoverageRecord | undefined {
  return existsSync(path) ? coverageRecordSchema.parse(JSON.parse(readFileSync(path, "utf8"))) : undefined;
}

/** Every code the recorded conformance runs report in a rejection. */
export function evidenceCodes(set: EvidenceSet): string[] {
  const codes = new Set<string>();
  for (const file of set.files) {
    if (file.format !== "current") continue;
    for (const entry of file.evidence.cases) {
      for (const rejection of entry.rejections ?? []) codes.add(rejection.code);
    }
  }
  return [...codes].filter(isRegistered).sort();
}

/** The registered codes a record shows exercised by a suite or a recorded run. */
export function exercisedIn(record: CoverageRecord): Set<string> {
  const { unit, integration, evidence, named } = record.exercised;
  return new Set(
    [...unit, ...integration, ...evidence, ...named].filter((code) => record.registered.includes(code)),
  );
}

/**
 * What is wrong between a record and the justifications: a code registered when the record was made
 * that nothing exercised and nothing justifies, a justification for a code that was exercised, and a
 * justification for a code that is not registered.
 */
export function coverageProblems(
  record: CoverageRecord,
  justifications: Readonly<Record<string, string>>,
  registered: readonly string[] = allRegistered(),
): string[] {
  const exercised = exercisedIn(record);
  const problems: string[] = [];
  for (const code of record.registered) {
    if (!exercised.has(code) && justifications[code] === undefined) {
      problems.push(`${code}: not exercised and not justified in codes-unexercised.ts`);
    }
  }
  for (const [code, text] of Object.entries(justifications)) {
    if (!registered.includes(code)) problems.push(`${code}: justified but not registered`);
    else if (exercised.has(code)) problems.push(`${code}: justified but exercised; remove its justification`);
    if (text.trim() === "") problems.push(`${code}: empty justification`);
  }
  return problems;
}

/** The registered codes a test file names as a quoted string: `"code"`. */
export function namedInTests(registered: readonly string[], root = REPO_ROOT): string[] {
  const text = testFiles(root)
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  return registered.filter((code) => text.includes(`"${code}"`));
}

function testFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string, inTests: boolean) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path, inTests || entry.name === "test");
      else if (inTests && entry.name.endsWith(".ts")) files.push(path);
    }
  };
  for (const top of ["apps", "packages", "tools"]) walk(join(root, top), false);
  walk(join(root, "test"), true);
  return files.sort();
}

export function allRegistered(): string[] {
  return [...Object.keys(allCodes), ...Object.keys(allClientCodes)].sort();
}

function gitHead(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

function main(): void {
  const { values } = parseArgs({
    options: { json: { type: "boolean", default: false }, write: { type: "boolean", default: false } },
  });
  if (!existsSync(COVERAGE_FILE)) {
    console.error("no .work/codes-coverage.json yet: run pnpm test and pnpm test:integration first");
    process.exit(1);
  }
  const { projects } = JSON.parse(readFileSync(COVERAGE_FILE, "utf8")) as {
    projects: Record<string, string[]>;
  };
  const coverage = codesCoverage(projects);
  if (values.json) {
    console.log(JSON.stringify(coverage, null, 2));
  } else {
    const runs = Object.entries(projects)
      .map(([name, codes]) => `${name} ${codes.length}`)
      .join(", ");
    console.log(`${coverage.exercised} of ${coverage.registered} registered codes exercised (${runs})`);
    if (coverage.unexercised.length > 0)
      console.log(`not exercised:\n  ${coverage.unexercised.join("\n  ")}`);
  }
  for (const [name, codes] of Object.entries(coverage.unregistered)) {
    if (codes.length > 0) console.error(`${name}: codes seen but not registered: ${codes.join(", ")}`);
  }
  if ((coverage.unregistered["integration"] ?? []).length > 0) process.exit(1);
  if (values.write) {
    const unit = projects["unit"] ?? [];
    const integration = projects["integration"] ?? [];
    if (unit.length === 0 || integration.length === 0) {
      console.error("--write needs a full run of both suites: pnpm test && pnpm test:integration");
      process.exit(1);
    }
    const record: CoverageRecord = {
      recordedAt: new Date().toISOString(),
      commit: gitHead(),
      registered: allRegistered(),
      exercised: {
        unit: unit.filter(isRegistered),
        integration: integration.filter(isRegistered),
        evidence: evidenceCodes(loadEvidenceSet()),
        named: namedInTests(allRegistered()),
      },
    };
    writeFileSync(COVERAGE_RECORD, `${JSON.stringify(coverageRecordSchema.parse(record), null, 2)}\n`);
    console.log(`recorded in tools/conformance/codes-coverage.json`);
  }
}

if (import.meta.main) main();
