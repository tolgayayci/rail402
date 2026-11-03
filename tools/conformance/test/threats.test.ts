import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/evidence.ts";
import { EXERCISES } from "../src/ops-exercises.ts";
import {
  REQUIRED_TOPICS,
  citationProblems,
  harnessDeclares,
  loadThreats,
  type Threat,
  type ThreatRegistry,
} from "../src/threats.ts";

const registry = loadThreats();

describe("the threat registry", () => {
  it("cites only files, symbols, tests and conformance cases that exist", () => {
    expect(citationProblems(registry)).toEqual([]);
  });

  it("covers every required topic with at least one tested threat", () => {
    for (const topic of REQUIRED_TOPICS) {
      const tested = registry.threats.filter((entry) => entry.topic === topic && entry.tests.length > 0);
      expect(tested.length, topic).toBeGreaterThan(0);
    }
  });

  it("gives every threat a mitigation, and a test unless it is an accepted limit", () => {
    for (const entry of registry.threats) {
      expect(entry.mitigations.length, entry.id).toBeGreaterThan(0);
      if (entry.status !== "accepted") expect(entry.tests.length, entry.id).toBeGreaterThan(0);
    }
  });

  // Ids are reserved per topic before parallel work lands, so a topic's numbers ascend but may skip a
  // reserved id that is not in the registry yet.
  it("names threats after their topic, in order", () => {
    const prefixes = new Map<string, string>();
    for (const entry of registry.threats) {
      const prefix = entry.id.replace(/\d+$/, "");
      const topic = prefixes.get(prefix);
      if (topic === undefined) prefixes.set(prefix, entry.topic);
      else expect(topic, entry.id).toBe(entry.topic);
    }
    for (const prefix of prefixes.keys()) {
      const numbers = registry.threats
        .filter((entry) => entry.id.replace(/\d+$/, "") === prefix)
        .map((entry) => Number(entry.id.slice(prefix.length)));
      expect(numbers, prefix).toEqual([...numbers].sort((a, b) => a - b));
      expect(new Set(numbers).size, prefix).toBe(numbers.length);
    }
  });
});

describe("citation checks", () => {
  const base = registry.threats.find((entry) => entry.id === "R1") as Threat;
  const withThreat = (changes: Partial<Threat>): ThreatRegistry => ({
    ...registry,
    threats: [{ ...base, ...changes, id: "Z1" }],
  });

  it("refuse a missing file, a missing symbol and a missing test", () => {
    const problems = citationProblems(
      withThreat({
        mitigations: [
          { text: "gone", code: "packages/facilitator/src/nowhere.ts#thing" },
          { text: "renamed", code: "packages/facilitator/src/engine.ts#noSuchSymbolAnywhere" },
        ],
        tests: [
          "packages/facilitator/test/nowhere.test.ts::a test",
          "packages/facilitator/test/state.test.ts::a test that was never written",
        ],
      }),
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        "Z1: mitigation cites a missing file packages/facilitator/src/nowhere.ts",
        'Z1: packages/facilitator/src/engine.ts does not contain "noSuchSymbolAnywhere"',
        "Z1: test cites a missing file packages/facilitator/test/nowhere.test.ts",
        'Z1: packages/facilitator/test/state.test.ts has no test named "a test that was never written"',
      ]),
    );
  });

  it("refuse an unknown harness, an undeclared case and unknown references", () => {
    const problems = citationProblems(
      withThreat({
        evidence: ["no-such-harness#case", "live-matrix#no-such-case"],
        topic: "no-topic",
        boundary: "TB99",
        asset: "nothing",
      }),
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        'Z1: unknown harness "no-such-harness"',
        'Z1: live-matrix declares no case "no-such-case"',
        'Z1: unknown topic "no-topic"',
        'Z1: unknown boundary "TB99"',
        'Z1: unknown asset "nothing"',
      ]),
    );
  });

  it("require every topic to keep a tested threat", () => {
    expect(citationProblems({ ...registry, threats: [{ ...base, tests: [] }] })).toContain(
      'topic "replay" has no threat with a test',
    );
  });

  it("match case ids as whole tokens", () => {
    expect(harnessDeclares("live-matrix", "replay-concurrent")).toBe(true);
    expect(harnessDeclares("live-matrix", "replay-concur")).toBe(false);
  });
});

