import { createRequire } from "node:module";
import { serve } from "@hono/node-server";
import { REQUEST_TIMEOUTS, createApp } from "./app.ts";
import { ConfigError, loadConfig } from "./config.ts";
import { createLogger } from "./log.ts";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

let config;
try {
  config = loadConfig(process.env, { version });
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  // The message names the variable, never its value.
  process.stderr.write(
    `${JSON.stringify({ level: "fatal", code: "playground_config_invalid", reason: error.message })}\n`,
  );
  process.exit(78); // EX_CONFIG
}

const log = createLogger({ level: config.logLevel, version: config.version });
const playground = createApp({ config, log });
const server = serve(
  {
    fetch: playground.app.fetch,
    port: config.port,
    hostname: config.host,
    serverOptions: {
      headersTimeout: REQUEST_TIMEOUTS.headersMs,
      requestTimeout: REQUEST_TIMEOUTS.requestMs,
    },
  },
  (info) => {
    log.info(
      { port: info.port, mode: config.mode, network: config.network, version: config.version },
      "rail402-playground listening",
    );
  },
);

let stopping = false;
const stop = (signal: string) => {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, "shutting down");
  playground.close();
  server.close(() => process.exit(0));
  // Relayed requests and streams may run for minutes; do not wait for them past this.
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on("SIGTERM", () => {
  stop("SIGTERM");
});
process.on("SIGINT", () => {
  stop("SIGINT");
});
