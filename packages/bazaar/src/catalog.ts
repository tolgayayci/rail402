import { randomUUID } from "node:crypto";
import { reportCode } from "@rail402.dev/errors";
import { CONTRACT_ADDRESS, DESTINATION_ADDRESS } from "@rail402.dev/stellar";
import type { PaymentPayload, PaymentRequirements, PaymentRequired } from "@x402/core/types";
import {
  bazaarCodes,
  type BazaarCode,
  type CatalogBackgroundCode,
  type CatalogResultCode,
  type QuarantineReason,
} from "./codes.ts";
import { baseAccount, extractCandidate, type SettledPayment } from "./extract.ts";
import { probeMcpTool, type McpToolProbe } from "./mcp-origin.ts";
import { fetchPaymentRequired, type OriginFetchOptions, type OriginResponse } from "./origin.ts";
import {
  catalogBudgetFor,
  catalogRulesFor,
  unverifiedBudget,
  type CatalogBudget,
  type CatalogRules,
  type NetworkCatalogPolicy,
} from "./policy.ts";
import { fetchStellarTomlAccounts, type StellarTomlResult } from "./stellar-toml.ts";
import { SchemaSandbox, type SchemaLane, type SchemaSandboxes } from "./schema-sandbox.ts";
import {
  contentHash,
  declaresPrivateUsage,
  abandoned,
  expired,
  askingOrder,
  canonicalJson,
  checkCandidates,
  resourceOrigin,
  withPrivateUsage,
  type CatalogStore,
  type CatalogTransaction,
  type QuotaCount,
} from "./store.ts";
import type {
  Candidate,
  CheckCandidate,
  Listing,
  ListingContent,
  ListingFacts,
  ListingState,
  ListingVersion,
  OptionFacts,
  OriginCheck,
  PaymentOption,
  SettledOption,
  ToolCallProposal,
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

/** The catalog's background work: queued settlements, origin checks, Stellar facts and retention. */
export type CatalogPhase = "outbox" | "origin_check" | "enrich" | "retention";

/**
 * Instrumentation seam of the catalog's background work. Implementations must be cheap; anything they
 * throw is contained and never affects cataloging.
 */
export interface CatalogObserver {
  outcome(
    phase: CatalogPhase,
    status: CatalogOutcome["status"],
    code: CatalogResultCode | BazaarCode | CatalogBackgroundCode,
  ): void;
}

export interface CatalogOptions {
  readonly store: CatalogStore;
  /**
   * Validates bazaar schemas: one sandbox for everything, or (in a service) one per network and lane,
   * so one network's or the previews' load never delays another network's cataloging.
   */
  readonly sandbox: SchemaSandbox | SchemaSandboxes;
  /** Accept and fetch loopback resources. Conformance runs only; never on a public deployment. */
  readonly allowLoopback?: boolean;
  /**
   * New listings one payTo may create per hour at one origin, on each network without settings of its
   * own in `networks` (never pubnet, see `networks`). A listing counts only once that origin confirmed
   * a settlement that paid the payTo its price there, and never after an ownership transfer: other
   * hosts, dust payments and handed-over listings cannot use up a seller's quota. A party that pays a
   * seller its full price for a listing can, as any buyer's purchase does. Listings are counted when
   * they are first published; one that would pass the quota waits for room.
   */
  readonly maxNewListingsPerOwnerPerHour?: number;
  /** New listings the settlements of one payer may create per hour, per network, as above. */
  readonly maxNewListingsPerPayerPerHour?: number;
  /** New listings the catalog publishes per hour, per network, as above. */
  readonly maxNewListingsPerHour?: number;
  /** Origin requests one host receives per minute from this process, per network, as above. */
  readonly originChecksPerHostPerMinute?: number;
  /**
   * Budgets and rules per network (CAIP-2 id). A network's own settings win; pubnet's missing
   * settings take pubnet's stricter defaults (`PUBNET_CATALOG_BUDGET`), never the catalog-wide ones
   * above, and pubnet refuses `mcp://` tools whatever is configured.
   */
  readonly networks?: Readonly<Record<string, Partial<NetworkCatalogPolicy>>>;
  /**
   * The largest content a listing may publish, in bytes of JSON (default 36 KiB). A larger listing is
   * refused at cataloging (`bazaar_listing_too_large`) and withdrawn at an origin check
   * (`origin_listing_too_large`), so a discovery page always fits what stock clients accept.
   */
  readonly maxListingBytes?: number;
  /**
   * Origin checks one network's lane runs at a time (default 4). Each network has its own lane, so
   * this bounds the open origin requests per network, not across them.
   */
  readonly originCheckConcurrency?: number;
  /** How long the inline attempt has before a background worker may finish a queued settlement. */
  readonly outboxGraceMs?: number;
  /** Reads token facts and receivability from each network; without it, listings carry no facts. */
  readonly assets?: TokenDirectory;
  /** Reads a domain's SEP-1 stellar.toml ACCOUNTS; replaces the network fetch in tests. */
  readonly stellarToml?: (host: string) => Promise<StellarTomlResult>;
  /**
   * Reads the SEP-1 `home_domain` an account sets on itself on a network (lower-cased, undefined when
   * none). A domain claim counts only when it is two-way: the host's stellar.toml lists the owner and
   * the owner's home_domain names the host. Without this reader no listing reaches `domain_verified`.
   */
  readonly homeDomain?: (network: string, account: string) => Promise<string | undefined>;
  readonly origin?: Omit<OriginFetchOptions, "allowLoopback">;
  /** Replaces the network fetch, for tests. */
  readonly fetchOrigin?: (url: string, method: string) => Promise<OriginResponse>;
  /** Replaces the MCP origin check (an unpaid `tools/call` over MCP), for tests. */
  readonly probeTool?: (url: string, tool: McpToolProbe) => Promise<OriginResponse>;
  readonly now?: () => Date;
  /** Receives the outcome of each queued settlement, origin check and facts refresh. */
  readonly observer?: CatalogObserver;
}

/** The largest content a listing publishes unless configured: 100 such items stay under 3.75 MiB. */
export const DEFAULT_MAX_LISTING_BYTES = 36 * 1024;

/** Payment options a listing publishes at most; an origin's further options are left out. */
export const MAX_LISTING_OPTIONS = 8;

/** Bytes a listing's content takes when published. */
export function listingBytes(content: ListingContent): number {
  return Buffer.byteLength(JSON.stringify(content));
}

/** Retry schedule for origin checks that could not reach the resource. */
const ORIGIN_RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000, 7_200_000, 43_200_000];
/** What a check asked at one URL: the answer, and the settlements weighed against it. */
interface Asked {
  readonly url: string;
  readonly response: OriginResponse;
  /** For an MCP tool whose listed call got no 402, a proposed call's 402 naming its owner. */
  readonly proposed?: OriginResponse;
  readonly payments: readonly SettledOption[];
  /** The candidate whose path it was asked at, for a listing not published. */
  readonly candidate?: CheckCandidate;
}

/** What one question to an origin got: for an MCP tool, the answer to its listed call. */
interface Answer {
  readonly response: OriginResponse;
  /**
   * For an MCP tool whose listed call got no 402, the first 402 to a call its check's settlements
   * proposed that names its owner.
   */
  readonly proposed?: OriginResponse;
  /** False when its host's budget ran out before every call the check's settlements proposed was tried. */
  readonly complete: boolean;
  /** Candidates whose proposed call was tried without a 402 naming the owner, with how (see `asked`). */
  readonly tried: readonly CheckCandidate[];
}

/**
 * A check that could not decide its listing yet, and how this run found its candidates: retried on
 * its schedule when `spend`, otherwise run again once its host's budget has room.
 */
interface Undecided {
  readonly kind: "undecided";
  readonly spend: boolean;
  readonly asked: readonly CheckCandidate[];
}

function undecided(spend: boolean, asked: readonly CheckCandidate[]): Undecided {
  return { kind: "undecided", spend, asked };
}

/** Why an earlier run of a check found a candidate refused, if it did. */
function refusalOf(candidate: CheckCandidate): QuarantineReason | undefined {
  return candidate.asked !== undefined && "refused" in candidate.asked ? candidate.asked.refused : undefined;
}

/** An answer that lists a listing: for whom, how, and the content it would publish. */
interface Listed {
  readonly kind: "listed";
  readonly owner: string;
  readonly cause: VersionCause;
  readonly content: ListingContent;
  readonly allOwnerOptions: readonly PaymentOption[];
  /** The settlement it was weighed for, and whether it paid this answer's price. */
  readonly settled: SettledOption | undefined;
  readonly paidInFull: boolean;
}

/** An answer that does not list a listing, and the reason a withdrawal records. */
interface Refused {
  readonly kind: "refused";
  readonly reason: QuarantineReason;
}

