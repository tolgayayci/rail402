/**
 * The evidence format every conformance harness writes, and the rules a file must satisfy before it is
 * written. Public pages are rendered only from files that pass these checks (see report.ts), so a
 * published claim always traces back to a run of committed code on `main`.
 *
 * Writer rules:
 * - the file parses against the schema below;
 * - the working tree is clean (evidence files themselves excepted, so several harnesses can run in a
 *   row) and `harness.commit` is the checked-out commit;
 * - that commit is reachable from `main` (a named branch only with an explicit `--allow-branch`, and the
 *   file then says so; such files are for local rehearsals and are refused by the evidence tests);
 * - `summary` equals the case counts, every case names at least one check, a skipped case says why;
 * - no value looks like a secret (an `S…` seed, or a secret-, seed- or key-named field).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
/** Where evidence lives, relative to the repository root. */
export const EVIDENCE_DIR = "tools/conformance/evidence";
/** The branch evidence must come from. */
export const RELEASE_BRANCH = "main";

export const CHECK_IDS = [
  "canonical-client",
  "payload-transaction",
  "supported",
  "fees-sponsored",
  "scheme-exact",
  "scheme-upto",
  "discovery",
  "mcp",
  "upstream-e2e",
  "expiration",
  "second-asset",
  "concurrency",
  "idempotency",
  "crash-recovery",
  "front-running",
  "rejection-codes",
  "observability",
  "agent-payments",
  "playground",
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

export const EVIDENCE_KINDS = [
  "canonical",
  "live-matrix",
  "concurrency",
  "fault-recovery",
  "upstream-e2e",
  "live-bazaar",
  "live-agent",
  "live-playground",
  "rejection-audit",
  "ops",
  "test-token",
  "upto-contract",
  "benchmark",
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

const HASH = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const PAYER = z.enum(["G", "C"]);
const INTEGER = z.string().regex(/^-?\d+$/, "must be an integer string");
const TIMESTAMP = z.iso.datetime({ offset: true });

const transaction = z.strictObject({
  hash: z.string().regex(HASH, "must be a 64-character hex transaction hash"),
  ledger: z.number().int().positive(),
  scheme: z.string().min(1),
  asset: z.string().min(1),
  decimals: z.number().int().min(0).max(38),
  amount: INTEGER,
  payerType: PAYER,
  feeChargedStroops: INTEGER,
  feeSource: z.string().min(1),
  innerSource: z.string().min(1),
  innerSequence: INTEGER,
  transfers: z.array(z.strictObject({ from: z.string(), to: z.string(), amount: INTEGER })),
  explorer: z.url(),
  /** Canonical and fault-recovery runs only, so the file stands alone after RPC retention. */
  envelopeXdr: z.string().min(1).optional(),
  resultXdr: z.string().min(1).optional(),
});

const rejection = z.strictObject({
  surface: z.enum(["facilitator", "bazaar", "search", "mcp", "http"]),
  operation: z.string().min(1),
  httpStatus: z.number().int().min(100).max(599).optional(),
  code: z.string().regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/, "must be a registered snake_case code"),
  reason: z.string().trim().min(1, "must not be blank"),
});

const evidenceCase = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "must be a lower-case kebab id"),
  title: z.string().trim().min(1),
  checks: z.array(z.enum(CHECK_IDS)).min(1, "must name at least one check"),
  scheme: z.enum(["exact", "upto"]).optional(),
  asset: z.string().min(1).optional(),
  payer: PAYER.optional(),
  payTo: PAYER.optional(),
  status: z.enum(["passed", "failed", "skipped"]),
  skipReason: z.string().trim().min(1).optional(),
  elapsedMs: z.number().min(0),
  rejections: z.array(rejection).optional(),
  transactions: z.array(transaction).optional(),
  /** Metric deltas, proxy transcripts, kill times: anything case-specific. */
  observations: z.record(z.string(), z.unknown()).optional(),
});

