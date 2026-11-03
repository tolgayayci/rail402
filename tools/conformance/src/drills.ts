/**
 * Recovery drills: a fault is injected into a running deployment, the alert that should fire is
 * awaited, the runbook's steps are followed, and the time to detect and to recover is measured. Each
 * run is one file per environment and network, one case per exercise, with `observations.drill` in the
 * shape `drillObservationSchema` defines and `drillProblems` checks.
 *
 * Local runs (`drills-local.ts`, a production-like stack on the private network) are written to
 * `tools/conformance/drills/`; runs against a deployed service go to the evidence directory once the
 * evidence format carries the `drill` kind.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ALERTS } from "../../../deploy/monitoring/alerts.ts";
import { allRegistered } from "./codes-coverage.ts";
import { REPO_ROOT, findLocalPaths, findSecrets, harnessProvenance, type Provenance } from "./evidence.ts";
import { loadThreats } from "./threats.ts";

export const DRILLS_DIR = "tools/conformance/drills";

export const EXERCISES = [
  "signer-rotation",
  "rpc-failure",
  "rpc-failover",
  "sequence-conflict",
  "expired-authorization",
  "channel-exhaustion",
  "sponsor-depletion",
  "degraded-indexing-bazaar",
  "degraded-indexing-explorer",
] as const;
export type Exercise = (typeof EXERCISES)[number];

export interface DrillDefinition {
  readonly exercise: Exercise;
  readonly title: string;
  readonly threats: readonly string[];
  /** The alert expected to fire, or "manual" when the condition is found by a person or a client. */
  readonly alert: string;
  /** `docs/runbook.mdx#anchor` with the recovery procedure. */
  readonly runbook: string;
}

export const DRILLS: readonly DrillDefinition[] = [
  {
    exercise: "signer-rotation",
    title: "Rotate the fee sponsor",
    threats: ["O6"],
    alert: "manual",
    runbook: "docs/runbook.mdx#signer-rotation",
  },
  {
    exercise: "rpc-failure",
    title: "The RPC stops answering",
    threats: ["O3"],
    alert: "Rail402NotReady",
    runbook: "docs/runbook.mdx#rpc-failure",
  },
  {
    exercise: "rpc-failover",
    title: "The primary RPC provider fails and the secondary takes over",
    threats: ["O3"],
    alert: "Rail402RpcFailover",
    runbook: "docs/runbook.mdx#rpc-failure",
  },
  {
    exercise: "sequence-conflict",
    title: "A channel's sequence used outside the service",
    threats: ["O2"],
    alert: "Rail402SequenceConflict",
    runbook: "docs/runbook.mdx#sequence-conflicts",
  },
  {
    exercise: "expired-authorization",
    title: "A payment settled after its authorization expired",
    threats: ["E4"],
    alert: "manual",
    runbook: "docs/runbook.mdx#expired-authorizations",
  },
  {
    exercise: "channel-exhaustion",
    title: "More settlements than channel accounts",
    threats: ["O5"],
    alert: "Rail402ChannelLeaseTimeouts",
    runbook: "docs/runbook.mdx#channel-pool-exhaustion",
  },
  {
    exercise: "sponsor-depletion",
    title: "The fee sponsor runs low and is topped up",
    threats: ["S5"],
    alert: "Rail402SponsorBalanceLow",
    runbook: "docs/runbook.mdx#sponsor-depletion",
  },
  {
    exercise: "degraded-indexing-bazaar",
    title: "The embedding model is missing at a restart",
    threats: ["O7"],
    alert: "Rail402Down",
    runbook: "docs/runbook.mdx#degraded-indexing",
  },
  {
    exercise: "degraded-indexing-explorer",
    title: "The Explorer indexer falls behind",
    threats: ["O7"],
    alert: "Rail402ExplorerLag",
    runbook: "docs/runbook.mdx#degraded-indexing",
  },
];

const timestamp = z.iso.datetime({ offset: true });

