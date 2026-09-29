import { Keypair, rpc, xdr } from "@stellar/stellar-sdk";
import { sql, type Kysely } from "kysely";
import {
  MemoryChannelPool,
  MemorySettlementLedger,
  SponsorBudget,
  createStellarFacilitator,
  deriveChannelKeypairs,
  existingAccounts,
  provisionChannels,
  type ChannelPool,
  type Logger,
  type SettlementLedger,
  type StellarFacilitator,
} from "@rail402.dev/facilitator";
import { AssetDirectory, networkPassphrase } from "@rail402.dev/stellar";
import { Catalog, MemoryCatalogStore, SchemaSandbox, type CatalogStore } from "@rail402.dev/bazaar";
import { BAZAAR } from "@x402/extensions/bazaar";
import { randomBytes } from "node:crypto";
import {
  AssetRegistry,
  OnnxEmbedder,
  SearchService,
  ensureModel,
  loadManifest,
  type Embedder,
} from "@rail402.dev/search";
import {
  PostgresCatalogStore,
  PostgresChannelPool,
  PostgresRateLimiter,
  PostgresUsageMeter,
  PostgresSettlementLedger,
  createDatabase,
  migrate,
  type Database,
} from "@rail402.dev/store-postgres";
import type { Readiness } from "./app.ts";
import type { Config, NetworkConfig } from "./config.ts";
import type { Metrics } from "./metrics.ts";

interface NetworkState {
  readonly config: NetworkConfig;
  readonly server: rpc.Server;
  readonly sponsor: string;
  readonly channels: ChannelPool;
  sponsorBalance?: bigint;
  rpcHealthy: boolean;
  channelsProvisioned: boolean;
  lastError?: string;
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
  /** Starts background work: reconciliation and balance polling. */
  start(): void;
  /** Stops background work, reconciles once more and closes the database. */
  stop(): Promise<void>;
}

/** Builds the facilitator and its stores from configuration. Fails fast on anything unusable. */
export async function createRuntime(config: Config, metrics: Metrics, log: Logger): Promise<Runtime> {
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
  for (const network of config.networks) {
    const sponsor = Keypair.fromSecret(network.sponsorSecret);
    const channelKeys = deriveChannelKeypairs(sponsor, network.network, network.channelCount);
    const addresses = channelKeys.map((keypair) => keypair.publicKey());
    const server = new rpc.Server(network.rpcUrl, {
      allowHttp: new URL(network.rpcUrl).protocol === "http:",
    });

    const provisioned = await ensureChannels(network, server, sponsor, channelKeys, log);

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
      rpcHealthy: true,
      channelsProvisioned: provisioned,
    };
    states.push(state);
    metrics.channelsTotal.set({ network: network.network }, network.channelCount);
    setups.push({
      network: network.network,
      rpcUrl: network.rpcUrl,
      sponsorSecret: network.sponsorSecret,
      channelCount: network.channelCount,
      assets: network.assets,
      policy: {
        maxTransactionFeeStroops: network.maxTransactionFeeStroops,
        inclusionFeeStroops: network.inclusionFeeStroops,
        expirationMarginLedgers: network.expirationMarginLedgers,
        timeoutSeconds: network.timeoutSeconds,
      },
      ledger,
      channels,
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
        ...(network.maxSponsorSpendPerHourStroops === undefined
          ? {}
          : { maxSpendPerHourStroops: network.maxSponsorSpendPerHourStroops }),
      }),
    });
  }

  const facilitator = createStellarFacilitator({ networks: setups, log });

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
      allowLoopback: config.bazaar.allowLoopback,
      maxNewListingsPerOwnerPerHour: config.bazaar.maxNewListingsPerOwnerPerHour,
      maxNewListingsPerPayerPerHour: config.bazaar.maxNewListingsPerPayerPerHour,
      maxNewListingsPerHour: config.bazaar.maxNewListingsPerHour,
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
        const finished = await facilitator.reconcile();
        if (finished > 0) metrics.settlementsReconciled.inc(finished);
      } catch (error) {
        metrics.backgroundErrors.inc({ task: "reconcile" });
        log.error({ err: error }, "reconciliation failed");
      }
    })();
    await reconciling;
    reconciling = undefined;
  };

  const poll = async (state: NetworkState) => {
    const network = state.config.network;
    try {
      await state.server.getHealth();
      state.rpcHealthy = true;
      state.sponsorBalance = await nativeBalance(state.server, state.sponsor);
      metrics.sponsorBalance.set({ network }, Number(state.sponsorBalance));
      metrics.channelsInUse.set({ network }, await state.channels.inUse());
      if (!state.channelsProvisioned) {
        const existing = await existingAccounts(state.server, state.channels.addresses);
        state.channelsProvisioned = existing.size === state.channels.addresses.length;
      }
      delete state.lastError;
    } catch (error) {
      state.rpcHealthy = false;
      state.lastError = error instanceof Error ? error.message : String(error);
      metrics.backgroundErrors.inc({ task: "poll" });
      log.warn({ err: error, network }, "network poll failed");
    }
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

    async readiness() {
      const checks: Record<string, { ok: boolean; detail?: string }> = {};
      if (db !== undefined) {
        try {
          await sql`SELECT 1`.execute(db);
          checks["database"] = { ok: true };
        } catch (error) {
          checks["database"] = { ok: false, detail: error instanceof Error ? error.message : "unreachable" };
        }
      }
      for (const state of states) {
        const network = state.config.network;
        const funded =
          state.sponsorBalance !== undefined && state.sponsorBalance >= state.config.minSponsorBalanceStroops;
        checks[`${network}:rpc`] = state.rpcHealthy
          ? { ok: true }
          : { ok: false, detail: state.lastError ?? "unhealthy" };
        checks[`${network}:sponsor`] = funded
          ? { ok: true, detail: `${String(state.sponsorBalance)} stroops` }
          : { ok: false, detail: `balance ${String(state.sponsorBalance ?? "unknown")} below minimum` };
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
      for (const state of states) void poll(state);
      timers.push(setInterval(() => void reconcile(), config.reconcileIntervalMs));
      timers.push(setInterval(() => void Promise.all(states.map(poll)), 15_000));
      void indexSearch();
      if (bazaar !== undefined) {
        timers.push(setInterval(() => void checkOrigins(), config.bazaar.originCheckIntervalMs));
        timers.push(setInterval(() => void indexSearch(), 5_000));
      }
      for (const timer of timers) timer.unref();
    },

    async stop() {
      for (const timer of timers) clearInterval(timer);
      await reconciling;
      await reconcile();
      await bazaar?.sandbox.close();
      await db?.destroy();
    },
  };
}

/** Asset symbols treated as US-dollar denominated for price filters in dollars and cents. */
const USD_PEGGED = new Set(["USDC", "PYUSD", "USDT", "USDP"]);

async function ensureChannels(
  network: NetworkConfig,
  server: rpc.Server,
  sponsor: Keypair,
  channels: Keypair[],
  log: Logger,
): Promise<boolean> {
  const existing = await existingAccounts(
    server,
    channels.map((keypair) => keypair.publicKey()),
  );
  const missing = channels.length - existing.size;
  if (missing === 0) return true;
  if (!network.autoProvisionChannels) {
    log.warn({ network: network.network, missing }, "channel accounts missing; run `channels provision`");
    return false;
  }
  const result = await provisionChannels({
    server,
    passphrase: networkPassphrase(network.network),
    sponsor,
    channels,
  });
  log.info({ network: network.network, created: result.created.length }, "channel accounts provisioned");
  return true;
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
