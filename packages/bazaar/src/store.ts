import { createHash } from "node:crypto";
import type { QuarantineReason } from "./codes.ts";
import type { SettledPayment } from "./extract.ts";
import type {
  CheckCandidate,
  ListFilter,
  Listing,
  ListingContent,
  ListingIdentity,
  ListingState,
  ListingVersion,
  OriginCheck,
  OriginCheckReason,
  ResourceListings,
  SettledOption,
  ToolCallProposal,
} from "./types.ts";

/** A settlement observed against a listing. Unique per transaction: duplicates change nothing. */
export interface Observation {
  /** The hash of the transaction that settled the payment on chain (the fee bump's, when sponsored). */
  readonly transaction: string;
  readonly payer: string;
  /** The account the settlement paid: the base G… or C… account of its `payTo`. */
  readonly payTo: string;
  readonly asset: string;
  /** The amount settled, in base units: for `upto`, what was charged, not the cap. */
  readonly amount: string;
  readonly observedAt: Date;
}

/**
 * The extension key a seller declares in its 402 response to keep a listing's usage private: the
 * listing stays in discovery, but the usage routes never link settlements to it.
 */
export const PRIVATE_USAGE_EXTENSION = "rail402-private-usage";

/** Most settlement transactions one usage lookup resolves. */
export const MAX_USAGE_TRANSACTIONS = 100;
/** Most recent settlements a listing's usage shows. */
export const MAX_RECENT_OBSERVATIONS = 20;
/** Most listings a seller's usage shows; its totals still count every listing. */
export const MAX_SELLER_USAGE_LISTINGS = 100;

/** Whether listing content declares `PRIVATE_USAGE_EXTENSION`. */
export function declaresPrivateUsage(content: ListingContent): boolean {
  return (content.extensions ?? []).includes(PRIVATE_USAGE_EXTENSION);
}

/** `content` with `PRIVATE_USAGE_EXTENSION` among its extension keys. */
export function withPrivateUsage(content: ListingContent): ListingContent {
  return {
    ...content,
    extensions: [...new Set([...(content.extensions ?? []), PRIVATE_USAGE_EXTENSION])].sort(),
  };
}

/**
 * Whether a listing's usage on `network` may be published: it is published, it is that network's
 * listing, an origin confirmed its content (trust above `settled`), and it does not declare
 * `PRIVATE_USAGE_EXTENSION`. A listing no origin ever confirmed, such as a tool under an `mcp://`
 * URL, holds whatever its first payer echoed, so its seller's choice is unknown and its usage stays
 * private. A settlement counts toward it only when it paid the listing's current owner (see
 * `Observation.payTo`).
 */
export function usageVisible(listing: Listing, network: string): boolean {
  return listing.state === "published" && listing.identity.network === network && !usagePrivate(listing);
}

/**
 * Whether a listing's usage is private whatever the network publishes: it declares
 * `PRIVATE_USAGE_EXTENSION`, or no origin confirmed its content (trust `settled`). Such a listing's
 * other routes leave out what would date or link its settlements: its `lastSettled` and the
 * transactions of its versions.
 */
export function usagePrivate(listing: Listing): boolean {
  return listing.trust === "settled" || declaresPrivateUsage(listing.content);
}

/**
 * The listings an hourly quota counts, and when the earliest of them was counted (undefined when it
 * counts none): the quota has room again once that one leaves the hour.
 */
export interface QuotaCount {
  readonly count: number;
  readonly earliest?: Date;
}

/** A settlement linked to the listing it paid for. */
export interface SettlementLink {
  readonly listing: Listing;
  readonly observation: Observation;
}

/** How a listing was paid for: settlements that paid its current owner. */
export interface ListingUsage {
  readonly payments: number;
  /** Distinct payers. */
  readonly payers: number;
  readonly firstObservedAt?: Date;
  readonly lastObservedAt?: Date;
  /** The latest settlements, newest first, at most the `recent` asked for. */
  readonly recent: readonly Observation[];
}

/** How a seller's listings on one network were paid for. */
export interface SellerUsage {
  /** Settlements and distinct payers across every listing of the seller, not only those shown. */
  readonly payments: number;
  readonly payers: number;
  /** The listings, most recently paid first, at most the `limit` asked for. */
  readonly listings: readonly {
    readonly listing: Listing;
    readonly payments: number;
    readonly payers: number;
    readonly lastObservedAt?: Date;
  }[];
  /** Whether the seller has more listings than `listings` shows. */
  readonly truncated: boolean;
}

