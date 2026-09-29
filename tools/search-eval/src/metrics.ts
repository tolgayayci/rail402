/**
 * Retrieval metrics with trec_eval semantics.
 *
 * Judgments are graded 0–3 (0 not relevant, 1 marginal, 2 relevant, 3 exactly what was asked for).
 * nDCG uses the grade as gain (trec_eval `ndcg_cut`); the binary metrics count a result as relevant
 * at grade ≥ RELEVANT (trec_eval `-l 2`). Queries without any relevant listing are excluded from the
 * averages and reported separately as no-answer queries.
 */

export const RELEVANT = 2;

/** Grades for one query: listing id → grade. Unjudged listings count as 0. */
export type Judgments = ReadonlyMap<string, number>;

export interface QueryMetrics {
  readonly reciprocalRank: number;
  readonly ndcgAt10: number;
  readonly recallAt20: number;
  readonly precisionAt1: number;
}

export function hasRelevant(judgments: Judgments): boolean {
  for (const grade of judgments.values()) if (grade >= RELEVANT) return true;
  return false;
}

export function evaluateQuery(ranking: readonly string[], judgments: Judgments): QueryMetrics {
  return {
    reciprocalRank: reciprocalRank(ranking, judgments),
    ndcgAt10: ndcg(ranking, judgments, 10),
    recallAt20: recall(ranking, judgments, 20),
    precisionAt1: precision(ranking, judgments, 1),
  };
}

export function reciprocalRank(ranking: readonly string[], judgments: Judgments): number {
  const index = ranking.findIndex((id) => (judgments.get(id) ?? 0) >= RELEVANT);
  return index === -1 ? 0 : 1 / (index + 1);
}

export function precision(ranking: readonly string[], judgments: Judgments, k: number): number {
  let hits = 0;
  for (const id of ranking.slice(0, k)) if ((judgments.get(id) ?? 0) >= RELEVANT) hits++;
  return hits / k;
}

export function recall(ranking: readonly string[], judgments: Judgments, k: number): number {
  let relevant = 0;
  for (const grade of judgments.values()) if (grade >= RELEVANT) relevant++;
  if (relevant === 0) return 0;
  let hits = 0;
  for (const id of ranking.slice(0, k)) if ((judgments.get(id) ?? 0) >= RELEVANT) hits++;
  return hits / relevant;
}

/** nDCG@k with linear gain and log2(rank + 1) discount, as trec_eval's ndcg_cut. */
export function ndcg(ranking: readonly string[], judgments: Judgments, k: number): number {
  const dcg = (grades: readonly number[]) =>
    grades.slice(0, k).reduce((sum, grade, index) => sum + grade / Math.log2(index + 2), 0);
  const ideal = dcg([...judgments.values()].filter((grade) => grade > 0).sort((a, b) => b - a));
  if (ideal === 0) return 0;
  return dcg(ranking.map((id) => judgments.get(id) ?? 0)) / ideal;
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank] ?? 0;
}

/** Deterministic PRNG (mulberry32), so bootstrap intervals reproduce exactly. */
export function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** 95% percentile-bootstrap confidence interval of the mean. */
export function bootstrapInterval(
  values: readonly number[],
  resamples = 2_000,
  seed = 402,
): [number, number] {
  if (values.length === 0) return [0, 0];
  const random = seededRandom(seed);
  const means: number[] = [];
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < values.length; i++) sum += values[Math.floor(random() * values.length)] ?? 0;
    means.push(sum / values.length);
  }
  return [percentile(means, 2.5), percentile(means, 97.5)];
}

/**
 * Two-sided paired randomization test (Smucker, Allan & Carterette, 2007): the share of random
 * sign-flips of per-query differences whose mean difference is at least as large as the observed one.
 */
export function pairedRandomizationTest(
  a: readonly number[],
  b: readonly number[],
  trials = 10_000,
  seed = 402,
): number {
  const differences = a.map((value, index) => value - (b[index] ?? 0));
  const observed = Math.abs(mean(differences));
  const random = seededRandom(seed);
  let extreme = 0;
  for (let t = 0; t < trials; t++) {
    let sum = 0;
    for (const difference of differences) sum += random() < 0.5 ? difference : -difference;
    if (Math.abs(sum / differences.length) >= observed - 1e-12) extreme++;
  }
  return (extreme + 1) / (trials + 1);
}
