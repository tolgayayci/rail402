import { randomUUID } from "node:crypto";
import { catalogOrder, groupByResource, matchesFilter, narrowOptions, optionMatches } from "./filter.ts";
import type { SettledPayment } from "./extract.ts";
import {
  identityKey,
  type CatalogStore,
  type CatalogTransaction,
  type Observation,
  type QueuedSettlement,
} from "./store.ts";
import type {
  ListFilter,
  Listing,
  ListingIdentity,
  ListingVersion,
  OriginCheck,
  OriginCheckReason,
  ResourceListings,
} from "./types.ts";

interface ScheduledCheck {
  check: OriginCheck;
  dueAt: number;
  claimedUntil?: number;
}

/** Process-local catalog store, for tests and single-process development. */
export class MemoryCatalogStore implements CatalogStore {
  private readonly listings = new Map<string, Listing>();
  private readonly byIdentity = new Map<string, string>();
  private readonly history = new Map<string, ListingVersion[]>();
  /** Settlement transaction → the listing it cataloged and its payer. */
  private readonly observations = new Map<string, { listingId: string; payer: string }>();
  private readonly checks = new Map<string, ScheduledCheck>();
  private readonly outbox = new Map<
    string,
    { payment: SettledPayment; attempts: number; dueAt: number; claimedUntil: number }
  >();
  private readonly locks = new Map<string, Promise<unknown>>();
  private counter = 0;
  private sequence = 0;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  async transaction<T>(
    key: ListingIdentity | string,
    work: (tx: CatalogTransaction) => Promise<T>,
  ): Promise<T> {
    // Settlements address a listing by identity, origin checks by id: both lock the identity.
    const lock =
      typeof key === "string"
        ? identityKey(this.listings.get(key)?.identity ?? unknownIdentity(key))
        : identityKey(key);
    const previous = this.locks.get(lock) ?? Promise.resolve();
    const run = previous.then(() => work(this.tx()));
    const settled = run.catch(() => undefined);
    this.locks.set(lock, settled);
    try {
      return await run;
    } finally {
      if (this.locks.get(lock) === settled) this.locks.delete(lock);
    }
  }

  get(id: string): Promise<Listing | undefined> {
    return Promise.resolve(this.listings.get(id));
  }

  list(filter: ListFilter): Promise<{ items: ResourceListings[]; total: number }> {
    const matching = [...this.listings.values()]
      .filter(
        (listing) =>
          listing.state === "published" &&
          (filter.asOf === undefined || (listing.listedAt?.getTime() ?? 0) <= filter.asOf.getTime()) &&
          matchesFilter(listing, filter),
      )
      .sort(catalogOrder)
      .map((listing) => narrowOptions(listing, (option) => optionMatches(option, filter)));
    const resources = groupByResource(matching);
    return Promise.resolve({
      items: resources.slice(filter.offset, filter.offset + filter.limit),
      total: resources.length,
    });
  }

  versions(id: string): Promise<ListingVersion[]> {
    return Promise.resolve([...(this.history.get(id) ?? [])]);
  }

  published(): Promise<{ revision: number; listings: Listing[] }> {
    return Promise.resolve({
      revision: this.counter,
      listings: [...this.listings.values()].filter((l) => l.state === "published").sort(catalogOrder),
    });
  }

  staleFacts(limit: number, before: Date): Promise<Listing[]> {
    const checked = (listing: Listing) => listing.facts?.checkedAt.getTime() ?? -Infinity;
    return Promise.resolve(
      [...this.listings.values()]
        .filter((listing) => listing.state === "published" && checked(listing) < before.getTime())
        .sort((a, b) => checked(a) - checked(b))
        .slice(0, limit),
    );
  }

  revision(): Promise<number> {
    return Promise.resolve(this.counter);
  }

  dueOriginChecks(limit: number): Promise<OriginCheck[]> {
    return Promise.resolve(this.due(limit).map((scheduled) => scheduled.check));
  }

  claimOriginChecks(limit: number, leaseMs: number): Promise<OriginCheck[]> {
    const claimed = this.due(limit);
    for (const scheduled of claimed) scheduled.claimedUntil = this.now() + leaseMs;
    return Promise.resolve(claimed.map((scheduled) => scheduled.check));
  }

  deferOriginCheck(check: OriginCheck, delayMs: number): Promise<void> {
    const scheduled = this.checks.get(check.listingId);
    if (scheduled?.check.requestId === check.requestId) {
      scheduled.check = { ...scheduled.check, attempts: scheduled.check.attempts + 1 };
      scheduled.dueAt = this.now() + delayMs;
      delete scheduled.claimedUntil;
    }
    return Promise.resolve();
  }