export const drillObservationSchema = z.strictObject({
  exercise: z.enum(EXERCISES),
  environment: z.enum(["hosted-testnet", "hosted-pubnet", "local"]),
  threats: z.array(z.string().min(1)).min(1),
  fault: z.strictObject({ method: z.string().min(1), injectedAt: timestamp, clearedAt: timestamp }),
  detection: z.strictObject({
    alert: z.string().min(1),
    severity: z.enum(["page", "ticket"]),
    source: z.enum(["alertmanager", "status-page", "manual"]),
    firedAt: timestamp.nullable(),
  }),
  runbook: z.strictObject({
    section: z.string().regex(/^docs\/[\w./-]+#[a-z0-9-]+$/),
    steps: z.array(z.string().min(1)).min(1),
  }),
  recovery: z.strictObject({ completedAt: timestamp, verifiedBy: z.array(z.string().min(1)).min(1) }),
  timings: z.strictObject({ detectSeconds: z.number().min(0).nullable(), recoverSeconds: z.number().min(0) }),
  impact: z.strictObject({
    failedRequests: z.number().int().min(0),
    refusedCodes: z.array(z.string().min(1)),
    fundsAtRisk: z.string().min(1),
  }),
});
export type DrillObservation = z.infer<typeof drillObservationSchema>;

/** One recovery check the drill ran: what was checked and whether it held. A drill passes only when all hold. */
export const drillCheckSchema = z.strictObject({ name: z.string().min(1), ok: z.boolean() });
export type DrillCheck = z.infer<typeof drillCheckSchema>;

/** In one-process mode: the other network's state while the fault lasted; null on a one-network stack. */
export const otherNetworkSchema = z
  .strictObject({ network: z.string().min(1), readyDuring: z.boolean(), settled: z.number().int().min(0) })
  .nullable();

const drillCase = z.strictObject({
  id: z.enum(EXERCISES),
  title: z.string().min(1),
  status: z.enum(["passed", "failed", "skipped"]),
  skipReason: z.string().min(1).optional(),
  /** Why a drill could not run to its end; such a case is failed. */
  error: z.string().min(1).optional(),
  elapsedMs: z.number().min(0),
  transactions: z
    .array(z.strictObject({ hash: z.string().regex(/^[0-9a-f]{64}$/), role: z.string().min(1) }))
    .optional(),
  observations: z
    .strictObject({
      drill: drillObservationSchema,
      otherNetwork: otherNetworkSchema,
      /** The recovery checks behind `drill.recovery.verifiedBy`, each with its outcome. */
      checks: z.array(drillCheckSchema).min(1),
      notes: z.array(z.string()).optional(),
    })
    .optional(),
});
export type DrillCase = z.infer<typeof drillCase>;

export const drillRunSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("drill"),
  environment: z.enum(["hosted-testnet", "hosted-pubnet", "local"]),
  network: z.enum(["stellar:testnet", "stellar:pubnet"]),
  startedAt: timestamp,
  finishedAt: timestamp,
  harness: z.strictObject({
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    branch: z.string().min(1).optional(),
  }),
  command: z.string().min(1),
  /** How the stack ran: images, rule evaluation, anything that differs from production. */
  stack: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  summary: z.strictObject({
    total: z.number().int(),
    passed: z.number().int(),
    failed: z.number().int(),
    skipped: z.number().int(),
  }),
  cases: z.array(drillCase),
});
export type DrillRun = z.infer<typeof drillRunSchema>;

