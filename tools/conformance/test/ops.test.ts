import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkEvidence, type Evidence, type EvidenceCase } from "../src/evidence.ts";
import type { EvidenceSet } from "../src/evidence-set.ts";
import { buildEvidence } from "../src/harness.ts";
import { exerciseCases, incompleteRun, readObservations, testFiles, type VitestReport } from "../src/ops.ts";
import { OPS_EVIDENCE_FILE, type OpsExercise } from "../src/ops-exercises.ts";
import { renderRelease, renderSummary } from "../src/render-report.ts";
import { renderExerciseSummary, renderExercises, renderOpsRun } from "../src/render-security.ts";

const ROOT = "/repo";

const exercise = (id: string, tests: OpsExercise["tests"]): OpsExercise => ({
  id,
  title: `exercise ${id}`,
  threats: ["S1"],
  checks: ["fees-sponsored"],
  environment: "private network",
  procedure: "do it",
  expected: "it works",
  tests,
});

const result = (title: string, status: string, duration = 100, describe = "suite") => ({
  title,
  fullName: `${describe} ${title}`,
  status,
  duration,
});

const report: VitestReport = {
  testResults: [
    {
      name: `${ROOT}/packages/a/test/a.integration.test.ts`,
      assertionResults: [
        result("refuses a thing", "passed", 1200),
        result("names a race; the fee is spent", "passed", 800),
        result("breaks", "failed"),
        result("needs docker", "skipped", 0),
      ],
    },
    {
      name: `${ROOT}/packages/b/test/b.integration.test.ts`,
      assertionResults: [
        result("never lets a different payTo modify a listing", "passed", 50, "postgres: bazaar catalog"),
      ],
    },
  ],
};

describe("ops runner", () => {
  const passing = exercise("passing", [
    { file: "packages/a/test/a.integration.test.ts", name: "refuses a thing" },
    { file: "packages/a/test/a.integration.test.ts", name: "names a race" },
  ]);
  const suite = exercise("suite", [
    {
      file: "packages/b/src/testing.ts",
      name: "never lets a different payTo modify a listing",
      runIn: "packages/b/test/b.integration.test.ts",
    },
  ]);

  it("runs each needed test file once", () => {
    expect(testFiles([passing, suite, passing])).toEqual([
      "packages/a/test/a.integration.test.ts",
      "packages/b/test/b.integration.test.ts",
    ]);
  });

  it("passes an exercise whose tests all passed, keeping what they recorded", () => {
    const [entry] = exerciseCases(
      [passing],
      report,
      [
        { id: "passing", at: "2026-09-30T00:00:00.000Z", observed: { wastedFeeStroops: "123" } },
        { id: "other", at: "2026-09-30T00:00:00.000Z", observed: { ignored: true } },
      ],
      ROOT,
    );
    expect(entry).toMatchObject({
      id: "passing",
      status: "passed",
      elapsedMs: 2000,
      checks: ["fees-sponsored"],
    });
    expect(entry?.observations).toMatchObject({
      threats: ["S1"],
      recorded: [{ wastedFeeStroops: "123" }],
      tests: [
        { test: "packages/a/test/a.integration.test.ts::refuses a thing", results: [{ status: "passed" }] },
        { test: "packages/a/test/a.integration.test.ts::names a race", results: [{ status: "passed" }] },
      ],
    });
  });

  it("finds a shared suite's test in the file that runs it", () => {
    expect(exerciseCases([suite], report, [], ROOT)[0]).toMatchObject({ status: "passed" });
  });

  it("fails an exercise when one of its tests failed, and skips one whose test did not run", () => {
    const [failed, skipped, missing] = exerciseCases(
      [
        exercise("failed", [
          { file: "packages/a/test/a.integration.test.ts", name: "refuses a thing" },
          { file: "packages/a/test/a.integration.test.ts", name: "breaks" },
        ]),
        exercise("skipped", [{ file: "packages/a/test/a.integration.test.ts", name: "needs docker" }]),
        exercise("missing", [{ file: "packages/a/test/a.integration.test.ts", name: "was renamed" }]),
      ],
      report,
      [],
      ROOT,
    );
    expect(failed).toMatchObject({ status: "failed" });
    expect(failed?.skipReason).toBeUndefined();
    expect(skipped).toMatchObject({ status: "skipped" });
    expect(skipped?.skipReason).toMatch(/unavailable/);
    expect(missing).toMatchObject({ status: "skipped" });
    expect(missing?.skipReason).toMatch(/no result for .*was renamed/);
  });

  it("refuses to record a run whose exercises were skipped unless skips are accepted", () => {
    const skippedOnly = exerciseCases(
      [exercise("skipped", [{ file: "packages/a/test/a.integration.test.ts", name: "needs docker" }])],
      report,
      [],
      ROOT,
    );
    const problems = incompleteRun(skippedOnly, false);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/1 of 1 exercises were skipped \(skipped\).*--allow-skips/);
    expect(incompleteRun(skippedOnly, true)).toEqual([]);
    expect(incompleteRun(exerciseCases([passing, suite], report, [], ROOT), false)).toEqual([]);
  });

  it("builds evidence the writer rules accept", () => {
    const cases = exerciseCases([passing, suite], report, [], ROOT);
    const evidence = buildEvidence(
      {
        kind: "ops",
        provenance: { commit: "a".repeat(40), dirty: false },
        network: "stellar:testnet",
        target: {
          mode: "local",
          facilitatorUrl: "http://127.0.0.1",
          healthVersion: "0.0.0",
          supported: null,
        },
        packages: {},
        command: "node tools/conformance/src/ops.ts",
        config: {},
        accounts: {},
        startedAt: "2026-09-30T00:00:00.000Z",
      },
      cases,
    );
    expect(checkEvidence(evidence).problems).toEqual([]);
  });

  it("reads the recorded observations line by line", () => {
    const file = join(mkdtempSync(join(tmpdir(), "ops-")), "observations.jsonl");
    expect(readObservations(file)).toEqual([]);
    writeFileSync(file, '{"id":"a","at":"t","observed":{"x":1}}\n\n{"id":"b","at":"t","observed":{}}\n');
    expect(readObservations(file).map((line) => line.id)).toEqual(["a", "b"]);
  });
});

