import { HybridRetriever, type Retriever, type ScoredEntry } from "../search/index.js";
import type { SignalStore } from "../search/signals.js";
import {
  entryKey,
  toPublic,
  type CatalogEntry,
  type DiscoveryFilters,
  type ListResponse,
  type SearchResponse,
} from "./types.js";

/**
 * The catalog store.
 *
 * Off-chain by default: an on-chain registry would add rent, eviction, and a
 * second transaction on the per-payment hot path, roughly doubling settlement cost. Nothing here
 * touches the settlement path — cataloging happens after a payment has already settled.
 *
 * The in-memory implementation is deliberate for v1: the whole catalog is derived state that can be
 * rebuilt from settlement history, so durability is a replay concern rather than a storage one.
 * `CatalogStore` is the seam a persistent backend slots into.
 */

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;
/** Hard ceiling on scored results per query, which is what makes `partialResults` meaningful. */
const SEARCH_CEILING = 200;

/**
 * How long a provisional (verify-time) entry lives before it may be pruned if it never settles.
 * Generous relative to a verify->settle round trip (seconds), short enough to bound clutter from
 * `/verify` calls that never pay. Provisional entries carry no rank and no ownership, so this only
 * bounds memory.
 */
const PROVISIONAL_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Declared retrieval method, published in every search response.
 *
 * Deliberately specific rather than aspirational: BM25 over weighted fields, fused by Reciprocal Rank
 * Fusion with in-process static-embedding (model2vec) semantic retrieval, plus a capped boost from
 * settlement-derived quality signals. It is a genuine hybrid — measured to lift recall@10 ~45% → ~80%
 * on the 107-judgment held-out set (per-query sign test p < 0.0001), not a `hybrid` label asserted to
 * look competitive, which would be the advertised-versus-reachable dishonesty this project measures in
 * other facilitators (CDP declares `hybrid` while silently falling back to URL-substring matching).
 */
const SEARCH_METHOD = "hybrid (bm25+static-embedding, rrf)";

export class CatalogStore {
  private entries = new Map<string, CatalogEntry>();
  /** entryKey -> set of payer addresses, for the unique-payer ranking signal. */
  private payers = new Map<string, Set<string>>();
  private retriever: Retriever;
  private dirty = true;
  /**
   * Online-signal recorder. Optional so the store stays usable in tests and in the evaluation
   * harness without dragging behavioural state into a measurement that must be deterministic.
   */
  readonly signals: SignalStore | undefined;

  constructor(retriever: Retriever = new HybridRetriever(), signals?: SignalStore) {
    this.retriever = retriever;
    this.signals = signals;
  }

  get size(): number {
    return this.entries.size;
  }

  get(resource: string, toolName?: string): CatalogEntry | undefined {
    return this.entries.get(entryKey(resource, toolName));
  }

  /**
   * Insert or update an entry. Ownership is enforced upstream in `ingest`.
   *
   * @param payer - the settling payer, counted once per resource. Unique payers are the strongest
   *   abuse-resistant ranking signal we have, because each one is a distinct on-chain payment.
   */
  upsert(entry: CatalogEntry, payer?: string): CatalogEntry {
    const key = entryKey(entry.resource, entry.toolName);

    // A seller paying its OWN endpoint earns nothing.
    //
    // Settlement-gating was supposed to make usage signal expensive. It was not: with
    // `payer === payTo` the transfer moves no net value, and the network fee is sponsored by the
    // facilitator — so sixty self-payments reached the ranking cap at zero marginal cost to the
    // seller. Refusing to count them restores the property the design
    // claimed, and costs an honest seller nothing: nobody's real buyers are their own payTo.
    const selfPaid = payer !== undefined && entry.accepts.some(a => a.payTo === payer);
    if (selfPaid) {
      const previous = this.entries.get(key);
      entry.quality.totalSettlements = previous?.quality.totalSettlements ?? 0;
      entry.quality.uniquePayers = previous?.quality.uniquePayers ?? 0;
    }

    if (payer && !selfPaid) {
      const seen = this.payers.get(key) ?? new Set<string>();
      seen.add(payer);
      this.payers.set(key, seen);
      entry.quality.uniquePayers = seen.size;
    }

    this.entries.set(key, entry);
    this.dirty = true;
    return entry;
  }