/** The anchors of a Markdown page: its headings, lower-cased with spaces as dashes. */
export function anchorsOf(text: string): Set<string> {
  return new Set(
    [...text.matchAll(/^#{2,4} (.+)$/gm)].map((match) =>
      (match[1] ?? "")
        .toLowerCase()
        .replace(/[`*]/g, "")
        .replace(/[^a-z0-9 -]/g, "")
        .trim()
        .replace(/ +/g, "-"),
    ),
  );
}

const ms = (iso: string) => Date.parse(iso);

/** An alert-detected drill whose alert never fired; a manual detection has no alert to wait for. */
function detectionMissed(drill: DrillObservation): boolean {
  return drill.detection.source !== "manual" && drill.detection.firedAt === null;
}

/** Every rule one drill case breaks, beyond its schema. */
export function drillProblems(entry: DrillCase, root = REPO_ROOT): string[] {
  const problems: string[] = [];
  const at = entry.id;
  if (entry.status === "skipped") {
    if (entry.skipReason === undefined) problems.push(`${at}: a skipped drill needs a skipReason`);
    return problems;
  }
  const drill = entry.observations?.drill;
  if (drill === undefined) {
    return entry.status === "failed" && entry.error !== undefined
      ? []
      : [`${at}: a recorded drill needs observations.drill`];
  }
  if (drill.exercise !== entry.id) problems.push(`${at}: observations.drill.exercise is ${drill.exercise}`);
  const checks = entry.observations?.checks ?? [];
  const failedChecks = checks.filter((check) => !check.ok);
  if (entry.status === "passed") {
    for (const check of failedChecks)
      problems.push(`${at}: passed although the check "${check.name}" failed`);
    if (detectionMissed(drill)) problems.push(`${at}: passed although the alert never fired`);
  } else if (failedChecks.length === 0 && !detectionMissed(drill)) {
    problems.push(`${at}: failed although every check held and the alert fired`);
  }
  const verified = new Set(drill.recovery.verifiedBy);
  for (const check of checks) {
    if (!verified.has(check.name))
      problems.push(`${at}: the check "${check.name}" is missing from recovery.verifiedBy`);
  }
  const definition = DRILLS.find((candidate) => candidate.exercise === entry.id);
  const threatIds = new Set(loadThreats(root).threats.map((threat) => threat.id));
  for (const id of drill.threats) if (!threatIds.has(id)) problems.push(`${at}: unknown threat ${id}`);
  const { fault, detection, recovery } = drill;
  if (ms(fault.injectedAt) > ms(fault.clearedAt))
    problems.push(`${at}: the fault was cleared before it was injected`);
  if (ms(recovery.completedAt) < ms(fault.injectedAt))
    problems.push(`${at}: recovered before the fault was injected`);
  if (detection.firedAt !== null) {
    if (ms(detection.firedAt) < ms(fault.injectedAt))
      problems.push(`${at}: the alert fired before the fault`);
    if (ms(detection.firedAt) > ms(recovery.completedAt))
      problems.push(`${at}: the alert fired after recovery`);
  }
  if (detection.source === "alertmanager") {
    if (!ALERTS.some((alert) => alert.name === detection.alert))
      problems.push(`${at}: unknown alert ${detection.alert}`);
    if (definition !== undefined && definition.alert !== detection.alert) {
      problems.push(`${at}: expected alert ${definition.alert}, recorded ${detection.alert}`);
    }
  }
  const registered = new Set(allRegistered());
  for (const code of drill.impact.refusedCodes) {
    if (!registered.has(code)) problems.push(`${at}: refused code ${code} is not registered`);
  }
  const [page = "", anchor = ""] = drill.runbook.section.split("#");
  const file = join(root, page);
  if (!existsSync(file)) problems.push(`${at}: runbook page ${page} does not exist`);
  else if (!anchorsOf(readFileSync(file, "utf8")).has(anchor))
    problems.push(`${at}: ${page} has no section #${anchor}`);
  return problems;
}

/** Every rule a drill run breaks: its schema, its summary and each case. */
export function drillRunProblems(value: unknown, root = REPO_ROOT): string[] {
  const parsed = drillRunSchema.safeParse(value);
  if (!parsed.success) return parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
  const run = parsed.data;
  const problems: string[] = [];
  const count = (status: DrillCase["status"]) => run.cases.filter((entry) => entry.status === status).length;
  const expected = {
    total: run.cases.length,
    passed: count("passed"),
    failed: count("failed"),
    skipped: count("skipped"),
  };
  for (const key of ["total", "passed", "failed", "skipped"] as const) {
    if (run.summary[key] !== expected[key])
      problems.push(`summary.${key} is ${run.summary[key]}, the cases give ${expected[key]}`);
  }
  if (new Set(run.cases.map((entry) => entry.id)).size !== run.cases.length)
    problems.push("duplicate exercise");
  problems.push(...findSecrets(value), ...findLocalPaths(value));
  for (const entry of run.cases) {
    if (
      entry.observations?.drill.environment !== undefined &&
      entry.observations.drill.environment !== run.environment
    ) {
      problems.push(
        `${entry.id}: recorded in ${entry.observations.drill.environment}, the run is ${run.environment}`,
      );
    }
    problems.push(...drillProblems(entry, root));
  }
  return problems;
}

export function drillRunFile(environment: DrillRun["environment"], network: DrillRun["network"]): string {
  return `${DRILLS_DIR}/${environment}-${network.replace(":", "-")}.json`;
}

export function loadDrillRun(path: string, root = REPO_ROOT): DrillRun {
  return drillRunSchema.parse(JSON.parse(readFileSync(join(root, path), "utf8")));
}

/** Checks and writes a run; the checkout must be clean and on main or on `allowBranch`. */
export function writeDrillRun(
  run: DrillRun,
  options: { allowBranch?: string; provenance?: Provenance } = {},
): string {
  const problems = drillRunProblems(run);
  if (problems.length > 0) throw new Error(`the drill run is invalid:\n  ${problems.join("\n  ")}`);
  const provenance =
    options.provenance ??
    harnessProvenance(options.allowBranch === undefined ? {} : { allowBranch: options.allowBranch });
  if (provenance.commit !== run.harness.commit)
    throw new Error("harness.commit is not the checked-out commit");
  const path = drillRunFile(run.environment, run.network);
  mkdirSync(join(REPO_ROOT, DRILLS_DIR), { recursive: true });
  writeFileSync(join(REPO_ROOT, path), `${JSON.stringify(run, null, 2)}\n`);
  return path;
}

export function summarize(cases: readonly DrillCase[]): DrillRun["summary"] {
  const count = (status: DrillCase["status"]) => cases.filter((entry) => entry.status === status).length;
  return { total: cases.length, passed: count("passed"), failed: count("failed"), skipped: count("skipped") };
}

const VERDICT: Readonly<Record<DrillCase["status"], string>> = {
  passed: "Passed",
  failed: "Failed",
  skipped: "Skipped",
};

/** Markdown for a recorded drill run: one row per exercise, then the steps and checks of each. */
export function renderDrillRun(path: string, run: DrillRun | undefined): string {
  if (run === undefined) return `No drill run has been recorded yet (\`${path}\`).`;
  const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const rows = run.cases.map((entry) => {
    const drill = entry.observations?.drill;
    const detect = drill?.timings.detectSeconds ?? null;
    return `| ${entry.id} | ${VERDICT[entry.status]} | ${drill === undefined ? "—" : cell(drill.detection.source === "manual" ? "found by a person or client" : drill.detection.alert)} | ${detect === null ? "—" : `${String(detect)} s`} | ${drill === undefined ? "—" : `${String(drill.timings.recoverSeconds)} s`} | ${drill === undefined ? cell(entry.skipReason ?? entry.error ?? "") : cell(drill.impact.refusedCodes.join(", ") || "none")} |`;
  });
  const details = run.cases
    .filter((entry) => entry.observations !== undefined)
    .map((entry) => {
      const drill = entry.observations?.drill;
      if (drill === undefined) return "";
      return [
        `### ${entry.id}: ${cell(entry.title)}`,
        `**Fault.** ${cell(drill.fault.method)}. **Runbook:** [${drill.runbook.section.split("#")[1] ?? ""}](/runbook#${drill.runbook.section.split("#")[1] ?? ""}).`,
        ["**Steps**", "", ...drill.runbook.steps.map((step) => `- ${cell(step)}`)].join("\n"),
        [
          "**Recovery checked by**",
          "",
          ...(entry.observations?.checks ?? []).map(
            (check) => `- ${check.ok ? "held" : "**failed**"}: ${cell(check.name)}`,
          ),
        ].join("\n"),
        ...(entry.observations?.notes ?? []).map((note) => `_${cell(note)}_`),
      ].join("\n\n");
    });
  return [
    `From \`${path}\` (${run.environment}, ${run.network}), ${run.startedAt.slice(0, 10)}: **${String(run.summary.passed)} of ${String(run.summary.total)} drills passed**${run.summary.failed > 0 ? `, ${String(run.summary.failed)} failed` : ""}${run.summary.skipped > 0 ? `, ${String(run.summary.skipped)} skipped` : ""}. Rules: ${cell(String(run.stack["rules"] ?? ""))}.`,
    "| Exercise | Result | Detected by | Detect | Recover | Refusals seen |\n| --- | --- | --- | --- | --- | --- |\n" +
      rows.join("\n"),
    ...details,
  ].join("\n\n");
}

/** The drills block of the operational tests page: the recorded local run, if any. */
export function renderLocalDrills(root = REPO_ROOT): string {
  const path = drillRunFile("local", "stellar:testnet");
  return renderDrillRun(path, existsSync(join(root, path)) ? loadDrillRun(path, root) : undefined);
}
