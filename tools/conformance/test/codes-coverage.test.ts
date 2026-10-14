import { describe, expect, it } from "vitest";
import {
  allRegistered,
  coverageProblems,
  exercisedIn,
  namedInTests,
  readCoverageRecord,
  type CoverageRecord,
} from "../src/codes-coverage.ts";
import { UNEXERCISED } from "../src/codes-unexercised.ts";
import { renderCoverage } from "../src/render-codes.ts";

const record = (overrides: Partial<CoverageRecord["exercised"]> = {}): CoverageRecord => ({
  recordedAt: "2026-09-30T00:00:00.000Z",
  commit: "a".repeat(40),
  registered: ["alpha", "beta", "gamma"],
  exercised: { unit: ["alpha"], integration: [], evidence: ["beta"], named: [], ...overrides },
});

describe("the committed code coverage", () => {
  it("is recorded, and every code it does not show exercised is justified", () => {
    const committed = readCoverageRecord();
    expect(committed).toBeDefined();
    if (committed === undefined) return;
    expect(coverageProblems(committed, UNEXERCISED)).toEqual([]);
  });

  it("justifies no code a test names today, so a merge cannot leave the page stale", () => {
    expect(namedInTests(Object.keys(UNEXERCISED))).toEqual([]);
  });

  it("records codes that are all registered", () => {
    const committed = readCoverageRecord();
    const registered = new Set(allRegistered());
    expect(committed?.registered.filter((code) => !registered.has(code))).toEqual([]);
  });
});

describe("coverageProblems", () => {
  const registered = ["alpha", "beta", "gamma"];

  it("accepts a record whose unexercised codes are justified", () => {
    expect(coverageProblems(record(), { gamma: "Needs a revoked trustline." }, registered)).toEqual([]);
  });

  it("names an unexercised code without a justification", () => {
    expect(coverageProblems(record(), {}, registered)).toEqual([
      "gamma: not exercised and not justified in codes-unexercised.ts",
    ]);
  });

  it("names a justification kept for an exercised, an unregistered or with an empty reason", () => {
    expect(
      coverageProblems(
        record({ integration: ["gamma"] }),
        { gamma: "x", delta: "y", alpha: " " },
        registered,
      ),
    ).toEqual([
      "gamma: justified but exercised; remove its justification",
      "delta: justified but not registered",
      "alpha: justified but exercised; remove its justification",
      "alpha: empty justification",
    ]);
  });

  it("counts a code a test names as exercised", () => {
    expect(coverageProblems(record({ named: ["gamma"] }), {}, registered)).toEqual([]);
  });

  it("counts only registered codes as exercised", () => {
    expect([...exercisedIn(record({ unit: ["alpha", "owner_conflict"] }))].sort()).toEqual(["alpha", "beta"]);
  });
});

describe("renderCoverage", () => {
  it("lists the unexercised codes with their reasons and codes registered since", () => {
    const text = renderCoverage(record(), { gamma: "Needs a `revoked` trustline." }, [
      "alpha",
      "beta",
      "gamma",
      "delta",
    ]);
    expect(text).toContain("**2 of 3 registered codes**");
    expect(text).toContain("unit tests 1, integration tests 0; reported by conformance runs 1");
    expect(text).toMatch(/\| `gamma` \| Needs a `revoked` trustline\. +\|/);
    expect(text).toContain("Registered since this record was made, not yet measured: `delta`.");
  });

  it("says when nothing has been recorded", () => {
    expect(renderCoverage(undefined, {}, [])).toContain("No coverage has been recorded yet");
  });
});
