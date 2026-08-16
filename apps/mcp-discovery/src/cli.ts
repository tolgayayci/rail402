#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { serve } from "@hono/node-server";
import { createMcpServer, type McpConfig } from "./server.js";
import { createHttpApp } from "./http.js";

/**
 * `rail402-mcp` — the published entry point for the Stellar Bazaar MCP discovery server.
 *
 * Defaults to **stdio**, which is how an agent runtime (Claude Desktop, an MCP client) launches a
 * server: it spawns this process and speaks JSON-RPC over stdin/stdout. `--http` starts the hosted
 * Streamable-HTTP transport instead. Both modes build the SAME two tools from the SAME
 * `createMcpServer` / `createHttpApp` factories that `index.ts` and `serve-http.ts` use, so this bin
 * adds a front door without changing any existing behaviour.
 *
 * In stdio mode nothing is written to stdout — stdout IS the protocol channel, so a stray log would
 * corrupt the JSON-RPC stream. Diagnostics go to stderr.
 */

const VERSION = "0.1.0";

const HELP = `rail402-mcp — Stellar Bazaar MCP discovery server (search + budget-capped paid calls)

Usage:
  rail402-mcp [options]            start on stdio (default; how agent runtimes launch it)
  rail402-mcp --http [options]     start the hosted Streamable-HTTP transport instead

Options:
  --http                 Serve over HTTP (Streamable HTTP) instead of stdio.
  --port <n>             HTTP port (with --http; default 8080, or $PORT).
  --bazaar <url>         Bazaar/facilitator base URL (default https://facilitator.rail402.dev, or $BAZAAR_URL).
  --network <caip2>      Network (default stellar:testnet, or $STELLAR_NETWORK).
  --secret <S…>          Stellar secret so pay_and_call can pay (or $CLIENT_STELLAR_PRIVATE_KEY).
                         Omit for a search-only server.
  --max-ceiling <atomic> Absolute spend ceiling the server enforces regardless of the agent's cap
                         (or $MAX_AMOUNT_CEILING).
  --allow-private-hosts  Permit pay_and_call to fetch loopback/private hosts (stdio only; NEVER on a
                         public HTTP deployment). Also enabled by $MCP_ALLOW_PRIVATE_HOSTS.
  -h, --help             Show this help.
  -v, --version          Show version.

Testnet-first. Part of Rail402 — https://rail402.dev`;

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("-")) {
    process.stderr.write(`missing value for ${name}\n`);
    process.exit(2);
  }
  return v;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

const args = process.argv.slice(2);

if (hasFlag(args, "-h") || hasFlag(args, "--help")) {
  process.stdout.write(HELP + "\n");
  process.exit(0);
}
if (hasFlag(args, "-v") || hasFlag(args, "--version")) {
  process.stdout.write(VERSION + "\n");
  process.exit(0);
}

const truthy = (v: string | undefined): boolean =>
  ["1", "true", "yes", "on"].includes((v ?? "").toLowerCase());

const http = hasFlag(args, "--http");

const bazaarUrl = flagValue(args, "--bazaar") ?? process.env.BAZAAR_URL ?? "https://facilitator.rail402.dev";
const network = flagValue(args, "--network") ?? process.env.STELLAR_NETWORK ?? "stellar:testnet";
const stellarSecret = flagValue(args, "--secret") ?? process.env.CLIENT_STELLAR_PRIVATE_KEY;
const maxAmountCeiling = flagValue(args, "--max-ceiling") ?? process.env.MAX_AMOUNT_CEILING;

const config: McpConfig = {
  bazaarUrl,
  network,
  ...(stellarSecret ? { stellarSecret } : {}),
  ...(maxAmountCeiling ? { maxAmountCeiling } : {}),
  // pay_and_call fetches caller-supplied URLs and returns the body. Loopback/private hosts are
  // refused by default. Opt in only for local sellers, and NEVER on a public HTTP deployment — the
  // HTTP transport therefore hardwires this off below regardless of the flag.
  allowPrivateHosts: http ? false : hasFlag(args, "--allow-private-hosts") || truthy(process.env.MCP_ALLOW_PRIVATE_HOSTS),
};

if (http) {
  const port = Number(flagValue(args, "--port") ?? process.env.PORT ?? 8080);
  const app = createHttpApp(config);
  serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, info => {
    // HTTP mode logs to stdout (unlike stdio) so a hosting platform's log viewer shows startup.
    process.stdout.write(
      `rail402-mcp (streamable-http) on :${info.port} ` +
        `(bazaar: ${config.bazaarUrl}, network: ${config.network}, ` +
        `paying: ${config.stellarSecret ? "enabled" : "search-only (no signer configured)"})\n`,
    );
  });
} else {
  const server = createMcpServer(config);
  // stderr only — stdout is the JSON-RPC channel in stdio mode.
  process.stderr.write(
    `rail402-mcp on stdio (bazaar: ${config.bazaarUrl}, network: ${config.network}, ` +
      `paying: ${config.stellarSecret ? "enabled" : "search-only"})\n`,
  );
  await server.connect(new StdioServerTransport());
}
