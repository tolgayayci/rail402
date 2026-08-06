import { describe, it, expect } from "vitest";
import { evaluateAll, failures } from "./evaluate.js";
import { THRESHOLDS } from "./fixtures.js";
import {
  HELD_OUT_THRESHOLDS,
  HELD_OUT_LARGE_THRESHOLDS,
  HELD_OUT_BROAD_THRESHOLDS,
  HELD_OUT_CORPUS,
} from "./heldout.js";
import { HybridRetriever, Bm25Retriever, type Retriever } from "./index.js";
import type { CatalogEntry } from "../catalog/types.js";

/**
 * Ranking quality as a build gate.
 *
 * Search quality is a graded deliverable here, evaluated over time.
 * The evaluation harness existed before this file, and ranking was said to be "gated in
 * CI" — but nothing ran it. `pnpm eval` was a command a person had to remember, which is the same
 * as no gate at all. This is the gate.
 *
 * Two corpora, scored separately and never blended:
 *
 * - **synthetic** — hand-written, complete metadata, partly tuned against. A regression guard.
 * - **held-out** — 20 real resources from the live CDP Bazaar, 16 of them near-identical siblings
 *   of one service, almost none carrying the metadata the ranker weights most heavily. Split into
 *   a `dev` slice (tunable) and a `locked` slice (measured, never diagnosed).
 *
 * A single blended score would let the easy corpus carry the hard one, which is exactly how a
 * search deliverable comes to be described as excellent by the team that built it.
 */

const sets = evaluateAll();
const bySet = Object.fromEntries(sets.map(s => [s.name, s]));

describe("ranking quality gate", () => {
  it.each(sets.map(s => [s.name, s] as const))("%s meets its thresholds", (name, set) => {
    // The `@2k` sets score the SAME queries against 1,980 extra real distractors, so they get
    // their own (much lower, first-measurement) floors. Applying the twenty-document floors to
    // them would fail the build permanently and teach everyone to ignore this gate.
    const thresholds: Record<string, number> =
      name === "synthetic"
        ? THRESHOLDS
        : name.startsWith("broad")
          ? HELD_OUT_BROAD_THRESHOLDS
          : name.includes("@2k")
            ? HELD_OUT_LARGE_THRESHOLDS
            : HELD_OUT_THRESHOLDS;
    for (const [metric, floor] of Object.entries(thresholds)) {
      const value = (set.metrics as unknown as Record<string, number>)[metric]!;
      if (metric === "zeroResultRate") {
        expect(value, `${name} ${metric} ${value} above ceiling ${floor}`).toBeLessThanOrEqual(floor);
      } else {
        expect(value, `${name} ${metric} ${value} below floor ${floor}`).toBeGreaterThanOrEqual(floor);
      }
    }
  });

  it("never returns nothing at all for a query someone actually asked", () => {
    // Zero results is the worst outcome available: browse still works, so the failure is invisible
    // to every test that does not look at retrieval specifically.
    for (const set of sets) {
      const empty = set.results.filter(r => r.returned.length === 0);
      expect(empty.map(r => r.query), `${set.name} returned nothing`).toEqual([]);
    }
  });

  /**
   * The gap between dev and locked is the measurement that matters.
   *
   * Tuning against a small dev slice reliably buys points on that slice and little elsewhere. If
   * dev were ever allowed to run far ahead of locked, the headline number would be measuring how
   * much we tuned rather than how well retrieval works. This bounds that drift.
   */
  it("keeps the tuned slice from running away from the held-out one", () => {
    const dev = bySet["held-out · dev"]!.metrics.precisionAt1;
    const locked = bySet["held-out · locked"]!.metrics.precisionAt1;
    expect(dev - locked, `dev ${dev} vs locked ${locked}`).toBeLessThanOrEqual(0.25);
  });

  it("evaluates against real captured resources, not only ones we wrote", () => {
    // Guards the corpus itself: regenerating it from a different capture, or accidentally
    // committing a tidied version, would quietly turn the hard test back into the easy one.
    expect(HELD_OUT_CORPUS.length).toBeGreaterThanOrEqual(20);
    const withServiceName = HELD_OUT_CORPUS.filter(e => e.serviceName).length;
    const withTags = HELD_OUT_CORPUS.filter(e => e.tags?.length).length;
    // The whole point of this corpus is that the ranker's highest-weighted fields are mostly
    // absent in real data. If that stops being true, someone has tidied it.
    expect(withServiceName, "corpus has been tidied — too many serviceNames").toBeLessThan(5);
    expect(withTags, "corpus has been tidied — too many tag sets").toBeLessThan(5);
  });

  it("reports which queries miss, so a regression names the query", () => {
    for (const set of sets) {
      const missed = failures(set.results);
      // Not an assertion about the count — the thresholds cover that. This exists so the failure
      // output of a threshold break carries the queries with it.
      expect(Array.isArray(missed)).toBe(true);
    }
  });
});

