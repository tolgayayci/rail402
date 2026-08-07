import { HybridRetriever, type Retriever, type ScoredEntry } from "../search/index.js";
import type { SignalStore } from "../search/signals.js";
import type { TrustlineVerdict } from "./trustline.js";
import type { CatalogPersistence, StoredEntry } from "./persistence.js";
import type { FederatedCatalog } from "./federation.js";
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
 * Entries live in memory and are optionally MIRRORED to a `CatalogPersistence` backend, so a restart
 * restores the catalog instead of forgetting every seller. Memory is written first and persistence
 * second, on purpose: if the disk is full or the file is unwritable, discovery keeps working and only
 * durability is lost. `persistenceDegraded` says so out loud rather than pretending otherwise.
 *
 * Ranking is deliberately untouched by any of this — the retriever indexes what is in memory, which
 * is now restored at boot rather than starting empty. See `persistence.ts` for why the storage
 * layer's own full-text engine is not used for retrieval.
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
 * settlement-derived quality signals. It is a genuine hybrid — measured to lift recall@10 60.8% → 72.6%
 * on the 107-judgment held-out set (per-query sign test p ≈ 0.003), not a `hybrid` label asserted to
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
  private readonly persistence: CatalogPersistence | undefined;
  /**
   * A persistence write has failed since boot.
   *
   * Surfaced on `/health` rather than swallowed: the catalog is still serving, but it will not
   * survive a restart, and an operator who cannot see that finds out at the worst moment.
   */
  private degraded: string | undefined;
  /** Pending hydration for an async backend; undefined for sync backends and for no backend. */
  private hydration: Promise<void> | undefined;

  /**
   * Read-only mirror of other catalogs, merged at READ time only (`federation.ts`).
   *
   * Never consulted by `get`, which is what the ownership check reads — so a mirrored listing can
   * never block a real seller from claiming their own key — and never persisted, because it is a
   * cache of somebody else's data rather than something we observed.
   */
  private readonly federated: FederatedCatalog | undefined;
  /** Mirror revision last indexed, so a refresh reindexes and an unchanged mirror does not. */
  private federatedStamp = 0;

  constructor(
    retriever: Retriever = new HybridRetriever(),
    signals?: SignalStore,
    persistence?: CatalogPersistence,
    federated?: FederatedCatalog,
  ) {
    this.retriever = retriever;
    this.signals = signals;
    this.persistence = persistence;
    this.federated = federated;

    if (persistence) {
      const loaded = persistence.load();
      if (loaded instanceof Promise) {
        // An async backend cannot hydrate in a constructor. Hold the promise and let the caller
        // await `ready()` before serving — a facilitator that answered /discovery/* from an
        // un-hydrated store would report an empty catalog as though nothing had ever settled.
        this.hydration = loaded
          .then(rows => this.hydrate(rows))
          .catch(error => {
            this.degraded = error instanceof Error ? error.message : String(error);
            console.error(`catalog hydration failed (serving empty): ${this.degraded}`);
          });
      } else {
        this.hydrate(loaded);
      }
    }
  }

  /**
   * Resolve once the catalog has been restored from an async backend.
   *
   * A no-op for a synchronous backend or no backend at all, so callers can await it unconditionally.
   */
  async ready(): Promise<void> {
    await this.hydration;
  }

  private hydrate(rows: readonly StoredEntry[]): void {
    {
      for (const row of rows) {
        // The key is rebuilt here, never stored. See persistence.ts: a null-joined composite key
        // cannot survive a SQLite TEXT bind, and the failure is invisible.
        const key = entryKey(row.entry.resource, row.entry.toolName);
        this.entries.set(key, row.entry);
        if (row.payers.length > 0) this.payers.set(key, new Set(row.payers));
      }
      this.dirty = true;
    }
  }

  /** Null when durable, otherwise why the last persistence write failed. */
  get persistenceDegraded(): string | undefined {
    return this.degraded;
  }

  /**
   * Mirror one entry to the backend, never letting a storage fault reach the caller.
   *
   * The in-memory write has already happened by the time this runs, so a failure here costs
   * durability and nothing else — a settled payment must not be reported as failed because a disk
   * filled up, and a listing must not vanish from search for the same reason.
   */
  private persist(resource: string, toolName?: string): void {
    if (!this.persistence) return;
    const key = entryKey(resource, toolName);
    const entry = this.entries.get(key);
    try {
      const written =
        entry === undefined
          ? this.persistence.remove(resource, toolName)
          : this.persistence.save({ entry, payers: [...(this.payers.get(key) ?? [])] });
      // An async backend rejects later than this frame, so the catch below cannot see it. Attach a
      // handler rather than leaving an unhandled rejection to take the process down — a storage
      // fault must cost durability and nothing else.
      if (written instanceof Promise) {
        void written.catch((error: unknown) => {
          this.degraded = error instanceof Error ? error.message : String(error);
          console.error(`catalog persistence write failed (serving from memory): ${this.degraded}`);
        });
      }
      this.degraded = undefined;
    } catch (error) {
      this.degraded = error instanceof Error ? error.message : String(error);
      console.error(`catalog persistence write failed (serving from memory): ${this.degraded}`);
    }
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
    this.persist(entry.resource, entry.toolName);
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
    // Provisional entries are persisted too. They carry no rank and no ownership, so restoring one
    // grants nothing — and dropping them on restart would make a verify-then-settle that straddles a
    // deploy behave differently from one that does not.
    this.persist(provisional.resource, provisional.toolName);
    return provisional;
  }

  /** Drop provisional entries whose TTL has passed. Settled entries are never pruned. */
  private pruneProvisional(now: string): void {
    for (const [key, e] of this.entries) {
      if (e.provisional && e.provisionalUntil !== undefined && e.provisionalUntil < now) {
        this.entries.delete(key);
        this.payers.delete(key);
        this.dirty = true;
        this.persist(e.resource, e.toolName);
      }
    }
  }

  /** How many mirrored entries are currently merged in. Never counted in `size`. */
  get federatedSize(): number {
    return this.federated?.size ?? 0;
  }

  /**
   * Everything a read can return: owned entries, plus mirrored ones on keys we do not own.
   *
   * Owned always wins a collision, unconditionally. A seller who has settled here must never see
   * their own listing shadowed by somebody else's copy of it — including a stale copy carrying an
   * old price.
   */
  private all(): CatalogEntry[] {
    const merged = new Map(this.entries);
    for (const entry of this.federated?.all() ?? []) {
      const key = entryKey(entry.resource, entry.toolName);
      if (!merged.has(key)) merged.set(key, entry);
    }
    return [...merged.values()].sort((a, b) =>
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
      // Additive, and the one filter an agent genuinely needs that the spec does not define: "only
      // things this facilitator has actually seen settle". Ignored by any client that omits it.
      if (f.source === "local" && e.federated) return false;
      if (f.source !== undefined && f.source !== "local" && e.provenance?.source !== f.source) return false;
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
    // A federation refresh changes the corpus without touching `dirty`, so notice it here rather
    // than serving a stale index. An integer compare, not a walk of the mirror — this runs on every
    // query, and fingerprinting somebody else's catalog per search would be O(n) for nothing.
    const version = this.federated?.version ?? 0;
    if (version !== this.federatedStamp) {
      this.federatedStamp = version;
      this.dirty = true;
    }
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
      this.persist(entry.resource, entry.toolName);
    }
    if (changed) this.dirty = true;
    return changed;
  }

  /**
   * Record a trustline pre-flight verdict against every listing priced in that exact asset for that
   * exact payee.
   *
   * Keyed on the (network, asset, payTo) triple the check was actually made about — never on the
   * entry or its owner. A verdict is a statement about one payee's ability to receive one asset, so
   * applying it anywhere else would publish a claim nobody verified. One check therefore updates
   * every listing that shares the triple, which is the common case for a seller with several
   * endpoints behind one account.
   *
   * Deliberately does NOT mark the index dirty: this is advisory metadata that no field weight
   * reads, and it must not be able to move anything's rank.
   *
   * @returns how many payment options were updated
   */
  setTrustline(
    network: string,
    asset: string,
    payTo: string,
    verdict: TrustlineVerdict,
  ): number {
    let updated = 0;
    for (const entry of this.entries.values()) {
      let touched = false;
      for (const accepts of entry.accepts) {
        if (accepts.network !== network || accepts.asset !== asset || accepts.payTo !== payTo) {
          continue;
        }
        const stellar = { ...((accepts.extra["stellar"] as Record<string, unknown>) ?? {}) };
        stellar["payToTrustline"] = verdict;
        accepts.extra = { ...accepts.extra, stellar };
        updated += 1;
        touched = true;
      }
      if (touched) this.persist(entry.resource, entry.toolName);
    }
    return updated;
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
