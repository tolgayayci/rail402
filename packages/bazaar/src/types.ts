export type ResourceKind = "http" | "mcp";

/** How far a listing's content is trusted. */
export type Trust =
  /** Created from a settled payment; its metadata was echoed by the buyer. */
  | "settled"
  /** Confirmed against the resource's own 402 response. */
  | "origin_verified"
  /** Also claimed by its domain: the resource host's SEP-1 stellar.toml lists the owner in ACCOUNTS. */
  | "domain_verified";

/** What the network says about one payment option of a listing. Unknown facts are left out. */
export interface OptionFacts {
  readonly symbol?: string;
  readonly name?: string;
  readonly decimals?: number;
  /** Whether payTo can receive the asset now (trustline, issuer or contract account). */
  readonly receivable?: boolean;
}

/** Stellar facts about a published listing, refreshed in the background; not versioned content. */
export interface ListingFacts {
  readonly checkedAt: Date;
  /** One entry per payment option, in the order of `accepts`. */
  readonly options: readonly OptionFacts[];
  /** The resource host and whether its stellar.toml lists the owner. */
  readonly domain?: { readonly host: string; readonly claimsOwner: boolean };
}

/** A payment option as published in `accepts`: a PaymentRequirements object. */
export interface PaymentOption {
  readonly scheme: string;
  readonly network: string;
  readonly asset: string;
  readonly payTo: string;
  readonly amount: string;
  readonly maxTimeoutSeconds: number;
  readonly extra: Readonly<Record<string, unknown>>;
}

/** The validated bazaar extension, stored and republished under `extensions.bazaar`. */
export interface BazaarDescriptor {
  readonly info: Readonly<Record<string, unknown>>;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly routeTemplate?: string;
}

/** Everything a listing publishes. Changes to it create a new public version. */
export interface ListingContent {
  readonly resource: string;
  readonly kind: ResourceKind;
  readonly method?: string;
  readonly toolName?: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly serviceName?: string;
  readonly tags?: readonly string[];
  readonly iconUrl?: string;
  /** Other x402 extensions the resource declares in its 402 response, by key, sorted; never `bazaar`. */
  readonly extensions?: readonly string[];
  readonly bazaar: BazaarDescriptor;
  readonly accepts: readonly PaymentOption[];
}

/**
 * What makes two catalog entries the same listing. HTTP resources are keyed on
 * (network, canonical URL, method); MCP tools on (network, resource URL, tool name). An `mcp://`
 * URL is not globally unique, so such tools are additionally scoped to their owner.
 *
 * A listing exists per network, because a settlement proves a payTo on its own network only.
 * Discovery shows the listings of one resource on several networks as one resource.
 */
export interface ListingIdentity {
  readonly network: string;
  readonly kind: ResourceKind;
  readonly resource: string;
  readonly method: string;
  readonly toolName: string;
  /** Owner scope for identities that are not globally unique; empty otherwise. */
  readonly scope: string;
}

/** A settled payment that carried a valid bazaar extension. */
export interface Candidate {
  readonly identity: ListingIdentity;
  /** The concrete URL that was paid for (query and fragment removed); origin checks fetch it. */
  readonly concreteUrl: string;
  /** The account proven by settlement: the base G… or C… account of `payTo`. */
  readonly owner: string;
  readonly payer: string;
  readonly transaction: string;
  readonly content: ListingContent;
  /** Service-metadata fields dropped by the soft-drop rules. */
  readonly dropped: readonly string[];
}

/**
 * `pending`: an HTTP listing created by a settlement, not yet confirmed by its resource's own 402;
 * `published`: listed by discovery and search; `quarantined`: withdrawn, kept with its history.
 */
export type ListingState = "pending" | "published" | "quarantined";

export interface Listing {
  readonly id: string;
  /** Position in the catalog, assigned by the store on insert; defines the stable listing order. */
  readonly sequence: number;
  readonly identity: ListingIdentity;
  readonly owner: string;
  readonly trust: Trust;
  readonly state: ListingState;
  readonly version: number;
  readonly content: ListingContent;
  readonly contentHash: string;
  readonly firstCatalogedAt: Date;
  /** When the listing was first published; undefined while it has never been. Orders discovery. */
  readonly listedAt?: Date;
  /** Stellar facts; absent until first checked. */
  readonly facts?: ListingFacts;
  readonly lastUpdated: Date;
  readonly lastSettledAt: Date;
  readonly settlements: number;
}

/**
 * One resource as discovery shows it: its published listings, one per network, in catalog order.
 * Each keeps its own owner, trust and history; together they offer every network's payment options.
 */
export type ResourceListings = readonly [Listing, ...Listing[]];

export type VersionCause =
  "settlement" | "origin_verification" | "ownership_transfer" | "quarantine" | "domain_verification";

/** Why a listing's origin must be (re)checked. */
export type OriginCheckReason = "created" | "changed" | "owner_conflict";

export interface OriginCheck {
  readonly listingId: string;
  readonly reason: OriginCheckReason;
  /** The concrete URL to fetch. */
  readonly url: string;
  /** A different payTo that settled for this listing and claims it. */
  readonly proposedOwner?: string;
  readonly attempts: number;
  /** Changes with every request: a check re-requested during a fetch outlives that fetch. */
  readonly requestId: string;
}

export interface ListingVersion {
  readonly listingId: string;
  readonly version: number;
  readonly createdAt: Date;
  readonly cause: VersionCause;
  /** Settlement that caused this version, when there was one. */
  readonly transaction?: string;
  readonly owner: string;
  readonly trust: Trust;
  readonly state: ListingState;
  readonly content: ListingContent;
}

/** Filters of GET /discovery/resources and /discovery/search. */
export interface ListFilter {
  /** Resource type, e.g. "http" or "mcp"; unknown values match nothing. */
  readonly type?: string;
  readonly payTo?: string;
  readonly scheme?: string;
  readonly network?: string;
  /** Extension keys every returned resource must declare. */
  readonly extensions?: readonly string[];
  readonly limit: number;
  readonly offset: number;
  /** Only listings first published at or before this time: pins a pagination against new listings. */
  readonly asOf?: Date;
}
