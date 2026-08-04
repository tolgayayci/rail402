import { describe, it, expect } from "vitest";
import { SignalStore } from "./signals.js";

/**
 * The online-signal loop.
 *
 * Two properties matter more than the arithmetic: the store must be **bounded** (it holds
 * user-supplied text in a long-lived process) and it must **never affect a payment** (an unknown or
 * forged token is a no-op, not an error).
 */

describe("search signals", () => {
  it("mints a distinct token per search and attributes a conversion to it", () => {
    const s = new SignalStore();
    const t1 = s.recordSearch("weather forecast", ["https://a.example/w", "https://b.example/w"]);
    const t2 = s.recordSearch("weather forecast", ["https://a.example/w"]);
    expect(t1).not.toBe(t2);

    expect(s.recordConversion(t1, "https://b.example/w")).toBe(true);

    const report = s.report();
    expect(report.searches).toBe(2);
    expect(report.conversions).toHaveLength(1);
    // Rank 2 — the buyer paid for the SECOND result, which is precisely the signal worth having:
    // ranking surfaced it but did not lead with it.
    expect(report.conversions[0]).toMatchObject({ resource: "https://b.example/w", rank: 2 });
    expect(report.meanConvertedRank).toBe(2);
  });

  it("surfaces zero-result queries, most frequent first", () => {
    const s = new SignalStore();
    s.recordSearch("quantum teleportation api", []);
    s.recordSearch("Quantum Teleportation API  ", []); // same query, different casing/space
    s.recordSearch("something else entirely", []);
    s.recordSearch("weather", ["https://a.example/w"]);

    const report = s.report();
    expect(report.zeroResultRate).toBeCloseTo(0.75);
    expect(report.zeroResultQueries[0]).toMatchObject({ count: 2 });
    expect(report.zeroResultQueries[0]!.query.toLowerCase()).toContain("quantum");
  });

  it("separates searches that returned results but never converted", () => {
    const s = new SignalStore();
    const converted = s.recordSearch("paid weather api", ["https://a.example/w"]);
    s.recordSearch("paid weather api", ["https://a.example/w"]);
    s.recordConversion(converted, "https://a.example/w");

    const report = s.report();
    expect(report.conversions).toHaveLength(1);
    expect(report.unconvertedQueries[0]).toMatchObject({ count: 1 });
    expect(report.conversionRate).toBeCloseTo(0.5);
  });

  // Every one of these must be a silent no-op. The buyer has already paid by the time a conversion
  // is reported, so an "error" here could only ever make a successful payment look failed.
  it.each([
    ["an undefined token", undefined],
    ["an empty token", ""],
    ["a token never issued", "not-a-real-token"],
    ["a forged token", "AAAAAAAAAAAAAAAA"],
  ])("ignores %s without throwing", (_label, token) => {
    const s = new SignalStore();
    s.recordSearch("q", ["https://a.example/x"]);
    expect(() => s.recordConversion(token as string | undefined, "https://a.example/x")).not.toThrow();
    expect(s.recordConversion(token as string | undefined, "https://a.example/x")).toBe(false);
  });

  it("records a conversion for a resource the search never returned, without lying about rank", () => {
    // An agent may pay for something it found elsewhere. Rank 0 means "not in these results" —
    // recorded honestly rather than being silently counted as a top hit.
    const s = new SignalStore();
    const token = s.recordSearch("weather", ["https://a.example/w"]);
    s.recordConversion(token, "https://elsewhere.example/z");

    const report = s.report();
    expect(report.conversions[0]!.rank).toBe(0);
    // Rank 0 must not drag the mean down as if it were a very good rank.
    expect(report.meanConvertedRank).toBeNull();
  });

  /**
   * Found live, not in review: the loop reported `attributed: true` on the wire while the report
   * showed `conversions: 0`, because a zero-result search fell into the zero-result bucket and its
   * conversion was never counted. The buckets overlap and must be counted independently.
   */
  it("counts a conversion even when the search that led to it returned nothing", () => {
    const s = new SignalStore();
    const token = s.recordSearch("nothing matches this", []);
    expect(s.recordConversion(token, "https://found.elsewhere/x")).toBe(true);

    const report = s.report();
    expect(report.conversions, "conversion was swallowed by the zero-result bucket").toHaveLength(1);
    expect(report.zeroResultQueries).toHaveLength(1);
    expect(report.conversions[0]!.rank).toBe(0);
  });

  it("counts only the first conversion for a token", () => {
    const s = new SignalStore();
    const token = s.recordSearch("weather", ["https://a.example/w", "https://b.example/w"]);
    expect(s.recordConversion(token, "https://a.example/w")).toBe(true);
    expect(s.recordConversion(token, "https://b.example/w")).toBe(false);
    expect(s.report().conversions).toHaveLength(1);
  });

  it("stays bounded, evicting oldest first and not leaking tokens", () => {
    const s = new SignalStore(10);
    const first = s.recordSearch("oldest", ["https://a.example/x"]);
    for (let i = 0; i < 20; i++) s.recordSearch(`q${i}`, ["https://a.example/x"]);

    expect(s.size).toBe(10);
    // The evicted record's token must be gone from the index too, or the map grows without bound
    // while the buffer stays capped — a slow leak that only shows up in production.
    expect(s.recordConversion(first, "https://a.example/x")).toBe(false);
  });

  it("proposes judgments from paid conversions, ordered by how often each was chosen", () => {
    const s = new SignalStore();
    for (const resource of ["https://a.example/w", "https://a.example/w", "https://b.example/w"]) {
      const token = s.recordSearch("weather forecast", [
        "https://a.example/w",
        "https://b.example/w",
      ]);
      s.recordConversion(token, resource);
    }

    const proposed = s.proposedJudgments();
    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.query).toBe("weather forecast");
    // Paid twice beats paid once.
    expect(proposed[0]!.relevant).toEqual(["https://a.example/w", "https://b.example/w"]);
    expect(proposed[0]!.note).toContain("Review before adding");
  });

  it("proposes nothing from searches nobody paid for", () => {
    const s = new SignalStore();
    s.recordSearch("browsed but never bought", ["https://a.example/w"]);
    expect(s.proposedJudgments()).toEqual([]);
  });

  it("reports zero rates rather than NaN when nothing has happened", () => {
    const report = new SignalStore().report();
    expect(report.zeroResultRate).toBe(0);
    expect(report.conversionRate).toBe(0);
    expect(report.meanConvertedRank).toBeNull();
  });
});