/**
 * Component guards.
 *
 * The threshold gate above measures the ranker end to end, but end-to-end metrics at the judgment
 * count we currently have cannot resolve a single component: mutation-testing the ranker showed the
 * field weights, the coverage bonus and the quality multiplier could each be flattened or deleted
 * outright with every threshold still green. Tightening the thresholds is the wrong answer — at ten
 * queries per slice they are inside their own confidence interval, so a tighter number would be
 * noise dressed as a gate.
 *
 * These assert the *design invariants* instead. They are deterministic, independent of corpus size,
 * and each one fails against the specific mutation that removes the behaviour it names.
 */
describe("ranker component invariants", () => {
  const entry = (over: Partial<CatalogEntry> & { resource: string }): CatalogEntry => ({
    type: "http",
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: "stellar:testnet",
        amount: "1000000",
        asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        payTo: "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO",
        maxTimeoutSeconds: 60,
      },
    ],
    lastUpdated: new Date("2026-07-01").toISOString(),
    quality: { totalSettlements: 0, uniquePayers: 0, firstSeenAt: new Date("2026-07-01").toISOString() },
    ...over,
  }) as CatalogEntry;

  /**
   * Score a document with a named retriever.
   *
   * WHICH retriever a test uses is itself the assertion, and getting it wrong hid a real defect:
   * every invariant here once ran against `Bm25Retriever` while the shipped default was
   * `HybridRetriever`, so the anti-sybil property was verified on a code path nobody runs
   * (an invariant measured on a component that is not the one deployed).
   *
   * The split is now deliberate:
   *  - **FIELD WEIGHTS are a BM25 property.** RRF fuses RANKS, so two documents at the same rank in
   *    both arms fuse to the same score no matter how far apart their BM25 scores were. Asserting a
   *    weight difference through RRF would be asserting something RRF cannot express.
   *  - **USAGE and ANTI-SYBIL are deployed-behaviour claims.** They must hold on the retriever that
   *    actually serves `/discovery/search`, which is why those tests use `HybridRetriever`.
   */
  const scoreWith = (
    make: () => Retriever,
    corpus: CatalogEntry[],
    query: string,
    resource: string,
  ): number => {
    const r = make();
    r.index(corpus);
    const hit = r.search(query, corpus, corpus.length).find(s => s.entry.resource === resource);
    return hit?.score ?? 0;
  };
  /** Component-level: the lexical arm, where field weights live. */
  const lexicalScore = (corpus: CatalogEntry[], query: string, resource: string) =>
    scoreWith(() => new Bm25Retriever(), corpus, query, resource);
  /** Deployed: what `/discovery/search` actually returns. */
  const shippedScore = (corpus: CatalogEntry[], query: string, resource: string) =>
    scoreWith(() => new HybridRetriever(), corpus, query, resource);

  it("weights a service-name match above the same term in prose", () => {
    // Both documents carry the query term exactly once and have the SAME weighted length, so BM25
    // length normalisation cannot account for the difference: the only thing that separates them is
    // which field the term sits in. Flattening FIELD_WEIGHTS makes the two scores exactly equal.
    const corpus = [
      entry({ resource: "https://a.example/x", serviceName: "Kestrel", description: "alpha beta gamma delta" }),
      entry({ resource: "https://b.example/x", serviceName: "Osprey", description: "Kestrel beta gamma delta" }),
    ];
    // Component-level by design: RRF fuses ranks, so this difference is invisible to the fused
    // score. Field weighting still decides ORDER within the lexical arm, which is what feeds RRF.
    const named = lexicalScore(corpus, "kestrel", "https://a.example/x");
    const prose = lexicalScore(corpus, "kestrel", "https://b.example/x");
    expect(named, `serviceName match (${named}) must beat prose match (${prose})`).toBeGreaterThan(prose);
  });

  it("breaks a relevance tie by settled usage, and only by usage", () => {
    // Byte-identical text, so BM25 alone ties them. Deleting the quality multiplier makes them equal.
    const text = { description: "Convert an address into latitude and longitude coordinates." };
    const corpus = [
      entry({ resource: "https://busy.example/geo", ...text, quality: { totalSettlements: 40, uniquePayers: 20, firstSeenAt: new Date("2026-07-01").toISOString() } }),
      entry({ resource: "https://quiet.example/geo", ...text }),
    ];
    // On the SHIPPED retriever. This previously passed against `Bm25Retriever` while the fused
    // score ignored the multiplier entirely — two byte-identical documents tied at 1/60 + 1/61 and
    // the alphabetical tiebreak decided, so a 20-payer endpoint lost to an unused one.
    const busy = shippedScore(corpus, "latitude longitude", "https://busy.example/geo");
    const quiet = shippedScore(corpus, "latitude longitude", "https://quiet.example/geo");
    expect(busy, `used endpoint (${busy}) must outrank unused twin (${quiet})`).toBeGreaterThan(quiet);
  });

  it("does not let settlement count buy rank without distinct payers", () => {
    // The sybil fix: on a fee-sponsored rail two colluding addresses can inflate totalSettlements for
    // free, so it must not influence rank. Same distinct-payer count, vastly different settlement
    // count -> identical score. Before the fix (`payers*2 + settlements`) the wash-settled entry won.
    const text = { description: "Convert an address into latitude and longitude coordinates." };
    const seen = new Date("2026-07-01").toISOString();
    const corpus = [
      entry({ resource: "https://washed.example/geo", ...text, quality: { totalSettlements: 1000, uniquePayers: 3, firstSeenAt: seen } }),
      entry({ resource: "https://honest.example/geo", ...text, quality: { totalSettlements: 3, uniquePayers: 3, firstSeenAt: seen } }),
    ];
    const washed = shippedScore(corpus, "latitude longitude", "https://washed.example/geo");
    const honest = shippedScore(corpus, "latitude longitude", "https://honest.example/geo");
    // `not greater than`, not `equal`: the quality multiplier is identical for both (same distinct
    // payers), but RRF's rank inputs need not tie, so demanding exact equality would assert
    // something about the fusion that the sybil property does not require. What must hold is that
    // 1000 wash settlements buy NOTHING over 3 honest ones.
    expect(washed, `wash-settled (${washed}) must not outrank its honest twin (${honest})`).toBeLessThanOrEqual(honest);
  });

  /**
   * The coverage bonus is deliberately NOT guarded here, because measurement showed it has no
   * invariant to guard. It is a <=15% differential (1.35x for full coverage vs 1.175x for half)
   * competing against IDF ratios that are routinely 5-10x, so a document hammering one rare term
   * beats a document that answers the whole query at every term frequency tested -- including one
   * repetition. That is the exact case the bonus was introduced to fix, and it does not fix it.
   * Writing a test that passed here would have meant contriving a corpus until it went green.
   * Recorded in Q_ANALYSIS_2026-08-01.md; the component needs strengthening or removing, and either
   * way that decision needs the larger judgment set first.
   */
});
