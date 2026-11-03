import { AsyncLocalStorage } from "node:async_hooks";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { httpError, isRail402Error, toErrorBody } from "@rail402.dev/errors";
import type { SearchService } from "@rail402.dev/search";
import {
  MAX_RECENT_OBSERVATIONS,
  MAX_SELLER_USAGE_LISTINGS,
  MAX_USAGE_TRANSACTIONS,
  baseAccount,
  bazaarError,
  toDiscoveryItem,
  toListingDetail,
  toListingUsageResponse,
  toSellerUsageResponse,
  toSettlementsResponse,
  toVersionItem,
  usagePrivate,
  usageVisible,
  type CatalogStore,
} from "@rail402.dev/bazaar";

/** Largest page the list endpoint returns (x402 v2 §8.1: 1-100). Larger requests are clamped. */
export const MAX_PAGE = 100;
export const DEFAULT_PAGE = 20;

const TOKEN = /^[a-z][a-z0-9_-]{0,31}$/;
const CAIP2 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,64}$/;
const ADDRESS = /^[A-Z2-7]{56}$|^M[A-Z2-7]{68}$/;
const EXTENSION_LIST = /^[a-zA-Z0-9_-]{1,64}(,[a-zA-Z0-9_-]{1,64}){0,9}$/;

const listQuery = z.strictObject({
  type: z.string().regex(TOKEN, "must be a resource type such as http or mcp").optional(),
  payTo: z
    .string()
    .regex(ADDRESS, "must be a Stellar G…, C… or M… address")
    .refine((value) => baseAccount(value) !== undefined, "must be a Stellar G…, C… or M… address")
    .optional(),
  scheme: z.string().regex(TOKEN, "must be a scheme name such as exact").optional(),
  network: z.string().regex(CAIP2, "must be a CAIP-2 network such as stellar:testnet").optional(),
  extensions: z.string().regex(EXTENSION_LIST, "must be a comma-separated list of extension keys").optional(),
  limit: z.coerce.number().int().min(1, "must be at least 1").optional(),
  asOf: z.iso.datetime({ offset: true, message: "must be an ISO 8601 date-time" }).optional(),
  offset: z.coerce
    .number()
    .int()
    .min(0, "must be 0 or more")
    .max(1_000_000, "must be at most 1000000")
    .optional(),
});

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Largest page of a listing's version history; larger requests are clamped. */
export const MAX_VERSIONS_PAGE = 100;

const versionsQuery = z.strictObject({
  limit: listQuery.shape.limit,
  after: z.coerce
    .number()
    .int()
    .min(0, "must be 0 or more")
    .max(2_147_483_647, "must be at most 2147483647")
    .optional(),
});

/** The networks usage is published for; a usage request names one of them. */
const usageNetwork = z.enum(["stellar:testnet", "stellar:pubnet"], {
  message: "must be stellar:testnet or stellar:pubnet",
});

const usageQuery = z.strictObject({ network: usageNetwork });

const settlementsQuery = z.strictObject({
  network: usageNetwork,
  transactions: z
    .string()
    .regex(
      new RegExp(`^[0-9a-f]{64}(,[0-9a-f]{64}){0,${String(MAX_USAGE_TRANSACTIONS - 1)}}$`),
      `must be 1 to ${String(MAX_USAGE_TRANSACTIONS)} comma-separated transaction hashes, each 64 lowercase hex characters`,
    ),
});

/** A seller's base account: a G… or C… address with a valid checksum, never a muxed M… address. */
const SELLER = /^[GC][A-Z2-7]{55}$/;

/** Search pages are advisory (bazaar spec); larger requests are clamped. */
export const MAX_SEARCH_PAGE = 50;
export const DEFAULT_SEARCH_PAGE = 10;

const searchQuery = z.strictObject({
  query: z.string().max(2_000, "must be at most 2000 characters"),
  type: listQuery.shape.type,
  payTo: listQuery.shape.payTo,
  scheme: listQuery.shape.scheme,
  network: listQuery.shape.network,
  extensions: listQuery.shape.extensions,
  asset: z
    .string()
    .regex(/^C[A-Z2-7]{55}$|^[A-Za-z0-9]{1,12}$/, "must be a C… contract address or an asset symbol")
    .optional(),
  maxPrice: z
    .string()
    .regex(
      /^\d{1,15}(\.\d{1,18})?$/,
      "must be a decimal amount, in the asset's units if asset is set, else in US dollars",
    )
    .optional(),
  limit: listQuery.shape.limit,
  cursor: z.string().max(512, "is too long").optional(),
});

