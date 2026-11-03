import { Keypair, xdr, type rpc } from "@stellar/stellar-sdk";
import type { Kysely } from "kysely";
import {
  MemoryChannelPool,
  MemorySettlementLedger,
  MemoryTaskLock,
  ProvisionRefusedError,
  RpcPool,
  SettleLimits,
  SignerSetError,
  assertSignerSet,
  readSignerSet,
  SponsorBudget,
  authorityStatus,
  createStellarFacilitator,
  deriveAuthorityKeypair,
  deriveChannelKeypairs,
  existingAccounts,
  ledgerCloseSeconds,
  provisionAuthority,
  provisionChannels,
  type CallerUsage,
  type ChannelPool,
  type InclusionFeeReading,
  type Logger,
  type SettlementLedger,
  type SettlementState,
  type StellarFacilitator,
  type TaskLock,
  recordRestoreHold,
} from "@rail402.dev/facilitator";
import {
  AssetDirectory,
  PUBNET,
  networkPassphrase,
  readContractTtl,
  type StellarNetwork,
} from "@rail402.dev/stellar";
import {
  Catalog,
  MemoryCatalogStore,
  SchemaSandboxes,
  type CatalogStats,
  type CatalogStore,
} from "@rail402.dev/bazaar";
import { BAZAAR } from "@x402/extensions/bazaar";
import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import {
  AssetRegistry,
  OnnxEmbedder,
  SearchService,
  ensureModel,
  loadManifest,
  type Embedder,
  type SearchObserver,
} from "@rail402.dev/search";
import {
  DatabaseProbe,
  PostgresCatalogStore,
  PostgresChannelPool,
  type PostgresRateLimiter,
  PostgresSettlementLedger,
  PostgresTaskLock,
  createDatabase,
  type Database,
} from "@rail402.dev/store-postgres";
import { cachedProbe } from "./cached-probe.ts";
import { checkConnectionBudget, prepareDatabase } from "./database-checks.ts";
import { SHARED_POOL_SIZE, databasePools } from "./database-pools.ts";
import { createAccessStores } from "./network-stores.ts";
import { singleFlight } from "./single-flight.ts";
import type { NetworkReadiness, Readiness, ReadinessCheck } from "./app.ts";
import { checkAssets, type AssetCheck } from "./asset-check.ts";
import {
  ConfigError,
  MAX_CHANNEL_COUNT,
  networkSettingsDigest,
  type Config,
  type NetworkConfig,
} from "./config.ts";
import { NetworkGate, STICKY_HOLDS, type HoldReason } from "./network-state.ts";
// --- discovery settings (DISCOVERY) ---
import { catalogOptions, isUsdAsset, searchOptions } from "./discovery-config.ts";
import { laneRouted } from "./discovery.ts";
// --- end discovery settings ---
import { HealthMonitor, type HealthSnapshot } from "./health.ts";
import { AccessKeys, legacyKeys } from "./access.ts";
import { metricsCatalogObserver, metricsObserver, metricsSearchObserver, type Metrics } from "./metrics.ts";
import { HORIZON_ORIGINS, meterRpcServer, watchTransport, type TransportTarget } from "./rpc-metrics.ts";
import { ContractTtlMonitor } from "./ttl-monitor.ts";
import { UPTO_TTL_SPEND, UptoTtlKeeper, sponsorLockName } from "./upto-keeper.ts";
import { LocalKeyedRateLimiter, type KeyedRateLimiter } from "./rate-limit.ts";
import type { UsageMeter } from "./metering.ts";
import { publicReason } from "./public-reason.ts";
import { describeFailure } from "./failure.ts";

interface NetworkState {
  readonly config: NetworkConfig;
  /** The network's RPC providers; `server` talks to the active one. */
  readonly pool: RpcPool;
  /** Whether this network serves `/verify` and `/settle` now. */
  readonly gate: NetworkGate;
  /** Why the startup chain checks failed, until a poll repeats them successfully. */
  startupHold?: HoldReason;
  /** Repeats the startup chain checks. */
  readonly bringUp: (progress?: BringUpProgress) => Promise<BringUp>;
  /** False once a poll found the sponsor account missing. */
  sponsorExists?: boolean;
  readonly server: rpc.Server;
  readonly sponsor: string;
  readonly channels: ChannelPool;
  readonly ledger: SettlementLedger;
  readonly ttl: ContractTtlMonitor;
  readonly directory: AssetDirectory;
  /** The accepted assets compared with the chain; re-read by the poll until they pass. */
  assets: AssetCheck;
  /** Present when the network serves `upto`. */
  readonly upto?: {
    readonly contract: string;
    readonly authority: string;
    readonly keeper: UptoTtlKeeper;
    authorityPresent?: boolean;
    authorityBalance?: bigint;
    authoritySpendable?: bigint;
    /** Accepted tokens the authority holds a balance of; it should hold none. */
    authorityTokens?: readonly {
      readonly symbol: string;
      readonly contract: string;
      readonly balance: bigint;
    }[];
  };
  sponsorBalance?: bigint;
  rpcHealthy: boolean;
  channelsProvisioned: boolean;
  lastError?: string;
  latestLedger?: number;
  latestLedgerClosedAt?: Date;
  /** A ledger far below the restore hold's, seen by an earlier poll: a possible network reset. */
  restartSeen?: number;
  /** Polls in a row that found the restore hold pending (nothing recorded to count it from). */
  restoreHoldPendingPolls?: number;
  committed1hStroops?: bigint;
  settlements?: { last1h: Record<SettlementState, number>; unfinished: number };
}

export interface Runtime {
  readonly facilitator: StellarFacilitator;
  /** Shared rate limiters and usage meter, when Postgres is the store. */
  readonly access?: {
    readonly rateLimiter: PostgresRateLimiter;
    /** The service-wide limit of pubnet key holders on the pubnet host, on pubnet's pool, when it has one. */
    readonly pubnetRateLimiter?: PostgresRateLimiter;
    readonly networkLimiter: KeyedRateLimiter;
    /** The address and internal-identity limits of the discovery routes, on the discovery pool. */
    readonly discoveryLimiter?: PostgresRateLimiter;
    readonly meter: UsageMeter;
  };
  /** The access keys, re-read from `API_KEYS_FILE` when it changes. */
  readonly accessKeys: AccessKeys;
  /** The Bazaar catalog, when enabled. */
  readonly bazaar?: {
    readonly catalog: Catalog;
    /** The catalog as the discovery routes read it: through the discovery pool with Postgres. */
    readonly store: CatalogStore;
    readonly search: SearchService;
  };
  /** Aggregate readiness: process checks and the networks that gate readiness (`GATES_READY`). */
  readiness(): Promise<Readiness>;
  /** One network's readiness, or undefined when the network is not configured. */
  networkReadiness(network: string): NetworkReadiness | undefined;
  /** Why `/verify` and `/settle` are refused for `network` now, or undefined while it serves. */
  refusal(network: string): string | undefined;
  /** A caller's settlement usage since `since`, from the settlement ledgers. */
  settlementUsage(subject: string, since: Date): Promise<CallerUsage[]>;
  /** Fees a caller's settlements committed in the last hour on `network`. */
  callerCommitted(network: string, subject: string): Promise<bigint>;
  /** The latest `/health` snapshot, built by the background poll; never does I/O. */
  health(): HealthSnapshot;
  /** The `upto` contract TTL keeper of each network that serves `upto`. */
  readonly uptoKeepers: ReadonlyMap<string, UptoTtlKeeper>;
  /** Starts background work: reconciliation and balance polling. */
  start(): void;
  /** Stops background work, reconciles once more and closes the database. */
  stop(): Promise<void>;
}

/** How often the network poll refreshes balances, RPC health, the settlement counts and /health. */
const POLL_INTERVAL_MS = 15_000;

/** A network poll running longer than this stops blocking the next one (see `singleFlight`). */
const POLL_DEADLINE_MS = 120_000;

/** Pending polls in a row after which, and every as many after, the pending restore hold is logged. */
const PENDING_WARN_POLLS = 4;
/** How often `rail402_channels_in_use` is counted; scrapes only read the last count. */
export const CHANNELS_IN_USE_INTERVAL_MS = 1_000;
/** How long one database readiness probe answers `/ready` for. */
export const READINESS_DATABASE_TTL_MS = 2_000;

/**
 * A transaction hash no transaction has. Asking the RPC for it is the cheapest call that reports the
 * latest ledger's close time (getLatestLedger returns the whole ledger's metadata).
 */
const ABSENT_TRANSACTION = "0".repeat(64);

/**
 * The ranking and resource settings the runtime builds its search service with, from configuration.
 * The search evaluation's parity check builds its service from the same function.
 */
