import { Hono } from "hono";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer, type McpConfig } from "./server.js";

/**
 * Hosted HTTP transport for the discovery MCP server.
 *
 * The server is stdio-first — that is how an agent runtime launches it as a subprocess, and it stays
 * the primary shape. This adds a second, hosted transport so a reviewer can exercise §3.3's
 * discover -> pay loop against a live URL without cloning the repo, using the MCP Streamable HTTP
 * transport every stock MCP client already speaks.
 *
 * STATELESS by design. Each POST carries its own JSON-RPC request and is answered in full; there is no
 * session to keep, so nothing is stored between requests and any isolate can serve any call. Three
 * traps this file is written around, all found the hard way:
 *
 *  - `sessionIdGenerator: undefined` does not type-check under `exactOptionalPropertyTypes`, and
 *    the SDK's own stateless snippet uses exactly that. We OMIT the key instead — absent means
 *    stateless just the same.
 *  - a stateless server needs a NEW `McpServer` AND a NEW transport per request. One server binds
 *    to one transport; reusing either across requests fails the second call with "Server not
 *    initialized", because that call arrives without the previous initialize handshake.
 *  - `enableJsonResponse` makes each POST return one buffered JSON body rather than an SSE stream,
 *    which is what a stateless request/response wants and what lets us close the pair deterministically
 *    once the body is in hand.
 */

export function createHttpApp(config: McpConfig): Hono {
  const app = new Hono();

  app.get("/health", c =>
    c.json({
      status: "ok",
      service: "x402-stellar-mcp-discovery",
      transport: "streamable-http (stateless)",
      bazaarUrl: config.bazaarUrl,
      network: config.network,
      tools: ["search_stellar_resources", "pay_and_call"],
    }),
  );

  // GET / is a friendly landing so a browser hitting the root does not see a 404 and assume the
  // service is down. The MCP endpoint is POST /mcp.
  app.get("/", c =>
    c.json({
      service: "x402-stellar-mcp-discovery",
      mcpEndpoint: "/mcp",
      health: "/health",
      note: "POST JSON-RPC (MCP Streamable HTTP) to /mcp. stdio remains the primary transport.",
    }),
  );

  // The MCP endpoint. `all` so the transport itself decides what each method means (POST = a
  // JSON-RPC request; GET/DELETE are answered by the transport, which returns 405 in stateless mode
  // since there is no session stream to attach to).
  app.all("/mcp", async c => {
    const server = createMcpServer(config);
    const transport = new WebStandardStreamableHTTPServerTransport({
      // Omitted sessionIdGenerator == stateless. Buffered JSON responses (not SSE) so a
      // single request/response completes and the pair can be closed once we hold the body.
      enableJsonResponse: true,
    });

    await server.connect(transport);
    try {
      const response = await transport.handleRequest(c.req.raw);
      // Buffer the body so closing the transport cannot truncate an in-flight stream. In JSON mode the
      // body is already complete, so this is a copy, not a wait on a long-lived stream.
      const body = await response.arrayBuffer();
      return new Response(body, { status: response.status, headers: response.headers });
    } finally {
      // Per-request lifecycle: release the pair regardless of outcome so nothing accumulates under
      // load. Closing the transport disconnects the server it is bound to.
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });

  return app;
}