/** The discovery routes, as the cost limits and their metrics name them. */
export type DiscoveryRoute =
  | "/discovery/search"
  | "/discovery/resources"
  | "/discovery/resources/:id"
  | "/discovery/resources/:id/versions"
  | "/discovery/resources/:id/usage"
  | "/discovery/settlements"
  | "/discovery/sellers/:payTo/usage";

export const DISCOVERY_ROUTES: readonly DiscoveryRoute[] = [
  "/discovery/search",
  "/discovery/resources",
  "/discovery/resources/:id",
  "/discovery/resources/:id/versions",
  "/discovery/resources/:id/usage",
  "/discovery/settlements",
  "/discovery/sellers/:payTo/usage",
];

/** The discovery route a request path belongs to, for metrics and refusals. */
export function discoveryRouteOf(path: string): DiscoveryRoute {
  const local = path.startsWith("/discovery/") ? path.slice("/discovery".length) : path;
  if (local === "/search") return "/discovery/search";
  if (local === "/resources" || local === "/resources/") return "/discovery/resources";
  if (local === "/settlements" || local === "/settlements/") return "/discovery/settlements";
  if (local.startsWith("/sellers/")) return "/discovery/sellers/:payTo/usage";
  if (local.endsWith("/usage")) return "/discovery/resources/:id/usage";
  return local.endsWith("/versions") ? "/discovery/resources/:id/versions" : "/discovery/resources/:id";
}

/** Seconds a discovery request refused for load is told to wait (`Retry-After`). */
export const DISCOVERY_RETRY_AFTER_SECONDS = 1;

/** How many discovery requests run at once and how many may wait for a turn. */
export interface DiscoveryAdmissionOptions {
  /** Requests served at once; every other request waits in the queue or is refused. */
  readonly maxInFlight: number;
  /** Requests that may wait for a turn; 0 refuses at once whenever every slot is taken. */
  readonly queueLength: number;
  /** Longest a request waits in the queue before it is refused, in milliseconds. */
  readonly queueTimeoutMs: number;
}

/**
 * Load shedding for the discovery routes. At most `maxInFlight` requests run at once, at most
 * `queueLength` more wait (each for at most `queueTimeoutMs`, first come first served), and every other
 * request is refused at once. A refusal costs no database connection, no index read and no embedding,
 * so discovery traffic beyond capacity is turned away instead of piling up in the process, where it
 * would delay the settlements and health checks the process also serves.
 */
export class DiscoveryAdmission {
  private running = 0;
  private readonly waiting: { readonly grant: () => void }[] = [];
  private readonly maxInFlight: number;
  private readonly queueLength: number;
  private readonly queueTimeoutMs: number;

  constructor(options: DiscoveryAdmissionOptions) {
    this.maxInFlight = Math.max(1, options.maxInFlight);
    this.queueLength = Math.max(0, options.queueLength);
    this.queueTimeoutMs = Math.max(0, options.queueTimeoutMs);
  }

  /** Requests running now. */
  get inFlight(): number {
    return this.running;
  }

  /** Requests waiting for a turn now. */
  get queued(): number {
    return this.waiting.length;
  }

  /** Takes a turn: true once admitted (then `leave` must follow), false when refused. */
  enter(): Promise<boolean> {
    if (this.running < this.maxInFlight) {
      this.running++;
      return Promise.resolve(true);
    }
    if (this.waiting.length >= this.queueLength || this.queueTimeoutMs === 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const waiter = {
        grant: () => {
          clearTimeout(timer);
          resolve(true);
        },
      };
      const timer = setTimeout(() => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
        resolve(false);
      }, this.queueTimeoutMs);
      this.waiting.push(waiter);
    });
  }

  /** Gives a turn back: to the request waiting longest, else to the free slots. */
  leave(): void {
    const next = this.waiting.shift();
    // A turn handed over keeps `running` as it is.
    if (next === undefined) this.running = Math.max(0, this.running - 1);
    else next.grant();
  }
}

