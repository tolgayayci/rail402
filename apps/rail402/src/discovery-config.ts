import { z } from "zod";
import { StrKey } from "@stellar/stellar-sdk";
import { PUBNET, TESTNET, USDC, type StellarNetwork } from "@rail402.dev/stellar";
import { ConfigError } from "./config-error.ts";
import { defaultUsageDetail, type UsageDetail } from "./discovery.ts";
import {
  DEFAULT_CATALOG_BUDGET,
  DEFAULT_MAX_LISTING_BYTES,
  PUBNET_CATALOG_BUDGET,
  type CatalogBudget,
  type CatalogOptions,
  type CatalogRules,
} from "@rail402.dev/bazaar";

/**
 * Discovery settings: the Bazaar's per-network catalog policy. Each network is configured with its
 * own `<NET>_` variables; pubnet never inherits a setting meant for testnet, and a missing pubnet
 * setting takes pubnet's stricter default.
 */
export interface DiscoveryConfig {
  /** Catalog policy per served network (CAIP-2 id). */
  readonly networks: Readonly<Record<string, NetworkDiscoveryConfig>>;
  /** The largest content one listing may publish, in bytes. */
  readonly maxListingBytes: number;
  /** Per-client cost limits of the discovery routes (see DiscoveryLimits). */
  readonly limits: { readonly perMinute: number; readonly uncachedSearchCost: number };
  /** Bounds on search's CPU and memory, so search load never starves settlement. */
  readonly search: {
    readonly embedConcurrency: number;
    readonly embedQueueLength: number;
    readonly queryCacheSize: number;
    readonly maxSnapshots: number;
    readonly maxSnapshotBytes: number;
    readonly maxIndexBytesPerNetwork: number;
    readonly pageCacheSize: number;
  };
  /**
   * Load shedding of the discovery routes (see DiscoveryAdmission): requests served at once, counting
   * each until its response has been handed to its client's connection, requests that may wait for a
   * turn, how long one may wait, and how many of them one client may have at once.
   */
  readonly admission: {
    readonly maxInFlight: number;
    readonly queueLength: number;
    readonly queueTimeoutMs: number;
    readonly maxInFlightPerClient: number;
  };
  /**
   * The discovery routes' own database pool, apart from the pool settlements, limits and metering use:
   * its size and how long a read waits for one of its connections.
   */
  readonly database: { readonly poolSize: number; readonly acquireTimeoutMs: number };
}

export interface NetworkDiscoveryConfig {
  readonly budget: CatalogBudget;
  readonly rules: CatalogRules;
  /**
   * Asset contracts whose amounts search treats as US dollars (for a `maxPrice` in dollars). Set by
   * contract, never by symbol: any token can call itself USDC.
   */
  readonly usdAssets: ReadonlySet<string>;
  /** What the usage routes publish for this network (see UsageDetail). */
  readonly usageDetail: UsageDetail;
}

const int = (min: number, max = Number.MAX_SAFE_INTEGER) => z.coerce.number().int().min(min).max(max);

/** The catalog-wide variables of earlier versions; they configure testnet only. */
const processSchema = z.object({
  BAZAAR_MAX_LISTING_BYTES: int(4_096, 1_048_576).default(DEFAULT_MAX_LISTING_BYTES),
  SEARCH_RATE_LIMIT_PER_MINUTE: int(0, 1_000_000).default(120),
  SEARCH_UNCACHED_COST: int(1, 100).default(5),
  SEARCH_EMBED_CONCURRENCY: int(1, 64).default(1),
  SEARCH_EMBED_QUEUE: int(0, 1_000).default(2),
  SEARCH_QUERY_CACHE_SIZE: int(0, 1_000_000).default(1_000),
  SEARCH_MAX_SNAPSHOTS: int(1, 1_000).default(4),
  SEARCH_MAX_SNAPSHOT_MB: int(1, 65_536).default(256),
  SEARCH_MAX_INDEX_MB_PER_NETWORK: int(1, 65_536).default(96),
  SEARCH_PAGE_CACHE_SIZE: int(0, 100_000).default(512),
  DISCOVERY_MAX_IN_FLIGHT: int(1, 10_000).default(32),
  DISCOVERY_QUEUE_LENGTH: int(0, 100_000).default(64),
  DISCOVERY_QUEUE_TIMEOUT_MS: int(0, 30_000).default(1_000),
  DISCOVERY_MAX_IN_FLIGHT_PER_CLIENT: int(1, 10_000).default(8),
  DISCOVERY_DATABASE_POOL_SIZE: int(1, 100).default(5),
  DISCOVERY_DATABASE_ACQUIRE_TIMEOUT_MS: int(100, 60_000).default(1_000),
});