  completeOriginCheck(check: OriginCheck): Promise<void> {
    if (this.checks.get(check.listingId)?.check.requestId === check.requestId) {
      this.checks.delete(check.listingId);
    }
    return Promise.resolve();
  }

  enqueueSettlement(payment: SettledPayment, graceMs: number): Promise<void> {
    if (!this.outbox.has(payment.transaction)) {
      this.outbox.set(payment.transaction, {
        payment,
        attempts: 0,
        dueAt: this.now() + graceMs,
        claimedUntil: 0,
      });
    }
    return Promise.resolve();
  }

  claimSettlements(limit: number, leaseMs: number): Promise<QueuedSettlement[]> {
    const now = this.now();
    const due = [...this.outbox.values()]
      .filter((entry) => entry.dueAt <= now && entry.claimedUntil <= now)
      .sort((a, b) => a.dueAt - b.dueAt)
      .slice(0, limit);
    for (const entry of due) entry.claimedUntil = now + leaseMs;
    return Promise.resolve(due.map(({ payment, attempts }) => ({ payment, attempts })));
  }

  deferSettlement(transaction: string, delayMs: number): Promise<void> {
    const entry = this.outbox.get(transaction);
    if (entry !== undefined) {
      entry.attempts++;
      entry.dueAt = this.now() + delayMs;
      entry.claimedUntil = 0;
    }
    return Promise.resolve();
  }

  completeSettlement(transaction: string): Promise<void> {
    this.outbox.delete(transaction);
    return Promise.resolve();
  }

  private createdSince(since: Date): Listing[] {
    return [...this.listings.values()].filter(
      (listing) => listing.firstCatalogedAt.getTime() >= since.getTime(),
    );
  }

  private due(limit: number): ScheduledCheck[] {
    const now = this.now();
    return [...this.checks.values()]
      .filter((scheduled) => scheduled.dueAt <= now && (scheduled.claimedUntil ?? 0) <= now)
      .sort((a, b) => a.dueAt - b.dueAt)
      .slice(0, limit);
  }

  private tx(): CatalogTransaction {
    return {
      find: (identity) => {
        const id = this.byIdentity.get(identityKey(identity));
        return Promise.resolve(id === undefined ? undefined : this.listings.get(id));
      },
      get: (id) => Promise.resolve(this.listings.get(id)),
      observe: (listingId: string, observation: Observation) => {
        const earlier = this.observations.get(observation.transaction);
        if (earlier !== undefined) {
          return Promise.resolve(earlier.listingId === listingId ? "seen" : "elsewhere");
        }
        this.observations.set(observation.transaction, { listingId, payer: observation.payer });
        return Promise.resolve("new");
      },
      observedListing: (transaction) => Promise.resolve(this.observations.get(transaction)?.listingId),
      countCreatedBy: (owner, since) =>
        Promise.resolve(
          this.createdSince(since).filter(
            (listing) => listing.owner === owner && listing.state !== "quarantined",
          ).length,
        ),
      countCreatedByPayer: (payer, since) =>
        Promise.resolve(
          this.createdSince(since).filter((listing) => {
            const creation = this.history.get(listing.id)?.[0]?.transaction;
            return creation !== undefined && this.observations.get(creation)?.payer === payer;
          }).length,
        ),
      countCreatedSince: (since) => Promise.resolve(this.createdSince(since).length),
      insert: (listing, version) => {
        const key = identityKey(listing.identity);
        if (this.byIdentity.has(key)) return Promise.reject(new Error("listing identity already exists"));
        this.listings.set(listing.id, { ...listing, sequence: ++this.sequence });
        this.byIdentity.set(key, listing.id);
        this.history.set(listing.id, [version]);
        this.counter++;
        return Promise.resolve();
      },
      update: (listing, version) => {
        this.listings.set(listing.id, listing);
        if (version !== undefined) {
          this.history.get(listing.id)?.push(version);
          this.counter++;
        }
        return Promise.resolve();
      },
      requestOriginCheck: (
        listingId: string,
        reason: OriginCheckReason,
        url: string,
        proposedOwner?: string,
      ) => {
        const existing = this.checks.get(listingId);
        // An ownership claim is never downgraded by a later, plainer request.
        const keep = existing?.check.reason === "owner_conflict" && reason !== "owner_conflict";
        const owner = keep ? existing.check.proposedOwner : proposedOwner;
        this.checks.set(listingId, {
          check: {
            listingId,
            reason: keep ? existing.check.reason : reason,
            url,
            attempts: 0,
            requestId: randomUUID(),
            ...(owner === undefined ? {} : { proposedOwner: owner }),
          },
          dueAt: this.now(),
        });
        return Promise.resolve();
      },
    };
  }
}

function unknownIdentity(id: string): ListingIdentity {
  return { network: "", kind: "http", resource: `unknown:${id}`, method: "", toolName: "", scope: "" };
}