/** Operations available inside one exclusive catalog transaction. */
export interface CatalogTransaction {
  find(identity: ListingIdentity): Promise<Listing | undefined>;
  get(id: string): Promise<Listing | undefined>;
  /**
   * Records a settlement against a listing. `seen` means this listing already observed it;
   * `elsewhere` means another listing did: one settlement catalogs at most one resource.
   */
  observe(listingId: string, observation: Observation): Promise<"new" | "seen" | "elsewhere">;
  /** The listing a settlement transaction was already observed against, if any. */
  observedListing(transaction: string): Promise<string | undefined>;
  /**
   * Listings on `network` owned by `owner` now, whose resource is served from `origin`
   * (`resourceOrigin(identity.resource) === origin`), that are published with trust above `settled`
   * and were charged to the owner's quota (`quotaChargedAt`) since `since`. Pending and withdrawn
   * listings, which any payer can create for any payTo, unverifiable `mcp://` listings, listings no
   * settlement paid the origin's price for and listings handed over to the owner do not count; nor do
   * listings at other origins, since any host can answer a 402 naming any payTo. The count holds until
   * the transaction ends: another transaction counting the same owner, network and origin waits for
   * it, so a listing charged on the count never takes a place another one took meanwhile. `earliest`
   * is the earliest `quotaChargedAt` counted.
   */
  countCreatedBy(owner: string, network: string, origin: string, since: Date): Promise<QuotaCount>;
  /** Listings on `network` created by settlements from `payer` since `since`. */
  countCreatedByPayer(payer: string, network: string, since: Date): Promise<number>;
  /**
   * Listings on `network` first published (`listedAt`) since `since`, by anyone, whatever their state
   * now: those no origin confirmed (trust `settled`) when `unverified`, the others otherwise. A listing
   * counts once, in the hour it was first published, however long it waited before; listings never
   * published, which any payer can create for any payTo, do not count. The count holds until the
   * transaction ends: another transaction counting the same network and trust waits for it, so a
   * listing published on the count never takes a place another one took meanwhile. `earliest` is the
   * earliest `listedAt` counted.
   */
  countListedSince(network: string, since: Date, unverified: boolean): Promise<QuotaCount>;
  /**
   * Listings published on `network` now: those no origin confirmed (trust `settled`) when
   * `unverified`, the others otherwise.
   */
  countPublished(network: string, unverified: boolean): Promise<number>;
  /** Listings an origin confirmed (trust other than `settled`) published on `network` now for `owner`. */
  countPublishedBy(network: string, owner: string): Promise<number>;
  /** The reason recorded on the listing's latest version: why it was withdrawn, if that version did. */
  latestReason(listingId: string): Promise<QuarantineReason | undefined>;
  /** Inserts a new listing; the store assigns its `sequence`. */
  insert(listing: Listing, version: ListingVersion): Promise<void>;
  /** Replaces the listing row; appends `version` when the published record changed. */
  update(listing: Listing, version?: ListingVersion): Promise<void>;
  /** Deletes a listing with its versions, options, observations and origin check. */
  remove(listingId: string): Promise<void>;
  /**
   * Requests an origin check. An `owner_conflict` request adds `proposedOwner` to the check's claimants
   * (at most MAX_PROPOSED_OWNERS) and never resets the attempts, URL or payment of a check already
   * requested; a check whose claimants did not change is left as it is. The requests of settlements
   * that paid the owner (`created`, `changed`) add their URL, settled payment and proposed call to the
   * check's candidates (`mergeCandidates`), keeping its claimants and its retry count. Such a request
   * makes a check due at once when the check is new, was never attempted and is not running, or is for
   * a listing not yet published (its `requestId` then changes), keeping the time of its scheduled retry
   * (`early`); otherwise the check keeps its due time, claim and `requestId`, so a run in flight still
   * schedules its next attempt. Its `url`, `settled` and `probe` become the request's, except that a check weighing claims
   * keeps its URL.
   */
  requestOriginCheck(
    listingId: string,
    reason: OriginCheckReason,
    url: string,
    proposedOwner?: string,
    settled?: SettledOption,
    probe?: ToolCallProposal,
  ): Promise<void>;
}

/**
 * The pattern of a resource URL's origin: its scheme and authority, everything before its path. A store
 * that counts listings by origin in its own query language uses this pattern, so it groups listings
 * exactly as `resourceOrigin` does.
 */
