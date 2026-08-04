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
  /** Relevant entry keys, most relevant first. Graded 3/2/1 by position band. */
  relevant: string[];
  /** Optional filters applied alongside the query. */
  filters?: Record<string, string>;
  /** Why these are the right answers — keeps the set reviewable as it grows. */
  note?: string;
}

export interface QueryResult {
  query: string;
  returned: string[];
  relevant: string[];
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

/** Graded relevance: leading entries in a judgment are worth more than trailing ones. */
function gain(relevant: string[], key: string): number {
  const idx = relevant.indexOf(key);
  if (idx === -1) return 0;
  if (idx === 0) return 3;
  if (idx < 3) return 2;
  return 1;
}

function dcg(returned: string[], relevant: string[], k: number): number {
  let sum = 0;
  for (let i = 0; i < Math.min(k, returned.length); i++) {
    const g = gain(relevant, returned[i]!);
    if (g > 0) sum += (2 ** g - 1) / Math.log2(i + 2);
  }
  return sum;
}

function idealDcg(relevant: string[], k: number): number {
  let sum = 0;
  for (let i = 0; i < Math.min(k, relevant.length); i++) {
    const g = i === 0 ? 3 : i < 3 ? 2 : 1;
    sum += (2 ** g - 1) / Math.log2(i + 2);
  }
  return sum;
}

const precisionAt = (r: QueryResult, k: number): number => {
  const top = r.returned.slice(0, k);
  if (top.length === 0) return 0;
  return top.filter(x => r.relevant.includes(x)).length / Math.min(k, top.length);
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
      const ideal = idealDcg(r.relevant, 10);
      return ideal === 0 ? 1 : dcg(r.returned, r.relevant, 10) / ideal;
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