export function searchSettings(config: Config) {
  return {
    similarityFloor: config.search.similarityFloor,
    // One revision read per second at most; a new listing is searchable within that second.
    revisionMaxAgeMs: 1_000,
    // --- discovery settings (DISCOVERY) ---
    ...searchOptions(config.discovery),
    // --- end discovery settings ---
  };
}

/** Builds the facilitator and its stores from configuration. Fails fast on anything unusable. */
export async function createRuntime(
  config: Config,
  metrics: Metrics,
  log: Logger,
  options: { readonly version?: string } = {},
): Promise<Runtime> {
  // Every pool this process opens, and so the most connections it holds (`check-config` reports them).
  const pools = databasePools(config);
  let db: Kysely<Database> | undefined;
  if (config.store.kind === "postgres") {
    db = createDatabase({
      connectionString: config.store.url,
      maxConnections: SHARED_POOL_SIZE,
      acquireTimeoutMs: config.store.acquireTimeoutMs,
      onIdleError: (error) => {
        log.warn({ err: error }, "an idle database connection failed; the pool replaces it");
      },
    });
    let applied: string[];
    try {
      applied = await prepareDatabase(db, config, { apply: true });
      const budget = await checkConnectionBudget(db, config);
      if (budget !== undefined) {
        const fields = { ...budget, pools };
        if (budget.replicas < 1) {
          log.warn(
            fields,
            "the database role cannot hold every pool of this process; raise its CONNECTION LIMIT",
          );
        } else log.info(fields, "database connection budget");
      }
    } catch (error) {
      await db.destroy();
      throw error;
    }
    if (applied.length > 0) log.info({ migrations: applied }, "database migrated");
  } else {
    log.warn({}, "STORE=memory: settlements are not durable and only one replica is safe");
  }

  const states: NetworkState[] = [];
  const setups = [];
  // With several networks in one process, pubnet's settlement ledger, channel leases, request, party
  // and key holders' service-wide limits, metering and provisioning locks use a pool of their own (same
  // database and role), so a flood of testnet work cannot take every connection pubnet's settle path
  // needs.
  const pubnetDb =
    db !== undefined && config.store.kind === "postgres" && pools?.pubnet !== undefined
      ? createDatabase({
          connectionString: config.store.url,
          maxConnections: pools.pubnet,
          acquireTimeoutMs: config.store.acquireTimeoutMs,
          onIdleError: (error) => {
            log.warn({ err: error }, "an idle pubnet database connection failed; the pool replaces it");
          },
        })
      : undefined;
  // The discovery routes read the catalog through a pool of their own (same database and role), small
  // and quick to give up: a flood of searches or list pages can hold every one of its connections and
  // still never take one settlements, limits, metering or readiness need.
  const discoveryDb =
    db !== undefined && config.store.kind === "postgres" && pools?.discovery !== undefined
      ? createDatabase({
          connectionString: config.store.url,
          maxConnections: pools.discovery,
          acquireTimeoutMs: config.discovery.database.acquireTimeoutMs,
          onIdleError: (error) => {
            log.warn({ err: error }, "an idle discovery database connection failed; the pool replaces it");
          },
        })
      : undefined;
  // Discovery requests scoped to pubnet read through a discovery pool of their own (same size), so
  // testnet or unscoped discovery holding every shared discovery connection never sheds them.
  const pubnetDiscoveryDb =
    discoveryDb !== undefined && config.store.kind === "postgres" && pools?.pubnetDiscovery !== undefined
      ? createDatabase({
          connectionString: config.store.url,
          maxConnections: pools.pubnetDiscovery,
          acquireTimeoutMs: config.discovery.database.acquireTimeoutMs,
          onIdleError: (error) => {
            log.warn(
              { err: error },
              "an idle pubnet discovery database connection failed; the pool replaces it",
            );
          },
        })
      : undefined;
  // The search index is built through a pool of its own (same database and role) that no request
  // takes. A search that finds the index behind the catalog joins the build in flight, whichever lane
  // or background task started it, so a build waiting on a discovery pool that testnet or unscoped load
  // holds would hold pubnet searches with it.
  const searchIndexDb =
    discoveryDb !== undefined && config.store.kind === "postgres" && pools?.searchIndex !== undefined
      ? createDatabase({
          connectionString: config.store.url,
          maxConnections: pools.searchIndex,
          acquireTimeoutMs: config.discovery.database.acquireTimeoutMs,
          onIdleError: (error) => {
            log.warn({ err: error }, "an idle search index database connection failed; the pool replaces it");
          },
        })
      : undefined;
  // Limiters and metering, shared by every replica with Postgres; pubnet's on its own pool, discovery's
  // on the discovery pools.
  const stores =
    db === undefined
      ? undefined
      : createAccessStores(db, pubnetDb, {
          rateLimitPerMinute: config.http.rateLimitPerMinute,
          pubnet: PUBNET,
          ...(discoveryDb === undefined ? {} : { discoveryDb }),
          ...(pubnetDiscoveryDb === undefined ? {} : { pubnetDiscoveryDb }),
        });
  // Per-payer and per-payTo settlement limits.
  const partyLimiter: KeyedRateLimiter = stores?.partyLimiter ?? new LocalKeyedRateLimiter();
  // One TTL round per network at a time across every replica sharing the database.
  const lock: TaskLock = db === undefined ? new MemoryTaskLock() : new PostgresTaskLock(db);
  // Pubnet's provisioning and TTL rounds lock through its own pool: advisory locks span the database,
  // so replicas still exclude each other, and testnet work holding every shared connection never fails
  // pubnet's provisioning or authority checks.
  const pubnetLock: TaskLock | undefined =
    pubnetDb === undefined ? undefined : new PostgresTaskLock(pubnetDb);
  const lockFor = (network: string): TaskLock =>
    network === PUBNET && pubnetLock !== undefined ? pubnetLock : lock;
  /** Marks the network's active RPC provider in `rail402_rpc_active`. */
  const recordActiveRpc = (network: string, pool: RpcPool) => {
    for (const provider of pool.providers) {
      metrics.rpcActive.set(
        { network, provider: provider.alias },
        provider.alias === pool.active.alias ? 1 : 0,
      );
    }
  };
  const prepared = config.networks.map((network) => {
    log.info(
      { network: network.network, settings: networkSettingsDigest(network) },
      "network settings loaded",
    );
    const sponsor = Keypair.fromSecret(network.sponsorSecret);
    const channelKeys = deriveChannelKeypairs(sponsor, network.network, network.channelCount);
    const pool = new RpcPool(network.rpcProviders, {
      onSwitch: (from, to) => {
        metrics.rpcFailovers.inc({ network: network.network, from, to });
        recordActiveRpc(network.network, pool);
        log.warn({ network: network.network, from, to }, "switched the active RPC provider");
      },
    });
    for (const [alias, providerServer] of pool.servers)
      meterRpcServer(providerServer, network.network, metrics, alias);
    metrics.prepareRpcProviders(
      network.network,
      pool.providers.map((provider) => provider.alias),
    );
    recordActiveRpc(network.network, pool);
    const server = pool.server;
    const directory = new AssetDirectory(server, networkPassphrase(network.network));
    const bring = (progress?: BringUpProgress) =>
      bringUp(network, server, directory, sponsor, channelKeys, lockFor(network.network), log, progress);
    const progress: BringUpProgress = {};
    return { network, sponsor, channelKeys, server, pool, directory, bring, progress };
  });
  // Every network checks the chain at once. A check the chain contradicts (the configuration must
  // change) stops startup with `exit`, as with a single network; with `hold` the network starts held.
  // Anything else, an RPC that fails, hangs or answers with something that is not even an Error,
  // holds only that network in both modes, and the poll repeats its checks until they pass.
  const brought = await Promise.allSettled(
    prepared.map(({ network, bring, progress }) =>
      network.onStartupCheckFailure === "hold"
        ? withTimeout(
            bring(progress),
            network.startupTimeoutMs,
            `${network.network}: the startup chain checks`,
          )
        : bring(progress),
    ),
  );
  for (const [index, result] of brought.entries()) {
    const network = prepared[index]?.network;
    if (result.status !== "rejected" || network?.onStartupCheckFailure === "hold") continue;
    const contradiction = contradictionOf(network?.network ?? "", result.reason);
    if (contradiction !== undefined) throw contradiction;
  }

  for (const [
    index,
    { network, sponsor, channelKeys, server, pool, directory, bring, progress },
  ] of prepared.entries()) {
    const result = brought[index];
    const up = result?.status === "fulfilled" ? result.value : undefined;
    const startupHold = result?.status === "rejected" ? holdReasonOf(result.reason) : undefined;
    if (startupHold !== undefined) {
      log.error(
        {
          network: network.network,
          reason: describeFailure(result?.status === "rejected" ? result.reason : undefined),
          holdReason: startupHold,
        },
        "a startup chain check failed; the network is held until it passes",
      );
    }
    // A check that failed after the assets were read keeps what they showed.
    const assetCheck: AssetCheck = up?.assetCheck ??
      progress.assetCheck ?? { ok: false, detail: "not checked yet" };
    const addresses = channelKeys.map((keypair) => keypair.publicKey());
    const assets = network.assets.map((asset) => {
      const kind = assetCheck.ok ? assetCheck.kinds.get(asset.contract) : undefined;
      return kind === undefined ? asset : { ...asset, kind };
    });
    const authority =
      network.upto === undefined
        ? undefined
        : (up?.authority ?? {
            address: deriveAuthorityKeypair(sponsor, network.network).publicKey(),
            present: undefined,
          });
    const provisioned = up?.provisioned ?? false;

    // Pubnet settles through connections of its own, so testnet traffic never holds all of them.
    const store = network.network === PUBNET && pubnetDb !== undefined ? pubnetDb : db;
    const ledger: SettlementLedger =
      store === undefined ? new MemorySettlementLedger() : new PostgresSettlementLedger(store);
    const channels: ChannelPool =
      store === undefined
        ? new MemoryChannelPool(addresses)
        : await PostgresChannelPool.open(store, { network: network.network, addresses });

    const state: NetworkState = {
      config: network,
      pool,
      server,
      sponsor: sponsor.publicKey(),
      channels,
      ledger,
      ttl: new ContractTtlMonitor({
        network: network.network,
        server,
        contracts: network.ttlContracts,
        metrics,
        log,
      }),
      directory,
      assets: assetCheck,
      gate: new NetworkGate(network.network, (snapshot) => {
        metrics.recordServing(network.network, snapshot.state === "serving", snapshot.holdReason);
      }),
      ...(startupHold === undefined ? {} : { startupHold }),
      bringUp: bring,
      ...(network.upto === undefined || authority === undefined
        ? {}
        : {
            upto: {
              contract: network.upto.contract,
              authority: authority.address,
              ...(authority.present === undefined ? {} : { authorityPresent: authority.present }),
              keeper: new UptoTtlKeeper({
                network: network.network,
                server,
                passphrase: networkPassphrase(network.network),
                sponsor,
                contract: network.upto.contract,
                wasmHash: network.upto.wasmHash,
                ttl: network.upto.ttl,
                inclusionFeeStroops: network.inclusionFeeStroops,
                sponsorReserveStroops: network.sponsorReserveStroops,
                lock: lockFor(network.network),
                metrics,
                log,
                spend: {
                  reserve: (fee, limits) =>
                    ledger.reserveSponsorSpend?.(network.network, UPTO_TTL_SPEND, fee, limits) ??
                    Promise.reject(new Error("the settlement ledger cannot record sponsor spend")),
                  settle: (id, fee) => ledger.settleSponsorSpend?.(id, fee) ?? Promise.resolve(),
                },
                ...(network.maxSponsorSpendPerHourStroops === undefined
                  ? {}
                  : { hourlyBudgetStroops: network.maxSponsorSpendPerHourStroops }),
              }),
            },
          }),
      rpcHealthy: true,
      channelsProvisioned: provisioned,
    };
    states.push(state);
    metrics.prepareNetwork(network.network, network.upto === undefined ? ["exact"] : ["exact", "upto"]);
    metrics.channelsTotal.set({ network: network.network }, network.channelCount);
    metrics.sponsorBalanceFloor.set({ network: network.network }, Number(network.minSponsorBalanceStroops));
    metrics.readChannelsInUse(network.network, () => channels.inUse());
    metrics.readRpcLedgerClose(network.network, () => state.latestLedgerClosedAt);
    setups.push({
      network: network.network,
      rpcUrl: network.rpcUrl,
      rpc: pool,
      sponsorSecret: network.sponsorSecret,
      channelCount: network.channelCount,
      assets,
      policy: {
        maxTransactionFeeStroops: network.maxTransactionFeeStroops,
        inclusionFeeStroops: network.inclusionFeeStroops,
        expirationMarginLedgers: network.expirationMarginLedgers,
        timeoutSeconds: network.timeoutSeconds,
      },
      ledger,
      channels,
      timing: {
        channelWaitMs: config.settlement.channelWaitMs,
        confirmTimeoutMs: config.settlement.confirmTimeoutMs,
        reconcileIdleMs: config.settlement.reconcileIdleMs,
        channelQuarantineMs: config.settlement.channelQuarantineMs,
      },
      reconcileThirdParty: config.settlement.reconcileThirdParty,
      ...(network.upto === undefined
        ? {}
        : {
            upto: {
              contract: network.upto.contract,
              contractWasmHash: network.upto.wasmHash,
              zeroSettlement: network.upto.zeroSettlement,
              maxTransactionFeeStroops: network.upto.maxTransactionFeeStroops,
              // Unset, it is read from the network's own RPC, cached: no request sends traffic to a
              // third party.
              ...(network.upto.ledgerSeconds === undefined
                ? {}
                : { ledgerSeconds: network.upto.ledgerSeconds }),
              // Only a poll that finds the authority missing turns it off; RPC failures do not.
              authorityReady: () => state.upto?.authorityPresent !== false,
              ...(network.upto.previousAuthority === undefined
                ? {}
                : {
                    previousAuthority: {
                      keypair: deriveAuthorityKeypair(
                        Keypair.fromSecret(network.upto.previousAuthority.sponsorSecret),
                        network.network,
                      ),
                      validUntil: network.upto.previousAuthority.validUntil,
                    },
                  }),
            },
          }),
      inclusionFee: {
        floor: network.inclusionFeeStroops,
        cap: network.inclusionFeeCapStroops,
        percentile: network.inclusionFeePercentile,
        onReading: (reading: InclusionFeeReading) => {
          metrics.inclusionFeeBid.set({ network: network.network }, reading.bid);
          if (reading.pinned !== undefined) {
            metrics.inclusionFeePinned.inc({ network: network.network, cause: reading.pinned });
          }
        },
      },
      guard: new SettleLimits({
        network: network.network,
        inner: new SponsorBudget({
          network: network.network,
          ledger,
          balance: () => state.sponsorBalance,
          minBalanceStroops: network.sponsorReserveStroops,
          // On pubnet an unread balance never admits: the reserve floor could not be checked.
          refuseWhileUnknown: network.network === PUBNET,
          onRefusal: (reason) => {
            metrics.sponsorGuardRefusals.inc({ network: network.network, reason });
          },
          ...(network.maxSponsorSpendPerHourStroops === undefined
            ? {}
            : { maxSpendPerHourStroops: network.maxSponsorSpendPerHourStroops }),
          ...(network.keylessSponsorBudgetStroopsPerHour === undefined
            ? {}
            : { keylessSpendPerHourStroops: network.keylessSponsorBudgetStroopsPerHour }),
        }),
        take: (key, perMinute) => partyLimiter.takeLimit(key, perMinute),
        ...(network.settleLimits.payerPerMinute === undefined
          ? {}
          : { payerPerMinute: network.settleLimits.payerPerMinute }),
        ...(network.settleLimits.payToPerMinute === undefined
          ? {}
          : { payToPerMinute: network.settleLimits.payToPerMinute }),
        ...(network.settleLimits.payerFailuresPerHour === undefined
          ? {}
          : { failuresPerHour: network.settleLimits.payerFailuresPerHour, ledger }),
        failClosed: network.network === PUBNET,
        onRefusal: (reason) => {
          metrics.sponsorGuardRefusals.inc({ network: network.network, reason });
        },
      }),
    });
  }

  const facilitator = createStellarFacilitator({
    networks: setups,
    log,
    observer: metricsObserver(metrics),
  });
  // Rail402's own RPC calls are metered per provider and method (above); upstream's per-call clients
  // are seen at the transport level only.
  const stopWatching = watchTransport(
    config.networks.flatMap((network): TransportTarget[] => [
      ...[...new Set(network.rpcProviders.map((provider) => new URL(provider.url).origin))].map(
        (origin): TransportTarget => ({ origin, network: network.network, target: "rpc" }),
      ),
      { origin: HORIZON_ORIGINS[network.network], network: network.network, target: "horizon" },
    ]),
    metrics,
  );

  // The last index build's outcome and when the index was last confirmed current, for /health.
  const indexState = {
    lastBuild: undefined as "ok" | "degraded" | "failed" | undefined,
    at: undefined as Date | undefined,
  };
  const metered = metricsSearchObserver(metrics);
  const searchObserver: SearchObserver = {
    ...metered,
    indexBuild(outcome, ms) {
      indexState.lastBuild = outcome;
      metered.indexBuild(outcome, ms);
    },
  };
  // --- discovery settings (DISCOVERY) ---
  // --- end discovery settings ---
  let bazaar:
    | {
        catalog: Catalog;
        store: CatalogStore;
        reads: CatalogStore;
        sandbox: SchemaSandboxes;
        search: SearchService;
      }
    | undefined;
  if (config.bazaar.enabled) {
    const store: CatalogStore = db === undefined ? new MemoryCatalogStore() : new PostgresCatalogStore(db);
    // What the discovery routes and searches read: the same catalog through the discovery pool. Inside a
    // pubnet-scoped discovery request, through the pubnet discovery pool.
    const reads: CatalogStore =
      discoveryDb === undefined
        ? store
        : laneRouted<CatalogStore>(
            new PostgresCatalogStore(discoveryDb),
            new Map(
              pubnetDiscoveryDb === undefined
                ? []
                : [["pubnet", new PostgresCatalogStore(pubnetDiscoveryDb)]],
            ),
          );
    // --- discovery settings (DISCOVERY) ---
    // One schema sandbox per network and lane (settlements, previews), so neither another network's nor
    // the previews' load delays a network's cataloging. Load the validators now, so the first seller
    // after a deploy is not refused for their startup.
    const sandbox = new SchemaSandboxes();
    if (!(await sandbox.warm(config.networks.map((network) => network.network))))
      log.warn({}, "the bazaar schema validator did not start; it is retried per request");
    // --- end discovery settings ---
    // Token facts and receivability come from each served network's own RPC.
    const directories = new Map(
      [...facilitator.networks.values()].map((runtime) => [
        runtime.network as string,
        new AssetDirectory(runtime.server, networkPassphrase(runtime.network)),
      ]),
    );
    const catalog = new Catalog({
      store,
      sandbox,
      assets: {
        describe: (network, contract) =>
          directories.get(network)?.readFacts(contract) ?? Promise.resolve(undefined),
        receivable: (network, contract, payTo) =>
          directories.get(network)?.receivable(contract, payTo) ?? Promise.resolve(undefined),
      },
      homeDomain: (network, account) =>
        directories.get(network)?.homeDomain(account) ?? Promise.resolve(undefined),
      allowLoopback: config.bazaar.allowLoopback,
      // --- discovery settings (DISCOVERY) ---
      ...catalogOptions(config.discovery),
      // --- end discovery settings ---
      observer: metricsCatalogObserver(metrics),
    });
    facilitator.core.registerExtension(BAZAAR);

    let embedder: Embedder | undefined;
    if (config.search.embeddings) {
      const manifest = await loadManifest();
      const files = await ensureModel(manifest, config.search.modelDirectory, {
        download: config.search.modelDownload,
      });
      embedder = await OnnxEmbedder.load(manifest, files);
      // --- discovery settings (DISCOVERY) ---
      // The model's first run is far slower than the rest; run it now, before /ready, so the first
      // search never spends its semantic budget on it and falls back to lexical.
      const warmStarted = performance.now();
      await embedder.embed("weather forecast for a city").catch((error: unknown) => {
        log.warn({ err: error }, "embedding model warm-up failed");
      });
      log.info({ ms: Math.round(performance.now() - warmStarted) }, "embedding model warmed up");
      // --- end discovery settings ---
      log.info({ model: manifest.id, revision: manifest.revision }, "embedding model loaded");
    } else {
      log.warn({}, "SEARCH_EMBEDDINGS=false: search is lexical-only and reports partialResults");
    }
    if (config.search.cursorSecret === undefined) {
      log.warn({}, "SEARCH_CURSOR_SECRET unset: search cursors do not survive restarts or cross replicas");
    }
    const search = new SearchService({
      store: reads,
      ...(searchIndexDb === undefined ? {} : { indexStore: new PostgresCatalogStore(searchIndexDb) }),
      assets: new AssetRegistry(
        config.networks.flatMap((network) =>
          network.assets.map((asset) => ({
            network: network.network,
            contract: asset.contract,
            symbol: asset.symbol,
            decimals: asset.decimals,
            // --- discovery settings (DISCOVERY) ---
            usd: isUsdAsset(config.discovery, network.network, asset.contract),
            // --- end discovery settings ---
          })),
        ),
      ),
      cursorSecret: config.search.cursorSecret ?? randomBytes(32),
      ...searchSettings(config),
      ...(embedder === undefined ? {} : { embedder }),
      observer: searchObserver,
    });
    bazaar = { catalog, store, reads, sandbox, search };
    if (config.bazaar.allowLoopback)
      log.warn({}, "DISCOVERY_ALLOW_LOOPBACK: loopback resources are cataloged");
  }

  const timers: NodeJS.Timeout[] = [];
  // --- discovery settings (DISCOVERY) ---
  // Origin checks run on their own timer, apart from the queue and facts work below. The catalog keeps
  // one lane per network and skips a network whose lane is still busy, so slow origins on one network
  // never hold up another network's checks.
  const checkOrigins = async () => {
    if (bazaar === undefined) return;
    try {
      await bazaar.catalog.checkOrigins();
    } catch (error) {
      metrics.backgroundErrors.inc({ task: "origin_check" });
      log.error({ err: error }, "origin checks failed");
    }
  };
  // --- end discovery settings ---
  let catalogWorking = false;
  const catalogWork = async () => {
    if (bazaar === undefined || catalogWorking) return;
    catalogWorking = true;
    // Settlements whose cataloging an earlier process did not finish, e.g. after a crash.
    try {
      await bazaar.catalog.processQueued();
    } catch (error) {
      metrics.backgroundErrors.inc({ task: "catalog_queue" });
      log.error({ err: error }, "queued cataloging failed");
    }
    // --- discovery settings (DISCOVERY) ---
    // Listings past their network's retention are withdrawn, bounding each network's catalog.
    try {
      await bazaar.catalog.expire();
    } catch (error) {
      metrics.backgroundErrors.inc({ task: "catalog_retention" });
      log.error({ err: error }, "catalog retention failed");
    } finally {
      catalogWorking = false;
    }
  };
  // Token facts, receivability and SEP-1 domain claims of published listings, on their own timer: the
  // catalog keeps one lane per network and skips a busy one, so slow hosts of one network never delay
  // another network's facts or the queue above.
  const enrichFacts = async () => {
    if (bazaar === undefined) return;
    try {
      await bazaar.catalog.enrich();
    } catch (error) {
      metrics.backgroundErrors.inc({ task: "listing_facts" });
      log.error({ err: error }, "listing facts failed");
    }
  };
  // --- end discovery settings ---
  // Build the search index off the request path: at startup, before /ready passes, and whenever the
  // catalog changes, so searches never wait for a cold build.
  let searchIndexed = bazaar === undefined;
  let indexing = false;
  const indexSearch = async () => {
    if (bazaar === undefined || indexing) return;
    indexing = true;
    try {
      await bazaar.search.refresh();
      searchIndexed = true;
      indexState.at = new Date();
    } catch (error) {
      metrics.backgroundErrors.inc({ task: "search_index" });
      log.error({ err: error }, "search indexing failed");
    } finally {
      indexing = false;
    }
  };
  // `/ready` asks whether the database answers, through one connection of its own: a queue for the
  // shared pool (testnet's work and limits) is load, not an outage, and must never take the process, and
  // the pubnet host with it, out of a load balancer; nor may pubnet's load on its pool take testnet out.
  // A probe that gets no answer within `DATABASE_ACQUIRE_TIMEOUT_MS`, connecting included, fails and
  // drops its connection, so a connection that stopped answering never passes for a database that
  // answers. The probe runs at most once per `READINESS_DATABASE_TTL_MS`, and concurrent requests share
  // the one running, so a flood of readiness requests costs one query per TTL. While a probe runs,
  // `/ready` answers from the last one, so a slow database never holds a readiness request for longer.
  const readinessProbe =
    db !== undefined && config.store.kind === "postgres"
      ? new DatabaseProbe({
          connectionString: config.store.url,
          timeoutMs: config.store.acquireTimeoutMs,
          onIdleError: (error) => {
            log.warn(
              { err: error },
              "the idle readiness database connection failed; the next probe opens one",
            );
          },
        })
      : undefined;
  const probeDatabase =
    readinessProbe === undefined
      ? undefined
      : cachedProbe(
          async (): Promise<ReadinessCheck> => {
            try {
              await readinessProbe.check();
              return { ok: true };
            } catch (error) {
              log.warn({ err: error }, "readiness: the database did not answer");
              return { ok: false, detail: publicReason(error) };
            }
          },
          READINESS_DATABASE_TTL_MS,
          Date.now,
          { staleWhileRunning: true },
        );

  // One reconciliation round per network at a time, and each network on its own: a testnet ledger
  // or RPC that fails or hangs never holds up pubnet's round (each RPC call is bounded besides).
  const reconciling = new Map<string, Promise<void>>();

  const reconcileNetwork = async (network: StellarNetwork) => {
    const running = reconciling.get(network);
    if (running !== undefined) return;
    const round = (async () => {
      try {
        // Each attempt is counted by outcome through the settlement observer.
        await facilitator.reconcileNetwork(network);
      } catch (error) {
        metrics.backgroundErrors.inc({ task: "reconcile" });
        log.error({ err: error, network }, "reconciliation failed");
      }
    })();
    reconciling.set(network, round);
    try {
      await round;
    } finally {
      reconciling.delete(network);
    }
  };

  const reconcile = async () => {
    await Promise.all([...facilitator.networks.keys()].map((network) => reconcileNetwork(network)));
  };

  /** Reads the assets again after startup could not verify them; logs when the answer changes. */
  const recheckAssets = async (state: NetworkState) => {
    const before = state.assets.detail;
    state.assets = await checkAssets(state.config, state.directory);
    const network = state.config.network;
    if (state.assets.ok) {
      log.info({ network, detail: state.assets.detail }, "accepted assets verified");
    } else if (state.assets.detail !== before) {
      const fields = { network, detail: state.assets.detail, code: state.assets.error?.code };
      if (state.assets.error === undefined) log.warn(fields, "accepted assets are not verified yet");
      else log.error(fields, "an accepted asset contradicts the configuration; fix it and restart");
    }
  };

  /** Repeats a held network's startup chain checks; on success their results replace the startup ones. */
  const retryStartup = async (state: NetworkState) => {
    if (state.startupHold === undefined || STICKY_HOLDS.has(state.startupHold)) return;
    const progress: BringUpProgress = {};
    try {
      const up = await state.bringUp(progress);
      state.assets = up.assetCheck;
      state.channelsProvisioned = up.provisioned;
      if (state.upto !== undefined && up.authority !== undefined)
        state.upto.authorityPresent = up.authority.present;
      delete state.startupHold;
      log.info({ network: state.config.network }, "the startup chain checks passed");
    } catch (error) {
      if (progress.assetCheck !== undefined) state.assets = progress.assetCheck;
      state.startupHold = holdReasonOf(error);
      log.warn(
        { network: state.config.network, reason: describeFailure(error), holdReason: state.startupHold },
        "the startup chain checks still fail",
      );
    }
  };

  /**
   * Records where the restore hold counts from, from this poll's reading of one provider, and starts it
   * again from a reset test network's new chain once corroborated (`recordRestoreHold`).
   */
  const observeRestoreHold = async (state: NetworkState, latestLedger: number) => {
    const network = state.config.network;
    const result = await recordRestoreHold({
      ledger: state.ledger,
      network,
      passphrase: networkPassphrase(network),
      timeoutMaxSeconds: state.config.timeoutSeconds.max,
      latestLedger,
      closedAt: state.latestLedgerClosedAt,
      networkPassphrase: async () => (await state.server.getNetwork()).passphrase,
      seen: state.restartSeen,
    });
    if (result.seen === undefined) delete state.restartSeen;
    else state.restartSeen = result.seen;
    metrics.uptoRestoreHoldPending.set({ network }, result.pending === true ? 1 : 0);
    state.restoreHoldPendingPolls = result.pending === true ? (state.restoreHoldPendingPolls ?? 0) + 1 : 0;
    if (state.restoreHoldPendingPolls > 0 && state.restoreHoldPendingPolls % PENDING_WARN_POLLS === 0) {
      log.warn(
        { network, polls: state.restoreHoldPendingPolls },
        "upto is held after a restore and no ledger to count the hold from could be recorded yet: check the RPC provider (its passphrase and the age of its newest ledger)",
      );
    }
    if (result.recorded !== undefined) {
      log.info({ network, ledger: result.recorded }, "the restore hold counts from this ledger");
    }
    if (result.restarted !== undefined) {
      log.warn(
        { network, ledger: result.restarted },
        "the network started over: the restore hold counts from its new ledgers",
      );
    }
  };

  // One poll per network at a time, so a slow poll is not overlapped by the next one; one that outlasts
  // POLL_DEADLINE_MS (a database call that never answers) stops blocking the network's next poll.
  const poll = singleFlight((state: NetworkState) => pollOnce(state), {
    deadlineMs: POLL_DEADLINE_MS,
    onOverrun: (state) => {
      metrics.backgroundErrors.inc({ task: "poll" });
      log.warn(
        { network: state.config.network, deadlineMs: POLL_DEADLINE_MS },
        "a network poll outlasted its deadline; the next one starts anyway",
      );
    },
  });

  const pollOnce = async (state: NetworkState) => {
    const network = state.config.network;
    await retryStartup(state);
    // Every provider of a network with several is read each poll; the pool switches between polls.
    if (state.pool.providers.length > 1) {
      const readings = await Promise.all(
        [...state.pool.servers].map(async ([alias, providerServer]) => {
          const ok = await providerServer.getHealth().then(
            () => true,
            () => false,
          );
          return [alias, ok] as const;
        }),
      );
      state.pool.observe(new Map(readings));
    }
    try {
      await state.server.getHealth();
      state.rpcHealthy = true;
      const probe = await state.server.getTransaction(ABSENT_TRANSACTION);
      state.latestLedger = probe.latestLedger;
      state.latestLedgerClosedAt = new Date(ledgerCloseSeconds(probe.latestLedgerCloseTime) * 1_000);
      metrics.rpcLatestLedger.set({ network }, probe.latestLedger);
      const balance = await nativeBalance(state.server, state.sponsor);
      state.sponsorExists = balance !== null;
      if (balance === null) {
        delete state.sponsorBalance;
        throw new Error(`sponsor account ${state.sponsor} does not exist`);
      }
      state.sponsorBalance = balance;
      metrics.sponsorBalance.set({ network }, Number(state.sponsorBalance));
      if (!state.channelsProvisioned) {
        const existing = await existingAccounts(state.server, state.channels.addresses);
        state.channelsProvisioned = existing.size === state.channels.addresses.length;
      }
      if (!state.assets.ok) await recheckAssets(state);
      if (state.upto !== undefined) {
        const upto = state.upto;
        if (upto.authorityPresent === false) {
          // Startup could not create it; try again, one replica at a time.
          await lockFor(network).run(sponsorLockName(network, state.sponsor), () =>
            ensureAuthority(state.config, state.server, Keypair.fromSecret(state.config.sponsorSecret), log),
          );
        }
        const authority = await authorityStatus(state.server, upto.authority);
        upto.authorityPresent = authority.exists;
        upto.authorityBalance = authority.balanceStroops;
        upto.authoritySpendable = authority.spendableStroops;
        upto.authorityTokens = authority.exists
          ? await tokensHeld(state.directory, state.config, upto.authority)
          : [];
        if (authority.exists) metrics.uptoAuthorityBalance.set({ network }, Number(authority.balanceStroops));
        else metrics.uptoAuthorityBalance.remove({ network });
      }
      delete state.lastError;
    } catch (error) {
      state.rpcHealthy = false;
      state.lastError = describeFailure(error);
      metrics.backgroundErrors.inc({ task: "poll" });
      log.warn({ err: error, network }, "network poll failed");
    }
    // After a restore, the first ledger a replica reads, from a provider of this network whose newest
    // ledger is current, is where the upto hold counts from (StellarUptoScheme); requests hold until then.
    // A network reset starts it again from the new chain, but only here and only when corroborated.
    if (state.upto !== undefined && state.rpcHealthy && state.latestLedger !== undefined) {
      try {
        await observeRestoreHold(state, state.latestLedger);
      } catch (error) {
        metrics.backgroundErrors.inc({ task: "restore_hold" });
        log.warn({ err: error, network }, "could not record the ledger the restore hold counts from");
      }
    }
    try {
      const hourAgo = new Date(Date.now() - 3_600_000);
      const [unfinished, last1h, committed] = await Promise.all([
        state.ledger.unfinished(network),
        state.ledger.countByState(network, hourAgo),
        state.ledger.committedFeesSince(network, hourAgo),
      ]);
      metrics.settlementsUnfinished.set({ network }, unfinished.length);
      metrics.sponsorFeesCommitted.set({ network }, Number(committed));
      const cap = state.config.maxSponsorSpendPerHourStroops;
      if (cap !== undefined) metrics.sponsorBudgetUsed.set({ network }, Number(committed) / Number(cap));
      for (const record of accessKeys.forNetwork(network)) {
        if (record.sponsorBudgetStroopsPerHour === undefined) continue;
        const spent = await state.ledger.committedFeesSince(network, hourAgo, `key:${record.id}`);
        metrics.accessSponsorCommitted.set({ network, key_id: record.id }, Number(spent));
      }
      state.settlements = { last1h, unfinished: unfinished.length };
      state.committed1hStroops = committed;
    } catch (error) {
      delete state.settlements;
      metrics.backgroundErrors.inc({ task: "settlement_ledger" });
      log.warn({ err: error, network }, "could not count settlements");
    }
    evaluateGate(state);
  };

  const health = new HealthMonitor(metrics, {
    version: options.version ?? "dev",
    budgetWarnPercent: config.observability.budgetWarnPercent,
    ttlWarnLedgers: config.observability.contractTtl.warnLedgers,
    ttlCriticalLedgers: config.observability.contractTtl.criticalLedgers,
  });

  /** Rebuilds the /health snapshot and the catalog and search gauges from the last poll. */
  const refreshHealth = async () => {
    let catalogStats: CatalogStats | undefined;
    if (bazaar !== undefined) {
      try {
        catalogStats = await bazaar.reads.stats();
        for (const [state, count] of Object.entries(catalogStats.listings)) {
          metrics.catalogListings.set({ state }, count);
        }
        metrics.catalogOutboxPending.set(catalogStats.queuedSettlements);
      } catch (error) {
        metrics.backgroundErrors.inc({ task: "catalog_stats" });
        log.warn({ err: error }, "could not count catalog listings");
      }
      if (indexState.at !== undefined) {
        metrics.searchIndexAge.set((Date.now() - indexState.at.getTime()) / 1_000);
      }
    }
    try {
      const keyStatus = accessKeys.status();
      await health.refresh({
        access: { ...keyStatus, reloadError: keyStatus.reloadError?.split(":")[0] ?? null },
        networks: await Promise.all(
          states.map(async (state) => ({
            network: state.config.network,
            serving: state.gate.snapshot(),
            rpc: {
              ok: state.rpcHealthy,
              active: state.pool.active.alias,
              providers: state.pool.providers.map((provider) => provider.alias),
              ...(state.lastError === undefined ? {} : { error: state.lastError }),
              ...(state.latestLedger === undefined ? {} : { latestLedger: state.latestLedger }),
              ...(state.latestLedgerClosedAt === undefined
                ? {}
                : { latestLedgerClosedAt: state.latestLedgerClosedAt }),
            },
            sponsor: {
              address: state.sponsor,
              floorStroops: state.config.minSponsorBalanceStroops,
              ...(state.sponsorBalance === undefined ? {} : { balanceStroops: state.sponsorBalance }),
              ...(state.committed1hStroops === undefined
                ? {}
                : { committed1hStroops: state.committed1hStroops }),
              ...(state.config.maxSponsorSpendPerHourStroops === undefined
                ? {}
                : { budgetStroops: state.config.maxSponsorSpendPerHourStroops }),
            },
            channels: {
              total: state.channels.addresses.length,
              ...(await state.channels.inUse().then(
                (inUse) => ({ inUse }),
                () => ({}),
              )),
            },
            ...(state.settlements === undefined ? {} : { settlements: state.settlements }),
            contracts: state.ttl.snapshot(),
            ...(state.upto === undefined
              ? {}
              : {
                  upto: {
                    contract: state.upto.contract,
                    authority: {
                      address: state.upto.authority,
                      ...(state.upto.authorityPresent === undefined
                        ? {}
                        : { present: state.upto.authorityPresent }),
                      ...(state.upto.authorityBalance === undefined
                        ? {}
                        : { balanceStroops: state.upto.authorityBalance }),
                      ...(state.upto.authoritySpendable === undefined
                        ? {}
                        : { spendableStroops: state.upto.authoritySpendable }),
                      ...(state.upto.authorityTokens === undefined
                        ? {}
                        : { tokens: state.upto.authorityTokens }),
                    },
                    keeper: state.upto.keeper.snapshot(),
                  },
                }),
          })),
        ),
        ...(bazaar === undefined
          ? {}
          : {
              catalog: catalogStats === undefined ? {} : { stats: catalogStats },
              search: {
                ...(bazaar.search.indexRevision === undefined
                  ? {}
                  : { indexRevision: bazaar.search.indexRevision }),
                ...(indexState.at === undefined ? {} : { indexedAt: indexState.at }),
                ...(indexState.lastBuild === undefined ? {} : { lastBuild: indexState.lastBuild }),
                // --- discovery settings (DISCOVERY) ---
                ranker: bazaar.search.rankerIdentity(),
                // --- end discovery settings ---
              },
            }),
      });
    } catch (error) {
      metrics.backgroundErrors.inc({ task: "health" });
      log.warn({ err: error }, "could not build the health snapshot");
    }
  };

  const pollAll = async () => {
    recordAccessKeys();
    void Promise.resolve(partyLimiter.sweep()).catch(() => undefined);
    await Promise.all(states.map(poll));
    await refreshHealth();
  };

  // The keeper acts on the upto contract after each TTL reading; what it changed is read again.
  const checkTtl = async () => {
    await Promise.all(
      states.map(async (state) => {
        await state.ttl.check();
        if (state.upto !== undefined && (await state.upto.keeper.tick())) await state.ttl.check();
      }),
    );
  };

  /**
   * One network's readiness checks: serving, RPC, sponsor at or above `MIN_SPONSOR_BALANCE_XLM`,
   * assets and channels. Pubnet details never carry the sponsor balance; testnet's do.
   */
  const networkChecks = (state: NetworkState): Record<string, ReadinessCheck> => {
    const gate = state.gate.snapshot();
    const pubnet = state.config.network === PUBNET;
    const balance = state.sponsorBalance;
    const funded = balance !== undefined && balance >= state.config.minSponsorBalanceStroops;
    return {
      serving:
        gate.state === "serving"
          ? { ok: true }
          : { ok: false, detail: gate.holdReason === null ? gate.state : `held: ${gate.holdReason}` },
      rpc: state.rpcHealthy
        ? { ok: true }
        : { ok: false, detail: state.lastError === undefined ? "unhealthy" : publicReason(state.lastError) },
      sponsor: funded
        ? { ok: true, detail: pubnet ? "funded" : `${String(balance)} stroops` }
        : {
            ok: false,
            detail: pubnet
              ? balance === undefined
                ? "balance unknown"
                : "below minimum"
              : `balance ${String(balance ?? "unknown")} below minimum`,
          },
      assets: state.assets.ok
        ? { ok: true, detail: state.assets.detail }
        : { ok: false, detail: state.assets.detail },
      channels: state.channelsProvisioned
        ? { ok: true, detail: `${String(state.channels.addresses.length)} channels` }
        : { ok: false, detail: "channel accounts are not all provisioned" },
    };
  };

  // Networks without a startup failure serve at once, except pubnet, which waits for its first poll.
  for (const state of states) {
    if (state.startupHold !== undefined) state.gate.hold(state.startupHold);
    else if (state.config.network !== PUBNET) state.gate.serve();
  }

  const access =
    stores === undefined
      ? undefined
      : {
          rateLimiter: stores.rateLimiter,
          ...(stores.pubnetRateLimiter === undefined ? {} : { pubnetRateLimiter: stores.pubnetRateLimiter }),
          networkLimiter: stores.networkLimiter,
          ...(stores.discoveryLimiter === undefined ? {} : { discoveryLimiter: stores.discoveryLimiter }),
          meter: stores.meter,
        };

  const accessKeys = new AccessKeys(config.auth.keys, {
    ...(config.auth.keysFile === undefined
      ? {}
      : { path: config.auth.keysFile, source: config.auth.keysSource }),
    rules: config.auth.rules,
    legacy: legacyKeys(
      config.auth.apiKeyHashes,
      config.networks.map((network) => network.network),
    ),
    onReload: (outcome) => {
      if (outcome.ok) {
        log.info({ status: accessKeys.status().keys }, "access keys reloaded");
      } else {
        metrics.accessKeysReloadFailures.inc();
        log.error(
          { code: outcome.error.code, err: outcome.error },
          "the access-key file is invalid; the previous keys stay in force",
        );
      }
      recordAccessKeys();
    },
  });
  const recordAccessKeys = () => {
    const now = Date.now();
    for (const network of config.networks) {
      const counts = { active: 0, expired: 0, revoked: 0 };
      for (const record of accessKeys.forNetwork(network.network)) {
        if (record.revoked) counts.revoked++;
        else if (record.expiresAt !== undefined && record.expiresAt.getTime() <= now) counts.expired++;
        else counts.active++;
      }
      for (const [state, count] of Object.entries(counts)) {
        metrics.accessKeys.set({ network: network.network, state }, count);
      }
    }
  };
  recordAccessKeys();

  return {
    facilitator,
    accessKeys,
    ...(access === undefined ? {} : { access }),
    ...(bazaar === undefined
      ? {}
      : { bazaar: { catalog: bazaar.catalog, store: bazaar.reads, search: bazaar.search } }),

    health() {
      return health.snapshot();
    },

    uptoKeepers: new Map(
      states.flatMap((state) =>
        state.upto === undefined ? [] : [[state.config.network, state.upto.keeper]],
      ),
    ),

    async readiness() {
      const checks: Record<string, ReadinessCheck> = {};
      if (probeDatabase !== undefined) checks["database"] = await probeDatabase();
      // Only the networks that gate readiness count: one process serving several networks never lets
      // one of them take the others out of a load balancer.
      for (const state of states) {
        if (!state.config.gatesReady) continue;
        for (const [name, check] of Object.entries(networkChecks(state))) {
          checks[`${state.config.network}:${name}`] = check;
        }
      }
      if (bazaar !== undefined) {
        checks["search"] = searchIndexed ? { ok: true } : { ok: false, detail: "building the search index" };
      }
      return { ready: Object.values(checks).every((check) => check.ok), checks };
    },

    networkReadiness(network) {
      const state = states.find((candidate) => candidate.config.network === network);
      if (state === undefined) return undefined;
      const checks = networkChecks(state);
      const gate = state.gate.snapshot();
      return {
        ready: Object.values(checks).every((check) => check.ok),
        checks,
        network,
        state: gate.state,
        holdReason: gate.holdReason,
      };
    },

    async settlementUsage(subject, since) {
      // With Postgres every network's ledger reads the same table: ask one of them.
      const ledgers =
        db === undefined
          ? states.map((state) => state.ledger)
          : states.slice(0, 1).map((state) => state.ledger);
      const rows = await Promise.all(
        ledgers.map((ledger) => ledger.usageSince?.(subject, since) ?? Promise.resolve([])),
      );
      return rows.flat();
    },

    async callerCommitted(network, subject) {
      const state = states.find((candidate) => candidate.config.network === network);
      return state === undefined
        ? 0n
        : state.ledger.committedFeesSince(network, new Date(Date.now() - 3_600_000), subject);
    },

    refusal(network) {
      return states.find((state) => state.config.network === network)?.gate.refusal();
    },

    start() {
      accessKeys.start();
      void reconcile();
      // The first /health snapshot waits for the first TTL reading, so it never shows contracts unchecked.
      void Promise.all([Promise.all(states.map(poll)), checkTtl()]).then(refreshHealth);
      timers.push(setInterval(() => void reconcile(), config.reconcileIntervalMs));
      timers.push(setInterval(() => void pollAll(), POLL_INTERVAL_MS));
      void metrics.refreshChannelsInUse();
      timers.push(setInterval(() => void metrics.refreshChannelsInUse(), CHANNELS_IN_USE_INTERVAL_MS));
      timers.push(setInterval(() => void checkTtl(), config.observability.contractTtl.pollMs));
      void indexSearch();
      if (bazaar !== undefined) {
        timers.push(setInterval(() => void checkOrigins(), config.bazaar.originCheckIntervalMs));
        timers.push(setInterval(() => void catalogWork(), config.bazaar.originCheckIntervalMs));
        // --- discovery settings (DISCOVERY) ---
        timers.push(setInterval(() => void enrichFacts(), config.bazaar.originCheckIntervalMs));
        // --- end discovery settings ---
        timers.push(setInterval(() => void indexSearch(), 5_000));
      }
      for (const timer of timers) timer.unref();
    },

    async stop() {
      accessKeys.stop();
      for (const timer of timers) clearInterval(timer);
      stopWatching();
      await Promise.all(reconciling.values());
      await reconcile();
      await bazaar?.sandbox.close();
      await searchIndexDb?.destroy();
      await discoveryDb?.destroy();
      await pubnetDiscoveryDb?.destroy();
      await pubnetDb?.destroy();
      await readinessProbe?.close();
      await db?.destroy();
    },
  };
}

