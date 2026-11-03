import { readFileSync } from "node:fs";
import { defineCodes, errorFactory } from "@rail402.dev/errors";
import {
  narrowOptions,
  resourceKey,
  trustRank,
  type CatalogStore,
  type Listing,
  type ResourceListings,
} from "@rail402.dev/bazaar";
import {
  Bm25Index,
  byScore,
  POSTING_ENTRY_BYTES,
  reciprocalRankFusion,
  termBytes,
  type Scored,
} from "./bm25.ts";
import {
  type AssetRegistry,
  optionSatisfies,
  parseQuery,
  satisfies,
  type SearchFilter,
} from "./constraints.ts";
import { CursorCodec, requestDigest } from "./cursor.ts";
import { cosine, type Embedder } from "./embedder.ts";
import { tokenize, toDocument, type SearchDocument } from "./text.ts";

export const searchCodes = defineCodes({
  search_query_required: {
    status: 400,
    retryable: false,
    reason: "The `query` parameter is required and must not be blank.",
  },
  search_query_too_long: {
    status: 400,
    retryable: false,
    reason: "The query exceeds 500 characters.",
  },
  search_invalid_cursor: {
    status: 400,
    retryable: false,
    reason: "The cursor is malformed, altered, or belongs to a different search.",
  },
  search_cursor_expired: {
    status: 400,
    retryable: false,
    reason: "The cursor has expired or its index snapshot is gone; repeat the search without a cursor.",
  },
});

export const searchError = errorFactory(searchCodes);

export const MAX_QUERY_LENGTH = 500;

/** The search evaluation release whose results this ranker is measured against. */
export const EVAL_BASELINE = "search-eval-v1.1.0";

/** This package's version, the version of the ranking code. */
export const SEARCH_PACKAGE_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

/**
 * What ranks search results, so a running instance can be tied to the evaluation it reproduces: the
 * embedding model and its file hashes, the similarity floor and semantic depth, and the code version.
 */
export interface RankerIdentity {
  /** The embedding model's id; null when search runs lexical-only. */
  readonly model: string | null;
  readonly revision: string | null;
  /** SHA-256 of the model and tokenizer files, as pinned and checked at startup. */
  readonly files: { readonly model: string; readonly tokenizer: string } | null;
  readonly similarityFloor: number;
  readonly depth: number;
  readonly embeddings: boolean;
  readonly searchPackage: string;
  readonly evalBaseline: string;
}

export interface SearchRequest {
  readonly query: string;
  /** Explicit filters; they take precedence over constraints recognised in the query. */
  readonly filter: SearchFilter;
  readonly limit: number;
  readonly cursor?: string;
  /**
   * How many results of a page to keep, at least one: a response-size budget ends the page early and
   * the cursor continues after the last result kept.
   */
  readonly fit?: (page: readonly ResourceListings[]) => number;
}

export type SearchMethod = "hybrid" | "lexical" | "filter";

/**
 * How a search got its query embedding: `cached` from the query-embedding cache, `computed` by the
 * embedder now, `saturated` not at all because the embedder was at its concurrency cap (the search
 * ran lexical-only), `failed` when the embedder failed or ran out of time, `none` when no embedding
 * was needed or no embedder is configured.
 */
export type QueryEmbedding = "cached" | "computed" | "saturated" | "failed" | "none";

export interface SearchResult {
  /**
   * Matching resources, best first. A resource holds its matching listings, one per network, the
   * best-ranked first, each narrowed to the payment options that satisfy the filters.
   */
  readonly resources: readonly ResourceListings[];
  /**
   * True when semantic matches above the similarity floor were cut at the retrieval depth, or when a
   * ranked search ran lexical-only: no embedder is configured, or it failed or ran out of time.
   */
  readonly partialResults: boolean;
  readonly nextCursor: string | null;
  readonly limit: number;
  readonly method: SearchMethod;
  readonly queryEmbedding: QueryEmbedding;
  /** Constraints recognised in the query text and applied as hard filters. */
  readonly recognised: readonly string[];
  readonly revision: number;
}

/**
 * Instrumentation seam of the search service. Implementations must be cheap; anything they throw is
 * contained and never affects a search.
 */
