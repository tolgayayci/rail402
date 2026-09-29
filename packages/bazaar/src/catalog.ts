import { randomUUID } from "node:crypto";
import { CONTRACT_ADDRESS, DESTINATION_ADDRESS } from "@rail402.dev/stellar";
import type { PaymentPayload, PaymentRequirements, PaymentRequired } from "@x402/core/types";
import { bazaarCodes, type BazaarCode, type CatalogResultCode } from "./codes.ts";
import { baseAccount, extractCandidate, type SettledPayment } from "./extract.ts";
import { fetchPaymentRequired, type OriginFetchOptions, type OriginResponse } from "./origin.ts";
import { fetchStellarTomlAccounts, type StellarTomlResult } from "./stellar-toml.ts";
import type { SchemaSandbox } from "./schema-sandbox.ts";
import { contentHash, type CatalogStore, type CatalogTransaction } from "./store.ts";
import type {
  Candidate,
  Listing,
  ListingContent,
  ListingFacts,
  ListingVersion,
  OptionFacts,
  OriginCheck,
  PaymentOption,
  Trust,
  VersionCause,
} from "./types.ts";

/**
 * The bazaar outcome reported to the seller in the `EXTENSION-RESPONSES` sidechannel. `status` and
 * `rejectedReason` are the spec's fields; `code` and the rest are Rail402 additions a stock client
 * logs verbatim.
 */
export interface CatalogOutcome {
  readonly status: "success" | "processing" | "rejected";
  readonly code: CatalogResultCode | BazaarCode;
  readonly rejectedReason?: string;
  readonly reason?: string;
  readonly listingId?: string;
  readonly version?: number;
  /** Service-metadata fields that failed the soft-drop rules and were left out. */
  readonly dropped?: readonly string[];
}

export interface CatalogOptions {
  readonly store: CatalogStore;
  readonly sandbox: SchemaSandbox;
  /** Accept and fetch loopback resources. Conformance runs only; never on a public deployment. */
  readonly allowLoopback?: boolean;
  /** New listings one payTo may create per hour. Listings the origin check withdrew do not count. */
  readonly maxNewListingsPerOwnerPerHour?: number;
  /** New listings the settlements of one payer may create per hour. */
  readonly maxNewListingsPerPayerPerHour?: number;
  /** New listings the whole catalog accepts per hour. */
  readonly maxNewListingsPerHour?: number;
  /** Origin requests one host receives per minute from this process. */
  readonly originChecksPerHostPerMinute?: number;
  /** How long the inline attempt has before a background worker may finish a queued settlement. */
  readonly outboxGraceMs?: number;
  /** Reads token facts and receivability from each network; without it, listings carry no facts. */
  readonly assets?: TokenDirectory;
  /** Reads a domain's SEP-1 stellar.toml ACCOUNTS; replaces the network fetch in tests. */
  readonly stellarToml?: (host: string) => Promise<StellarTomlResult>;
  readonly origin?: Omit<OriginFetchOptions, "allowLoopback">;
  /** Replaces the network fetch, for tests. */
  readonly fetchOrigin?: (url: string, method: string) => Promise<OriginResponse>;
  readonly now?: () => Date;
}

/** Retry schedule for origin checks that could not reach the resource. */
const ORIGIN_RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000, 43_200_000];
/** How long a worker holds a claimed origin check; a fetch takes at most a few seconds. */
const ORIGIN_CLAIM_MS = 60_000;
/** How long a worker holds a claimed queued settlement. */
const OUTBOX_CLAIM_MS = 60_000;
/** Retry schedule for queued settlements the catalog store could not take. */
const OUTBOX_RETRY_DELAYS_MS = [10_000, 60_000, 300_000, 1_800_000, 7_200_000];

/** Token facts per network: what each network says about a token and who can receive it. */
export interface TokenDirectory {
  describe(
    network: string,
    contract: string,
  ): Promise<{ symbol: string; name: string; decimals: number } | undefined>;
  receivable(network: string, contract: string, payTo: string): Promise<boolean | undefined>;
}