/** How long startup waits for another replica that is provisioning accounts on the same network. */
const PROVISION_WAIT_MS = 120_000;

/**
 * Runs `task`, which creates accounts from the sponsor, while holding the network's provisioning lock,
 * and waits while another replica holds it. Replicas starting together would otherwise submit from the
 * sponsor at once, and all but one transaction would fail on the sponsor's sequence number or on an
 * account another replica just created. Each task reads what exists first, so a replica that waited
 * finds nothing left to do.
 */
export async function provisionExclusively<T>(
  lock: TaskLock,
  network: string,
  sponsor: Keypair,
  task: () => Promise<T>,
  waitMs: number = PROVISION_WAIT_MS,
): Promise<T> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const done = await lock.run(sponsorLockName(network, sponsor.publicKey()), async () => ({
      value: await task(),
    }));
    if (done !== undefined) return done.value;
    if (Date.now() >= deadline)
      throw new StartupHoldError(
        `${network}: another replica is still provisioning accounts`,
        "provisioning_busy",
      );
    await sleep(1_000);
  }
}

async function ensureChannels(
  network: NetworkConfig,
  server: rpc.Server,
  sponsor: Keypair,
  channels: Keypair[],
  log: Logger,
): Promise<boolean> {
  const addresses = channels.map((keypair) => keypair.publicKey());
  const existing = await existingAccounts(server, addresses);
  const missing = channels.length - existing.size;
  if (missing === 0) return true;
  if (!network.autoProvisionChannels) {
    log.warn({ network: network.network, missing }, "channel accounts missing; run `channels provision`");
    return false;
  }
  // The sponsor creates the accounts; without it there is nothing to provision from.
  if ((await nativeBalance(server, sponsor.publicKey())) === null) {
    throw new StartupHoldError(
      `${network.network}: the sponsor account ${sponsor.publicKey()} does not exist, so the channel accounts cannot be created`,
      "sponsor_missing",
    );
  }
  try {
    const result = await provisionChannels({
      server,
      passphrase: networkPassphrase(network.network),
      sponsor,
      channels,
    });
    log.info({ network: network.network, created: result.created.length }, "channel accounts provisioned");
  } catch (error) {
    // Another process sharing the sponsor (without this database's lock) may have created them.
    if ((await existingAccounts(server, addresses)).size < channels.length) {
      if (error instanceof ProvisionRefusedError)
        throw new StartupHoldError(`${network.network}: ${error.message}`, "channels_missing", {
          cause: error,
        });
      throw error;
    }
    log.info({ network: network.network }, "channel accounts were created by another process");
  }
  return true;
}

