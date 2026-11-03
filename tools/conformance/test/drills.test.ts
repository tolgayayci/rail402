import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ALERTS } from "../../../deploy/monitoring/alerts.ts";
import {
  DRILLS,
  EXERCISES,
  anchorsOf,
  drillProblems,
  drillRunFile,
  drillRunProblems,
  summarize,
  type DrillCase,
} from "../src/drills.ts";
import { drillRules } from "../src/drills-local.ts";
import { REPO_ROOT } from "../src/evidence.ts";

const recorded: DrillCase = {
  id: "rpc-failure",
  title: "The RPC stops answering",
  status: "passed",
  elapsedMs: 40_000,
  observations: {
    drill: {
      exercise: "rpc-failure",
      environment: "local",
      threats: ["O3"],
      fault: {
        method: "the RPC answers 503",
        injectedAt: "2026-10-22T10:00:00Z",
        clearedAt: "2026-10-22T10:00:30Z",
      },
      detection: {
        alert: "Rail402NotReady",
        severity: "page",
        source: "alertmanager",
        firedAt: "2026-10-22T10:00:20Z",
      },
      runbook: { section: "docs/runbook.mdx#rpc-failure", steps: ["read /ready"] },
      recovery: { completedAt: "2026-10-22T10:00:45Z", verifiedBy: ["/ready 200"] },
      timings: { detectSeconds: 20, recoverSeconds: 45 },
      impact: { failedRequests: 0, refusedCodes: [], fundsAtRisk: "none" },
    },
    otherNetwork: null,
    checks: [{ name: "/ready 200", ok: true }],
  },
};
const drill = recorded.observations?.drill;
if (drill === undefined) throw new Error("fixture");
const withDrill = (changes: Partial<typeof drill>): DrillCase => ({
  ...recorded,
  observations: {
    drill: { ...drill, ...changes },
    otherNetwork: null,
    checks: [{ name: "/ready 200", ok: true }],
  },
});

describe("the drill catalog", () => {
  it("covers every exercise once, with known threats, alerts and runbook sections", () => {
    expect(DRILLS.map((entry) => entry.exercise)).toEqual([...EXERCISES]);
    const runbook = anchorsOf(readFileSync(join(REPO_ROOT, "docs/runbook.mdx"), "utf8"));
    for (const entry of DRILLS) {
      expect(
        entry.alert === "manual" || ALERTS.some((alert) => alert.name === entry.alert),
        entry.exercise,
      ).toBe(true);
      expect(runbook.has(entry.runbook.split("#")[1] ?? ""), entry.runbook).toBe(true);
    }
  });

  it("runs the committed rules with their hold times removed", () => {
    const rules = drillRules();
    expect(rules).not.toMatch(/for: (?!0s)/);
    expect(rules.match(/- alert: /g)).toHaveLength(ALERTS.length);
  });

  it("shortens the Explorer's stall window, which a drill cannot wait an hour for", () => {
    const lag = drillRules()
      .split("- alert: ")
      .find((rule) => rule.startsWith("Rail402ExplorerLag"));
    expect(lag).toContain("changes(rail402_explorer_last_ledger[20s]) == 0");
    expect(lag).not.toContain("[1h]");
  });
});

describe("drill checks", () => {
  it("records an injected failure from alert to recovery", () => {
    expect(drillProblems(recorded)).toEqual([]);
  });

  it("refuse an alert that never fired, timestamps out of order and unknown references", () => {
    expect(
      drillProblems(withDrill({ detection: { ...drill.detection, firedAt: null }, threats: ["Z9"] })),
    ).toEqual(["rpc-failure: passed although the alert never fired", "rpc-failure: unknown threat Z9"]);
    expect(
      drillProblems(withDrill({ detection: { ...drill.detection, firedAt: "2026-10-22T09:59:00Z" } })),
    ).toEqual(["rpc-failure: the alert fired before the fault"]);
    expect(
      drillProblems(
        withDrill({
          runbook: { section: "docs/runbook.mdx#nowhere", steps: ["x"] },
          impact: { failedRequests: 1, refusedCodes: ["not_a_code"], fundsAtRisk: "none" },
          detection: { ...drill.detection, alert: "Rail402RpcStale" },
        }),
      ),
    ).toEqual([
      "rpc-failure: expected alert Rail402NotReady, recorded Rail402RpcStale",
      "rpc-failure: refused code not_a_code is not registered",
      "rpc-failure: docs/runbook.mdx has no section #nowhere",
    ]);
  });

  it("fail a drill whose recovery check did not hold, and keep the verdict consistent with its checks", () => {
    const failing: DrillCase = {
      ...recorded,
      observations: {
        drill,
        otherNetwork: null,
        checks: [
          { name: "/ready 200", ok: true },
          { name: "settle exact succeeded", ok: false },
        ],
      },
    };
    expect(drillProblems(failing)).toEqual([
      'rpc-failure: passed although the check "settle exact succeeded" failed',
      'rpc-failure: the check "settle exact succeeded" is missing from recovery.verifiedBy',
    ]);
    const honest: DrillCase = {
      ...failing,
      status: "failed",
      observations: {
        drill: {
          ...drill,
          recovery: { ...drill.recovery, verifiedBy: ["/ready 200", "settle exact succeeded"] },
        },
        otherNetwork: null,
        checks: failing.observations?.checks ?? [],
      },
    };
    expect(drillProblems(honest)).toEqual([]);
    expect(drillProblems({ ...recorded, status: "failed" })).toEqual([
      "rpc-failure: failed although every check held and the alert fired",
    ]);
  });

  it("accept a manual detection without an alert time, and a failed run with its error", () => {
    expect(
      drillProblems(withDrill({ detection: { ...drill.detection, source: "manual", firedAt: null } })),
    ).toEqual([]);
    expect(
      drillProblems({ id: "rpc-failure", title: "x", status: "failed", elapsedMs: 0, error: "boom" }),
    ).toEqual([]);
    expect(drillProblems({ id: "rpc-failure", title: "x", status: "skipped", elapsedMs: 0 })).toEqual([
      "rpc-failure: a skipped drill needs a skipReason",
    ]);
  });

  it("check a whole run's summary and environment", () => {
    const run = {
      schemaVersion: 1,
      kind: "drill",
      environment: "hosted-testnet",
      network: "stellar:testnet",
      startedAt: "2026-10-22T10:00:00Z",
      finishedAt: "2026-10-22T11:00:00Z",
      harness: { commit: "a".repeat(40) },
      command: "drills",
      stack: {},
      summary: { ...summarize([recorded]), passed: 0 },
      cases: [recorded],
    };
    expect(drillRunProblems(run)).toEqual([
      "summary.passed is 0, the cases give 1",
      "rpc-failure: recorded in local, the run is hosted-testnet",
    ]);
    expect(drillRunFile("local", "stellar:testnet")).toBe(
      "tools/conformance/drills/local-stellar-testnet.json",
    );
  });

  it("keeps the recorded local run valid", () => {
    const file = join(REPO_ROOT, drillRunFile("local", "stellar:testnet"));
    if (!existsSync(file)) return;
    const run = JSON.parse(readFileSync(file, "utf8")) as { harness: Record<string, unknown> };
    expect(drillRunProblems(run)).toEqual([]);
    // A rehearsal written from another branch names it; a committed record names only its commit.
    expect(Object.keys(run.harness)).toEqual(["commit"]);
  });
});
