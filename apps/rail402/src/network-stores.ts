import type { Kysely } from "kysely";
import { PostgresRateLimiter, PostgresUsageMeter, type Database } from "@rail402.dev/store-postgres";
import type { UsageEvent, UsageMeter, UsageRow } from "./metering.ts";
import type { KeyedRateLimiter } from "./rate-limit.ts";
import { laneRouted } from "./discovery.ts";

/** The network a limiter bucket belongs to: buckets of one network are keyed `n:<network>|…`. */
function networkOfBucket(key: string): string | undefined {
  if (!key.startsWith("n:")) return undefined;
  const end = key.indexOf("|");
  return end < 0 ? undefined : key.slice(2, end);
}

/**
 * A `KeyedRateLimiter` that takes the buckets of some networks through limiters of their own (for
 * pubnet: one on its own connection pool) and every other bucket through `fallback`. The buckets live
 * in the same table either way; only the connections differ.
 */
export class NetworkRoutedLimiter implements KeyedRateLimiter {
  private readonly fallback: KeyedRateLimiter;
  private readonly routes: ReadonlyMap<string, KeyedRateLimiter>;

  constructor(fallback: KeyedRateLimiter, routes: ReadonlyMap<string, KeyedRateLimiter>) {
    this.fallback = fallback;
    this.routes = routes;
  }

  takeLimit(key: string, perMinute: number): number | Promise<number> {
    const network = networkOfBucket(key);
    const limiter = (network === undefined ? undefined : this.routes.get(network)) ?? this.fallback;
    return limiter.takeLimit(key, perMinute);
  }

  sweep(): void | Promise<void> {
    // One table holds every bucket: sweeping through the fallback's connections clears them all.
    return this.fallback.sweep();
  }
}

/** A `UsageMeter` that records the events of some networks through meters of their own. */
export class NetworkRoutedMeter implements UsageMeter {
  private readonly fallback: UsageMeter;
  private readonly routes: ReadonlyMap<string, UsageMeter>;

  constructor(fallback: UsageMeter, routes: ReadonlyMap<string, UsageMeter>) {
    this.fallback = fallback;
    this.routes = routes;
  }

  record(event: UsageEvent): Promise<void> {
    return (this.routes.get(event.network) ?? this.fallback).record(event);
  }

  usage(subject: string, days: number): Promise<UsageRow[]> {
    return this.fallback.usage(subject, days);
  }
}

/** The database-backed limiters and meter of the service, by connection pool. */
export interface AccessStores {
  /**
   * The service-wide limit, applied before the body is read (per address, or per key for a key holder's
   * `/verify` and `/settle`): the shared pool.
   */
  readonly rateLimiter: PostgresRateLimiter;
  /**
   * With a pool of pubnet's own: the service-wide limit of a request to the pubnet host whose key pubnet
   * admits, on that pool. Never an anonymous caller's: the key is decided in memory first, and anyone
   * else on that host is limited per process (see `createApp`).
   */
  readonly pubnetRateLimiter?: PostgresRateLimiter;
  /** Each network's request limit (`n:<network>|…`). */
  readonly networkLimiter: KeyedRateLimiter;
  /** The per-payer and per-payTo settlement limits (`n:<network>|payer:…`, `…|<caller>|payto:…`). */
  readonly partyLimiter: KeyedRateLimiter;
  /**
   * With a discovery pool (the Bazaar is served): the per-address limit of the discovery routes and the
   * buckets of internal discovery identities, on that pool, so discovery traffic never queues for the
   * connections a settlement's limits need. Never built on the shared pool.
   */
  readonly discoveryLimiter?: PostgresRateLimiter;
  readonly meter: UsageMeter;
}

/**
 * Builds the service's limiters and meter. With a pool of pubnet's own (`pubnetDb`), pubnet's network
 * and party limits, its metering and the service-wide limit of its key holders on the pubnet host use
 * it, so testnet work holding every shared connection cannot stall a pubnet settlement at a limiter;
 * both pools fail fast once their acquire timeout passes. The buckets live in one table whichever pool
 * writes them, so an address, and a key, keeps one service-wide limit on every host.
 */
export function createAccessStores(
  db: Kysely<Database>,
  pubnetDb: Kysely<Database> | undefined,
  options: {
    readonly rateLimitPerMinute: number;
    readonly pubnet: string;
    /** The discovery routes' own pool; without it there is no discovery limiter. */
    readonly discoveryDb?: Kysely<Database>;
    /** The pool of pubnet-scoped discovery requests (`discoveryLaneOf`); without it they share the above. */
    readonly pubnetDiscoveryDb?: Kysely<Database>;
  },
): AccessStores {
  const shared = new PostgresRateLimiter(db, 0);
  const meter = new PostgresUsageMeter(db);
  const rateLimiter = new PostgresRateLimiter(db, options.rateLimitPerMinute);
  const discovery =
    options.discoveryDb === undefined
      ? {}
      : {
          discoveryLimiter: laneRouted(
            new PostgresRateLimiter(options.discoveryDb, options.rateLimitPerMinute),
            new Map(
              options.pubnetDiscoveryDb === undefined
                ? []
                : [
                    [
                      "pubnet",
                      new PostgresRateLimiter(options.pubnetDiscoveryDb, options.rateLimitPerMinute),
                    ] as const,
                  ],
            ),
          ),
        };
  if (pubnetDb === undefined) {
    return { rateLimiter, networkLimiter: shared, partyLimiter: shared, ...discovery, meter };
  }
  const own = new Map([[options.pubnet, new PostgresRateLimiter(pubnetDb, 0)]]);
  const routed = new NetworkRoutedLimiter(shared, own);
  return {
    rateLimiter,
    pubnetRateLimiter: new PostgresRateLimiter(pubnetDb, options.rateLimitPerMinute),
    networkLimiter: routed,
    partyLimiter: routed,
    ...discovery,
    meter: new NetworkRoutedMeter(meter, new Map([[options.pubnet, new PostgresUsageMeter(pubnetDb)]])),
  };
}
