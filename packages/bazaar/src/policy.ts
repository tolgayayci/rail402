import { PUBNET } from "@rail402.dev/stellar";

/**
 * How much cataloging work one network may cause. Every budget is kept per network, so free testnet
 * payments can never use up what pubnet sellers need.
 */
export interface CatalogBudget {
  /**
   * New listings the catalog publishes per hour on this network, from anyone: listings first published
   * in the last hour, whatever their state now. Listings never published, which any payer can create
   * for any payTo, never count, so unconfirmed listings cannot block other sellers; they count toward
   * their payer's quota only. A listing its origin confirms while the hour's quota is spent waits for
   * room before it is published, however long ago it was created. Listings no origin can confirm have
   * a share of their own (see `unverifiedBudget`).
   */
  readonly maxNewListingsPerHour: number;
  /**
   * New listings one payTo may create per hour at one origin (scheme, host and port) on this network.
   * A listing counts from its first publication once that origin confirmed a settlement that paid the
   * payTo its price there (for `upto`, the whole cap), so neither other hosts, which can answer a 402
   * naming any payTo, nor dust payments, such as one base unit for each spelling of a route a seller's
   * server answers alike, use up a seller's quota. A listing handed over to the payTo by an ownership
   * transfer counts toward nobody's quota, and no listing is charged past the quota: one that would
   * be waits for room before it is first published. A seller's listings across its origins, and
   * those that do not count, stay bounded by the payer and network-wide quotas.
   */
  readonly maxNewListingsPerOwnerPerHour: number;
  /** New listings the settlements of one payer may create per hour on this network. */
  readonly maxNewListingsPerPayerPerHour: number;
  /** Origin requests one host receives per minute from this process for listings on this network. */
  readonly originChecksPerHostPerMinute: number;
  /**
   * Listings an origin confirmed that this network may have published at once. A new listing is
   * refused while the network is full (`bazaar_catalog_full`), and a pending one is not published
   * (`catalog_full`). Listings no origin can confirm have a share of their own (see `unverifiedBudget`).
   */
  readonly maxPublishedListings: number;
  /**
   * Listings an origin confirmed that one payTo may have published at once on this network, so no
   * seller, or one party behind many listings, holds more than a share of `maxPublishedListings`. A
   * new listing past it is refused (`bazaar_catalog_full`) and a pending one is not published
   * (`catalog_full`), as when the network is full; 0 sets no share.
   */
  readonly maxPublishedListingsPerOwner: number;
  /**
   * Hours a published listing no origin ever confirmed (trust `settled`: an `mcp://` tool) stays
   * listed after its last settlement; it is then withdrawn (`listing_expired`) until its owner's next
   * settlement.
   */
  readonly unverifiedListingTtlHours: number;
  /**
   * Days any published listing stays listed after its last settlement before it is withdrawn
   * (`listing_expired`); a later settlement lists it again once its origin confirms it. 0 never
   * withdraws a listing for being idle.
   */
  readonly idleListingTtlDays: number;
}

/**
 * What listings no origin can confirm (`mcp://` tools, published at trust `settled`) may take of a
 * network's budget: half of its hourly quota of new listings and half of its room, counted apart from
 * listings an origin confirmed. Any payer can create such a listing for any payTo with one base unit,
 * so they never use up the quota or the room that sellers with an origin need.
 */
export function unverifiedBudget(
  budget: CatalogBudget,
): Pick<CatalogBudget, "maxNewListingsPerHour" | "maxPublishedListings"> {
  return {
    maxNewListingsPerHour: Math.floor(budget.maxNewListingsPerHour / 2),
    maxPublishedListings: Math.floor(budget.maxPublishedListings / 2),
  };
}

/** The budget of a network without settings of its own: testnet and any network but pubnet. */
export const DEFAULT_CATALOG_BUDGET: CatalogBudget = {
  maxNewListingsPerHour: 1_000,
  maxNewListingsPerOwnerPerHour: 20,
  maxNewListingsPerPayerPerHour: 10,
  originChecksPerHostPerMinute: 30,
  maxPublishedListings: 5_000,
  maxPublishedListingsPerOwner: 0,
  unverifiedListingTtlHours: 168,
  idleListingTtlDays: 90,
};

/** Pubnet's budget unless configured: listings there reach buyers paying real money. */
export const PUBNET_CATALOG_BUDGET: CatalogBudget = {
  maxNewListingsPerHour: 200,
  maxNewListingsPerOwnerPerHour: 5,
  maxNewListingsPerPayerPerHour: 5,
  originChecksPerHostPerMinute: 10,
  maxPublishedListings: 25_000,
  maxPublishedListingsPerOwner: 250,
  unverifiedListingTtlHours: 168,
  idleListingTtlDays: 90,
};

/**
 * The budget a network catalogs under: its own settings, completed by pubnet's stricter defaults on
 * pubnet and by `fallback` (the catalog-wide settings) on every other network. Settings meant for
 * testnet never loosen pubnet.
 */
export function catalogBudgetFor(
  network: string,
  configured: Partial<CatalogBudget> | undefined,
  fallback: Partial<CatalogBudget> = {},
): CatalogBudget {
  const base =
    network === PUBNET ? PUBNET_CATALOG_BUDGET : { ...DEFAULT_CATALOG_BUDGET, ...defined(fallback) };
  return { ...base, ...defined(configured ?? {}) };
}

/** What a network does with an MCP tool under an `mcp://` URL, which has no origin to verify. */
export type OriginlessMcpPolicy = "publish" | "refuse";

/** A network's cataloging rules beyond its budget. */
export interface CatalogRules {
  /**
   * `publish` lists such a tool at trust `settled` from its settlement alone; `refuse` rejects it with
   * `bazaar_resource_unverifiable`. Pubnet always refuses: its listings reach buyers paying real money.
   */
  readonly originlessMcp: OriginlessMcpPolicy;
  /**
   * The smallest settled amount, in base units, per asset contract, that catalogs a resource; assets
   * not listed have no minimum. Off by default.
   */
  readonly minSettled: Readonly<Record<string, bigint>>;
}

/** A network's catalog policy: its budget and its rules. */
export type NetworkCatalogPolicy = CatalogBudget & CatalogRules;

/**
 * The rules a network catalogs under: its own settings over the defaults (`publish` everywhere but
 * pubnet, no minimums). Pubnet refuses originless tools whatever is configured.
 */
export function catalogRulesFor(
  network: string,
  configured: Partial<CatalogRules> | undefined,
): CatalogRules {
  const rules: CatalogRules = {
    originlessMcp: network === PUBNET ? "refuse" : "publish",
    minSettled: {},
    ...defined(configured ?? {}),
  };
  return network === PUBNET ? { ...rules, originlessMcp: "refuse" } : rules;
}

function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}
