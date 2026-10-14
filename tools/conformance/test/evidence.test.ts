import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  EVIDENCE_DIR,
  EvidenceError,
  checkEvidence,
  commitOnRelease,
  findLocalPaths,
  findSecrets,
  harnessProvenance,
  writeEvidence,
  type Evidence,
  type EvidenceCase,
  type EvidenceTransaction,
} from "../src/evidence.ts";
import {
  buildManifest,
  loadEvidenceSet,
  publicationProblems,
  readManifest,
  type EvidenceSet,
} from "../src/evidence-set.ts";

describe("committed evidence", () => {
  const set = loadEvidenceSet();

  it("passes every check", () => {
    expect(set.problems).toEqual([]);
    expect(set.files.length).toBeGreaterThan(0);
  });

  it("matches the manifest, so no file changed without re-rendering the report", () => {
    expect(readManifest()).toEqual(buildManifest(set));
  });

  it("comes from main, never from a rehearsal branch", () => {
    for (const file of set.files) {
      expect(file.branch, `${file.file} is a rehearsal run`).toBeUndefined();
      if (file.format !== "current") continue;
      const ancestry = commitOnRelease(file.commit);
      if (ancestry.status === "unknown") {
        console.warn(`${file.file}: commit ancestry not checked (${ancestry.reason})`);
        continue;
      }
      expect(ancestry.status, `${file.file}: ${file.commit} must be on main`).toBe("reachable");
    }
  });
});

describe("publicationProblems", () => {
  const ON_MAIN = "1".repeat(40);
  const LOST = "2".repeat(40);
  const set = (files: { file: string; format: "current" | "legacy"; commit: string }[]): EvidenceSet =>
    ({
      files: files.map((file) => ({ ...file, sha256: "0".repeat(64), kind: "canonical", branch: undefined })),
      problems: [],
    }) as unknown as EvidenceSet;
  const root = mkdtempSync(join(tmpdir(), "publication-"));
  afterEach(() => {
    rmSync(join(root, "contracts"), { recursive: true, force: true });
  });
  const reachable = (commit: string) => (commit === "3".repeat(40) ? undefined : commit === ON_MAIN);

  it("names older-format files and commits that are not on main, including deployment records", () => {
    mkdirSync(join(root, "contracts/stellar/deployments"), { recursive: true });
    writeFileSync(
      join(root, "contracts/stellar/deployments/testnet.json"),
      JSON.stringify({
        commit: LOST,
        previous: [
          { contract_id: "CPREVIOUS", commit: LOST },
          { contract_id: "CKEPT", commit: ON_MAIN },
        ],
      }),
    );
    expect(
      publicationProblems(
        set([
          { file: "a.json", format: "current", commit: ON_MAIN },
          { file: "b.json", format: "legacy", commit: `${LOST}-dirty` },
          { file: "c.json", format: "current", commit: "3".repeat(40) },
        ]),
        reachable,
        root,
      ),
    ).toEqual([
      "b.json: recorded in the older format; re-record it with pnpm evidence or delete it",
      "b.json: commit 222222222222 is not on main",
      "contracts/stellar/deployments/testnet.json: source revision 222222222222 is not on main",
      "contracts/stellar/deployments/testnet.json: the source revision 222222222222 of CPREVIOUS is not on main",
    ]);
  });

  it("accepts current files whose commits are on main", () => {
    expect(
      publicationProblems(set([{ file: "a.json", format: "current", commit: ON_MAIN }]), reachable, root),
    ).toEqual([]);
  });

  it("names a coverage record that is not on main or older than the evidence", () => {
    const NEWER = "4".repeat(40);
    mkdirSync(join(root, "tools/conformance"), { recursive: true });
    const record = join(root, "tools/conformance/codes-coverage.json");
    // `ancestor(a, b)`: a is b or an ancestor of it; ON_MAIN comes before NEWER.
    const ancestor = (commit: string, of: string) => commit === of || (commit === ON_MAIN && of === NEWER);
    const files = set([
      { file: "a.json", format: "current", commit: ON_MAIN },
      { file: "b.json", format: "current", commit: NEWER },
    ]);
    try {
      writeFileSync(record, JSON.stringify({ commit: NEWER }));
      expect(publicationProblems(files, () => true, root, ancestor)).toEqual([]);
      writeFileSync(record, JSON.stringify({ commit: ON_MAIN }));
      expect(publicationProblems(files, () => true, root, ancestor)).toEqual([
        "tools/conformance/codes-coverage.json: recorded at 111111111111, before the evidence at 444444444444; run pnpm evidence with RAIL402_EVIDENCE_STEPS=codes-coverage,report",
      ]);
      writeFileSync(record, JSON.stringify({ commit: LOST }));
      expect(publicationProblems(set([]), reachable, root, ancestor)).toEqual([
        "tools/conformance/codes-coverage.json: recorded at 222222222222, which is not on main",
      ]);
    } finally {
      rmSync(join(root, "tools"), { recursive: true, force: true });
    }
  });
});

