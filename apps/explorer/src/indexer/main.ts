/**
 * The Explorer indexer: discovers the ledgers that hold transactions of the registry's facilitator
 * accounts and upto contracts through Lumeus Activity, reads those ledgers' full bytes (Lumeus RPC inside
 * its retention, the public data lake before it), verifies and classifies them, and follows the head.
 * Settings: config.ts.
 *
 *   EXPLORER_NETWORK=testnet EXPLORER_LUMEUS_KEY_FILE=/run/secrets/lumeus-testnet \
 *   EXPLORER_DATABASE_URL=postgres://… pnpm --filter @rail402.dev/explorer indexer
 */
import { pino } from "pino";
import {
  DataLakeSource,
  HorizonAnchors,
  Limiter,
  LumeusActivity,
  RpcLedgerSource,
  lumeusCodeLabel,
  type Fetch,
} from "@rail402.dev/ledger-source";
import { migrate } from "@rail402.dev/store-postgres";
import { RULES_VERSION } from "@rail402.dev/x402-index";
import { REGISTRIES } from "@rail402.dev/x402-index/registry";
import { ExplorerConfigError, indexerConfig } from "../config.ts";
import { EXPLORER_MIGRATIONS, createExplorerDatabase } from "../db.ts";
import { detectEpoch } from "../epoch.ts";
import { startHealthServer } from "../health.ts";
import { ExplorerMetrics } from "../metrics.ts";
import { assertWriterRole } from "../roles.ts";
import { ExplorerStore, reconcileRegistry } from "../store.ts";
import { LedgerBytes } from "./bytes.ts";
import { Ingester } from "./ingester.ts";
import { ReportPublisher } from "./report-publisher.ts";

const logger = pino({ name: "rail402-explorer-indexer" });

/**
 * A fetch that counts every Lumeus request by product and status, and for RPC (whose JSON-RPC client
 * has no hook of its own) failed requests by status. Activity failures are counted by their Lumeus code.
 */
function counted(metrics: ExplorerMetrics, network: string, product: "activity" | "rpc"): Fetch {
  return async (input, init) => {
    try {
      const response = await fetch(input, init);
      metrics.lumeusRequests.inc({ network, product, status: String(response.status) });
      if (product === "rpc" && response.status !== 200)
        metrics.lumeusErrors.inc({ network, product, code: lumeusCodeLabel(undefined, response.status) });
      return response;
    } catch (error) {
      metrics.lumeusRequests.inc({ network, product, status: "0" });
      if (product === "rpc") metrics.lumeusErrors.inc({ network, product, code: "transport" });
      throw error;
    }
  };
}

