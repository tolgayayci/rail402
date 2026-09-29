import type { CatalogOutcome } from "./catalog.ts";
import { bazaarCodes, type BazaarCode } from "./codes.ts";
import type { Listing, ListingVersion, OptionFacts, ResourceListings, Trust } from "./types.ts";

/**
 * A resource as published by GET /discovery/resources (x402 v2 §8.3). One resource sold on several
 * networks is one item: `accepts` holds every network's options. Rail402-specific facts live under
 * `rail402`, so stock clients see exactly the spec's shape.
 */
export interface DiscoveryItem {
  readonly resource: string;
  readonly type: string;
  readonly x402Version: 2;
  readonly accepts: readonly Record<string, unknown>[];
  readonly lastUpdated: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly serviceName?: string;
  readonly tags?: readonly string[];
  readonly iconUrl?: string;
  /** `bazaar`, and an empty object for every other extension the resource declares in its 402. */
  readonly extensions: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly rail402: {
    readonly method?: string;
    readonly toolName?: string;
    /** The strongest trust among the resource's listings. */
    readonly trust: Trust;
    /** Settlements across every listing. */
    readonly settlements: number;
    /** The catalog listings behind the resource, one per network, each with its own owner and history. */
    readonly listings: readonly ListingSummary[];
    /** One entry per `accepts` option: the listing it belongs to and what the network says about its token. */
    readonly options: readonly OptionSummary[];
  };
}

export interface ListingSummary {
  readonly id: string;
  readonly network: string;
  readonly version: number;
  readonly trust: Trust;
  readonly owner: string;
  readonly settlements: number;
  readonly firstCataloged: string;
  readonly lastSettled: string;
  /** When the listing's Stellar facts were read, and whether the host's stellar.toml lists the owner. */
  readonly stellar?: {
    readonly checkedAt: string;
    readonly domain?: { readonly host: string; readonly claimsOwner: boolean };
  };
}

/** A payment option's listing, and its token's symbol, name and decimals and whether payTo can receive it. */
export interface OptionSummary extends OptionFacts {
  readonly listing: string;
}

const TRUST_RANK: Readonly<Record<Trust, number>> = { settled: 0, origin_verified: 1, domain_verified: 2 };

/** Orders trust levels, weakest first. */
export function trustRank(trust: Trust): number {
  return TRUST_RANK[trust];
}

/** One resource as a discovery item. Its content comes from the first listing; `accepts` from all. */
export function toDiscoveryItem(listings: ResourceListings): DiscoveryItem {
  const [primary] = listings;
  const { content } = primary;
  const declared = [...new Set(listings.flatMap((listing) => listing.content.extensions ?? []))].sort();
  return {
    resource: content.resource,
    type: content.kind,
    x402Version: 2,
    accepts: listings.flatMap((listing) => listing.content.accepts.map((option) => ({ ...option }))),
    lastUpdated: latest(listings.map((listing) => listing.lastUpdated)).toISOString(),
    ...(content.description === undefined ? {} : { description: content.description }),
    ...(content.mimeType === undefined ? {} : { mimeType: content.mimeType }),
    ...(content.serviceName === undefined ? {} : { serviceName: content.serviceName }),
    ...(content.tags === undefined ? {} : { tags: content.tags }),
    ...(content.iconUrl === undefined ? {} : { iconUrl: content.iconUrl }),
    extensions: {
      bazaar: { ...content.bazaar },
      ...Object.fromEntries(declared.map((key) => [key, {}])),
    },
    rail402: {
      ...(content.method === undefined ? {} : { method: content.method }),
      ...(content.toolName === undefined ? {} : { toolName: content.toolName }),
      trust: listings.reduce<Trust>(
        (best, listing) => (trustRank(listing.trust) > trustRank(best) ? listing.trust : best),
        primary.trust,
      ),
      settlements: listings.reduce((sum, listing) => sum + listing.settlements, 0),
      listings: listings.map(toListingSummary),
      options: listings.flatMap((listing) =>
        listing.content.accepts.map((_, index) => ({
          listing: listing.id,
          ...(listing.facts?.options[index] ?? {}),
        })),
      ),
    },
  };
}

function toListingSummary(listing: Listing): ListingSummary {
  return {
    id: listing.id,
    network: listing.identity.network,
    version: listing.version,
    trust: listing.trust,
    owner: listing.owner,
    settlements: listing.settlements,
    firstCataloged: listing.firstCatalogedAt.toISOString(),
    lastSettled: listing.lastSettledAt.toISOString(),
    ...(listing.facts === undefined
      ? {}
      : {
          stellar: {
            checkedAt: listing.facts.checkedAt.toISOString(),
            ...(listing.facts.domain === undefined ? {} : { domain: listing.facts.domain }),
          },
        }),
  };
}

function latest(dates: readonly Date[]): Date {
  return new Date(Math.max(...dates.map((date) => date.getTime())));
}

export function toVersionItem(version: ListingVersion) {
  return {
    version: version.version,
    createdAt: version.createdAt.toISOString(),
    cause: version.cause,
    ...(version.transaction === undefined ? {} : { transaction: version.transaction }),
    owner: version.owner,
    trust: version.trust,
    state: version.state,
    content: version.content,
  };
}

/** Largest `EXTENSION-RESPONSES` value sent; common HTTP clients refuse headers past about 16 KB. */
export const MAX_EXTENSION_RESPONSES_BYTES = 4_096;

/**
 * The `EXTENSION-RESPONSES` header value: base64 JSON keyed by extension name (x402 v2 §7.2.1). An
 * outcome too large for the budget is reduced to its status, code and a fixed reason, so the header
 * can never make an HTTP client reject the response of a settled payment.
 */
export function extensionResponsesHeader(outcome: CatalogOutcome): string {
  const encode = (value: CatalogOutcome) => Buffer.from(JSON.stringify({ bazaar: value })).toString("base64");
  const full = encode(outcome);
  if (full.length <= MAX_EXTENSION_RESPONSES_BYTES) return full;
  const registered = outcome.code in bazaarCodes ? bazaarCodes[outcome.code as BazaarCode].reason : undefined;
  return encode({
    status: outcome.status,
    code: outcome.code,
    ...(outcome.status === "rejected"
      ? { rejectedReason: registered ?? "The cataloging outcome was too large to report." }
      : {}),
    ...(outcome.listingId === undefined ? {} : { listingId: outcome.listingId }),
    ...(outcome.version === undefined ? {} : { version: outcome.version }),
  });
}