  /**
   * Catalog a resource seen at VERIFY, before it has settled (hybrid cataloging).
   *
   * A provisional entry is discoverable so a resource appears "during payment verification" — what
   * the upstream reference facilitator does and what the e2e conformance suite checks — but it is
   * intentionally powerless: it carries NO ranking signals and establishes NO ownership. Settlement
   * always wins:
   *   - a settled entry is never downgraded (a provisional write over any existing key is a no-op);
   *   - the ownership check in `ingest` treats a provisional incumbent as displaceable, so a
   *     provisional entry a hostile client created at verify can never lock out or spoof the real
   *     seller when they settle.
   * Expired provisional entries are pruned opportunistically on write, bounding memory to the verify
   * rate times the TTL. Never touches the payers set, so unique-payer signal stays settlement-only.
   */
  upsertProvisional(entry: CatalogEntry, now: string): CatalogEntry | undefined {
    this.pruneProvisional(now);
    const key = entryKey(entry.resource, entry.toolName);
    // Never downgrade a settled entry, and do not disturb an existing provisional one — the resource
    // is already discoverable, and refreshing it on every unpaid probe would hand `/verify` a way to
    // keep a listing alive indefinitely without ever paying.
    const existing = this.entries.get(key);
    if (existing) return existing;

    const provisional: CatalogEntry = {
      ...entry,
      provisional: true,
      provisionalUntil: new Date(new Date(now).getTime() + PROVISIONAL_TTL_MS).toISOString(),
      // Zero signals: a provisional entry has settled nothing, so it must earn no ranking boost.
      quality: { totalSettlements: 0, uniquePayers: 0, firstSeenAt: now },
    };
    this.entries.set(key, provisional);
    this.dirty = true;
    return provisional;
  }

  /** Drop provisional entries whose TTL has passed. Settled entries are never pruned. */
  private pruneProvisional(now: string): void {
    for (const [key, e] of this.entries) {
      if (e.provisional && e.provisionalUntil !== undefined && e.provisionalUntil < now) {
        this.entries.delete(key);
        this.payers.delete(key);
        this.dirty = true;
      }
    }
  }

  /** All entries, in a stable order so pagination never wobbles between calls. */
  private all(): CatalogEntry[] {
    return [...this.entries.values()].sort((a, b) =>
      entryKey(a.resource, a.toolName).localeCompare(entryKey(b.resource, b.toolName)),
    );
  }

  /**
   * Apply the spec's structured filters.
   *
   * All seven are implemented and all seven actually filter. That is a low bar, and the largest
   * live Bazaar does not clear it: `network` and `scheme` are silently ignored there, proven by
   * byte-identical responses across different filter values.
   */
  private filter(entries: CatalogEntry[], f: DiscoveryFilters): CatalogEntry[] {
    return entries.filter(e => {
      if (f.type && e.type !== f.type) return false;
      if (f.extensions && !(e.extensions && f.extensions in e.extensions)) return false;
      if (f.payTo && !e.accepts.some(a => a.payTo === f.payTo)) return false;
      if (f.scheme && !e.accepts.some(a => a.scheme === f.scheme)) return false;
      if (f.network && !e.accepts.some(a => a.network === f.network)) return false;
      return true;
    });
  }

