import { CatalogStore } from "../catalog/store.js";
import { entryKey, type CatalogEntry } from "../catalog/types.js";
import { CORPUS, JUDGMENTS, THRESHOLDS } from "./fixtures.js";
import {
  HELD_OUT_CORPUS,
  HELD_OUT_CORPUS_LARGE,
  HELD_OUT_DEV,
  HELD_OUT_LOCKED,
  HELD_OUT_SOURCE,
  HELD_OUT_THRESHOLDS,
  HELD_OUT_LARGE_THRESHOLDS,
  HELD_OUT_BROAD_THRESHOLDS,
  HELD_OUT_BROAD_DEV,
  HELD_OUT_BROAD_LOCKED,
  HELD_OUT_MCP_CORPUS,
  HELD_OUT_MCP_DEV,
  HELD_OUT_MCP_LOCKED,
  HELD_OUT_MCP_THRESHOLDS,
} from "./heldout.js";
import {
  computeMetrics,
  formatMetrics,
  type Judgment,
  type Metrics,
  type QueryResult,
} from "./metrics.js";

/**
 * Run the judgment sets against the live ranker.
 *
 * Shared by the CI regression test and the `pnpm eval` CLI, so the number a developer sees locally
 * is exactly the number that gates the build.
 *
 * There are two corpora, and they are never merged into one score:
 *
 * - **synthetic** — hand-written, well-separated services with complete metadata. Useful as a
 *   regression guard, useless as evidence of production quality, because it was partly tuned
 *   against and it describes a world that does not exist (see `heldout.ts`).
 * - **held-out** — twenty real resources captured from the live CDP Bazaar, sixteen of them
 *   near-identical siblings of one service, almost none carrying the metadata our ranker weights
 *   most heavily. Split into a tunable `dev` slice and a `locked` slice that is measured and never
 *   diagnosed.
 *
 * Reporting them separately is the whole point. A single blended number would let the easy corpus
 * carry the hard one, which is precisely how a search deliverable comes to be described as
 * excellent by the team that built it.
 */

export interface SetResult {
  name: string;
  metrics: Metrics;
  results: QueryResult[];
}

function runSet(name: string, corpus: readonly CatalogEntry[], judgments: readonly Judgment[]): SetResult {
  const store = new CatalogStore();
  for (const entry of corpus) store.upsert(structuredClone(entry));
  store.reindex();

  const results: QueryResult[] = judgments.map(j => {
    const response = store.search(j.query, j.filters ?? {}, 10);
    return {
      query: j.query,
      returned: response.resources.map(r =>
        entryKey(r.resource, r.type === "mcp" ? toolNameOf(r) : undefined),
      ),
      relevant: j.relevant,
      ...(j.grades ? { grades: j.grades } : {}),
    };
  });

  return { name, metrics: computeMetrics(results), results };
}

/** Every set, in reporting order. */
export function evaluateAll(): SetResult[] {
  return [
    runSet("synthetic", CORPUS, JUDGMENTS),
    runSet("held-out · dev", HELD_OUT_CORPUS, HELD_OUT_DEV),
    runSet("held-out · locked", HELD_OUT_CORPUS, HELD_OUT_LOCKED),
    // Distractor-scaling slices (REPORT-ONLY, no CI floors — see the threshold routing below and in
    // ranking.test.ts). The SAME 20 held-out queries and relevance labels scored against 50 and 100
    // documents. The 20 gold resources are the first 20 of the large corpus, so `.slice()` keeps
    // every target and adds 30 / 80 real distractors, filling the low end of the 20 -> 2,000 ->
    // 18,450 curve. The broad 202-judgment set is deliberately NOT scaled down here: it references
    // 358 distinct target documents, which cannot fit inside a 50- or 100-document corpus.
    runSet("held-out · dev @50", HELD_OUT_CORPUS_LARGE.slice(0, 50), HELD_OUT_DEV),
    runSet("held-out · locked @50", HELD_OUT_CORPUS_LARGE.slice(0, 50), HELD_OUT_LOCKED),
    runSet("held-out · dev @100", HELD_OUT_CORPUS_LARGE.slice(0, 100), HELD_OUT_DEV),
    runSet("held-out · locked @100", HELD_OUT_CORPUS_LARGE.slice(0, 100), HELD_OUT_LOCKED),
    // Same queries, same relevance labels, 100x the distractors. This is the set that can actually
    // tell two rankers apart.
    runSet("held-out · dev @2k", HELD_OUT_CORPUS_LARGE, HELD_OUT_DEV),
    runSet("held-out · locked @2k", HELD_OUT_CORPUS_LARGE, HELD_OUT_LOCKED),
    // The broad set: 202 blind judgments over the same 2000 documents. Wide enough to actually tell
    // two rankers apart — this is the set that matters now.
    runSet("broad · dev @2k", HELD_OUT_CORPUS_LARGE, HELD_OUT_BROAD_DEV),
    runSet("broad · locked @2k", HELD_OUT_CORPUS_LARGE, HELD_OUT_BROAD_LOCKED),
    // MCP tools (Z3), scored against the full catalog — the 2000 http entries PLUS the 24 MCP tools —
    // so a tool must out-rank realistic http distractors, and sibling tools on one endpoint must be
    // told apart by (url, toolName). The one slice that measures the project's differentiator.
    runSet("mcp · dev @2k", [...HELD_OUT_CORPUS_LARGE, ...HELD_OUT_MCP_CORPUS], HELD_OUT_MCP_DEV),
    runSet("mcp · locked @2k", [...HELD_OUT_CORPUS_LARGE, ...HELD_OUT_MCP_CORPUS], HELD_OUT_MCP_LOCKED),
  ];
}

