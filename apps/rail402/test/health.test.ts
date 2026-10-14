import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { silentLogger, type StellarFacilitator } from "@rail402.dev/facilitator";
import {
  CounterWindows,
  HealthMonitor,
  Metrics,
  bucketQuantile,
  createApp,
  loadConfig,
  metricsObserver,
  type HealthInput,
  type HealthSnapshot,
  type NetworkHealthInput,
} from "@rail402.dev/service";

const NETWORK = "stellar:testnet";
const SPONSOR = Keypair.random().publicKey();
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const UPTO = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

function network(overrides: Partial<NetworkHealthInput> = {}): NetworkHealthInput {
  return {
    network: NETWORK,
    rpc: { ok: true, latestLedger: 1_000, latestLedgerClosedAt: new Date(clock - 3_000) },
    sponsor: {
      address: SPONSOR,
      balanceStroops: 500_000_000n,
      floorStroops: 250_000_000n,
      committed1hStroops: 12_345n,
    },
    channels: { total: 8, inUse: 2 },
    settlements: {
      last1h: { claimed: 1, submitted: 2, succeeded: 40, failed: 3, expired: 1 },
      unfinished: 2,
    },
    contracts: {
      checkedAt: new Date(clock),
      contracts: [
        { alias: "USDC", id: USDC, kind: "stellar_asset", instanceTtlLedgers: 2_000_000 },
        { alias: "payments", id: UPTO, kind: "wasm", instanceTtlLedgers: 1_000_000, codeTtlLedgers: 900_000 },
      ],
    },
    ...overrides,
  };
}

let clock = Date.parse("2026-09-30T12:00:00Z");

function monitor(metrics = new Metrics()) {
  return {
    metrics,
    health: new HealthMonitor(metrics, {
      version: "1.2.3",
      ttlWarnLedgers: 518_400,
      ttlCriticalLedgers: 120_960,
      now: () => clock,
    }),
  };
}

