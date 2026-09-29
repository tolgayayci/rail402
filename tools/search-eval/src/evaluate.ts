import { availableParallelism, cpus } from "node:os";
import { MemoryCatalogStore } from "@rail402.dev/bazaar";
import {
  AssetRegistry,
  SearchService,
  parseQuery,
  type Embedder,
  type KnownAsset,
  type SearchFilter,
} from "@rail402.dev/search";
import { checkFilters, type ConformanceReport } from "./conformance.ts";
import { unmetConstraints, type ConstraintName } from "./constraints.ts";
import {
  toListing,
  type Dataset,
  type EvalQuery,
  type ExpectedConstraints,
  type QueryClass,
} from "./dataset.ts";
import {
  bootstrapInterval,
  evaluateQuery,
  hasRelevant,
  mean,
  pairedRandomizationTest,
  percentile,
  type QueryMetrics,
} from "./metrics.ts";

export type Mode = "lexical" | "hybrid";
const MODES: readonly Mode[] = ["lexical", "hybrid"];
const DEPTH = 20;

export interface Aggregate {
  readonly queries: number;
  readonly mrr: number;
  readonly ndcgAt10: number;
  readonly recallAt20: number;
  readonly precisionAt1: number;
}

export interface ModeReport {
  readonly splits: Readonly<Record<"dev" | "test" | "all", Aggregate>>;
  readonly classes: Readonly<Partial<Record<QueryClass, Aggregate>>>;
  /** 95% bootstrap intervals on the test split. */
  readonly intervals: Readonly<Record<"ndcgAt10" | "recallAt20", readonly [number, number]>>;
  readonly latencyMs: Readonly<Record<"p50" | "p95" | "p99" | "mean", number>>;
  /** No-answer queries (no listing graded ≥ 2) that returned no results at all. */
  readonly emptyOnNoAnswer: number;
}

export type Constraint = ConstraintName;
/** The constraints queries are labelled with. */
type Labelled = "network" | "type" | "asset" | "price";

/** How well constraints stated in query text were recovered, per constraint, against the labels. */
export interface Extraction {
  readonly labelled: number;
  readonly recovered: number;
  /** Constraints applied that the searcher did not ask for. */
  readonly spurious: number;
}

export interface Report {
  readonly dataset: {
    readonly version: string;
    readonly hash: string;
    readonly listings: number;
    readonly public: number;
    readonly sample: number;
    readonly queries: number;
    readonly noAnswerQueries: number;
  };
  readonly model: string;
  readonly environment: { readonly node: string; readonly cpu: string; readonly cores: number };
  readonly modes: Readonly<Record<Mode, ModeReport>>;
  /** Hybrid minus lexical on the test split, with paired randomization-test p-values. */
  readonly comparison: Readonly<Record<"ndcgAt10" | "recallAt20" | "mrr", { delta: number; pValue: number }>>;
  /**
   * Results that break a filter the service applied (explicit parameters plus constraints it parsed
   * from the text), checked by an implementation independent of the service. Must be zero.
   */
  readonly filters: {
    readonly checkedQueries: number;
    readonly checkedResults: number;
    readonly violations: Readonly<Record<Constraint, number>>;
  };
  /**
   * Each constraint tested on its own against a generated catalog built to stress it (conformance.ts):
   * violations and missed listings, per constraint. Both must be zero.
   */
  readonly filterConformance: ConformanceReport;
  /**
   * Against the hand-labelled constraints of each query: how many were applied, and how many
   * hybrid results fail what the searcher asked for (a missed constraint shows up here).
   */
  readonly constraints: {
    readonly queries: number;
    readonly extraction: Readonly<Record<Labelled, Extraction>>;
    readonly resultsChecked: number;
    readonly resultsUnmet: number;
  };
}

export interface EvaluateOptions {
  readonly embedder: Embedder;
  readonly assets: readonly KnownAsset[];
  readonly modelLabel: string;
  readonly repeats?: number;
}