const HASH = "a".repeat(64);
const COMMIT = "b".repeat(40);

const TRANSACTION: EvidenceTransaction = {
  hash: HASH,
  ledger: 12,
  scheme: "exact",
  asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  decimals: 7,
  amount: "100",
  payerType: "G",
  feeChargedStroops: "23126",
  feeSource: "GSPONSOR",
  innerSource: "GCHANNEL",
  innerSequence: "42",
  transfers: [{ from: "GPAYER", to: "GPAYTO", amount: "100" }],
  explorer: `https://stellar.expert/explorer/testnet/tx/${HASH}`,
};
const SETTLED: EvidenceCase = {
  id: "g-payer-settles",
  title: "a G… payer settles",
  checks: ["scheme-exact"],
  status: "passed",
  elapsedMs: 10,
  transactions: [TRANSACTION],
};
const SKIPPED: EvidenceCase = {
  id: "upto",
  title: "upto settles",
  checks: ["scheme-upto"],
  status: "skipped",
  skipReason: "the facilitator does not advertise upto",
  elapsedMs: 0,
};

function sample(overrides: Partial<Evidence> = {}): Evidence {
  return {
    schemaVersion: 2,
    kind: "live-matrix",
    runId: "run-1",
    startedAt: "2026-09-30T10:00:00.000Z",
    finishedAt: "2026-09-30T10:05:00.000Z",
    network: "stellar:testnet",
    target: {
      mode: "local",
      facilitatorUrl: "http://localhost:8080",
      healthVersion: "0.2.1",
      supported: { kinds: [] },
    },
    harness: { commit: COMMIT, dirty: false },
    packages: { "@x402/stellar": "2.27.0" },
    command: "node tools/conformance/src/live-matrix.ts",
    config: { channels: 8 },
    accounts: { sponsor: Keypair.random().publicKey() },
    summary: { total: 2, passed: 1, failed: 0, skipped: 1 },
    cases: [SETTLED, SKIPPED],
    ...overrides,
  };
}

describe("checkEvidence", () => {
  it("accepts a complete document", () => {
    expect(checkEvidence(sample()).problems).toEqual([]);
  });

  it("requires the summary to equal the case counts", () => {
    const { problems } = checkEvidence(sample({ summary: { total: 2, passed: 2, failed: 0, skipped: 0 } }));
    expect(problems).toEqual([
      "summary.passed is 2 but the cases give 1",
      "summary.skipped is 0 but the cases give 1",
    ]);
  });

  it("requires a reason for every skipped case and a check id for every case", () => {
    const unchecked = { ...SETTLED, checks: [] } as unknown as EvidenceCase;
    expect(checkEvidence(sample({ cases: [unchecked, SKIPPED] })).problems).toEqual([
      "cases.0.checks: must name at least one check",
    ]);
    const { skipReason: _, ...unexplained } = SKIPPED;
    expect(checkEvidence(sample({ cases: [SETTLED, unexplained] })).problems).toEqual([
      "cases.1 (upto): a skipped case needs a skipReason",
    ]);
  });

  it("refuses a dirty harness, a short commit and a malformed transaction hash", () => {
    expect(
      checkEvidence({ ...sample(), harness: { commit: COMMIT, dirty: true } }).problems.join("\n"),
    ).toMatch(/harness\.dirty/);
    expect(
      checkEvidence(sample({ harness: { commit: "bbbbbbb", dirty: false } })).problems.join("\n"),
    ).toMatch(/40-character/);
    const cases = [{ ...SETTLED, transactions: [{ ...TRANSACTION, hash: "zz" }] }, SKIPPED];
    expect(checkEvidence(sample({ cases })).problems.join("\n")).toMatch(/64-character/);
  });

  it("refuses anything that looks like a secret", () => {
    const seed = Keypair.random().secret();
    expect(checkEvidence(sample({ command: `run --key ${seed}` })).problems).toEqual([
      "command: contains a Stellar secret seed",
    ]);
    expect(checkEvidence(sample({ config: { sponsorSecret: "hidden" } })).problems).toEqual([
      "config.sponsorSecret: a field named like a secret must not carry a value",
    ]);
    // A public key and a string that only resembles a seed are fine.
    expect(findSecrets({ account: Keypair.random().publicKey(), text: `S${"A".repeat(55)}` })).toEqual([]);
  });

  it("refuses a path of the machine that recorded it", () => {
    const home = join(tmpdir(), "rail402-live-agent-home-x", "payer.key");
    expect(checkEvidence(sample({ command: `rail402 keys new --key-file ${home}` })).problems).toEqual([
      `command: names a local path (${tmpdir()})`,
    ]);
    expect(findLocalPaths({ a: ["/srv/rail402/x"] }, ["/srv/rail402"])).toEqual([
      "a.0: names a local path (/srv/rail402)",
    ]);
    expect(findLocalPaths({ command: "rail402 keys new --key-file <home>/payer.key" })).toEqual([]);
    expect(findLocalPaths({ file: "tools/conformance/evidence/x.json" })).toEqual([]);
  });
});