describe("the operational exercises", () => {
  const threatIds = new Set(registry.threats.map((entry) => entry.id));

  it("have unique ids and cite known threats", () => {
    const ids = EXERCISES.map((exercise) => exercise.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const exercise of EXERCISES) {
      expect(exercise.threats.length, exercise.id).toBeGreaterThan(0);
      for (const id of exercise.threats) expect(threatIds.has(id), `${exercise.id}: ${id}`).toBe(true);
    }
  });

  it("run tests that exist, from test files the suite runs", () => {
    for (const exercise of EXERCISES) {
      for (const test of exercise.tests) {
        const at = `${exercise.id}: ${test.file}`;
        const source = join(REPO_ROOT, test.file);
        expect(existsSync(source), at).toBe(true);
        expect(readFileSync(source, "utf8"), at).toContain(test.name);
        const runner = test.runIn ?? test.file;
        expect(runner, at).toMatch(/^(apps|packages|tools)\/[^/]+\/test\/.+\.test\.ts$|^test\/.+\.test\.ts$/);
        expect(existsSync(join(REPO_ROOT, runner)), at).toBe(true);
      }
    }
  });

  it("cite testnet cases their harnesses declare", () => {
    for (const exercise of EXERCISES) {
      for (const ref of exercise.testnet ?? []) {
        const [harness = "", id = ""] = ref.split("#");
        expect(harnessDeclares(harness, id), `${exercise.id}: ${ref}`).toBe(true);
      }
    }
  });

  it("cover every threat that has tests, or say why not", () => {
    const exercised = new Set(EXERCISES.flatMap((exercise) => exercise.threats));
    // Threats proved by unit or contract tests only, which are not operational exercises.
    const unitOnly = new Set([
      "R3",
      "A3",
      "M2",
      "M4",
      "M5",
      "M6",
      "M7",
      "M8",
      "M9",
      "M10",
      "M11",
      "M12",
      "M13",
      "H1",
      "H2",
      "H3",
      "H4",
      "H5",
      "U2",
      "U4",
      "U5",
      "U8",
      "U9",
      "U10",
      // An accepted limit of post-paid upto; documented, not exercised.
      "U11",
      "E1",
      "E2",
      "E3",
      "E4",
      "E5",
      "P5",
      "P6",
      "P7",
      "P8",
      // mcp:// tools have no origin to exercise against; an accepted, documented limit.
      "P10",
      // Pubnet catalog policy, per-network quotas and trust: unit and integration tests prove these.
      "P11",
      "P12",
      "P13",
      "P14",
      // Discovery cost and size limits: unit tests prove these.
      "D1",
      "D2",
      "D3",
      "D4",
      // Discovery load shedding and its own pool: unit and integration tests and the load-test package.
      "D5",
      // The Playground's own tests and its live run prove these; the operational exercises cover Rail402.
      "PG1",
      "PG2",
      "PG3",
      "PG4",
      "PG5",
      "PG6",
      // Unit and integration tests prove these fee-sponsorship and access-key controls; drills come with
      // the operational exercises for pubnet.
      "S8",
      "S9",
      "S10",
      "S11",
      "S12",
      "S13",
      "Q1",
      "Q2",
      "Q3",
      "Q4",
      "Q5",
      "Q6",
      "O8",
      "O9",
      "O10",
      "U12",
      "U13",
      "N1",
      "N2",
      "N3",
      "N4",
      "N5",
      "N6",
      "N7",
      "N9",
      "N10",
      "N11",
      "K1",
      "K2",
      "K3",
      // The upstream watcher's own tests prove these against a GitHub fake.
      "SW1",
      "SW2",
      "SW3",
      "SW4",
      // The indexing rules' unit, hostile and fuzz tests prove these.
      "I1",
      "I2",
      "I3",
      "I4",
      "I5",
      "I13",
      // The indexer's integration tests prove these until a degraded-indexing exercise exists.
      "I6",
      "I7",
      "I8",
      "I9",
      "I10",
      "I11",
      "I12",
      // The Explorer's page, API and live-lookup tests prove these.
      "W1",
      "W2",
      "W3",
      "W4",
      "W5",
      "W6",
      "W7",
      // Database roles and key custody, proved by the roles integration test and the ceremony tests.
      "N8",
      "K4",
      "K5",
      "K6",
      "K7",
      // Monitoring controls, proved by the configuration and rule tests.
      "O11",
      "O12",
      "O13",
      // Self-host independence, proved by the image test without internet and the in-process egress guard.
      "O14",
      // The status page's own controls, proved by its page test.
      "O15",
      // Release and deploy controls, proved by the workflow and deploy-gate tests.
      "C1",
      "C2",
      "C3",
      "C4",
      "C5",
      // The pubnet harness controls: their unit tests and the private-network funder tests prove them.
      "CF1",
      "CF2",
      "CF3",
      "CF4",
      // Who decides and who sees a listing's usage: the catalog and usage-route tests prove these.
      "P15",
      "P16",
    ]);
    for (const entry of registry.threats) {
      expect(exercised.has(entry.id) !== unitOnly.has(entry.id), `${entry.id}: exercised or unit-only`).toBe(
        true,
      );
    }
    for (const id of unitOnly) expect(threatIds.has(id), id).toBe(true);
  });
});