export const RESOURCE_ORIGIN_PATTERN = "^[^/:]+://[^/]*";

const RESOURCE_ORIGIN = new RegExp(RESOURCE_ORIGIN_PATTERN);

/**
 * The origin a listing's resource is served from, such as `https://api.example.com:8443`: the only
 * server whose 402 can confirm the listing. A resource without one is its own origin.
 */
export function resourceOrigin(resource: string): string {
  return RESOURCE_ORIGIN.exec(resource)?.[0] ?? resource;
}

/** Candidates an origin check keeps at most for one asset, and in all. */
export const MAX_CHECK_CANDIDATES_PER_ASSET = 4;
export const MAX_CHECK_CANDIDATES = 8;

/** What a candidate's settlement moved, in base units of its asset (0 when unknown). */
function candidatePaid(candidate: CheckCandidate): bigint {
  const moved = candidate.settled?.settledAmount;
  return moved !== undefined && /^\d{1,39}$/.test(moved) ? BigInt(moved) : 0n;
}

/** A candidate's path, payment and call, without how a run found it. */
function candidateKey(candidate: CheckCandidate): string {
  const { asked: _asked, ...rest } = candidate;
  return canonicalJson(rest);
}

/**
 * A check's candidates with `incoming` added at the end: one with the same path, payment and call
 * moves there, and how a run found it is cleared, so it is asked again. Each asset keeps its
 * `MAX_CHECK_CANDIDATES_PER_ASSET` largest payments, the earliest of equal ones leaving first, and the
 * check keeps its `MAX_CHECK_CANDIDATES` latest: a smaller payment never removes a larger one in its
 * asset, and payments in other assets made before a buyer's never remove it.
 */
export function mergeCandidates(
  existing: readonly CheckCandidate[],
  incoming: CheckCandidate,
): CheckCandidate[] {
  const key = candidateKey(incoming);
  const { asked: _asked, ...fresh } = incoming;
  const merged = [...existing.filter((candidate) => candidateKey(candidate) !== key), fresh];
  const asset = incoming.settled?.asset ?? "";
  for (;;) {
    const same = merged.filter((candidate) => (candidate.settled?.asset ?? "") === asset);
    if (same.length <= MAX_CHECK_CANDIDATES_PER_ASSET) break;
    const smallest = same.reduce((least, candidate) =>
      candidatePaid(candidate) < candidatePaid(least) ? candidate : least,
    );
    merged.splice(merged.indexOf(smallest), 1);
  }
  return merged.slice(-MAX_CHECK_CANDIDATES);
}

/**
 * `candidates` with how a run found each of `asked` (matched by path, payment and call) recorded on it;
 * the others are kept as they are.
 */
export function markCandidates(
  candidates: readonly CheckCandidate[],
  asked: readonly CheckCandidate[],
): CheckCandidate[] {
  const found = new Map(asked.map((candidate) => [candidateKey(candidate), candidate.asked]));
  return candidates.map((candidate) => {
    const outcome = found.get(candidateKey(candidate));
    return outcome === undefined ? candidate : { ...candidate, asked: outcome };
  });
}

/**
 * The order a run of a check asks its candidates in: those no run of it asked yet, then those whose
 * answer was a passing error, then those whose answer listed it for a payment below its price; within
 * each, larger payments first and earlier ones among equal payments. Candidates an earlier run found
 * refused are left out: they are not asked again while it is open.
 */
export function askingOrder(candidates: readonly CheckCandidate[]): CheckCandidate[] {
  const rank = ({ asked }: CheckCandidate) => (asked === undefined ? 0 : "failed" in asked ? 1 : 2);
  return candidates
    .filter((candidate) => candidate.asked === undefined || !("refused" in candidate.asked))
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => {
      const paid = candidatePaid(b.candidate) - candidatePaid(a.candidate);
      return rank(a.candidate) - rank(b.candidate) || (paid > 0n ? 1 : paid < 0n ? -1 : a.index - b.index);
    })
    .map(({ candidate }) => candidate);
}

/**
 * A check's candidates: those its requests added or, for a check requested before candidates were
 * kept, its own URL, payment and call (a claim's check too, when its owner's settlement joined it). A
 * check only claims requested has none.
 */