/** How long a listing's Stellar facts are trusted before they are read again. */
const FACTS_MAX_AGE_MS = 6 * 3_600_000;

/**
 * The Stellar Bazaar catalog. Listings are created only from settled payments and are bound to the
 * payTo the settlement proved. Metadata echoed by the buyer is never allowed to change an existing
 * listing on its own: changes publish only after the resource's own 402 response confirms them.
 */
export class Catalog {
  private readonly store: CatalogStore;
  private readonly sandbox: SchemaSandbox;
  private readonly allowLoopback: boolean;
  private readonly maxNewListingsPerOwnerPerHour: number;
  private readonly maxNewListingsPerPayerPerHour: number;
  private readonly maxNewListingsPerHour: number;
  private readonly originChecksPerHostPerMinute: number;
  private readonly outboxGraceMs: number;
  private readonly assets: TokenDirectory | undefined;
  private readonly stellarToml: (host: string) => Promise<StellarTomlResult>;
  private readonly hostBudget = new Map<string, { since: number; count: number }>();
  private readonly fetchOrigin: (url: string, method: string) => Promise<OriginResponse>;
  private readonly now: () => Date;

  constructor(options: CatalogOptions) {
    this.store = options.store;
    this.sandbox = options.sandbox;
    this.allowLoopback = options.allowLoopback ?? false;
    this.maxNewListingsPerOwnerPerHour = options.maxNewListingsPerOwnerPerHour ?? 20;
    this.maxNewListingsPerPayerPerHour = options.maxNewListingsPerPayerPerHour ?? 10;
    this.maxNewListingsPerHour = options.maxNewListingsPerHour ?? 1_000;
    this.originChecksPerHostPerMinute = options.originChecksPerHostPerMinute ?? 30;
    this.outboxGraceMs = options.outboxGraceMs ?? 30_000;
    this.assets = options.assets;
    this.stellarToml =
      options.stellarToml ??
      ((host) => fetchStellarTomlAccounts(host, { allowLoopback: this.allowLoopback }));
    this.now = options.now ?? (() => new Date());
    this.fetchOrigin =
      options.fetchOrigin ??
      ((url, method) =>
        fetchPaymentRequired(url, method, { ...options.origin, allowLoopback: this.allowLoopback }));
  }

