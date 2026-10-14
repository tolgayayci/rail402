import { isRail402Error } from "@rail402.dev/errors";
import { redact } from "@rail402.dev/sdk";
import { USAGE, resolveMcpCommand } from "./config.ts";
import { startHttpTransport } from "./http.ts";
import { createLogger } from "./logger.ts";
import { createRail402Mcp, openConfiguredBuyer } from "./runtime.ts";
import { SERVER_INFO } from "./server.ts";
import { startStdioTransport } from "./stdio.ts";

/**
 * Runs rail402-mcp: resolves the configuration (failing fast, before anything is served), opens the
 * buyer and serves stdio or loopback HTTP until stdin closes or a signal arrives.
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  let command;
  try {
    command = resolveMcpCommand(argv, env);
  } catch (error) {
    return fail(error);
  }
  // No MCP session runs for these, so stdout is free.
  if (command.kind === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command.kind === "version") {
    process.stdout.write(`${SERVER_INFO.version}\n`);
    return 0;
  }
  const { agent, transport } = command.config;
  const logger = createLogger(agent.logLevel);
  let opened;
  try {
    opened = await openConfiguredBuyer(agent, logger);
  } catch (error) {
    return fail(error);
  }
  const { buyer } = opened;
  const { factory } = createRail402Mcp({ buyer, limits: { maxInflight: agent.maxInflight }, logger });

  let stop: () => Promise<void>;
  if (transport.kind === "http") {
    let running;
    try {
      running = await startHttpTransport(factory, { ...transport, logger });
    } catch (error) {
      await opened.close();
      return fail(error);
    }
    logger.info("serving", {
      transport: "http",
      url: running.url,
      network: buyer.network,
      payer: buyer.address ?? null,
    });
    stop = () => running.close();
  } else {
    const handle = startStdioTransport(factory, { logger });
    logger.info("serving", { transport: "stdio", network: buyer.network, payer: buyer.address ?? null });
    stop = () => handle.close();
  }

  return new Promise<number>((resolve) => {
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      void (async () => {
        await stop().catch(() => undefined);
        await opened.close().catch(() => undefined);
        logger.info("stopped");
        resolve(0);
      })();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    // An MCP host ends a stdio server by closing its stdin.
    if (transport.kind === "stdio") process.stdin.once("close", shutdown).once("end", shutdown);
  });
}

/** Reports a startup failure on stderr as one coded JSON line; the exit status is 1. */
function fail(error: unknown): number {
  const body = isRail402Error(error)
    ? {
        code: error.code,
        reason: error.reason,
        ...(error.details === undefined ? {} : { details: error.details }),
      }
    : {
        code: "tool_internal_error",
        reason: redact(error instanceof Error ? error.message : String(error)) || "Startup failed.",
      };
  process.stderr.write(
    `${JSON.stringify({ level: "fatal", msg: "rail402-mcp could not start", error: body })}\n`,
  );
  return 1;
}