export function checkCandidates(
  check: Pick<OriginCheck, "reason" | "url" | "settled" | "probe" | "candidates">,
): readonly CheckCandidate[] {
  if (check.candidates !== undefined && check.candidates.length > 0) return check.candidates;
  if (check.reason === "owner_conflict" && check.settled === undefined) return [];
  return [
    {
      url: check.url,
      ...(check.settled === undefined ? {} : { settled: check.settled }),
      ...(check.probe === undefined ? {} : { probe: check.probe }),
    },
  ];
}

/** Claimants an origin check keeps at most; later ones wait until a check ran with these. */
export const MAX_PROPOSED_OWNERS = 32;

/**
 * How soon a new claimant's check runs at the latest when a check is already scheduled later (a retry
 * after an unreachable origin): a claim never makes an origin be asked again at once.
 */
export const OWNER_CLAIM_DELAY_MS = 60_000;

/**
 * Whether a published listing is past its retention: its last settlement is older than `idleBefore`
 * (when given), or, for a listing no origin ever confirmed, older than `unverifiedBefore`.
 */
export function expired(listing: Listing, unverifiedBefore: Date, idleBefore: Date | undefined): boolean {
  const last = listing.lastSettledAt.getTime();
  return (
    (listing.trust === "settled" && last < unverifiedBefore.getTime()) ||
    (idleBefore !== undefined && last < idleBefore.getTime())
  );
}

/**
 * Whether a listing was never published and is withdrawn, last updated before `before`: its content,
 * echoed by a payer and never confirmed by its origin, was never public, so nothing needs to keep it.
 */
export function abandoned(listing: Listing, before: Date): boolean {
  return (
    listing.state === "quarantined" &&
    listing.listedAt === undefined &&
    listing.lastUpdated.getTime() < before.getTime()
  );
}

/** A page of a listing's version history: the versions after `after`, at most `limit`. */
export interface VersionPage {
  readonly after?: number;
  readonly limit: number;
}

