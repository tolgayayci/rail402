/**
 * Catalog types.
 *
 * The wire shapes here are pinned to what stock SDK clients actually parse — verified against
 * `@x402/extensions`' `DiscoveryResource` type AND against live wire captures from the CDP Bazaar. Two details that are easy to get wrong and would
 * silently break every stock client:
 *
 *  - `GET /discovery/resources` returns **`items`** with offset pagination.
 *  - `GET /discovery/search` returns **`resources`** with cursor pagination.
 *
 *  - `lastUpdated` is an **ISO 8601 string**, not a Unix number. The core spec §8.3 says `number`,
 *    but the SDK type and every live implementation use a string. Stock clients win; the spec text
 *    is being fixed upstream.
 */

export type ResourceType = "http" | "mcp";

/** A payment option echoed into the catalog, mirroring `PaymentRequirements`. */
export interface CatalogAccepts {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  /** Required on v2 PaymentRequirements; a listing without it is not consumable by stock clients. */
  maxTimeoutSeconds: number;
  /**
   * Also required on v2 `PaymentRequirements` — the stock type is `extra: Record<string, unknown>`,
   * not optional — so an omitted `extra` is a listing a strict stock consumer rejects. Ingest always
   * emits it (`{}` when the seller declared none); for Stellar `exact` it additionally carries the
   * `areFeesSponsored` flag the stock @x402/stellar client hard-requires.
   */
  extra: Record<string, unknown>;
}

/**
 * Behaviour-derived ranking signals.
 *
 * Modelled on the shape CDP emits. These are harder to forge than self-declared metadata — nothing a
 * seller merely ASSERTS about itself influences rank — but they are NOT free of abuse, and claiming
 * "nothing a seller can forge" (as an earlier version of this comment did) was wrong. On a
 * fee-sponsored rail a distinct "unique payer" costs only a funded address (friendbot on testnet), so
 * a determined seller can manufacture ~25 of them to reach the ranking cap. `uniquePayers` at least
 * costs distinct addresses; `totalSettlements` costs nothing — two colluding addresses can inflate it
 * — which is why the ranker no longer weights it (see `qualityMultiplier`). The control the
 * "abuse-resistant" bar really wants is settled-VALUE weighting with a dust floor (real money moved,
 * not accounts created); that is the planned next step. A naive per-seller
 * result-page cap was tried and MEASURED harmful on this catalog — many distinct services legitimately
 * share one payTo (platform hosts, e.g. the 153 `stratalize.com` endpoints) — so it is not applied;
 * near-duplicate detection is the better anti-flooding control if one proves necessary.
 */
export interface QualitySignals {
  totalSettlements: number;
  uniquePayers: number;
  lastSettledAt?: string;
  firstSeenAt: string;
}

export interface CatalogEntry {
  /** Catalog key: canonical resource URL (origin + path, or origin + routeTemplate). */
  resource: string;
  type: ResourceType;
  /** MCP tool name. Part of the identity for MCP resources — (resource.url, toolName). */
  toolName?: string;
  x402Version: number;
  accepts: CatalogAccepts[];
  lastUpdated: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
  extensions?: Record<string, unknown>;
  quality: QualitySignals;
  /**
   * The payTo that first settled this listing. Ownership is claimed by settlement, so nobody can
   * overwrite another seller's entry or pricing ("a discovery index that does not let
   * anyone spoof another seller's listing or pricing").
   */
  ownerPayTo: string;
  /**
   * Whether `ownerPayTo` is listed in the SEP-1 `ACCOUNTS` of the resource's own domain.
   *
   * Settlement-gating makes a listing cost money; it does not make it truthful. This is what ties
   * the party being paid to the domain being listed, and it is the reason a squatter cannot hold a
   * key against the real owner. `undefined` means not yet checked —
   * verification is asynchronous and never blocks a settlement.
   */
  domainVerified?: boolean;
  /**
   * A provisional entry was cataloged at VERIFY, before any payment settled, so a resource shows up
   * "during payment verification" — which is what the upstream reference facilitator does and what
   * the e2e conformance suite checks. Provisional entries are deliberately weak: they
   * carry NO ranking signals and NO real ownership, and settlement always confirms or claims one, so
   * a free `/verify` call can neither rank a listing nor lock a real seller out of it. Cleared once
   * the entry settles.
   */
  provisional?: boolean;
  /** ISO deadline after which an unsettled provisional entry may be pruned. Set only when provisional. */
  provisionalUntil?: string;
  /**
   * Mirrored from another catalog rather than earned by a settlement here (`federation.ts`).
   *
   * A federated entry owns nothing, carries no ranking signal, and is always displaced by an owned
   * entry on the same key. Kept as a flag AND a separate storage map so the distinction survives a
   * refactor that only remembers one of them.
   */
  federated?: true;
  provenance?: ResourceProvenance;
}