/**
 * The admission lanes of the discovery routes. A request scoped to pubnet (its `network` parameter, or
 * a `Host` of `PUBLIC_HOSTS` that serves pubnet) takes the `pubnet` lane; every other request, testnet
 * or unscoped, takes the `shared` lane. Each lane has its own admission gate and, with Postgres and
 * pubnet served next to another network, its own discovery pool and limiter connections, so testnet
 * load never sheds a pubnet discovery request.
 */
export const DISCOVERY_LANES = ["pubnet", "shared"] as const;
export type DiscoveryLane = (typeof DISCOVERY_LANES)[number];

/** The lane of the discovery request being served, for `laneRouted` stores and limiters. */
export const discoveryLaneContext = new AsyncLocalStorage<DiscoveryLane>();

/** The lane of a request scoped to `network` (undefined: not scoped). */
export function discoveryLaneOf(network: string | undefined): DiscoveryLane {
  return network === "stellar:pubnet" ? "pubnet" : "shared";
}

/**
 * `fallback`, except that inside a discovery request of a lane in `lanes` every method call goes to
 * that lane's object instead (the same catalog through another pool, for example). Calls outside a
 * discovery request, such as background work, always use `fallback`.
 */
export function laneRouted<T extends object>(fallback: T, lanes: ReadonlyMap<DiscoveryLane, T>): T {
  if (lanes.size === 0) return fallback;
  return new Proxy(fallback, {
    get(target, property) {
      const lane = discoveryLaneContext.getStore();
      const owner = (lane === undefined ? undefined : lanes.get(lane)) ?? target;
      const value = Reflect.get(owner, property, owner) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(owner) : value;
    },
  });
}

/** One `DiscoveryAdmission` per lane, with the same settings each. */
export class DiscoveryAdmissions {
  private readonly lanes: ReadonlyMap<DiscoveryLane, DiscoveryAdmission>;

  constructor(options: DiscoveryAdmissionOptions) {
    this.lanes = new Map(DISCOVERY_LANES.map((lane) => [lane, new DiscoveryAdmission(options)]));
  }

  lane(lane: DiscoveryLane): DiscoveryAdmission {
    return this.lanes.get(lane) as DiscoveryAdmission;
  }

  /** Requests running now, across lanes. */
  get inFlight(): number {
    return [...this.lanes.values()].reduce((sum, gate) => sum + gate.inFlight, 0);
  }

  /** Requests waiting for a turn now, across lanes. */
  get queued(): number {
    return [...this.lanes.values()].reduce((sum, gate) => sum + gate.queued, 0);
  }
}

/** Why a discovery read failed, when the catalog database is the cause. */
export type DiscoveryFailure = "database_busy" | "database_unavailable";

/** Why a discovery request was refused with 503, as `rail402_discovery_shed_total` counts it. */
export const DISCOVERY_SHED_REASONS = ["admission", "database_busy", "database_unavailable"] as const;

/** Postgres codes of a busy database: a statement cut by its timeout, too many connections. */
const BUSY_CODES = new Set(["57014", "53300"]);
/** Socket errors of a database that cannot be reached. */
const UNREACHABLE = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "EPIPE"]);

/**
 * Whether `error`, or an error it wraps, is the catalog database being busy (no pooled connection free
 * within the acquire timeout, a read cut by its statement timeout) or unreachable. Anything else is a
 * defect, not load, and stays an internal error.
 */
export function discoveryFailure(error: unknown): DiscoveryFailure | undefined {
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (
      /timeout exceeded when trying to connect|connection timeout/i.test(current.message) ||
      (typeof code === "string" && BUSY_CODES.has(code))
    ) {
      return "database_busy";
    }
    if (
      (typeof code === "string" && (UNREACHABLE.has(code) || /^(08|57P)/.test(code))) ||
      /Connection terminated|Cannot use a pool after calling end/i.test(current.message)
    ) {
      return "database_unavailable";
    }
    current = current.cause;
  }
  return undefined;
}

