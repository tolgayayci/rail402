/**
 * Markdown for the security pages: the threat model's tables from docs/security/threats.json, and the
 * operational test report from the exercise list and the recorded `ops` evidence. Deterministic: the
 * output depends only on the registry, the exercise list and the committed evidence.
 */
import type { EvidenceSet } from "./evidence-set.ts";
import type { Evidence, EvidenceCase, EvidenceKind } from "./evidence.ts";
import { EVIDENCE_DIR } from "./evidence.ts";
import { OPS_EVIDENCE_FILE, type OpsExercise, type TestOutcome } from "./ops-exercises.ts";
import {
  REPOSITORY_URL,
  code,
  commitLink,
  day,
  escape,
  integer,
  packageList,
  table,
} from "./render-evidence.ts";
import {
  STRIDE_NAMES,
  parseCodeRef,
  parseEvidenceRef,
  parseTestRef,
  type Threat,
  type ThreatRegistry,
} from "./threats.ts";

const STATUS_LABEL: Readonly<Record<Threat["status"], string>> = {
  mitigated: "Mitigated",
  accepted: "Accepted risk",
  open: "Open",
};

/** The evidence kind a conformance harness writes. */
const HARNESS_KINDS: Readonly<Record<string, EvidenceKind>> = {
  canonical: "canonical",
  "live-matrix": "live-matrix",
  "live-bazaar": "live-bazaar",
  concurrency: "concurrency",
  "fault-recovery": "fault-recovery",
  "rejection-audit": "rejection-audit",
};

function sourceLink(path: string): string {
  return `[${code(path)}](${REPOSITORY_URL}/blob/main/${path})`;
}

function testLine(ref: string): string {
  const { path, name } = parseTestRef(ref);
  return `${sourceLink(path)}: ${escape(name)}`;
}

function evidenceLine(ref: string): string {
  const { harness, id } = parseEvidenceRef(ref);
  return `${code(harness)} case ${code(id)}`;
}

function stride(entry: Threat): string {
  return entry.stride.map((letter) => STRIDE_NAMES[letter]).join(", ");
}

export function renderAssets(registry: ThreatRegistry): string {
  return table(
    ["Asset", "What is protected"],
    registry.assets.map((asset) => [escape(asset.name), escape(asset.description)]),
  );
}

export function renderBoundaries(registry: ThreatRegistry): string {
  return table(
    ["Boundary", "Between", "What crosses it"],
    registry.boundaries.map((boundary) => [boundary.id, escape(boundary.name), escape(boundary.description)]),
  );
}

export function renderThreatSummary(registry: ThreatRegistry): string {
  const topics = new Map(registry.topics.map((topic) => [topic.id, topic.title]));
  return table(
    ["ID", "Topic", "Threat", "STRIDE", "Status", "Tests"],
    registry.threats.map((entry) => [
      entry.id,
      escape(topics.get(entry.topic) ?? entry.topic),
      escape(entry.title),
      entry.stride.join(""),
      STATUS_LABEL[entry.status],
      String(entry.tests.length),
    ]),
  );
}

/** Every threat of one topic, each with its analysis, mitigations, tests and residual risk. */
export function renderTopic(registry: ThreatRegistry, topic: string): string {
  const assets = new Map(registry.assets.map((asset) => [asset.id, asset.name]));
  const boundaries = new Map(registry.boundaries.map((boundary) => [boundary.id, boundary.name]));
  const threats = registry.threats.filter((entry) => entry.topic === topic);
  if (threats.length === 0) throw new Error(`no threats for topic "${topic}"`);
  return threats
    .map((entry) => {
      const parts = [
        `### ${entry.id}. ${escape(entry.title)}`,
        `${STATUS_LABEL[entry.status]} · ${escape(stride(entry))} · boundary ${entry.boundary} (${escape(boundaries.get(entry.boundary) ?? "")}) · asset: ${escape(assets.get(entry.asset) ?? entry.asset)}`,
        `**Threat.** ${escape(entry.threat)}`,
        `**What Stellar makes different.** ${escape(entry.stellar)}`,
        `**Preconditions.** ${escape(entry.preconditions)} **Impact.** ${escape(entry.impact)}`,
        [
          "**Mitigations**",
          "",
          ...entry.mitigations.map((mitigation) => {
            const { path, symbol } = parseCodeRef(mitigation.code);
            return `- ${escape(mitigation.text)} (${sourceLink(path)}, ${code(symbol)})`;
          }),
        ].join("\n"),
        entry.tests.length === 0
          ? "**Tests.** None: this is a documented limit, not a behaviour Rail402 implements."
          : ["**Tests**", "", ...entry.tests.map((ref) => `- ${testLine(ref)}`)].join("\n"),
        ...(entry.evidence.length === 0
          ? []
          : [`**Conformance runs.** ${entry.evidence.map(evidenceLine).join(", ")}.`]),
        `**Residual risk.** ${escape(entry.residual)}`,
      ];
      return parts.join("\n\n");
    })
    .join("\n\n");
}

// --- operational test report ---------------------------------------------------------------------

function opsRun(set: EvidenceSet): { file: string; evidence: Evidence } | undefined {
  const loaded = set.files.find((file) => file.file === OPS_EVIDENCE_FILE);
  return loaded?.format === "current" ? { file: loaded.file, evidence: loaded.evidence } : undefined;
}