function refused(reason: QuarantineReason): Refused {
  return { kind: "refused", reason };
}

/** Whether an origin's answer is worth asking again: it could not be reached, or did not say "no". */
function transient(response: OriginResponse): boolean {
  return (
    response.kind === "unreachable" ||
    (response.kind === "not_payment_required" && transientStatus(response.status))
  );
}

/**
 * Whether a check may withdraw its listing: any listing not published; a published one only on a
 * check its owner's settlements asked for, at a URL its origin confirmed (its resource, or a route
 * template's confirmed example). A check that only weighs claims, and an example kept from before
 * examples were confirmed, never take a listing down.
 */
function mayWithdraw(listing: Listing, check: OriginCheck): boolean {
  if (listing.state !== "published") return true;
  if (check.reason === "owner_conflict") return false;
  return listing.content.bazaar.routeTemplate === undefined || listing.confirmedExample !== undefined;
}

/**
 * The URL that decides a published listing and weighs every claim: its resource, or the path of the
 * example a route template keeps, spelled as its origin confirmed it, or for a listing not yet listed as
 * a payer paid it. Undefined when that example does not fill its template.
 */
function examplePath(listing: Listing, check: OriginCheck): string | undefined {
  if (listing.content.bazaar.routeTemplate === undefined) return listing.identity.resource;
  if (listing.confirmedExample !== undefined) return listing.confirmedExample;
  const kept = exampleUrl(listing);
  if (kept === undefined || listing.state === "published") return kept;
  // When its check kept that path.
  const paid = checkCandidates(check).find((candidate) => {
    const content = withExampleOf(listing.content, candidate.url);
    return content !== undefined && exampleUrl({ ...listing, content }) === kept;
  });
  return paid?.url ?? kept;
}

/** An hourly quota with no room now, and when it has room again: its earliest listing leaves the hour. */
interface Spent {
  readonly until: Date;
}
/** How long a worker holds a claimed origin check; a fetch takes at most a few seconds. */
const ORIGIN_CLAIM_MS = 60_000;
/** How long a host's budget of origin requests lasts, and a check that spent it waits to go on. */
const HOST_BUDGET_WINDOW_MS = 60_000;
/** How long a worker holds a claimed queued settlement. */
const OUTBOX_CLAIM_MS = 60_000;
/** Retry schedule for queued settlements the catalog store could not take. */
const OUTBOX_RETRY_DELAYS_MS = [10_000, 60_000, 300_000, 1_800_000, 7_200_000];

/** Token facts per network: what each network says about a token and who can receive it. */
export interface TokenDirectory {
  /**
   * The token's symbol, name and decimals; undefined when the contract is not a readable token. Rejects
   * when the network could not be read now: the listing then keeps its old facts and is read again on
   * the next round, instead of being shown without its token's facts until they are next due.
   */
  describe(
    network: string,
    contract: string,
  ): Promise<{ symbol: string; name: string; decimals: number } | undefined>;
  receivable(network: string, contract: string, payTo: string): Promise<boolean | undefined>;
}

/** How long a listing's Stellar facts are trusted before they are read again. */
const FACTS_MAX_AGE_MS = 6 * 3_600_000;
/** Days a listing never published stays withdrawn before `prune` deletes it. */
const ABANDONED_LISTING_DAYS = 7;

/**
 * The Stellar Bazaar catalog. Listings are created only from settled payments and are bound to the
 * payTo the settlement proved. Metadata echoed by the buyer is never published on its own: an HTTP
 * resource or an MCP tool at an http(s) endpoint is listed, and changed, only with what its own 402
 * response (for a tool, its unpaid `tools/call`) says. Only an MCP tool under an `mcp://` URL, which
 * has no origin to ask, is listed from the settlement alone, at trust `settled`.
 */
export class Catalog {
  private readonly store: CatalogStore;
  private readonly sandbox: SchemaSandbox | SchemaSandboxes;
  private readonly allowLoopback: boolean;
  private readonly budgetFallback: Partial<CatalogBudget>;
  private readonly networkPolicies: Readonly<Record<string, Partial<NetworkCatalogPolicy>>>;
  private readonly budgets = new Map<string, CatalogBudget>();
  private readonly rules = new Map<string, CatalogRules>();
  private readonly outboxGraceMs: number;
  private readonly maxListingBytes: number;
  private readonly assets: TokenDirectory | undefined;
  private readonly stellarToml: (host: string) => Promise<StellarTomlResult>;
  private readonly homeDomain:
    ((network: string, account: string) => Promise<string | undefined>) | undefined;
  private readonly hostBudget = new Map<string, { since: number; count: number }>();
  private readonly originLanes = new Set<string>();
  private readonly enrichLanes = new Set<string>();
  private readonly originCheckConcurrency: number;
  private readonly fetchOrigin: (url: string, method: string) => Promise<OriginResponse>;
  private readonly probeTool: (url: string, tool: McpToolProbe) => Promise<OriginResponse>;
  private readonly now: () => Date;
  private readonly observer: CatalogObserver | undefined;

  constructor(options: CatalogOptions) {
    this.store = options.store;
    this.sandbox = options.sandbox;
    this.allowLoopback = options.allowLoopback ?? false;
    this.budgetFallback = {
      ...(options.maxNewListingsPerHour === undefined
        ? {}
        : { maxNewListingsPerHour: options.maxNewListingsPerHour }),
      ...(options.maxNewListingsPerOwnerPerHour === undefined
        ? {}
        : { maxNewListingsPerOwnerPerHour: options.maxNewListingsPerOwnerPerHour }),
      ...(options.maxNewListingsPerPayerPerHour === undefined
        ? {}
        : { maxNewListingsPerPayerPerHour: options.maxNewListingsPerPayerPerHour }),
      ...(options.originChecksPerHostPerMinute === undefined
        ? {}
        : { originChecksPerHostPerMinute: options.originChecksPerHostPerMinute }),
    };
    this.networkPolicies = options.networks ?? {};
    this.outboxGraceMs = options.outboxGraceMs ?? 30_000;
    this.originCheckConcurrency = Math.max(1, Math.floor(options.originCheckConcurrency ?? 4));
    this.maxListingBytes = options.maxListingBytes ?? DEFAULT_MAX_LISTING_BYTES;
    this.assets = options.assets;
    this.stellarToml =
      options.stellarToml ??
      ((host) => fetchStellarTomlAccounts(host, { allowLoopback: this.allowLoopback }));
    this.homeDomain = options.homeDomain;
    this.now = options.now ?? (() => new Date());
    this.observer = options.observer;
    this.fetchOrigin =
      options.fetchOrigin ??
      ((url, method) =>
        fetchPaymentRequired(url, method, { ...options.origin, allowLoopback: this.allowLoopback }));
    this.probeTool =
      options.probeTool ?? ((url, tool) => probeMcpTool(url, tool, { allowLoopback: this.allowLoopback }));
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
      { sandbox: this.sandboxFor(requirements.network, "preview"), allowLoopback: this.allowLoopback },
    );
    if (extraction.kind === "absent") return undefined;
    // A preview is advisory: a busy validator decides nothing, and settlement validates on its own lane.
    if (extraction.kind === "rejected" && extraction.busy === true) {
      return {
        status: "processing",
        code: "awaiting_settlement",
        reason: "The discovery metadata is still being checked; it is cataloged once the payment settles.",
      };
    }
    if (extraction.kind === "rejected") return rejected(extraction.code, extraction.reason);
    // At /verify the amount is what is offered: for upto the cap, the most the settlement can move.
    const refused = this.refusal(extraction.candidate, requirements.amount);
    if (refused !== undefined) return refused;
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
    const unproven = unprovenSettlement(payment);
    if (unproven !== undefined) return rejected(unproven);
    let queued = true;
    try {
      await this.store.enqueueSettlement(payment, this.outboxGraceMs);
    } catch {
      // The queue is a safety net; cataloging itself does not depend on it.
      queued = false;
    }
    const { outcome, retry } = await this.attempt(payment);
    if (!queued) return outcome;
    // A store outage or a busy schema validator decided nothing: the queued entry stays, and a worker
    // retries it once its grace period has passed.
    if (retry) {
      return outcome?.code === "bazaar_catalog_unavailable"
        ? outcome
        : {
            status: "processing",
            code: "cataloging_in_progress",
            reason:
              "The payment settled; its discovery metadata is validated again shortly and cataloging continues in the background.",
          };
    }
    await this.store.completeSettlement(payment.transaction).catch(() => undefined);
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
      let retry: boolean;
      try {
        ({ outcome, retry } = await this.attempt(payment));
      } catch {
        outcome = rejected("bazaar_catalog_unavailable");
        retry = true;
      }
      if (outcome !== undefined) this.observe("outbox", outcome.status, outcome.code);
      if (retry) {
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
    return (await this.attempt(payment)).outcome;
  }