  /**
   * Checks the bazaar extension of a payment being verified. Nothing is cataloged until the payment
   * settles; a valid extension reports `processing` so the seller learns early whether it will land.
   */
  async preview(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<CatalogOutcome | undefined> {
    const extraction = await extractCandidate(
      { payload, requirements, payer: "", transaction: "" },
      { sandbox: this.sandbox, allowLoopback: this.allowLoopback },
    );
    if (extraction.kind === "absent") return undefined;
    if (extraction.kind === "rejected") return rejected(extraction.code, extraction.reason);
    return {
      status: "processing",
      code: "awaiting_settlement",
      reason: "The discovery metadata is valid; the resource is cataloged once the payment settles.",
      ...dropped(extraction.candidate),
    };
  }

  /**
   * Catalogs a settled payment durably: it is queued before cataloging starts and removed once
   * cataloging reached an outcome, so a crash in between leaves it for processQueued() to finish. A
   * payment without a bazaar extension is not queued. Never throws.
   */
  async recordDurably(payment: SettledPayment): Promise<CatalogOutcome | undefined> {
    if (payment.payload.extensions?.["bazaar"] === undefined) return undefined;
    let queued = true;
    try {
      await this.store.enqueueSettlement(payment, this.outboxGraceMs);
    } catch {
      // The queue is a safety net; cataloging itself does not depend on it.
      queued = false;
    }
    const outcome = await this.record(payment);
    if (queued && outcome?.code !== "bazaar_catalog_unavailable") {
      await this.store.completeSettlement(payment.transaction).catch(() => undefined);
    }
    return outcome;
  }

  /**
   * Catalogs queued settlements that an earlier attempt did not finish, and returns how many reached an
   * outcome. Cataloging is idempotent per settlement, so finishing one twice changes nothing.
   */
  async processQueued(limit = 10): Promise<number> {
    const queued = await this.store.claimSettlements(limit, OUTBOX_CLAIM_MS);
    let finished = 0;
    for (const { payment, attempts } of queued) {
      let outcome: CatalogOutcome | undefined;
      try {
        outcome = await this.record(payment);
      } catch {
        outcome = rejected("bazaar_catalog_unavailable");
      }
      if (outcome?.code === "bazaar_catalog_unavailable") {
        const delay = OUTBOX_RETRY_DELAYS_MS[attempts];
        if (delay !== undefined) {
          await this.store.deferSettlement(payment.transaction, delay);
          continue;
        }
      }
      await this.store.completeSettlement(payment.transaction);
      finished++;
    }
    return finished;
  }

  /** Catalogs a settled payment. Never throws: failures are reported as outcomes. */
  async record(payment: SettledPayment): Promise<CatalogOutcome | undefined> {
    const extraction = await extractCandidate(payment, {
      sandbox: this.sandbox,
      allowLoopback: this.allowLoopback,
    });
    if (extraction.kind === "absent") return undefined;
    if (extraction.kind === "rejected") return rejected(extraction.code, extraction.reason);
    const candidate = extraction.candidate;
    try {
      return await this.store.transaction(candidate.identity, (tx) => this.apply(tx, candidate));
    } catch {
      return rejected("bazaar_catalog_unavailable");
    }
  }

  private async apply(tx: CatalogTransaction, candidate: Candidate): Promise<CatalogOutcome> {
    const now = this.now();
    const observation = {
      transaction: candidate.transaction,
      payer: candidate.payer,
      asset: candidate.content.accepts[0]?.asset ?? "",
      amount: candidate.content.accepts[0]?.amount ?? "",
      observedAt: now,
    };
    const existing = await tx.find(candidate.identity);
    const earlier = await tx.observedListing(candidate.transaction);
    if (earlier !== undefined && earlier !== existing?.id) return rejected("bazaar_settlement_reused");

    if (existing === undefined) {
      const hourAgo = new Date(now.getTime() - 3_600_000);
      if ((await tx.countCreatedBy(candidate.owner, hourAgo)) >= this.maxNewListingsPerOwnerPerHour) {
        return rejected("bazaar_rate_limited");
      }
      if ((await tx.countCreatedByPayer(candidate.payer, hourAgo)) >= this.maxNewListingsPerPayerPerHour) {
        return rejected(
          "bazaar_rate_limited",
          "This payer's settlements created too many new listings recently; the resource will be cataloged on a later settlement.",
        );
      }
      if ((await tx.countCreatedSince(hourAgo)) >= this.maxNewListingsPerHour) {
        return rejected(
          "bazaar_rate_limited",
          "The catalog accepted too many new listings recently; the resource will be cataloged on a later settlement.",
        );
      }

      // An HTTP resource is listed only once its own 402 response confirms what the buyer echoed:
      // until then anyone could list any public URL under their own payTo.
      const verifiable = this.verifiable(candidate);
      const listing: Listing = {
        id: randomUUID(),
        sequence: 0,
        identity: candidate.identity,
        owner: candidate.owner,
        trust: "settled",
        state: verifiable ? "pending" : "published",
        version: 1,
        content: candidate.content,
        contentHash: contentHash(candidate.content),
        firstCatalogedAt: now,
        ...(verifiable ? {} : { listedAt: now }),
        lastUpdated: now,
        lastSettledAt: now,
        settlements: 1,
      };
      await tx.insert(listing, versionOf(listing, "settlement", now, candidate.transaction));
      if ((await tx.observe(listing.id, observation)) !== "new") {
        throw new Error("the settlement was observed concurrently for another listing");
      }
      if (!verifiable) {
        return {
          status: "success",
          code: "cataloged",
          listingId: listing.id,
          version: 1,
          ...dropped(candidate),
        };
      }
      await tx.requestOriginCheck(listing.id, "created", candidate.concreteUrl);
      return {
        status: "processing",
        code: "awaiting_origin_verification",
        reason: "The resource is listed once its own 402 response confirms the payment options and metadata.",
        listingId: listing.id,
        version: 1,
        ...dropped(candidate),
      };
    }

    const observed = await tx.observe(existing.id, observation);
    if (observed === "elsewhere") return rejected("bazaar_settlement_reused");
    if (observed === "seen") {
      return { status: "success", code: "recorded", listingId: existing.id, version: existing.version };
    }

    if (existing.owner !== candidate.owner) {
      if (this.verifiable(candidate)) {
        await tx.requestOriginCheck(existing.id, "owner_conflict", candidate.concreteUrl, candidate.owner);
      }
      return rejected(
        "bazaar_owner_conflict",
        this.verifiable(candidate)
          ? "This resource is cataloged for a different payTo. The resource's own 402 response will be checked; the listing changes owner only if it names this payTo."
          : undefined,
        existing.id,
      );
    }

    const stats: Listing = { ...existing, lastSettledAt: now, settlements: existing.settlements + 1 };
    const proposed = keepExamplePathParams(
      existing.content,
      mergeContent(existing.content, candidate.content),
    );
    await tx.update(stats);
    // A pending or quarantined HTTP listing is re-checked on every settlement, so a seller that fixes
    // its 402 response gets it listed again.
    const recheck =
      this.verifiable(candidate) &&
      (contentHash(proposed) !== existing.contentHash || existing.state !== "published");
    if (recheck) {
      await tx.requestOriginCheck(existing.id, "changed", candidate.concreteUrl);
      return {
        status: "processing",
        code: "awaiting_origin_verification",
        reason:
          existing.state === "published"
            ? "The listing's metadata or price changed; the change is published once the resource's own 402 response confirms it."
            : "The resource is listed once its own 402 response confirms the payment options and metadata.",
        listingId: existing.id,
        version: existing.version,
        ...dropped(candidate),
      };
    }
    return {
      status: "success",
      code: "recorded",
      ...(contentHash(proposed) === existing.contentHash
        ? {}
        : {
            reason:
              "The settlement was recorded. MCP tools cannot be checked against an origin, so their metadata is not changed by later settlements.",
          }),
      listingId: existing.id,
      version: existing.version,
      ...dropped(candidate),
    };
  }

  /**
   * Refreshes the Stellar facts of published listings that have none or whose facts are older than six
   * hours, and returns how many it refreshed: each option's token symbol, name and decimals and whether
   * payTo can receive it, and whether the resource's domain claims the owner in its SEP-1 stellar.toml.
   * A domain claim raises trust to `domain_verified`; losing it lowers trust again. Trust changes are
   * public versions; the facts themselves are not versioned content.
   */
  async enrich(limit = 10): Promise<number> {
    const now = this.now();
    const listings = await this.store.staleFacts(limit, new Date(now.getTime() - FACTS_MAX_AGE_MS));
    const domains = new Map<string, Promise<StellarTomlResult>>();
    let refreshed = 0;
    for (const listing of listings) {
      try {
        const facts = await this.factsOf(listing, domains, now);
        await this.store.transaction(listing.id, async (tx) => {
          const current = await tx.get(listing.id);
          if (current === undefined || current.state !== "published") return;
          const trust = facts.domain?.claimsOwner === true ? "domain_verified" : checkedTrust(current);
          if (trust === current.trust) {
            await tx.update({ ...current, facts });
            return;
          }
          const next: Listing = { ...current, facts, trust, version: current.version + 1, lastUpdated: now };
          await tx.update(next, versionOf(next, "domain_verification", now));
        });
        refreshed++;
      } catch {
        // A listing whose facts cannot be read now keeps its old facts and is tried again next round.
      }
    }
    return refreshed;
  }

  private async factsOf(
    listing: Listing,
    domains: Map<string, Promise<StellarTomlResult>>,
    now: Date,
  ): Promise<ListingFacts> {
    const assets = this.assets;
    const options = await Promise.all(
      listing.content.accepts.map(async (option): Promise<OptionFacts> => {
        if (assets === undefined) return {};
        const [token, receivable] = await Promise.all([
          assets.describe(option.network, option.asset),
          assets.receivable(option.network, option.asset, option.payTo),
        ]);
        return { ...(token ?? {}), ...(receivable === undefined ? {} : { receivable }) };
      }),
    );
    const url = new URL(listing.content.resource);
    if (url.protocol !== "https:" && url.protocol !== "http:") return { checkedAt: now, options };
    let claim = domains.get(url.host);
    if (claim === undefined) {
      claim = this.stellarToml(url.host);
      domains.set(url.host, claim);
    }
    const toml = await claim;
    return {
      checkedAt: now,
      options,
      domain: { host: url.host, claimsOwner: toml.ok && toml.accounts.includes(listing.owner) },
    };
  }

  /**
   * Runs due origin checks and returns how many reached a verdict. Each check is isolated: a failure
   * in one is retried on the normal schedule and never holds up the others.
   */
  async checkOrigins(limit = 10): Promise<number> {
    const checks = await this.store.claimOriginChecks(limit, ORIGIN_CLAIM_MS);
    let completed = 0;
    for (const check of checks) {
      // Over its host's budget, a check keeps its claim and runs once the claim lapses: no retry is spent.
      if (!this.spendHostBudget(check.url)) continue;
      try {
        if (await this.checkOrigin(check)) completed++;
      } catch {
        await this.retryOrWithdraw(check).catch(() => undefined);
      }
    }
    return completed;
  }

  private async checkOrigin(check: OriginCheck): Promise<boolean> {
    const listing = await this.store.get(check.listingId);
    if (listing === undefined) {
      await this.store.completeOriginCheck(check);
      return false;
    }
    const response = await this.fetchOrigin(check.url, listing.content.method ?? "GET");
    if (
      response.kind === "unreachable" ||
      (response.kind === "not_payment_required" && transientStatus(response.status))
    ) {
      await this.retryOrWithdraw(check);
      return false;
    }
    const required =
      response.kind === "payment_required" ? usablePaymentRequired(response.paymentRequired) : undefined;
    await this.store.transaction(check.listingId, (tx) =>
      // A definitive answer that is not a usable 402: the resource does not sell what is listed.
      required === undefined ? this.withdraw(tx, check.listingId) : this.applyOrigin(tx, check, required),
    );
    await this.store.completeOriginCheck(check);
    return true;
  }

  /** Counts one origin request against its host's per-minute budget; false when the budget is spent. */
  private spendHostBudget(url: string): boolean {
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      return true;
    }
    const now = this.now().getTime();
    const budget = this.hostBudget.get(host);
    if (budget === undefined || now - budget.since >= 60_000) {
      if (this.hostBudget.size > 10_000) this.hostBudget.clear();
      this.hostBudget.set(host, { since: now, count: 1 });
      return true;
    }
    if (budget.count >= this.originChecksPerHostPerMinute) return false;
    budget.count++;
    return true;
  }

