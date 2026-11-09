import { createApp } from "./app.ts";
import { ConfigError, configFailureLine, loadConfig, type Config } from "./config.ts";
import { startupFailureLines } from "./failure.ts";
import { afterLogsWritten, createLogger } from "./logger.ts";
import { Metrics } from "./metrics.ts";
import { createRuntime, type Runtime } from "./runtime.ts";
import { listen } from "./server.ts";

const VERSION = process.env["RAIL402_VERSION"] ?? "dev";

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(configFailureLine(error));
      process.exit(78); // EX_CONFIG
    }
    throw error;
  }

  const log = createLogger({ level: config.logLevel, version: VERSION });

  const metrics = new Metrics();
  let runtime: Runtime;
  try {
    runtime = await createRuntime(config, metrics, log, { version: VERSION });
  } catch (error) {
    // A configuration the network contradicts, such as an asset's decimals, is a configuration error.
    if (error instanceof ConfigError) {
      process.stderr.write(configFailureLine(error));
      process.exit(78); // EX_CONFIG
    }
    throw error;
  }
  const app = createApp({
    config,
    facilitator: runtime.facilitator,
    metrics,
    log,
    readiness: () => runtime.readiness(),
    networkReadiness: (network) => runtime.networkReadiness(network),
    refusal: (network) => runtime.refusal(network),
    settlementUsage: (subject, since) => runtime.settlementUsage(subject, since),
    callerCommitted: (network, subject) => runtime.callerCommitted(network, subject),
    health: () => runtime.health(),
    version: VERSION,
    ...(runtime.bazaar === undefined ? {} : { bazaar: runtime.bazaar }),
    accessKeys: runtime.accessKeys,
    ...(runtime.access === undefined
      ? {}
      : {
          rateLimiter: runtime.access.rateLimiter,
          ...(runtime.access.pubnetRateLimiter === undefined
            ? {}
            : { pubnetRateLimiter: runtime.access.pubnetRateLimiter }),
          networkLimiter: runtime.access.networkLimiter,
          ...(runtime.access.discoveryLimiter === undefined
            ? {}
            : { discoveryLimiter: runtime.access.discoveryLimiter }),
          meter: runtime.access.meter,
          issuedKeys: runtime.access.issuedKeys,
        }),
  });

  const server = listen(
    app.fetch,
    {
      port: config.port,
      host: config.host,
      responseWriteTimeoutMs: config.http.responseWriteTimeoutMs,
      maxPipelinedRequests: config.http.maxPipelinedRequests,
      onReset: (reason, dropped) => {
        metrics.connectionsReset.inc({ reason });
        log.debug({ reason, dropped }, "a connection was reset");
      },
    },
    (info) => {
      log.info({ port: info.port, networks: config.networks.map((n) => n.network) }, "rail402 listening");
    },
  );
  runtime.start();

  /** Exits once the lines just logged are out, in order (a second at most); the first exit decides. */
  let exiting = false;
  const exit = (code: number) => {
    if (exiting) return;
    exiting = true;
    process.exitCode = code;
    afterLogsWritten(log, () => process.exit(code));
  };

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, "shutting down");
    const force = setTimeout(() => {
      log.error({}, "shutdown grace period elapsed; exiting");
      exit(1);
    }, config.shutdownGraceMs);
    force.unref();
    // Stop accepting connections, let in-flight settlements finish, then reconcile and close. Idle
    // connections and requests whose headers or body are still arriving are dropped (none has been
    // acted on yet), and a client that does not take its answer is cut off after a short window, so
    // only handlers still at work keep the final reconcile from running.
    server.close(() => {
      if (exiting) return;
      void runtime
        .stop()
        .then(() => {
          log.info({}, "stopped");
          exit(0);
        })
        .catch((error: unknown) => {
          log.error({ err: error }, "shutdown failed");
          exit(1);
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

// Anything else that stops startup, whatever was thrown: one coded, secret-free line, exit 1.
main().catch((error: unknown) => {
  process.stderr.write(startupFailureLines(error));
  process.exit(1);
});