/** Evaluates BM25-only and hybrid search on the frozen dataset. Deterministic apart from latency. */
export async function evaluate(dataset: Dataset, options: EvaluateOptions): Promise<Report> {
  const store = new MemoryCatalogStore();
  for (const [index, entry] of dataset.corpus.entries()) {
    const listing = toListing(entry, index + 1);
    await store.transaction(listing.identity, (tx) =>
      tx.insert(listing, {
        listingId: listing.id,
        version: 1,
        createdAt: listing.firstCatalogedAt,
        cause: "settlement",
        owner: listing.owner,
        trust: listing.trust,
        state: listing.state,
        content: listing.content,
      }),
    );
  }
  const registry = new AssetRegistry(options.assets);
  const secret = Buffer.alloc(32, 1);
  const services: Record<Mode, SearchService> = {
    lexical: new SearchService({ store, assets: registry, cursorSecret: secret }),
    hybrid: new SearchService({ store, assets: registry, cursorSecret: secret, embedder: options.embedder }),
  };
  for (const mode of MODES) await services[mode].refresh();

  const perQuery: Record<Mode, Map<string, QueryMetrics>> = { lexical: new Map(), hybrid: new Map() };
  const latencies: Record<Mode, number[]> = { lexical: [], hybrid: [] };
  const empty: Record<Mode, number> = { lexical: 0, hybrid: 0 };
  const violations: Record<Constraint, number> = {
    network: 0,
    type: 0,
    asset: 0,
    price: 0,
    scheme: 0,
    payTo: 0,
  };
  const extraction: Record<Labelled, { labelled: number; recovered: number; spurious: number }> = {
    network: { labelled: 0, recovered: 0, spurious: 0 },
    type: { labelled: 0, recovered: 0, spurious: 0 },
    asset: { labelled: 0, recovered: 0, spurious: 0 },
    price: { labelled: 0, recovered: 0, spurious: 0 },
  };
  let labelledQueries = 0;
  let expectedChecked = 0;
  let expectedUnmet = 0;
  let checkedQueries = 0;
  let checkedResults = 0;
  const repeats = options.repeats ?? 3;

  for (const query of dataset.queries) {
    const judgments = dataset.qrels.get(query.id) ?? new Map<string, number>();
    const answerable = hasRelevant(judgments);
    const applied = asConstraints(effectiveFilter(query, registry), options.assets);
    const constrained = Object.keys(applied).length > 0;
    if (constrained) checkedQueries++;
    if (query.expected !== undefined) {
      labelledQueries++;
      for (const name of ["network", "type", "asset", "price"] as const) {
        const wanted = pick(query.expected, name);
        const got = pick(applied, name);
        if (wanted !== undefined) extraction[name].labelled++;
        if (wanted !== undefined && got === wanted) extraction[name].recovered++;
        if (got !== undefined && got !== wanted) extraction[name].spurious++;
      }
    }

    for (const mode of MODES) {
      let ranking: string[] = [];
      for (let run = 0; run < repeats; run++) {
        const started = performance.now();
        const result = await services[mode].search({
          query: query.text,
          filter: query.filter ?? {},
          limit: DEPTH,
        });
        latencies[mode].push(performance.now() - started);
        // A resource on several networks is one result; each of its listings is judged on its own.
        const listings = result.resources.flat();
        ranking = listings.map((listing) => listing.id);
        if (run === 0 && constrained) {
          for (const listing of listings) {
            checkedResults++;
            for (const unmet of unmetConstraints(listing.content, applied, options.assets))
              violations[unmet]++;
          }
        }
        if (run === 0 && mode === "hybrid" && query.expected !== undefined) {
          for (const listing of listings) {
            expectedChecked++;
            if (unmetConstraints(listing.content, query.expected, options.assets).length > 0) expectedUnmet++;
          }
        }
      }
      if (answerable) perQuery[mode].set(query.id, evaluateQuery(ranking, judgments));
      else if (ranking.length === 0) empty[mode]++;
    }
  }

  const answerable = dataset.queries.filter((query) => perQuery.lexical.has(query.id));
  const aggregate = (mode: Mode, queries: readonly EvalQuery[]): Aggregate => {
    const metrics = queries
      .map((query) => perQuery[mode].get(query.id))
      .filter((m): m is QueryMetrics => m !== undefined);
    return {
      queries: metrics.length,
      mrr: mean(metrics.map((m) => m.reciprocalRank)),
      ndcgAt10: mean(metrics.map((m) => m.ndcgAt10)),
      recallAt20: mean(metrics.map((m) => m.recallAt20)),
      precisionAt1: mean(metrics.map((m) => m.precisionAt1)),
    };
  };
  const test = answerable.filter((query) => query.split === "test");
  const series = (mode: Mode, key: keyof QueryMetrics) =>
    test.map((query) => perQuery[mode].get(query.id)?.[key] ?? 0);

  const modes = Object.fromEntries(
    MODES.map((mode) => {
      const classes: Partial<Record<QueryClass, Aggregate>> = {};
      for (const cls of new Set(answerable.map((query) => query.class))) {
        classes[cls] = aggregate(
          mode,
          answerable.filter((query) => query.class === cls),
        );
      }
      const report: ModeReport = {
        splits: {
          dev: aggregate(
            mode,
            answerable.filter((query) => query.split === "dev"),
          ),
          test: aggregate(mode, test),
          all: aggregate(mode, answerable),
        },
        classes,
        intervals: {
          ndcgAt10: bootstrapInterval(series(mode, "ndcgAt10")),
          recallAt20: bootstrapInterval(series(mode, "recallAt20")),
        },
        latencyMs: {
          p50: round(percentile(latencies[mode], 50)),
          p95: round(percentile(latencies[mode], 95)),
          p99: round(percentile(latencies[mode], 99)),
          mean: round(mean(latencies[mode])),
        },
        emptyOnNoAnswer: empty[mode],
      };
      return [mode, report];
    }),
  ) as Record<Mode, ModeReport>;

  const compare = (key: keyof QueryMetrics) => ({
    delta: mean(series("hybrid", key)) - mean(series("lexical", key)),
    pValue: pairedRandomizationTest(series("hybrid", key), series("lexical", key)),
  });

  return {
    dataset: {
      version: dataset.manifest.version,
      hash: dataset.hash,
      listings: dataset.corpus.length,
      public: dataset.corpus.filter((entry) => entry.source === "public").length,
      sample: dataset.corpus.filter((entry) => entry.source === "sample").length,
      queries: dataset.queries.length,
      noAnswerQueries: dataset.queries.length - answerable.length,
    },
    model: options.modelLabel,
    environment: { node: process.version, cpu: cpus()[0]?.model ?? "unknown", cores: availableParallelism() },
    modes,
    comparison: {
      ndcgAt10: compare("ndcgAt10"),
      recallAt20: compare("recallAt20"),
      mrr: compare("reciprocalRank"),
    },
    filters: { checkedQueries, checkedResults, violations },
    filterConformance: await checkFilters(options.embedder),
    constraints: {
      queries: labelledQueries,
      extraction,
      resultsChecked: expectedChecked,
      resultsUnmet: expectedUnmet,
    },
  };
}