  /** Schedules the next attempt, or withdraws the listing once the retry schedule is exhausted. */
  private async retryOrWithdraw(check: OriginCheck): Promise<void> {
    const delay = ORIGIN_RETRY_DELAYS_MS[check.attempts];
    if (delay !== undefined) {
      await this.store.deferOriginCheck(check, delay);
      return;
    }
    await this.store.transaction(check.listingId, (tx) => this.withdraw(tx, check.listingId));
    await this.store.completeOriginCheck(check);
  }

  private async withdraw(tx: CatalogTransaction, listingId: string): Promise<void> {
    const listing = await tx.get(listingId);
    if (listing === undefined || listing.state === "quarantined") return;
    const now = this.now();
    const quarantined: Listing = {
      ...listing,
      state: "quarantined",
      version: listing.version + 1,
      lastUpdated: now,
    };
    await tx.update(quarantined, versionOf(quarantined, "quarantine", now));
  }

  private async applyOrigin(
    tx: CatalogTransaction,
    check: OriginCheck,
    required: PaymentRequired,
  ): Promise<void> {
    const listing = await tx.get(check.listingId);
    if (listing === undefined) return;
    const now = this.now();
    const options = originOptions(required, listing.identity.network);
    const owners = new Set(options.map((option) => baseAccount(option.payTo)));

    let owner = listing.owner;
    let cause: VersionCause = "origin_verification";
    if (!owners.has(owner)) {
      if (check.proposedOwner !== undefined && owners.has(check.proposedOwner)) {
        owner = check.proposedOwner;
        cause = "ownership_transfer";
      } else {
        if (listing.state !== "quarantined") {
          const quarantined: Listing = {
            ...listing,
            state: "quarantined",
            version: listing.version + 1,
            lastUpdated: now,
          };
          await tx.update(quarantined, versionOf(quarantined, "quarantine", now));
        }
        return;
      }
    }

    const ownerOptions = options.filter((option) => baseAccount(option.payTo) === owner);
    const [first] = ownerOptions;
    if (first === undefined) return;
    const extraction = await extractCandidate(
      {
        payload: {
          x402Version: 2,
          resource: required.resource,
          accepted: first as unknown as PaymentRequirements,
          payload: {},
          ...(required.extensions === undefined ? {} : { extensions: required.extensions }),
        },
        requirements: first as unknown as PaymentRequirements,
        payer: "",
        transaction: "",
      },
      { sandbox: this.sandbox, allowLoopback: this.allowLoopback },
    );
    // The seller's own 402 no longer declares a valid, matching bazaar extension: stop listing it.
    const sameResource =
      extraction.kind === "candidate" &&
      extraction.candidate.identity.resource === listing.identity.resource &&
      extraction.candidate.identity.method === listing.identity.method &&
      extraction.candidate.identity.toolName === listing.identity.toolName;
    if (extraction.kind !== "candidate" || !sameResource) {
      if (listing.state !== "quarantined") {
        const quarantined: Listing = {
          ...listing,
          state: "quarantined",
          version: listing.version + 1,
          lastUpdated: now,
        };
        await tx.update(quarantined, versionOf(quarantined, "quarantine", now));
      }
      return;
    }

    const content = keepExamplePathParams(listing.content, {
      ...extraction.candidate.content,
      accepts: ownerOptions,
    });
    const hash = contentHash(content);
    // A domain claim for the same owner survives an origin check; enrich() re-reads it regularly.
    const trust =
      owner === listing.owner && listing.trust === "domain_verified" ? "domain_verified" : "origin_verified";
    const unchanged =
      hash === listing.contentHash &&
      owner === listing.owner &&
      listing.trust === trust &&
      listing.state === "published";
    if (unchanged) return;
    const verified: Listing = {
      ...listing,
      owner,
      trust,
      state: "published",
      listedAt: listing.listedAt ?? now,
      // New options or a new owner: the facts are read again on the next enrichment round.
      ...(hash === listing.contentHash && owner === listing.owner ? {} : { facts: undefined }),
      content,
      contentHash: hash,
      version: listing.version + 1,
      lastUpdated: now,
    };
    await tx.update(verified, versionOf(verified, cause, now));
  }

