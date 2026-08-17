// Scale report — proves the ranker LOGIC holds on a ~18.5k-document corpus, without inflating the
// live catalog. Run `node eval-pack/build.mjs` first to fetch the silver corpus, then this script
// (`pnpm eval:scale`). Lives beside evaluate.ts on purpose: same import context as the gated eval.
//
// Reuses the shipped ranker, the tested `computeMetrics`, and the committed blind GOLD judgments, so
// these are the same ranker a reviewer gets — measured against many more documents. Two things are
// measured and reported SEPARATELY, never blended:
//   GOLD   — real captured listings + blind human judgments, at 2k (baseline) and the full corpus.
//            The 2k→full comparison is the robustness proof: does the right REAL answer survive among
//            ~16k off-distribution distractors?
//   SILVER — ToolACE-derived queries (first user turn -> the function the assistant called). A silver
//            query was written against its own answer, so it measures recall/robustness under load,
//            NOT precision truth, and never gates a release.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CatalogStore } from "../catalog/store.js";
import { entryKey, type CatalogEntry } from "../catalog/types.js";
import { computeMetrics, type Judgment, type Metrics } from "./metrics.js";
import { HELD_OUT_CORPUS_LARGE, HELD_OUT_BROAD_DEV, HELD_OUT_BROAD_LOCKED } from "./heldout.js";

const PACK = join(dirname(fileURLToPath(import.meta.url)), "../../eval-pack");
const DERIVED = join(PACK, "derived");

/** Score judgments against a corpus with the shipped ranker (mirrors evaluate.ts's runSet; http-only). */
function scoreOn(corpus: readonly CatalogEntry[], judgments: readonly Judgment[]): Metrics {
  const store = new CatalogStore();
  for (const entry of corpus) store.upsert(structuredClone(entry));
  store.reindex();
  const results = judgments.map(j => ({
    query: j.query,
    returned: store.search(j.query, j.filters ?? {}, 10).resources.map(r => entryKey(r.resource, undefined)),
    relevant: j.relevant,
    ...(j.grades ? { grades: j.grades } : {}),
  }));
  return computeMetrics(results);
}

/** Wilson 95% score interval for a proportion (k of n). */
function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.96, p = k / n, d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(centre - half) / d, (centre + half) / d];
}

const pct = (x: number) => (x * 100).toFixed(1) + "%";
const ci = (p: number, n: number) => {
  const [lo, hi] = wilson(Math.floor(p * n + 0.5), n);
  return `[${pct(lo)}, ${pct(hi)}]`;
};

interface Row {
  slice: string;
  kind: string;
  corpus: number;
  m: Metrics;
}

