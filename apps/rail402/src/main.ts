import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { ConfigError, loadConfig, type Config } from "./config.ts";
import { createLogger } from "./logger.ts";
import { Metrics } from "./metrics.ts";
import { createRuntime } from "./runtime.ts";

const VERSION = process.env["RAIL402_VERSION"] ?? "dev";

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`rail402: ${error.message}\n`);
      process.exit(78); // EX_CONFIG
    }
    throw error;
  }

  const log = createLogger({ level: config.logLevel, version: VERSION });

  const metrics = new Metrics();
  const runtime = await createRuntime(config, metrics, log);
  const app = createApp({
    config,
    facilitator: runtime.facilitator,
    metrics,
    log,
    readiness: () => runtime.readiness(),
    version: VERSION,
    ...(runtime.bazaar === undefined ? {} : { bazaar: runtime.bazaar }),
    ...(runtime.access === undefined
      ? {}
      : { rateLimiter: runtime.access.rateLimiter, meter: runtime.access.meter }),
  });

  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    log.info({ port: info.port, networks: config.networks.map((n) => n.network) }, "rail402 listening");
  });
  runtime.start();

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, "shutting down");
    const force = setTimeout(() => {
      log.error({}, "shutdown grace period elapsed; exiting");
      process.exit(1);
    }, config.shutdownGraceMs);
    force.unref();
    // Stop accepting connections, let in-flight settlements finish, then reconcile and close.
    server.close(() => {
      void runtime
        .stop()
        .then(() => {
          log.info({}, "stopped");
          process.exit(0);
        })
        .catch((error: unknown) => {
          log.error({ err: error }, "shutdown failed");
          process.exit(1);
        });
    });
  };
  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });
}

main().catch((error: unknown) => {
  process.stderr.write(
    `rail402: fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});
