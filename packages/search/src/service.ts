import { defineCodes, errorFactory } from "@rail402.dev/errors";
import {
  narrowOptions,
  resourceKey,
  trustRank,
  type CatalogStore,
  type Listing,
  type ResourceListings,
} from "@rail402.dev/bazaar";
import { Bm25Index, byScore, reciprocalRankFusion, type Scored } from "./bm25.ts";
import {
  type AssetRegistry,
  optionSatisfies,
  parseQuery,
  satisfies,
  type SearchFilter,
} from "./constraints.ts";
import { CursorCodec, requestDigest } from "./cursor.ts";
import { cosine, type Embedder } from "./embedder.ts";
import { tokenize, toDocument } from "./text.ts";

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

export interface SearchRequest {
  readonly query: string;
  /** Explicit filters; they take precedence over constraints recognised in the query. */
  readonly filter: SearchFilter;
  readonly limit: number;
  readonly cursor?: string;
}

export type SearchMethod = "hybrid" | "lexical" | "filter";

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
  /** Constraints recognised in the query text and applied as hard filters. */
  readonly recognised: readonly string[];
  readonly revision: number;
}

export interface SearchServiceOptions {
  readonly store: CatalogStore;
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
  readonly now?: () => number;
}

interface Snapshot {
  readonly revision: number;
  readonly listings: ReadonlyMap<string, Listing>;
  readonly order: readonly Listing[];
  /** Listing id → the ids of every listing of its resource, in catalog order. */
  readonly siblings: ReadonlyMap<string, readonly string[]>;
  readonly bm25: Bm25Index;
  readonly vectors: ReadonlyMap<string, Float32Array> | undefined;
  /** Keys into the embedding cache this snapshot uses. */
  readonly embeddingKeys: ReadonlySet<string>;
}

/**
 * Hybrid search over the published catalog. Each catalog revision gets an immutable in-memory
 * snapshot (BM25F index plus embeddings); results come from fusing the lexical and semantic
 * rankings with RRF, restricted beforehand to listings that satisfy every hard filter.
 */
export class SearchService {
  private readonly store: CatalogStore;
  private readonly assets: AssetRegistry;
  private readonly embedder: Embedder | undefined;
  private readonly cursors: CursorCodec;
  private readonly depth: number;
  private readonly similarityFloor: number;
  private readonly cursorTtlMs: number;
  private readonly revisionMaxAgeMs: number;
  private readonly semanticBudgetMs: number;
  private readonly now: () => number;
  private readonly snapshots = new Map<number, Snapshot>();
  /** Revision → when the last cursor issued on that snapshot expires. */
  private readonly cursorsUntil = new Map<number, number>();
  private revisionRead: { readonly value: number; readonly at: number } | undefined;
  private readonly embeddings = new Map<string, Float32Array>();
  private latest: Snapshot | undefined;
  private building: Promise<Snapshot> | undefined;

  constructor(options: SearchServiceOptions) {
    this.store = options.store;
    this.assets = options.assets;
    this.embedder = options.embedder;
    this.cursors = new CursorCodec(options.cursorSecret);
    this.depth = options.depth ?? 100;
    this.similarityFloor = options.similarityFloor ?? 0.3;
    this.cursorTtlMs = options.cursorTtlMs ?? 15 * 60_000;
    this.revisionMaxAgeMs = options.revisionMaxAgeMs ?? 0;
    this.semanticBudgetMs = options.semanticBudgetMs ?? 2_000;
    this.now = options.now ?? Date.now;
  }

  /** Brings the index up to the catalog's current revision. */
  async refresh(): Promise<Snapshot> {
    const revision = await this.currentRevision();
    if (this.latest !== undefined && this.latest.revision >= revision) return this.latest;
    this.building ??= this.build().finally(() => {
      this.building = undefined;
    });
    return this.building;
  }

  private async currentRevision(): Promise<number> {
    const now = this.now();
    if (this.revisionRead !== undefined && now - this.revisionRead.at < this.revisionMaxAgeMs) {
      return this.revisionRead.value;
    }
    const value = await this.store.revision();
    this.revisionRead = { value, at: now };
    return value;
  }

  async search(request: SearchRequest): Promise<SearchResult> {
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
        const current = await this.refresh();
        if (current.revision === state.revision) pinned = current;
      }
      if (pinned === undefined) throw searchError("search_cursor_expired");
      snapshot = pinned;
      offset = state.offset;
    } else {
      snapshot = await this.refresh();
    }

    const candidates = snapshot.order.filter((listing) => satisfies(listing, filter, this.assets));
    const candidateIds = new Set(candidates.map((listing) => listing.id));
    let ranked: Scored[];
    let method: SearchMethod;
    let truncated = false;

    const queryVector =
      parsed.text === "" || snapshot.vectors === undefined ? undefined : await this.embedQuery(parsed.text);
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

    const page = resources
      .slice(offset, offset + request.limit)
      .map((members) =>
        members
          // Defence in depth: nothing that violates a hard filter is ever returned.
          .filter((listing) => satisfies(listing, filter, this.assets))
          .map((listing) => narrowOptions(listing, (option) => optionSatisfies(option, filter, this.assets))),
      )
      .filter((members): members is [Listing, ...Listing[]] => members.length > 0);
    const nextOffset = offset + request.limit;
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
      // Echo only what was applied: an explicit parameter overrides the same constraint in the text.
      recognised: parsed.recognised
        .filter((entry) => request.filter[entry.field] === undefined)
        .map((entry) => entry.label),
      revision: snapshot.revision,
    };
  }

  /** The query's embedding, or undefined when the embedder fails or exceeds the semantic budget. */
  private async embedQuery(text: string): Promise<Float32Array | undefined> {
    if (this.embedder === undefined) return undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.embedder.embed(text),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => {
            resolve(undefined);
          }, this.semanticBudgetMs);
        }),
      ]);
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  private async build(): Promise<Snapshot> {
    const { revision, listings } = await this.store.published();
    const documents = listings.map(toDocument);
    const embeddingKeys = new Set<string>();
    let vectors: Map<string, Float32Array> | undefined;
    if (this.embedder !== undefined) {
      try {
        vectors = new Map();
        for (const [index, listing] of listings.entries()) {
          const key = `${this.embedder.id}:${listing.contentHash}`;
          let vector = this.embeddings.get(key);
          if (vector === undefined) {
            vector = await this.embedder.embed(documents[index]?.embeddingText ?? "");
            this.embeddings.set(key, vector);
          }
          vectors.set(listing.id, vector);
          embeddingKeys.add(key);
        }
      } catch {
        // Without embeddings this snapshot serves lexical-only results, reported as partial.
        vectors = undefined;
        embeddingKeys.clear();
      }
    }
    const byResource = new Map<string, string[]>();
    for (const listing of listings) {
      const key = resourceKey(listing.identity);
      const ids = byResource.get(key);
      if (ids === undefined) byResource.set(key, [listing.id]);
      else ids.push(listing.id);
    }
    const snapshot: Snapshot = {
      revision,
      listings: new Map(listings.map((listing) => [listing.id, listing])),
      order: listings,
      siblings: new Map(
        listings.map((listing) => [listing.id, byResource.get(resourceKey(listing.identity)) ?? []]),
      ),
      bm25: new Bm25Index(documents),
      vectors,
      embeddingKeys,
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
    const live = new Set([...this.snapshots.values()].flatMap((kept) => [...kept.embeddingKeys]));
    for (const key of this.embeddings.keys()) if (!live.has(key)) this.embeddings.delete(key);
    return snapshot;
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