/**
 * Creates the `upto` settlement authority when it is missing: a zero-balance account whose reserve
 * the sponsor sponsors, like a channel. Never throws: an authority that cannot be created now (an
 * unfunded sponsor, an RPC outage) is logged, reported by `/health`, retried by every poll, and
 * refuses `upto` payments with a coded answer meanwhile, while `exact` keeps working. Returns whether
 * the authority exists.
 */
async function ensureAuthority(
  network: NetworkConfig,
  server: rpc.Server,
  sponsor: Keypair,
  log: Logger,
): Promise<boolean> {
  const authority = deriveAuthorityKeypair(sponsor, network.network);
  const fields = { network: network.network, authority: authority.publicKey() };
  try {
    if ((await authorityStatus(server, authority.publicKey())).exists) return true;
    await provisionAuthority({
      server,
      passphrase: networkPassphrase(network.network),
      sponsor,
      authority,
    });
    log.info(fields, "upto settlement authority provisioned");
    return true;
  } catch (error) {
    try {
      // Another process sharing the sponsor may have created it first.
      if ((await authorityStatus(server, authority.publicKey())).exists) return true;
    } catch {
      // Reported below with the original error.
    }
    log.error(
      { ...fields, err: error },
      "could not create the upto settlement authority; upto payments are refused until it exists",
    );
    return false;
  }
}