describe("security page renderers", () => {
  const exercises: OpsExercise[] = [
    exercise("passing", [{ file: "packages/a/test/a.integration.test.ts", name: "refuses a thing" }]),
    {
      ...exercise("remote", [{ file: "packages/a/test/a.integration.test.ts", name: "breaks" }]),
      testnet: ["live-matrix#replay-concurrent"],
    },
  ];
  const run = (kind: Evidence["kind"], cases: EvidenceCase[]): Evidence =>
    buildEvidence(
      {
        kind,
        provenance: { commit: "b".repeat(40), dirty: false },
        network: "stellar:testnet",
        target: {
          mode: "local",
          facilitatorUrl: "http://127.0.0.1",
          healthVersion: "0.2.1",
          supported: null,
        },
        packages: { "@x402/core": "2.27.0" },
        command: "node tools/conformance/src/ops.ts",
        config: {},
        accounts: {},
        startedAt: "2026-09-30T00:00:00.000Z",
        finishedAt: "2026-09-30T00:10:00.000Z",
      },
      cases,
    );
  const loaded = (file: string, evidence: Evidence): EvidenceSet["files"][number] => ({
    file,
    sha256: "0".repeat(64),
    kind: evidence.kind,
    commit: evidence.harness.commit,
    format: "current",
    evidence,
    branch: undefined,
  });
  const ops = run(
    "ops",
    exerciseCases(exercises, report, [{ id: "passing", at: "t", observed: { fee: "76216" } }], ROOT),
  );
  const matrix = run("live-matrix", [
    { id: "replay-concurrent", title: "t", checks: ["idempotency"], status: "passed", elapsedMs: 1 },
  ]);

  it("show each exercise's local and testnet outcome with what it recorded", () => {
    const set: EvidenceSet = {
      files: [loaded(OPS_EVIDENCE_FILE, ops), loaded("live-matrix-stellar-testnet.json", matrix)],
      problems: [],
    };
    const summary = renderExerciseSummary(exercises, set);
    expect(summary).toContain("| `passing` exercise passing | S1 | private network | Passed | n/a |");
    expect(summary).toContain("| `remote` exercise remote | S1 | private network | Failed | 1 of 1 passed |");
    const details = renderExercises(exercises, set);
    expect(details).toContain("- Recorded: fee `76216`");
    expect(details).toContain("`live-matrix` case `replay-concurrent`: Passed");
    expect(renderOpsRun(set)).toContain("**1 of 2 exercises passed**, 1 failed");
  });

  it("say that nothing was recorded when there is no run", () => {
    const set: EvidenceSet = { files: [], problems: [] };
    expect(renderOpsRun(set)).toMatch(/^No run has been recorded yet/);
    expect(renderExercises(exercises, set)).toContain("**Observed.** Not recorded yet.");
  });

  it("keep operational runs out of the conformance page's release, and label them in the summary", () => {
    const set: EvidenceSet = { files: [loaded(OPS_EVIDENCE_FILE, ops)], problems: [] };
    expect(renderRelease(set)).toMatch(/^No run in the current evidence format/);
    const rows = renderSummary(set)
      .split("\n")
      .filter((row) => row.includes(OPS_EVIDENCE_FILE));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).toContain("private network");
  });
});