async function main(): Promise<number> {
  const config = indexerConfig(process.env);
  const registry = REGISTRIES[config.network];
  const newest = registry.document.epochs.at(-1);
  if (newest === undefined) throw new ExplorerConfigError("config_invalid", "the registry lists no epoch");
  const epoch = detectEpoch(registry, { passphrase: newest.passphrase, folder: newest.dataLakeFolder });

  if (config.migrationDatabaseUrl !== undefined) {
    const owner = createExplorerDatabase({
      connectionString: config.migrationDatabaseUrl,
      maxConnections: 1,
    });
    try {
      const applied = await migrate(owner, EXPLORER_MIGRATIONS);
      logger.info({ applied }, "migrated the Explorer database");
    } finally {
      await owner.destroy();
    }
  }

  const db = createExplorerDatabase({
    connectionString: config.databaseUrl,
    maxConnections: config.concurrency + 2,
    onIdleError: (error) => {
      logger.warn({ err: error.message }, "idle database connection failed");
    },
  });
  try {
    await assertWriterRole(db, { facilitatorDatabase: config.facilitatorDatabase });
  } catch (error) {
    if (!config.allowUnsafeRole) throw error;
    logger.warn(
      { err: (error as Error).message },
      "running under an unsafe role (EXPLORER_ALLOW_UNSAFE_ROLE)",
    );
  }
  const store = new ExplorerStore(db);
  await store.loadRegistry(registry);
  // Rows indexed under an older registry or rules version: re-attribute or index them again.
  const reconciled = await reconcileRegistry(store, config.network, epoch.id, registry, RULES_VERSION);
  if (reconciled.reattributed + reconciled.reset > 0) {
    logger.info({ ...reconciled, registryVersion: registry.registryVersion }, "reconciled the registry");
  }

  const network = config.network;
  const metrics = new ExplorerMetrics();
  // One budget of Lumeus requests in flight for discovery and ledger bytes together.
  const limiter = new Limiter(config.concurrency);
  const activity = new LumeusActivity({
    network,
    apiKey: config.lumeusKey,
    url: config.activityUrl,
    limiter,
    fetch: counted(metrics, network, "activity"),
    onRequest: (outcome) => {
      if (outcome.status !== 200)
        metrics.lumeusErrors.inc({
          network,
          product: "activity",
          code: lumeusCodeLabel(outcome.code, outcome.status),
        });
    },
  });
  const rpc = new RpcLedgerSource({
    url: config.rpcUrl,
    pageLimit: config.rpcPageLedgers,
    ...(config.rpcIsLumeus
      ? { apiKey: config.lumeusKey, network, limiter, fetch: counted(metrics, network, "rpc") }
      : {}),
  });
  const bytes = new LedgerBytes({
    lake: new DataLakeSource({ folder: epoch.dataLakeFolder, passphrase: epoch.passphrase }),
    rpc,
    pageLimit: config.rpcPageLedgers,
    retentionMarginLedgers: config.retentionMarginLedgers,
    concurrency: config.concurrency,
    maxBytesInFlight: config.bytesInFlightMib * 1024 * 1024,
    onBytesInFlight: (held) => {
      metrics.bytesInFlight.set({ network }, held);
    },
  });

  const abort = new AbortController();
  const from = config.fromLedger ?? epoch.fromLedger;
  const ingester = new Ingester({
    network,
    registry,
    epoch,
    store,
    activity,
    bytes,
    ...(config.anchorHorizonUrl === undefined
      ? {}
      : { anchors: new HorizonAnchors({ url: config.anchorHorizonUrl }) }),
    metrics,
    logger,
    from,
    to: config.toLedger,
    windowLedgers: config.windowLedgers,
    maxCandidatesPerRound: config.maxCandidatesPerRound,
    slowRouteRounds: config.slowRouteRounds,
    concurrency: config.concurrency,
    pollMs: config.pollSeconds * 1000,
    signal: abort.signal,
  });
  let stopped = false;
  const server = await startHealthServer({
    host: config.healthHost,
    port: config.healthPort,
    registry: metrics.registry,
    maxLagLedgers: config.maxLagLedgers,
    snapshot: () => ({ network, epoch: epoch.id, ...ingester.status, stopped }),
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      logger.info({ signal }, "stopping after the current round");
      abort.abort();
    });
  }
  const publisher = new ReportPublisher(db, { network, epoch, registry }, logger);
  if (config.reportRefreshSeconds > 0) publisher.start(config.reportRefreshSeconds * 1000);
  logger.info(
    { network, epoch: epoch.id, from, to: config.toLedger ?? "head", rpcIsLumeus: config.rpcIsLumeus },
    "indexing the registry scope",
  );
  try {
    await ingester.run();
    return 0;
  } catch (error) {
    stopped = true;
    logger.error(
      { err: (error as Error).message, code: (error as { code?: string }).code },
      "the indexer stopped",
    );
    return 1;
  } finally {
    server.close();
    await publisher.stop();
    // A bounded run publishes the report of what it indexed before it exits.
    if (config.toLedger !== undefined && !stopped && config.reportRefreshSeconds > 0)
      await publisher.publish();
    await db.destroy();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    logger.error(
      { err: error instanceof Error ? error.message : String(error) },
      "the indexer could not start",
    );
    process.exitCode = error instanceof ExplorerConfigError ? 78 : 1;
  },
);