/**
 * Readies `upto` on a network before it is served: creates the settlement authority if it is missing
 * (see `ensureAuthority`) and checks that a live settlement contract runs exactly the configured WASM,
 * which is the one condition that stops startup. A contract that is not on the network at all is
 * logged and reported by `/health`; `upto` payments fail until it is deployed, while `exact` keeps
 * working. Returns the authority's address and whether it exists.
 */
async function ensureUpto(
  network: NetworkConfig,
  server: rpc.Server,
  sponsor: Keypair,
  lock: TaskLock,
  log: Logger,
): Promise<{ readonly address: string; readonly present: boolean }> {
  const upto = network.upto;
  if (upto === undefined) throw new Error(`${network.network} does not serve upto`);
  const reading = await readContractTtl(server, [upto.contract]);
  const live = reading.contracts.get(upto.contract);
  if (live === undefined && network.network === PUBNET) {
    // On mainnet a missing contract is a configuration to fix, not a deployment to wait for.
    throw new UptoContractMismatchError(
      `${network.network}: the upto contract ${upto.contract} is not on the network`,
    );
  }
  if (live === undefined) {
    log.error(
      { network: network.network, contract: upto.contract },
      "the upto settlement contract is not on the network; upto payments fail until it is deployed",
    );
  } else if (live.wasmHash !== upto.wasmHash) {
    throw new UptoContractMismatchError(
      `${network.network}: the upto contract ${upto.contract} runs WASM ${live.wasmHash ?? "(built in)"}, ` +
        `not the configured ${upto.wasmHash}`,
    );
  }

  const address = deriveAuthorityKeypair(sponsor, network.network).publicKey();
  let present: boolean;
  try {
    present = await provisionExclusively(lock, network.network, sponsor, () =>
      ensureAuthority(network, server, sponsor, log),
    );
  } catch (error) {
    log.error({ network: network.network, err: error }, "the upto settlement authority was not checked");
    present = false;
  }
  return { address, present };
}