  /** Origin checks speak HTTP: they apply to HTTP resources. MCP tools keep first-seen content. */
  private verifiable(candidate: Candidate): boolean {
    return candidate.identity.kind === "http";
  }
}

/**
 * The content a settlement proposes for an existing listing: the settled payment option replaces the
 * option for the same scheme, network, asset and payTo; all other fields come from the candidate.
 */
function mergeContent(existing: ListingContent, proposed: ListingContent): ListingContent {
  const key = (option: PaymentOption) => `${option.scheme}|${option.network}|${option.asset}|${option.payTo}`;
  const incoming = new Map(proposed.accepts.map((option) => [key(option), option]));
  const accepts = existing.accepts.map((option) => incoming.get(key(option)) ?? option);
  for (const option of proposed.accepts) {
    if (!existing.accepts.some((current) => key(current) === key(option))) accepts.push(option);
  }
  return { ...proposed, accepts };
}

const SCHEME = /^[a-z][a-z0-9_-]{0,31}$/;
const AMOUNT = /^\d{1,39}$/;
const MAX_REASON_LENGTH = 300;
const MAX_EXTRA_BYTES = 2_048;

/** A PaymentRequired with an `accepts` array, or undefined for anything else an origin sends. */
function usablePaymentRequired(value: unknown): PaymentRequired | undefined {
  return isRecord(value) && Array.isArray(value["accepts"])
    ? (value as unknown as PaymentRequired)
    : undefined;
}

