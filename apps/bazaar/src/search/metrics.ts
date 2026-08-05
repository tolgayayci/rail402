/**
 * Offline retrieval metrics.
 *
 * Search quality is a graded deliverable here, evaluated *over time*,
 * so these are computed in CI and a ranking regression fails the build. Measuring is the only thing
 * that separates "we have search" from "we have good search".
 */

export interface Judgment {
  /** The natural-language query, as an agent would phrase it. */
  query: string;
  /** The relevant entry keys (order does not matter). */
  relevant: string[];
  /**
   * Explicit, judge-assigned relevance grade per key: 3 = clearly-best answer, 2 = strongly relevant,
   * 1 = partially relevant. Absent means binary relevance (every key in `relevant` counts as grade 1).
   * Grades come from a human judge, NEVER from position in the list — two equally-good answers both
   * get 3.
   */
  grades?: Record<string, number>;
  /** Optional filters applied alongside the query. */
  filters?: Record<string, string>;
  /** Why these are the right answers — keeps the set reviewable as it grows. */
  note?: string;
}

export interface QueryResult {
  query: string;
  returned: string[];
  relevant: string[];
  /** Judge-assigned grades from the judgment, carried through so nDCG can use them. */
  grades?: Record<string, number>;
}

export interface Metrics {
  precisionAt1: number;
  precisionAt5: number;
  recallAt5: number;
  recallAt10: number;
  mrr: number;
  ndcgAt10: number;
  zeroResultRate: number;
  queries: number;
}

/**
 * Judge-assigned relevance grade of a key.
 *
 * Grades are EXPLICIT (`grades`), never inferred from list position — an earlier version fabricated a
 * grade difference between equally-relevant siblings purely from array order, which was a weakness of
 * the ruler rather than a fact about the judges. A key with no explicit grade counts as binary
 * relevance (grade 1 if judged relevant, 0 otherwise). The nDCG below uses the exponential-gain form
 * `(2^g - 1)` from Burges et al., "Learning to Rank using Gradient Descent" (ICML 2005) — NOT the
 * original linear-gain nDCG of Järvelin & Kekäläinen (TOIS 2002); any doc citing J&K for it is wrong.
 */
function gain(r: QueryResult, key: string): number {
  const explicit = r.grades?.[key];
  if (explicit !== undefined) return explicit;
  return r.relevant.includes(key) ? 1 : 0;
}

function dcg(r: QueryResult, k: number): number {
  let sum = 0;
  for (let i = 0; i < Math.min(k, r.returned.length); i++) {
    const g = gain(r, r.returned[i]!);
    if (g > 0) sum += (2 ** g - 1) / Math.log2(i + 2);
  }
  return sum;
}

function idealDcg(r: QueryResult, k: number): number {
  // The ideal ranking lists the relevant keys in descending grade order.
  const grades = r.relevant.map(key => gain(r, key)).sort((a, b) => b - a);
  let sum = 0;
  for (let i = 0; i < Math.min(k, grades.length); i++) {
    sum += (2 ** grades[i]! - 1) / Math.log2(i + 2);
  }
  return sum;
}

const precisionAt = (r: QueryResult, k: number): number => {
  // Precision@k divides by k, NOT by the number of results returned. Dividing by the smaller of the
  // two rewarded a ranker for returning FEWER results: a search returning 2 items, 1 relevant, scored
  // P@5 = 1/2 instead of the correct 1/5. Standard P@k measures the top-k slots, empty ones included.
  return r.returned.slice(0, k).filter(x => r.relevant.includes(x)).length / k;
};

const recallAt = (r: QueryResult, k: number): number => {
  if (r.relevant.length === 0) return 1;
  const top = r.returned.slice(0, k);
  return top.filter(x => r.relevant.includes(x)).length / r.relevant.length;
};

const reciprocalRank = (r: QueryResult): number => {
  for (let i = 0; i < r.returned.length; i++) {
    if (r.relevant.includes(r.returned[i]!)) return 1 / (i + 1);
  }
  return 0;
};

export function computeMetrics(results: readonly QueryResult[]): Metrics {
  if (results.length === 0) {
    return {
      precisionAt1: 0, precisionAt5: 0, recallAt5: 0, recallAt10: 0,
      mrr: 0, ndcgAt10: 0, zeroResultRate: 0, queries: 0,
    };
  }
  const mean = (f: (r: QueryResult) => number) =>
    results.reduce((s, r) => s + f(r), 0) / results.length;

  return {
    precisionAt1: mean(r => precisionAt(r, 1)),
    precisionAt5: mean(r => precisionAt(r, 5)),
    recallAt5: mean(r => recallAt(r, 5)),
    recallAt10: mean(r => recallAt(r, 10)),
    mrr: mean(reciprocalRank),
    ndcgAt10: mean(r => {
      const ideal = idealDcg(r, 10);
      return ideal === 0 ? 1 : dcg(r, 10) / ideal;
    }),
    // An online signal we can also measure offline. Zero-result queries are the clearest evidence
    // of a retrieval gap and feed directly back into the judgment set.
    zeroResultRate: mean(r => (r.returned.length === 0 ? 1 : 0)),
    queries: results.length,
  };
}

export function formatMetrics(m: Metrics): string {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  return [
    `queries          ${m.queries}`,
    `precision@1      ${pct(m.precisionAt1)}`,
    `precision@5      ${pct(m.precisionAt5)}`,
    `recall@5         ${pct(m.recallAt5)}`,
    `recall@10        ${pct(m.recallAt10)}`,
    `MRR              ${m.mrr.toFixed(3)}`,
    `nDCG@10          ${m.ndcgAt10.toFixed(3)}`,
    `zero-result rate ${pct(m.zeroResultRate)}`,
  ].join("\n");
}
