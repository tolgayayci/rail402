import { createHash } from "node:crypto";
import type { SettledPayment } from "./extract.ts";
import type {
  ListFilter,
  Listing,
  ListingContent,
  ListingIdentity,
  ListingVersion,
  OriginCheck,
  OriginCheckReason,
  ResourceListings,
} from "./types.ts";

/** A settlement observed against a listing. Unique per transaction: duplicates change nothing. */
export interface Observation {
  readonly transaction: string;
  readonly payer: string;
  readonly asset: string;
  readonly amount: string;
  readonly observedAt: Date;
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
  /** Listings first cataloged for `owner` since `since`, not counting those the origin check withdrew. */
  countCreatedBy(owner: string, since: Date): Promise<number>;
  /** Listings created by settlements from `payer` since `since`. */
  countCreatedByPayer(payer: string, since: Date): Promise<number>;
  /** Listings created since `since`, by anyone. */
  countCreatedSince(since: Date): Promise<number>;
  /** Inserts a new listing; the store assigns its `sequence`. */
  insert(listing: Listing, version: ListingVersion): Promise<void>;
  /** Replaces the listing row; appends `version` when the published record changed. */
  update(listing: Listing, version?: ListingVersion): Promise<void>;
  requestOriginCheck(
    listingId: string,
    reason: OriginCheckReason,
    url: string,
    proposedOwner?: string,
  ): Promise<void>;
}

export interface CatalogStore {
  /**
   * Runs `work` with exclusive access to the listing that has (or would have) `identity`. For origin
   * checks, pass the listing id instead. Concurrent transactions for one listing are serialised.
   */
  transaction<T>(key: ListingIdentity | string, work: (tx: CatalogTransaction) => Promise<T>): Promise<T>;
  get(id: string): Promise<Listing | undefined>;
  /**
   * Published resources matching `filter`, in stable catalog order, and how many match in total. A
   * resource holds its matching listings, one per network, each narrowed to its matching payment
   * options; it is ordered by the first of them to be published.
   */
  list(filter: ListFilter): Promise<{ items: ResourceListings[]; total: number }>;
  versions(id: string): Promise<ListingVersion[]>;
  /** Every published listing in catalog order, and the revision they are at, read together. */
  published(): Promise<{ revision: number; listings: Listing[] }>;
  /** Published listings whose Stellar facts are missing or were checked before `before`, oldest first. */
  staleFacts(limit: number, before: Date): Promise<Listing[]>;
  /** Monotonic counter bumped by every catalog change; search indexes rebuild when it moves. */
  revision(): Promise<number>;
  /** Origin checks due now and not claimed by a worker, oldest first. Reads only. */
  dueOriginChecks(limit: number): Promise<OriginCheck[]>;
  /**
   * Claims up to `limit` due, unclaimed origin checks for `leaseMs`, oldest first. No other worker, on
   * any replica, can claim them until the lease ends or the check is deferred or completed.
   */
  claimOriginChecks(limit: number, leaseMs: number): Promise<OriginCheck[]>;
  /** Schedules the next attempt of a claimed check, unless it was requested again since the claim. */
  deferOriginCheck(check: OriginCheck, delayMs: number): Promise<void>;
  /** Removes a claimed check, unless it was requested again since the claim. */
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