export interface SearchObserver {
  /**
   * An index snapshot was built: `ok`, `degraded` (the embedder failed, so the snapshot serves
   * lexical-only results), or `failed` (the catalog could not be read; the previous snapshot stays).
   */
  indexBuild(outcome: "ok" | "degraded" | "failed", ms: number): void;
  /** Embedding a listing (`document`) or a query (`query`) failed or ran out of time. */
  embeddingFailure(stage: "document" | "query"): void;
  /** A search was answered. */
  search(method: SearchMethod, partial: boolean, ms: number): void;
  /** How a search got its query embedding (see QueryEmbedding). */
  queryEmbedding?(outcome: QueryEmbedding): void;
  /** The snapshots kept after a build or eviction: how many, and their estimated size in bytes. */
  snapshots?(count: number, bytes: number): void;
  /**
   * After each build, per network with published listings: how many of them the latest snapshot left
   * out because the network's share of the index was full (see maxIndexBytesPerNetwork).
   */
  leftOut?(network: string, count: number): void;
}

export interface SearchServiceOptions {
  /** Where searches read the catalog revision and their result pages. */
  readonly store: CatalogStore;
  /**
   * Where index builds scan the catalog and `refresh` reads the revision (default `store`). Give it
   * connections no request can take: a search that finds the index behind the catalog joins the build
   * in flight, whoever started it, so a build waiting for a connection held by request load would hold
   * every search with it.
   */
  readonly indexStore?: CatalogStore;
  readonly assets: AssetRegistry;
  /** Without an embedder the service runs lexical-only and reports partialResults. */
  readonly embedder?: Embedder;
  /** 32+ bytes shared by every replica, so cursors issued by one replica work on another. */
  readonly cursorSecret: Buffer;
  /** Semantic candidates taken before fusion; the lexical ranking is never cut. */
  readonly depth?: number;
  /** Minimum cosine similarity for a semantic match. */
  readonly similarityFloor?: number;
  readonly cursorTtlMs?: number;
  /**
   * How long a read of the catalog revision is reused before the store is asked again; new listings
   * become searchable within this delay. 0 asks on every search.
   */
  readonly revisionMaxAgeMs?: number;
  /** How long embedding a query may take before the search answers lexical-only. */
  readonly semanticBudgetMs?: number;
  /**
   * Embeddings run at once, queries and index builds together (default 1). A query that finds every
   * slot taken and `embedQueueLength` queries already waiting answers lexical-only, as partial
   * results, instead of queueing behind the model: search never takes more CPU than this.
   */
  readonly embedConcurrency?: number;
  /** Queries that may wait for an embedding slot (default 2); index builds wait without limit. */
  readonly embedQueueLength?: number;
  /** Query embeddings kept, least recently used evicted first (default 1,000; 0 disables). */
  readonly queryCacheSize?: number;
  /**
   * Listings of result pages kept for reuse (default 512; 0 disables), the oldest evicted first. A
   * page's listings are read from the store once per `revisionMaxAgeMs` at most: a kept listing is
   * reused while it is younger than that and the catalog is still at the revision it was read at. A
   * withdrawal or a content change moves the revision, so it is never hidden by the cache; settlement
   * counts and facts, which change without a revision, are at most `revisionMaxAgeMs` old.
   */
  readonly pageCacheSize?: number;
  /**
   * Snapshots kept at most, the latest included (default 4). Superseded snapshots are kept only while
   * a cursor issued on them is valid; over either cap the oldest go first, and their cursors expire.
   */
  readonly maxSnapshots?: number;
  /** Estimated bytes all kept snapshots may hold (default 256 MiB); the latest is always kept. */
  readonly maxSnapshotBytes?: number;
  /**
   * Estimated bytes one network's listings may take in a snapshot (default 96 MiB): the index holds
   * at most this much per network, whatever the catalog holds. Listings are taken in catalog order
   * and those that no longer fit are left out of search (discovery still lists them); listings at
   * trust `settled`, which no origin confirmed, may take at most half of it. Each network has its own
   * share, so a flood of free testnet listings never pushes pubnet listings out.
   */
  readonly maxIndexBytesPerNetwork?: number;
  readonly now?: () => number;
  /** Receives index builds, embedding failures and search timings. */
  readonly observer?: SearchObserver;
}

interface Snapshot {
  readonly revision: number;
  /**
   * The indexed listings, reduced to what ranking, filters and grouping read (see `indexed`): never
   * their metadata. A page reads its listings from the store as they are now.
   */
  readonly listings: ReadonlyMap<string, Listing>;
  readonly order: readonly Listing[];
  /** Listing id → the ids of every listing of its resource, in catalog order. */
  readonly siblings: ReadonlyMap<string, readonly string[]>;
  readonly bm25: Bm25Index;
  readonly vectors: ReadonlyMap<string, Float32Array> | undefined;
  /** Keys into the embedding cache this snapshot uses. */
  readonly embeddingKeys: ReadonlySet<string>;
  /** Estimated memory the snapshot holds. */
  readonly bytes: number;
}