describe("evidence provenance", () => {
  const repos: string[] = [];
  afterEach(() => {
    for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
  });

  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "evidence test",
    GIT_AUTHOR_EMAIL: "evidence@example.com",
    GIT_COMMITTER_NAME: "evidence test",
    GIT_COMMITTER_EMAIL: "evidence@example.com",
  };

  function repository(): { root: string; git: (...args: string[]) => string } {
    const root = mkdtempSync(join(tmpdir(), "rail402-evidence-"));
    repos.push(root);
    const git = (...args: string[]) =>
      execFileSync("git", args, {
        cwd: root,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    git("init", "-q", "-b", "main");
    writeFileSync(join(root, "README.md"), "evidence\n");
    git("add", ".");
    git("commit", "-q", "-m", "add the readme");
    return { root, git };
  }

  it("accepts a clean commit on main and writes the file", () => {
    const { root, git } = repository();
    const commit = git("rev-parse", "HEAD");
    expect(harnessProvenance({ root })).toEqual({ commit, dirty: false });
    const path = writeEvidence(sample({ harness: { commit, dirty: false } }), { root });
    expect(path).toBe(`${EVIDENCE_DIR}/live-matrix-stellar-testnet.json`);
    const written = JSON.parse(readFileSync(join(root, path), "utf8")) as Evidence;
    expect(written.harness.commit).toBe(commit);
    // Evidence written by an earlier harness does not make the tree dirty for the next one.
    expect(harnessProvenance({ root }).commit).toBe(commit);
  });

  it("refuses a dirty tree", () => {
    const { root } = repository();
    writeFileSync(join(root, "README.md"), "changed\n");
    expect(() => harnessProvenance({ root })).toThrow(/clean working tree.*README\.md/);
    writeFileSync(join(root, "README.md"), "evidence\n");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "new.ts"), "export {};\n");
    expect(() => harnessProvenance({ root })).toThrow(EvidenceError);
  });

  it("refuses a commit that is not on main unless its branch is named", () => {
    const { root, git } = repository();
    git("checkout", "-q", "-b", "feature");
    writeFileSync(join(root, "feature.txt"), "x\n");
    git("add", ".");
    git("commit", "-q", "-m", "add a feature");
    const commit = git("rev-parse", "HEAD");
    expect(() => harnessProvenance({ root })).toThrow(/not reachable from main/);
    expect(harnessProvenance({ root, allowBranch: "feature" })).toEqual({
      commit,
      dirty: false,
      branch: "feature",
    });
    expect(() => harnessProvenance({ root, allowBranch: "other" })).toThrow(
      /not reachable from main; record evidence from main or other/,
    );
    expect(commitOnRelease(commit, root)).toEqual({ status: "unreachable" });
    expect(commitOnRelease(git("rev-parse", "main"), root)).toEqual({ status: "reachable", ref: "main" });
  });

  it("refuses to write evidence that does not describe the checked-out commit", () => {
    const { root } = repository();
    expect(() => writeEvidence(sample(), { root })).toThrow(/is not the checked-out commit/);
    expect(() =>
      writeEvidence(sample({ summary: { total: 0, passed: 0, failed: 0, skipped: 0 } }), { root }),
    ).toThrow(/evidence is invalid/);
  });
});
