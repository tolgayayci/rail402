import { createError, type X402ErrorPayload, type ErrorCode } from "@x402-stellar/errors";
import type { CatalogAccepts, CatalogEntry, ResourceProvenance, ResourceType } from "./types.js";

/**
 * Federation — showing an agent Stellar resources that other catalogs list, without pretending we
 * vouch for them.
 *
 * The interop rule: "Stellar listings must be representable consistently with how other
 * facilitators represent theirs — Stellar is not a walled garden". The read direction of that is a
 * buyer asking us for a capability and getting the ecosystem's answer rather than only ours.
 *
 * Everything here is built around one distinction, because collapsing it is the entire risk:
 *
 * | | Owned | Federated |
 * |---|---|---|
 * | How it got here | a payment settled through THIS facilitator | copied from someone else's catalog |
 * | Ranking signals | unique payers, earned on-chain | **none, ever** |
 * | Ownership of the key | claimed, SEP-1 verifiable | **none** — a real seller always displaces it |
 * | Persisted | yes | **no** — it is a cache of somebody else's data |
 * | On the wire | plain | carries `provenance` naming the source and its licence |
 *
 * ## Why federated entries carry no ranking signal
 *
 * Our quality signal is distinct payers who settled *here*, which is expensive to forge because each
 * one is a funded account making a real payment. A remote catalog's numbers cost us nothing to
 * import and cost an attacker nothing to manufacture — anyone who can get a listing into that
 * catalog would be able to move rank in ours. So federated entries are scored on relevance alone
 * (`qualityMultiplier` returns 1.0 for `uniquePayers: 0`); they can win on being a better match and
 * on nothing else.
 *
 * ## Why a source must be declared before it is read
 *
 * Mirroring somebody's catalog redistributes their data, so a source is refused unless it declares a
 * licence, the attribution that licence requires, and an explicit acknowledgement that a human has
 * read the terms. Fail closed: the default configuration federates nothing at all, and adding a
 * source is a deliberate act with a name attached — not something that happens because a URL was
 * reachable.
 */

/** A catalog we are willing to read from, and the terms under which we may republish it. */
export interface FederationSource {
  /** Stable slug published as `provenance.source`. Changing it changes what agents have cached. */
  readonly id: string;
  /** The source's `/discovery/resources` endpoint. */
  readonly url: string;
  /** SPDX identifier or licence name. Required — we do not republish unattributed data. */
  readonly license: string;
  /** Human-readable credit, as the licence requires (CC-BY and friends do). Required. */
  readonly attribution: string;
  /**
   * A human has read this source's terms and confirmed that mirroring is permitted.
   *
   * Deliberately not inferrable. A robots.txt or an open endpoint is not permission, and this is the
   * one question in the module that code genuinely cannot answer.
   */
  readonly termsAcknowledged: boolean;
  /** Only import listings on these CAIP-2 networks. Omit to import whatever the source lists. */
  readonly networks?: readonly string[];
}

/** How stale a mirror may get before it is refreshed. */
export const DEFAULT_REFRESH_MS = 15 * 60 * 1000;
/** Bound on what one source can put in our memory, and on how long a fetch may hold us up. */
const MAX_ENTRIES_PER_SOURCE = 2_000;
const FETCH_TIMEOUT_MS = 10_000;

export interface FederationRefreshResult {
  readonly source: string;
  readonly imported: number;
  readonly rejected: number;
  readonly error?: X402ErrorPayload<ErrorCode>;
}

/** The wire shape we read. Only the fields a listing needs to be usable are required. */
interface RemoteResource {
  resource?: unknown;
  type?: unknown;
  x402Version?: unknown;
  accepts?: unknown;
  lastUpdated?: unknown;
  description?: unknown;
  serviceName?: unknown;
  tags?: unknown;
  extensions?: unknown;
}

/**
 * Validate a source's declaration before any request is made.
 *
 * @returns a coded rejection, or `undefined` when the source may be read
 */