/**
 * The origin's payment options on `network` that could be published: well-formed Stellar options
 * only. Anything else in the origin's 402 is ignored rather than trusted.
 */
function originOptions(required: PaymentRequired, network: string): PaymentOption[] {
  const options: PaymentOption[] = [];
  for (const entry of required.accepts as unknown[]) {
    if (!isRecord(entry)) continue;
    const { scheme, asset, payTo, amount, maxTimeoutSeconds, extra } = entry;
    if (
      entry["network"] !== network ||
      typeof scheme !== "string" ||
      !SCHEME.test(scheme) ||
      typeof asset !== "string" ||
      !CONTRACT_ADDRESS.test(asset) ||
      typeof payTo !== "string" ||
      !DESTINATION_ADDRESS.test(payTo) ||
      baseAccount(payTo) === undefined ||
      typeof amount !== "string" ||
      !AMOUNT.test(amount) ||
      typeof maxTimeoutSeconds !== "number" ||
      !Number.isInteger(maxTimeoutSeconds) ||
      maxTimeoutSeconds < 1
    ) {
      continue;
    }
    const bounded = isRecord(extra) && Buffer.byteLength(JSON.stringify(extra)) <= MAX_EXTRA_BYTES;
    options.push({ scheme, network, asset, payTo, amount, maxTimeoutSeconds, extra: bounded ? extra : {} });
  }
  return options;
}