const legacySchema = z.object({
  BAZAAR_MAX_NEW_LISTINGS_PER_HOUR: int(1, 10_000_000).optional(),
  BAZAAR_MAX_NEW_LISTINGS_PER_OWNER_PER_HOUR: int(1, 100_000).optional(),
  BAZAAR_MAX_NEW_LISTINGS_PER_PAYER_PER_HOUR: int(1, 100_000).optional(),
});

const networkSchema = z.object({
  BAZAAR_MAX_NEW_LISTINGS_PER_HOUR: int(1, 10_000_000).optional(),
  BAZAAR_MAX_NEW_LISTINGS_PER_OWNER_PER_HOUR: int(1, 100_000).optional(),
  BAZAAR_MAX_NEW_LISTINGS_PER_PAYER_PER_HOUR: int(1, 100_000).optional(),
  BAZAAR_ORIGIN_CHECKS_PER_HOST_PER_MINUTE: int(1, 10_000).optional(),
  BAZAAR_MAX_PUBLISHED_LISTINGS: int(1, 10_000_000).optional(),
  BAZAAR_MAX_PUBLISHED_PER_OWNER: int(0, 10_000_000).optional(),
  BAZAAR_UNVERIFIED_TTL_HOURS: int(1, 87_600).optional(),
  BAZAAR_IDLE_TTL_DAYS: int(0, 3_650).optional(),
  BAZAAR_ORIGINLESS_MCP: z.enum(["publish", "refuse"]).optional(),
  BAZAAR_MIN_SETTLED: z.string().optional(),
  BAZAAR_USD_ASSETS: z.string().optional(),
  BAZAAR_USAGE_DETAIL: z.enum(["settlements", "counts"]).optional(),
});

/**
 * Reads the discovery settings of every served network from `env`. Testnet falls back to the legacy
 * catalog-wide `BAZAAR_MAX_NEW_LISTINGS_*` variables, then to the defaults; pubnet to its own
 * stricter defaults only.
 */
export function loadDiscoveryConfig(
  env: Readonly<Record<string, string | undefined>>,
  networks: readonly StellarNetwork[],
): DiscoveryConfig {
  const legacy = parse(legacySchema, env, "");
  const entries = networks.map((network): [string, NetworkDiscoveryConfig] => {
    const prefix = network === PUBNET ? "PUBNET_" : "TESTNET_";
    const values = parse(networkSchema, env, prefix);
    const defaults =
      network === TESTNET
        ? {
            ...DEFAULT_CATALOG_BUDGET,
            ...defined({
              maxNewListingsPerHour: legacy.BAZAAR_MAX_NEW_LISTINGS_PER_HOUR,
              maxNewListingsPerOwnerPerHour: legacy.BAZAAR_MAX_NEW_LISTINGS_PER_OWNER_PER_HOUR,
              maxNewListingsPerPayerPerHour: legacy.BAZAAR_MAX_NEW_LISTINGS_PER_PAYER_PER_HOUR,
            }),
          }
        : PUBNET_CATALOG_BUDGET;
    const budget: CatalogBudget = {
      ...defaults,
      ...defined({
        maxNewListingsPerHour: values.BAZAAR_MAX_NEW_LISTINGS_PER_HOUR,
        maxNewListingsPerOwnerPerHour: values.BAZAAR_MAX_NEW_LISTINGS_PER_OWNER_PER_HOUR,
        maxNewListingsPerPayerPerHour: values.BAZAAR_MAX_NEW_LISTINGS_PER_PAYER_PER_HOUR,
        originChecksPerHostPerMinute: values.BAZAAR_ORIGIN_CHECKS_PER_HOST_PER_MINUTE,
        maxPublishedListings: values.BAZAAR_MAX_PUBLISHED_LISTINGS,
        maxPublishedListingsPerOwner: values.BAZAAR_MAX_PUBLISHED_PER_OWNER,
        unverifiedListingTtlHours: values.BAZAAR_UNVERIFIED_TTL_HOURS,
        idleListingTtlDays: values.BAZAAR_IDLE_TTL_DAYS,
      }),
    };
    const originlessMcp = values.BAZAAR_ORIGINLESS_MCP ?? (network === PUBNET ? "refuse" : "publish");
    if (network === PUBNET && originlessMcp !== "refuse") {
      throw new ConfigError(
        "PUBNET_BAZAAR_ORIGINLESS_MCP must be refuse: tools without an https endpoint cannot be verified, so pubnet never catalogs them",
        "config_bazaar_policy_invalid",
      );
    }
    const minSettled = parseMinimums(values.BAZAAR_MIN_SETTLED, `${prefix}BAZAAR_MIN_SETTLED`);
    const usdAssets = new Set(
      values.BAZAAR_USD_ASSETS === undefined
        ? [USDC[network].contract]
        : contracts(values.BAZAAR_USD_ASSETS, `${prefix}BAZAAR_USD_ASSETS`),
    );
    const usageDetail = values.BAZAAR_USAGE_DETAIL ?? defaultUsageDetail(network);
    return [network, { budget, rules: { originlessMcp, minSettled }, usdAssets, usageDetail }];
  });
  const shared = parse(processSchema, env, "");
  return {
    networks: Object.fromEntries(entries),
    maxListingBytes: shared.BAZAAR_MAX_LISTING_BYTES,
    limits: {
      perMinute: shared.SEARCH_RATE_LIMIT_PER_MINUTE,
      uncachedSearchCost: shared.SEARCH_UNCACHED_COST,
    },
    search: {
      embedConcurrency: shared.SEARCH_EMBED_CONCURRENCY,
      embedQueueLength: shared.SEARCH_EMBED_QUEUE,
      queryCacheSize: shared.SEARCH_QUERY_CACHE_SIZE,
      maxSnapshots: shared.SEARCH_MAX_SNAPSHOTS,
      maxSnapshotBytes: shared.SEARCH_MAX_SNAPSHOT_MB * 1024 * 1024,
      maxIndexBytesPerNetwork: shared.SEARCH_MAX_INDEX_MB_PER_NETWORK * 1024 * 1024,
      pageCacheSize: shared.SEARCH_PAGE_CACHE_SIZE,
    },
    admission: {
      maxInFlight: shared.DISCOVERY_MAX_IN_FLIGHT,
      queueLength: shared.DISCOVERY_QUEUE_LENGTH,
      queueTimeoutMs: shared.DISCOVERY_QUEUE_TIMEOUT_MS,
      maxInFlightPerClient: shared.DISCOVERY_MAX_IN_FLIGHT_PER_CLIENT,
    },
    database: {
      poolSize: shared.DISCOVERY_DATABASE_POOL_SIZE,
      acquireTimeoutMs: shared.DISCOVERY_DATABASE_ACQUIRE_TIMEOUT_MS,
    },
  };
}