/**
 * Where a listing came from, when we did not settle it ourselves.
 *
 * Additive and ignorable — a stock client that has never heard of it drops it, and everything the
 * spec defines is still in its usual place. Published because an agent deciding whether to trust a
 * listing should be able to tell "this facilitator saw a payment for this" from "somebody else says
 * this exists", and because the licences that make mirroring permissible require the credit.
 */
export interface ResourceProvenance {
  /** Stable source slug, e.g. `"x402-list"`. */
  source: string;
  sourceUrl: string;
  /** SPDX identifier or licence name under which the source permits republication. */
  license: string;
  attribution: string;
  /** When this copy was taken. A mirror's value is inseparable from its age. */
  fetchedAt: string;
}

/**
 * Separator for composite catalog keys.
 *
 * A null byte, chosen deliberately: it cannot appear in a URL or in an MCP tool name, so a key can
 * never be ambiguous between `(resource, toolName)` pairs. It is invisible in logs, which is why
 * NOTHING may build this key by hand — always call `entryKey`. An earlier version of the judgment
 * set hardcoded a space-joined key and silently failed every MCP assertion while printing two
 * strings that looked identical.
 */
const KEY_SEPARATOR = "\u0000";

/**
 * Identity of a catalog entry.
 *
 * MCP multiplexes many tools over a single endpoint, so `resource.url` alone is not unique. The
 * spec is explicit: facilitators MUST key MCP tools on the tuple (`resource.url`, `input.toolName`).
 */
export function entryKey(resource: string, toolName?: string): string {
  return toolName ? `${resource}${KEY_SEPARATOR}${toolName}` : resource;
}

/**
 * Filters shared by both discovery endpoints.
 *
 * The first five are spec-defined (with `limit`/`offset` or `cursor`, that is the spec's seven).
 * `source` is ours and additive: `local` restricts results to listings this facilitator saw settle,
 * and a source slug restricts them to one mirror. A client that omits it gets everything, which is
 * the spec's behaviour unchanged.
 */
export interface DiscoveryFilters {
  type?: string;
  payTo?: string;
  scheme?: string;
  network?: string;
  extensions?: string;
  source?: string;
}

export interface ListResponse {
  x402Version: number;
  items: PublicResource[];
  pagination: { limit: number; offset: number; total: number };
}

export interface SearchResponse {
  x402Version: number;
  resources: PublicResource[];
  partialResults?: boolean;
  pagination?: { limit: number; cursor: string | null } | null;
  /**
   * How the results were retrieved. Optional and additive; CDP ships `"hybrid"` here today.
   *
   * Declaring it is cheap honesty that also disciplines us — if this ever says `hybrid`, a hybrid
   * had better exist. Ours says `lexical+signals`: BM25 over weighted fields, with a capped
   * settlement-derived boost.
   */
  searchMethod?: string;
  /**
   * Correlation token for this response, so a later paid call can be attributed to the search that
   * produced it. Optional, additive, ignored by clients that have never heard of it — and a
   * convergence on CDP's shipped convention rather than a field we invented.
   */
  meta?: { searchToken: string };
}

/** The public projection of a catalog entry. `ownerPayTo` is internal and never serialized. */
export interface PublicResource {
  resource: string;
  type: ResourceType;
  x402Version: number;
  accepts: CatalogAccepts[];
  lastUpdated: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
  extensions?: Record<string, unknown>;
  quality?: QualitySignals;
  /** Present once checked. Buyers can prefer verified sellers; nothing forces them to. */
  domainVerified?: boolean;
  /**
   * Present only on entries mirrored from another catalog. Its absence means this facilitator saw a
   * payment settle for the listing; its presence means somebody else says the listing exists.
   */
  provenance?: ResourceProvenance;
}

export function toPublic(entry: CatalogEntry): PublicResource {
  const out: PublicResource = {
    resource: entry.resource,
    type: entry.type,
    x402Version: entry.x402Version,
    accepts: entry.accepts,
    lastUpdated: entry.lastUpdated,
    quality: entry.quality,
  };
  if (entry.description !== undefined) out.description = entry.description;
  if (entry.mimeType !== undefined) out.mimeType = entry.mimeType;
  if (entry.serviceName !== undefined) out.serviceName = entry.serviceName;
  if (entry.tags !== undefined) out.tags = entry.tags;
  if (entry.iconUrl !== undefined) out.iconUrl = entry.iconUrl;
  if (entry.extensions !== undefined) out.extensions = entry.extensions;
  if (entry.domainVerified !== undefined) out.domainVerified = entry.domainVerified;
  if (entry.provenance !== undefined) {
    out.provenance = entry.provenance;
    // A mirrored listing must never appear to carry earned signals. They are zeroed at import, and
    // dropped here as well: a `quality` block of zeroes reads as "nobody has ever paid for this",
    // which is a claim about the resource rather than about what we know.
    delete out.quality;
  }
  return out;
}
