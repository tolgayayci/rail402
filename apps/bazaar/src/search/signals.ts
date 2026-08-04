import { createHash, randomBytes } from "node:crypto";

/**
 * Online search signals — the loop that lets ranking improve from real behaviour.
 *
 * Three online signals matter: **zero-result queries**, **searches that never convert to a
 * paid call**, and **click/selection data from the MCP server**. Until this module existed, our
 * judgment set could only grow by me sitting down and inventing queries — which measures my
 * imagination, not what agents actually ask for. Every serious retrieval system is improved by its
 * own traffic; a curated set alone plateaus at the taste of whoever curated it.
 *
 * ## The correlation token
 *
 * Each search response carries an opaque `meta.searchToken`. When a buyer later pays for a resource
 * they found, the token comes back, and that pair — *query* → *resource actually paid for* — is the
 * single most valuable relevance judgment obtainable, because it cost the buyer real money.
 * Unconverted searches are equally informative in the negative direction.
 *
 * This is not an invention. CDP ships `meta.searchToken` in production today (verified per-call:
 * two identical queries returned different tokens), so emitting one is convergence on an existing
 * ecosystem convention rather than a unilateral field — which the spec process forbids. It is
 * additive and optional; a stock client that has never heard of it ignores it.
 *
 * ## What is deliberately NOT stored
 *
 * No IP addresses, no payer addresses, no headers, no API keys. A query string and what was returned
 * for it, nothing else. Search queries are user content and can carry anything a user typed, so the
 * store is bounded, in-memory, and never written to disk by this module: an operator who wants
 * durable analytics opts in explicitly, having thought about what that means.
 *
 * ## Why ranking cannot read this directly
 *
 * Conversions are *reported by the caller*, so they are attacker-influenced: a seller who can forge
 * conversions for their own listing could buy rank. Nothing here feeds the live ranker. These
 * signals are an input to the **human-reviewed** judgment set (`heldout.ts`, `fixtures.ts`), which
 * is the only path by which they ever affect ranking. Behaviour that costs a settled payment
 * (`quality.uniquePayers`) is the abuse-resistant signal, and it stays the only one with automatic
 * influence.
 */

/** Ring-buffer capacity. Bounded because this is user-supplied text in a long-lived process. */
const MAX_SEARCHES = 5_000;
/** Tokens live only long enough for a buyer to discover, decide, and pay. */
const TOKEN_TTL_MS = 30 * 60 * 1000;

export interface SearchRecord {
  /** Opaque per-response correlation id. */
  readonly token: string;
  readonly query: string;
  /** Entry keys returned, in rank order — so a conversion records its own rank. */
  readonly returned: readonly string[];
  readonly filters: Readonly<Record<string, string>>;
  readonly at: number;
  /** Set when a paid call cites this token. */
  converted?: { resource: string; rank: number; at: number };
}

export interface ZeroResultQuery {
  query: string;
  count: number;
  lastSeen: string;
}

export interface ConversionRecord {
  query: string;
  resource: string;
  /** 1-based rank the converted resource held. Rank > 1 means ranking had it, but not first. */
  rank: number;
  at: string;
}

export interface SignalsReport {
  readonly searches: number;
  readonly zeroResultRate: number;
  readonly conversionRate: number;
  /** Queries returning nothing, most frequent first — the clearest retrieval gaps we have. */
  readonly zeroResultQueries: readonly ZeroResultQuery[];
  /** Queries that returned results but never converted, most frequent first. */
  readonly unconvertedQueries: readonly ZeroResultQuery[];
  /** Paid conversions: a query and the resource someone actually paid for after it. */
  readonly conversions: readonly ConversionRecord[];
  /** Mean rank of converted resources. Drifting upward means ranking is degrading. */
  readonly meanConvertedRank: number | null;
}

/**
 * Bounded, in-memory store of search behaviour.
 *
 * Deliberately mirrors `CatalogStore`: derived state, rebuildable, with a clean seam for a durable
 * backend later. Nothing here is on the settlement hot path.
 */
export class SignalStore {
  private records: SearchRecord[] = [];
  private byToken = new Map<string, SearchRecord>();

  constructor(private readonly capacity: number = MAX_SEARCHES) {}

  /**
   * Record a search and mint its correlation token.
   *
   * @param query - the raw query as asked
   * @param returned - entry keys in rank order
   * @returns the token to echo in `meta.searchToken`
   */
  recordSearch(
    query: string,
    returned: readonly string[],
    filters: Readonly<Record<string, string>> = {},
  ): string {
    const token = randomBytes(12).toString("base64url");
    const record: SearchRecord = {
      token,
      query,
      returned: [...returned],
      filters: { ...filters },
      at: Date.now(),
    };

    this.records.push(record);
    this.byToken.set(token, record);

    // Evict oldest first, keeping the token index in step so it cannot outgrow the buffer.
    while (this.records.length > this.capacity) {
      const evicted = this.records.shift();
      if (evicted) this.byToken.delete(evicted.token);
    }
    return token;
  }