/**
 * Per-client cost limits of the discovery routes. Each request spends cost units from its client's
 * bucket, which refills at `perMinute` units a minute: a search whose query embedding is cached, or
 * that needs none, costs 1; one that runs the embedding model costs `uncachedSearchCost`; a list
 * page costs 1 plus 1 per 1,000 of offset (at most 10); a listing costs 1; a page of its version
 * history costs 1 plus 1 per 25 versions asked for.
 */
export interface DiscoveryLimits {
  /** Cost units one client may spend per minute; 0 disables the limit. */
  readonly perMinute: number;
  readonly uncachedSearchCost: number;
  /** The key a request's client is limited under (its address, or /64 for IPv6). */
  readonly clientKey: (c: Context) => string;
  /**
   * The buckets a request is charged to instead of its address's, when it comes from an internal
   * discovery identity: each forwarded client's own bucket, then the identity's. Undefined for every
   * other request.
   */
  readonly charges?: (c: Context) => readonly DiscoveryCharge[] | undefined;
  /** Called for every request the cost limit refuses, with its route. Must not throw. */
  readonly onLimited?: (route: DiscoveryRoute) => void;
}

/** What the discovery routes report besides their responses. */
export interface DiscoveryObserver {
  /**
   * Called for every request refused because the catalog database is busy or unreachable, with the
   * error. Must not throw.
   */
  readonly failed?: (route: DiscoveryRoute, failure: DiscoveryFailure, error: unknown) => void;
}

/**
 * How much of a network's usage the usage routes publish. `settlements`: which settlement paid for
 * which listing (`/settlements`) and each listing's latest settlements with their payers. `counts`:
 * counts and dates only; no route links a settlement, and with it its payer, to a listing.
 */
export type UsageDetail = "settlements" | "counts";

/** The default usage detail of a network: `counts` on pubnet, where payments are real money. */
export function defaultUsageDetail(network: string): UsageDetail {
  return network === "stellar:pubnet" ? "counts" : "settlements";
}

/** A cost bucket a request is charged to: its key and how many cost units it refills a minute. */
export interface DiscoveryCharge {
  readonly key: string;
  readonly perMinute: number;
}

/**
 * A token bucket per client in which requests spend different amounts. A request whose cost exceeds
 * what is left is refused; every request can succeed once the bucket refilled to its cost.
 */
export class CostBucket {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number; capacity: number }>();
  private readonly capacity: number;
  private readonly now: () => number;

  constructor(perMinute: number, now: () => number = Date.now) {
    this.capacity = perMinute;
    this.now = now;
  }

  get enabled(): boolean {
    return this.capacity > 0;
  }

  /**
   * Spends `cost` for `key`, from a bucket of `perMinute` units (the bucket's default when omitted).
   * Returns 0 when allowed, otherwise the seconds until it would be.
   */
  take(key: string, cost: number, perMinute?: number): number {
    if (!this.enabled) return 0;
    const capacity = perMinute ?? this.capacity;
    const refillPerMs = capacity / 60_000;
    const spend = Math.min(cost, capacity);
    const now = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: capacity, updatedAt: now, capacity };
    bucket.capacity = capacity;
    bucket.tokens = Math.min(capacity, bucket.tokens + (now - bucket.updatedAt) * refillPerMs);
    bucket.updatedAt = now;
    this.buckets.set(key, bucket);
    if (bucket.tokens >= spend) {
      bucket.tokens -= spend;
      return 0;
    }
    return Math.max(1, Math.ceil((spend - bucket.tokens) / refillPerMs / 1_000));
  }

  /** Drops buckets that have refilled completely, bounding memory. */
  sweep(): void {
    const now = this.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.tokens + ((now - bucket.updatedAt) * bucket.capacity) / 60_000 >= bucket.capacity)
        this.buckets.delete(key);
    }
  }
}

/**
 * The most bytes of discovery items one response carries. Upstream's `withBazaar` client refuses
 * discovery responses over 4 MiB; this leaves room for the envelope.
 */
export const PAGE_BYTE_BUDGET = 3.5 * 1024 * 1024;

/**
 * How many of `items`, in order, fit in `budget` bytes, at least one: a page ends early rather than
 * grow past what stock clients accept, and the next page continues after it.
 */