  /**
   * Catalogs a settled payment, and says whether the outcome decided nothing and is worth retrying:
   * the store was unavailable or the schema validator was busy.
   */
  private async attempt(
    payment: SettledPayment,
  ): Promise<{ outcome: CatalogOutcome | undefined; retry: boolean }> {
    const outcome = await this.catalogOnce(payment);
    return { outcome: outcome?.outcome, retry: outcome?.retry ?? false };
  }

  private async catalogOnce(
    payment: SettledPayment,
  ): Promise<{ outcome: CatalogOutcome; retry: boolean } | undefined> {
    const decided = (outcome: CatalogOutcome) => ({ outcome, retry: false });
    // A listing is bound to a transaction that moved value to its payTo; without one there is nothing
    // to prove.
    if (payment.payload.extensions?.["bazaar"] !== undefined) {
      const unproven = unprovenSettlement(payment);
      if (unproven !== undefined) return decided(rejected(unproven));
    }
    const extraction = await extractCandidate(payment, {
      sandbox: this.sandboxFor(payment.requirements.network, "catalog"),
      allowLoopback: this.allowLoopback,
    });
    if (extraction.kind === "absent") return undefined;
    if (extraction.kind === "rejected") {
      return { outcome: rejected(extraction.code, extraction.reason), retry: extraction.busy === true };
    }
    const candidate = extraction.candidate;
    // Checked before any write: a refused candidate creates nothing and changes nothing.
    const refused = this.refusal(candidate, payment.requirements.amount);
    if (refused !== undefined) return decided(refused);
    try {
      return decided(
        await this.store.transaction(candidate.identity, (tx) =>
          this.apply(tx, candidate, payment.requirements.amount),
        ),
      );
    } catch {
      return { outcome: rejected("bazaar_catalog_unavailable"), retry: true };
    }
  }

  /** The sandbox validating `network`'s schemas for `lane`. */
  private sandboxFor(network: string, lane: SchemaLane): SchemaSandbox {
    return this.sandbox instanceof SchemaSandbox ? this.sandbox : this.sandbox.for(network, lane);
  }