  /**
   * Attribute a paid call back to the search that produced it.
   *
   * Unknown or expired tokens are ignored rather than rejected: the token is a hint for our own
   * analytics, and failing a buyer's payment because an analytics id had aged out would be an
   * absurd trade. Returns whether the attribution landed, for tests and metrics.
   */
  recordConversion(token: string | undefined, resource: string): boolean {
    if (!token) return false;
    const record = this.byToken.get(token);
    if (!record) return false;
    if (Date.now() - record.at > TOKEN_TTL_MS) return false;
    if (record.converted) return false; // first conversion wins; a token is one decision

    const index = record.returned.indexOf(resource);
    record.converted = {
      resource,
      // 0 means "paid for something this search did not return" — worth seeing, not an error.
      rank: index === -1 ? 0 : index + 1,
      at: Date.now(),
    };
    return true;
  }

  /** Normalised grouping key, so "Weather Forecast " and "weather forecast" aggregate together. */
  private static key(query: string): string {
    return query.trim().toLowerCase().replace(/\s+/g, " ");
  }

  /**
   * Aggregate the signals worth acting on.
   *
   * @param limit - how many queries to include in each ranked list
   */
  report(limit = 20): SignalsReport {
    const zero = new Map<string, { count: number; last: number; original: string }>();
    const unconverted = new Map<string, { count: number; last: number; original: string }>();
    const conversions: ConversionRecord[] = [];

    // The three buckets are NOT mutually exclusive, and treating them as a single if/else chain
    // silently loses data: a search that returned nothing but was still followed by a paid call is
    // both a zero-result query AND a conversion (at rank 0 — the buyer paid for something this
    // search did not surface). An earlier version dropped that conversion entirely, which showed up
    // live as `attributed: true` alongside `conversions: 0`. Each fact is now counted where it
    // belongs, independently.
    for (const record of this.records) {
      const key = SignalStore.key(record.query);

      if (record.returned.length === 0) {
        const entry = zero.get(key) ?? { count: 0, last: 0, original: record.query };
        entry.count += 1;
        entry.last = Math.max(entry.last, record.at);
        zero.set(key, entry);
      }

      if (record.converted) {
        conversions.push({
          query: record.query,
          resource: record.converted.resource,
          rank: record.converted.rank,
          at: new Date(record.converted.at).toISOString(),
        });
      } else if (record.returned.length > 0) {
        // "Returned something, bought nothing" — the signal that ranking surfaced the wrong things.
        const entry = unconverted.get(key) ?? { count: 0, last: 0, original: record.query };
        entry.count += 1;
        entry.last = Math.max(entry.last, record.at);
        unconverted.set(key, entry);
      }
    }

    const rank = (m: Map<string, { count: number; last: number; original: string }>) =>
      [...m.values()]
        .sort((a, b) => b.count - a.count || b.last - a.last)
        .slice(0, limit)
        .map(e => ({ query: e.original, count: e.count, lastSeen: new Date(e.last).toISOString() }));

    const total = this.records.length;
    const zeroCount = this.records.filter(r => r.returned.length === 0).length;
    const ranked = conversions.filter(c => c.rank > 0);

    return {
      searches: total,
      zeroResultRate: total === 0 ? 0 : zeroCount / total,
      conversionRate: total === 0 ? 0 : conversions.length / total,
      zeroResultQueries: rank(zero),
      unconvertedQueries: rank(unconverted),
      conversions: conversions.slice(-limit),
      meanConvertedRank:
        ranked.length === 0 ? null : ranked.reduce((s, c) => s + c.rank, 0) / ranked.length,
    };
  }

  /**
   * Candidate judgments for human review.
   *
   * A paid conversion is a relevance judgment somebody backed with money, which makes it far better
   * evidence than anything I would write by hand. It is still only a *candidate*: conversions are
   * caller-reported and therefore forgeable, so these are proposed to a human and never merged
   * automatically. Same rule as the rest of the automation — detect and draft, a human merges.
   */
  proposedJudgments(): Array<{ query: string; relevant: string[]; note: string }> {
    const byQuery = new Map<string, Map<string, number>>();
    for (const record of this.records) {
      if (!record.converted || record.converted.rank === 0) continue;
      const key = SignalStore.key(record.query);
      const resources = byQuery.get(key) ?? new Map<string, number>();
      resources.set(record.converted.resource, (resources.get(record.converted.resource) ?? 0) + 1);
      byQuery.set(key, resources);
    }

    return [...byQuery.entries()].map(([query, resources]) => ({
      query,
      relevant: [...resources.entries()].sort((a, b) => b[1] - a[1]).map(([r]) => r),
      note: `Derived from ${[...resources.values()].reduce((a, b) => a + b, 0)} paid conversion(s). Review before adding.`,
    }));
  }

  /** Stable digest of the current signal state, for change detection in a nightly report. */
  digest(): string {
    return createHash("sha256")
      .update(JSON.stringify(this.report(1000)))
      .digest("hex")
      .slice(0, 16);
  }

  get size(): number {
    return this.records.length;
  }

  clear(): void {
    this.records = [];
    this.byToken.clear();
  }
}
