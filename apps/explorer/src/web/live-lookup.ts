import {
  LedgerSourceError,
  checkLumeusKey,
  isPublishableLumeusKey,
  lumeusHostNetwork,
  request,
  type Fetch,
} from "@rail402.dev/ledger-source";
import { xdr } from "@stellar/stellar-sdk";
import {
  classifyTransaction,
  decodeXdr,
  envelopeHashes,
  EventIntegrityError,
  networkId,
  type Classification,
  type ClassifyContext,
  type IndexNetwork,
} from "@rail402.dev/x402-index";
import { explorerError } from "../api/paging.ts";
import { clientKey } from "./client-key.ts";
import { HASH } from "./text.ts";

/** A token bucket per key; `take` returns 0 or the seconds until a token frees up. */
export class TokenBuckets {
  readonly #buckets = new Map<string, { tokens: number; at: number }>();
  readonly #capacity: number;
  readonly #perMs: number;
  readonly #now: () => number;
  readonly #maxKeys: number;

  constructor(perMinute: number, options: { burst?: number; now?: () => number; maxKeys?: number } = {}) {
    this.#capacity = Math.max(1, options.burst ?? perMinute);
    this.#perMs = perMinute / 60_000;
    this.#now = options.now ?? Date.now;
    this.#maxKeys = options.maxKeys ?? 100_000;
  }