/**
 * Bounds how many embeddings run at once. Queries try to take a slot and give up when the queue is
 * full; index builds wait their turn.
 */
class EmbedGate {
  private running = 0;
  private readonly waiting: (() => void)[] = [];
  private queuedQueries = 0;
  private readonly slots: number;
  private readonly queueLength: number;

  constructor(slots: number, queueLength: number) {
    this.slots = slots;
    this.queueLength = queueLength;
  }

  /** Takes a slot for a query, waiting behind at most `queueLength` others; false when saturated. */
  async tryAcquire(): Promise<boolean> {
    if (this.running < this.slots) {
      this.running++;
      return true;
    }
    if (this.queuedQueries >= this.queueLength) return false;
    this.queuedQueries++;
    try {
      await this.wait();
    } finally {
      this.queuedQueries--;
    }
    return true;
  }

  /** Takes a slot, waiting as long as it takes. */
  async acquire(): Promise<void> {
    if (this.running < this.slots) {
      this.running++;
      return;
    }
    await this.wait();
  }

  release(): void {
    const next = this.waiting.shift();
    if (next === undefined) this.running--;
    else next();
  }

  /** Waits for a released slot, which is handed over without changing `running`. */
  private wait(): Promise<void> {
    return new Promise((resolve) => this.waiting.push(resolve));
  }
}

/**
 * Hybrid search over the published catalog. Each catalog revision gets an immutable in-memory
 * snapshot (BM25F index plus embeddings); results come from fusing the lexical and semantic
 * rankings with RRF, restricted beforehand to listings that satisfy every hard filter.
 */
export class SearchService {
  private readonly store: CatalogStore;
  private readonly indexStore: CatalogStore;
  private readonly assets: AssetRegistry;
  private readonly embedder: Embedder | undefined;
  private readonly cursors: CursorCodec;
  private readonly depth: number;
  private readonly similarityFloor: number;
  private readonly cursorTtlMs: number;
  private readonly revisionMaxAgeMs: number;
  private readonly semanticBudgetMs: number;
  private readonly now: () => number;
  private readonly observer: SearchObserver | undefined;
  private readonly snapshots = new Map<number, Snapshot>();
  /** Revision → when the last cursor issued on that snapshot expires. */
  private readonly cursorsUntil = new Map<number, number>();
  private revisionRead: { readonly value: number; readonly at: number } | undefined;
  private readonly embeddings = new Map<string, Float32Array>();
  /** Query text → its embedding, least recently used first. */
  private readonly queryCache = new Map<string, Float32Array>();
  private readonly queryCacheSize: number;
  /** Listing id → the listing as last read for a page, the snapshot revision and when; oldest first. */
  private readonly pageCache = new Map<
    string,
    { readonly listing: Listing; readonly revision: number; readonly at: number }
  >();
  private readonly pageCacheSize: number;
  private readonly gate: EmbedGate;
  private readonly maxSnapshots: number;
  private readonly maxSnapshotBytes: number;
  private readonly maxIndexBytesPerNetwork: number;
  private latest: Snapshot | undefined;
  private building: Promise<Snapshot> | undefined;

  constructor(options: SearchServiceOptions) {
    this.store = options.store;
    this.indexStore = options.indexStore ?? options.store;
    this.assets = options.assets;
    this.embedder = options.embedder;
    this.cursors = new CursorCodec(options.cursorSecret);
    this.depth = options.depth ?? 100;
    this.similarityFloor = options.similarityFloor ?? 0.3;
    this.cursorTtlMs = options.cursorTtlMs ?? 15 * 60_000;
    this.revisionMaxAgeMs = options.revisionMaxAgeMs ?? 0;
    this.semanticBudgetMs = options.semanticBudgetMs ?? 2_000;
    this.gate = new EmbedGate(
      Math.max(1, options.embedConcurrency ?? 1),
      Math.max(0, options.embedQueueLength ?? 2),
    );
    this.queryCacheSize = Math.max(0, options.queryCacheSize ?? 1_000);
    this.pageCacheSize = this.revisionMaxAgeMs > 0 ? Math.max(0, options.pageCacheSize ?? 512) : 0;
    this.maxSnapshots = Math.max(1, options.maxSnapshots ?? 4);
    this.maxSnapshotBytes = options.maxSnapshotBytes ?? 256 * 1024 * 1024;
    this.maxIndexBytesPerNetwork = options.maxIndexBytesPerNetwork ?? 96 * 1024 * 1024;
    this.now = options.now ?? Date.now;
    this.observer = options.observer;
  }