/** Parses `CONTRACT:AMOUNT` entries separated by commas; amounts are in base units. */
function parseMinimums(value: string | undefined, name: string): Readonly<Record<string, bigint>> {
  const minimums: Record<string, bigint> = {};
  for (const entry of (value ?? "").split(",").map((part) => part.trim())) {
    if (entry === "") continue;
    const [contract = "", amount = "", ...rest] = entry.split(":");
    if (!StrKey.isValidContract(contract) || !/^\d{1,39}$/.test(amount) || rest.length > 0) {
      throw new ConfigError(
        `${name}: "${entry}" must be CONTRACT:AMOUNT with a C… contract and an amount in base units`,
      );
    }
    if (Object.hasOwn(minimums, contract)) throw new ConfigError(`${name}: ${contract} is listed twice`);
    minimums[contract] = BigInt(amount);
  }
  return minimums;
}

function contracts(value: string, name: string): string[] {
  const list = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  for (const contract of list) {
    if (!StrKey.isValidContract(contract))
      throw new ConfigError(`${name}: "${contract}" is not a C… contract address`);
  }
  return list;
}

/** Whether search treats amounts of `contract` on `network` as US dollars. */
export function isUsdAsset(config: DiscoveryConfig, network: string, contract: string): boolean {
  return config.networks[network]?.usdAssets.has(contract) ?? false;
}

function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

function parse<T extends z.ZodObject>(
  schema: T,
  env: Readonly<Record<string, string | undefined>>,
  prefix: string,
): z.infer<T> {
  const input: Record<string, string | undefined> = {};
  for (const key of Object.keys(schema.shape)) {
    const value = env[`${prefix}${key}`];
    input[key] = value === "" ? undefined : value;
  }
  const result = schema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${prefix}${issue.path.join(".")}: ${issue.message}`);
    throw new ConfigError(`invalid configuration:\n  ${issues.join("\n  ")}`);
  }
  return result.data;
}

/** The catalog options of the discovery settings. */
export function catalogOptions(
  config: DiscoveryConfig,
): Pick<CatalogOptions, "networks" | "maxListingBytes"> {
  return {
    maxListingBytes: config.maxListingBytes,
    networks: Object.fromEntries(
      Object.entries(config.networks).map(([network, { budget, rules }]) => [
        network,
        { ...budget, ...rules },
      ]),
    ),
  };
}

/** The search options of the discovery settings. */
export function searchOptions(config: DiscoveryConfig): DiscoveryConfig["search"] {
  return config.search;
}
