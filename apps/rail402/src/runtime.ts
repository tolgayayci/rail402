import { Keypair, rpc, xdr } from "@stellar/stellar-sdk";
import { sql, type Kysely } from "kysely";
import {
  MemoryChannelPool,
  MemorySettlementLedger,
  MemoryTaskLock,
  SponsorBudget,
  authorityStatus,
  createStellarFacilitator,
  deriveAuthorityKeypair,
  deriveChannelKeypairs,
  existingAccounts,
  ledgerCloseSeconds,
  provisionAuthority,
  provisionChannels,
  type ChannelPool,
  type Logger,
  type SettlementLedger,
  type SettlementState,
  type StellarFacilitator,
  type TaskLock,
} from "@rail402.dev/facilitator";
import { AssetDirectory, networkPassphrase, readContractTtl } from "@rail402.dev/stellar";
import {
  Catalog,
  MemoryCatalogStore,
  SchemaSandbox,
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
  PostgresCatalogStore,
  PostgresChannelPool,
  PostgresRateLimiter,
  PostgresUsageMeter,
  PostgresSettlementLedger,
  PostgresTaskLock,
  createDatabase,
  migrate,
  type Database,
} from "@rail402.dev/store-postgres";
import type { Readiness } from "./app.ts";
import { checkAssets, type AssetCheck } from "./asset-check.ts";
import type { Config, NetworkConfig } from "./config.ts";
import { HealthMonitor, type HealthSnapshot } from "./health.ts";
import { metricsCatalogObserver, metricsObserver, metricsSearchObserver, type Metrics } from "./metrics.ts";
import { HORIZON_ORIGINS, meterRpcServer, watchTransport, type TransportTarget } from "./rpc-metrics.ts";
import { ContractTtlMonitor } from "./ttl-monitor.ts";
import { UptoTtlKeeper, sponsorLockName } from "./upto-keeper.ts";
import { publicReason } from "./public-reason.ts";

interface NetworkState {
  readonly config: NetworkConfig;
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
  committed1hStroops?: bigint;
  settlements?: { last1h: Record<SettlementState, number>; unfinished: number };
}