  /** What ranks this service's results (see RankerIdentity). */
  rankerIdentity(): RankerIdentity {
    const manifest = this.embedder?.manifest;
    return {
      model: this.embedder === undefined ? null : (manifest?.id ?? this.embedder.id),
      revision: manifest?.revision ?? null,
      files:
        manifest === undefined
          ? null
          : { model: manifest.files.model.sha256, tokenizer: manifest.files.tokenizer.sha256 },
      similarityFloor: this.similarityFloor,
      depth: this.depth,
      embeddings: this.embedder !== undefined,
      searchPackage: SEARCH_PACKAGE_VERSION,
      evalBaseline: EVAL_BASELINE,
    };
  }

  /** The catalog revision the latest index snapshot was built from; undefined before the first build. */
  get indexRevision(): number | undefined {
    return this.latest?.revision;
  }

  /**
   * Brings the index up to the catalog's current revision. The revision is read from the index store
   * now, never reused from an earlier read, so every change committed before the call is searchable
   * once it resolves. A build that fails rejects it.
   */
  async refresh(): Promise<Snapshot> {
    return this.indexAt(await this.readRevision(this.indexStore));
  }

  /**
   * The index at a revision read at most revisionMaxAgeMs ago: the path searches take. While a build
   * cannot read the catalog, the latest snapshot answers; the next build catches up.
   */
  private async recent(): Promise<Snapshot> {
    const now = this.now();
    const revision =
      this.revisionRead !== undefined && now - this.revisionRead.at < this.revisionMaxAgeMs
        ? this.revisionRead.value
        : await this.readRevision(this.store);
    try {
      return await this.indexAt(revision);
    } catch (error) {
      if (this.latest === undefined) throw error;
      return this.latest;
    }
  }

  private async readRevision(store: CatalogStore): Promise<number> {
    const at = this.now();
    const value = await store.revision();
    this.revisionRead = { value, at };
    return value;
  }

  /** A snapshot at `revision` or later, joining a build that is already running. */
  private async indexAt(revision: number): Promise<Snapshot> {
    if (this.latest !== undefined && this.latest.revision >= revision) return this.latest;
    const snapshot = await this.build();
    if (snapshot.revision >= revision) return snapshot;
    // The joined build read the catalog before `revision` was committed; a build started now reads
    // it after, so it sees that revision.
    return this.build();
  }

  private build(): Promise<Snapshot> {
    this.building ??= this.buildSnapshot().finally(() => {
      this.building = undefined;
    });
    return this.building;
  }

  async search(request: SearchRequest): Promise<SearchResult> {
    const started = performance.now();
    const result = await this.answer(request);
    this.observe((observer) => {
      observer.search(result.method, result.partialResults, performance.now() - started);
      observer.queryEmbedding?.(result.queryEmbedding);
    });
    return result;
  }

  /** Whether a search for `query` would find its embedding in the cache (no embedder run needed). */
  isQueryCached(query: string): boolean {
    if (this.embedder === undefined) return true;
    const text = parseQuery(query.trim(), this.assets.symbols()).text;
    return text === "" || this.queryCache.has(this.queryKey(text));
  }

  private queryKey(text: string): string {
    return `${this.embedder?.id ?? ""}:${text}`;
  }