/**
 * The accepted tokens `holder` has a positive balance of. A Stellar Asset Contract balance is one
 * trustline read; any other SEP-41 token is asked for `balance(holder)` by simulation.
 */
async function tokensHeld(
  directory: AssetDirectory,
  network: NetworkConfig,
  holder: string,
): Promise<{ symbol: string; contract: string; balance: bigint }[]> {
  const held = await Promise.all(
    network.assets.map(async (asset) => {
      const funds = await directory.funds(asset.contract, holder);
      const balance = funds === undefined ? await directory.balance(asset.contract, holder) : funds.balance;
      return { symbol: asset.symbol, contract: asset.contract, balance: balance ?? 0n };
    }),
  );
  return held.filter((token) => token.balance > 0n);
}

/** The native balance of `address` in stroops, or null when the account does not exist. */
async function nativeBalance(server: rpc.Server, address: string): Promise<bigint | null> {
  const key = xdr.LedgerKey.account(
    new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(address).xdrAccountId() }),
  );
  const { entries } = await server.getLedgerEntries(key);
  const entry = entries[0];
  return entry === undefined ? null : entry.val.account().balance().toBigInt();
}

/** What one network's startup chain checks found before they finished or failed. */
interface BringUpProgress {
  assetCheck?: AssetCheck;
}