export const evidenceSchema = z.strictObject({
  schemaVersion: z.literal(2),
  kind: z.enum(EVIDENCE_KINDS),
  runId: z.string().min(1),
  startedAt: TIMESTAMP,
  finishedAt: TIMESTAMP,
  network: z.enum(["stellar:testnet", "stellar:pubnet"]),
  target: z.strictObject({
    mode: z.enum(["local", "hosted"]),
    facilitatorUrl: z.url(),
    healthVersion: z.string().min(1),
    /** `GET /supported`, verbatim. */
    supported: z.unknown(),
  }),
  harness: z.strictObject({
    commit: z.string().regex(COMMIT, "must be a full 40-character commit hash"),
    dirty: z.literal(false),
    /** Set only for rehearsal runs written from a branch other than main. */
    branch: z.string().min(1).optional(),
  }),
  upstream: z
    .strictObject({
      repository: z.string().min(1),
      ref: z.string().min(1),
      commit: z.string().regex(COMMIT),
      version: z.string().min(1),
      preMerge: z.boolean(),
    })
    .optional(),
  packages: z.record(z.string(), z.string()),
  command: z.string().min(1),
  /** Non-secret configuration only: channels, fee ceilings, timing, assets. */
  config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  /** Public keys and contract ids only. */
  accounts: z.record(z.string(), z.string()),
  summary: z.strictObject({
    total: z.number().int().min(0),
    passed: z.number().int().min(0),
    failed: z.number().int().min(0),
    skipped: z.number().int().min(0),
  }),
  cases: z.array(evidenceCase),
});

export type Evidence = z.infer<typeof evidenceSchema>;
export type EvidenceCase = Evidence["cases"][number];
export type EvidenceTransaction = NonNullable<EvidenceCase["transactions"]>[number];
export type EvidenceRejection = NonNullable<EvidenceCase["rejections"]>[number];

/** Every rule a v2 evidence document must satisfy, apart from its git provenance. */
export function checkEvidence(value: unknown): { evidence?: Evidence; problems: string[] } {
  const parsed = evidenceSchema.safeParse(value);
  if (!parsed.success) {
    return {
      problems: parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    };
  }
  const evidence = parsed.data;
  const problems: string[] = [];
  const count = (status: EvidenceCase["status"]) => evidence.cases.filter((c) => c.status === status).length;
  const expected = {
    total: evidence.cases.length,
    passed: count("passed"),
    failed: count("failed"),
    skipped: count("skipped"),
  };
  for (const key of ["total", "passed", "failed", "skipped"] as const) {
    if (evidence.summary[key] !== expected[key]) {
      problems.push(`summary.${key} is ${evidence.summary[key]} but the cases give ${expected[key]}`);
    }
  }
  const ids = new Set<string>();
  for (const [index, entry] of evidence.cases.entries()) {
    if (ids.has(entry.id)) problems.push(`cases.${index}: duplicate case id "${entry.id}"`);
    ids.add(entry.id);
    if (entry.status === "skipped" && entry.skipReason === undefined) {
      problems.push(`cases.${index} (${entry.id}): a skipped case needs a skipReason`);
    }
    if (entry.status !== "skipped" && entry.skipReason !== undefined) {
      problems.push(`cases.${index} (${entry.id}): skipReason is only allowed on skipped cases`);
    }
  }
  if (Date.parse(evidence.finishedAt) < Date.parse(evidence.startedAt)) {
    problems.push("finishedAt is earlier than startedAt");
  }
  problems.push(...findSecrets(value), ...findLocalPaths(value));
  return problems.length === 0 ? { evidence, problems } : { problems };
}

/**
 * Paths of strings that name a directory of the machine that recorded the run: the checkout, the home
 * directory or the temporary directory. Evidence is published, and such a path says nothing to readers.
 */
export function findLocalPaths(
  value: unknown,
  roots: readonly string[] = [REPO_ROOT.replace(/\/+$/, ""), homedir(), tmpdir()],
  path = "",
): string[] {
  const local = roots.filter((root) => root.length > 1);
  if (typeof value === "string") {
    const root = local.find((candidate) => value.includes(`${candidate}/`) || value.endsWith(candidate));
    return root === undefined ? [] : [`${path || "(root)"}: names a local path (${root})`];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findLocalPaths(item, local, `${path}${path ? "." : ""}${index}`));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) =>
      findLocalPaths(item, local, `${path}${path ? "." : ""}${key}`),
    );
  }
  return [];
}

