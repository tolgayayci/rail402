/**
 * The Explorer's web role: public pages and the read API over the Explorer database, as the reader
 * role only. Settings: web/config.ts.
 *
 *   EXPLORER_DATABASE_URL=postgres://reader:…@localhost:5432/rail402_explorer pnpm --filter @rail402.dev/explorer web
 */
import { createServer } from "node:http";
import { serve } from "@hono/node-server";
import { pino } from "pino";
import { REGISTRIES } from "@rail402.dev/x402-index/registry";
import { ExplorerReader } from "../api/queries.ts";
import { ExplorerConfigError } from "../config.ts";
import { createExplorerDatabase } from "../db.ts";
import { assertReaderRole } from "../roles.ts";
import { createExplorerApp, type ServedNetwork } from "./app.ts";
import { BazaarClient } from "./bazaar.ts";
import { webConfig } from "./config.ts";
import { HoldingsClient } from "./holdings.ts";
import { ChainTip } from "./chain-tip.ts";
import { LiveLookup } from "./live-lookup.ts";
import { WebMetrics } from "./metrics.ts";
import { ReportCache } from "./report-cache.ts";

const logger = pino({ name: "rail402-explorer-web" });

async function main(): Promise<void> {
  const config = webConfig(process.env);
  const db = createExplorerDatabase({
    connectionString: config.databaseUrl,
    maxConnections: 10,
    acquireTimeoutMs: 2_000,
    statementTimeoutMs: 2_000,
    onIdleError: (error) => {
      logger.warn({ err: error.message }, "idle database connection failed");
    },
  });
  try {
    await assertReaderRole(db, { facilitatorDatabase: config.facilitatorDatabase });
  } catch (error) {
    if (!config.allowUnsafeRole) throw error;
    logger.warn(
      { err: (error as Error).message },
      "running under an unsafe role (EXPLORER_ALLOW_UNSAFE_ROLE)",
    );
  }
  const metrics = new WebMetrics();
  const networks: ServedNetwork[] = config.networks.map((settings) => {
    const registry = REGISTRIES[settings.network];
    const epoch = registry.document.epochs.at(-1);
    if (epoch === undefined)
      throw new ExplorerConfigError("config_invalid", `the ${settings.network} registry lists no epoch`);
    return {
      network: settings.network,
      registry,
      epoch,
      publicRpcUrl: settings.publicRpcUrl,
      tip: new ChainTip(settings.publicRpcUrl),
      lookup:
        settings.lookupRpcUrl === undefined
          ? undefined
          : new LiveLookup({
              network: settings.network,
              rpcUrl: settings.lookupRpcUrl,
              ...(settings.lookupApiKey === undefined
                ? {}
                : { apiKey: settings.lookupApiKey, origin: config.publicUrl }),
              budget: config.lookup,
              context: { network: settings.network, epoch: epoch.id, passphrase: epoch.passphrase, registry },
            }),
      bazaar:
        settings.bazaarUrl === undefined
          ? undefined
          : new BazaarClient({
              network: settings.network,
              baseUrl: settings.bazaarUrl,
              timeoutMs: config.bazaarTimeoutMs,
              cacheMs: config.bazaarCacheSeconds * 1000,
              metrics,
              ...(settings.bazaarKey === undefined ? {} : { apiKey: settings.bazaarKey }),
            }),
      holdings:
        settings.holdingsKey === undefined
          ? undefined
          : new HoldingsClient({
              network: settings.network,
              apiKey: settings.holdingsKey,
              origin: config.publicUrl,
              perMinute: config.holdingsPerMinute,
              metrics,
            }),
    };
  });
  const reports = new ReportCache(db, networks, { metrics, logger });
  reports.start(config.reportRefreshSeconds * 1000);
  const app = createExplorerApp({
    reader: new ExplorerReader(db),
    reports,
    networks,
    ratePerMinute: config.ratePerMinute,
    trustedProxyHops: config.trustedProxyHops,
    maxInFlight: config.maxInFlight,
    statusUrl: config.statusUrl,
    publicUrl: config.publicUrl,
    metrics,
  });
  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host });
  const metricsServer = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/metrics") {
      metrics.registry
        .metrics()
        .then((text) => response.writeHead(200, { "content-type": metrics.registry.contentType }).end(text))
        .catch(() => response.writeHead(500).end());
      return;
    }
    response.writeHead(404).end();
  }).listen(config.metricsPort, config.metricsHost);
  logger.info(
    {
      port: config.port,
      networks: config.networks.map((entry) => entry.network),
      bazaar: config.networks.map((entry) => entry.bazaarUrl ?? "off"),
      bazaarKey: config.networks.map((entry) => entry.bazaarKey !== undefined),
      holdings: config.networks.map((entry) => entry.holdingsKey !== undefined),
      metricsPort: config.metricsPort,
    },
    "serving the Explorer",
  );
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      logger.info({ signal }, "stopping");
      reports.stop();
      metricsServer.close();
      server.close(() => {
        void db.destroy();
      });
    });
  }
}

main().catch((error: unknown) => {
  logger.error(
    { err: error instanceof Error ? error.message : String(error), code: (error as { code?: string }).code },
    "the Explorer web role could not start",
  );
  process.exitCode = error instanceof ExplorerConfigError ? 78 : 1;
});
