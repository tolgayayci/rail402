import { describe, expect, it } from "vitest";
import {
  bootstrapInterval,
  evaluateQuery,
  ndcg,
  pairedRandomizationTest,
  percentile,
  precision,
  recall,
  reciprocalRank,
} from "../src/metrics.ts";

const judged = new Map([
  ["a", 3],
  ["b", 2],
  ["c", 1],
  ["d", 0],
]);

describe("metrics (hand-computed, trec_eval semantics)", () => {
  it("reciprocal rank uses the first result with grade >= 2", () => {
    expect(reciprocalRank(["d", "c", "b", "a"], judged)).toBeCloseTo(1 / 3);
    expect(reciprocalRank(["d", "c"], judged)).toBe(0);
  });

  it("precision@k and recall@k count grade >= 2", () => {
    expect(precision(["a", "d"], judged, 1)).toBe(1);
    expect(precision(["c", "a"], judged, 1)).toBe(0);
    expect(recall(["x", "b", "c"], judged, 20)).toBe(0.5);
  });

  it("nDCG@10 uses linear gains and log2 discounts", () => {
    // DCG = 1/log2(2) + 3/log2(3) + 2/log2(4); IDCG = 3 + 2/log2(3) + 1/log2(4)
    const dcg = 1 + 3 / Math.log2(3) + 2 / 2;
    const idcg = 3 + 2 / Math.log2(3) + 1 / 2;
    expect(ndcg(["c", "a", "b"], judged, 10)).toBeCloseTo(dcg / idcg, 12);
    expect(ndcg(["a", "b", "c"], judged, 10)).toBeCloseTo(1, 12);
    expect(ndcg(["d"], new Map([["d", 0]]), 10)).toBe(0);
  });

  it("evaluates a perfect ranking as 1 on every metric", () => {
    expect(evaluateQuery(["a", "b", "c"], judged)).toEqual({
      reciprocalRank: 1,
      ndcgAt10: 1,
      recallAt20: 1,
      precisionAt1: 1,
    });
  });

  it("percentiles use the nearest-rank method", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 95)).toBe(5);
  });

  it("bootstrap intervals are deterministic and contain the mean", () => {
    const values = [0.2, 0.4, 0.6, 0.8, 1.0, 0.5, 0.7];
    const [low, high] = bootstrapInterval(values);
    expect(bootstrapInterval(values)).toEqual([low, high]);
    expect(low).toBeLessThan(0.6);
    expect(high).toBeGreaterThan(0.6);
  });

  it("the randomization test separates real differences from noise", () => {
    const base = Array.from({ length: 60 }, (_, i) => (i % 5) / 5);
    expect(
      pairedRandomizationTest(
        base.map((v) => v + 0.2),
        base,
      ),
    ).toBeLessThan(0.01);
    expect(pairedRandomizationTest(base, base)).toBeGreaterThan(0.9);
  });
});