  take(key: string): number {
    const now = this.#now();
    const bucket = this.#buckets.get(key);
    const tokens =
      bucket === undefined
        ? this.#capacity
        : Math.min(this.#capacity, bucket.tokens + (now - bucket.at) * this.#perMs);
    if (tokens < 1) {
      this.#buckets.set(key, { tokens, at: now });
      return Math.max(1, Math.ceil((1 - tokens) / this.#perMs / 1_000));
    }
    if (bucket === undefined && this.#buckets.size >= this.#maxKeys) this.sweep();
    this.#buckets.set(key, { tokens: tokens - 1, at: now });
    return 0;
  }

  /** Gives back a token taken by `take`, when the request it paid for did not go ahead. */
  refund(key: string): void {
    const bucket = this.#buckets.get(key);
    if (bucket !== undefined) bucket.tokens = Math.min(this.#capacity, bucket.tokens + 1);
  }

  /** Whether `key` has its whole burst available (it spent nothing recently). */
  full(key: string): boolean {
    const bucket = this.#buckets.get(key);
    if (bucket === undefined) return true;
    return bucket.tokens + (this.#now() - bucket.at) * this.#perMs >= this.#capacity;
  }

  /** Forgets buckets that have refilled, bounding memory. */
  sweep(): void {
    const now = this.#now();
    for (const [key, bucket] of this.#buckets) {
      if (bucket.tokens + (now - bucket.at) * this.#perMs >= this.#capacity) this.#buckets.delete(key);
    }
  }

  get size(): number {
    return this.#buckets.size;
  }
}

/** Keys remembered for a time, oldest dropped first beyond `maxEntries`. */
class ExpiringSet {
  readonly #entries = new Map<string, number>();
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #now: () => number;

  constructor(ttlMs: number, max: number, now: () => number) {
    this.#ttlMs = ttlMs;
    this.#max = max;
    this.#now = now;
  }

  has(key: string): boolean {
    const until = this.#entries.get(key);
    if (until === undefined) return false;
    if (until > this.#now()) return true;
    this.#entries.delete(key);
    return false;
  }

  add(key: string): void {
    this.#entries.delete(key);
    this.#entries.set(key, this.#now() + this.#ttlMs);
    while (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }
}

/** One transaction as RPC `getTransaction` returns it, classified under the same rules as the index. */
export interface LiveResult {
  readonly classification: Classification;
  readonly ledger: number;
  readonly closedAt: string;
}

export interface LookupBudget {
  /** Live lookups per client per minute. */
  readonly perClientPerMinute: number;
  /** Live lookups per minute across every client, per network. */
  readonly globalPerMinute: number;
  /**
   * The share of the global budget kept for clients making their first lookup in a minute (default
   * 0.25), so a few busy clients cannot leave nothing for everyone else.
   */
  readonly reservedShare?: number;
  /** How long a hash the RPC did not know is answered from memory. */
  readonly negativeTtlMs: number;
  readonly negativeEntries?: number;
  /** How long a found, not yet indexed transaction is answered from memory (default 60 s). */
  readonly positiveTtlMs?: number;
}

/** The default budget: a handful per visitor, a bounded total, and repeated misses served from memory. */
export const lookupBudget: LookupBudget = {
  perClientPerMinute: 6,
  globalPerMinute: 60,
  reservedShare: 0.25,
  negativeTtlMs: 20_000,
  negativeEntries: 10_000,
  positiveTtlMs: 60_000,
};

export interface LiveLookupOptions {
  readonly network: IndexNetwork;
  /** The RPC used only for these lookups (https), never the facilitator's settlement provider. */
  readonly rpcUrl: string;
  /**
   * A Lumeus key for this network, sent as `Authorization: Bearer` only when `rpcUrl` is this network's
   * Lumeus RPC (any other host, or a key of the other network, is refused). A read-access server key or a
   * publishable key (`lum_pub_…`, read-only RPC) keeps the indexer's key out of the internet-facing role.
   * Read it from a secret file; it never appears in an answer, a log or an error.
   */
  readonly apiKey?: string;
  /**
   * The Origin sent with a publishable key, one of the key's allowed origins (the Explorer's public
   * origin). Required with a publishable key.
   */
  readonly origin?: string;
  readonly context: ClassifyContext;
  readonly budget?: LookupBudget;
  readonly fetch?: Fetch;
  readonly timeoutMs?: number;
  readonly now?: () => number;
}

export type LookupOutcome =
  | { readonly kind: "found"; readonly result: LiveResult }
  | { readonly kind: "not_found"; readonly cached: boolean };

interface RpcTransaction {
  readonly status: "SUCCESS" | "FAILED" | "NOT_FOUND";
  readonly ledger?: number;
  readonly createdAt?: string | number;
  readonly applicationOrder?: number;
  readonly envelopeXdr?: string;
  readonly resultXdr?: string;
  readonly resultMetaXdr?: string;
}

/**
 * Looks up a hash the index does not hold yet, through RPC `getTransaction`, and classifies it with the
 * index's own classifier, so a payment opens seconds after it settles. Every lookup passes, in order: the
 * hash syntax check, the negative cache, the per-client budget and the network's global budget.
 * Concurrent lookups of one hash share one RPC call.
 */
export class LiveLookup {
  readonly network: IndexNetwork;
  readonly #options: LiveLookupOptions;
  readonly #url: URL;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #perClient: TokenBuckets;
  readonly #global: TokenBuckets;
  readonly #reserve: TokenBuckets | undefined;
  readonly #misses: ExpiringSet;
  readonly #found = new Map<string, { readonly outcome: LookupOutcome; readonly until: number }>();
  readonly #positiveTtlMs: number;
  readonly #now: () => number;
  readonly #inFlight = new Map<string, Promise<LookupOutcome>>();
  #id = 0;
  /** RPC calls made, for metrics and tests. */
  calls = 0;

  constructor(options: LiveLookupOptions) {
    const url = new URL(options.rpcUrl);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
      throw new TypeError("the lookup RPC URL must be https without credentials");
    }
    if (options.apiKey !== undefined) {
      if (lumeusHostNetwork(url.host) !== options.network) {
        throw new TypeError(`a Lumeus key is sent only to the Lumeus RPC host of ${options.network}`);
      }
      checkLumeusKey(options.apiKey, options.network, { publishable: true });
    }
    const publishable = options.apiKey !== undefined && isPublishableLumeusKey(options.apiKey);
    let origin: string | undefined;
    if (publishable) {
      const parsed = options.origin === undefined ? undefined : new URL(options.origin);
      if (parsed?.protocol !== "https:") {
        throw new TypeError("a publishable Lumeus key needs the https origin it is allowed for");
      }
      origin = parsed.origin;
    }
    this.network = options.network;
    this.#url = url;
    this.#headers =
      options.apiKey === undefined
        ? {}
        : { authorization: `Bearer ${options.apiKey}`, ...(origin === undefined ? {} : { origin }) };
    this.#options = options;
    const budget = options.budget ?? lookupBudget;
    const now = options.now ?? Date.now;
    this.#perClient = new TokenBuckets(budget.perClientPerMinute, { now });
    const reserved = Math.max(0, Math.min(1, budget.reservedShare ?? 0.25));
    const reservePerMinute = Math.floor(budget.globalPerMinute * reserved);
    this.#global = new TokenBuckets(Math.max(1, budget.globalPerMinute - reservePerMinute), { now });
    this.#reserve = reservePerMinute >= 1 ? new TokenBuckets(reservePerMinute, { now }) : undefined;
    this.#positiveTtlMs = budget.positiveTtlMs ?? 60_000;
    this.#now = now;
    this.#misses = new ExpiringSet(budget.negativeTtlMs, budget.negativeEntries ?? 10_000, now);
  }

  /**
   * Throws `explorer_lookup_busy` when a budget is spent and `explorer_lookup_unavailable` when the RPC
   * fails; both are retryable and never cached.
   */
  async lookup(hash: string, client: string): Promise<LookupOutcome> {
    if (!HASH.test(hash)) return { kind: "not_found", cached: false };
    if (this.#misses.has(hash)) return { kind: "not_found", cached: true };
    const cached = this.#found.get(hash);
    if (cached !== undefined && cached.until > this.#now()) return cached.outcome;
    if (cached !== undefined) this.#found.delete(hash);
    const shared = this.#inFlight.get(hash);
    if (shared !== undefined) return shared;
    // An IPv6 client is one /64; its own budget is checked before any shared token is spent.
    const key = clientKey(client);
    const first = this.#perClient.full(key);
    const clientWait = this.#perClient.take(key);
    if (clientWait > 0) throw explorerError("explorer_lookup_busy", { details: { retryAfter: clientWait } });
    const globalWait = this.#global.take("all");
    if (globalWait > 0) {
      // The reserve serves only a client's first lookup in a minute, so busy clients cannot drain it.
      const reserveWait = first && this.#reserve !== undefined ? this.#reserve.take("all") : globalWait;
      if (reserveWait > 0) {
        this.#perClient.refund(key);
        throw explorerError("explorer_lookup_busy", {
          details: { retryAfter: Math.min(globalWait, reserveWait) },
        });
      }
    }
    const pending = this.#fetch(hash)
      .then((outcome) => {
        if (outcome.kind === "found") this.#remember(hash, outcome);
        return outcome;
      })
      .finally(() => this.#inFlight.delete(hash));
    this.#inFlight.set(hash, pending);
    return pending;
  }

  /** Keeps a found transaction for a short time, so repeated views of a fresh link cost nothing. */
  #remember(hash: string, outcome: LookupOutcome): void {
    this.#found.set(hash, { outcome, until: this.#now() + this.#positiveTtlMs });
    while (this.#found.size > 10_000) {
      const oldest = this.#found.keys().next().value;
      if (oldest === undefined) break;
      this.#found.delete(oldest);
    }
  }

  async #fetch(hash: string): Promise<LookupOutcome> {
    this.calls++;
    let transaction: RpcTransaction;
    try {
      const response = await request(
        this.#url,
        {
          maxBytes: 4 * 1024 * 1024,
          timeoutMs: this.#options.timeoutMs ?? 8_000,
          attempts: 1,
          ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
        },
        {
          method: "POST",
          headers: this.#headers,
          json: { jsonrpc: "2.0", id: ++this.#id, method: "getTransaction", params: { hash } },
        },
      );
      if (response.status !== 200) throw new LedgerSourceError("http_status", "the RPC answered 404");
      const body = JSON.parse(response.body.toString("utf8")) as { result?: RpcTransaction };
      if (body.result === undefined) throw new LedgerSourceError("rpc_error", "getTransaction: no result");
      transaction = body.result;
    } catch (error) {
      throw explorerError("explorer_lookup_unavailable", { cause: error });
    }
    if (transaction.status === "NOT_FOUND") {
      this.#misses.add(hash);
      return { kind: "not_found", cached: false };
    }
    const ledger = Number(transaction.ledger);
    const createdAt = Number(transaction.createdAt);
    if (
      !Number.isSafeInteger(ledger) ||
      !Number.isFinite(createdAt) ||
      transaction.envelopeXdr === undefined ||
      transaction.resultXdr === undefined ||
      transaction.resultMetaXdr === undefined
    ) {
      throw explorerError("explorer_lookup_unavailable", {
        reason: "The RPC's getTransaction answer is incomplete.",
      });
    }
    // The answer must be the transaction asked for: its envelope hashes (outer, or inner for a fee
    // bump) on this network must include the requested hash, or a faulty RPC could show any
    // transaction under any link.
    if (!answersFor(transaction.envelopeXdr, hash, this.#options.context.passphrase)) {
      throw explorerError("explorer_lookup_unavailable", {
        reason: "The RPC answered with another transaction than the one asked for.",
      });
    }
    const closedAt = new Date(createdAt * 1000).toISOString();
    let classification: Classification;
    try {
      classification = classifyTransaction(
        {
          envelopeXdr: transaction.envelopeXdr,
          resultXdr: transaction.resultXdr,
          metaXdr: transaction.resultMetaXdr,
          ledger,
          txIndex: transaction.applicationOrder ?? 0,
          closedAt,
        },
        this.#options.context,
      );
    } catch (error) {
      throw explorerError("explorer_lookup_unavailable", {
        reason:
          error instanceof EventIntegrityError
            ? "The RPC's answer does not hold together: the transaction's events do not match its result."
            : "The transaction's meta is in a format these rules do not read yet.",
        cause: error,
      });
    }
    return { kind: "found", result: { classification, ledger, closedAt } };
  }
}

/** Whether a base64 envelope's network hash, or its inner transaction's, is `hash`. */
export function answersFor(envelopeXdr: string, hash: string, passphrase: string): boolean {
  const envelope = decodeXdr(xdr.TransactionEnvelope, envelopeXdr);
  if (envelope === undefined) return false;
  try {
    const hashes = envelopeHashes(envelope, networkId(passphrase));
    return hashes.hash === hash || hashes.innerHash === hash;
  } catch {
    return false;
  }
}