export function itemsWithin(items: readonly unknown[], budget = PAGE_BYTE_BUDGET): number {
  let bytes = 0;
  for (const [index, item] of items.entries()) {
    bytes += Buffer.byteLength(JSON.stringify(item)) + 1;
    if (bytes > budget) return Math.max(1, index);
  }
  return items.length;
}

/** What a search costs: 1 when its query embedding is cached or not needed, else `uncachedCost`. */
export function searchCost(search: SearchService, query: string, uncachedCost: number): number {
  return search.isQueryCached(query) ? 1 : uncachedCost;
}

/** What a list page costs: deep offsets make the database scan further. */
export function offsetCost(offset: number): number {
  return 1 + Math.min(9, Math.floor(offset / 1_000));
}

/** What a page of version history costs: each version may carry a full listing. */
export function versionsCost(limit: number): number {
  return 1 + Math.floor(limit / 25);
}

/** What a settlements lookup costs: 1 plus 1 per 25 transactions asked for. */
export function settlementsCost(transactions: number): number {
  return 1 + Math.floor(transactions / 25);
}

/** What a seller's usage costs: it reads every settlement of the seller's listings. */
export const SELLER_USAGE_COST = 2;

/**
 * GET /discovery/resources and listing detail routes. Every filter is applied or rejected with a
 * coded 400; an unsupported parameter is never silently ignored. Filters on payTo, scheme and
 * network must hold for one and the same payment option of a listing. A resource sold on several
 * networks is one item; filtered, it shows only the payment options that matched. The detail routes
 * address one listing: one resource on one network.
 */
