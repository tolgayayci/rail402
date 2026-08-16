import { entryKey, type CatalogEntry } from "../catalog/types.js";
import { HELD_OUT_CORPUS_LARGE, HELD_OUT_BROAD_DEV, HELD_OUT_BROAD_LOCKED } from "./heldout.js";
import { HybridRetriever, Bm25Retriever, type Retriever } from "./index.js";
import { computeMetrics, type Judgment, type QueryResult } from "./metrics.js";

/**
 * Hybrid-vs-BM25 ablation, made runnable.
 *
 * `heldout.ts` states the hybrid arm beats pure BM25 with a per-query sign test of p ≈ 0.003, but for
 * a long time no script reproduced it — a claim in a comment is a claim, not evidence. This is the
 * script. `pnpm --filter @rail402.dev/bazaar ablation` re-runs it against whatever the corpus and the
 * broad judgment set currently are, so the number in that comment can be checked rather than trusted.
 *
 * It compares the two RETRIEVERS directly (not through the store), so the quality multiplier and the
 * provisional/filter layers are held constant and only the retrieval arm varies — which is exactly
 * what "hybrid vs BM25" names. Per-query metric is nDCG@10 (grade-aware), and the sign test is the
 * two-sided binomial over queries where the two differ, ties discarded.
 */

const JUDGMENTS: readonly Judgment[] = [...HELD_OUT_BROAD_DEV, ...HELD_OUT_BROAD_LOCKED];
const CORPUS = HELD_OUT_CORPUS_LARGE;

/** Rank a judgment's query through one retriever and score it as a single-query QueryResult. */
function scoreQuery(retriever: Retriever, j: Judgment): number {
  const hits = retriever.search(j.query, CORPUS as CatalogEntry[], 10);
  const returned = hits.map(h => entryKey(h.entry.resource, undefined));
  const result: QueryResult = {
    query: j.query,
    returned,
    relevant: j.relevant,
    ...(j.grades ? { grades: j.grades } : {}),
  };
  return computeMetrics([result]).ndcgAt10;
}

/** Two-sided binomial sign test: probability of a split at least this lopsided under p=0.5. */
function signTestP(better: number, worse: number): number {
  const n = better + worse;
  if (n === 0) return 1;
  const logC = (n: number, k: number): number => {
    let s = 0;
    for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
    return s;
  };
  const tail = Math.min(better, worse);
  let cum = 0;
  for (let k = 0; k <= tail; k++) cum += Math.exp(logC(n, k) + n * Math.log(0.5));
  return Math.min(1, 2 * cum);
}

function aggregate(retriever: Retriever): { mrr: number; ndcg: number } {
  const results: QueryResult[] = JUDGMENTS.map(j => {
    const hits = retriever.search(j.query, CORPUS as CatalogEntry[], 10);
    return {
      query: j.query,
      returned: hits.map(h => entryKey(h.entry.resource, undefined)),
      relevant: j.relevant,
      ...(j.grades ? { grades: j.grades } : {}),
    };
  });
  const m = computeMetrics(results);
  return { mrr: m.mrr, ndcg: m.ndcgAt10 };
}

function run(): void {
  const bm25 = new Bm25Retriever();
  const hybrid = new HybridRetriever();
  bm25.index(CORPUS as CatalogEntry[]);
  hybrid.index(CORPUS as CatalogEntry[]);

  let better = 0, worse = 0, tie = 0;
  const EPS = 1e-9;
  for (const j of JUDGMENTS) {
    const b = scoreQuery(bm25, j);
    const h = scoreQuery(hybrid, j);
    if (h - b > EPS) better++;
    else if (b - h > EPS) worse++;
    else tie++;
  }

  const bm25Agg = aggregate(bm25);
  const hybridAgg = aggregate(hybrid);
  const p = signTestP(better, worse);

  console.log(`hybrid vs BM25 ablation — ${JUDGMENTS.length} broad judgments over ${CORPUS.length} documents\n`);
  console.log("aggregate (all judgments, one blended number — the per-query test below is the real one):");
  console.log(`  BM25-only : MRR ${bm25Agg.mrr.toFixed(3)}  nDCG@10 ${bm25Agg.ndcg.toFixed(3)}`);
  console.log(`  hybrid    : MRR ${hybridAgg.mrr.toFixed(3)}  nDCG@10 ${hybridAgg.ndcg.toFixed(3)}\n`);
  console.log("per-query nDCG@10, hybrid vs BM25:");
  console.log(`  hybrid better : ${better}`);
  console.log(`  hybrid worse  : ${worse}`);
  console.log(`  exact ties    : ${tie}  (hybrid changes nothing on these)`);
  console.log(`  two-sided sign test p = ${p.toFixed(4)}  (ties discarded, n=${better + worse})`);
  console.log(`\n${p < 0.05 ? "SIGNIFICANT" : "not significant"} at α=0.05 — ${better > worse ? "hybrid" : "BM25"} is ahead.`);
}

// CLI: `pnpm --filter @rail402.dev/bazaar ablation`
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? " ")) {
  run();
}

export { signTestP };
