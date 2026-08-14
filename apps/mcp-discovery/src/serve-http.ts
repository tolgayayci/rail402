import { serve } from "@hono/node-server";
import { createHttpApp } from "./http.js";
import type { McpConfig } from "./server.js";

/**
 * Hosted HTTP entrypoint (Railway). Distinct from `index.ts`, which is the stdio entrypoint an agent
 * runtime spawns as a subprocess. Both build the same two tools from the same `createMcpServer`.
 *
 * Diagnostics go to stdout here (unlike stdio, where stdout IS the protocol channel) so Railway's log
 * viewer shows startup and the bound port.
 */

const config: McpConfig = {
  // Points at the live Bazaar by default so a bare deploy is useful; override for local runs.
  bazaarUrl: process.env.BAZAAR_URL ?? "https://facilitator.rail402.dev",
  ...(process.env.CLIENT_STELLAR_PRIVATE_KEY
    ? { stellarSecret: process.env.CLIENT_STELLAR_PRIVATE_KEY }
    : {}),
  network: process.env.STELLAR_NETWORK ?? "stellar:testnet",
  ...(process.env.MAX_AMOUNT_CEILING ? { maxAmountCeiling: process.env.MAX_AMOUNT_CEILING } : {}),
  // NEVER true on a hosted deployment. `pay_and_call` fetches caller-supplied URLs and returns the
  // body; permitting loopback/private hosts on a public server is an SSRF pivot. The stdio entry opts
  // in for localhost sellers; this one is hardwired off and does not read MCP_ALLOW_PRIVATE_HOSTS.
  allowPrivateHosts: false,
};

const port = Number(process.env.PORT ?? 8080);
const app = createHttpApp(config);

serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, info => {
  console.log(
    `x402-stellar MCP discovery server (streamable-http) on :${info.port} ` +
      `(bazaar: ${config.bazaarUrl}, network: ${config.network}, ` +
      `paying: ${config.stellarSecret ? "enabled" : "search-only (no signer configured)"})`,
  );
});