/** Backwards-compatible entry point for the synthetic regression gate. */
export function evaluate(): { metrics: Metrics; results: QueryResult[] } {
  const { metrics, results } = runSet("synthetic", CORPUS, JUDGMENTS);
  return { metrics, results };
}

/** The public projection drops `toolName`, so recover it from the echoed extension block. */
function toolNameOf(resource: { extensions?: Record<string, unknown> }): string | undefined {
  const bazaar = resource.extensions?.["bazaar"] as
    | { info?: { input?: { toolName?: string } } }
    | undefined;
  return bazaar?.info?.input?.toolName;
}

/** Per-query failures, so a regression names the query that broke rather than just a number. */
export function failures(results: readonly QueryResult[]): QueryResult[] {
  return results.filter(r => r.returned.length === 0 || !r.relevant.includes(r.returned[0]!));
}

function belowThresholds(metrics: Metrics, thresholds: Record<string, number>): string[] {
  return Object.entries(thresholds)
    .filter(([key, floor]) =>
      key === "zeroResultRate"
        ? metrics.zeroResultRate > floor
        : (metrics as unknown as Record<string, number>)[key]! < floor,
    )
    .map(([key]) => key);
}

// CLI: `pnpm --filter @rail402.dev/bazaar eval`
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop() ?? " ")) {
  console.log(
    `held-out corpus: ${HELD_OUT_SOURCE.entries} real resources from ${HELD_OUT_SOURCE.source}` +
      ` (live catalog held ${HELD_OUT_SOURCE.capturedTotal} at capture time)\n`,
  );

  let failed = false;
  for (const set of evaluateAll()) {
    console.log(`── ${set.name} ${"─".repeat(Math.max(0, 40 - set.name.length))}`);
    console.log(formatMetrics(set.metrics));

    const bad = failures(set.results);
    if (set.name.includes("locked")) {
      // Aggregate only. A held-out set whose individual failures you read is just a slower training
      // set: once you know WHICH query broke, you will fix that query, and the number stops
      // measuring generalisation. This tool refuses to show them rather than relying on the
      // person running it to look away — which is the correct place to put that discipline,
      // because I already failed it once by printing them.
      if (bad.length > 0) {
        console.log(`\ntop-1 misses: ${bad.length}/${set.results.length} (queries withheld by design)`);
      }
    } else if (bad.length > 0) {
      console.log(`\ntop-1 misses (${bad.length}/${set.results.length}):`);
      for (const r of bad) {
        console.log(`  "${r.query}"`);
        console.log(`     expected: ${r.relevant[0]}`);
        console.log(`     got     : ${r.returned[0] ?? "(nothing)"}`);
      }
    }

    const thresholds = set.name.includes("@50") || set.name.includes("@100")
      ? {} // report-only distractor-scaling slices (see evaluateAll) — measured, never gated
      : set.name === "synthetic"
      ? THRESHOLDS
      : set.name.startsWith("mcp")
        ? HELD_OUT_MCP_THRESHOLDS
        : set.name.startsWith("broad")
          ? HELD_OUT_BROAD_THRESHOLDS
          : set.name.includes("@2k")
            ? HELD_OUT_LARGE_THRESHOLDS
            : HELD_OUT_THRESHOLDS;
    const below = belowThresholds(set.metrics, thresholds);
    if (below.length > 0) {
      console.error(`\n  BELOW THRESHOLD: ${below.join(", ")}`);
      failed = true;
    }
    console.log("");
  }

  if (failed) process.exit(1);
}
