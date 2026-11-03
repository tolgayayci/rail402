import { createHmac } from "node:crypto";
import type { Fetch } from "@rail402.dev/ledger-source";
import type { IndexNetwork } from "@rail402.dev/x402-index";
import type { WebMetrics } from "./metrics.ts";
import { HASH } from "./text.ts";

/**
 * The Bazaar's public read API over HTTP: listings, their history, and which listing a settled payment
 * bought. The web role never reads the facilitator's database. Everything here is off-chain metadata:
 * pages label it so and never count it, and every string in it is untrusted text.
 *
 * Calls fail soft: an error or a timeout is `down` and the page renders without Bazaar data. A 404 from
 * a usage route is `none` (no data), so an Explorer can run against a Bazaar that does not serve those
 * routes yet. Answers are cached for a short time and concurrent calls for one key share one request.
 *
 * Every call belongs to one page request (`forRequest`): the request's visitor, so a Bazaar access key
 * charges each visitor's own discovery budget, and one deadline shared by all of the page's calls, so a
 * slow Bazaar delays a page by that much at most.
 */

/** A listing as the usage routes name it (`ListingRef`): the option of the network it was settled on. */
export interface ListingRef {
  readonly id: string;
  readonly type: "http" | "mcp";
  readonly resource: string;
  readonly method?: string;
  readonly toolName?: string;
  readonly description?: string;
  readonly serviceName?: string;
  readonly payTo: string;
  readonly scheme: string;
  /** Atomic units, as the payment requirements give them. */
  readonly amount: string;
  readonly asset: string;
  readonly network: string;
  readonly lastUpdated: string;
}

/** A listing as `/discovery/resources` shows it, for one network. */
export interface Listing extends ListingRef {
  readonly mimeType?: string;
  readonly trust?: string;
  readonly state?: string;
  readonly contentWithheld?: boolean;
  readonly maxTimeoutSeconds?: number;
  readonly routeTemplate?: string;
  /** The bazaar extension's `info.input` and `info.output`, as published (untrusted). */
  readonly input?: unknown;
  readonly output?: unknown;
  readonly firstCataloged?: string;
  readonly version?: number;
  readonly x402Version?: number;
  readonly feesSponsored?: boolean;
}

export interface PaidFor {
  readonly transaction: string;
  readonly listing: ListingRef;
  readonly observedAt: string;
}

export interface ResourceUsage {
  readonly listingId: string;
  readonly payments: number;
  readonly payers: number;
  readonly firstObservedAt: string | null;
  readonly lastObservedAt: string | null;
  readonly recent: readonly {
    readonly transaction: string;
    readonly payer: string;
    readonly asset: string;
    readonly amount: string;
    readonly observedAt: string;
  }[];
}

export interface SellerUsage {
  readonly payTo: string;
  /** The Bazaar lists at most 100 listings (newest paid first); `totals` cover them all. */
  readonly truncated: boolean;
  readonly totals: { readonly payments: number; readonly payers: number };
  readonly listings: readonly {
    readonly listing: ListingRef;
    readonly payments: number;
    readonly payers: number;
    readonly lastObservedAt: string | null;
  }[];
}

export interface ListingVersion {
  readonly version: number;
  readonly createdAt: string;
  readonly cause: string;
  readonly transaction?: string;
  readonly trust: string;
  readonly state: string;
  readonly contentWithheld: boolean;
}

/** An answer: the value, `none` (the Bazaar has no data for it), or `down` (no answer in time). */
export type Answer<T> =
  { readonly status: "ok"; readonly value: T } | { readonly status: "none" } | { readonly status: "down" };

/** A listing's usage, or `private` when its seller keeps usage private. */
export type UsageAnswer = Answer<ResourceUsage> | { readonly status: "private" };

/** The Bazaar's code for the usage of a listing whose seller keeps it private. */
const USAGE_PRIVATE = "discovery_usage_private";

type Raw =
  | { readonly status: "ok"; readonly value: unknown }
  | { readonly status: "none"; readonly code?: string }
  | { readonly status: "down"; readonly cut?: boolean };

const NONE = { status: "none" } as const;
const DOWN = { status: "down" } as const;
/**
 * No answer for this visitor only: the page's deadline ran out, or the Bazaar refused this visitor's
 * own budget (429, or 503 with Retry-After). Never kept for other visitors.
 */
