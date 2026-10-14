import { parseArgs } from "node:util";
import { localhostAllowedHostnames, localhostAllowedOrigins } from "@modelcontextprotocol/server";
import { paymentError, resolveAgentConfig, type AgentConfig, type PaymentError } from "@rail402.dev/sdk";

/** Environment variable holding the HTTP transport's bearer token; removed from the environment once read. */
export const MCP_TOKEN_ENV = "RAIL402_MCP_TOKEN";
export const DEFAULT_HTTP_PORT = 3402;
/** Largest HTTP request body accepted. */
export const MAX_HTTP_BODY_BYTES = 1_048_576;
/** Shortest bearer token accepted: 32 random bytes in base64 are 43 characters or more. */
const MIN_TOKEN_LENGTH = 43;
const TOKEN = /^[A-Za-z0-9+/=_.~-]+$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export type TransportConfig =
  | { readonly kind: "stdio" }
  | {
      readonly kind: "http";
      readonly host: string;
      readonly port: number;
      /** Undefined only for a search-only server; a server that can pay always has a token. */
      readonly token: string | undefined;
      /** Host header names accepted (DNS rebinding protection). */
      readonly allowedHosts: readonly string[];
      /** Origin host names accepted from browsers; requests without Origin pass. */
      readonly allowedOrigins: readonly string[];
    };

export interface McpServerConfig {
  readonly agent: AgentConfig;
  readonly transport: TransportConfig;
}

export type McpCommand =
  | { readonly kind: "serve"; readonly config: McpServerConfig }
  | { readonly kind: "help" }
  | { readonly kind: "version" };

export const USAGE = `Usage: rail402-mcp [--http [--host 127.0.0.1] [--port ${String(DEFAULT_HTTP_PORT)}]]

An MCP server that searches the Stellar Bazaar and pays x402 resources under a spending cap.
Serves stdio by default; --http serves Streamable HTTP on a loopback address.

Configuration comes from the environment:
  RAIL402_NETWORK             stellar:testnet (default) or stellar:pubnet
  RAIL402_SECRET_KEY_FILE     key file (0600) of the paying account; without a key the server only searches
  RAIL402_MAX_PER_CALL        per-call ceiling, e.g. "0.10 USDC" (required on pubnet)
  RAIL402_MAX_TOTAL           budget per session window, e.g. "1.00 USDC" (required on pubnet)
  RAIL402_RPC_URL, RAIL402_BAZAAR_URL   endpoints (required on pubnet)
  RAIL402_MCP_TOKEN           bearer token for --http (required when a key is configured)
  RAIL402_MCP_ALLOWED_ORIGINS browser origins allowed for --http (default: localhost)
Logs go to stderr.
`;

/**
 * Reads the command line and environment. Everything the SDK shares with the CLI is resolved by
 * `resolveAgentConfig`; this adds the transport. The HTTP transport listens on loopback only and
 * needs a bearer token whenever a key is configured. The token is removed from `env` once read.
 */
export function resolveMcpCommand(
  argv: readonly string[],
  env: Record<string, string | undefined>,
): McpCommand {
  let values: { http?: boolean; host?: string; port?: string; help?: boolean; version?: boolean };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        http: { type: "boolean" },
        host: { type: "string" },
        port: { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw invalid("argv", error instanceof Error ? error.message : "unrecognized arguments.");
  }
  const token = env[MCP_TOKEN_ENV];
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete env[MCP_TOKEN_ENV];
  if (values.help === true) return { kind: "help" };
  if (values.version === true) return { kind: "version" };

  const agent = resolveAgentConfig(env);
  if (values.http !== true) {
    if (values.host !== undefined || values.port !== undefined) {
      throw invalid("--http", "--host and --port apply to the HTTP transport; add --http.");
    }
    return { kind: "serve", config: { agent, transport: { kind: "stdio" } } };
  }

  const host = values.host ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) {
    throw invalid(
      "--host",
      "the HTTP transport listens on a loopback address only (127.0.0.1, ::1 or localhost); it serves one operator's key.",
    );
  }
  const portText = values.port ?? String(DEFAULT_HTTP_PORT);
  const port = Number(portText);
  if (!/^[0-9]{1,5}$/.test(portText) || port > 65_535) {
    throw invalid("--port", "the port is an integer from 0 to 65535.");
  }

  const trimmed = token?.trim();
  if (trimmed !== undefined && trimmed !== "") {
    if (trimmed.length < MIN_TOKEN_LENGTH || !TOKEN.test(trimmed)) {
      throw invalid(
        MCP_TOKEN_ENV,
        `the token must be at least ${String(MIN_TOKEN_LENGTH)} characters of random data, e.g. from "openssl rand -base64 32".`,
      );
    }
  } else if (agent.key !== undefined) {
    throw invalid(MCP_TOKEN_ENV, "a server that can pay needs a bearer token for the HTTP transport.");
  }

  const originsText = env["RAIL402_MCP_ALLOWED_ORIGINS"]?.trim();
  const allowedOrigins =
    originsText === undefined || originsText === ""
      ? localhostAllowedOrigins()
      : originsText.split(",").map((item) => originHost(item.trim()));
  return {
    kind: "serve",
    config: {
      agent,
      transport: {
        kind: "http",
        host,
        port,
        token: trimmed === "" ? undefined : trimmed,
        allowedHosts: localhostAllowedHostnames(),
        allowedOrigins,
      },
    },
  };
}

/** An allowed origin as a host name: "https://app.example:8443" and "app.example" both give "app.example". */
function originHost(text: string): string {
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  if (text === "" || !URL.canParse(candidate)) {
    throw invalid("RAIL402_MCP_ALLOWED_ORIGINS", `"${text}" is not an origin or host name.`);
  }
  return new URL(candidate).hostname;
}

function invalid(setting: string, reason: string): PaymentError {
  return paymentError("payment_policy_invalid", {
    reason: `Invalid configuration: ${reason}`,
    details: { setting },
  });
}
