/**
 * The findings register, `docs/security/findings.json`: every finding of a security or correctness
 * review, with its severity, its status and either the commit and tests that fixed it or the written
 * acceptance of a lower-severity risk. `docs/security/report.mdx` renders from this file, and
 * `test/findings.test.ts` checks it with `findingProblems`.
 *
 *   node tools/conformance/src/findings.ts --release <tag>
 *       exit 1 unless the register may ship with that tag: the tested revision names the tag and no
 *       critical or high finding is open or accepted
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { REPO_ROOT } from "./evidence.ts";
import { parseTestRef, type ThreatRegistry } from "./threats.ts";

export const FINDINGS_FILE = "docs/security/findings.json";

export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export const STATUSES = ["open", "fixed", "accepted", "wont-fix", "duplicate"] as const;
export const COMPONENTS = [
  "facilitator",
  "bazaar",
  "search",
  "sdk",
  "mcp",
  "cli",
  "explorer",
  "contract",
  "operations",
  "docs",
] as const;

export type Severity = (typeof SEVERITIES)[number];

const text = z.string().trim().min(1);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");
const commit = z.string().regex(/^[0-9a-f]{40}$/, "must be a full commit hash");
const testRef = z.string().regex(/^[\w./-]+::.+$/, "must be path::test name");
const reviewId = z.string().regex(/^REV-\d{4}-\d{2}-[a-z0-9-]+$/, "must look like REV-2026-11-internal");

const finding = z.strictObject({
  id: z.string().regex(/^F-\d{4}-\d{3}$/, "must look like F-2026-001"),
  title: text,
  severity: z.enum(SEVERITIES),
  component: z.enum(COMPONENTS),
  review: reviewId,
  status: z.enum(STATUSES),
  /** Ids in docs/security/threats.json. */
  threats: z.array(z.string().regex(/^[A-Z]{1,2}\d{1,2}$/)),
  description: text,
  fix: z.strictObject({ commit: commit.nullable(), tests: z.array(testRef) }).nullable(),
  acceptance: z
    .strictObject({ rationale: text, mitigations: z.array(text).min(1), approvedBy: text, date })
    .nullable(),
  verifiedBy: reviewId.nullable(),
  reportedAt: date,
  resolvedAt: date.nullable(),
});

export const findingsRegisterSchema = z.strictObject({
  $comment: z.string().optional(),
  schemaVersion: z.literal(1),
  testedRevision: z.strictObject({
    tag: text.nullable(),
    commit: commit.nullable(),
    images: z.record(z.string(), z.string().regex(/^sha256:[0-9a-f]{64}$/)),
    npm: z.record(z.string(), text),
    uptoWasm: z.record(
      z.string(),
      z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .nullable(),
    ),
  }),
  reviews: z
    .array(
      z.strictObject({
        id: reviewId,
        kind: z.enum(["internal", "external"]),
        by: text,
        scope: z.array(text).min(1),
        from: date,
        to: date,
        report: z.url().nullable(),
      }),
    )
    .min(1),
  findings: z.array(finding),
});

export type FindingsRegister = z.infer<typeof findingsRegisterSchema>;
export type Finding = FindingsRegister["findings"][number];

export function loadFindings(root = REPO_ROOT): FindingsRegister {
  return findingsRegisterSchema.parse(JSON.parse(readFileSync(join(root, FINDINGS_FILE), "utf8")));
}

/**
 * The words that must not appear in a public register (for example internal tool or vendor names),
 * one per line (`#` starts a comment), from a local file that is never committed: `.forbidden-words`
 * at the repository root, or the file `RAIL402_FORBIDDEN_WORDS_FILE` names. Without the file the
 * check has no words and passes; maintainers keep the file in their own checkout.
 */
export const FORBIDDEN_WORDS_FILE = ".forbidden-words";

export function loadForbiddenWords(
  root = REPO_ROOT,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  const file = env["RAIL402_FORBIDDEN_WORDS_FILE"] ?? join(root, FORBIDDEN_WORDS_FILE);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim().toLowerCase())
    .filter((line) => line !== "");
}