const SECRET_KEY = /secret|seed|private.?key|mnemonic|password|passphrase/i;
const SEED_CANDIDATE = /S[A-Z2-7]{55}/g;

/**
 * Paths of values that look like secrets: a valid Stellar secret seed anywhere in a string, or a
 * string under a field named like a secret. Evidence is public, so these are refused outright.
 */
export function findSecrets(value: unknown, path = ""): string[] {
  const found: string[] = [];
  if (typeof value === "string") {
    for (const candidate of value.match(SEED_CANDIDATE) ?? []) {
      if (StrKey.isValidEd25519SecretSeed(candidate)) {
        found.push(`${path || "(root)"}: contains a Stellar secret seed`);
        break;
      }
    }
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => found.push(...findSecrets(item, `${path}${path ? "." : ""}${index}`)));
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      const at = `${path}${path ? "." : ""}${key}`;
      if (SECRET_KEY.test(key) && typeof item === "string" && item !== "") {
        found.push(`${at}: a field named like a secret must not carry a value`);
      }
      found.push(...findSecrets(item, at));
    }
  }
  return found;
}

// --- git provenance ------------------------------------------------------------------------------

export interface ProvenanceOptions {
  /** Repository root; defaults to this checkout. */
  readonly root?: string;
  /**
   * Also accept a commit reachable only from this branch. For local rehearsals: the evidence records
   * the branch, and the evidence tests refuse committed files that carry one.
   */
  readonly allowBranch?: string | undefined;
}

export interface Provenance {
  readonly commit: string;
  readonly dirty: false;
  readonly branch?: string;
}

export class EvidenceError extends Error {
  override readonly name = "EvidenceError";
}

/**
 * The harness commit for an evidence run, after checking that the tree is clean and the commit is on
 * `main` (or on `allowBranch`). Harnesses call it before a run, so a run that could not be recorded
 * never spends testnet funds, and again when writing.
 */
export function harnessProvenance(options: ProvenanceOptions = {}): Provenance {
  const root = options.root ?? REPO_ROOT;
  const git = gitRunner(root);
  const commit = git("rev-parse", "HEAD");
  const changes = changedPaths(root).filter((path) => !path.startsWith(`${EVIDENCE_DIR}/`));
  if (changes.length > 0) {
    throw new EvidenceError(
      `evidence must be recorded from a clean working tree; commit or stash: ${changes.slice(0, 5).join(", ")}`,
    );
  }
  if (git("rev-parse", "--is-shallow-repository") === "true") {
    throw new EvidenceError("evidence cannot be recorded from a shallow clone: fetch the full history first");
  }
  const onMain = releaseRefs(git).some((ref) => isAncestor(git, commit, ref));
  if (onMain) return { commit, dirty: false };
  const branch = options.allowBranch;
  if (branch !== undefined && isAncestor(git, commit, branch)) return { commit, dirty: false, branch };
  throw new EvidenceError(
    `commit ${commit.slice(0, 12)} is not reachable from ${RELEASE_BRANCH}; record evidence from ${RELEASE_BRANCH}` +
      (branch === undefined ? "" : ` or ${branch}`),
  );
}

/**
 * Checks, just before writing, that the run still describes the checked-out tree: the same commit, and
 * nothing edited while it ran.
 */
export function recheckProvenance(started: Provenance, options: ProvenanceOptions = {}): void {
  const now = harnessProvenance(options);
  if (now.commit !== started.commit || now.branch !== started.branch) {
    throw new EvidenceError(
      `the checkout moved from ${started.commit.slice(0, 12)} to ${now.commit.slice(0, 12)} during the run; run again`,
    );
  }
}

export type AncestryResult =
  | { readonly status: "reachable"; readonly ref: string }
  | { readonly status: "unreachable" }
  | { readonly status: "unknown"; readonly reason: string };

/** Whether `commit` is `of` or one of its ancestors; undefined when git cannot tell (a shallow clone). */
export function commitIsAncestor(commit: string, of: string, root = REPO_ROOT): boolean | undefined {
  const git = gitRunner(root);
  try {
    if (git("rev-parse", "--is-shallow-repository") === "true") return undefined;
    git("rev-parse", "--verify", "--quiet", `${commit}^{commit}`);
    git("rev-parse", "--verify", "--quiet", `${of}^{commit}`);
  } catch {
    return undefined;
  }
  return isAncestor(git, commit, of);
}