/** What one network's startup chain checks found. */
interface BringUp {
  readonly assetCheck: AssetCheck;
  readonly provisioned: boolean;
  readonly authority?: { readonly address: string; readonly present: boolean };
}

/**
 * One network's chain checks before it serves: the accepted assets agree with the chain (before
 * anything spends the sponsor's XLM), the channel accounts exist (created where allowed), and `upto`
 * is ready. Throws on a contradiction (a coded `ConfigError`, or `UptoContractMismatchError`) and on
 * anything that could not be read or created.
 */
async function bringUp(
  network: NetworkConfig,
  server: rpc.Server,
  directory: AssetDirectory,
  sponsor: Keypair,
  channelKeys: Keypair[],
  lock: TaskLock,
  log: Logger,
  progress: BringUpProgress = {},
): Promise<BringUp> {
  if (network.checkSponsorSigners) {
    if (network.sponsorColdSigner === undefined) {
      throw new SignerSetError("no cold signer is configured for the sponsor signer check");
    }
    // A sponsor that does not exist yet has no signers to judge: held until it is created.
    if ((await nativeBalance(server, sponsor.publicKey())) === null) {
      throw new StartupHoldError(
        `${network.network}: the sponsor account ${sponsor.publicKey()} does not exist`,
        "sponsor_missing",
      );
    }
    assertSignerSet(await readSignerSet(server, sponsor.publicKey()), sponsor.publicKey(), {
      coldSigner: network.sponsorColdSigner,
      // Everything the service derives from the seed, up to the most channels it may be configured
      // with (CHANNEL_COUNT): a leaked seed holds these too.
      derived: new Set([
        ...deriveChannelKeypairs(sponsor, network.network, MAX_CHANNEL_COUNT).map((keypair) =>
          keypair.publicKey(),
        ),
        deriveAuthorityKeypair(sponsor, network.network).publicKey(),
      ]),
    });
  }
  const assetCheck = await checkAssets(network, directory);
  progress.assetCheck = assetCheck;
  if (!assetCheck.ok) {
    if (assetCheck.error !== undefined) throw assetCheck.error;
    log.warn({ network: network.network, detail: assetCheck.detail }, "accepted assets are not verified yet");
  }
  const provisioned = await provisionExclusively(lock, network.network, sponsor, () =>
    ensureChannels(network, server, sponsor, channelKeys, log),
  );
  const authority =
    network.upto === undefined ? undefined : await ensureUpto(network, server, sponsor, lock, log);
  return { assetCheck, provisioned, ...(authority === undefined ? {} : { authority }) };
}