// All execution lives in main() so the shipped ranker module is fully initialized before anything
// indexes — running scoreOn at top level races module init under tsx (mirrors evaluate.ts's structure).
function main(): void {
if (!existsSync(join(DERIVED, "silver-corpus.json"))) {
  console.error("No silver corpus. Run `node eval-pack/build.mjs` first (fetches ToolACE + MCP registry).");
  process.exit(1);
}

const silverCorpus = JSON.parse(readFileSync(join(DERIVED, "silver-corpus.json"), "utf8")) as CatalogEntry[];
const rawSilver = JSON.parse(readFileSync(join(DERIVED, "silver-judgments.json"), "utf8")) as {
  query: string;
  relevant: string[];
}[];
// SILVER_LIMIT caps the silver slice for fast iteration (the JSON is hash-ordered, so a prefix is a
// stable sample). Unset = all of them for the published number.
const silverCap = Number(process.env.SILVER_LIMIT) || rawSilver.length;
// The called function is the clearly-best answer -> grade 3.
const silverJudgments: Judgment[] = rawSilver.slice(0, silverCap).map(j => ({
  query: j.query,
  relevant: j.relevant,
  grades: Object.fromEntries(j.relevant.map(r => [r, 3])),
}));

const REAL = HELD_OUT_CORPUS_LARGE;
const FULL = [...REAL, ...silverCorpus];

// Gold-DERIVED slices — same human relevance labels, different query WORDING, to measure the query
// shapes the natural-language gold set lacks. Relevance is inherited from the gold judgments (nothing
// fabricated); only the phrasing changes. Honest robustness slices, labelled `derived`.
const byKey = new Map(REAL.map(e => [entryKey(e.resource, undefined), e]));
/** Keyword phrasing: query = the relevant service's own name (does an agent find it by name at scale?). */
function keywordize(j: Judgment): Judgment | undefined {
  const first = j.relevant[0];
  const name = first ? byKey.get(first)?.serviceName : undefined;
  return name ? { query: name, relevant: j.relevant, ...(j.grades ? { grades: j.grades } : {}) } : undefined;
}
/** Typo phrasing: swap two adjacent letters in every third word of the original query. Deterministic. */
function mistype(w: string): string {
  return w.length < 5 ? w : w.slice(0, 2) + w[3] + w[2] + w.slice(4);
}
function typoize(j: Judgment): Judgment {
  const q = j.query.split(/\s+/).map((w, i) => (i % 3 === 0 ? mistype(w) : w)).join(" ");
  return { query: q, relevant: j.relevant, ...(j.grades ? { grades: j.grades } : {}) };
}
const keywordSlice = HELD_OUT_BROAD_LOCKED.map(keywordize).filter((j): j is Judgment => j !== undefined);
const typoSlice = HELD_OUT_BROAD_LOCKED.map(typoize);

const rows: Row[] = [
  { slice: "gold · locked", kind: "gold", corpus: REAL.length, m: scoreOn(REAL, HELD_OUT_BROAD_LOCKED) },
  { slice: "gold · locked", kind: "gold", corpus: FULL.length, m: scoreOn(FULL, HELD_OUT_BROAD_LOCKED) },
  { slice: "gold · dev", kind: "gold", corpus: FULL.length, m: scoreOn(FULL, HELD_OUT_BROAD_DEV) },
  { slice: "keyword", kind: "derived", corpus: FULL.length, m: scoreOn(FULL, keywordSlice) },
  { slice: "typo", kind: "derived", corpus: FULL.length, m: scoreOn(FULL, typoSlice) },
  { slice: "silver · toolace", kind: "silver", corpus: FULL.length, m: scoreOn(FULL, silverJudgments) },
];

const header = "slice              kind    corpus  n     p@1 (95% CI)            r@10    MRR     nDCG@10  0-res";
console.log("\n" + header);
console.log("-".repeat(header.length));
for (const r of rows) {
  const n = r.m.queries;
  console.log(
    [
      r.slice.padEnd(18),
      r.kind.padEnd(7),
      String(r.corpus).padStart(6),
      String(n).padStart(4),
      (pct(r.m.precisionAt1) + " " + ci(r.m.precisionAt1, n)).padEnd(23),
      pct(r.m.recallAt10).padStart(6),
      r.m.mrr.toFixed(3).padStart(6),
      r.m.ndcgAt10.toFixed(3).padStart(7),
      pct(r.m.zeroResultRate).padStart(5),
    ].join(" "),
  );
}

const g2k = rows[0]!.m, gFull = rows[1]!.m;
console.log(
  `\nGold-locked robustness ${REAL.length} → ${FULL.length} docs:  p@1 ${pct(g2k.precisionAt1)} → ${pct(gFull.precisionAt1)}` +
    `  ·  recall@10 ${pct(g2k.recallAt10)} → ${pct(gFull.recallAt10)}  ·  nDCG@10 ${g2k.ndcgAt10.toFixed(3)} → ${gFull.ndcgAt10.toFixed(3)}`,
);

const manifest = JSON.parse(readFileSync(join(PACK, "manifest.json"), "utf8"));
const md = `# Bazaar search — scale report

Generated by \`node apps/bazaar/eval-pack/build.mjs && pnpm --filter @rail402.dev/bazaar eval:scale\`.
Reproducible with no auth token: the builder fetches only Apache-2.0 (ToolACE) and CC0 (MCP registry)
sources by pinned revision; nothing upstream is redistributed here.

**This does not touch the live catalog.** The ${silverCorpus.length.toLocaleString()} silver documents
are an in-process eval fixture — \`.invalid\` hosts, zeroed quality, a sentinel payTo — so they can never
be served, ranked into, or leaked.

## What is measured

- **Gold** — our ${REAL.length.toLocaleString()} real captured listings + blind human judgments, scored
  at ${REAL.length.toLocaleString()} (baseline) and at the full ${FULL.length.toLocaleString()} documents.
  Does the right *real* answer survive among ${silverCorpus.length.toLocaleString()} off-distribution
  distractors?
- **Silver** — ${silverJudgments.length.toLocaleString()} ToolACE-derived queries. Written against their
  own answer, so lexical overlap flatters any ranker; measures recall/robustness under load, **not**
  precision truth, and never gates a release.

## Results

| slice | kind | corpus | n | p@1 (95% CI) | recall@10 | MRR | nDCG@10 |
|---|---|---|---|---|---|---|---|
${rows
  .map(
    r =>
      `| ${r.slice} | ${r.kind} | ${r.corpus.toLocaleString()} | ${r.m.queries} | ${pct(r.m.precisionAt1)} ${ci(r.m.precisionAt1, r.m.queries)} | ${pct(r.m.recallAt10)} | ${r.m.mrr.toFixed(3)} | ${r.m.ndcgAt10.toFixed(3)} |`,
  )
  .join("\n")}

**Robustness (gold · locked, ${REAL.length.toLocaleString()} → ${FULL.length.toLocaleString()} docs):**
p@1 ${pct(g2k.precisionAt1)} → ${pct(gFull.precisionAt1)}, recall@10 ${pct(g2k.recallAt10)} → ${pct(gFull.recallAt10)}, nDCG@10 ${g2k.ndcgAt10.toFixed(3)} → ${gFull.ndcgAt10.toFixed(3)}.

## Sources (manifest.json)

- ToolACE — ${manifest.builtFrom.toolace.license}, ${manifest.builtFrom.toolace.docs.toLocaleString()} docs, rev \`${manifest.builtFrom.toolace.revision}\`
- MCP registry — ${manifest.builtFrom.mcpRegistry.license}, ${manifest.builtFrom.mcpRegistry.docs.toLocaleString()} docs
- Real x402 listings — our capture, ${REAL.length.toLocaleString()} docs (the gold set)

_Silver is reported apart from gold and never blended into a headline — a single number would let the
easy corpus carry the hard one._
`;
writeFileSync(join(PACK, "REPORT.md"), md);
console.log(`\nWrote ${join(PACK, "REPORT.md")}`);
}

main();