/** Whether `commit` is on `main`; "unknown" in a shallow clone or without a `main` ref. */
export function commitOnRelease(commit: string, root = REPO_ROOT): AncestryResult {
  const git = gitRunner(root);
  try {
    if (git("rev-parse", "--is-shallow-repository") === "true") {
      return { status: "unknown", reason: "shallow clone" };
    }
  } catch {
    return { status: "unknown", reason: "not a git checkout" };
  }
  const refs = releaseRefs(git);
  if (refs.length === 0) return { status: "unknown", reason: `no ${RELEASE_BRANCH} ref` };
  const ref = refs.find((candidate) => isAncestor(git, commit, candidate));
  return ref === undefined ? { status: "unreachable" } : { status: "reachable", ref };
}

// --- writing -------------------------------------------------------------------------------------

export interface WriteOptions extends ProvenanceOptions {
  /** File name inside the evidence directory; defaults to `runFileName(evidence)`. */
  readonly file?: string;
}

export function evidenceFileName(kind: EvidenceKind, network: string, variant?: string): string {
  return `${kind}${variant === undefined ? "" : `-${variant}`}-${network.replace(":", "-")}.json`;
}

/**
 * The file a run is written to: `<kind>[-<variant>]-<network>.json` for a run against a local Rail402,
 * `<kind>[-<variant>]-hosted-<network>.json` against a deployed one, so the two are kept side by side.
 */
export function runFileName(
  evidence: Pick<Evidence, "kind" | "network" | "target">,
  variant?: string,
): string {
  const parts = [
    ...(variant === undefined ? [] : [variant]),
    ...(evidence.target.mode === "hosted" ? ["hosted"] : []),
  ];
  return evidenceFileName(evidence.kind, evidence.network, parts.length === 0 ? undefined : parts.join("-"));
}

/** Validates evidence against every writer rule and writes it; returns the repository-relative path. */
export function writeEvidence(value: Evidence, options: WriteOptions = {}): string {
  const { evidence, problems } = checkEvidence(value);
  if (evidence === undefined) throw new EvidenceError(`evidence is invalid:\n  ${problems.join("\n  ")}`);
  const provenance = harnessProvenance(options);
  if (evidence.harness.commit !== provenance.commit) {
    throw new EvidenceError(
      `harness.commit ${evidence.harness.commit.slice(0, 12)} is not the checked-out commit ${provenance.commit.slice(0, 12)}`,
    );
  }
  if (evidence.harness.branch !== provenance.branch) {
    throw new EvidenceError("harness.branch must match the provenance the run was started with");
  }
  const file = options.file ?? runFileName(evidence);
  if (!/^[a-z0-9][a-z0-9.-]*\.json$/.test(file) || file === "manifest.json") {
    throw new EvidenceError(`invalid evidence file name "${file}"`);
  }
  const directory = join(options.root ?? REPO_ROOT, EVIDENCE_DIR);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, file), `${JSON.stringify(evidence, null, 2)}\n`);
  return `${EVIDENCE_DIR}/${file}`;
}

/** Paths with uncommitted changes, untracked files included (`git status -z`, so no quoting). */
function changedPaths(root: string): string[] {
  const entries = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).split("\0");
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index] ?? "";
    if (entry.length < 4) continue;
    paths.push(entry.slice(3));
    // A rename or copy is followed by its original path.
    if (entry[0] === "R" || entry[0] === "C") index++;
  }
  return paths;
}

function gitRunner(root: string) {
  return (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function releaseRefs(git: ReturnType<typeof gitRunner>): string[] {
  return [RELEASE_BRANCH, `origin/${RELEASE_BRANCH}`].filter((ref) => {
    try {
      git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`);
      return true;
    } catch {
      return false;
    }
  });
}

function isAncestor(git: ReturnType<typeof gitRunner>, commit: string, ref: string): boolean {
  try {
    git("merge-base", "--is-ancestor", commit, ref);
    return true;
  } catch {
    return false;
  }
}