  private async answer(request: SearchRequest): Promise<SearchResult> {
    const query = request.query.trim();
    if (query === "") throw searchError("search_query_required");
    if (query.length > MAX_QUERY_LENGTH) throw searchError("search_query_too_long");

    const parsed = parseQuery(query, this.assets.symbols());
    const filter: SearchFilter = { ...parsed.filter, ...defined(request.filter) };
    const digest = requestDigest({ query, filter });

    let snapshot: Snapshot;
    let offset = 0;
    if (request.cursor !== undefined) {
      const state = this.cursors.decode(request.cursor, this.now());
      if (state === "invalid") throw searchError("search_invalid_cursor");
      if (state === "expired") throw searchError("search_cursor_expired");
      if (state.request !== digest) throw searchError("search_invalid_cursor");
      // Another replica, or this one after a restart, can continue a cursor as long as the catalog
      // is still at the cursor's revision: the snapshot is rebuilt from the same content.
      let pinned = this.snapshots.get(state.revision);
      if (pinned === undefined) {
        const current = await this.recent();
        if (current.revision === state.revision) pinned = current;
      }
      if (pinned === undefined) throw searchError("search_cursor_expired");
      snapshot = pinned;
      offset = state.offset;
    } else {
      snapshot = await this.recent();
    }

    const candidates = snapshot.order.filter((listing) => satisfies(listing, filter, this.assets));
    const candidateIds = new Set(candidates.map((listing) => listing.id));
    let ranked: Scored[];
    let method: SearchMethod;
    let truncated = false;

    const embedded =
      parsed.text === "" || snapshot.vectors === undefined
        ? { vector: undefined, outcome: "none" as const }
        : await this.embedQuery(parsed.text);
    const queryVector = embedded.vector;
    if (parsed.text === "") {
      // Only constraints: every candidate matches. Verified listings first, then the longest-listed:
      // nothing a seller can buy by paying itself.
      ranked = candidates.map((listing) => ({ id: listing.id, score: trustRank(listing.trust) }));
      method = "filter";
    } else {
      // Lexical scoring over every candidate is cheap, so that arm is never cut.
      const rankings: Scored[][] = [snapshot.bm25.search(tokenize(parsed.text), candidateIds)];
      if (queryVector !== undefined && snapshot.vectors !== undefined) {
        const semantic: Scored[] = [];
        for (const id of candidateIds) {
          const vector = snapshot.vectors.get(id);
          if (vector === undefined) continue;
          const score = cosine(queryVector, vector);
          if (score >= this.similarityFloor) semantic.push({ id, score });
        }
        semantic.sort(byScore);
        truncated ||= semantic.length > this.depth;
        rankings.push(semantic.slice(0, this.depth));
        method = "hybrid";
      } else {
        method = "lexical";
      }
      ranked = rankings.length === 1 ? (rankings[0] ?? []) : reciprocalRankFusion(rankings);
    }
    ranked.sort(breakingTies(snapshot.listings));

    // One result per resource, placed at its best-ranked listing; its other matching listings (other
    // networks) follow it, ranked ones first.
    const position = new Map(ranked.map((entry, index) => [entry.id, index]));
    const resources: ResourceListings[] = [];
    const placed = new Set<string>();
    for (const entry of ranked) {
      if (placed.has(entry.id)) continue;
      const members = (snapshot.siblings.get(entry.id) ?? [entry.id])
        .filter((id) => candidateIds.has(id))
        .sort((a, b) => (position.get(a) ?? Infinity) - (position.get(b) ?? Infinity));
      for (const id of members) placed.add(id);
      const listings = members
        .map((id) => snapshot.listings.get(id))
        .filter((listing): listing is Listing => listing !== undefined);
      const [first, ...rest] = listings;
      if (first !== undefined) resources.push([first, ...rest]);
    }

    const slice = resources.slice(offset, offset + request.limit);
    const current = await this.current(slice.flat(), snapshot.revision);
    const shown = slice.map((members) =>
      members
        .map((listing) => current.get(listing.id))
        // A listing withdrawn since the snapshot is no longer shown.
        .filter((listing): listing is Listing => listing?.state === "published")
        // Defence in depth: nothing that violates a hard filter is ever returned.
        .filter((listing) => satisfies(listing, filter, this.assets))
        .map((listing) => narrowOptions(listing, (option) => optionSatisfies(option, filter, this.assets))),
    );
    const kept =
      request.fit === undefined
        ? shown.length
        : Math.min(shown.length, Math.max(1, request.fit(shown.filter(nonEmpty))));
    const page = shown.slice(0, kept).filter(nonEmpty);
    const nextOffset = offset + (kept < slice.length ? kept : request.limit);
    let nextCursor: string | null = null;
    if (nextOffset < resources.length) {
      const expiresAt = this.now() + this.cursorTtlMs;
      nextCursor = this.cursors.encode({
        revision: snapshot.revision,
        offset: nextOffset,
        request: digest,
        expiresAt,
      });
      this.cursorsUntil.set(
        snapshot.revision,
        Math.max(this.cursorsUntil.get(snapshot.revision) ?? 0, expiresAt),
      );
    }

    return {
      resources: page,
      partialResults: truncated || method === "lexical",
      nextCursor,
      limit: request.limit,
      method,
      queryEmbedding: embedded.outcome,
      // Echo only what was applied: an explicit parameter overrides the same constraint in the text.
      recognised: parsed.recognised
        .filter((entry) => request.filter[entry.field] === undefined)
        .map((entry) => entry.label),
      revision: snapshot.revision,
    };
  }