const CUT = { status: "down", cut: true } as const;

/** A Bazaar access key: `r402_<id>_<43 base64url characters>`. */
export const BAZAAR_ACCESS_KEY = /^r402_[a-z0-9][a-z0-9-]{2,31}_[A-Za-z0-9_-]{43}$/;
/** The header a discovery-internal caller forwards its own client's identifier in. */
export const FORWARDED_CLIENT_HEADER = "x-rail402-client";

/**
 * The identifier a visitor is forwarded to the Bazaar under: an HMAC of its rate-limit key under the
 * access key, so the Bazaar budgets each visitor apart and its address is never sent. It is a
 * pseudonym, not anonymity: whoever holds the key can compute it for every IPv4 address and so find a
 * visitor's address.
 */
export function forwardedClientId(key: string, client: string): string {
  return createHmac("sha256", key).update(client).digest("hex").slice(0, 32);
}

/** One page request's calls: whose they are, and when they must have answered (epoch ms). */
export interface Call {
  readonly client?: string;
  readonly deadline?: number;
}

export interface BazaarClientOptions {
  readonly network: IndexNetwork;
  /** The Bazaar's origin (https), e.g. https://testnet.rail402.dev. */
  readonly baseUrl: string;
  readonly fetch?: Fetch;
  /** Per call (default 2,500 ms). */
  readonly timeoutMs?: number;
  /** How long answers are kept (default 60 s); a failure is kept for 5 s so a down Bazaar is not hammered. */
  readonly cacheMs?: number;
  /** Largest answer read, in bytes (default 1 MiB). */
  readonly maxBytes?: number;
  readonly metrics?: WebMetrics;
  readonly now?: () => number;
  /**
   * The Bazaar's `discovery-internal` access key, sent as `Authorization: Bearer` with each visitor's
   * forwarded identifier, so each visitor draws on its own discovery budget instead of all sharing the
   * Explorer's address. Never logged.
   */
  readonly apiKey?: string;
}

/** Versions a listing page shows: the history route charges by the page size asked for. */
const VERSIONS_PAGE = 25;
/** Listings read for a network's pages: 5 pages of 100. */
const MAX_LISTING_PAGES = 5;
const CACHE_ENTRIES = 2_000;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max = 2_048): string | undefined =>
  typeof value === "string" && value.length <= max ? value : undefined;
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const atomic = (value: unknown): string | undefined =>
  typeof value === "string" && /^\d{1,40}$/.test(value) ? value : undefined;
const time = (value: unknown): string | undefined => {
  const raw = text(value, 40);
  return raw !== undefined && !Number.isNaN(Date.parse(raw)) ? raw : undefined;
};
const optional = <K extends string, V>(key: K, value: V | undefined) =>
  (value === undefined ? {} : { [key]: value }) as Partial<Record<K, V>>;

/** A `ListingRef` as the usage routes send it, or undefined when it is malformed. */
export function parseListingRef(value: unknown): ListingRef | undefined {
  if (!isObject(value)) return undefined;
  const id = text(value["id"], 64);
  const type = value["type"] === "http" || value["type"] === "mcp" ? value["type"] : undefined;
  const resource = text(value["resource"]);
  const payTo = text(value["payTo"], 69);
  const scheme = text(value["scheme"], 32);
  const amount = atomic(value["amount"]);
  const asset = text(value["asset"], 69);
  const network = text(value["network"], 72);
  const lastUpdated = time(value["lastUpdated"]);
  if (
    id === undefined ||
    type === undefined ||
    resource === undefined ||
    payTo === undefined ||
    scheme === undefined ||
    amount === undefined ||
    asset === undefined ||
    network === undefined ||
    lastUpdated === undefined
  )
    return undefined;
  return {
    id,
    type,
    resource,
    payTo,
    scheme,
    amount,
    asset,
    network,
    lastUpdated,
    ...optional("method", text(value["method"], 16)),
    ...optional("toolName", text(value["toolName"], 128)),
    ...optional("description", text(value["description"], 4_096)),
    ...optional("serviceName", text(value["serviceName"], 256)),
  };
}

