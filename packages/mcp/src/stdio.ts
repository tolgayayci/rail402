import { serveStdio, StdioServerTransport, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import type { McpServerFactory } from "@modelcontextprotocol/server";
import { silentLogger, type Logger } from "./logger.ts";

/** Largest single stdio message accepted. */
export const MAX_STDIO_MESSAGE_BYTES = 1_048_576;

/**
 * Serves MCP over this process's stdin and stdout, for 2026 and 2025 clients alike (the opening
 * exchange picks the protocol era for the connection). stdout carries protocol messages only.
 */
export function startStdioTransport(
  factory: McpServerFactory,
  options: { readonly logger?: Logger } = {},
): StdioServerHandle {
  const logger = options.logger ?? silentLogger;
  const transport = new StdioServerTransport(process.stdin, process.stdout, {
    maxBufferSize: MAX_STDIO_MESSAGE_BYTES,
  });
  return serveStdio(factory, {
    legacy: "serve",
    transport,
    onerror: (error) => {
      logger.debug("mcp transport error", { error: error.message });
    },
  });
}
