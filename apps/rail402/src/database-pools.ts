import { PUBNET } from "@rail402.dev/stellar";
import type { Config } from "./config.ts";

/** Connections of the shared pool: every network's settlements, limits and metering but pubnet's own. */
export const SHARED_POOL_SIZE = 10;

/** Connections of pubnet's own pool when one process serves several networks. */
export const PUBNET_POOL_SIZE = 5;

/**
 * Connections of the search index's own pool, with the Bazaar: one for a build's catalog scan, one for the
 * background refresh's revision read, so neither waits for the other.
 */
export const SEARCH_INDEX_POOL_SIZE = 2;

/** The database pools one process opens, by the most connections each holds; absent ones are not opened. */
export interface DatabasePools {
  readonly shared: number;
  /** The readiness probe's connection of its own. */
  readonly readiness: number;
  /** Pubnet's own pool, when pubnet is served next to another network. */
  readonly pubnet?: number;
  /** The discovery routes' pool, with the Bazaar. */
  readonly discovery?: number;
  /** The pool of pubnet-scoped discovery, with the Bazaar and pubnet's own pool. */
  readonly pubnetDiscovery?: number;
  /** The search index's builds and background refresh, with the Bazaar; no request takes it. */
  readonly searchIndex?: number;
}

/** The pools the service opens for `config` with Postgres; undefined with the in-memory store. */
export function databasePools(
  config: Pick<Config, "store" | "networks" | "bazaar" | "discovery">,
): DatabasePools | undefined {
  if (config.store.kind !== "postgres") return undefined;
  const pubnet = config.networks.length > 1 && config.networks.some((network) => network.network === PUBNET);
  const discovery = config.bazaar.enabled ? config.discovery.database.poolSize : undefined;
  return {
    shared: SHARED_POOL_SIZE,
    readiness: 1,
    ...(pubnet ? { pubnet: PUBNET_POOL_SIZE } : {}),
    ...(discovery === undefined ? {} : { discovery }),
    ...(discovery !== undefined && pubnet ? { pubnetDiscovery: discovery } : {}),
    ...(discovery === undefined ? {} : { searchIndex: SEARCH_INDEX_POOL_SIZE }),
  };
}

/** The most connections one process holds at once: every pool full. */
export function connectionsPerProcess(pools: DatabasePools): number {
  const sizes: readonly (number | undefined)[] = Object.values(pools);
  let total = 0;
  for (const size of sizes) total += size ?? 0;
  return total;
}