/** A discovery item (or listing detail) as the listing of `network`, or undefined when it has none. */
export function parseListing(value: unknown, network: string): Listing | undefined {
  if (!isObject(value)) return undefined;
  const rail402 = isObject(value["rail402"]) ? value["rail402"] : {};
  const listings = Array.isArray(rail402["listings"]) ? rail402["listings"].filter(isObject) : [];
  const summary = listings.find((entry) => entry["network"] === network);
  const accepts = Array.isArray(value["accepts"]) ? value["accepts"].filter(isObject) : [];
  const option = accepts.find((entry) => entry["network"] === network);
  if (summary === undefined || option === undefined) return undefined;
  const type = value["type"];
  const ref = parseListingRef({
    id: summary["id"],
    type,
    resource: value["resource"],
    method: rail402["method"],
    toolName: rail402["toolName"],
    description: value["description"],
    serviceName: value["serviceName"],
    payTo: option["payTo"],
    scheme: option["scheme"],
    amount: option["amount"],
    asset: option["asset"],
    network,
    lastUpdated: value["lastUpdated"],
  });
  if (ref === undefined) return undefined;
  const bazaar = isObject(value["extensions"]) ? value["extensions"]["bazaar"] : undefined;
  const info = isObject(bazaar) && isObject(bazaar["info"]) ? bazaar["info"] : {};
  const extra = isObject(option["extra"]) ? option["extra"] : {};
  return {
    ...ref,
    ...optional("mimeType", text(value["mimeType"], 128)),
    ...optional("trust", text(summary["trust"], 32)),
    ...optional("state", text(value["state"], 32)),
    ...(value["contentWithheld"] === true ? { contentWithheld: true } : {}),
    ...optional("maxTimeoutSeconds", count(option["maxTimeoutSeconds"])),
    ...optional("routeTemplate", isObject(bazaar) ? text(bazaar["routeTemplate"], 1_024) : undefined),
    ...(info["input"] === undefined ? {} : { input: info["input"] }),
    ...(info["output"] === undefined ? {} : { output: info["output"] }),
    ...optional("firstCataloged", time(summary["firstCataloged"])),
    ...optional("version", count(summary["version"])),
    ...optional("x402Version", count(value["x402Version"])),
    ...(extra["areFeesSponsored"] === true ? { feesSponsored: true } : {}),
  };
}

function parseUsage(value: unknown): ResourceUsage | undefined {
  if (!isObject(value)) return undefined;
  const listingId = text(value["listingId"], 64);
  const payments = count(value["payments"]);
  const payers = count(value["payers"]);
  if (listingId === undefined || payments === undefined || payers === undefined) return undefined;
  const recent = (Array.isArray(value["recent"]) ? value["recent"] : [])
    .slice(0, 20)
    .filter(isObject)
    .flatMap((entry) => {
      const transaction = text(entry["transaction"], 64);
      const payer = text(entry["payer"], 69);
      const asset = text(entry["asset"], 69);
      const amount = atomic(entry["amount"]);
      const observedAt = time(entry["observedAt"]);
      return transaction !== undefined &&
        HASH.test(transaction) &&
        payer !== undefined &&
        asset !== undefined &&
        amount !== undefined &&
        observedAt !== undefined
        ? [{ transaction, payer, asset, amount, observedAt }]
        : [];
    });
  return {
    listingId,
    payments,
    payers,
    firstObservedAt: time(value["firstObservedAt"]) ?? null,
    lastObservedAt: time(value["lastObservedAt"]) ?? null,
    recent,
  };
}

function parseSellerUsage(value: unknown): SellerUsage | undefined {
  if (!isObject(value)) return undefined;
  const payTo = text(value["payTo"], 69);
  const totals = isObject(value["totals"]) ? value["totals"] : undefined;
  const payments = count(totals?.["payments"]);
  const payers = count(totals?.["payers"]);
  if (payTo === undefined || payments === undefined || payers === undefined) return undefined;
  const listings = (Array.isArray(value["listings"]) ? value["listings"] : [])
    .slice(0, 500)
    .filter(isObject)
    .flatMap((entry) => {
      const listing = parseListingRef(entry["listing"]);
      const listingPayments = count(entry["payments"]);
      const listingPayers = count(entry["payers"]);
      return listing === undefined || listingPayments === undefined || listingPayers === undefined
        ? []
        : [
            {
              listing,
              payments: listingPayments,
              payers: listingPayers,
              lastObservedAt: time(entry["lastObservedAt"]) ?? null,
            },
          ];
    });
  return { payTo, truncated: value["truncated"] === true, totals: { payments, payers }, listings };
}

