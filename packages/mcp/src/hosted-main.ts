import { isRail402Error } from "@rail402.dev/errors";
import { resolveHostedConfig } from "./hosted.ts";
import { startHostedServer } from "./hosted-server.ts";
import type { LogLevel } from "@rail402.dev/sdk";
import { createLogger } from "./logger.ts";

const LEVELS: readonly LogLevel[] = ["fatal", "error", "warn", "info", "debug", "trace", "silent"];

/** Exit status for a configuration the process refuses to start with (sysexits EX_CONFIG). */
export const EXIT_CONFIG = 78;

/**
 * Runs `rail402-mcp --hosted`: the public, discovery-only endpoint. Everything it imports is built on
 * `@rail402.dev/sdk/discovery`, so the process never loads key loading, the signing guard, a budget
 * ledger or a payment flow; a configuration that could make it pay stops it with status 78.
 */
export async function hostedMain(env: Record<string, string | undefined> = process.env): Promise<number> {
  let config;
  try {
    config = resolveHostedConfig(env);
  } catch (error) {
    const body = isRail402Error(error)
      ? {
          code: error.code,
          reason: error.reason,
          ...(error.details === undefined ? {} : { details: error.details }),
        }
      : { code: "config_hosted_invalid", reason: "The configuration could not be read." };
    process.stderr.write(
      `${JSON.stringify({ level: "fatal", msg: "rail402-mcp --hosted could not start", error: body })}\n`,
    );
    return EXIT_CONFIG;
  }
  const requested = env["RAIL402_LOG_LEVEL"]?.trim() as LogLevel | undefined;
  const level: LogLevel = requested !== undefined && LEVELS.includes(requested) ? requested : "info";
  const logger = createLogger(level);
  const running = await startHostedServer(config, { logger });
  const stopped = new Promise<number>((resolve) => {
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      void running
        .close()
        .catch(() => undefined)
        .then(() => {
          logger.info("stopped");
          resolve(0);
        });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
  // Logged once the signal handlers are in place: a supervisor that stops the process as soon as it
  // reads this line still gets a clean shutdown.
  logger.info("serving", {
    mode: "hosted",
    url: running.url,
    networks: config.networks,
    upstream: new URL(config.upstream).origin,
    // Whether discovery runs under the Bazaar access key; the key itself is never logged.
    upstreamKey: config.upstreamKey !== undefined,
  });
  return stopped;
}