/** The recorded outcome of a conformance case, or undefined when no current-format run holds it. */
function harnessCase(set: EvidenceSet, ref: string): { file: string; entry: EvidenceCase } | undefined {
  const { harness, id } = parseEvidenceRef(ref);
  const kind = HARNESS_KINDS[harness];
  for (const loaded of set.files) {
    if (loaded.format !== "current" || loaded.kind !== kind) continue;
    const entry = loaded.evidence.cases.find((candidate) => candidate.id === id);
    if (entry !== undefined) return { file: loaded.file, entry };
  }
  return undefined;
}

const VERDICT: Readonly<Record<EvidenceCase["status"], string>> = {
  passed: "Passed",
  failed: "Failed",
  skipped: "Skipped",
};

export function renderOpsRun(set: EvidenceSet): string {
  const run = opsRun(set);
  if (run === undefined) {
    return `No run has been recorded yet (\`${EVIDENCE_DIR}/${OPS_EVIDENCE_FILE}\`). Every exercise below lists the tests that run it; the observed outcome appears here once \`ops.ts --write\` has recorded a run.`;
  }
  const { evidence } = run;
  const { summary } = evidence;
  return [
    `From ${code(`${EVIDENCE_DIR}/${run.file}`)}: **${summary.passed} of ${summary.total} exercises passed**${summary.failed > 0 ? `, ${summary.failed} failed` : ""}${summary.skipped > 0 ? `, ${summary.skipped} skipped` : ""}.`,
    table(
      ["Field", "Value"],
      [
        ["Date", `${day(evidence.startedAt)} to ${day(evidence.finishedAt)}`],
        ["Rail402 commit", commitLink(evidence.harness.commit)],
        ["Packages", packageList(evidence.packages)],
        ["Command", code(evidence.command)],
      ],
    ),
  ].join("\n\n");
}

export function renderExerciseSummary(exercises: readonly OpsExercise[], set: EvidenceSet): string {
  const run = opsRun(set);
  return table(
    ["Exercise", "Threats", "Environment", "Local run", "Testnet"],
    exercises.map((exercise) => {
      const local = run?.evidence.cases.find((entry) => entry.id === exercise.id);
      const testnet = (exercise.testnet ?? []).map((ref) => harnessCase(set, ref));
      const recorded = testnet.filter((found) => found !== undefined);
      return [
        `${code(exercise.id)} ${escape(exercise.title)}`,
        exercise.threats.join(", "),
        escape(exercise.environment),
        local === undefined ? "not recorded" : VERDICT[local.status],
        exercise.testnet === undefined
          ? "n/a"
          : recorded.length === 0
            ? "not recorded"
            : `${recorded.filter((found) => found.entry.status === "passed").length} of ${testnet.length} passed`,
      ];
    }),
  );
}

function observedLines(entry: EvidenceCase): string[] {
  const observations = entry.observations as
    { tests?: { test: string; results: TestOutcome[] }[]; recorded?: Record<string, unknown>[] } | undefined;
  const lines: string[] = [];
  for (const test of observations?.tests ?? []) {
    const { name } = parseTestRef(test.test);
    const results = test.results;
    const passed = results.filter((result) => result.status === "passed").length;
    const seconds = results.reduce((sum, result) => sum + result.durationMs, 0) / 1000;
    lines.push(
      `- ${escape(name)}: ${results.length === 0 ? "no result" : `${passed} of ${results.length} passed in ${seconds.toFixed(1)} s`}`,
    );
  }
  for (const recorded of observations?.recorded ?? []) {
    const facts = Object.entries(recorded).map(
      ([key, value]) => `${escape(key)} ${code(typeof value === "string" ? value : JSON.stringify(value))}`,
    );
    lines.push(`- Recorded: ${facts.join(", ")}`);
  }
  return lines;
}

/** Each exercise: what it does, what it must show, the tests that run it, and what was observed. */
export function renderExercises(exercises: readonly OpsExercise[], set: EvidenceSet): string {
  const run = opsRun(set);
  return exercises
    .map((exercise) => {
      const local = run?.evidence.cases.find((entry) => entry.id === exercise.id);
      const parts = [
        `### ${code(exercise.id)} ${escape(exercise.title)}`,
        `Threats ${exercise.threats.join(", ")} · ${escape(exercise.environment)}`,
        `**Procedure.** ${escape(exercise.procedure)}`,
        `**Expected.** ${escape(exercise.expected)}`,
        [
          "**Tests**",
          "",
          ...exercise.tests.map(
            (test) =>
              `- ${sourceLink(test.file)}: ${escape(test.name)}${test.runIn === undefined ? "" : ` (run by ${code(test.runIn)})`}`,
          ),
        ].join("\n"),
        local === undefined
          ? "**Observed.** Not recorded yet."
          : [
              `**Observed.** ${VERDICT[local.status]}${local.skipReason === undefined ? "" : `: ${escape(local.skipReason)}`} (${integer(local.elapsedMs)} ms).`,
              "",
              ...observedLines(local),
            ].join("\n"),
      ];
      if (exercise.testnet !== undefined) {
        const rows = exercise.testnet.map((ref) => {
          const found = harnessCase(set, ref);
          return found === undefined
            ? `- ${evidenceLine(ref)}: not recorded in the current evidence format yet`
            : `- ${evidenceLine(ref)}: ${VERDICT[found.entry.status]} (${code(`${EVIDENCE_DIR}/${found.file}`)})`;
        });
        parts.push(["**On the public testnet**", "", ...rows].join("\n"));
      }
      return parts.join("\n\n");
    })
    .join("\n\n");
}