/** The Bazaar's read API for one network. */
export class BazaarClient {
  readonly network: IndexNetwork;
  readonly #base: URL;
  readonly #options: BazaarClientOptions;
  readonly #cache = new Map<
    string,
    { readonly until: number; readonly answer: Promise<{ readonly status: string }> }
  >();
  readonly #now: () => number;
  /** HTTP calls made, for tests. */
  calls = 0;

  constructor(options: BazaarClientOptions) {
    const base = new URL(options.baseUrl);
    if (base.protocol !== "https:" || base.username !== "" || base.password !== "") {
      throw new TypeError("the Bazaar URL must be https without credentials");
    }
    if (base.pathname !== "/" || base.search !== "" || base.hash !== "") {
      throw new TypeError("the Bazaar URL is an origin, without a path");
    }
    if (options.apiKey !== undefined && !BAZAAR_ACCESS_KEY.test(options.apiKey)) {
      throw new TypeError("the Bazaar access key is not an r402_ access key");
    }
    this.network = options.network;
    this.#base = base;
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /** The origin pages link to for the Bazaar's own answers. */
  get origin(): string {
    return this.#base.origin;
  }

  /** This client for one page request: its visitor, and a deadline for all of its calls together. */
  forRequest(client: string, budgetMs?: number): BazaarSession {
    return new BazaarSession(this, { client, deadline: this.#now() + (budgetMs ?? 3_000) });
  }

  /** Every listing on this network that the Bazaar shows publicly, newest first (at most 500). */
  listings(call: Call = {}): Promise<Answer<Listing[]>> {
    return this.#cached("resources", async () => {
      const items: Listing[] = [];
      let asOf: string | undefined;
      // The offset counts the items the Bazaar sent, not the ones kept: a malformed or other-network
      // item still takes its place in the paging.
      let offset = 0;
      for (let page = 0; page < MAX_LISTING_PAGES; page++) {
        const answer = await this.#get(
          "resources",
          "/discovery/resources",
          {
            network: this.network,
            limit: "100",
            offset: String(offset),
            ...(asOf === undefined ? {} : { asOf }),
          },
          call,
        );
        if (answer.status !== "ok") return page === 0 ? answer : { status: "ok", value: items };
        const body = answer.value;
        const raw = isObject(body) && Array.isArray(body["items"]) ? body["items"] : [];
        for (const item of raw) {
          const listing = parseListing(item, this.network);
          if (listing !== undefined) items.push(listing);
        }
        offset += raw.length;
        const pagination = isObject(body) && isObject(body["pagination"]) ? body["pagination"] : {};
        asOf = text(pagination["asOf"], 40);
        const total = count(pagination["total"]) ?? 0;
        if (raw.length === 0 || offset >= total) break;
      }
      return { status: "ok", value: items };
    });
  }

