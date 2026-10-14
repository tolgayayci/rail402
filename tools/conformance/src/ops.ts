/**
 * Runs the operational exercises (ops-exercises.ts) and records what happened. The exercises are
 * integration and unit tests; this runs their files with Vitest's JSON reporter, joins each exercise's
 * test results with the observations the tests recorded through `recordOps`, and builds `ops`
 * evidence, one case per exercise. It needs the local services the integration tests use (the private
 * Stellar network, Postgres, Docker for the archival network); a test that could not run makes its
 * exercise skipped, with the reason.
 *
 *   node --conditions=@rail402/source tools/conformance/src/ops.ts [--only balance-race,crash-k0] \
 *     [--allow-skips] [--write [--allow-branch <branch>]]
 *
 * Without --write the evidence is printed only. With --write it is recorded in
 * tools/conformance/evidence/ops-local-stellar-testnet.json, from a clean checkout of main. A run in
 * which any exercise was skipped (a local service was down) exits non-zero and records nothing, unless
 * `--allow-skips` accepts the skipped rows (a rehearsal on a machine without some of the services).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";
import { LOCAL_RPC_URL, type OpsObservation } from "@rail402.dev/testkit";
import { jsonSafe, buildEvidence } from "./harness.ts";
import {
  REPO_ROOT,
  harnessProvenance,
  recheckProvenance,
  writeEvidence,
  type Evidence,
  type EvidenceCase,
} from "./evidence.ts";
import {
  EXERCISES,
  OPS_EVIDENCE_FILE,
  type ExerciseTest,
  type OpsExercise,
  type TestOutcome,
} from "./ops-exercises.ts";
import { gitCommit, log, versions } from "./testnet.ts";

/** The part of Vitest's JSON report this reads. */
export interface VitestReport {
  readonly testResults: readonly {
    readonly name: string;
    readonly assertionResults: readonly {
      readonly title: string;
      readonly fullName: string;
      readonly status: string;
      readonly duration?: number | null;
      readonly failureMessages?: readonly string[];
    }[];
  }[];
}

/** The test file an exercise test runs in. */
export function runnerOf(test: ExerciseTest): string {
  return test.runIn ?? test.file;
}

/** Every test file the selected exercises need, once each, in order. */
export function testFiles(exercises: readonly OpsExercise[]): string[] {
  return [...new Set(exercises.flatMap((exercise) => exercise.tests.map(runnerOf)))];
}

/** The results in `file` whose test name contains `name` (all of them for a parameterised test). */
export function outcomesOf(report: VitestReport, test: ExerciseTest, root = REPO_ROOT): TestOutcome[] {
  const file = runnerOf(test);
  return report.testResults
    .filter((result) => relative(root, result.name) === file)
    .flatMap((result) => result.assertionResults)
    .filter((assertion) => assertion.title.includes(test.name))
    .map((assertion) => ({
      name: assertion.fullName,
      status: assertion.status === "passed" ? "passed" : assertion.status === "failed" ? "failed" : "skipped",
      durationMs: Math.round(assertion.duration ?? 0),
    }));
}

/** One evidence case per exercise, from the test results and the recorded observations. */
export function exerciseCases(
  exercises: readonly OpsExercise[],
  report: VitestReport,
  observations: readonly OpsObservation[],
  root = REPO_ROOT,
): EvidenceCase[] {
  return exercises.map((exercise) => {
    const tests = exercise.tests.map((test) => ({
      test: `${test.file}::${test.name}`,
      results: outcomesOf(report, test, root),
    }));
    const results = tests.flatMap((entry) => entry.results);
    const missing = tests.filter((entry) => entry.results.length === 0).map((entry) => entry.test);
    const skipped = tests
      .filter((entry) => entry.results.some((result) => result.status === "skipped"))
      .map((entry) => entry.test);
    const failed = results.some((result) => result.status === "failed");
    const recorded = observations
      .filter((observation) => observation.id === exercise.id)
      .map((observation) => observation.observed);
    const status: EvidenceCase["status"] = failed
      ? "failed"
      : missing.length > 0 || skipped.length > 0
        ? "skipped"
        : "passed";
    const reason = [
      ...(missing.length > 0 ? [`no result for ${missing.join("; ")}`] : []),
      ...(skipped.length > 0
        ? [`skipped (a local service it needs was unavailable): ${skipped.join("; ")}`]
        : []),
    ].join("; ");
    return {
      id: exercise.id,
      title: exercise.title,
      checks: [...exercise.checks],
      status,
      ...(status === "skipped" ? { skipReason: reason } : {}),
      elapsedMs: results.reduce((sum, result) => sum + result.durationMs, 0),
      observations: jsonSafe({
        threats: exercise.threats,
        environment: exercise.environment,
        tests,
        ...(recorded.length === 0 ? {} : { recorded }),
      }) as Record<string, unknown>,
    };
  });
}

