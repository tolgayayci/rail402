import type { QuarantineReason } from "./codes.ts";

export type ResourceKind = "http" | "mcp";

/** How far a listing's content is trusted. */
export type Trust =
  /** Created from a settled payment; its metadata was echoed by the buyer. */
  | "settled"
  /** Confirmed against the resource's own 402 response (an MCP tool's unpaid call). */
  | "origin_verified"
  /**
   * Origin-verified and also claimed by its domain both ways (SEP-1): the resource host's stellar.toml
   * lists the owner in ACCOUNTS, and the owner's account sets that host as its home_domain.
   */
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
  /** The resource host's SEP-1 claim of the owner. */
  readonly domain?: DomainClaim;
}

/**
 * Whether a resource host and a listing's owner name each other under SEP-1. Only both together (the
 * two-way binding) raise an origin-verified listing to `domain_verified`.
 */
export interface DomainClaim {
  readonly host: string;
  /** The host's stellar.toml lists the owner in ACCOUNTS. */
  readonly claimsOwner: boolean;
  /** The owner's account sets the host as its home_domain on a network the listing is paid on. */
  readonly homeDomainMatches: boolean;
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
 * `pending`: an HTTP listing, or an MCP tool at an http(s) endpoint, created by a settlement and not
 * yet confirmed by its resource's own 402;
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
  /**
   * From when the listing counts toward its owner's hourly quota of new listings at its origin: its
   * first publication, once its origin confirmed a settlement that paid the owner the price there.
   * Undefined while none did, and again after an ownership transfer: dust settlements and listings
   * handed over never use up a payTo's quota.
   */
  readonly quotaChargedAt?: Date;
  /**
   * The path of the listing's route template its origin confirmed, spelled as it was asked: the path of
   * the check that listed it, whose parameters are the template's example (`info.input.pathParams`).
   * Absent for an example kept from before examples were confirmed: that example is checked all the
   * same, but never withdraws or rewrites the listing until its own answer lists it.
   */
  readonly confirmedExample?: string;
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

/**
 * How the settlement that requested an MCP origin check proposes to call the tool unpaid: the
 * `info.input.example` arguments and `transport` its payload declared.
 */
export interface ToolCallProposal {
  readonly arguments?: Readonly<Record<string, unknown>>;
  readonly transport?: string;
}

/** The payment option a settlement paid, as its listing publishes it, and the amount it moved. */
export interface SettledOption extends PaymentOption {
  /**
   * The amount the settlement moved, in base units: for `upto`, what it charged, never more than the
   * cap in `amount`. Absent on checks requested before it was recorded.
   */
  readonly settledAmount?: string;
}

export interface OriginCheck {
  readonly listingId: string;
  readonly reason: OriginCheckReason;
  /** The concrete URL to fetch. */
  readonly url: string;
  /**
   * Different payTos that settled for this listing and claim it, in the order they first did. A claim
   * is kept until a check ran with it; one claimant never replaces another's claim.
   */
  readonly proposedOwners?: readonly string[];
  /**
   * The payment option of the settlement that requested the check. An MCP tool whose content its
   * origin never confirmed is published only if its origin offers this option.
   */
  readonly settled?: SettledOption;
  /**
   * For an MCP tool, the unpaid call the owner's settlement proposed. The check calls the tool as its
   * listing describes first and tries this call only when that one is not answered with a 402 (for a
   * published tool, not while it fails for now), taking only a 402 that names the owner: a tool whose
   * arguments changed since it was listed is still confirmed, and a payload's arguments can never fail
   * the check of a tool, nor decide one whose listed call fails for now.
   */
  readonly probe?: ToolCallProposal;
  /**
   * The paths settlements that paid the owner asked the check to try, each with its payment and
   * proposed call, in the order they came (see `mergeCandidates`). A listing not yet listed is listed
   * from one of them; `url`, `settled` and `probe` are the latest's.
   */
  readonly candidates?: readonly CheckCandidate[];
  readonly attempts: number;
  /**
   * Whether a request made it due before its scheduled retry: a passing error then waits for that
   * retry and spends none (see `deferOriginCheck`), so only scheduled runs use up the retry schedule.
   */
  readonly early?: boolean;
  /** Changes with every request: a check re-requested during a fetch outlives that fetch. */
  readonly requestId: string;
}

/** A path a settlement that paid a listing's owner asked its origin check to try. */
export interface CheckCandidate {
  readonly url: string;
  /** The payment option the settlement paid, and what it moved. */
  readonly settled?: SettledOption;
  /** For an MCP tool, the unpaid call the settlement proposed. */
  readonly probe?: ToolCallProposal;
  /**
   * How an earlier run of the open check found it: `refused` when its answer (for an MCP tool, its
   * proposed call's) did not list the listing, and it is not asked again; `failed` when that answer
   * was a passing error, and `underpaid` when it listed the listing for a payment below its price:
   * such candidates are asked after those no run asked yet.
   */
  readonly asked?: CandidateOutcome;
}

/** How a run of an origin check found a candidate. */
export type CandidateOutcome =
  { readonly refused: QuarantineReason } | { readonly failed: true } | { readonly underpaid: true };

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
  /** Why the origin check quarantined the listing, on `quarantine` versions. */
  readonly reason?: QuarantineReason;
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
