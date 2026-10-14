/**
 * The committed evidence as one checked set: every file parsed (current or older format) and its
 * content hash, plus the manifest that pins those hashes. The report renders only from this set.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  EVIDENCE_DIR,
  EVIDENCE_KINDS,
  REPO_ROOT,
  checkEvidence,
  findSecrets,
  type Evidence,
  type EvidenceKind,
} from "./evidence.ts";
import { legacyCommit, parseLegacy, type LegacyEvidence } from "./legacy.ts";

export const MANIFEST_FILE = "manifest.json";

export type LoadedEvidence =
  | {
      readonly file: string;
      readonly sha256: string;
      readonly kind: EvidenceKind;
      readonly commit: string;
      readonly format: "current";
      readonly evidence: Evidence;
      /** Set when the run was a rehearsal from a branch other than main. */
      readonly branch: string | undefined;
    }
  | {
      readonly file: string;
      readonly sha256: string;
      readonly kind: EvidenceKind;
      readonly commit: string;
      readonly format: "legacy";
      readonly evidence: LegacyEvidence;
      readonly branch: string | undefined;
    };

export interface EvidenceSet {
  readonly files: readonly LoadedEvidence[];
  /** One entry per file that failed a check; empty when the whole set is valid. */
  readonly problems: readonly string[];
}

const manifestSchema = z.strictObject({
  files: z.array(
    z.strictObject({
      file: z.string().min(1),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      kind: z.enum(EVIDENCE_KINDS),
      commit: z.string().min(1),
    }),
  ),
});
export type Manifest = z.infer<typeof manifestSchema>;

/** Loads and checks every evidence file under `root`. */
export function loadEvidenceSet(root = REPO_ROOT): EvidenceSet {
  const directory = join(root, EVIDENCE_DIR);
  const names = existsSync(directory)
    ? readdirSync(directory)
        .filter((name) => name.endsWith(".json") && name !== MANIFEST_FILE)
        .sort()
    : [];
  const files: LoadedEvidence[] = [];
  const problems: string[] = [];
  for (const file of names) {
    const text = readFileSync(join(directory, file), "utf8");
    const sha256 = createHash("sha256").update(text).digest("hex");
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      problems.push(`${file}: not valid JSON`);
      continue;
    }
    if ((value as { schemaVersion?: unknown } | null)?.schemaVersion !== undefined) {
      const checked = checkEvidence(value);
      if (checked.evidence === undefined) {
        problems.push(...checked.problems.map((problem) => `${file}: ${problem}`));
        continue;
      }
      const evidence = checked.evidence;
      files.push({
        file,
        sha256,
        kind: evidence.kind,
        commit: evidence.harness.commit,
        format: "current",
        evidence,
        branch: evidence.harness.branch,
      });
      continue;
    }
    const legacy = parseLegacy(value);
    const secrets = findSecrets(value);
    if (legacy.evidence === undefined || secrets.length > 0) {
      problems.push(...[...legacy.problems, ...secrets].map((problem) => `${file}: ${problem}`));
      continue;
    }
    files.push({
      file,
      sha256,
      kind: legacy.evidence.kind,
      commit: legacyCommit(legacy.evidence),
      format: "legacy",
      evidence: legacy.evidence,
      branch: rehearsalBranch(value),
    });
  }
  return { files, problems };
}

export function buildManifest(set: EvidenceSet): Manifest {
  return {
    files: set.files.map(({ file, sha256, kind, commit }) => ({ file, sha256, kind, commit })),
  };
}

