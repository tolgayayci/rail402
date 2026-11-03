import type { CatalogOutcome } from "./catalog.ts";
import { bazaarCodes, type BazaarCode } from "./codes.ts";
import { usagePrivate, type ListingUsage, type SellerUsage, type SettlementLink } from "./store.ts";
import type {
  DomainClaim,
  Listing,
  ListingContent,
  ListingVersion,
  OptionFacts,
  ResourceListings,
  Trust,
} from "./types.ts";

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
    /**
     * The weakest trust among the listings shown, never more than any one network proved. Filtered by
     * network, an item shows that network's listing only, so this is its trust; each listing's own
     * trust is in `listings`.
     */
    readonly trust: Trust;
    /**
     * The fewest settlements of any listing shown, never a sum across networks: testnet settlements
     * are free, so they never add to a pubnet count. Filtered by network, this is that network's
     * count; each network's own count is in `listings`.
     */
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
  /** Absent while the listing's usage is private (`usagePrivate`). */
  readonly lastSettled?: string;
  /**
   * When the listing's Stellar facts were read, and the SEP-1 binding of its host and owner: whether
   * the host's stellar.toml lists the owner, and whether the owner's home_domain names the host.
   */
  readonly stellar?: {
    readonly checkedAt: string;
    readonly domain?: DomainClaim;
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
      trust: trustFor(listings),
      settlements: settlementsFor(listings),
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

/**
 * The trust a resource shows: the weakest of its listings'. Trust is proved per network (a domain's
 * claim, an origin's answer), so trust earned on one network never stands in for another's.
 */
export function trustFor(listings: ResourceListings): Trust {
  return listings.reduce<Trust>(
    (weakest, listing) => (trustRank(listing.trust) < trustRank(weakest) ? listing.trust : weakest),
    listings[0].trust,
  );
}

/**
 * The settlements a resource shows: the fewest of its listings'. Settlements are counted per network,
 * and a count on one network never stands in for, or adds to, another's.
 */
export function settlementsFor(listings: ResourceListings): number {
  return listings.reduce((fewest, listing) => Math.min(fewest, listing.settlements), listings[0].settlements);
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
    ...(usagePrivate(listing) ? {} : { lastSettled: listing.lastSettledAt.toISOString() }),
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

/**
 * One version of a listing's history. `linked: false` leaves out the settlement transaction that caused
 * it: for a listing whose usage is private, or on a network that publishes usage counts only, the
 * history never links a settlement, and with it its payer, to the listing.
 */
export function toVersionItem(version: ListingVersion, linked = true) {
  return {
    version: version.version,
    createdAt: version.createdAt.toISOString(),
    cause: version.cause,
    ...(version.transaction === undefined || !linked ? {} : { transaction: version.transaction }),
    owner: version.owner,
    trust: version.trust,
    state: version.state,
    ...(version.reason === undefined ? {} : { reason: version.reason }),
    content: version.state === "published" ? version.content : withheldContent(version.content),
    ...(version.state === "published" ? {} : { contentWithheld: true }),
  };
}

/**
 * A listing's content without what it describes about itself: its description, service name, tags,
 * icon, MIME type and bazaar `info` and `schema`. A listing that is not published (pending, or
 * withdrawn) may carry metadata a payer echoed and no origin confirmed, under the payTo it paid, so
 * the public detail and history routes show only its resource, kind and the payment options that
 * were settled.
 */
export function withheldContent(content: ListingContent): ListingContent {
  return {
    resource: content.resource,
    kind: content.kind,
    ...(content.method === undefined ? {} : { method: content.method }),
    ...(content.toolName === undefined ? {} : { toolName: content.toolName }),
    bazaar: {
      info: {},
      schema: {},
      ...(content.bazaar.routeTemplate === undefined ? {} : { routeTemplate: content.bazaar.routeTemplate }),
    },
    accepts: content.accepts,
  };
}

/** A listing as the public detail route shows it: with its content withheld unless it is published. */
export function toListingDetail(listing: Listing) {
  if (listing.state === "published") return { ...toDiscoveryItem([listing]), state: listing.state };
  const item = toDiscoveryItem([{ ...listing, content: withheldContent(listing.content) }]);
  return {
    ...item,
    // Summarised from the stored listing: the withheld content no longer declares the extensions
    // that keep its usage private, and a withdrawn listing's usage stays as private as it was.
    rail402: { ...item.rail402, listings: [toListingSummary(listing)] },
    state: listing.state,
    contentWithheld: true,
  };
}

/**
 * A listing as the usage routes name it: what it is and the price it lists on one network. `scheme`,
 * `asset`, `amount` and `payTo` come from the listing's payment option on that network (the first one
 * in `asset` when given and there is one).
 */
export interface ListingRef {
  readonly id: string;
  readonly type: string;
  readonly resource: string;
  readonly method?: string;
  readonly toolName?: string;
  readonly description?: string;
  readonly serviceName?: string;
  readonly payTo: string;
  readonly scheme: string;
  readonly amount: string;
  readonly asset: string;
  readonly network: string;
  readonly lastUpdated: string;
}

/** A published listing as a `ListingRef` on `network`. */
export function toListingRef(listing: Listing, network: string, asset?: string): ListingRef {
  const { content } = listing;
  const options = content.accepts.filter((option) => option.network === network);
  const option = options.find((candidate) => candidate.asset === asset) ?? options[0] ?? content.accepts[0];
  return {
    id: listing.id,
    type: content.kind,
    resource: content.resource,
    ...(content.method === undefined ? {} : { method: content.method }),
    ...(content.toolName === undefined ? {} : { toolName: content.toolName }),
    ...(content.description === undefined ? {} : { description: content.description }),
    ...(content.serviceName === undefined ? {} : { serviceName: content.serviceName }),
    payTo: option?.payTo ?? listing.owner,
    scheme: option?.scheme ?? "",
    amount: option?.amount ?? "",
    asset: option?.asset ?? "",
    network,
    lastUpdated: listing.lastUpdated.toISOString(),
  };
}

/** GET /discovery/settlements: the settlements linked to a listing, in the order they were asked for. */
export function toSettlementsResponse(
  links: readonly SettlementLink[],
  transactions: readonly string[],
  network: string,
  asOf: Date,
) {
  const byTransaction = new Map(links.map((link) => [link.observation.transaction, link]));
  const items = [...new Set(transactions)].flatMap((transaction) => {
    const link = byTransaction.get(transaction);
    if (link === undefined) return [];
    return [
      {
        transaction,
        listing: toListingRef(link.listing, network, link.observation.asset),
        observedAt: link.observation.observedAt.toISOString(),
      },
    ];
  });
  return { items, asOf: asOf.toISOString() };
}

/** GET /discovery/resources/{id}/usage. Only these fields of each settlement are published. */
export function toListingUsageResponse(listingId: string, usage: ListingUsage) {
  return {
    listingId,
    payments: usage.payments,
    payers: usage.payers,
    firstObservedAt: usage.firstObservedAt?.toISOString() ?? null,
    lastObservedAt: usage.lastObservedAt?.toISOString() ?? null,
    recent: usage.recent.map((observation) => ({
      transaction: observation.transaction,
      payer: observation.payer,
      asset: observation.asset,
      amount: observation.amount,
      observedAt: observation.observedAt.toISOString(),
    })),
  };
}

/** GET /discovery/sellers/{payTo}/usage. */
export function toSellerUsageResponse(payTo: string, network: string, usage: SellerUsage) {
  return {
    payTo,
    totals: { payments: usage.payments, payers: usage.payers },
    listings: usage.listings.map((entry) => ({
      listing: toListingRef(entry.listing, network),
      payments: entry.payments,
      payers: entry.payers,
      lastObservedAt: entry.lastObservedAt?.toISOString() ?? null,
    })),
    truncated: usage.truncated,
  };
}

/** Largest `EXTENSION-RESPONSES` value sent; common HTTP clients refuse headers past about 16 KB. */
export const MAX_EXTENSION_RESPONSES_BYTES = 4_096;

/**
 * The `EXTENSION-RESPONSES` header value: base64 JSON keyed by extension name (x402 v2 §7.2.1). The
 * cataloging outcome goes under `bazaar`, next to any other extensions' entries in `others`. An
 * outcome too large for the budget is reduced to its status, code and a fixed reason, so the header
 * can never make an HTTP client reject the response of a settled payment.
 */
export function extensionResponsesHeader(
  outcome: CatalogOutcome | undefined,
  others: Readonly<Record<string, unknown>> = {},
): string {
  const encode = (value: CatalogOutcome | undefined) =>
    Buffer.from(JSON.stringify(value === undefined ? others : { ...others, bazaar: value })).toString(
      "base64",
    );
  const full = encode(outcome);
  if (outcome === undefined || full.length <= MAX_EXTENSION_RESPONSES_BYTES) return full;
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