describe("HealthMonitor", () => {
  it("reports starting until the first poll, then a healthy snapshot with every field filled", async () => {
    const { health, metrics } = monitor();
    expect(health.snapshot()).toEqual({
      status: "ok",
      version: "1.2.3",
      state: "starting",
      checkedAt: null,
      warnings: [],
      networks: {},
    });
    const observer = metricsObserver(metrics);
    observer.leaseWait(NETWORK, 40, true);
    observer.repeat(NETWORK, "exact");
    metrics.catalogOutcomes.inc({ phase: "settle", status: "success", code: "recorded" });
    metrics.catalogOutcomes.inc({ phase: "origin_check", status: "success", code: "origin_confirmed" });
    metrics.searchDuration.observe({ method: "hybrid", partial: "false" }, 0.02);

    const input: HealthInput = {
      networks: [network()],
      catalog: { stats: { listings: { pending: 1, published: 5, quarantined: 0 }, queuedSettlements: 0 } },
      search: { indexRevision: 7, indexedAt: new Date(clock - 2_000), lastBuild: "ok" },
    };
    const snapshot = await health.refresh(input);
    expect(snapshot).toEqual<HealthSnapshot>({
      status: "ok",
      version: "1.2.3",
      state: "healthy",
      checkedAt: "2026-09-30T12:00:00.000Z",
      warnings: [],
      networks: {
        [NETWORK]: {
          rpc: { ok: true, latestLedger: 1_000, ledgerAgeSeconds: 3, transportErrors1h: 0 },
          sponsor: {
            address: SPONSOR,
            balanceStroops: "500000000",
            committed1hStroops: "12345",
            wasted1hStroops: "0",
          },
          channels: { total: 8, inUse: 2, leaseWaitP95Ms: expect.any(Number) as number, leaseTimeouts1h: 0 },
          settlements: {
            last1h: { succeeded: 40, failed: 3, expired: 1, pending: 3 },
            unfinished: 2,
            unresolvable: 0,
            repeats1h: 1,
          },
          sequenceConflicts1h: 0,
          contracts: {
            USDC: { id: USDC, instanceTtlLedgers: 2_000_000 },
            payments: { id: UPTO, instanceTtlLedgers: 1_000_000, codeTtlLedgers: 900_000 },
          },
        },
      },
      catalog: {
        listings: { pending: 1, published: 5, quarantined: 0 },
        outboxPending: 0,
        outcomes1h: { settle: { success: 1 }, origin_check: { success: 1 } },
      },
      search: {
        indexRevision: 7,
        indexAgeSeconds: 2,
        lastBuild: "ok",
        embeddingFailures1h: 0,
        p50Ms: expect.any(Number) as number,
        p95Ms: expect.any(Number) as number,
      },
    });
    const lease = snapshot.networks[NETWORK]?.channels.leaseWaitP95Ms ?? 0;
    expect(lease).toBeGreaterThan(25);
    expect(lease).toBeLessThanOrEqual(50);
    expect(snapshot.search?.p95Ms).toBeGreaterThan(10);
    expect(snapshot.search?.p95Ms).toBeLessThanOrEqual(25);
    // The handler serves exactly this object until the next refresh.
    expect(health.snapshot()).toBe(snapshot);
  });

  it("degrades on every critical condition and only warns on a TTL below the warning level", async () => {
    const { health, metrics } = monitor();
    metrics.settlementsUnresolvable.set({ network: NETWORK }, 2);
    const snapshot = await health.refresh({
      networks: [
        network({
          rpc: { ok: true, latestLedger: 1_000, latestLedgerClosedAt: new Date(clock - 120_000) },
          sponsor: { address: SPONSOR, balanceStroops: 10n, floorStroops: 250_000_000n },
          contracts: {
            error: "RPC unavailable",
            contracts: [
              { alias: "USDC", id: USDC, instanceTtlLedgers: 200_000 },
              { alias: "payments", id: UPTO, instanceTtlLedgers: 1_000_000, codeTtlLedgers: 100 },
              { alias: "gone", id: USDC, missing: true },
            ],
          },
        }),
      ],
      catalog: {},
      search: { lastBuild: "failed" },
    });
    expect(snapshot.state).toBe("degraded");
    expect(snapshot.warnings.map((warning) => [warning.code, warning.severity, warning.contract])).toEqual([
      ["ledger_stale", "critical", undefined],
      ["sponsor_below_floor", "critical", undefined],
      ["settlements_unresolvable", "critical", undefined],
      ["contract_ttl_unchecked", "warning", undefined],
      ["contract_ttl_low", "warning", "USDC"],
      ["contract_ttl_critical", "critical", "payments"],
      ["contract_missing", "critical", "gone"],
      ["catalog_unreadable", "critical", undefined],
      ["search_index_failed", "critical", undefined],
    ]);
    for (const warning of snapshot.warnings) expect(warning.message.trim()).not.toBe("");
    expect(snapshot.networks[NETWORK]?.settlements.unresolvable).toBe(2);
    expect(snapshot.catalog).toMatchObject({ listings: null, outboxPending: null });

    const warnOnly = await health.refresh({
      networks: [
        network({
          contracts: { contracts: [{ alias: "USDC", id: USDC, instanceTtlLedgers: 200_000 }] },
        }),
      ],
    });
    metrics.settlementsUnresolvable.set({ network: NETWORK }, 0);
    expect((await health.refresh({ networks: [network()] })).state).toBe("healthy");
    expect(warnOnly.warnings.map((warning) => warning.code)).toEqual([
      "settlements_unresolvable",
      "contract_ttl_low",
    ]);
  });

  it("reports the upto component without ever failing readiness on it", async () => {
    const { health } = monitor();
    const authority = Keypair.random().publicKey();
    const upto = (
      overrides: Partial<NonNullable<NetworkHealthInput["upto"]>> = {},
    ): NonNullable<NetworkHealthInput["upto"]> => ({
      contract: UPTO,
      authority: { address: authority, present: true, balanceStroops: 0n, spendableStroops: 0n, tokens: [] },
      keeper: { enabled: true, autoRestore: true },
      ...overrides,
    });
    const healthy = await health.refresh({ networks: [network({ upto: upto() })] });
    expect(healthy.state).toBe("healthy");
    expect(healthy.networks[NETWORK]?.upto).toEqual({
      contract: UPTO,
      authority: {
        address: authority,
        present: true,
        balanceStroops: "0",
        spendableStroops: "0",
        tokens: [],
      },
      keeper: {
        enabled: true,
        autoRestore: true,
        checkedAt: null,
        plan: null,
        lastAction: null,
        error: null,
      },
    });

    const at = new Date(clock);
    const troubled = await health.refresh({
      networks: [
        network({
          contracts: {
            contracts: [
              { alias: "upto", id: UPTO, kind: "wasm", instanceTtlLedgers: -40, codeTtlLedgers: 9 },
            ],
          },
          upto: upto({
            authority: {
              address: authority,
              present: true,
              balanceStroops: 10_001_000n,
              spendableStroops: 1_000n,
              tokens: [{ symbol: "USDC", contract: USDC, balance: 25n }],
            },
            keeper: {
              enabled: true,
              autoRestore: false,
              checkedAt: at,
              plan: "restore_required",
              lastAction: { action: "extend", transaction: "d".repeat(64), at },
              error: "the contract extension costs too much",
            },
          }),
        }),
      ],
    });
    expect(troubled.state).toBe("degraded");
    expect(troubled.warnings.map((warning) => [warning.code, warning.severity, warning.contract])).toEqual([
      ["contract_archived", "critical", "upto"],
      ["upto_authority_funded", "warning", undefined],
      ["upto_authority_holds_tokens", "warning", USDC],
      ["upto_contract_restore_required", "critical", undefined],
      ["upto_ttl_keeper_failed", "warning", undefined],
    ]);
    for (const warning of troubled.warnings) expect(warning.message.trim()).not.toBe("");
    expect(troubled.networks[NETWORK]?.upto?.authority).toMatchObject({
      balanceStroops: "10001000",
      spendableStroops: "1000",
      tokens: [{ symbol: "USDC", contract: USDC, balance: "25" }],
    });
    // A balance that only covers the reserve the authority pays itself is not spendable.
    const reserved = await health.refresh({
      networks: [
        network({
          upto: upto({
            authority: {
              address: authority,
              present: true,
              balanceStroops: 10_000_000n,
              spendableStroops: 0n,
            },
          }),
        }),
      ],
    });
    expect(reserved.warnings).toEqual([]);
    expect(troubled.networks[NETWORK]?.upto?.keeper).toMatchObject({
      plan: "restore_required",
      lastAction: { action: "extend", transaction: "d".repeat(64), at: at.toISOString() },
    });

    const missing = await health.refresh({
      networks: [network({ upto: upto({ authority: { address: authority, present: false } }) })],
    });
    expect(missing.warnings.map((warning) => [warning.code, warning.severity])).toEqual([
      ["upto_authority_missing", "critical"],
    ]);
  });

  it("reports an unreachable RPC and an unreadable settlement ledger", async () => {
    const { health } = monitor();
    const { settlements: _omit, ...unreadable } = network();
    const snapshot = await health.refresh({
      networks: [{ ...unreadable, rpc: { ok: false, error: "connect ECONNREFUSED 10.0.3.7:8000" } }],
    });
    expect(snapshot.state).toBe("degraded");
    expect(snapshot.warnings.map((warning) => warning.code)).toEqual([
      "rpc_unhealthy",
      "settlement_ledger_unreadable",
    ]);
    // The public snapshot names the kind of failure only, never an internal address.
    expect(snapshot.warnings[0]?.message).toBe(
      "The RPC did not answer the last poll: connection refused (details in the service log).",
    );
    expect(snapshot.networks[NETWORK]?.rpc).toEqual({
      ok: false,
      latestLedger: null,
      ledgerAgeSeconds: null,
      transportErrors1h: 0,
    });
    expect(snapshot.networks[NETWORK]?.settlements.last1h).toBeNull();
  });

  it("counts the last hour from per-minute samples of the counters", async () => {
    const { health, metrics } = monitor();
    const refresh = () => health.refresh({ networks: [network()] });
    metrics.rpcTransportErrors.inc({ network: NETWORK, target: "rpc", kind: "network" }, 3);
    metrics.sequenceConflicts.inc({ network: NETWORK, kind: "bad_seq" });
    metrics.sponsorFees.inc({ network: NETWORK, outcome: "wasted" }, 700);
    expect((await refresh()).networks[NETWORK]).toMatchObject({
      rpc: { transportErrors1h: 3 },
      sequenceConflicts1h: 1,
      sponsor: { wasted1hStroops: "700" },
    });
    clock += 30 * 60_000;
    metrics.rpcTransportErrors.inc({ network: NETWORK, target: "horizon", kind: "http_5xx" }, 2);
    expect((await refresh()).networks[NETWORK]?.rpc.transportErrors1h).toBe(5);
    clock += 31 * 60_000;
    // The first sample (3) is now more than an hour old and becomes the baseline.
    expect((await refresh()).networks[NETWORK]?.rpc.transportErrors1h).toBe(2);
    clock += 60 * 60_000;
    expect((await refresh()).networks[NETWORK]).toMatchObject({
      rpc: { transportErrors1h: 0 },
      sequenceConflicts1h: 0,
    });
  });
});

