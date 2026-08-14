import { serve } from "@hono/node-server";
import { X402Error } from "@rail402/errors";
import { loadConfig, describeConfig } from "./config/env.js";
import { createApp } from "./app.js";
import { startExplorerAnnounce } from "./announce.js";
import { createLogger } from "./logger.js";

// The log level is read from the environment here rather than from config, because the very first
// thing that can fail — loadConfig — happens before a config object exists, and a configuration
// error still deserves a leveled, structured line.
const log = createLogger(process.env.LOG_LEVEL ?? "info");

/**
 * Entrypoint. Configuration is validated before the port is bound, so a misconfigured deployment
 * fails immediately and visibly rather than serving 500s on real payments.
 */
async function main(): Promise<void> {
  const startedAt = Date.now();

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof X402Error) {
      // A coded, actionable startup failure — not a stack trace.
      log.fatal({ code: error.code, reason: error.reason }, "configuration error");
      process.exit(1);
    }
    throw error;
  }

  const { app, signerAddresses, feeBumpAddress, startFederation } = createApp({ config, startedAt });

  // describeConfig is the redacted view — no secret reaches the log.
  log.info(
    { config: describeConfig(config), signers: signerAddresses, feeBump: feeBumpAddress ?? null },
    "starting x402 Stellar facilitator",
  );

  // Mirrors of other catalogs, if any are configured. Started here rather than in createApp so that
  // constructing an app never touches the network.
  const stopFederation = startFederation();

  // Explorer announce heartbeat (default on; EXPLORER_ANNOUNCE_URL="" disables). Fire-and-forget
  // by design — an explorer outage must never touch a payment path.
  const stopAnnounce = startExplorerAnnounce({ config, logger: log });

  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, info => {
    log.info({ url: `http://${config.host}:${info.port}` }, "listening");
  });

  const shutdown = (signal: string) => {
    log.info({ signal }, "draining connections");
    stopAnnounce();
    stopFederation();
    server.close(() => process.exit(0));
    // Do not let a hung connection block a redeploy indefinitely.
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch(error => {
  log.fatal({ err: error }, "fatal");
  process.exit(1);
});