export function renderManifest(manifest: Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function manifestPath(root = REPO_ROOT): string {
  return join(root, EVIDENCE_DIR, MANIFEST_FILE);
}

/** The committed manifest, or undefined when there is none. Throws when it is malformed. */
export function readManifest(root = REPO_ROOT): Manifest | undefined {
  const path = manifestPath(root);
  if (!existsSync(path)) return undefined;
  return manifestSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function writeManifest(set: EvidenceSet, root = REPO_ROOT): void {
  writeFileSync(manifestPath(root), renderManifest(buildManifest(set)));
}

/** Older harnesses record a rehearsal branch as a top-level `harnessBranch`. */
function rehearsalBranch(value: unknown): string | undefined {
  const branch = (value as { harnessBranch?: unknown }).harnessBranch;
  return typeof branch === "string" ? branch : undefined;
}

/**
 * Deployment records whose `commit` (and each replaced deployment's under `previous`) names a source
 * revision a published page links to.
 */
export const DEPLOYMENT_RECORDS = [
  "contracts/stellar/deployments/testnet.json",
  "contracts/testing/deployments/test6-testnet.json",
] as const;

/** The error-code coverage record, rendered on the error-code page next to the evidence. */
export const COVERAGE_RECORD_FILE = "tools/conformance/codes-coverage.json";

/**
 * Why the set is not ready to publish, beyond the per-file checks: a file still in the older format
 * (re-record it or delete it), a cited commit (an evidence file's, a deployment record's or the
 * error-code coverage record's) that readers cannot reach because it is not on `main`, or a coverage
 * record made before the evidence it is published with. `reachable` answers whether a commit is on
 * `main`, and `ancestor` whether the first commit is the second or one of its ancestors; undefined
 * means it could not be decided (a shallow clone), which is not a problem.
 */
export function publicationProblems(
  set: EvidenceSet,
  reachable: (commit: string) => boolean | undefined,
  root = REPO_ROOT,
  ancestor: (commit: string, of: string) => boolean | undefined = () => undefined,
): string[] {
  const problems: string[] = [];
  for (const file of set.files) {
    if (file.format === "legacy") {
      problems.push(
        `${file.file}: recorded in the older format; re-record it with pnpm evidence or delete it`,
      );
    }
    const commit = file.commit.replace(/-dirty$/, "");
    if (reachable(commit) === false)
      problems.push(`${file.file}: commit ${commit.slice(0, 12)} is not on main`);
  }
  for (const record of DEPLOYMENT_RECORDS) {
    const path = join(root, record);
    if (!existsSync(path)) continue;
    const { commit, previous } = JSON.parse(readFileSync(path, "utf8")) as {
      commit?: unknown;
      previous?: { contract_id?: unknown; commit?: unknown }[];
    };
    if (typeof commit === "string" && reachable(commit) === false) {
      problems.push(`${record}: source revision ${commit.slice(0, 12)} is not on main`);
    }
    for (const entry of Array.isArray(previous) ? previous : []) {
      if (typeof entry.commit === "string" && reachable(entry.commit) === false) {
        problems.push(
          `${record}: the source revision ${entry.commit.slice(0, 12)} of ${String(entry.contract_id)} is not on main`,
        );
      }
    }
  }
  const coverage = join(root, COVERAGE_RECORD_FILE);
  if (existsSync(coverage)) {
    const { commit } = JSON.parse(readFileSync(coverage, "utf8")) as { commit?: unknown };
    if (typeof commit === "string") {
      if (reachable(commit) === false) {
        problems.push(`${COVERAGE_RECORD_FILE}: recorded at ${commit.slice(0, 12)}, which is not on main`);
      }
      const evidence = [
        ...new Set(set.files.filter((file) => file.format === "current").map((file) => file.commit)),
      ];
      const newer = evidence.filter((evidenceCommit) => ancestor(evidenceCommit, commit) === false);
      if (newer.length > 0) {
        problems.push(
          `${COVERAGE_RECORD_FILE}: recorded at ${commit.slice(0, 12)}, before the evidence at ${newer.map((entry) => entry.slice(0, 12)).join(", ")}; ` +
            "run pnpm evidence with RAIL402_EVIDENCE_STEPS=codes-coverage,report",
        );
      }
    }
  }
  return problems;
}