export function discoveryRoutes(
  store: CatalogStore,
  search?: SearchService,
  limits?: DiscoveryLimits,
  observer?: DiscoveryObserver,
  usageDetail: (network: string) => UsageDetail = defaultUsageDetail,
): Hono {
  const app = new Hono();
  // A catalog database that is busy or unreachable is load or an outage, not a defect: a coded 503
  // with Retry-After, never a 500.
  app.onError((error, c) => {
    const failure = discoveryFailure(error);
    if (failure === undefined) throw error;
    observer?.failed?.(discoveryRouteOf(c.req.path), failure, error);
    c.header("Retry-After", String(DISCOVERY_RETRY_AFTER_SECONDS));
    const code = failure === "database_busy" ? "discovery_overloaded" : "discovery_catalog_unavailable";
    return c.json(toErrorBody(bazaarError(code)), 503);
  });
  const bucket = limits === undefined ? undefined : new CostBucket(limits.perMinute);
  if (bucket?.enabled === true) {
    const sweep = setInterval(() => {
      bucket.sweep();
    }, 60_000);
    sweep.unref();
  }
  /** Spends `cost` for the request's client; a 429 response when the client's budget is spent. */
  const limited = (c: Context, route: DiscoveryRoute, cost: number): Response | undefined => {
    if (bucket === undefined || limits === undefined) return undefined;
    // An internal discovery identity is charged per forwarded client and as a whole, never as one
    // client of its address: one remote user cannot spend every other user's budget.
    const charges = limits.charges?.(c) ?? [{ key: limits.clientKey(c), perMinute: limits.perMinute }];
    let retryAfter = 0;
    for (const charge of charges) {
      retryAfter = bucket.take(charge.key, cost, charge.perMinute);
      if (retryAfter > 0) break;
    }
    if (retryAfter === 0) return undefined;
    limits.onLimited?.(route);
    c.header("Retry-After", String(retryAfter));
    return c.json(toErrorBody(httpError("rate_limited")), 429);
  };

  if (search !== undefined) {
    app.get("/search", async (c) => {
      const parsed = searchQuery.safeParse(c.req.query());
      if (!parsed.success) return invalid(c, parsed.error);
      const query = parsed.data;
      const refused = limited(
        c,
        "/discovery/search",
        searchCost(search, query.query, limits?.uncachedSearchCost ?? 1),
      );
      if (refused !== undefined) return refused;
      const limit = Math.min(query.limit ?? DEFAULT_SEARCH_PAGE, MAX_SEARCH_PAGE);
      try {
        const result = await search.search({
          query: query.query,
          filter: {
            ...(query.type === undefined ? {} : { type: query.type }),
            ...(query.payTo === undefined ? {} : { payTo: query.payTo }),
            ...(query.scheme === undefined ? {} : { scheme: query.scheme }),
            ...(query.network === undefined ? {} : { network: query.network }),
            ...(query.extensions === undefined ? {} : { extensions: query.extensions.split(",") }),
            ...(query.asset === undefined ? {} : { asset: query.asset }),
            ...(query.maxPrice === undefined
              ? {}
              : { maxPrice: { value: query.maxPrice, unit: query.asset === undefined ? "usd" : "asset" } }),
          },
          limit,
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          fit: (page) => itemsWithin(page.map(toDiscoveryItem)),
        });
        return c.json({
          x402Version: 2,
          resources: result.resources.map(toDiscoveryItem),
          partialResults: result.partialResults,
          // The spec's `pagination.limit` is the number of results in this page.
          pagination: { limit: result.resources.length, cursor: result.nextCursor },
          rail402: {
            method: result.method,
            queryEmbedding: result.queryEmbedding,
            recognised: result.recognised,
            revision: result.revision,
          },
        });
      } catch (error) {
        if (isRail402Error(error)) return c.json(toErrorBody(error), error.status as 400);
        throw error;
      }
    });
  }

  app.get("/resources", async (c) => {
    const parsed = listQuery.safeParse(c.req.query());
    if (!parsed.success) return invalid(c, parsed.error);
    const query = parsed.data;
    const limit = Math.min(query.limit ?? DEFAULT_PAGE, MAX_PAGE);
    const offset = query.offset ?? 0;
    const refused = limited(c, "/discovery/resources", offsetCost(offset));
    if (refused !== undefined) return refused;
    // Pages of one pagination share its asOf, so listings published meanwhile never shift them.
    const now = new Date();
    const requested = query.asOf === undefined ? now : new Date(query.asOf);
    const asOf = requested.getTime() > now.getTime() ? now : requested;
    const { items, total } = await store.list({
      asOf,
      ...(query.type === undefined ? {} : { type: query.type }),
      ...(query.payTo === undefined ? {} : { payTo: query.payTo }),
      ...(query.scheme === undefined ? {} : { scheme: query.scheme }),
      ...(query.network === undefined ? {} : { network: query.network }),
      ...(query.extensions === undefined ? {} : { extensions: query.extensions.split(",") }),
      limit,
      offset,
    });
    // A page that would exceed the byte budget ends early; its limit then says how many it holds, so
    // offset + limit continues where it ended.
    const published = items.map(toDiscoveryItem);
    const kept = itemsWithin(published);
    return c.json({
      x402Version: 2,
      items: published.slice(0, kept),
      pagination: { limit: kept < published.length ? kept : limit, offset, total, asOf: asOf.toISOString() },
    });
  });

  app.get("/resources/:id", async (c) => {
    const refused = limited(c, "/discovery/resources/:id", 1);
    if (refused !== undefined) return refused;
    const id = c.req.param("id");
    const listing = ID.test(id) ? await store.get(id) : undefined;
    if (listing === undefined) return c.json(toErrorBody(bazaarError("discovery_listing_not_found")), 404);
    // A pending or withdrawn listing shows its state, never metadata its origin has not confirmed.
    return c.json(toListingDetail(listing));
  });

  // A listing's history, oldest first, a page at a time: `after` is the last version already read.
  app.get("/resources/:id/versions", async (c) => {
    const parsed = versionsQuery.safeParse(c.req.query());
    if (!parsed.success) return invalid(c, parsed.error);
    const limit = Math.min(parsed.data.limit ?? MAX_VERSIONS_PAGE, MAX_VERSIONS_PAGE);
    const after = parsed.data.after ?? 0;
    const refused = limited(c, "/discovery/resources/:id/versions", versionsCost(limit));
    if (refused !== undefined) return refused;
    const id = c.req.param("id");
    const listing = ID.test(id) ? await store.get(id) : undefined;
    if (listing === undefined) return c.json(toErrorBody(bazaarError("discovery_listing_not_found")), 404);
    // The history links no settlement to a listing whose usage is private, or on a network that
    // publishes usage counts only.
    const linked = !usagePrivate(listing) && usageDetail(listing.identity.network) === "settlements";
    const versions = (await store.versions(id, { after, limit })).map((version) =>
      toVersionItem(version, linked),
    );
    // A page that would exceed the byte budget ends early; `next` continues where it ended.
    const kept = itemsWithin(versions);
    const page = versions.slice(0, kept);
    const last = page.at(-1)?.version;
    const more = last !== undefined && last < listing.version;
    return c.json({
      x402Version: 2,
      id,
      versions: page,
      pagination: {
        limit,
        after,
        latest: listing.version,
        ...(more ? { next: last } : {}),
      },
    });
  });

  // Which listing each settlement paid for: settlements linked to a listing whose usage is public on
  // `network`. Unknown, unlinked and private settlements are simply absent.
  app.get("/settlements", async (c) => {
    const parsed = settlementsQuery.safeParse(c.req.query());
    if (!parsed.success) return invalid(c, parsed.error);
    const transactions = parsed.data.transactions.split(",");
    const refused = limited(c, "/discovery/settlements", settlementsCost(transactions.length));
    if (refused !== undefined) return refused;
    const asOf = new Date();
    // With `counts`, the network links no settlement to a listing.
    const links =
      usageDetail(parsed.data.network) === "counts"
        ? []
        : await store.settlementLinks(parsed.data.network, transactions);
    return c.json(toSettlementsResponse(links, transactions, parsed.data.network, asOf));
  });

  // How a listing was paid for: settlements that paid its current owner, the latest 20 of them.
  app.get("/resources/:id/usage", async (c) => {
    const parsed = usageQuery.safeParse(c.req.query());
    if (!parsed.success) return invalid(c, parsed.error);
    const refused = limited(c, "/discovery/resources/:id/usage", 1);
    if (refused !== undefined) return refused;
    const { network } = parsed.data;
    const id = c.req.param("id");
    const listing = ID.test(id) ? await store.get(id) : undefined;
    // Usage is shown for what discovery lists on that network only: never a pending, withdrawn or
    // other network's listing.
    if (listing?.state !== "published" || listing.identity.network !== network) {
      return c.json(toErrorBody(bazaarError("discovery_listing_not_found")), 404);
    }
    if (!usageVisible(listing, network)) {
      // A listing no origin confirmed (an mcp:// tool) holds its first payer's echo, not its seller's
      // choice: its usage stays private.
      const reason =
        listing.trust === "settled"
          ? "No origin confirmed this listing's metadata, so its seller's choice is unknown and its usage stays private."
          : undefined;
      return c.json(
        toErrorBody(bazaarError("discovery_usage_private", reason === undefined ? undefined : { reason })),
        404,
      );
    }
    const counts = usageDetail(network) === "counts";
    const usage = await store.listingUsage(listing, counts ? 0 : MAX_RECENT_OBSERVATIONS);
    return c.json(toListingUsageResponse(listing.id, counts ? { ...usage, recent: [] } : usage));
  });

  // How a seller's listings on one network were paid for. A seller without listings has none.
  app.get("/sellers/:payTo/usage", async (c) => {
    const parsed = usageQuery.safeParse(c.req.query());
    if (!parsed.success) return invalid(c, parsed.error);
    const payTo = c.req.param("payTo");
    if (!SELLER.test(payTo) || baseAccount(payTo) !== payTo) {
      return c.json(
        toErrorBody(
          bazaarError("discovery_invalid_parameter", {
            reason: "Parameter payTo must be a Stellar G… or C… address with a valid checksum.",
          }),
        ),
        400,
      );
    }
    const refused = limited(c, "/discovery/sellers/:payTo/usage", SELLER_USAGE_COST);
    if (refused !== undefined) return refused;
    const usage = await store.sellerUsage(payTo, parsed.data.network, MAX_SELLER_USAGE_LISTINGS);
    return c.json(toSellerUsageResponse(payTo, parsed.data.network, usage));
  });

  return app;
}

function invalid(c: Context, error: z.ZodError) {
  const [issue] = error.issues;
  const reason =
    issue === undefined
      ? "A discovery query parameter is malformed."
      : issue.code === "unrecognized_keys"
        ? `Unsupported parameter: ${issue.keys.join(", ")}.`
        : `Parameter ${issue.path.join(".")} ${issue.message}.`;
  return c.json(toErrorBody(bazaarError("discovery_invalid_parameter", { reason })), 400);
}