/** A live `upto` contract runs other code than the configured WASM hash, or (pubnet) is absent. */
export class UptoContractMismatchError extends Error {
  override readonly name = "UptoContractMismatchError";
}

class StartupTimeoutError extends Error {
  override readonly name = "StartupTimeoutError";
}

/**
 * A startup chain check that failed for a known reason other than the RPC: the network is held for
 * `holdReason`, and the poll repeats the checks.
 */
export class StartupHoldError extends Error {
  override readonly name = "StartupHoldError";
  readonly holdReason: HoldReason;

  constructor(message: string, holdReason: HoldReason, options?: ErrorOptions) {
    super(message, options);
    this.holdReason = holdReason;
  }
}

/** `promise`, or a `StartupTimeoutError` after `ms`. A late failure of `promise` is ignored. */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  promise.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const elapsed = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new StartupTimeoutError(`${what} did not finish within ${String(ms)} ms`));
    }, ms);
    timer.unref();
  });
  return Promise.race([promise, elapsed]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * The configuration error a failed startup check stops the process with under `exit`: the chain
 * contradicts the configuration, so retrying cannot help. `undefined` for anything else (an RPC that
 * failed, timed out or threw something that is not an Error), which holds the network instead.
 */
function contradictionOf(network: string, error: unknown): ConfigError | undefined {
  if (error instanceof ConfigError) return error;
  if (error instanceof SignerSetError)
    return new ConfigError(`${network}: ${error.message}`, "sponsor_signers_unsafe");
  if (error instanceof UptoContractMismatchError)
    return new ConfigError(error.message, "upto_contract_mismatch");
  return undefined;
}

/**
 * Why a network is held after its startup chain checks failed with `error`. Every failure the checks
 * name (`StartupHoldError`, a contradiction) carries its own reason; what is left is a read or a
 * submission the RPC failed, did not answer in time, or answered with something that is not an Error.
 */
export function holdReasonOf(error: unknown): HoldReason {
  if (error instanceof StartupHoldError) return error.holdReason;
  if (error instanceof SignerSetError) return "sponsor_signers_unsafe";
  if (error instanceof UptoContractMismatchError) return "upto_contract_mismatch";
  if (error instanceof ConfigError) return "asset_contradicts_config";
  return "rpc_unreachable";
}

/**
 * Why pubnet must not serve now, from the last poll: every money-relevant fact must be known and
 * good before the sponsor pays for a mainnet settlement.
 */
function pubnetHold(state: NetworkState): HoldReason | undefined {
  if (!state.assets.ok && state.assets.error !== undefined) return "asset_contradicts_config";
  if (state.sponsorExists === false) return "sponsor_missing";
  if (!state.rpcHealthy) return "rpc_unreachable";
  if (state.sponsorBalance === undefined) return "sponsor_balance_unknown";
  if (state.sponsorBalance < state.config.sponsorReserveStroops) return "sponsor_below_reserve";
  if (!state.assets.ok) return "asset_unverified";
  if (!state.channelsProvisioned) return "channels_missing";
  return undefined;
}

/**
 * Decides whether a network serves: never while its startup checks fail; pubnet only while every
 * money-relevant fact of the last poll is good (`pubnetHold`). Other networks serve once started.
 */
function evaluateGate(state: NetworkState): void {
  if (state.startupHold !== undefined) {
    state.gate.hold(state.startupHold);
    return;
  }
  if (state.config.network === PUBNET) {
    const reason = pubnetHold(state);
    if (reason !== undefined) {
      state.gate.hold(reason);
      return;
    }
  }
  state.gate.serve();
}