/** Answers worth retrying: the origin is down, overloaded or timing out, not saying "no". */
function transientStatus(status: number): boolean {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Reasons can quote buyer input; keep them short enough for any HTTP header. */
export function boundedReason(text: string): string {
  return text.length <= MAX_REASON_LENGTH ? text : `${text.slice(0, MAX_REASON_LENGTH - 1)}…`;
}

/** The trust a published listing has without a domain claim: HTTP listings are origin-verified. */
function checkedTrust(listing: Listing): Trust {
  return listing.identity.kind === "http" ? "origin_verified" : "settled";
}

/**
 * A route-template listing describes every path of its route; the `pathParams` in its input are only
 * the example of whichever path was paid. Keeping the first example means paying `/users/7` after
 * `/users/42` changes nothing, instead of proposing a new version for every path.
 */
function keepExamplePathParams(existing: ListingContent, next: ListingContent): ListingContent {
  if (existing.bazaar.routeTemplate === undefined || next.bazaar.routeTemplate === undefined) return next;
  const before = (existing.bazaar.info["input"] as Record<string, unknown> | undefined)?.["pathParams"];
  const input = next.bazaar.info["input"] as Record<string, unknown> | undefined;
  if (before === undefined || input === undefined) return next;
  return {
    ...next,
    bazaar: { ...next.bazaar, info: { ...next.bazaar.info, input: { ...input, pathParams: before } } },
  };
}

function versionOf(listing: Listing, cause: VersionCause, at: Date, transaction?: string): ListingVersion {
  return {
    listingId: listing.id,
    version: listing.version,
    createdAt: at,
    cause,
    ...(transaction === undefined ? {} : { transaction }),
    owner: listing.owner,
    trust: listing.trust,
    state: listing.state,
    content: listing.content,
  };
}

function rejected(code: BazaarCode, reason?: string, listingId?: string): CatalogOutcome {
  const text = reason !== undefined && reason.trim() !== "" ? reason : bazaarCodes[code].reason;
  return {
    status: "rejected",
    code,
    rejectedReason: boundedReason(text),
    ...(listingId === undefined ? {} : { listingId }),
  };
}

function dropped(candidate: Candidate): { dropped?: readonly string[] } {
  return candidate.dropped.length === 0 ? {} : { dropped: candidate.dropped };
}