describe("CounterWindows", () => {
  it("keeps one sample per minute and one baseline older than an hour", () => {
    const windows = new CounterWindows();
    const start = 0;
    for (let minute = 0; minute <= 120; minute++) {
      windows.record("k", start + minute * 60_000, minute * 10);
      windows.record("k", start + minute * 60_000 + 30_000, minute * 10 + 5);
    }
    // Now at minute 120.5: latest 1205, baseline the newest sample at or before minute 60.5 (605).
    expect(windows.increase("k", start + 120 * 60_000 + 30_000)).toBe(600);
    expect(windows.increase("missing", 0)).toBe(0);
  });
});

describe("bucketQuantile", () => {
  it("interpolates inside the bucket, like histogram_quantile", () => {
    const buckets = [
      { le: 0.1, count: 50 },
      { le: 0.5, count: 90 },
      { le: 1, count: 100 },
      { le: Infinity, count: 100 },
    ];
    expect(bucketQuantile(buckets, 0.5)).toBeCloseTo(0.1);
    expect(bucketQuantile(buckets, 0.7)).toBeCloseTo(0.3);
    expect(bucketQuantile(buckets, 0.95)).toBeCloseTo(0.75);
    expect(
      bucketQuantile(
        [
          { le: 1, count: 0 },
          { le: Infinity, count: 0 },
        ],
        0.5,
      ),
    ).toBeUndefined();
    expect(
      bucketQuantile(
        [
          { le: 1, count: 1 },
          { le: Infinity, count: 10 },
        ],
        0.99,
      ),
    ).toBe(1);
  });
});