/**
 * Why these cases may not be recorded or reported as a success: every skipped exercise, unless
 * `allowSkips` accepts them. A failed exercise is reported by the exit status on its own.
 */
export function incompleteRun(cases: readonly EvidenceCase[], allowSkips: boolean): string[] {
  if (allowSkips) return [];
  const skipped = cases.filter((entry) => entry.status === "skipped");
  if (skipped.length === 0) return [];
  return [
    `${String(skipped.length)} of ${String(cases.length)} exercises were skipped (${skipped.map((entry) => entry.id).join(", ")}): ` +
      "start the local services they need (see the reasons above), or pass --allow-skips to accept skipped rows",
  ];
}

/** Parses the JSON lines `recordOps` appended; a malformed line is an error. */
export function readObservations(file: string): OpsObservation[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as OpsObservation);
}

function main(): void {
  const { values } = parseArgs({
    options: {
      only: { type: "string" },
      "allow-skips": { type: "boolean", default: false },
      write: { type: "boolean", default: false },
      "allow-branch": { type: "string" },
    },
  });
  const provenance = values.write ? harnessProvenance({ allowBranch: values["allow-branch"] }) : undefined;
  const only = values.only?.split(",").map((id) => id.trim());
  const unknown = (only ?? []).filter((id) => !EXERCISES.some((exercise) => exercise.id === id));
  if (unknown.length > 0) throw new Error(`unknown exercises: ${unknown.join(", ")}`);
  const exercises = EXERCISES.filter((exercise) => only === undefined || only.includes(exercise.id));

  const work = join(REPO_ROOT, ".work", "ops");
  mkdirSync(work, { recursive: true });
  const reportFile = join(work, "vitest.json");
  const observationsFile = join(work, "observations.jsonl");
  rmSync(reportFile, { force: true });
  rmSync(observationsFile, { force: true });

  const files = testFiles(exercises);
  log(`running ${exercises.length} exercises from ${files.length} test files`);
  const startedAt = new Date().toISOString();
  const run = spawnSync(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${reportFile}`,
      ...files,
    ],
    {
      cwd: REPO_ROOT,
      // Vitest's own output goes to stderr, so stdout carries only the evidence document.
      stdio: ["ignore", 2, 2],
      env: { ...process.env, RAIL402_OPS_RECORD: observationsFile },
    },
  );
  if (!existsSync(reportFile)) {
    throw new Error(
      `vitest wrote no report (exit ${String(run.status)}${run.error ? `: ${run.error.message}` : ""})`,
    );
  }
  const report = JSON.parse(readFileSync(reportFile, "utf8")) as VitestReport;
  const cases = exerciseCases(exercises, report, readObservations(observationsFile));
  for (const entry of cases) {
    log(
      `${entry.status.toUpperCase()} ${entry.id}${entry.skipReason === undefined ? "" : `: ${entry.skipReason}`}`,
    );
  }

  const incomplete = incompleteRun(cases, values["allow-skips"]);
  for (const problem of incomplete) log(problem);

  const packages = versions(["@x402/core", "@x402/stellar", "@stellar/stellar-sdk", "@rail402.dev/service"]);
  const evidence: Evidence = buildEvidence(
    {
      kind: "ops",
      // Without --write the document is printed only; its commit may then describe a dirty tree.
      provenance: provenance ?? { commit: gitCommit().replace(/-dirty$/, ""), dirty: false },
      network: "stellar:testnet",
      // Each test starts its own facilitators and service processes on this machine.
      target: {
        mode: "local",
        facilitatorUrl: "http://127.0.0.1",
        healthVersion: packages["@rail402.dev/service"] ?? "unknown",
        supported: null,
      },
      packages,
      command:
        "node --conditions=@rail402/source tools/conformance/src/ops.ts" +
        (only === undefined ? "" : ` --only ${only.join(",")}`),
      config: {
        network: "private Stellar network with the testnet passphrase",
        rpc: LOCAL_RPC_URL,
        store: "memory and Postgres, per test",
        testFiles: files.length,
      },
      accounts: {},
      startedAt,
    },
    cases,
  );
  if (provenance === undefined || incomplete.length > 0) {
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
    if (provenance !== undefined) log("nothing was recorded: the run is incomplete");
  } else {
    recheckProvenance(provenance, { allowBranch: values["allow-branch"] });
    log(
      `evidence written to ${writeEvidence(evidence, { file: OPS_EVIDENCE_FILE, allowBranch: values["allow-branch"] })}`,
    );
  }
  if (incomplete.length > 0 || cases.some((entry) => entry.status === "failed")) process.exit(1);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