export interface CatalogStore {
  /**
   * Runs `work` with exclusive access to the listing that has (or would have) `identity`. For origin
   * checks, pass the listing id instead. Concurrent transactions for one listing are serialised.
   */
  transaction<T>(key: ListingIdentity | string, work: (tx: CatalogTransaction) => Promise<T>): Promise<T>;
  get(id: string): Promise<Listing | undefined>;
  /** The listings with these ids as they are now, in any order; unknown ids are left out. */
  getMany(ids: readonly string[]): Promise<Listing[]>;
  /**
   * Published resources matching `filter`, in stable catalog order, and how many match in total. A
   * resource holds its matching listings, one per network, each narrowed to its matching payment
   * options; it is ordered by the first of them to be published.
   */
  list(filter: ListFilter): Promise<{ items: ResourceListings[]; total: number }>;
  /**
   * A listing's versions, oldest first. With `page`, only those after version `after` (default 0), at
   * most `limit` of them; a store bounds how long such a read may take.
   */
  versions(id: string, page?: VersionPage): Promise<ListingVersion[]>;
  /** Every published listing in catalog order, and the revision they are at, read together. */
  published(): Promise<{ revision: number; listings: Listing[] }>;
  /**
   * Reads every published listing in catalog order, at most `batchSize` at a time, hands each batch to
   * `visit` as it is read, and returns the revision they are at, read together. Only what `visit`
   * keeps stays in memory, so a reader can index a catalog without holding all of its content at
   * once. A store bounds how long each read may take.
   */
  scanPublished(visit: (batch: readonly Listing[]) => void, batchSize?: number): Promise<number>;
  /**
   * Published listings whose Stellar facts are missing or were checked before `before`, oldest first,
   * of the listings on `network` when given.
   */
  staleFacts(limit: number, before: Date, network?: string): Promise<Listing[]>;
  /** The networks with published listings whose facts are missing or were checked before `before`. */
  staleFactsNetworks(before: Date): Promise<string[]>;
  /** The networks with published listings. */
  publishedNetworks(): Promise<string[]>;
  /**
   * Up to `limit` listings never published (no `listedAt`) that are withdrawn and were last updated
   * before `before`, oldest first.
   */
  abandonedListings(before: Date, limit: number): Promise<Listing[]>;
  /**
   * Up to `limit` published listings on `network` whose last settlement is older than `idleBefore`
   * (when given), or, at trust `settled`, older than `unverifiedBefore`.
   */
  expiredListings(
    network: string,
    unverifiedBefore: Date,
    idleBefore: Date | undefined,
    limit: number,
  ): Promise<Listing[]>;
  /** Monotonic counter bumped by every catalog change; search indexes rebuild when it moves. */
  revision(): Promise<number>;
  /**
   * Origin checks due now and not claimed by a worker, oldest first, of the listings on `network` when
   * given. Reads only.
   */
  dueOriginChecks(limit: number, network?: string): Promise<OriginCheck[]>;
  /**
   * Claims up to `limit` due, unclaimed origin checks for `leaseMs`, oldest first, of the listings on
   * `network` when given. No other worker, on any replica, can claim them until the lease ends or the
   * check is deferred or completed.
   */
  claimOriginChecks(limit: number, leaseMs: number, network?: string): Promise<OriginCheck[]>;
  /** The networks whose listings have origin checks due now and not claimed by a worker. */
  originCheckNetworks(): Promise<string[]>;
  /**
   * Schedules the next attempt of a claimed check, unless it was requested again since the claim, and
   * records on its candidates how this run found those in `asked` (`markCandidates`). With `spend`
   * false the check only waits: its attempts stay as they are. A check a request made due before its
   * scheduled retry (`early`) spends none either: it waits for that retry instead of `delayMs`.
   */
  deferOriginCheck(
    check: OriginCheck,
    delayMs: number,
    spend?: boolean,
    asked?: readonly CheckCandidate[],
  ): Promise<void>;
  /**
   * Removes a claimed check, unless it was requested again since the claim. When a request that kept
   * its claim added a candidate meanwhile, the check is due again at once instead, as a new check: no
   * attempts, and no candidate found yet.
   */
  completeOriginCheck(check: OriginCheck): Promise<void>;
  /**
   * Keeps a settled payment until it is cataloged; a worker may take it once `graceMs` passed. Queuing
   * the same settlement twice keeps one entry.
   */
  enqueueSettlement(payment: SettledPayment, graceMs: number): Promise<void>;
  /** Claims up to `limit` queued settlements that are due, for `leaseMs`, oldest first. */
  claimSettlements(limit: number, leaseMs: number): Promise<QueuedSettlement[]>;
  /** Schedules another attempt of a queued settlement. */
  deferSettlement(transaction: string, delayMs: number): Promise<void>;
  /** Removes a settlement that reached a cataloging outcome. */
  completeSettlement(transaction: string): Promise<void>;
  /** How many listings are in each state, and how many settlements wait to be cataloged. */
  stats(): Promise<CatalogStats>;
  /**
   * The settlements among `transactions` linked to a listing whose usage is visible on `network`
   * (`usageVisible`) and that paid its current owner, in any order; others are left out. A store
   * bounds how long the read may take.
   */
  settlementLinks(network: string, transactions: readonly string[]): Promise<SettlementLink[]>;
  /**
   * The usage of `listing`: the settlements observed against it that paid its current owner, with
   * the `recent` latest of them. The caller decides whether the listing's usage may be shown.
   */
  listingUsage(listing: Listing, recent: number): Promise<ListingUsage>;
  /**
   * The usage of the listings on `network` owned by the base account `owner` whose usage is visible
   * there, counting the settlements that paid `owner`; at most `limit` listings, most recently paid
   * first, with totals over all of them.
   */
  sellerUsage(owner: string, network: string, limit: number): Promise<SellerUsage>;
}

/** A catalog's size, for monitoring. */
export interface CatalogStats {
  readonly listings: Readonly<Record<ListingState, number>>;
  /** Settled payments queued and not yet cataloged, due or not. */
  readonly queuedSettlements: number;
}

/** A settled payment waiting to be cataloged. */
export interface QueuedSettlement {
  readonly payment: SettledPayment;
  readonly attempts: number;
}

/** Stable key of an identity, for maps and locks. */
export function identityKey(identity: ListingIdentity): string {
  return [
    identity.network,
    identity.kind,
    identity.resource,
    identity.method,
    identity.toolName,
    identity.scope,
  ].join("\u0000");
}

/** Stable key of the resource an identity belongs to: the identity without its network. */
export function resourceKey(identity: ListingIdentity): string {
  return [identity.kind, identity.resource, identity.method, identity.toolName, identity.scope].join(
    "\u0000",
  );
}

/** SHA-256 of the published content, with object keys sorted so equal content hashes equally. */
export function contentHash(content: ListingContent): string {
  return createHash("sha256").update(canonicalJson(content)).digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