  /**
   * The listings of a page as the store holds them now: their content (a snapshot keeps none), and
   * their settlement count, last settlement and facts, which a settlement or a facts refresh updates
   * without a new revision. Ranking only reads what the snapshot kept, so the order stays stable across
   * pages. Listings read for an earlier page within `revisionMaxAgeMs`, at the same revision, are
   * reused (see `pageCacheSize`): a page whose listings are all kept costs no database read.
   */
  private async current(
    listings: readonly Listing[],
    revision: number,
  ): Promise<ReadonlyMap<string, Listing>> {
    const found = new Map<string, Listing>();
    if (listings.length === 0) return found;
    const now = this.now();
    const missing: string[] = [];
    for (const { id } of listings) {
      const kept = this.pageCache.get(id);
      if (kept !== undefined && kept.revision === revision && now - kept.at < this.revisionMaxAgeMs) {
        found.set(id, kept.listing);
      } else {
        missing.push(id);
      }
    }
    if (missing.length === 0) return found;
    for (const listing of await this.store.getMany(missing)) {
      found.set(listing.id, listing);
      if (this.pageCacheSize === 0) continue;
      // Re-inserted at the end: the map's order is the order the listings were read in.
      this.pageCache.delete(listing.id);
      this.pageCache.set(listing.id, { listing, revision, at: now });
    }
    while (this.pageCache.size > this.pageCacheSize) {
      const oldest = this.pageCache.keys().next().value;
      if (oldest === undefined) break;
      this.pageCache.delete(oldest);
    }
    return found;
  }

  /**
   * The query's embedding: from the cache, or computed within the embedder's concurrency cap and the
   * semantic budget. Undefined, with the reason, when the embedder is saturated, fails or runs late.
   */
  private async embedQuery(
    text: string,
  ): Promise<{ vector: Float32Array | undefined; outcome: QueryEmbedding }> {
    const embedder = this.embedder;
    if (embedder === undefined) return { vector: undefined, outcome: "none" };
    const key = this.queryKey(text);
    const cached = this.queryCache.get(key);
    if (cached !== undefined) {
      // Refresh its place: the least recently used entry is evicted first.
      this.queryCache.delete(key);
      this.queryCache.set(key, cached);
      return { vector: cached, outcome: "cached" };
    }
    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<"late">((resolve) => {
      timer = setTimeout(() => {
        resolve("late");
      }, this.semanticBudgetMs);
    });
    let vector: Float32Array | undefined;
    try {
      const acquiring = this.gate.tryAcquire();
      const acquired = await Promise.race([acquiring, budget]);
      if (acquired === false) return { vector: undefined, outcome: "saturated" };
      if (acquired === "late") {
        // The slot may still come; hand it straight back when it does.
        void acquiring.then((granted) => {
          if (granted) this.gate.release();
        });
        return this.failedQuery();
      }
      // The slot is held until the model finishes, even after the budget ran out: the CPU is still busy.
      const running = embedder.embed(text).finally(() => {
        this.gate.release();
      });
      const answer = await Promise.race([running, budget]);
      vector = answer === "late" ? undefined : answer;
    } catch {
      vector = undefined;
    } finally {
      clearTimeout(timer);
    }
    if (vector === undefined) return this.failedQuery();
    if (this.queryCacheSize > 0) {
      this.queryCache.set(key, vector);
      while (this.queryCache.size > this.queryCacheSize) {
        const oldest = this.queryCache.keys().next().value;
        if (oldest === undefined) break;
        this.queryCache.delete(oldest);
      }
    }
    return { vector, outcome: "computed" };
  }

  private failedQuery(): { vector: undefined; outcome: QueryEmbedding } {
    this.observe((observer) => {
      observer.embeddingFailure("query");
    });
    return { vector: undefined, outcome: "failed" };
  }

