import { randomUUID } from "node:crypto";
import { catalogOrder, groupByResource, matchesFilter, narrowOptions, optionMatches } from "./filter.ts";
import type { SettledPayment } from "./extract.ts";
import {
  canonicalJson,
  checkCandidates,
  markCandidates,
  mergeCandidates,
  identityKey,
  MAX_PROPOSED_OWNERS,
  OWNER_CLAIM_DELAY_MS,
  abandoned,
  expired,
  resourceOrigin,
  usageVisible,
  type CatalogStats,
  type CatalogStore,
  type CatalogTransaction,
  type QuotaCount,
  type ListingUsage,
  type Observation,
  type QueuedSettlement,
  type SellerUsage,
  type SettlementLink,
  type VersionPage,
} from "./store.ts";
import type {
  CheckCandidate,
  ListFilter,
  Listing,
  ListingIdentity,
  ListingVersion,
  OriginCheck,
  OriginCheckReason,
  ResourceListings,
  SettledOption,
  ToolCallProposal,
} from "./types.ts";

/**
 * The quotas a transaction holds (see `CatalogTransaction.countCreatedBy` and `countListedSince`),
 * released when it ends.
 */
interface QuotaHolds {
  readonly keys: Set<string>;
  readonly releases: (() => void)[];
}

interface ScheduledCheck {
  check: OriginCheck;
  /** The network of the listing checked; workers claim each network's checks separately. */
  network: string;
  dueAt: number;
  claimedUntil?: number;
  /** When its scheduled retry is, while a request made it due before then. */
  retryAt?: number;
}

