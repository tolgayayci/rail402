import { serve } from "@hono/node-server";
import pino from "pino";
import { createExplorerApp } from "./app.js";
import { describeConfig, loadConfig } from "./config.js";
import { ExplorerStore } from "./db.js";
import { createBazaarEnricher } from "./enrich.js";
import { HorizonBackfill } from "./horizon.js";
import { IngestWorker } from "./ingest.js";
import { FacilitatorRegistry } from "./registry.js";

/** Server entrypoint: config → store → registry → HTTP (bind first) → ingest. Fail-fast on bad config. */

const config = loadConfig();
const logger = pino({ level: config.logLevel, base: { service: "rail402-explorer" } });

const store = new ExplorerStore(config.dbPath);
const registry = new FacilitatorRegistry({
  store,
  seeds: config.facilitatorSeeds,
  pollIntervalMs: config.supportedPollIntervalMs,
  logger,
});
registry.seed();

let ingest: IngestWorker | undefined;
let horizon: HorizonBackfill | undefined;
if (config.ingestEnabled) {
  ingest = new IngestWorker({
    store,
    config,
    enricher: createBazaarEnricher(store, config.bazaarUrl),
    logger,
  });
  horizon = new HorizonBackfill({ store, config, worker: ingest, logger });
}

const app = createExplorerApp({
  store,
  config,
  registry,
  logger,
  ...(ingest ? { ingest } : {}),
  ...(horizon ? { horizon } : {}),
});

logger.info(describeConfig(config), "explorer starting");
// Bind the port FIRST (review M8): the deploy healthcheck must not wait on the registry probes.
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, info => {
  logger.info({ port: info.port }, "explorer listening");
});

// Verify the seeds BEFORE ingestion starts, but AFTER the port is bound. Attribution and the
// Horizon epoch walk both read the verified signer index, and a cold boot that classified its
// first rows against an empty registry would mislabel a facilitator's own payments as x402-shaped
// (found live, 2026-08-14). Ingestion is gated on this refresh; the HTTP server is not.
void (async () => {
  await registry.refreshAll().catch((error: unknown) => {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      "initial registry refresh failed; starting with an empty signer index",
    );
  });
  registry.start();
  ingest?.start();
  horizon?.start();
})();

let shuttingDown = false;
const shutdown = (): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("explorer shutting down");
  horizon?.stop();
  ingest?.stop();
  registry.stop();
  // Close the DB even if the server never drains — a lingering keep-alive must not wedge the
  // process open (review m10). A hard deadline backstops the graceful close.
  const finish = (): void => {
    store.close();
    process.exit(0);
  };
  server.close(finish);
  setTimeout(finish, 10_000).unref();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