export function checkSource(source: FederationSource): X402ErrorPayload<ErrorCode> | undefined {
  const reject = (reason: string) =>
    createError("bazaar_federation_source_refused", { reason, details: { source: source.id } });

  if (!source.id.trim()) return reject("A federation source must declare a non-empty id.");
  if (!source.license.trim()) {
    return reject(
      `Federation source "${source.id}" declares no licence. Republishing somebody's catalog redistributes their data, so the licence has to be recorded before anything is copied.`,
    );
  }
  if (!source.attribution.trim()) {
    return reject(
      `Federation source "${source.id}" declares no attribution. Every licence permissive enough to mirror under requires credit, and it is published with each entry.`,
    );
  }
  if (!source.termsAcknowledged) {
    return reject(
      `Federation source "${source.id}" has not been acknowledged. Set termsAcknowledged only after a human has read that source's terms and confirmed mirroring is permitted — a reachable endpoint is not permission.`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(source.url);
  } catch {
    return reject(`Federation source "${source.id}" has an unparseable url: ${source.url}`);
  }
  if (parsed.protocol !== "https:") {
    return reject(
      `Federation source "${source.id}" must be https. Mirrored listings become search results we serve, so the transport carrying them cannot be tamperable in flight.`,
    );
  }
  return undefined;
}

/**
 * A read-only mirror of other catalogs, refreshed on a timer and merged at read time.
 *
 * Holds its entries entirely separately from the owned catalog. That separation is structural rather
 * than a convention: `CatalogStore.get` — which is what the ownership check reads — never sees these,
 * so a mirrored listing can never block a real seller from claiming their own key.
 */
export class FederatedCatalog {
  private readonly sources: FederationSource[] = [];
  private readonly refused = new Map<string, X402ErrorPayload<ErrorCode>>();
  private entriesBySource = new Map<string, CatalogEntry[]>();
  private readonly fetchImpl: typeof fetch;

  constructor(sources: readonly FederationSource[] = [], fetchImpl: typeof fetch = fetch) {
    this.fetchImpl = fetchImpl;
    for (const source of sources) {
      const problem = checkSource(source);
      if (problem) {
        // Recorded rather than thrown: one misconfigured source must not stop a facilitator booting,
        // and the operator needs to see WHICH one and why.
        this.refused.set(source.id, problem);
        console.error(`federation: refusing source "${source.id}" — ${problem.reason}`);
        continue;
      }
      this.sources.push(source);
    }
  }

  /** Sources that failed their declaration check, for `/health` and the operator's logs. */
  get refusals(): X402ErrorPayload<ErrorCode>[] {
    return [...this.refused.values()];
  }

  get size(): number {
    let total = 0;
    for (const list of this.entriesBySource.values()) total += list.length;
    return total;
  }

  /** Every mirrored entry, in a stable order. */
  all(): CatalogEntry[] {
    const out: CatalogEntry[] = [];
    for (const id of [...this.entriesBySource.keys()].sort()) {
      out.push(...(this.entriesBySource.get(id) ?? []));
    }
    return out;
  }

  /** Fetch every configured source. Never throws — a source that is down is a source that is down. */
  async refresh(now: string = new Date().toISOString()): Promise<FederationRefreshResult[]> {
    const results: FederationRefreshResult[] = [];
    for (const source of this.sources) {
      try {
        const { entries, rejected } = await this.readSource(source, now);
        this.entriesBySource.set(source.id, entries);
        results.push({ source: source.id, imported: entries.length, rejected });
      } catch (error) {
        // Keep whatever was mirrored last time. A source's outage should degrade freshness, not
        // silently delete listings an agent found five minutes ago.
        results.push({
          source: source.id,
          imported: this.entriesBySource.get(source.id)?.length ?? 0,
          rejected: 0,
          error: createError("bazaar_federation_source_unavailable", {
            reason: `Could not refresh "${source.id}" from ${source.url}: ${error instanceof Error ? error.message : "unknown error"}. Serving the previous mirror.`,
            details: { source: source.id },
          }),
        });
      }
    }
    return results;
  }

  private async readSource(
    source: FederationSource,
    now: string,
  ): Promise<{ entries: CatalogEntry[]; rejected: number }> {
    const url = new URL(source.url);
    url.searchParams.set("limit", "100");

    const response = await this.fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { items?: unknown };
    // `items` on the list endpoint — the asymmetry with search's `resources` is real and
    // load-bearing, and reading the wrong key makes a working source look empty.
    const items = Array.isArray(body.items) ? body.items : [];

    const provenance: ResourceProvenance = {
      source: source.id,
      sourceUrl: source.url,
      license: source.license,
      attribution: source.attribution,
      fetchedAt: now,
    };

    const entries: CatalogEntry[] = [];
    let rejected = 0;
    for (const raw of items.slice(0, MAX_ENTRIES_PER_SOURCE)) {
      const entry = this.normalize(raw as RemoteResource, source, provenance, now);
      if (entry) entries.push(entry);
      else rejected += 1;
    }
    return { entries, rejected };
  }

  /**
   * Turn a remote listing into a catalog entry, or drop it.
   *
   * Applies the same payability bar as our own ingest, because the point of showing an agent a
   * listing is that it can act on it. The live CDP catalog carries Stellar `exact` entries with no
   * `extra.areFeesSponsored`, which the stock `@x402/stellar` client throws on — mirroring those
   * would just relocate somebody else's broken listings into our results.
   */
  private normalize(
    raw: RemoteResource,
    source: FederationSource,
    provenance: ResourceProvenance,
    now: string,
  ): CatalogEntry | undefined {
    if (typeof raw.resource !== "string" || raw.resource.length === 0) return undefined;
    try {
      const parsed = new URL(raw.resource);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    } catch {
      return undefined;
    }
    const type: ResourceType = raw.type === "mcp" ? "mcp" : "http";
    if (!Array.isArray(raw.accepts)) return undefined;

    const accepts: CatalogAccepts[] = [];
    for (const option of raw.accepts as Record<string, unknown>[]) {
      if (
        typeof option?.["scheme"] !== "string" ||
        typeof option["network"] !== "string" ||
        typeof option["amount"] !== "string" ||
        typeof option["asset"] !== "string" ||
        typeof option["payTo"] !== "string" ||
        typeof option["maxTimeoutSeconds"] !== "number"
      ) {
        continue;
      }
      const network = option["network"];
      if (source.networks && !source.networks.includes(network)) continue;

      const extra = (option["extra"] ?? {}) as Record<string, unknown>;
      if (option["scheme"] === "exact" && network.startsWith("stellar:") && extra["areFeesSponsored"] !== true) {
        continue; // unpayable by a stock client — see the method comment
      }
      accepts.push({
        scheme: option["scheme"],
        network,
        amount: option["amount"],
        asset: option["asset"],
        payTo: option["payTo"],
        maxTimeoutSeconds: option["maxTimeoutSeconds"],
        // Whatever the source computed about the asset is THEIR claim, not our derivation, so the
        // `stellar` block is dropped rather than republished under our name.
        extra: withoutStellar(extra),
      });
    }
    if (accepts.length === 0) return undefined;

    const toolName =
      type === "mcp"
        ? ((raw.extensions as { bazaar?: { info?: { input?: { toolName?: unknown } } } } | undefined)
            ?.bazaar?.info?.input?.toolName as string | undefined)
        : undefined;
    if (type === "mcp" && !toolName) return undefined; // an MCP listing without its tool name has no identity

    return {
      resource: raw.resource,
      type,
      ...(toolName === undefined ? {} : { toolName }),
      x402Version: typeof raw.x402Version === "number" ? raw.x402Version : 2,
      accepts,
      lastUpdated: typeof raw.lastUpdated === "string" ? raw.lastUpdated : now,
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
      ...(typeof raw.serviceName === "string" ? { serviceName: raw.serviceName } : {}),
      ...(Array.isArray(raw.tags) ? { tags: raw.tags.filter((t): t is string => typeof t === "string") } : {}),
      ...(raw.extensions && typeof raw.extensions === "object"
        ? { extensions: raw.extensions as Record<string, unknown> }
        : {}),
      // Zeroed, not copied. A remote catalog's counts are not evidence we have, and importing them
      // would let anyone who can list there move rank here.
      quality: { totalSettlements: 0, uniquePayers: 0, firstSeenAt: now },
      // No owner: nobody has proved anything about this listing to us, and an owned entry on the
      // same key always wins.
      ownerPayTo: "",
      federated: true,
      provenance,
    };
  }
}

function withoutStellar(extra: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...extra };
  delete copy["stellar"];
  return copy;
}