  /** One listing by id; `none` when the Bazaar does not know it or it belongs to another network. */
  listing(id: string, call: Call = {}): Promise<Answer<Listing>> {
    if (!/^[0-9a-f-]{36}$/.test(id)) return Promise.resolve(NONE);
    return this.#cached(`listing:${id}`, async () => {
      const answer = await this.#get("resource", `/discovery/resources/${id}`, {}, call);
      if (answer.status !== "ok") return answer;
      const listing = parseListing(answer.value, this.network);
      return listing === undefined || listing.id !== id ? NONE : { status: "ok", value: listing };
    });
  }

  /** A listing's public version history, oldest first (the first 25 versions: cheap to ask for). */
  versions(id: string, call: Call = {}): Promise<Answer<ListingVersion[]>> {
    if (!/^[0-9a-f-]{36}$/.test(id)) return Promise.resolve(NONE);
    return this.#cached(`versions:${id}`, async () => {
      const answer = await this.#get(
        "versions",
        `/discovery/resources/${id}/versions`,
        { limit: String(VERSIONS_PAGE) },
        call,
      );
      if (answer.status !== "ok") return answer;
      const body = answer.value;
      const raw = isObject(body) && Array.isArray(body["versions"]) ? body["versions"] : [];
      const versions = raw.filter(isObject).flatMap((entry): ListingVersion[] => {
        const version = count(entry["version"]);
        const createdAt = time(entry["createdAt"]);
        const cause = text(entry["cause"], 64);
        const trust = text(entry["trust"], 32);
        const state = text(entry["state"], 32);
        const transaction = text(entry["transaction"], 64);
        if (
          version === undefined ||
          createdAt === undefined ||
          cause === undefined ||
          trust === undefined ||
          state === undefined
        )
          return [];
        return [
          {
            version,
            createdAt,
            cause,
            trust,
            state,
            contentWithheld: entry["contentWithheld"] === true,
            ...(transaction !== undefined && HASH.test(transaction) ? { transaction } : {}),
          },
        ];
      });
      return { status: "ok", value: versions };
    });
  }

  /**
   * What each of `hashes` paid for: the listing a Rail402 settlement was cataloged under. Send both the
   * outer and the inner hash of a fee bump; the answer is keyed by whichever the Bazaar recorded.
   */
  paidFor(hashes: readonly string[], call: Call = {}): Promise<Answer<ReadonlyMap<string, PaidFor>>> {
    const wanted = [...new Set(hashes.filter((hash) => HASH.test(hash)))].sort().slice(0, 100);
    if (wanted.length === 0) return Promise.resolve({ status: "ok", value: new Map() });
    return this.#cached(`settlements:${wanted.join(",")}`, async () => {
      const answer = await this.#get(
        "settlements",
        "/discovery/settlements",
        { network: this.network, transactions: wanted.join(",") },
        call,
      );
      if (answer.status === "none") return { status: "ok", value: new Map() };
      if (answer.status !== "ok") return answer;
      const body = answer.value;
      const raw = isObject(body) && Array.isArray(body["items"]) ? body["items"] : [];
      const found = new Map<string, PaidFor>();
      for (const item of raw.filter(isObject)) {
        const transaction = text(item["transaction"], 64);
        const listing = parseListingRef(item["listing"]);
        const observedAt = time(item["observedAt"]);
        if (
          transaction === undefined ||
          !wanted.includes(transaction) ||
          listing === undefined ||
          listing.network !== this.network ||
          observedAt === undefined
        )
          continue;
        found.set(transaction, { transaction, listing, observedAt });
      }
      return { status: "ok", value: found };
    });
  }

  /** Settled payments linked to a listing; `private` when its seller keeps them private. */
  resourceUsage(id: string, call: Call = {}): Promise<UsageAnswer> {
    if (!/^[0-9a-f-]{36}$/.test(id)) return Promise.resolve(NONE);
    return this.#cached<ResourceUsage, UsageAnswer>(`usage:${id}`, async () => {
      const answer = await this.#get(
        "resource_usage",
        `/discovery/resources/${id}/usage`,
        { network: this.network },
        call,
      );
      if (answer.status === "none") return answer.code === USAGE_PRIVATE ? { status: "private" } : NONE;
      if (answer.status !== "ok") return answer;
      const usage = parseUsage(answer.value);
      return usage === undefined || usage.listingId !== id ? NONE : { status: "ok", value: usage };
    });
  }

  /** A seller's listings with the settled payments linked to each. */
  sellerUsage(payTo: string, call: Call = {}): Promise<Answer<SellerUsage>> {
    if (!/^[GC][A-Z2-7]{55}$/.test(payTo)) return Promise.resolve(NONE);
    return this.#cached(`seller:${payTo}`, async () => {
      const answer = await this.#get(
        "seller_usage",
        `/discovery/sellers/${payTo}/usage`,
        { network: this.network },
        call,
      );
      if (answer.status !== "ok") return answer;
      const usage = parseSellerUsage(answer.value);
      return usage === undefined || usage.payTo !== payTo ? NONE : { status: "ok", value: usage };
    });
  }

  #cached<T, A extends { readonly status: string } = Answer<T>>(
    key: string,
    load: () => Promise<A>,
  ): Promise<A> {
    const now = this.#now();
    const hit = this.#cache.get(key);
    if (hit !== undefined && hit.until > now) return hit.answer as Promise<A>;
    const ttl = this.#options.cacheMs ?? 60_000;
    const answer = load().catch((): A => DOWN as unknown as A);
    this.#cache.delete(key);
    this.#cache.set(key, { until: now + ttl, answer });
    // A failure is kept briefly only, and one cut short by a page's deadline not at all.
    void answer.then((settled) => {
      if (settled.status === "down") {
        const entry = this.#cache.get(key);
        if (entry?.answer !== answer) return;
        if ((settled as { cut?: boolean }).cut === true) this.#cache.delete(key);
        else this.#cache.set(key, { until: this.#now() + 5_000, answer });
      }
    });
    while (this.#cache.size > CACHE_ENTRIES) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
    return answer;
  }

  /**
   * One GET with a time limit covering the body, no redirects and a size cap. A 404 is `none`, with the
   * error body's reason when it has one; anything else that is not a 200 with JSON is `down`.
   */
  async #get(route: string, path: string, query: Readonly<Record<string, string>>, call: Call): Promise<Raw> {
    const url = new URL(path, this.#base);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    const timeout = this.#options.timeoutMs ?? 2_500;
    const left = call.deadline === undefined ? timeout : call.deadline - this.#now();
    if (left < 50) {
      this.#options.metrics?.bazaar.inc({ network: this.network, route, outcome: "deadline" });
      return CUT;
    }
    const cut = left < timeout;
    const key = this.#options.apiKey;
    const headers: Record<string, string> = { accept: "application/json" };
    if (key !== undefined) {
      headers["authorization"] = `Bearer ${key}`;
      if (call.client !== undefined) headers[FORWARDED_CLIENT_HEADER] = forwardedClientId(key, call.client);
    }
    this.calls++;
    let outcome = "error";
    try {
      const response = await (this.#options.fetch ?? fetch)(url, {
        redirect: "manual",
        headers,
        signal: AbortSignal.timeout(Math.min(timeout, left)),
      });
      if (response.status !== 200 && response.status !== 404) {
        await response.body?.cancel();
        // Calls are charged to each visitor's forwarded budget: a refusal of this visitor's budget, or
        // a shed under load, says nothing about the Bazaar for the next visitor.
        const refused =
          response.status === 429 || (response.status === 503 && response.headers.has("retry-after"));
        if (refused) outcome = "limited";
        return refused ? CUT : DOWN;
      }
      const raw = await readCapped(response, this.#options.maxBytes ?? 1024 * 1024);
      if (response.status === 404) {
        // A route the Bazaar does not serve answers 404 too, often without a JSON body.
        outcome = "none";
        let code: string | undefined;
        try {
          const parsed: unknown = JSON.parse(raw);
          const error = isObject(parsed) && isObject(parsed["error"]) ? parsed["error"] : {};
          code = text(error["code"], 64);
        } catch {
          code = undefined;
        }
        return code === undefined ? NONE : { status: "none", code };
      }
      const body: unknown = JSON.parse(raw);
      outcome = "ok";
      return { status: "ok", value: body };
    } catch {
      return cut ? CUT : DOWN;
    } finally {
      this.#options.metrics?.bazaar.inc({ network: this.network, route, outcome });
    }
  }
}

/** A response body as text, refused as soon as it passes `maxBytes`. */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error("the answer is too large");
  }
  const reader = response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined;
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("the answer is too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

/** A Bazaar client bound to one page request: its visitor and its deadline. */
export class BazaarSession {
  readonly #client: BazaarClient;
  readonly #call: Call;

  constructor(client: BazaarClient, call: Call) {
    this.#client = client;
    this.#call = call;
  }

  get network(): IndexNetwork {
    return this.#client.network;
  }

  listings(): Promise<Answer<Listing[]>> {
    return this.#client.listings(this.#call);
  }

  listing(id: string): Promise<Answer<Listing>> {
    return this.#client.listing(id, this.#call);
  }

  versions(id: string): Promise<Answer<ListingVersion[]>> {
    return this.#client.versions(id, this.#call);
  }

  paidFor(hashes: readonly string[]): Promise<Answer<ReadonlyMap<string, PaidFor>>> {
    return this.#client.paidFor(hashes, this.#call);
  }

  resourceUsage(id: string): Promise<UsageAnswer> {
    return this.#client.resourceUsage(id, this.#call);
  }

  sellerUsage(payTo: string): Promise<Answer<SellerUsage>> {
    return this.#client.sellerUsage(payTo, this.#call);
  }
}
