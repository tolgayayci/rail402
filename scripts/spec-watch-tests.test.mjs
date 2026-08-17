import { describe, it, expect } from "vitest";
import { computeVerdict, composeReport } from "./spec-watch-tests.mjs";

/**
 * The breaking/non-breaking verdict is what a human — and the Copilot coding agent — acts on.
 * A wrong "non-breaking" ships a conformance gap silently; a wrong "breaking" trains the reader
 * to ignore the alarm. So the classification rules are pinned here, on every PR.
 *
 * The subtle case is `regression`: the upstream suite does not fully pass even at OUR pinned SHA
 * (a diagnosed upstream harness defect), so exit codes cannot classify drift. Scenario counts can:
 * fewer passing at latest than at pinned is the only signal that THIS drift broke something.
 */

const dual = (verdict, pinnedScen, latestScen) => ({
  verdict,
  pinned: { sha: "a".repeat(40), ok: verdict === "green" || verdict === "drift", scenarios: pinnedScen },
  latest: { sha: "b".repeat(40), ok: verdict === "green", scenarios: latestScen },
});

describe("spec-watch test verdict", () => {
  it("is inconclusive — never a guess — when the dual run is blocked or absent", () => {
    expect(computeVerdict(null, "success", "success").verdict).toBe("inconclusive");
    expect(
      computeVerdict({ verdict: "blocked", note: "no funded accounts" }, "success", "success").verdict,
    ).toBe("inconclusive");
    // Unmeasured must read as potentially breaking, not as safe.
    expect(computeVerdict(null, "success", "success").reason).toMatch(/UNMEASURED/);
  });

  it("green at both SHAs is non-breaking", () => {
    const v = computeVerdict(
      dual("green", { passed: 4, failed: 0 }, { passed: 4, failed: 0 }),
      "success",
      "success",
    );
    expect(v.verdict).toBe("non-breaking");
  });

  it("pass-pinned / fail-latest (the harness's own `drift` verdict) is breaking", () => {
    const v = computeVerdict(
      dual("drift", { passed: 4, failed: 0 }, { passed: 2, failed: 2 }),
      "success",
      "success",
    );
    expect(v.verdict).toBe("breaking");
  });

  it("regression with FEWER scenarios passing at latest is breaking", () => {
    const v = computeVerdict(
      dual("regression", { passed: 2, failed: 2 }, { passed: 1, failed: 3 }),
      "success",
      "success",
    );
    expect(v.verdict).toBe("breaking");
    expect(v.reason).toMatch(/1 previously-passing scenario/);
  });

  it("regression with IDENTICAL scenario counts is non-breaking (pre-existing harness defect)", () => {
    const v = computeVerdict(
      dual("regression", { passed: 2, failed: 2 }, { passed: 2, failed: 2 }),
      "success",
      "success",
    );
    expect(v.verdict).toBe("non-breaking");
    expect(v.reason).toMatch(/pre-existing/);
  });

  it("unit and canary failures become caveats, never the verdict", () => {
    const v = computeVerdict(
      dual("green", { passed: 4, failed: 0 }, { passed: 4, failed: 0 }),
      "failure",
      "failure",
    );
    expect(v.verdict).toBe("non-breaking");
    expect(v.reason).toMatch(/our own test suite failed/);
    expect(v.reason).toMatch(/canary failed/);
  });

  it("composeReport marks upstream rows skipped when the dual run is blocked", () => {
    const r = composeReport({
      unit: "success",
      canary: "success",
      dual: { verdict: "blocked", note: "no accounts" },
    });
    const rows = Object.fromEntries(r.suites.map(s => [s.id, s.outcome]));
    expect(rows["upstream-pinned"]).toBe("skipped");
    expect(rows["upstream-latest"]).toBe("skipped");
    expect(r.verdict).toBe("inconclusive");
  });
});