  private async buildSnapshot(): Promise<Snapshot> {
    const started = performance.now();
    const listings: Listing[] = [];
    const documents: SearchDocument[] = [];
    // Each network's share of the index, and how many of its listings did not fit.
    const used = new Map<string, { all: number; unverified: number }>();
    const leftOut = new Map<string, number>();
    const terms = new Set<string>();
    const vectorBytes =
      this.embedder === undefined ? 0 : this.embedder.dimensions * 4 + VECTOR_OVERHEAD_BYTES;
    let revision: number;
    try {
      // The catalog is read a batch at a time and only what search needs is kept, so a build never
      // holds every listing's content at once.
      revision = await this.indexStore.scanPublished((batch) => {
        for (const listing of batch) {
          const network = listing.identity.network;
          const share = used.get(network) ?? { all: 0, unverified: 0 };
          used.set(network, share);
          leftOut.set(network, leftOut.get(network) ?? 0);
          const document = toDocument(listing);
          const kept = indexed(listing);
          const distinct = new Set(Object.values(document.fields).flat());
          let cost = indexedBytes(kept) + vectorBytes + distinct.size * POSTING_ENTRY_BYTES;
          for (const term of distinct) if (!terms.has(term)) cost += termBytes(term);
          const unverified = listing.trust === "settled";
          if (
            share.all + cost > this.maxIndexBytesPerNetwork ||
            (unverified && share.unverified + cost > this.maxIndexBytesPerNetwork / 2)
          ) {
            leftOut.set(network, (leftOut.get(network) ?? 0) + 1);
            continue;
          }
          share.all += cost;
          if (unverified) share.unverified += cost;
          for (const term of distinct) terms.add(term);
          listings.push(kept);
          documents.push(document);
        }
      });
    } catch (error) {
      this.observe((observer) => {
        observer.indexBuild("failed", performance.now() - started);
      });
      throw error;
    }
    terms.clear();
    const embeddingKeys = new Set<string>();
    let vectors: Map<string, Float32Array> | undefined;
    if (this.embedder !== undefined) {
      try {
        vectors = new Map();
        for (const [index, listing] of listings.entries()) {
          const key = `${this.embedder.id}:${listing.contentHash}`;
          let vector = this.embeddings.get(key);
          if (vector === undefined) {
            // Index builds share the embedder's slots with queries, and wait for them.
            await this.gate.acquire();
            try {
              vector = await this.embedder.embed(documents[index]?.embeddingText ?? "");
            } finally {
              this.gate.release();
            }
            this.embeddings.set(key, vector);
          }
          vectors.set(listing.id, vector);
          embeddingKeys.add(key);
        }
      } catch {
        // Without embeddings this snapshot serves lexical-only results, reported as partial.
        vectors = undefined;
        embeddingKeys.clear();
        this.observe((observer) => {
          observer.embeddingFailure("document");
        });
      }
    }
    const byResource = new Map<string, string[]>();
    for (const listing of listings) {
      const key = resourceKey(listing.identity);
      const ids = byResource.get(key);
      if (ids === undefined) byResource.set(key, [listing.id]);
      else ids.push(listing.id);
    }
    const bm25 = new Bm25Index(documents);
    documents.length = 0;
    const snapshot: Snapshot = {
      revision,
      listings: new Map(listings.map((listing) => [listing.id, listing])),
      order: listings,
      siblings: new Map(
        listings.map((listing) => [listing.id, byResource.get(resourceKey(listing.identity)) ?? []]),
      ),
      bm25,
      vectors,
      embeddingKeys,
      bytes: snapshotBytes(listings, bm25, vectors),
    };
    this.snapshots.set(revision, snapshot);
    if (this.latest === undefined || revision >= this.latest.revision) this.latest = snapshot;
    // A superseded snapshot is kept while a cursor issued on it can still be continued.
    const now = this.now();
    for (const key of this.snapshots.keys()) {
      if (key !== this.latest.revision && (this.cursorsUntil.get(key) ?? 0) < now) {
        this.snapshots.delete(key);
        this.cursorsUntil.delete(key);
      }
    }
    // Over the count or byte cap, the oldest superseded snapshots go first; their cursors expire.
    let bytes = [...this.snapshots.values()].reduce((sum, kept) => sum + kept.bytes, 0);
    for (const key of [...this.snapshots.keys()].sort((a, b) => a - b)) {
      if (this.snapshots.size <= this.maxSnapshots && bytes <= this.maxSnapshotBytes) break;
      if (key === this.latest.revision) continue;
      bytes -= this.snapshots.get(key)?.bytes ?? 0;
      this.snapshots.delete(key);
      this.cursorsUntil.delete(key);
    }
    this.observe((observer) => {
      observer.snapshots?.(this.snapshots.size, bytes);
      for (const [network, count] of leftOut) observer.leftOut?.(network, count);
    });
    const live = new Set([...this.snapshots.values()].flatMap((kept) => [...kept.embeddingKeys]));
    for (const key of this.embeddings.keys()) if (!live.has(key)) this.embeddings.delete(key);
    const outcome = this.embedder !== undefined && vectors === undefined ? "degraded" : "ok";
    this.observe((observer) => {
      observer.indexBuild(outcome, performance.now() - started);
    });
    return snapshot;
  }

