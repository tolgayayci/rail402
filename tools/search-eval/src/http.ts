/**
 * The search evaluation over HTTP: the frozen corpus is seeded into a staging catalog through the
 * store (never through payments, never into a catalog holding other listings), and the evaluation
 * queries are sent to a running service's `GET /discovery/search`. The production ranker, with its
 * Postgres store, HTTP layer, index refresh and model binary, is scored by the same metrics as the
 * in-process evaluation and held to the same baseline.
 */
import { createHash } from "node:crypto";
import type { CatalogStore, ListingContent, PaymentOption } from "@rail402.dev/bazaar";
import { AssetRegistry, type KnownAsset, type RankerIdentity, type SearchFilter } from "@rail402.dev/search";
import { unmetConstraints, type ConstraintName } from "./constraints.ts";
import { toListing, type Dataset } from "./dataset.ts";
import { asConstraints, effectiveFilter } from "./evaluate.ts";
import { TOLERANCE, type Baseline } from "./gate.ts";
import { evaluateQuery, hasRelevant, mean, percentile, type QueryMetrics } from "./metrics.ts";

const DEPTH = 20;

/** The UUID a corpus listing is stored under: listing ids in Postgres are UUIDs. */
export function corpusUuid(id: string): string {
  const hex = createHash("sha256").update(`rail402-search-eval:${id}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Inserts the corpus into `store`, published, through the store itself. Refuses a catalog that holds
 * anything but this corpus, so evaluation listings never mix with real ones. Seeding a catalog that
 * already holds exactly the corpus changes nothing. Returns the number of listings inserted.
 */
export async function seedCatalog(store: CatalogStore, dataset: Dataset): Promise<number> {
  const stats = await store.stats();
  const held = stats.listings.pending + stats.listings.published + stats.listings.quarantined;
  if (held > 0) {
    const { listings } = await store.published();
    const corpus = new Set(dataset.corpus.map((entry) => corpusUuid(entry.id)));
    if (
      listings.length === held &&
      held === corpus.size &&
      listings.every((listing) => corpus.has(listing.id))
    ) {
      return 0;
    }
    throw new Error(
      `refusing to seed: the catalog holds ${String(held)} listings that are not exactly the evaluation corpus; use an empty staging database`,
    );
  }
  for (const [index, entry] of dataset.corpus.entries()) {
    const base = toListing(entry, index + 1);
    const listing = { ...base, id: corpusUuid(entry.id), listedAt: base.firstCatalogedAt };
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
  return dataset.corpus.length;
}

/** A search result as `GET /discovery/search` publishes it, with the fields the evaluation reads. */
interface PublishedItem {
  readonly type: string;
  readonly accepts: readonly PaymentOption[];
  readonly rail402: {
    readonly listings: readonly { readonly id: string }[];
    readonly options: readonly { readonly listing: string }[];
  };
}

interface SearchResponse {
  readonly resources: readonly PublishedItem[];
  readonly partialResults: boolean;
  readonly rail402: { readonly method: string; readonly queryEmbedding?: string };
}

export interface HttpEvalOptions {
  /** Sends a GET for a path such as `/discovery/search?query=…` and returns the response. */
  readonly get: (path: string) => Promise<Response>;
  readonly dataset: Dataset;
  readonly assets: readonly KnownAsset[];
}

export interface HttpReport {
  readonly datasetHash: string;
  /** The service's ranker, read from `/health` (`search.ranker`); null when it reports none. */
  readonly ranker: RankerIdentity | null;
  readonly version: string | null;
  readonly test: {
    readonly queries: number;
    readonly ndcgAt10: number;
    readonly recallAt20: number;
    readonly mrr: number;
  };
  readonly all: { readonly queries: number; readonly ndcgAt10: number; readonly recallAt20: number };
  /** How the service answered: by method, and how many answers were partial. */
  readonly methods: Readonly<Record<string, number>>;
  readonly partial: number;
  readonly violations: Readonly<Record<ConstraintName, number>>;
  readonly checkedResults: number;
  /** Requests that did not answer 200, with their status. */
  readonly errors: readonly { readonly query: string; readonly status: number }[];
  readonly latencyMs: { readonly p50: number; readonly p95: number; readonly p99: number };
}

/** The query string of a search for `text` with explicit `filter` parameters. */
export function searchPath(text: string, filter: SearchFilter | undefined): string {
  const params = new URLSearchParams({ query: text, limit: String(DEPTH) });
  for (const key of ["type", "payTo", "scheme", "network", "asset"] as const) {
    const value = filter?.[key];
    if (value !== undefined) params.set(key, value);
  }
  if (filter?.extensions !== undefined) params.set("extensions", filter.extensions.join(","));
  if (filter?.maxPrice !== undefined) {
    params.set("maxPrice", filter.maxPrice.value);
    if (
      filter.maxPrice.unit === "asset" &&
      filter.asset === undefined &&
      filter.maxPrice.symbol !== undefined
    ) {
      params.set("asset", filter.maxPrice.symbol);
    }
  }
  return `/discovery/search?${params.toString()}`;
}

/** Runs every evaluation query against the service and scores the answers. */
export async function evaluateOverHttp(options: HttpEvalOptions): Promise<HttpReport> {
  const { dataset, assets } = options;
  const registry = new AssetRegistry(assets);
  const byUuid = new Map(dataset.corpus.map((entry) => [corpusUuid(entry.id), entry.id]));
  const perQuery = new Map<string, QueryMetrics>();
  const methods: Record<string, number> = {};
  const violations: Record<ConstraintName, number> = {
    network: 0,
    type: 0,
    asset: 0,
    price: 0,
    scheme: 0,
    payTo: 0,
  };
  const errors: { query: string; status: number }[] = [];
  const latencies: number[] = [];
  let partial = 0;
  let checkedResults = 0;

  for (const query of dataset.queries) {
    const started = performance.now();
    const response = await options.get(searchPath(query.text, query.filter));
    latencies.push(performance.now() - started);
    if (response.status !== 200) {
      errors.push({ query: query.id, status: response.status });
      await response.body?.cancel();
      continue;
    }
    const body = (await response.json()) as SearchResponse;
    methods[body.rail402.method] = (methods[body.rail402.method] ?? 0) + 1;
    if (body.partialResults) partial++;
    // A resource on several networks is one result; each of its listings is judged on its own.
    const ranking: string[] = [];
    const applied = asConstraints(effectiveFilter(query, registry), assets);
    const constrained = Object.keys(applied).length > 0;
    for (const item of body.resources) {
      for (const listing of item.rail402.listings) {
        ranking.push(byUuid.get(listing.id) ?? listing.id);
        if (!constrained) continue;
        checkedResults++;
        const accepts = item.accepts.filter(
          (_, index) => item.rail402.options[index]?.listing === listing.id,
        );
        const content = { kind: item.type, accepts } as unknown as ListingContent;
        for (const unmet of unmetConstraints(content, applied, assets)) violations[unmet]++;
      }
    }
    const judgments = dataset.qrels.get(query.id) ?? new Map<string, number>();
    if (hasRelevant(judgments)) perQuery.set(query.id, evaluateQuery(ranking, judgments));
  }

  const scored = (split?: "test") =>
    dataset.queries
      .filter((query) => split === undefined || query.split === split)
      .map((query) => perQuery.get(query.id))
      .filter((metrics): metrics is QueryMetrics => metrics !== undefined);
  const test = scored("test");
  const all = scored();
  const health = await readHealth(options.get);
  return {
    datasetHash: dataset.hash,
    ranker: health.ranker,
    version: health.version,
    test: {
      queries: test.length,
      ndcgAt10: mean(test.map((m) => m.ndcgAt10)),
      recallAt20: mean(test.map((m) => m.recallAt20)),
      mrr: mean(test.map((m) => m.reciprocalRank)),
    },
    all: {
      queries: all.length,
      ndcgAt10: mean(all.map((m) => m.ndcgAt10)),
      recallAt20: mean(all.map((m) => m.recallAt20)),
    },
    methods,
    partial,
    violations,
    checkedResults,
    errors,
    latencyMs: {
      p50: round(percentile(latencies, 50)),
      p95: round(percentile(latencies, 95)),
      p99: round(percentile(latencies, 99)),
    },
  };
}

async function readHealth(
  get: (path: string) => Promise<Response>,
): Promise<{ ranker: RankerIdentity | null; version: string | null }> {
  try {
    const response = await get("/health");
    if (response.status !== 200) return { ranker: null, version: null };
    const body = (await response.json()) as { version?: string; search?: { ranker?: RankerIdentity } };
    return { ranker: body.search?.ranker ?? null, version: body.version ?? null };
  } catch {
    return { ranker: null, version: null };
  }
}

/**
 * The parity gate: the service must reproduce the tagged evaluation within TOLERANCE on test nDCG@10
 * and Recall@20, stay at or above the baseline's BM25, answer every query with the hybrid ranker
 * (no lexical fallback), return no result that breaks a filter, and run the baseline's model.
 */
export function httpGate(report: HttpReport, baseline: Baseline): string[] {
  const failures: string[] = [];
  if (report.datasetHash !== baseline.datasetHash) failures.push("the dataset differs from the baseline's");
  for (const metric of ["ndcgAt10", "recallAt20"] as const) {
    const value = report.test[metric];
    if (value < baseline.test.hybrid[metric] - TOLERANCE) {
      failures.push(
        `hybrid test ${metric} ${value.toFixed(4)} is more than ${String(TOLERANCE)} below the baseline's ${String(baseline.test.hybrid[metric])}`,
      );
    }
    if (value < baseline.test.lexical[metric]) {
      failures.push(
        `hybrid test ${metric} ${value.toFixed(4)} is below the baseline's BM25 ${String(baseline.test.lexical[metric])}`,
      );
    }
  }
  const total = Object.values(report.violations).reduce((sum, count) => sum + count, 0);
  if (total > 0)
    failures.push(`${String(total)} results break a filter: ${JSON.stringify(report.violations)}`);
  if ((report.methods["lexical"] ?? 0) > 0) {
    failures.push(
      `${String(report.methods["lexical"])} queries were answered lexical-only; the embedder did not rank them`,
    );
  }
  if (report.errors.length > 0) failures.push(`${String(report.errors.length)} queries did not answer 200`);
  const model =
    report.ranker === null ? undefined : `${report.ranker.model ?? ""}@${report.ranker.revision ?? ""}`;
  if (model === undefined) failures.push("the service's /health reports no search.ranker");
  else if (model !== baseline.model)
    failures.push(`the service ranks with ${model}, the baseline with ${baseline.model}`);
  return failures;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