/** The listed words a text contains, as whole words (a hyphen counts as part of a word), ignoring case. */
export function forbiddenWords(value: string, words: readonly string[]): string[] {
  return words.filter((word) =>
    new RegExp(`(?<![\\w-])${word.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")}(?![\\w-])`, "i").test(value),
  );
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

export interface FindingChecks {
  /** Whether a commit is on main; undefined when it cannot be decided (a shallow clone). */
  readonly commitOnMain?: (commit: string) => boolean | undefined;
  readonly root?: string;
  /** The words refused in any text; `loadForbiddenWords(root)` by default. */
  readonly forbiddenWords?: readonly string[];
}

/** Every rule the register breaks, as readable problems. */
export function findingProblems(
  register: FindingsRegister,
  threats: ThreatRegistry,
  checks: FindingChecks = {},
): string[] {
  const root = checks.root ?? REPO_ROOT;
  const problems: string[] = [];
  const reviews = new Set(register.reviews.map((review) => review.id));
  const threatIds = new Set(threats.threats.map((entry) => entry.id));
  const read = new Map<string, string | undefined>();
  const source = (path: string) => {
    if (!read.has(path)) {
      const full = join(root, path);
      read.set(path, existsSync(full) ? readFileSync(full, "utf8") : undefined);
    }
    return read.get(path);
  };
  if (new Set(register.reviews.map((review) => review.id)).size !== register.reviews.length) {
    problems.push("duplicate review id");
  }
  for (const review of register.reviews) {
    if (review.to < review.from) problems.push(`${review.id}: ends before it starts`);
  }
  const ids = new Set<string>();
  for (const entry of register.findings) {
    const at = entry.id;
    if (ids.has(at)) problems.push(`${at}: duplicate finding id`);
    ids.add(at);
    if (!reviews.has(entry.review)) problems.push(`${at}: unknown review ${entry.review}`);
    if (entry.verifiedBy !== null && !reviews.has(entry.verifiedBy)) {
      problems.push(`${at}: verified by an unknown review ${entry.verifiedBy}`);
    }
    for (const id of entry.threats) {
      if (!threatIds.has(id)) problems.push(`${at}: unknown threat ${id}`);
    }
    const tests = entry.fix?.tests ?? [];
    if (entry.status === "fixed") {
      if ((entry.fix?.commit ?? null) === null) problems.push(`${at}: fixed without a fix commit`);
      if (entry.acceptance !== null) problems.push(`${at}: fixed findings carry no acceptance`);
    }
    if (entry.status === "accepted" || entry.status === "wont-fix" || entry.status === "duplicate") {
      if (entry.acceptance === null) problems.push(`${at}: ${entry.status} without an acceptance text`);
    }
    if (entry.status === "accepted" && (entry.severity === "critical" || entry.severity === "high")) {
      problems.push(`${at}: a ${entry.severity} finding cannot be accepted`);
    }
    if ((entry.status === "fixed" || entry.status === "accepted") && tests.length === 0) {
      problems.push(`${at}: ${entry.status} without a test`);
    }
    if (entry.status !== "open" && entry.resolvedAt === null) problems.push(`${at}: no resolution date`);
    if (entry.resolvedAt !== null && entry.resolvedAt < entry.reportedAt) {
      problems.push(`${at}: resolved before it was reported`);
    }
    for (const ref of tests) {
      const { path, name } = parseTestRef(ref);
      const file = source(path);
      if (file === undefined) problems.push(`${at}: test cites a missing file ${path}`);
      else if (!file.includes(name)) problems.push(`${at}: ${path} has no test named "${name}"`);
    }
    const fixCommit = entry.fix?.commit;
    if (fixCommit !== undefined && fixCommit !== null && checks.commitOnMain?.(fixCommit) === false) {
      problems.push(`${at}: fix commit ${fixCommit.slice(0, 12)} is not on main`);
    }
  }
  const denied = checks.forbiddenWords ?? loadForbiddenWords(root);
  for (const value of strings(register)) {
    const words = forbiddenWords(value, denied);
    if (words.length > 0) problems.push(`internal wording (${words.join(", ")}): "${value.slice(0, 60)}"`);
  }
  return problems;
}

/** Why the register may not ship with `tag`: release gates on the tested revision and severities. */
export function releaseProblems(register: FindingsRegister, tag: string): string[] {
  const problems: string[] = [];
  if (register.testedRevision.tag !== tag) {
    problems.push(`testedRevision.tag is ${register.testedRevision.tag ?? "unset"}, not ${tag}`);
  }
  for (const entry of register.findings) {
    const blocking = entry.severity === "critical" || entry.severity === "high";
    if (blocking && (entry.status === "open" || entry.status === "accepted")) {
      problems.push(`${entry.id}: ${entry.severity} finding is ${entry.status}`);
    }
  }
  return problems;
}

function main(): void {
  const { values } = parseArgs({ options: { release: { type: "string" } } });
  if (values.release === undefined) {
    console.error("usage: findings.ts --release <tag>");
    process.exit(2);
  }
  const problems = releaseProblems(loadFindings(), values.release);
  for (const problem of problems) console.error(`not releasable: ${problem}`);
  if (problems.length > 0) process.exit(1);
  console.log(`the findings register allows ${values.release}`);
}

if (import.meta.main) main();