  /** Catalogs a settled candidate; `settled` is the amount the settlement moved, in base units. */
  private async apply(
    tx: CatalogTransaction,
    candidate: Candidate,
    settled: string,
  ): Promise<CatalogOutcome> {
    const now = this.now();
    // The amount settled, not the listed price: an upto listing shows its cap, its payments what they
    // charged.
    const observation = {
      transaction: candidate.transaction,
      payer: candidate.payer,
      payTo: candidate.owner,
      asset: candidate.content.accepts[0]?.asset ?? "",
      amount: settled,
      observedAt: now,
    };
    const existing = await tx.find(candidate.identity);
    const earlier = await tx.observedListing(candidate.transaction);
    if (earlier !== undefined && earlier !== existing?.id) return rejected("bazaar_settlement_reused");

    if (existing === undefined) {
      // Every quota counts this network's listings only: another network's traffic never uses it up.
      const { network } = candidate.identity;
      const budget = this.budgetFor(network);
      const hourAgo = new Date(now.getTime() - 3_600_000);
      // Any host can answer a 402 naming any payTo, so a payTo's quota is kept per origin, and only
      // listings that origin confirmed a full-price settlement for count (see quotaCharge).
      const origin = resourceOrigin(candidate.identity.resource);
      if (
        (await tx.countCreatedBy(candidate.owner, network, origin, hourAgo)).count >=
        budget.maxNewListingsPerOwnerPerHour
      ) {
        return rejected(
          "bazaar_rate_limited",
          "This payTo has created too many new listings at this origin recently; the resource will be cataloged on a later settlement.",
        );
      }
      if (
        (await tx.countCreatedByPayer(candidate.payer, network, hourAgo)) >=
        budget.maxNewListingsPerPayerPerHour
      ) {
        return rejected(
          "bazaar_rate_limited",
          "This payer's settlements created too many new listings recently; the resource will be cataloged on a later settlement.",
        );
      }
      // A resource with an origin is listed only once its own 402 response confirms what the buyer
      // echoed: until then anyone could list any public URL under their own payTo, or plant a tool
      // description and price under a seller's payTo by paying it one base unit.
      const verifiable = this.verifiable(candidate);
      // A tool no origin can confirm is listed from any payer's settlement at once, so such tools are
      // counted apart, within a share of their own: they never use up what sellers with an origin need.
      const limits = verifiable ? budget : unverifiedBudget(budget);
      if ((await tx.countListedSince(network, hourAgo, !verifiable)).count >= limits.maxNewListingsPerHour) {
        return rejected(
          "bazaar_rate_limited",
          `The catalog published too many new listings on ${network} recently; the resource will be cataloged on a later settlement.`,
        );
      }
      if ((await tx.countPublished(network, !verifiable)) >= limits.maxPublishedListings) {
        return catalogFull(network);
      }
      if (verifiable && (await this.ownerFull(tx, network, candidate.owner))) {
        return ownerFull(network);
      }
      // A route template's example is the path that was paid, never the pathParams the payer echoed.
      const content = withExampleOf(candidate.content, candidate.concreteUrl) ?? candidate.content;
      const listing: Listing = {
        id: randomUUID(),
        sequence: 0,
        identity: candidate.identity,
        owner: candidate.owner,
        trust: "settled",
        state: verifiable ? "pending" : "published",
        version: 1,
        content,
        contentHash: contentHash(content),
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
      await tx.requestOriginCheck(
        listing.id,
        "created",
        candidate.concreteUrl,
        undefined,
        settledOption(candidate, settled),
      );
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

    // The private-usage opt-out only ratchets one way from a settlement: a payload that declares it
    // keeps the listing's usage private at once, and nothing a payer sends can clear it. Only content
    // the listing's origin confirms (`verify`) can remove it again.
    const ratchet = declaresPrivateUsage(candidate.content) && !declaresPrivateUsage(existing.content);
    const current: Listing = ratchet
      ? (() => {
          const content = withPrivateUsage(existing.content);
          return {
            ...existing,
            content,
            contentHash: contentHash(content),
            version: existing.version + 1,
            lastUpdated: now,
          };
        })()
      : existing;
    const stats: Listing = { ...current, lastSettledAt: now, settlements: existing.settlements + 1 };
    const proposed = keepExamplePathParams(
      existing.content,
      mergeContent(existing.content, candidate.content),
    );
    await tx.update(stats, ratchet ? versionOf(stats, "settlement", now, candidate.transaction) : undefined);
    // A tool without an origin is withdrawn only when it expires: its owner's settlement lists it again,
    // with its first content, as long as the network has room.
    if (!this.verifiable(candidate) && existing.state !== "published") {
      const { network } = candidate.identity;
      if (
        (await tx.countPublished(network, true)) >=
        unverifiedBudget(this.budgetFor(network)).maxPublishedListings
      ) {
        return catalogFull(network, existing.id);
      }
      const listed: Listing = {
        ...stats,
        state: "published",
        version: stats.version + 1,
        lastUpdated: now,
      };
      await tx.update(listed, versionOf(listed, "settlement", now, candidate.transaction));
      return { status: "success", code: "cataloged", listingId: existing.id, version: listed.version };
    }
    // A pending or quarantined listing is re-checked on every settlement, so a seller that fixes its
    // 402 response gets it listed again, and a genuine settlement replaces content a payer planted.
    // A payload that made the usage private is checked too: the origin's answer decides whether it stays.
    const recheck =
      this.verifiable(candidate) &&
      (ratchet || contentHash(proposed) !== stats.contentHash || existing.state !== "published");
    if (recheck) {
      await tx.requestOriginCheck(
        existing.id,
        "changed",
        candidate.concreteUrl,
        undefined,
        settledOption(candidate, settled),
        proposedCall(candidate),
      );
      return {
        status: "processing",
        code: "awaiting_origin_verification",
        reason:
          existing.state === "published"
            ? "The listing's metadata or price changed; the change is published once the resource's own 402 response confirms it."
            : "The resource is listed once its own 402 response confirms the payment options and metadata.",
        listingId: existing.id,
        version: stats.version,
        ...dropped(candidate),
      };
    }
    return {
      status: "success",
      code: "recorded",
      ...(contentHash(proposed) === stats.contentHash
        ? {}
        : {
            reason:
              "The settlement was recorded. An MCP tool under an mcp:// URL has no origin to check, so its metadata is not changed by later settlements.",
          }),
      listingId: existing.id,
      version: stats.version,
      ...dropped(candidate),
    };
  }

  /**
   * Refreshes the Stellar facts of published listings that have none or whose facts are older than six
   * hours, and returns how many it refreshed: each option's token symbol, name and decimals and whether
   * payTo can receive it, and whether the resource's domain claims the owner under SEP-1 both ways: the
   * host's stellar.toml lists the owner in ACCOUNTS, and the owner's account sets the host as its
   * home_domain. A one-way claim proves nothing (any domain can list any account), so only the two-way
   * binding raises trust to `domain_verified`, and only for a listing whose content its origin
   * confirmed: a domain vouches for its owner, not for what a buyer echoed. Losing the binding lowers
   * trust to `origin_verified` again. Trust changes are public versions; the facts themselves are not
   * versioned content.
   */
  async enrich(limit = 10): Promise<number> {
    const before = new Date(this.now().getTime() - FACTS_MAX_AGE_MS);
    // One lane per network, as for origin checks: slow RPC reads or stellar.toml hosts of one network's
    // listings never hold up another network's facts and domain trust. A busy lane is skipped.
    const networks = (await this.store.staleFactsNetworks(before)).filter(
      (network) => !this.enrichLanes.has(network),
    );
    const refreshed = await Promise.all(
      networks.map((network) => this.enrichNetwork(network, limit, before)),
    );
    return refreshed.reduce((sum, count) => sum + count, 0);
  }

  /** Whether an earlier call's facts lane for `network` is still running. */
  enrichingFacts(network: string): boolean {
    return this.enrichLanes.has(network);
  }

  private async enrichNetwork(network: string, limit: number, before: Date): Promise<number> {
    if (this.enrichLanes.has(network)) return 0;
    this.enrichLanes.add(network);
    try {
      const now = this.now();
      const listings = await this.store.staleFacts(limit, before, network);
      const domains = new Map<string, Promise<StellarTomlResult>>();
      let refreshed = 0;
      for (const listing of listings) {
        try {
          const facts = await this.factsOf(listing, domains, now);
          await this.store.transaction(listing.id, async (tx) => {
            const current = await tx.get(listing.id);
            if (current === undefined || current.state !== "published") return;
            const bound = facts.domain?.claimsOwner === true && facts.domain.homeDomainMatches;
            const trust =
              current.trust === "settled" ? "settled" : bound ? "domain_verified" : "origin_verified";
            if (trust === current.trust) {
              await tx.update({ ...current, facts });
              return;
            }
            const next: Listing = {
              ...current,
              facts,
              trust,
              version: current.version + 1,
              lastUpdated: now,
            };
            await tx.update(next, versionOf(next, "domain_verification", now));
          });
          refreshed++;
          this.observe("enrich", "success", "facts_refreshed");
        } catch {
          // A listing whose facts cannot be read now keeps its old facts and is tried again next round.
          this.observe("enrich", "processing", "facts_unavailable");
        }
      }
      return refreshed;
    } finally {
      this.enrichLanes.delete(network);
    }
  }

  /**
   * Withdraws published listings past their network's retention (see CatalogBudget) and returns how
   * many it withdrew, at most `limit` per network: listings no origin ever confirmed whose last
   * settlement is older than `unverifiedListingTtlHours`, and any listing idle for longer than
   * `idleListingTtlDays` when that is set. Each becomes a `quarantine` version with reason
   * `listing_expired`; its owner's next settlement lists it again.
   */
  async expire(limit = 100): Promise<number> {
    const now = this.now();
    let withdrawn = 0;
    for (const network of await this.store.publishedNetworks()) {
      const budget = this.budgetFor(network);
      const unverifiedBefore = new Date(now.getTime() - budget.unverifiedListingTtlHours * 3_600_000);
      const idleBefore =
        budget.idleListingTtlDays > 0
          ? new Date(now.getTime() - budget.idleListingTtlDays * 86_400_000)
          : undefined;
      for (const listing of await this.store.expiredListings(network, unverifiedBefore, idleBefore, limit)) {
        const done = await this.store.transaction(listing.id, async (tx) => {
          const current = await tx.get(listing.id);
          // A settlement since the read keeps the listing.
          if (current?.state !== "published" || !expired(current, unverifiedBefore, idleBefore)) return false;
          await this.withdraw(tx, current.id, "listing_expired");
          return true;
        });
        if (done) {
          withdrawn++;
          this.observe("retention", "rejected", "listing_expired");
        }
      }
    }
    await this.prune(limit);
    return withdrawn;
  }

  /**
   * Deletes up to `limit` listings that were never published and have stayed withdrawn for
   * ABANDONED_LISTING_DAYS, with their versions, and returns how many it deleted. Any payer can create
   * such a listing for any https resource, and its content, which its origin never confirmed, was never
   * public; deleting it keeps what free settlements can store bounded by the payer quotas over that
   * time. A later settlement for the resource creates it again.
   */
  async prune(limit = 100): Promise<number> {
    const before = new Date(this.now().getTime() - ABANDONED_LISTING_DAYS * 86_400_000);
    let deleted = 0;
    for (const listing of await this.store.abandonedListings(before, limit)) {
      const done = await this.store.transaction(listing.identity, async (tx) => {
        const current = await tx.get(listing.id);
        // A settlement or check since the read keeps the listing.
        if (current === undefined || !abandoned(current, before)) return false;
        await tx.remove(current.id);
        return true;
      });
      if (done) {
        deleted++;
        this.observe("retention", "rejected", "listing_pruned");
      }
    }
    return deleted;
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
      domain: {
        host: url.host,
        claimsOwner: toml.ok && toml.accounts.includes(listing.owner),
        homeDomainMatches: await this.namesHost(listing, url.hostname),
      },
    };
  }

  /** Whether the owner's account sets `hostname` as its home_domain on a network the listing is paid on. */
  private async namesHost(listing: Listing, hostname: string): Promise<boolean> {
    const reader = this.homeDomain;
    if (reader === undefined) return false;
    const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const networks = [...new Set(listing.content.accepts.map((option) => option.network))];
    for (const network of networks) {
      if ((await reader(network, listing.owner)) === host) return true;
    }
    return false;
  }

  /**
   * Runs due origin checks and returns how many reached a verdict. Each network has its own lane: up to
   * `limit` of its checks are claimed and run, `originCheckConcurrency` at a time, while the other
   * networks' lanes run alongside. A network whose lane is still busy from an earlier call is skipped,
   * so slow or unanswering origins on one network never delay another network's checks. Each check is
   * isolated: a failure in one is retried on the normal schedule and never holds up the others.
   */
  async checkOrigins(limit = 10): Promise<number> {
    const networks = (await this.store.originCheckNetworks()).filter(
      (network) => !this.originLanes.has(network),
    );
    const completed = await Promise.all(networks.map((network) => this.checkNetworkOrigins(network, limit)));
    return completed.reduce((sum, count) => sum + count, 0);
  }

  /** Whether an earlier call's lane for `network` is still running its checks. */
  checkingOrigins(network: string): boolean {
    return this.originLanes.has(network);
  }

  private async checkNetworkOrigins(network: string, limit: number): Promise<number> {
    if (this.originLanes.has(network)) return 0;
    this.originLanes.add(network);
    try {
      const checks = await this.store.claimOriginChecks(limit, ORIGIN_CLAIM_MS, network);
      let completed = 0;
      let next = 0;
      const worker = async () => {
        while (next < checks.length) {
          const check = checks[next++];
          if (check !== undefined && (await this.runOriginCheck(check))) completed++;
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.originCheckConcurrency, checks.length) }, worker));
      return completed;
    } finally {
      this.originLanes.delete(network);
    }
  }

  private async runOriginCheck(check: OriginCheck): Promise<boolean> {
    try {
      const listing = await this.store.get(check.listingId);
      if (listing === undefined) {
        await this.store.completeOriginCheck(check);
        return false;
      }
      // A listing never published waits, without asking its origin, while its network has published as
      // many new listings this hour as it may: the check could not publish it now.
      const spent =
        listing.listedAt === undefined
          ? await this.store.transaction(listing.id, (tx) =>
              this.newListingsSpent(tx, listing.identity.network),
            )
          : undefined;
      if (spent !== undefined) {
        await this.waitForRoom(check, spent);
        return false;
      }
      return await this.checkOrigin(check, listing);
    } catch {
      await this.retryOrWithdraw(check).catch(() => undefined);
      return false;
    }
  }

  /** Whether `owner` holds as many listings an origin confirmed on `network` as one payTo may. */
  private async ownerFull(tx: CatalogTransaction, network: string, owner: string): Promise<boolean> {
    const share = this.budgetFor(network).maxPublishedListingsPerOwner;
    return share > 0 && (await tx.countPublishedBy(network, owner)) >= share;
  }

  /** The budget `network` catalogs under, resolved once per network. */
  budgetFor(network: string): CatalogBudget {
    let budget = this.budgets.get(network);
    if (budget === undefined) {
      budget = catalogBudgetFor(network, this.networkPolicies[network], this.budgetFallback);
      this.budgets.set(network, budget);
    }
    return budget;
  }

  /** The rules `network` catalogs under, resolved once per network. */
  rulesFor(network: string): CatalogRules {
    let rules = this.rules.get(network);
    if (rules === undefined) {
      rules = catalogRulesFor(network, this.networkPolicies[network]);
      this.rules.set(network, rules);
    }
    return rules;
  }

  /**
   * Why the network's rules refuse a candidate, if they do: a tool without an origin where originless
   * tools are refused, or a settlement below the network's minimum for its asset.
   */
  private refusal(candidate: Candidate, settled: unknown): CatalogOutcome | undefined {
    const { network } = candidate.identity;
    if (listingBytes(candidate.content) > this.maxListingBytes) {
      return rejected(
        "bazaar_listing_too_large",
        `The listing would publish more than ${String(this.maxListingBytes)} bytes; shorten its info, schema or description.`,
      );
    }
    const rules = this.rulesFor(network);
    if (!this.verifiable(candidate) && rules.originlessMcp === "refuse") {
      return rejected(
        "bazaar_resource_unverifiable",
        `Tools without an https endpoint cannot be verified and are not cataloged on ${network}.`,
      );
    }
    const asset = candidate.content.accepts[0]?.asset ?? "";
    const minimum = rules.minSettled[asset];
    if (
      minimum !== undefined &&
      (typeof settled !== "string" || !/^\d{1,39}$/.test(settled) || BigInt(settled) < minimum)
    ) {
      return rejected(
        "bazaar_settlement_below_minimum",
        `Settlements of this asset catalog resources on ${network} from ${minimum.toString()} base units.`,
      );
    }
    return undefined;
  }

  /**
   * Asks a listing's origin and acts on its answers. A published listing is decided by one answer
   * only, at its example path (its resource, for a listing that is no route template): nothing at a
   * path a payer chose changes or withdraws it. A listing not published is listed from an answer at a
   * path its owner's payers paid that confirms it for its owner. Either moves to a claimant only when
   * its example path names that claimant and not its owner. A run asks what it can within its host's
   * budget, in asking order (`askingOrder`): one answer that lists the listing for its owner is enough,
   * and a run that ran out of budget before deciding records what it found, so the next run goes on
   * from there.
   */
  private async checkOrigin(check: OriginCheck, listing: Listing): Promise<boolean> {
    const ask = this.originAsker(listing, check);
    const candidates = checkCandidates(check);
    const payments = candidates.flatMap((candidate) =>
      candidate.settled === undefined ? [] : [candidate.settled],
    );
    const claimed = (check.proposedOwners ?? []).length > 0;
    const path = examplePath(listing, check);
    const answers = new Set<Answer>();
    let example: Asked | undefined;
    const asked: Asked[] = [];
    let budgetLeft = true;
    if (listing.state === "published") {
      if (path !== undefined) {
        // Over its host's budget, a check keeps its claim and runs once the claim lapses.
        const answer = await ask(path);
        if (answer === undefined) return false;
        answers.add(answer);
        example = {
          url: path,
          response: answer.response,
          ...(answer.proposed === undefined ? {} : { proposed: answer.proposed }),
          payments,
        };
      }
    } else {
      // A tool is asked once, for every candidate's payment; a resource at each candidate's path.
      const order = listing.identity.kind === "mcp" ? candidates : askingOrder(candidates);
      for (const candidate of order) {
        const answer = await ask(candidate.url);
        if (answer === undefined) {
          budgetLeft = false;
          break;
        }
        answers.add(answer);
        asked.push({
          url: candidate.url,
          response: answer.response,
          ...(answer.proposed === undefined ? {} : { proposed: answer.proposed }),
          payments: candidate.settled === undefined ? [] : [candidate.settled],
          candidate,
        });
      }
      if (budgetLeft && claimed && path !== undefined) {
        const answer = await ask(path);
        if (answer === undefined) budgetLeft = false;
        else {
          answers.add(answer);
          example = { url: path, response: answer.response, payments };
        }
      }
      if (!budgetLeft && asked.length === 0) return false;
    }
    const complete = budgetLeft && [...answers].every((answer) => answer.complete);
    const tried = [...answers].flatMap((answer) => answer.tried);
    const outcome = await this.store.transaction(check.listingId, (tx) =>
      this.decide(tx, check, { example, asked, complete, tried }),
    );
    if (typeof outcome === "object" && "kind" in outcome) {
      if (outcome.spend) await this.retryOrWithdraw(check, outcome.asked);
      else await this.store.deferOriginCheck(check, HOST_BUDGET_WINDOW_MS, false, outcome.asked);
      return false;
    }
    if (typeof outcome === "object") {
      await this.waitForRoom(check, outcome);
      return false;
    }
    await this.store.completeOriginCheck(check);
    if (outcome === "quarantined") this.observe("origin_check", "rejected", "origin_withdrawn");
    else this.observe("origin_check", "success", "origin_confirmed");
    return true;
  }

  /**
   * What a run's answers do to its listing: the spent quota when it would be first published while a
   * quota is spent, the check undecided when an answer that could decide it was a passing error or it
   * ran out of its host's budget first, and otherwise the listing's state afterwards.
   */
  private async decide(
    tx: CatalogTransaction,
    check: OriginCheck,
    run: {
      readonly example: Asked | undefined;
      readonly asked: readonly Asked[];
      /** Whether it asked everything it needed: every candidate not refused, and every proposed call. */
      readonly complete: boolean;
      /** For an MCP tool, the candidates whose proposed call it tried without a 402. */
      readonly tried: readonly CheckCandidate[];
    },
  ): Promise<Undecided | Spent | ListingState | undefined> {
    const { example, asked, complete, tried } = run;
    const listing = await tx.get(check.listingId);
    if (listing === undefined) return undefined;
    const progressed = (found: readonly CheckCandidate[]) => found.some((c) => refusalOf(c) !== undefined);
    if (listing.state === "published") {
      // A route template without a usable example has nothing that may change it.
      if (example === undefined) return listing.state;
      if (transient(example.response)) return undecided(true, tried);
      // A tool whose listed call is answered without a 402 is updated from a call its owner's payers
      // proposed only when that call's 402 lists it for its owner; its listed call decides otherwise.
      if (example.proposed !== undefined) {
        const confirmed = await this.verdict(
          listing,
          check,
          { ...example, response: example.proposed },
          "owner",
        );
        if (confirmed.kind === "listed") {
          const spent = await this.list(tx, listing, confirmed, example.url, false);
          return spent ?? (await tx.get(listing.id))?.state;
        }
      }
      const owned = await this.verdict(listing, check, example, "owner");
      const verdict =
        owned.kind === "refused" && owned.reason === "origin_owner_mismatch"
          ? await this.verdict(listing, check, example, "claimant")
          : owned;
      if (verdict.kind === "listed") {
        const spent = await this.list(tx, listing, verdict, example.url, false);
        if (spent !== undefined) return spent;
      } else if (!complete) {
        // A tool whose listed call fails goes on with the calls not tried yet.
        return undecided(!progressed(tried), tried);
      } else if (mayWithdraw(listing, check)) {
        await this.withdraw(tx, listing.id, owned.kind === "refused" ? owned.reason : verdict.reason);
      }
      return (await tx.get(listing.id))?.state;
    }
    // Not published: an answer at a path its owner's payers paid that lists it for its owner, one
    // whose settlement paid that answer's own price before others, and the first asked among those.
    const tool = listing.identity.kind === "mcp";
    const found: CheckCandidate[] = [...tried];
    const reasons: QuarantineReason[] = [];
    const listings: { asked: Asked; verdict: Listed }[] = [];
    for (const answer of asked) {
      // A tool's proposed call lists it only with a 402 that lists it for its owner; its listed call's
      // answer decides otherwise.
      const proposed =
        answer.proposed === undefined
          ? undefined
          : await this.verdict(listing, check, { ...answer, response: answer.proposed }, "owner");
      if (proposed?.kind === "listed") {
        listings.push({ asked: answer, verdict: proposed });
        continue;
      }
      if (transient(answer.response)) {
        if (!tool && answer.candidate !== undefined) {
          found.push({ ...answer.candidate, asked: { failed: true } });
        }
        continue;
      }
      const verdict = await this.verdict(listing, check, answer, "owner");
      if (verdict.kind === "listed") {
        listings.push({ asked: answer, verdict });
        continue;
      }
      reasons.push(verdict.reason);
      if (!tool && answer.candidate !== undefined) {
        found.push({ ...answer.candidate, asked: { refused: verdict.reason } });
      }
    }
    const chosen = listings.find(({ verdict }) => verdict.paidInFull) ?? listings[0];
    // Out of budget before asking everything, with only answers to payments below the price: a
    // candidate not asked yet that would pay that price is asked first.
    const unasked = askingOrder(checkCandidates(check)).filter(
      (candidate) =>
        (candidate.asked === undefined || "failed" in candidate.asked) &&
        !asked.some((answer) => answer.candidate === candidate),
    );
    const waits =
      !complete &&
      chosen !== undefined &&
      !chosen.verdict.paidInFull &&
      unasked.some((candidate) =>
        paidInFull(candidate.settled, listing.owner, chosen.verdict.allOwnerOptions),
      );
    if (chosen !== undefined && !waits) {
      const spent = await this.list(tx, listing, chosen.verdict, chosen.asked.url, true);
      return spent ?? (await tx.get(listing.id))?.state;
    }
    for (const { asked: answer } of listings) {
      if (answer.candidate !== undefined) found.push({ ...answer.candidate, asked: { underpaid: true } });
    }
    const failing =
      asked.some((answer) => transient(answer.response)) ||
      (example !== undefined && transient(example.response));
    // Out of budget before asking everything: it goes on from what it found, or backs off while what
    // it asks fails or it found nothing new.
    if (!complete) return undecided(failing || !(waits || progressed(found)), found);
    // Else a claimant its example path names, and not its owner.
    if (example !== undefined && !transient(example.response)) {
      const verdict = await this.verdict(listing, check, example, "claimant");
      if (verdict.kind === "listed") {
        const spent = await this.list(tx, listing, verdict, example.url, true);
        return spent ?? (await tx.get(listing.id))?.state;
      }
    }
    if (failing) return undecided(true, found);
    const reason =
      reasons[0] ??
      checkCandidates(check)
        .map(refusalOf)
        .find((refusal) => refusal !== undefined);
    if (reason !== undefined) await this.withdraw(tx, listing.id, reason);
    return (await tx.get(listing.id))?.state;
  }

  /**
   * Whether an origin's answer lists a listing: for its owner, or for the first of the check's
   * claimants it names when it does not name the owner. The content it would publish, or why not.
   */
  private async verdict(
    listing: Listing,
    check: OriginCheck,
    asked: Asked,
    who: "owner" | "claimant",
  ): Promise<Listed | Refused> {
    const { response } = asked;
    const required =
      response.kind === "payment_required" ? usablePaymentRequired(response.paymentRequired) : undefined;
    if (required === undefined) {
      return refused(
        response.kind === "tool_not_listed" ? "origin_tool_not_listed" : "origin_not_payment_required",
      );
    }
    const { network } = listing.identity;
    const options = originOptions(required, network);
    const named = new Set(options.map((option) => baseAccount(option.payTo)));
    let owner = listing.owner;
    let cause: VersionCause = "origin_verification";
    if (who === "claimant") {
      const claimant = (check.proposedOwners ?? []).find((candidate) => named.has(candidate));
      if (named.has(listing.owner) || claimant === undefined) return refused("origin_owner_mismatch");
      owner = claimant;
      cause = "ownership_transfer";
    } else if (!named.has(owner)) {
      return refused("origin_owner_mismatch");
    }
    const allOwnerOptions = options.filter((option) => baseAccount(option.payTo) === owner);
    // The settlement this answer is weighed for: one that paid its price, else the latest.
    const paid =
      asked.payments.find((payment) => paidInFull(payment, owner, allOwnerOptions)) ?? asked.payments.at(-1);
    const ownerOptions = publishedOptions(allOwnerOptions, paid);
    const [first] = ownerOptions;
    if (first === undefined) return refused("origin_owner_mismatch");
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
      { sandbox: this.sandboxFor(network, "catalog"), allowLoopback: this.allowLoopback },
    );
    // A busy validator decided nothing: the check is retried on its schedule, never held against the
    // listing.
    if (extraction.kind === "rejected" && extraction.busy === true) {
      throw new Error("the schema validator is busy");
    }
    // The answer no longer declares a valid, matching bazaar extension.
    const sameResource =
      extraction.kind === "candidate" &&
      extraction.candidate.identity.resource === listing.identity.resource &&
      extraction.candidate.identity.method === listing.identity.method &&
      extraction.candidate.identity.toolName === listing.identity.toolName;
    if (extraction.kind !== "candidate" || !sameResource) return refused("origin_metadata_mismatch");
    // An MCP tool whose content its origin never confirmed may have been created by anyone paying the
    // owner: it is published only if the tool itself offers a payment settled for it, the one that
    // created it or one its check keeps. A later settlement adds what it paid and never narrows it.
    if (listing.identity.kind === "mcp" && listing.trust === "settled") {
      const settled = checkCandidates(check).flatMap((candidate) =>
        candidate.settled === undefined ? [] : [candidate.settled],
      );
      const expected = [...listing.content.accepts, ...settled];
      // Matched against every option the tool offers its owner, before the published options are capped.
      if (!allOwnerOptions.some((option) => expected.some((payment) => samePayment(option, payment)))) {
        return refused("origin_payment_mismatch");
      }
    }
    const content: ListingContent = { ...extraction.candidate.content, accepts: ownerOptions };
    // A resource whose own 402 describes more than a listing may publish is not listed.
    if (listingBytes(content) > this.maxListingBytes) return refused("origin_listing_too_large");
    return {
      kind: "listed",
      owner,
      cause,
      content,
      allOwnerOptions,
      settled: paid,
      paidInFull: paidInFull(paid, owner, allOwnerOptions),
    };
  }

  /**
   * Asks a listing's origin for one check, at most once per URL: a second question takes the first
   * answer. A tool is called as its listing describes, then, when that call is not answered with a
   * 402, with each call its check's settlements proposed (their example arguments may have changed
   * since it was listed), in asking order and skipping those an earlier run refused; only a 402 to one
   * of those that names the owner is taken, apart from the listed call's answer, so a payload's
   * arguments can confirm a tool but never fail the check of one that answers its listed call. A
   * published tool whose listed call fails for now is not called with them: it is retried. Each request
   * counts against the host's budget: undefined when that is spent before the first, and an incomplete
   * answer when it runs out among the proposed calls.
   */
  private originAsker(listing: Listing, check: OriginCheck): (url: string) => Promise<Answer | undefined> {
    const answers = new Map<string, Promise<Answer | undefined>>();
    const { network } = listing.identity;
    const request = async (url: string): Promise<Answer | undefined> => {
      if (!this.spendHostBudget(network, url)) return undefined;
      if (listing.identity.kind !== "mcp") {
        const response = await this.fetchOrigin(url, listing.content.method ?? "GET");
        return { response, complete: true, tried: [] };
      }
      const { toolName } = listing.identity;
      const listed = toolCall(listing.content);
      const answer = await this.probeTool(url, { toolName, ...listed });
      if (answer.kind === "payment_required" || answer.kind === "tool_not_listed") {
        return { response: answer, complete: true, tried: [] };
      }
      // A published tool whose listed call fails for now is asked again later, as an example path
      // that fails for now is: a call a payer proposed never decides it.
      if (listing.state === "published" && transient(answer)) {
        return { response: answer, complete: true, tried: [] };
      }
      const calls = new Map<string, CheckCandidate["asked"]>([[canonicalJson(listed), undefined]]);
      const tried: CheckCandidate[] = [];
      for (const candidate of askingOrder(checkCandidates(check))) {
        const proposed = candidate.probe;
        if (proposed === undefined) continue;
        const call = canonicalJson(proposed);
        if (calls.has(call)) {
          // The same call as one tried in this run: found alike.
          const outcome = calls.get(call);
          if (outcome !== undefined) tried.push({ ...candidate, asked: outcome });
          continue;
        }
        if (!this.spendHostBudget(network, url)) return { response: answer, complete: false, tried };
        const retried = await this.probeTool(url, { toolName, ...proposed });
        // Only a 402 naming the owner is taken: another payTo's, at a payer's arguments, never decides.
        if (retried.kind === "payment_required" && namesOwner(retried, listing)) {
          return { response: answer, proposed: retried, complete: true, tried };
        }
        const outcome: CheckCandidate["asked"] = transient(retried)
          ? { failed: true }
          : {
              refused:
                retried.kind === "payment_required"
                  ? "origin_owner_mismatch"
                  : retried.kind === "tool_not_listed"
                    ? "origin_tool_not_listed"
                    : "origin_not_payment_required",
            };
        calls.set(call, outcome);
        tried.push({ ...candidate, asked: outcome });
      }
      return { response: answer, complete: true, tried };
    };
    return (url) => {
      let answer = answers.get(url);
      if (answer === undefined) {
        answer = request(url);
        answers.set(url, answer);
      }
      return answer;
    };
  }

  /**
   * Counts one origin request for a listing on `network` against its host's per-minute budget on that
   * network; false when the budget is spent.
   */
  private spendHostBudget(network: string, url: string): boolean {
    let host: string;
    try {
      host = new URL(url).host;
    } catch {
      return true;
    }
    const key = `${network} ${host}`;
    const now = this.now().getTime();
    const budget = this.hostBudget.get(key);
    if (budget === undefined || now - budget.since >= HOST_BUDGET_WINDOW_MS) {
      if (this.hostBudget.size > 10_000) this.hostBudget.clear();
      this.hostBudget.set(key, { since: now, count: 1 });
      return true;
    }
    if (budget.count >= this.budgetFor(network).originChecksPerHostPerMinute) return false;
    budget.count++;
    return true;
  }

  /**
   * Whether `network` has published as many new listings an origin confirmed in the last hour as its
   * budget allows, and if so when it has room again. The count holds until `tx` ends, so a listing
   * published on it takes a free place.
   */
  private async newListingsSpent(tx: CatalogTransaction, network: string): Promise<Spent | undefined> {
    const now = this.now();
    const counted = await tx.countListedSince(network, new Date(now.getTime() - 3_600_000), false);
    return counted.count >= this.budgetFor(network).maxNewListingsPerHour
      ? spentUntil(counted, now)
      : undefined;
  }

  /**
   * Runs a check again once the quota that holds its listing back has room, when the earliest listing
   * it counts leaves the hour; waiting spends no retry, and the origin is not asked meanwhile.
   */
  private async waitForRoom(check: OriginCheck, spent: Spent): Promise<void> {
    this.observe("origin_check", "processing", "publication_deferred");
    const delay = Math.max(spent.until.getTime() - this.now().getTime(), 0) + QUOTA_MARGIN_MS;
    await this.store.deferOriginCheck(check, delay, false);
  }

  /**
   * Schedules the next attempt, or withdraws the listing once the retry schedule is exhausted, when
   * the check may withdraw it (see `mayWithdraw`); otherwise the check just ends.
   */
  private async retryOrWithdraw(check: OriginCheck, asked: readonly CheckCandidate[] = []): Promise<void> {
    const delay = ORIGIN_RETRY_DELAYS_MS[check.attempts];
    // A run a settlement made due before the scheduled retry waits for that retry: only scheduled runs
    // spend one, so the schedule keeps its times however often settlements come.
    if (delay !== undefined || check.early === true) {
      this.observe("origin_check", "processing", "origin_retry");
      await this.store.deferOriginCheck(check, delay ?? 0, true, asked);
      return;
    }
    const withdrawn = await this.store.transaction(check.listingId, async (tx) => {
      const listing = await tx.get(check.listingId);
      if (listing === undefined || !mayWithdraw(listing, check)) return false;
      await this.withdraw(tx, check.listingId, "origin_unreachable");
      return true;
    });
    if (withdrawn) this.observe("origin_check", "rejected", "origin_withdrawn");
    await this.store.completeOriginCheck(check);
  }

  /**
   * Quarantines a listing, recording why on its new version. A quarantined listing gets a new version
   * only when the reason changed, so its history always says why it is withdrawn now.
   */
  private async withdraw(tx: CatalogTransaction, listingId: string, reason: QuarantineReason): Promise<void> {
    const listing = await tx.get(listingId);
    if (listing === undefined) return;
    if (listing.state === "quarantined" && (await tx.latestReason(listingId)) === reason) return;
    const now = this.now();
    const quarantined: Listing = {
      ...listing,
      state: "quarantined",
      version: listing.version + 1,
      lastUpdated: now,
    };
    await tx.update(quarantined, { ...versionOf(quarantined, "quarantine", now), reason });
  }

  /**
   * Lists a listing as an origin's answer confirmed it (`verdict`), and returns the spent quota when it
   * would be first published while its network's or its owner's hourly quota of new listings is spent.
   * A listing not published takes its route template's example from `url`, the path whose answer lists
   * it (`retake`); a published one keeps its example, which its answer at `url` just confirmed. Either
   * way `url`, spelled as it was asked, is the example its origin confirmed.
   */
  private async list(
    tx: CatalogTransaction,
    listing: Listing,
    verdict: Listed,
    url: string,
    retake: boolean,
  ): Promise<Spent | undefined> {
    const now = this.now();
    const { owner, cause, allOwnerOptions } = verdict;
    const template = listing.content.bazaar.routeTemplate !== undefined;
    const retaken = retake ? withExampleOf(verdict.content, url) : undefined;
    const content =
      retaken ?? (retake ? verdict.content : keepExamplePathParams(listing.content, verdict.content));
    const confirmedExample = template && (retaken !== undefined || !retake) ? url : listing.confirmedExample;
    const hash = contentHash(content);
    // A domain claim for the same owner survives an origin check; enrich() re-reads it regularly.
    const trust =
      owner === listing.owner && listing.trust === "domain_verified" ? "domain_verified" : "origin_verified";
    const unchanged =
      hash === listing.contentHash &&
      owner === listing.owner &&
      listing.trust === trust &&
      listing.state === "published";
    const charge = await this.quotaCharge(tx, listing, owner, verdict.settled, allOwnerOptions, now);
    // A listing's first publication takes a place in its network's hourly quota of new listings, and in
    // its owner's at its origin when it is charged there. While either is spent it waits for room, so
    // listings created, or staged pending, in any number never publish past the quotas at once.
    if (listing.listedAt === undefined) {
      const owners = charge !== undefined && !(charge instanceof Date) ? charge : undefined;
      const network = await this.newListingsSpent(tx, listing.identity.network);
      // Both must have room: it waits for the later of the two.
      if (owners !== undefined || network !== undefined) {
        return [owners, network].reduce<Spent>(
          (later, spent) => (spent !== undefined && spent.until > later.until ? spent : later),
          { until: now },
        );
      }
    }
    // A listing not yet published takes a place in its network's catalog only while there is room.
    if (
      !unchanged &&
      listing.state !== "published" &&
      ((await tx.countPublished(listing.identity.network, false)) >=
        this.budgetFor(listing.identity.network).maxPublishedListings ||
        (await this.ownerFull(tx, listing.identity.network, listing.owner)))
    ) {
      await this.withdraw(tx, listing.id, "catalog_full");
      return;
    }
    const quotaChargedAt = charge instanceof Date ? charge : undefined;
    if (unchanged) {
      // Only the quota charge and the confirmed example may change; they are not part of the
      // published record.
      if (
        quotaChargedAt?.getTime() !== listing.quotaChargedAt?.getTime() ||
        confirmedExample !== listing.confirmedExample
      ) {
        await tx.update({ ...listing, quotaChargedAt, confirmedExample });
      }
      return;
    }
    const verified: Listing = {
      ...listing,
      owner,
      trust,
      state: "published",
      listedAt: listing.listedAt ?? now,
      quotaChargedAt,
      confirmedExample,
      // New options or a new owner: the facts are read again on the next enrichment round.
      ...(hash === listing.contentHash && owner === listing.owner ? {} : { facts: undefined }),
      content,
      contentHash: hash,
      version: listing.version + 1,
      lastUpdated: now,
    };
    await tx.update(verified, versionOf(verified, cause, now));
    return undefined;
  }

  /**
   * From when a listing its origin just confirmed for `owner` counts toward the owner's hourly quota of
   * new listings at its origin: from its first publication, once its origin confirmed a settlement
   * that paid the owner the price there (`paidInFull`), so a listing staged pending for hours counts in
   * the hour it is published. Dust payments, such as one base unit for each spelling of a route that a
   * seller's server answers alike, therefore never use up the seller's quota. A transfer charges
   * nobody: it creates no listing, and the claim that moved the listing paid the new owner nothing the
   * check can see. Spent when the listing would count in the current hour while the owner's quota at
   * the origin is full: it is never charged past the quota, and a listing not yet published waits.
   */
  private async quotaCharge(
    tx: CatalogTransaction,
    listing: Listing,
    owner: string,
    settled: SettledOption | undefined,
    ownerOptions: readonly PaymentOption[],
    now: Date,
  ): Promise<Date | Spent | undefined> {
    if (owner !== listing.owner) return undefined;
    if (listing.quotaChargedAt !== undefined) return listing.quotaChargedAt;
    if (!paidInFull(settled, owner, ownerOptions)) return undefined;
    const { network } = listing.identity;
    const hourAgo = new Date(now.getTime() - 3_600_000);
    const chargedAt = listing.listedAt ?? now;
    if (chargedAt.getTime() < hourAgo.getTime()) return chargedAt;
    const counted = await tx.countCreatedBy(
      owner,
      network,
      resourceOrigin(listing.identity.resource),
      hourAgo,
    );
    return counted.count >= this.budgetFor(network).maxNewListingsPerOwnerPerHour
      ? spentUntil(counted, now)
      : chargedAt;
  }

  private observe(
    phase: CatalogPhase,
    status: CatalogOutcome["status"],
    code: CatalogResultCode | BazaarCode | CatalogBackgroundCode,
  ): void {
    try {
      this.observer?.outcome(phase, status, code);
    } catch {
      // Instrumentation never affects cataloging.
    }
  }

  /**
   * Whether a candidate has an origin to check: every HTTP resource, and every MCP tool at an http(s)
   * endpoint. Only a tool under an `mcp://` URL has none, and keeps its first-seen content.
   */
  private verifiable(candidate: Candidate): boolean {
    return candidate.identity.kind === "http" || /^https?:\/\//.test(candidate.concreteUrl);
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

/** Whether an origin's 402 offers an option on the listing's network that pays its owner. */
function namesOwner(response: OriginResponse, listing: Listing): boolean {
  const required =
    response.kind === "payment_required" ? usablePaymentRequired(response.paymentRequired) : undefined;
  return (
    required !== undefined &&
    originOptions(required, listing.identity.network).some(
      (option) => baseAccount(option.payTo) === listing.owner,
    )
  );
}

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

/**
 * The payment option a candidate's settlement paid, as its listing publishes it, and `settled`, the
 * amount it moved.
 */
function settledOption(candidate: Candidate, settled: string): SettledOption | undefined {
  const option = candidate.content.accepts[0];
  return option === undefined ? undefined : { ...option, settledAmount: settled };
}

/**
 * The options a listing publishes: the origin's first `MAX_LISTING_OPTIONS`, in its order. When the
 * settled option is further down, it takes the last place, so a listing always publishes what was paid.
 */
function publishedOptions(
  options: readonly PaymentOption[],
  settled: PaymentOption | undefined,
): PaymentOption[] {
  const kept = options.slice(0, MAX_LISTING_OPTIONS);
  if (settled === undefined || kept.some((option) => samePayment(option, settled))) return kept;
  const paid = options.find((option) => samePayment(option, settled));
  return paid === undefined ? kept : [...kept.slice(0, MAX_LISTING_OPTIONS - 1), paid];
}

/** A quota is counted from `since` on: it waits this much past the hour, so the earliest has left it. */
const QUOTA_MARGIN_MS = 1_000;

/**
 * When a spent quota has room again: once the earliest listing it counts leaves the hour, or an hour
 * from `now` when it counts none (a quota of 0).
 */
function spentUntil(counted: QuotaCount, now: Date): Spent {
  return { until: new Date((counted.earliest ?? now).getTime() + 3_600_000) };
}

/**
 * Whether a settlement paid `owner` at least the price its origin confirmed: one of the origin's
 * options for the owner, in the settled scheme, network and asset, costs no more than the settlement
 * moved. For `upto` that takes a settlement of the whole cap; signing the cap moves nothing.
 */
function paidInFull(
  settled: SettledOption | undefined,
  owner: string,
  ownerOptions: readonly PaymentOption[],
): boolean {
  const moved = settled?.settledAmount;
  if (settled === undefined || moved === undefined || !AMOUNT.test(moved)) return false;
  if (baseAccount(settled.payTo) !== owner) return false;
  return ownerOptions.some(
    (option) =>
      option.scheme === settled.scheme &&
      option.network === settled.network &&
      option.asset === settled.asset &&
      BigInt(option.amount) <= BigInt(moved),
  );
}

/** Whether an origin's option offers the settled payment: scheme, network, asset, payTo and price. */
function samePayment(option: PaymentOption, settled: PaymentOption): boolean {
  return (
    option.scheme === settled.scheme &&
    option.network === settled.network &&
    option.asset === settled.asset &&
    option.payTo === settled.payTo &&
    option.amount === settled.amount
  );
}

/**
 * How an MCP origin check calls a tool unpaid: over the transport the content declares, with its
 * example arguments, so a server that validates arguments before asking for payment still answers
 * with its 402.
 */
function toolCall(content: ListingContent): ToolCallProposal {
  const input = content.bazaar.info["input"];
  const declared = isRecord(input) ? input : {};
  const transport = declared["transport"];
  const example = declared["example"];
  return {
    ...(typeof transport === "string" ? { transport } : {}),
    ...(isRecord(example) ? { arguments: example } : {}),
  };
}

/**
 * The unpaid call an owner's settlement proposes for an MCP tool at an http(s) endpoint, as its payload
 * declares it; undefined for any other resource.
 */
function proposedCall(candidate: Candidate): ToolCallProposal | undefined {
  return candidate.identity.kind === "mcp" ? toolCall(candidate.content) : undefined;
}

/**
 * A route-template listing describes every path of its route; the `pathParams` in its input are only
 * its example: the path that created it, then the one the check that listed it asked (see
 * `withExampleOf`). Keeping it means paying `/users/7` after `/users/42` changes nothing, instead of
 * proposing a new version for every path.
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

/**
 * `content` with its route template's example set to the path of `url`: each `:name` segment of the
 * template takes the decoded segment of `url` at its place. Undefined when `content` has no route
 * template or `url` is not a path of it.
 */
function withExampleOf(content: ListingContent, url: string): ListingContent | undefined {
  const template = content.bazaar.routeTemplate;
  const input = content.bazaar.info["input"];
  if (template === undefined || !isRecord(input)) return undefined;
  let segments: string[];
  try {
    segments = new URL(url).pathname.split("/");
  } catch {
    return undefined;
  }
  const names = template.split("/");
  if (segments.length !== names.length) return undefined;
  const pathParams: Record<string, string> = {};
  for (const [index, name] of names.entries()) {
    if (!name.startsWith(":")) continue;
    let value: string;
    try {
      value = decodeURIComponent(segments[index] ?? "");
    } catch {
      return undefined;
    }
    if (value === "") return undefined;
    pathParams[name.slice(1)] = value;
  }
  return {
    ...content,
    bazaar: { ...content.bazaar, info: { ...content.bazaar.info, input: { ...input, pathParams } } },
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
  reportCode(code);
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

/**
 * Why a settled payment cannot vouch for a listing, if it cannot: it settled without a transaction
 * (an off-chain zero `upto` settlement), or it moved nothing. An `upto` settlement of zero needs no
 * balance and no trustline, so anyone could otherwise catalog under any payTo and price for free.
 */
function unprovenSettlement(
  payment: SettledPayment,
): "bazaar_settlement_offchain" | "bazaar_settlement_zero" | undefined {
  if (payment.transaction === "") return "bazaar_settlement_offchain";
  const amount = payment.requirements.amount;
  if (typeof amount !== "string" || !/^\d{1,39}$/.test(amount) || BigInt(amount) === 0n) {
    return "bazaar_settlement_zero";
  }
  return undefined;
}

/** The refusal of a new listing while its payTo holds as many published listings as one may. */
function ownerFull(network: string): CatalogOutcome {
  return rejected(
    "bazaar_catalog_full",
    `This payTo holds as many published listings on ${network} as one seller may; the resource will be cataloged on a later settlement once one of them expires.`,
  );
}

/** The refusal of a new listing while its network holds as many published listings as it may. */
function catalogFull(network: string, listingId?: string): CatalogOutcome {
  return rejected(
    "bazaar_catalog_full",
    `The catalog holds as many listings on ${network} as it publishes; the resource will be cataloged on a later settlement once listings expire.`,
    listingId,
  );
}

/**
 * The concrete URL of a route-template listing's example: its template with each `:name` segment
 * filled from the example `pathParams` it keeps. Undefined when the example does not fill the template.
 */
function exampleUrl(listing: Listing): string | undefined {
  const template = listing.content.bazaar.routeTemplate;
  if (template === undefined) return undefined;
  const input = listing.content.bazaar.info["input"];
  const params = isRecord(input) && isRecord(input["pathParams"]) ? input["pathParams"] : {};
  let origin: string;
  try {
    origin = new URL(listing.identity.resource).origin;
  } catch {
    return undefined;
  }
  const segments: string[] = [];
  for (const segment of template.split("/")) {
    if (!segment.startsWith(":")) {
      segments.push(segment);
      continue;
    }
    const value = params[segment.slice(1)];
    if ((typeof value !== "string" && typeof value !== "number") || String(value) === "") return undefined;
    segments.push(encodeURIComponent(String(value)));
  }
  return `${origin}${segments.join("/")}`;
}