/** Process-local catalog store, for tests and single-process development. */
export class MemoryCatalogStore implements CatalogStore {
  private readonly listings = new Map<string, Listing>();
  private readonly byIdentity = new Map<string, string>();
  private readonly history = new Map<string, ListingVersion[]>();
  /** Settlement transaction → the listing it was observed against, and the observation. */
  private readonly observations = new Map<string, { listingId: string; observation: Observation }>();
  private readonly checks = new Map<string, ScheduledCheck>();
  private readonly outbox = new Map<
    string,
    { payment: SettledPayment; attempts: number; dueAt: number; claimedUntil: number }
  >();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly quotaLocks = new Map<string, Promise<unknown>>();
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
    const holds: QuotaHolds = { keys: new Set(), releases: [] };
    const run = previous.then(() => work(this.tx(holds)));
    const settled = run.catch(() => undefined);
    this.locks.set(lock, settled);
    try {
      return await run;
    } finally {
      for (const release of holds.releases) release();
      if (this.locks.get(lock) === settled) this.locks.delete(lock);
    }
  }

  /** Waits until no other transaction holds `key`, then holds it until this transaction ends. */
  private async holdQuota(key: string, holds: QuotaHolds): Promise<void> {
    if (holds.keys.has(key)) return;
    holds.keys.add(key);
    const previous = this.quotaLocks.get(key) ?? Promise.resolve();
    const { promise: ended, resolve: end } = Promise.withResolvers<undefined>();
    const held = previous.then(() => ended);
    this.quotaLocks.set(key, held);
    holds.releases.push(() => {
      end(undefined);
      if (this.quotaLocks.get(key) === held) this.quotaLocks.delete(key);
    });
    await previous;
  }

  get(id: string): Promise<Listing | undefined> {
    return Promise.resolve(this.listings.get(id));
  }

  getMany(ids: readonly string[]): Promise<Listing[]> {
    return Promise.resolve(
      [...new Set(ids)]
        .map((id) => this.listings.get(id))
        .filter((listing): listing is Listing => listing !== undefined),
    );
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

  versions(id: string, page?: VersionPage): Promise<ListingVersion[]> {
    const all = this.history.get(id) ?? [];
    if (page === undefined) return Promise.resolve([...all]);
    const after = page.after ?? 0;
    return Promise.resolve(all.filter((version) => version.version > after).slice(0, page.limit));
  }

  published(): Promise<{ revision: number; listings: Listing[] }> {
    return Promise.resolve({
      revision: this.counter,
      listings: [...this.listings.values()].filter((l) => l.state === "published").sort(catalogOrder),
    });
  }

  scanPublished(visit: (batch: readonly Listing[]) => void, batchSize = 500): Promise<number> {
    const revision = this.counter;
    const listings = [...this.listings.values()].filter((l) => l.state === "published").sort(catalogOrder);
    for (let at = 0; at < listings.length; at += Math.max(1, batchSize)) {
      visit(listings.slice(at, at + Math.max(1, batchSize)));
    }
    return Promise.resolve(revision);
  }

  staleFacts(limit: number, before: Date, network?: string): Promise<Listing[]> {
    const checked = (listing: Listing) => listing.facts?.checkedAt.getTime() ?? -Infinity;
    return Promise.resolve(
      [...this.listings.values()]
        .filter(
          (listing) =>
            listing.state === "published" &&
            checked(listing) < before.getTime() &&
            (network === undefined || listing.identity.network === network),
        )
        .sort((a, b) => checked(a) - checked(b))
        .slice(0, limit),
    );
  }

  async staleFactsNetworks(before: Date): Promise<string[]> {
    const stale = await this.staleFacts(Infinity, before);
    return [...new Set(stale.map((listing) => listing.identity.network))].sort();
  }

  publishedNetworks(): Promise<string[]> {
    const published = [...this.listings.values()].filter((listing) => listing.state === "published");
    return Promise.resolve([...new Set(published.map((listing) => listing.identity.network))].sort());
  }

  abandonedListings(before: Date, limit: number): Promise<Listing[]> {
    return Promise.resolve(
      [...this.listings.values()]
        .filter((listing) => abandoned(listing, before))
        .sort((a, b) => a.lastUpdated.getTime() - b.lastUpdated.getTime())
        .slice(0, limit),
    );
  }

  expiredListings(
    network: string,
    unverifiedBefore: Date,
    idleBefore: Date | undefined,
    limit: number,
  ): Promise<Listing[]> {
    return Promise.resolve(
      [...this.listings.values()]
        .filter((listing) => listing.state === "published" && listing.identity.network === network)
        .filter((listing) => expired(listing, unverifiedBefore, idleBefore))
        .sort((a, b) => a.lastSettledAt.getTime() - b.lastSettledAt.getTime())
        .slice(0, limit),
    );
  }

  revision(): Promise<number> {
    return Promise.resolve(this.counter);
  }

  dueOriginChecks(limit: number, network?: string): Promise<OriginCheck[]> {
    return Promise.resolve(this.due(limit, network).map((scheduled) => this.snapshot(scheduled)));
  }

  claimOriginChecks(limit: number, leaseMs: number, network?: string): Promise<OriginCheck[]> {
    const claimed = this.due(limit, network);
    for (const scheduled of claimed) scheduled.claimedUntil = this.now() + leaseMs;
    return Promise.resolve(claimed.map((scheduled) => this.snapshot(scheduled)));
  }

  /** A scheduled check as a worker sees it: `early` while its scheduled retry is still ahead. */
  private snapshot(scheduled: ScheduledCheck): OriginCheck {
    return scheduled.retryAt !== undefined && scheduled.retryAt > this.now()
      ? { ...scheduled.check, early: true }
      : scheduled.check;
  }

  originCheckNetworks(): Promise<string[]> {
    return Promise.resolve([...new Set(this.due(Infinity).map((scheduled) => scheduled.network))].sort());
  }

  deferOriginCheck(
    check: OriginCheck,
    delayMs: number,
    spend = true,
    asked: readonly CheckCandidate[] = [],
  ): Promise<void> {
    const scheduled = this.checks.get(check.listingId);
    if (scheduled?.check.requestId === check.requestId) {
      const { candidates } = scheduled.check;
      // A run a request made due before its scheduled retry waits for that retry and spends none.
      const early = spend && scheduled.retryAt !== undefined && scheduled.retryAt > this.now();
      scheduled.check = {
        ...scheduled.check,
        attempts: scheduled.check.attempts + (spend && !early ? 1 : 0),
        ...(candidates === undefined ? {} : { candidates: markCandidates(candidates, asked) }),
      };
      scheduled.dueAt = early && scheduled.retryAt !== undefined ? scheduled.retryAt : this.now() + delayMs;
      if (spend) delete scheduled.retryAt;
      delete scheduled.claimedUntil;
    }
    return Promise.resolve();
  }

  completeOriginCheck(check: OriginCheck): Promise<void> {
    const scheduled = this.checks.get(check.listingId);
    if (scheduled?.check.requestId !== check.requestId) return Promise.resolve();
    const { candidates } = scheduled.check;
    if (canonicalJson(candidates ?? []) === canonicalJson(check.candidates ?? [])) {
      this.checks.delete(check.listingId);
      return Promise.resolve();
    }
    // A request added a candidate while it ran: the check runs again, as a new one.
    scheduled.check = {
      ...scheduled.check,
      attempts: 0,
      requestId: randomUUID(),
      ...(candidates === undefined
        ? {}
        : { candidates: candidates.map(({ asked: _asked, ...rest }) => rest) }),
    };
    scheduled.dueAt = this.now();
    delete scheduled.claimedUntil;
    delete scheduled.retryAt;
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

  stats(): Promise<CatalogStats> {
    const listings = { pending: 0, published: 0, quarantined: 0 };
    for (const listing of this.listings.values()) listings[listing.state]++;
    return Promise.resolve({ listings, queuedSettlements: this.outbox.size });
  }

  settlementLinks(network: string, transactions: readonly string[]): Promise<SettlementLink[]> {
    const links: SettlementLink[] = [];
    for (const transaction of new Set(transactions)) {
      const observed = this.observations.get(transaction);
      const listing = observed === undefined ? undefined : this.listings.get(observed.listingId);
      if (observed === undefined || listing === undefined) continue;
      if (!usageVisible(listing, network) || observed.observation.payTo !== listing.owner) continue;
      links.push({ listing, observation: observed.observation });
    }
    return Promise.resolve(links);
  }

  listingUsage(listing: Listing, recent: number): Promise<ListingUsage> {
    const paid = this.paidTo(listing);
    const times = paid.map((observation) => observation.observedAt.getTime());
    return Promise.resolve({
      payments: paid.length,
      payers: new Set(paid.map((observation) => observation.payer)).size,
      ...(paid.length === 0
        ? {}
        : { firstObservedAt: new Date(Math.min(...times)), lastObservedAt: new Date(Math.max(...times)) }),
      recent: paid.slice(0, recent),
    });
  }

  sellerUsage(owner: string, network: string, limit: number): Promise<SellerUsage> {
    const all: Observation[] = [];
    const listings = [...this.listings.values()]
      .filter((listing) => listing.owner === owner && usageVisible(listing, network))
      .sort(catalogOrder)
      .map((listing) => {
        const paid = this.paidTo(listing);
        all.push(...paid);
        return {
          listing,
          payments: paid.length,
          payers: new Set(paid.map((observation) => observation.payer)).size,
          ...(paid[0] === undefined ? {} : { lastObservedAt: paid[0].observedAt }),
        };
      })
      // Most recently paid first, then listings never paid; ties keep catalog order.
      .sort((a, b) => (b.lastObservedAt?.getTime() ?? -1) - (a.lastObservedAt?.getTime() ?? -1));
    return Promise.resolve({
      payments: all.length,
      payers: new Set(all.map((observation) => observation.payer)).size,
      listings: listings.slice(0, limit),
      truncated: listings.length > limit,
    });
  }

  /** The settlements observed against `listing` that paid its current owner, newest first. */
  private paidTo(listing: Listing): Observation[] {
    return [...this.observations.values()]
      .filter(({ listingId, observation }) => listingId === listing.id && observation.payTo === listing.owner)
      .map(({ observation }) => observation)
      .sort(newestFirst);
  }

  private createdSince(network: string, since: Date): Listing[] {
    return [...this.listings.values()].filter(
      (listing) =>
        listing.identity.network === network && listing.firstCatalogedAt.getTime() >= since.getTime(),
    );
  }

  private due(limit: number, network?: string): ScheduledCheck[] {
    const now = this.now();
    return [...this.checks.values()]
      .filter(
        (scheduled) =>
          scheduled.dueAt <= now &&
          (scheduled.claimedUntil ?? 0) <= now &&
          (network === undefined || scheduled.network === network),
      )
      .sort((a, b) => a.dueAt - b.dueAt)
      .slice(0, limit);
  }

  private tx(holds: QuotaHolds): CatalogTransaction {
    return {
      find: (identity) => {
        const id = this.byIdentity.get(identityKey(identity));
        return Promise.resolve(id === undefined ? undefined : this.listings.get(id));
      },
      get: (id) => Promise.resolve(this.listings.get(id)),
      latestReason: (id) => Promise.resolve(this.history.get(id)?.at(-1)?.reason),
      observe: (listingId: string, observation: Observation) => {
        const earlier = this.observations.get(observation.transaction);
        if (earlier !== undefined) {
          return Promise.resolve(earlier.listingId === listingId ? "seen" : "elsewhere");
        }
        this.observations.set(observation.transaction, { listingId, observation });
        return Promise.resolve("new");
      },
      observedListing: (transaction) => Promise.resolve(this.observations.get(transaction)?.listingId),
      countCreatedBy: async (owner, network, origin, since) => {
        await this.holdQuota([owner, network, origin].join("\u0000"), holds);
        return quotaCount(
          [...this.listings.values()]
            .filter(
              (listing) =>
                listing.identity.network === network &&
                listing.owner === owner &&
                resourceOrigin(listing.identity.resource) === origin &&
                listing.state === "published" &&
                listing.trust !== "settled",
            )
            .map((listing) => listing.quotaChargedAt),
          since,
        );
      },
      countCreatedByPayer: (payer, network, since) =>
        Promise.resolve(
          this.createdSince(network, since).filter((listing) => {
            const creation = this.history.get(listing.id)?.[0]?.transaction;
            return creation !== undefined && this.observations.get(creation)?.observation.payer === payer;
          }).length,
        ),
      countListedSince: async (network, since, unverified) => {
        await this.holdQuota(["listed", network, String(unverified)].join("\u0000"), holds);
        return quotaCount(
          [...this.listings.values()]
            .filter(
              (listing) =>
                listing.identity.network === network && (listing.trust === "settled") === unverified,
            )
            .map((listing) => listing.listedAt),
          since,
        );
      },
      countPublishedBy: (network, owner) =>
        Promise.resolve(
          [...this.listings.values()].filter(
            (listing) =>
              listing.state === "published" &&
              listing.identity.network === network &&
              listing.owner === owner &&
              listing.trust !== "settled",
          ).length,
        ),
      countPublished: (network, unverified) =>
        Promise.resolve(
          [...this.listings.values()].filter(
            (listing) =>
              listing.state === "published" &&
              listing.identity.network === network &&
              (listing.trust === "settled") === unverified,
          ).length,
        ),
      insert: (listing, version) => {
        const key = identityKey(listing.identity);
        if (this.byIdentity.has(key)) return Promise.reject(new Error("listing identity already exists"));
        this.listings.set(listing.id, { ...listing, sequence: ++this.sequence });
        this.byIdentity.set(key, listing.id);
        this.history.set(listing.id, [version]);
        this.counter++;
        return Promise.resolve();
      },
      remove: (listingId) => {
        const listing = this.listings.get(listingId);
        if (listing === undefined) return Promise.resolve();
        this.listings.delete(listingId);
        this.byIdentity.delete(identityKey(listing.identity));
        this.history.delete(listingId);
        this.checks.delete(listingId);
        for (const [transaction, entry] of this.observations) {
          if (entry.listingId === listingId) this.observations.delete(transaction);
        }
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
        settled?: SettledOption,
        probe?: ToolCallProposal,
      ) => {
        const existing = this.checks.get(listingId);
        const claimants = existing?.check.proposedOwners ?? [];
        if (reason === "owner_conflict" && existing !== undefined) {
          // A claim joins the check already requested; it never resets it or replaces another claim.
          if (
            proposedOwner === undefined ||
            claimants.includes(proposedOwner) ||
            claimants.length >= MAX_PROPOSED_OWNERS
          ) {
            return Promise.resolve();
          }
          existing.check = {
            ...existing.check,
            reason: "owner_conflict",
            proposedOwners: [...claimants, proposedOwner],
            requestId: randomUUID(),
          };
          const dueAt = Math.min(existing.dueAt, this.now() + OWNER_CLAIM_DELAY_MS);
          if (dueAt < existing.dueAt && existing.check.attempts > 0) existing.retryAt ??= existing.dueAt;
          existing.dueAt = dueAt;
          delete existing.claimedUntil;
          return Promise.resolve();
        }
        const network = this.listings.get(listingId)?.identity.network ?? "";
        if (reason === "owner_conflict") {
          this.checks.set(listingId, {
            check: {
              listingId,
              reason,
              url,
              attempts: 0,
              requestId: randomUUID(),
              ...(proposedOwner === undefined ? {} : { proposedOwners: [proposedOwner] }),
            },
            network,
            dueAt: this.now(),
          });
          return Promise.resolve();
        }
        // A settlement that paid the owner adds its candidate; the check keeps its retry count.
        const before = existing === undefined ? [] : checkCandidates(existing.check);
        const candidates = mergeCandidates(before, {
          url,
          ...(settled === undefined ? {} : { settled }),
          ...(probe === undefined ? {} : { probe }),
        });
        const attempts = existing?.check.attempts ?? 0;
        const unlisted = this.listings.get(listingId)?.state !== "published";
        const running = existing?.claimedUntil !== undefined && existing.claimedUntil > this.now();
        // A check waiting for a retry, or running, is due sooner only for a listing not published;
        // otherwise it keeps its due time and claim, so a run in flight still defers it.
        const soon = existing === undefined || (attempts === 0 && !running) || unlisted;
        const retryAt =
          existing === undefined || attempts === 0
            ? undefined
            : (existing.retryAt ?? (soon && existing.dueAt > this.now() ? existing.dueAt : undefined));
        // An ownership claim is never downgraded by a later, plainer request, nor sent to its path.
        const keep = existing?.check.reason === "owner_conflict";
        this.checks.set(listingId, {
          check: {
            listingId,
            reason: keep ? "owner_conflict" : reason,
            url: keep ? existing.check.url : url,
            attempts,
            requestId: soon ? randomUUID() : existing.check.requestId,
            ...(claimants.length === 0 ? {} : { proposedOwners: claimants }),
            ...(settled === undefined ? {} : { settled }),
            ...(probe === undefined ? {} : { probe }),
            candidates,
          },
          network,
          dueAt: soon ? this.now() : existing.dueAt,
          ...(soon || existing.claimedUntil === undefined ? {} : { claimedUntil: existing.claimedUntil }),
          // Made due before its scheduled retry, it keeps that retry's time: only scheduled runs spend one.
          ...(retryAt === undefined ? {} : { retryAt }),
        });
        return Promise.resolve();
      },
    };
  }
}

/** The times at or after `since` among `times`: how many, and the earliest. */
function quotaCount(times: readonly (Date | undefined)[], since: Date): QuotaCount {
  const counted = times.map((time) => time?.getTime() ?? -Infinity).filter((time) => time >= since.getTime());
  return counted.length === 0
    ? { count: 0 }
    : { count: counted.length, earliest: new Date(Math.min(...counted)) };
}

/** Newest first; settlements observed at the same instant by transaction hash, descending. */
function newestFirst(a: Observation, b: Observation): number {
  return (
    b.observedAt.getTime() - a.observedAt.getTime() ||
    (a.transaction < b.transaction ? 1 : a.transaction > b.transaction ? -1 : 0)
  );
}

function unknownIdentity(id: string): ListingIdentity {
  return { network: "", kind: "http", resource: `unknown:${id}`, method: "", toolName: "", scope: "" };
}