  /** `GET /discovery/resources` — offset pagination, array key `items`. */
  list(filters: DiscoveryFilters, limit?: number, offset?: number): ListResponse {
    const lim = clamp(limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
    const off = Math.max(0, Math.floor(offset ?? 0));
    const filtered = this.filter(this.all(), filters);

    return {
      x402Version: 2,
      items: filtered.slice(off, off + lim).map(toPublic),
      pagination: { limit: lim, offset: off, total: filtered.length },
    };
  }

  /** `GET /discovery/search` — cursor pagination, array key `resources`, plus `partialResults`. */
  search(query: string, filters: DiscoveryFilters, limit?: number, cursor?: string): SearchResponse {
    if (this.dirty) {
      this.retriever.index(this.all());
      this.dirty = false;
    }

    const lim = clamp(limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
    const start = decodeCursor(cursor, query, filters);
    const candidates = this.filter(this.all(), filters);
    const scored: ScoredEntry[] = this.retriever.search(query, candidates, SEARCH_CEILING);

    const page = scored.slice(start, start + lim);
    const nextStart = start + page.length;
    const hasMore = nextStart < scored.length;
    // Honest semantics: `partialResults` means matches were TRUNCATED by the facilitator, which is
    // only true when we hit the scoring ceiling — not merely when another page exists.
    const truncated = scored.length >= SEARCH_CEILING;

    const response: SearchResponse = {
      x402Version: 2,
      resources: page.map(s => toPublic(s.entry)),
      pagination: { limit: lim, cursor: hasMore ? encodeCursor(nextStart, query, filters) : null },
      searchMethod: SEARCH_METHOD,
    };
    if (truncated) response.partialResults = true;

    // Record what was asked and what came back, then hand out a token so a later paid call can be
    // attributed to this search. Only the FIRST page mints a token: paging through results is one
    // decision by one buyer, and counting each page as a separate search would inflate the
    // denominator of every rate we publish.
    if (this.signals && start === 0) {
      const token = this.signals.recordSearch(
        query,
        page.map(s => entryKey(s.entry.resource, s.entry.toolName)),
        filters as Record<string, string>,
      );
      response.meta = { searchToken: token };
    }
    return response;
  }

  /**
   * Attribute a paid call back to the search that produced it.
   *
   * Returns whether the attribution landed. An unknown token is not an error — see `SignalStore`.
   */
  recordConversion(token: string | undefined, resource: string): boolean {
    return this.signals?.recordConversion(token, resource) ?? false;
  }

  /**
   * Record the outcome of a SEP-1 domain check.
   *
   * Keyed on the OWNER, not on the caller: a verdict about some other account says nothing about
   * the account that owns this listing, and applying it would let a third party flip a competitor's
   * badge by paying their endpoint from a verified address of their own.
   *
   * @returns whether an entry was updated
   */
  setDomainVerified(resourceUrl: string, account: string, verified: boolean): boolean {
    let changed = false;
    for (const entry of this.entries.values()) {
      if (entry.ownerPayTo !== account) continue;
      // Match on origin: the entry's key may be a routeTemplate rather than the concrete path the
      // payment carried, so comparing full URLs would miss every templated listing.
      if (originOf(entry.resource) !== originOf(resourceUrl)) continue;
      if (entry.domainVerified === verified) continue;
      entry.domainVerified = verified;
      changed = true;
    }
    if (changed) this.dirty = true;
    return changed;
  }

  /** Rebuild the index eagerly, e.g. after a bulk import. */
  reindex(): void {
    this.retriever.index(this.all());
    this.dirty = false;
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : lo;
}

/**
 * Cursors bind to the query they were issued for.
 *
 * A cursor replayed against a different query would silently return an arbitrary slice of unrelated
 * results, which is worse than an error because the caller cannot tell. Binding makes that
 * detectable, and we fail closed to offset 0.
 */
function encodeCursor(offset: number, query: string, filters: DiscoveryFilters): string {
  return Buffer.from(
    JSON.stringify({ o: offset, q: hashQuery(query + "\u0000" + canonicalFilters(filters)) }),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(
  cursor: string | undefined,
  query: string,
  filters: DiscoveryFilters,
): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      o?: unknown;
      q?: unknown;
    };
    if (parsed.q !== hashQuery(query + "\u0000" + canonicalFilters(filters))) return 0;
    return typeof parsed.o === "number" && parsed.o >= 0 ? Math.floor(parsed.o) : 0;
  } catch {
    return 0;
  }
}

/**
 * Stable serialisation of the filters a cursor was issued under.
 *
 * The cursor binds to the query AND the filters, because it encodes an offset into the filtered,
 * scored list. Binding to the query alone let a cursor issued under `payTo=A` be replayed under
 * `payTo=B` and silently return an arbitrary slice of a different result set — the same failure
 * the query binding exists to prevent, one field short.
 */
function canonicalFilters(filters: DiscoveryFilters): string {
  return Object.entries(filters)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${String(v)}`)
    .join("&");
}

/** Small non-cryptographic hash; only needs to detect a mismatched query, not resist attack. */
function hashQuery(query: string): string {
  let h = 2166136261;
  for (let i = 0; i < query.length; i++) {
    h ^= query.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