describe("GET /health", () => {
  const config = loadConfig({
    STORE: "memory",
    TESTNET_RPC_URL: "http://localhost:8000/rpc",
    TESTNET_SPONSOR_SECRET: Keypair.random().secret(),
  });
  const facilitator = {
    core: { getSupported: () => ({ kinds: [], extensions: [], signers: {} }) },
    networks: new Map(),
  } as unknown as StellarFacilitator;

  it("serves the poller's snapshot without doing any I/O, and 200 even when degraded", async () => {
    const snapshot = { ...(await monitor().health.refresh({ networks: [network({ rpc: { ok: false } })] })) };
    const health = vi.fn(() => snapshot);
    const readiness = vi.fn(() => Promise.resolve({ ready: false, checks: {} }));
    const app = createApp({
      config,
      facilitator,
      metrics: new Metrics(),
      log: silentLogger,
      readiness,
      health,
      version: "1.2.3",
    });
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(JSON.parse(JSON.stringify(snapshot)));
    expect(snapshot.state).toBe("degraded");
    expect(health).toHaveBeenCalledTimes(1);
    expect(readiness).not.toHaveBeenCalled();
  });
});

describe("GET /metrics", () => {
  it("requires the configured bearer token when METRICS_TOKEN_SHA256 is set", async () => {
    const token = "metrics-scrape-token";
    const config = loadConfig({
      STORE: "memory",
      TESTNET_RPC_URL: "http://localhost:8000/rpc",
      TESTNET_SPONSOR_SECRET: Keypair.random().secret(),
      METRICS_TOKEN_SHA256: createHash("sha256").update(token).digest("hex"),
    });
    const app = createApp({
      config,
      facilitator: { core: { getSupported: () => ({ kinds: [] }) } } as unknown as StellarFacilitator,
      metrics: new Metrics(),
      log: silentLogger,
      readiness: () => Promise.resolve({ ready: true, checks: {} }),
      version: "test",
    });
    const denied = await app.request("/metrics");
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toContain("Bearer");
    expect(await denied.json()).toMatchObject({ error: { code: "unauthorized" } });
    expect((await app.request("/metrics", { headers: { "x-api-key": token } })).status).toBe(401);
    expect((await app.request("/metrics", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    const allowed = await app.request("/metrics", { headers: { authorization: `Bearer ${token}` } });
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toContain("rail402_process_");
    // Health and readiness stay open for load balancers.
    expect((await app.request("/health")).status).toBe(200);
  });
});