/** The hard filter a query ends up with: constraints parsed from its text, overridden by explicit ones. */
function effectiveFilter(query: EvalQuery, registry: AssetRegistry): SearchFilter {
  const parsed = parseQuery(query.text, registry.symbols());
  return { ...parsed.filter, ...(query.filter ?? {}) };
}

/** A search filter in the labelled-constraint vocabulary, so both are checked the same way. */
function asConstraints(filter: SearchFilter, assets: readonly KnownAsset[]): ExpectedConstraints {
  const symbol =
    filter.asset === undefined
      ? undefined
      : (assets.find((known) => known.contract === filter.asset)?.symbol ?? filter.asset.toUpperCase());
  return {
    ...(filter.network === undefined ? {} : { network: filter.network }),
    ...(filter.scheme === undefined ? {} : { scheme: filter.scheme }),
    ...(filter.payTo === undefined ? {} : { payTo: filter.payTo }),
    ...(filter.type === "http" || filter.type === "mcp" ? { type: filter.type } : {}),
    ...(symbol === undefined ? {} : { asset: symbol }),
    ...(filter.maxPrice === undefined
      ? {}
      : {
          maxPrice: {
            amount: filter.maxPrice.value,
            unit: filter.maxPrice.unit === "usd" ? "USD" : (filter.maxPrice.symbol ?? symbol ?? ""),
          },
        }),
  };
}

/** One constraint as a comparable string. */
function pick(constraints: ExpectedConstraints, name: Labelled): string | undefined {
  switch (name) {
    case "network":
      return constraints.network;
    case "type":
      return constraints.type;
    case "asset": {
      // A ceiling stated in an asset ("under 0.02 USDC") already requires paying in that asset.
      const unit = constraints.maxPrice?.unit.toUpperCase();
      return (constraints.asset ?? (unit === undefined || unit === "USD" ? undefined : unit))?.toUpperCase();
    }
    case "price":
      return constraints.maxPrice === undefined
        ? undefined
        : `${String(Number(constraints.maxPrice.amount))} ${constraints.maxPrice.unit.toUpperCase()}`;
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