  private observe(call: (observer: SearchObserver) => void): void {
    if (this.observer === undefined) return;
    try {
      call(this.observer);
    } catch {
      // Instrumentation never affects a search.
    }
  }
}

/**
 * Orders equal scores, which RRF produces often (a lexical-only and a semantic-only match at the
 * same rank tie exactly): domain-verified, then origin-verified listings first, then the
 * longest-listed. No signal can be bought by repeating payments.
 */
function breakingTies(listings: ReadonlyMap<string, Listing>) {
  return (a: Scored, b: Scored): number => {
    if (a.score !== b.score) return b.score - a.score;
    const left = listings.get(a.id);
    const right = listings.get(b.id);
    const verified = trustRank(right?.trust ?? "settled") - trustRank(left?.trust ?? "settled");
    if (verified !== 0) return verified;
    const listed = (left?.listedAt?.getTime() ?? 0) - (right?.listedAt?.getTime() ?? 0);
    return (
      listed || (left?.sequence ?? 0) - (right?.sequence ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
  };
}

function defined(filter: SearchFilter): SearchFilter {
  return Object.fromEntries(Object.entries(filter).filter(([, value]) => value !== undefined));
}

/** Bytes a vector takes beyond its elements: the typed array, its buffer and its map entry. */
const VECTOR_OVERHEAD_BYTES = 240;
const NO_EXTRA: Readonly<Record<string, unknown>> = Object.freeze({});
const NO_DESCRIPTOR = Object.freeze({ info: NO_EXTRA, schema: NO_EXTRA });

/**
 * What a snapshot keeps of a listing: what ranking (trust, listing age, sequence), the hard filters
 * (type, extensions, each option's scheme, network, asset, payTo and price) and grouping by resource
 * read. Its metadata, the options' `extra` and its facts are dropped: a page reads the listing from the
 * store, so a listing's size never multiplies across snapshots.
 */
function indexed(listing: Listing): Listing {
  const { content } = listing;
  return {
    id: listing.id,
    sequence: listing.sequence,
    identity: listing.identity,
    owner: listing.owner,
    trust: listing.trust,
    state: listing.state,
    version: listing.version,
    contentHash: listing.contentHash,
    firstCatalogedAt: listing.firstCatalogedAt,
    ...(listing.listedAt === undefined ? {} : { listedAt: listing.listedAt }),
    lastUpdated: listing.lastUpdated,
    lastSettledAt: listing.lastSettledAt,
    settlements: listing.settlements,
    content: {
      resource: listing.identity.resource,
      kind: content.kind,
      ...(content.extensions === undefined ? {} : { extensions: content.extensions }),
      bazaar: NO_DESCRIPTOR,
      accepts: content.accepts.map((option) => ({
        scheme: option.scheme,
        network: option.network,
        asset: option.asset,
        payTo: option.payTo,
        amount: option.amount,
        maxTimeoutSeconds: option.maxTimeoutSeconds,
        extra: NO_EXTRA,
      })),
    },
  };
}

/**
 * Estimated bytes one indexed listing holds: its strings (UTF-16), its objects and dates, its options,
 * and its entries in the snapshot's maps and arrays. Calibrated against measured heap (see the memory
 * test in packages/search/test) with a margin, so the snapshot caps measure what a snapshot holds.
 */
function indexedBytes(listing: Listing): number {
  return 2 * JSON.stringify(listing).length + 1_200 + 240 * listing.content.accepts.length;
}

/** A snapshot's estimated memory: its indexed listings, its BM25 index and its vectors. */
function snapshotBytes(
  listings: readonly Listing[],
  bm25: Bm25Index,
  vectors: ReadonlyMap<string, Float32Array> | undefined,
): number {
  let bytes = bm25.bytes;
  for (const listing of listings) bytes += indexedBytes(listing);
  for (const vector of vectors?.values() ?? []) bytes += vector.byteLength + VECTOR_OVERHEAD_BYTES;
  return bytes;
}

function nonEmpty(members: Listing[]): members is [Listing, ...Listing[]] {
  return members.length > 0;
}
