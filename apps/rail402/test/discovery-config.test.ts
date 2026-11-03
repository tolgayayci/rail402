import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { ConfigError, loadConfig } from "@rail402.dev/service";
import { isUsdAsset, loadDiscoveryConfig } from "../src/discovery-config.ts";

const both = ["stellar:testnet", "stellar:pubnet"] as const;

describe("discovery settings", () => {
  it("keeps catalog budgets per network, with stricter pubnet defaults", () => {
    const config = loadDiscoveryConfig({}, both);
    expect(config.networks["stellar:testnet"]?.budget).toEqual({
      maxNewListingsPerHour: 1_000,
      maxNewListingsPerOwnerPerHour: 20,
      maxNewListingsPerPayerPerHour: 10,
      originChecksPerHostPerMinute: 30,
      maxPublishedListings: 5_000,
      maxPublishedListingsPerOwner: 0,
      unverifiedListingTtlHours: 168,
      idleListingTtlDays: 90,
    });
    expect(config.networks["stellar:pubnet"]?.budget).toEqual({
      maxNewListingsPerHour: 200,
      maxNewListingsPerOwnerPerHour: 5,
      maxNewListingsPerPayerPerHour: 5,
      originChecksPerHostPerMinute: 10,
      maxPublishedListings: 25_000,
      maxPublishedListingsPerOwner: 250,
      unverifiedListingTtlHours: 168,
      idleListingTtlDays: 90,
    });
  });

  it("applies the legacy catalog-wide quotas to testnet only", () => {
    const config = loadDiscoveryConfig(
      {
        BAZAAR_MAX_NEW_LISTINGS_PER_HOUR: "5000",
        BAZAAR_MAX_NEW_LISTINGS_PER_OWNER_PER_HOUR: "50",
        BAZAAR_MAX_NEW_LISTINGS_PER_PAYER_PER_HOUR: "40",
      },
      both,
    );
    expect(config.networks["stellar:testnet"]?.budget).toMatchObject({
      maxNewListingsPerHour: 5_000,
      maxNewListingsPerOwnerPerHour: 50,
      maxNewListingsPerPayerPerHour: 40,
    });
    expect(config.networks["stellar:pubnet"]?.budget).toMatchObject({
      maxNewListingsPerHour: 200,
      maxNewListingsPerOwnerPerHour: 5,
      maxNewListingsPerPayerPerHour: 5,
    });
  });

  it("reads each network's own budget variables, which win over the legacy ones", () => {
    const config = loadDiscoveryConfig(
      {
        BAZAAR_MAX_NEW_LISTINGS_PER_HOUR: "5000",
        TESTNET_BAZAAR_MAX_NEW_LISTINGS_PER_HOUR: "3000",
        TESTNET_BAZAAR_ORIGIN_CHECKS_PER_HOST_PER_MINUTE: "60",
        PUBNET_BAZAAR_MAX_NEW_LISTINGS_PER_HOUR: "50",
        PUBNET_BAZAAR_MAX_NEW_LISTINGS_PER_OWNER_PER_HOUR: "2",
        PUBNET_BAZAAR_MAX_NEW_LISTINGS_PER_PAYER_PER_HOUR: "3",
        PUBNET_BAZAAR_ORIGIN_CHECKS_PER_HOST_PER_MINUTE: "4",
        PUBNET_BAZAAR_MAX_PUBLISHED_LISTINGS: "1000",
        PUBNET_BAZAAR_MAX_PUBLISHED_PER_OWNER: "40",
        PUBNET_BAZAAR_IDLE_TTL_DAYS: "365",
        TESTNET_BAZAAR_UNVERIFIED_TTL_HOURS: "12",
        TESTNET_BAZAAR_IDLE_TTL_DAYS: "0",
      },
      both,
    );
    expect(config.networks["stellar:testnet"]?.budget).toMatchObject({
      maxNewListingsPerHour: 3_000,
      originChecksPerHostPerMinute: 60,
      unverifiedListingTtlHours: 12,
      idleListingTtlDays: 0,
    });
    expect(config.networks["stellar:pubnet"]?.budget).toEqual({
      maxNewListingsPerHour: 50,
      maxNewListingsPerOwnerPerHour: 2,
      maxNewListingsPerPayerPerHour: 3,
      originChecksPerHostPerMinute: 4,
      maxPublishedListings: 1_000,
      maxPublishedListingsPerOwner: 40,
      unverifiedListingTtlHours: 168,
      idleListingTtlDays: 365,
    });
  });

  it("names the variable of a malformed budget", () => {
    expect(() => loadDiscoveryConfig({ PUBNET_BAZAAR_MAX_NEW_LISTINGS_PER_HOUR: "0" }, both)).toThrow(
      /PUBNET_BAZAAR_MAX_NEW_LISTINGS_PER_HOUR/,
    );
    expect(() =>
      loadDiscoveryConfig({ TESTNET_BAZAAR_ORIGIN_CHECKS_PER_HOST_PER_MINUTE: "x" }, both),
    ).toThrow(ConfigError);
  });

  it("refuses mcp:// tools on pubnet and refuses a pubnet setting that would publish them", () => {
    const config = loadDiscoveryConfig({}, both);
    expect(config.networks["stellar:pubnet"]?.rules.originlessMcp).toBe("refuse");
    expect(config.networks["stellar:testnet"]?.rules.originlessMcp).toBe("publish");
    expect(
      loadDiscoveryConfig({ TESTNET_BAZAAR_ORIGINLESS_MCP: "refuse" }, both).networks["stellar:testnet"]
        ?.rules.originlessMcp,
    ).toBe("refuse");
    let error: unknown;
    try {
      loadDiscoveryConfig({ PUBNET_BAZAAR_ORIGINLESS_MCP: "publish" }, both);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect(error).toMatchObject({ code: "config_bazaar_policy_invalid" });
    expect((error as Error).message).toContain("PUBNET_BAZAAR_ORIGINLESS_MCP");
  });

  it("publishes usage counts only on pubnet by default, each network settable on its own", () => {
    const defaults = loadDiscoveryConfig({}, both);
    expect(defaults.networks["stellar:testnet"]?.usageDetail).toBe("settlements");
    expect(defaults.networks["stellar:pubnet"]?.usageDetail).toBe("counts");
    const set = loadDiscoveryConfig(
      { PUBNET_BAZAAR_USAGE_DETAIL: "settlements", TESTNET_BAZAAR_USAGE_DETAIL: "counts" },
      both,
    );
    expect(set.networks["stellar:pubnet"]?.usageDetail).toBe("settlements");
    expect(set.networks["stellar:testnet"]?.usageDetail).toBe("counts");
    expect(() => loadDiscoveryConfig({ PUBNET_BAZAAR_USAGE_DETAIL: "payers" }, both)).toThrow(
      /PUBNET_BAZAAR_USAGE_DETAIL/,
    );
  });

  it("reads an optional minimum settled amount per asset, off by default", () => {
    expect(loadDiscoveryConfig({}, both).networks["stellar:pubnet"]?.rules.minSettled).toEqual({});
    const usdc = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
    const config = loadDiscoveryConfig({ PUBNET_BAZAAR_MIN_SETTLED: `${usdc}:10000` }, both);
    expect(config.networks["stellar:pubnet"]?.rules.minSettled).toEqual({ [usdc]: 10_000n });
    expect(config.networks["stellar:testnet"]?.rules.minSettled).toEqual({});
    for (const value of ["GABC:1", `${usdc}:-1`, `${usdc}:1:2`, `${usdc}:1,${usdc}:2`]) {
      expect(() => loadDiscoveryConfig({ PUBNET_BAZAAR_MIN_SETTLED: value }, both)).toThrow(
        /PUBNET_BAZAAR_MIN_SETTLED/,
      );
    }
  });

  it("treats only configured asset contracts as US dollars, never a symbol", () => {
    const config = loadDiscoveryConfig({}, both);
    expect([...(config.networks["stellar:pubnet"]?.usdAssets ?? [])]).toEqual([
      "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
    ]);
    expect([...(config.networks["stellar:testnet"]?.usdAssets ?? [])]).toEqual([
      "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    ]);
    expect(() => loadDiscoveryConfig({ TESTNET_BAZAAR_USD_ASSETS: "USDC" }, both)).toThrow(
      /TESTNET_BAZAAR_USD_ASSETS/,
    );
  });

  it("does not treat a token named USDC from another issuer as USD", () => {
    const impostor = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
    const config = loadConfig({
      DATABASE_URL: "postgres://rail402:rail402@localhost:5432/rail402",
      TESTNET_RPC_URL: "https://soroban-testnet.stellar.org",
      TESTNET_SPONSOR_SECRET: Keypair.random().secret(),
      TESTNET_ASSETS: `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA:USDC:7,${impostor}:USDC:7`,
    });
    expect(
      isUsdAsset(
        config.discovery,
        "stellar:testnet",
        "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      ),
    ).toBe(true);
    expect(isUsdAsset(config.discovery, "stellar:testnet", impostor)).toBe(false);
    expect(isUsdAsset(config.discovery, "stellar:pubnet", impostor)).toBe(false);
  });

  it("reads the search load limits, with defaults that keep one embedding running at a time", () => {
    expect(loadDiscoveryConfig({}, both)).toMatchObject({
      limits: { perMinute: 120, uncachedSearchCost: 5 },
      search: {
        embedConcurrency: 1,
        embedQueueLength: 2,
        queryCacheSize: 1_000,
        maxSnapshots: 4,
        maxSnapshotBytes: 256 * 1024 * 1024,
        maxIndexBytesPerNetwork: 96 * 1024 * 1024,
        pageCacheSize: 512,
      },
      admission: { maxInFlight: 32, queueLength: 64, queueTimeoutMs: 1_000, maxInFlightPerClient: 8 },
      database: { poolSize: 5, acquireTimeoutMs: 1_000 },
    });
    const config = loadDiscoveryConfig(
      {
        SEARCH_RATE_LIMIT_PER_MINUTE: "0",
        SEARCH_UNCACHED_COST: "10",
        SEARCH_EMBED_CONCURRENCY: "2",
        SEARCH_EMBED_QUEUE: "0",
        SEARCH_QUERY_CACHE_SIZE: "0",
        SEARCH_MAX_SNAPSHOTS: "3",
        SEARCH_MAX_SNAPSHOT_MB: "64",
        SEARCH_MAX_INDEX_MB_PER_NETWORK: "32",
        SEARCH_PAGE_CACHE_SIZE: "0",
        DISCOVERY_MAX_IN_FLIGHT: "8",
        DISCOVERY_QUEUE_LENGTH: "0",
        DISCOVERY_QUEUE_TIMEOUT_MS: "250",
        DISCOVERY_MAX_IN_FLIGHT_PER_CLIENT: "2",
        DISCOVERY_DATABASE_POOL_SIZE: "3",
        DISCOVERY_DATABASE_ACQUIRE_TIMEOUT_MS: "500",
      },
      both,
    );
    expect(config.limits).toEqual({ perMinute: 0, uncachedSearchCost: 10 });
    expect(config.search).toEqual({
      embedConcurrency: 2,
      embedQueueLength: 0,
      queryCacheSize: 0,
      maxSnapshots: 3,
      maxSnapshotBytes: 64 * 1024 * 1024,
      maxIndexBytesPerNetwork: 32 * 1024 * 1024,
      pageCacheSize: 0,
    });
    expect(config.admission).toEqual({
      maxInFlight: 8,
      queueLength: 0,
      queueTimeoutMs: 250,
      maxInFlightPerClient: 2,
    });
    expect(config.database).toEqual({ poolSize: 3, acquireTimeoutMs: 500 });
    expect(() => loadDiscoveryConfig({ SEARCH_EMBED_CONCURRENCY: "0" }, both)).toThrow(
      /SEARCH_EMBED_CONCURRENCY/,
    );
    expect(() => loadDiscoveryConfig({ DISCOVERY_MAX_IN_FLIGHT: "0" }, both)).toThrow(
      /DISCOVERY_MAX_IN_FLIGHT/,
    );
    expect(() => loadDiscoveryConfig({ DISCOVERY_MAX_IN_FLIGHT_PER_CLIENT: "0" }, both)).toThrow(
      /DISCOVERY_MAX_IN_FLIGHT_PER_CLIENT/,
    );
    expect(() => loadDiscoveryConfig({ DISCOVERY_DATABASE_ACQUIRE_TIMEOUT_MS: "50" }, both)).toThrow(
      /DISCOVERY_DATABASE_ACQUIRE_TIMEOUT_MS/,
    );
  });

  it("is part of the service configuration, for the served networks only", () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://rail402:rail402@localhost:5432/rail402",
      TESTNET_RPC_URL: "https://soroban-testnet.stellar.org",
      TESTNET_SPONSOR_SECRET: Keypair.random().secret(),
      TESTNET_BAZAAR_MAX_NEW_LISTINGS_PER_HOUR: "7",
    });
    expect(Object.keys(config.discovery.networks)).toEqual(["stellar:testnet"]);
    expect(config.discovery.networks["stellar:testnet"]?.budget.maxNewListingsPerHour).toBe(7);
  });
});
