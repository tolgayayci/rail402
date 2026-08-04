import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";

/**
 * stdio entrypoint, which is how agent runtimes launch an MCP server as a subprocess.
 *
 * Nothing is logged to stdout — stdio IS the protocol channel here, and a stray console.log would
 * corrupt the JSON-RPC stream. Diagnostics go to stderr.
 */
const server = createMcpServer({
  bazaarUrl: process.env.BAZAAR_URL ?? "http://localhost:4022",
  ...(process.env.CLIENT_STELLAR_PRIVATE_KEY
    ? { stellarSecret: process.env.CLIENT_STELLAR_PRIVATE_KEY }
    : {}),
  network: process.env.STELLAR_NETWORK ?? "stellar:testnet",
  ...(process.env.MAX_AMOUNT_CEILING ? { maxAmountCeiling: process.env.MAX_AMOUNT_CEILING } : {}),
  // Off unless explicitly enabled. `pay_and_call` fetches caller-supplied URLs and returns the
  // body, so loopback and private hosts are refused by default; local development and the bundled
  // examples run a seller on localhost and opt in. Never set this on a hosted deployment.
  allowPrivateHosts: ["1", "true", "yes", "on"].includes(
    (process.env.MCP_ALLOW_PRIVATE_HOSTS ?? "").toLowerCase(),
  ),
});

console.error(`x402-stellar MCP discovery server on stdio (bazaar: ${process.env.BAZAAR_URL ?? "http://localhost:4022"})`);
await server.connect(new StdioServerTransport());