export interface Runtime {
  readonly facilitator: StellarFacilitator;
  /** Shared rate limiter and usage meter, when Postgres is the store. */
  readonly access?: { readonly rateLimiter: PostgresRateLimiter; readonly meter: PostgresUsageMeter };
  /** The Bazaar catalog, when enabled. */
  readonly bazaar?: {
    readonly catalog: Catalog;
    readonly store: CatalogStore;
    readonly search: SearchService;
  };
  readiness(): Promise<Readiness>;
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

/**
 * A transaction hash no transaction has. Asking the RPC for it is the cheapest call that reports the
 * latest ledger's close time (getLatestLedger returns the whole ledger's metadata).
 */
const ABSENT_TRANSACTION = "0".repeat(64);

/** Builds the facilitator and its stores from configuration. Fails fast on anything unusable. */
export async function createRuntime(
  config: Config,
  metrics: Metrics,
  log: Logger,
  options: { readonly version?: string } = {},
): Promise<Runtime> {
  let db: Kysely<Database> | undefined;
  if (config.store.kind === "postgres") {
    db = createDatabase({
      connectionString: config.store.url,
      onIdleError: (error) => {
        log.warn({ err: error }, "an idle database connection failed; the pool replaces it");
      },
    });
    const applied = await migrate(db);
    if (applied.length > 0) log.info({ migrations: applied }, "database migrated");
  } else {
    log.warn({}, "STORE=memory: settlements are not durable and only one replica is safe");
  }

  const states: NetworkState[] = [];
  const setups = [];
  // One TTL round per network at a time across every replica sharing the database.
  const lock: TaskLock = db === undefined ? new MemoryTaskLock() : new PostgresTaskLock(db);
  for (const network of config.networks) {
    const sponsor = Keypair.fromSecret(network.sponsorSecret);
    const channelKeys = deriveChannelKeypairs(sponsor, network.network, network.channelCount);
    const addresses = channelKeys.map((keypair) => keypair.publicKey());
    const server = new rpc.Server(network.rpcUrl, {
      allowHttp: new URL(network.rpcUrl).protocol === "http:",
    });
    meterRpcServer(server, network.network, metrics);

    // Before anything spends the sponsor's XLM: the chain must agree with the configured assets.
    const directory = new AssetDirectory(server, networkPassphrase(network.network));
    const assetCheck = await checkAssets(network, directory);
    if (!assetCheck.ok) {
      if (assetCheck.error !== undefined) throw assetCheck.error;
      log.warn(
        { network: network.network, detail: assetCheck.detail },
        "accepted assets are not verified yet",
      );
    }
    const assets = network.assets.map((asset) => {
      const kind = assetCheck.ok ? assetCheck.kinds.get(asset.contract) : undefined;
      return kind === undefined ? asset : { ...asset, kind };
    });

    const provisioned = await provisionExclusively(lock, network.network, sponsor, () =>
      ensureChannels(network, server, sponsor, channelKeys, log),
    );
    const authority =
      network.upto === undefined ? undefined : await ensureUpto(network, server, sponsor, lock, log);

    const ledger: SettlementLedger =
      db === undefined ? new MemorySettlementLedger() : new PostgresSettlementLedger(db);
    const channels: ChannelPool =
      db === undefined
        ? new MemoryChannelPool(addresses)
        : await PostgresChannelPool.open(db, { network: network.network, addresses });

    const state: NetworkState = {
      config: network,
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
      ...(network.upto === undefined || authority === undefined
        ? {}
        : {
            upto: {
              contract: network.upto.contract,
              authority: authority.address,
              authorityPresent: authority.present,
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
                lock,
                metrics,
                log,
              }),
            },
          }),
      rpcHealthy: true,
      channelsProvisioned: provisioned,
    };
    states.push(state);
    metrics.prepareNetwork(network.network, network.upto === undefined ? ["exact"] : ["exact", "upto"]);
    metrics.channelsTotal.set({ network: network.network }, network.channelCount);
    metrics.readChannelsInUse(network.network, () => channels.inUse());
    setups.push({
      network: network.network,
      rpcUrl: network.rpcUrl,
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
            },
          }),
      inclusionFee: {
        floor: network.inclusionFeeStroops,
        cap: network.inclusionFeeCapStroops,
        percentile: network.inclusionFeePercentile,
      },
      guard: new SponsorBudget({
        network: network.network,
        ledger,
        balance: () => state.sponsorBalance,
        minBalanceStroops: network.sponsorReserveStroops,
        onRefusal: (reason) => {
          metrics.sponsorGuardRefusals.inc({ network: network.network, reason });
        },
        ...(network.maxSponsorSpendPerHourStroops === undefined
          ? {}
          : { maxSpendPerHourStroops: network.maxSponsorSpendPerHourStroops }),
      }),
    });
  }

  const facilitator = createStellarFacilitator({
    networks: setups,
    log,
    observer: metricsObserver(metrics),
  });
  // Rail402's own RPC calls are metered per method; upstream's per-call clients are seen at the
  // transport level only.
  for (const [network, runtime] of facilitator.networks) meterRpcServer(runtime.server, network, metrics);
  const stopWatching = watchTransport(
    config.networks.flatMap((network): TransportTarget[] => [
      { origin: new URL(network.rpcUrl).origin, network: network.network, target: "rpc" },
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
  let bazaar:
    { catalog: Catalog; store: CatalogStore; sandbox: SchemaSandbox; search: SearchService } | undefined;
  if (config.bazaar.enabled) {
    const store: CatalogStore = db === undefined ? new MemoryCatalogStore() : new PostgresCatalogStore(db);
    const sandbox = new SchemaSandbox();
    // Load the schema validator now, so the first seller after a deploy is not refused for its startup.
    if (!(await sandbox.warm()))
      log.warn({}, "the bazaar schema validator did not start; it is retried per request");
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
          directories.get(network)?.describe(contract) ?? Promise.resolve(undefined),
        receivable: (network, contract, payTo) =>
          directories.get(network)?.receivable(contract, payTo) ?? Promise.resolve(undefined),
      },
      homeDomain: (network, account) =>
        directories.get(network)?.homeDomain(account) ?? Promise.resolve(undefined),
      allowLoopback: config.bazaar.allowLoopback,
      maxNewListingsPerOwnerPerHour: config.bazaar.maxNewListingsPerOwnerPerHour,
      maxNewListingsPerPayerPerHour: config.bazaar.maxNewListingsPerPayerPerHour,
      maxNewListingsPerHour: config.bazaar.maxNewListingsPerHour,
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
      log.info({ model: manifest.id, revision: manifest.revision }, "embedding model loaded");
    } else {
      log.warn({}, "SEARCH_EMBEDDINGS=false: search is lexical-only and reports partialResults");
    }
    if (config.search.cursorSecret === undefined) {
      log.warn({}, "SEARCH_CURSOR_SECRET unset: search cursors do not survive restarts or cross replicas");
    }
    const search = new SearchService({
      store,
      assets: new AssetRegistry(
        config.networks.flatMap((network) =>
          network.assets.map((asset) => ({
            network: network.network,
            contract: asset.contract,
            symbol: asset.symbol,
            decimals: asset.decimals,
            usd: USD_PEGGED.has(asset.symbol.toUpperCase()),
          })),
        ),
      ),
      cursorSecret: config.search.cursorSecret ?? randomBytes(32),
      similarityFloor: config.search.similarityFloor,
      // One revision read per second at most; a new listing is searchable within that second.
      revisionMaxAgeMs: 1_000,
      ...(embedder === undefined ? {} : { embedder }),
      observer: searchObserver,
    });
    bazaar = { catalog, store, sandbox, search };
    if (config.bazaar.allowLoopback)
      log.warn({}, "DISCOVERY_ALLOW_LOOPBACK: loopback resources are cataloged");
  }

  const timers: NodeJS.Timeout[] = [];
  let checkingOrigins = false;
  const checkOrigins = async () => {
    if (bazaar === undefined || checkingOrigins) return;
    checkingOrigins = true;
    try {
      await bazaar.catalog.checkOrigins();
    } catch (error) {
      metrics.backgroundErrors.inc({ task: "origin_check" });
      log.error({ err: error }, "origin checks failed");
    }
    // Settlements whose cataloging an earlier process did not finish, e.g. after a crash.
    try {
      await bazaar.catalog.processQueued();
    } catch (error) {
      metrics.backgroundErrors.inc({ task: "catalog_queue" });
      log.error({ err: error }, "queued cataloging failed");
    }
    // Token facts, receivability and SEP-1 domain claims of published listings.
    try {
      await bazaar.catalog.enrich();
    } catch (error) {
      metrics.backgroundErrors.inc({ task: "listing_facts" });
      log.error({ err: error }, "listing facts failed");
    } finally {
      checkingOrigins = false;
    }
  };
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
  let reconciling: Promise<void> | undefined;

  const reconcile = async () => {
    if (reconciling !== undefined) return;
    reconciling = (async () => {
      try {
        // Each attempt is counted by outcome through the settlement observer.
        await facilitator.reconcile();
      } catch (error) {
        metrics.backgroundErrors.inc({ task: "reconcile" });
        log.error({ err: error }, "reconciliation failed");
      }
    })();
    await reconciling;
    reconciling = undefined;
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

  const poll = async (state: NetworkState) => {
    const network = state.config.network;
    try {
      await state.server.getHealth();
      state.rpcHealthy = true;
      const probe = await state.server.getTransaction(ABSENT_TRANSACTION);
      state.latestLedger = probe.latestLedger;
      state.latestLedgerClosedAt = new Date(ledgerCloseSeconds(probe.latestLedgerCloseTime) * 1_000);
      metrics.rpcLatestLedger.set({ network }, probe.latestLedger);
      metrics.rpcLedgerAge.set(
        { network },
        Math.max(0, (Date.now() - state.latestLedgerClosedAt.getTime()) / 1_000),
      );
      state.sponsorBalance = await nativeBalance(state.server, state.sponsor);
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
          await lock.run(sponsorLockName(network, state.sponsor), () =>
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
      state.lastError = error instanceof Error ? error.message : String(error);
      metrics.backgroundErrors.inc({ task: "poll" });
      log.warn({ err: error, network }, "network poll failed");
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
      state.settlements = { last1h, unfinished: unfinished.length };
      state.committed1hStroops = committed;
    } catch (error) {
      delete state.settlements;
      metrics.backgroundErrors.inc({ task: "settlement_ledger" });
      log.warn({ err: error, network }, "could not count settlements");
    }
  };

  const health = new HealthMonitor(metrics, {
    version: options.version ?? "dev",
    ttlWarnLedgers: config.observability.contractTtl.warnLedgers,
    ttlCriticalLedgers: config.observability.contractTtl.criticalLedgers,
  });

  /** Rebuilds the /health snapshot and the catalog and search gauges from the last poll. */
  const refreshHealth = async () => {
    let catalogStats: CatalogStats | undefined;
    if (bazaar !== undefined) {
      try {
        catalogStats = await bazaar.store.stats();
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
      await health.refresh({
        networks: await Promise.all(
          states.map(async (state) => ({
            network: state.config.network,
            rpc: {
              ok: state.rpcHealthy,
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
              },
            }),
      });
    } catch (error) {
      metrics.backgroundErrors.inc({ task: "health" });
      log.warn({ err: error }, "could not build the health snapshot");
    }
  };

  const pollAll = async () => {
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

  const access =
    db === undefined
      ? undefined
      : {
          rateLimiter: new PostgresRateLimiter(db, config.http.rateLimitPerMinute),
          meter: new PostgresUsageMeter(db),
        };

  return {
    facilitator,
    ...(access === undefined ? {} : { access }),
    ...(bazaar === undefined
      ? {}
      : { bazaar: { catalog: bazaar.catalog, store: bazaar.store, search: bazaar.search } }),

    health() {
      return health.snapshot();
    },

    uptoKeepers: new Map(
      states.flatMap((state) =>
        state.upto === undefined ? [] : [[state.config.network, state.upto.keeper]],
      ),
    ),

    async readiness() {
      const checks: Record<string, { ok: boolean; detail?: string }> = {};
      if (db !== undefined) {
        try {
          await sql`SELECT 1`.execute(db);
          checks["database"] = { ok: true };
        } catch (error) {
          checks["database"] = { ok: false, detail: publicReason(error) };
          log.warn({ err: error }, "readiness: the database did not answer");
        }
      }
      for (const state of states) {
        const network = state.config.network;
        const funded =
          state.sponsorBalance !== undefined && state.sponsorBalance >= state.config.minSponsorBalanceStroops;
        checks[`${network}:rpc`] = state.rpcHealthy
          ? { ok: true }
          : {
              ok: false,
              detail: state.lastError === undefined ? "unhealthy" : publicReason(state.lastError),
            };
        checks[`${network}:sponsor`] = funded
          ? { ok: true, detail: `${String(state.sponsorBalance)} stroops` }
          : { ok: false, detail: `balance ${String(state.sponsorBalance ?? "unknown")} below minimum` };
        checks[`${network}:assets`] = state.assets.ok
          ? { ok: true, detail: state.assets.detail }
          : { ok: false, detail: state.assets.detail };
        checks[`${network}:channels`] = state.channelsProvisioned
          ? { ok: true, detail: `${String(state.channels.addresses.length)} channels` }
          : { ok: false, detail: "channel accounts are not all provisioned" };
      }
      if (bazaar !== undefined) {
        checks["search"] = searchIndexed ? { ok: true } : { ok: false, detail: "building the search index" };
      }
      return { ready: Object.values(checks).every((check) => check.ok), checks };
    },

    start() {
      void reconcile();
      // The first /health snapshot waits for the first TTL reading, so it never shows contracts unchecked.
      void Promise.all([Promise.all(states.map(poll)), checkTtl()]).then(refreshHealth);
      timers.push(setInterval(() => void reconcile(), config.reconcileIntervalMs));
      timers.push(setInterval(() => void pollAll(), POLL_INTERVAL_MS));
      timers.push(setInterval(() => void checkTtl(), config.observability.contractTtl.pollMs));
      void indexSearch();
      if (bazaar !== undefined) {
        timers.push(setInterval(() => void checkOrigins(), config.bazaar.originCheckIntervalMs));
        timers.push(setInterval(() => void indexSearch(), 5_000));
      }
      for (const timer of timers) timer.unref();
    },

    async stop() {
      for (const timer of timers) clearInterval(timer);
      stopWatching();
      await reconciling;
      await reconcile();
      await bazaar?.sandbox.close();
      await db?.destroy();
    },
  };
}

/** Asset symbols treated as US-dollar denominated for price filters in dollars and cents. */
const USD_PEGGED = new Set(["USDC", "PYUSD", "USDT", "USDP"]);

/** How long startup waits for another replica that is provisioning accounts on the same network. */
const PROVISION_WAIT_MS = 120_000;

/**
 * Runs `task`, which creates accounts from the sponsor, while holding the network's provisioning lock,
 * and waits while another replica holds it. Replicas starting together would otherwise submit from the
 * sponsor at once, and all but one transaction would fail on the sponsor's sequence number or on an
 * account another replica just created. Each task reads what exists first, so a replica that waited
 * finds nothing left to do.
 */
async function provisionExclusively<T>(
  lock: TaskLock,
  network: string,
  sponsor: Keypair,
  task: () => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + PROVISION_WAIT_MS;
  for (;;) {
    const done = await lock.run(sponsorLockName(network, sponsor.publicKey()), async () => ({
      value: await task(),
    }));
    if (done !== undefined) return done.value;
    if (Date.now() >= deadline) throw new Error(`${network}: another replica is still provisioning accounts`);
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
    if ((await existingAccounts(server, addresses)).size < channels.length) throw error;
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
  if (live === undefined) {
    log.error(
      { network: network.network, contract: upto.contract },
      "the upto settlement contract is not on the network; upto payments fail until it is deployed",
    );
  } else if (live.wasmHash !== upto.wasmHash) {
    throw new Error(
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

async function nativeBalance(server: rpc.Server, address: string): Promise<bigint> {
  const key = xdr.LedgerKey.account(
    new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(address).xdrAccountId() }),
  );
  const { entries } = await server.getLedgerEntries(key);
  const entry = entries[0];
  if (entry === undefined) throw new Error(`sponsor account ${address} does not exist`);
  return entry.val.account().balance().toBigInt();
}
