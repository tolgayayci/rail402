import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { createPaymentWrapper } from "@x402/mcp";
import { describeTool, mcpToolResource } from "@rail402.dev/seller-helpers";
import { z } from "zod";

/**
 * A paid **MCP tool** that catalogs itself in the Bazaar.
 *
 * The other two examples sell an HTTP endpoint. This one sells an MCP tool, which the Bazaar
 * extension treats as a first-class resource type keyed on the pair (endpoint URL, `toolName`)
 * because one MCP endpoint multiplexes many tools.
 *
 * Worth doing well: the largest live Bazaar contains **zero** MCP resources (`type=mcp` returns
 * `total: 0` against 15,332 HTTP entries). The resource
 * type is specified and nobody serves it, so an MCP tool listed here has no competition at all.
 *
 * Everything below the payment wrapper is a completely ordinary MCP server. That is the claim:
 * charging for a tool is a wrapper around the handler, not a rewrite of the service.
 */

const PORT = Number(process.env.PORT ?? 4024);
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "http://localhost:4022";
const NETWORK = (process.env.STELLAR_NETWORK ?? "stellar:testnet") as `${string}:${string}`;
const PAY_TO = process.env.SELLER_ADDRESS;
const ASSET = process.env.PAYMENT_ASSET;
const AMOUNT = process.env.PAYMENT_AMOUNT ?? "2500000";
/**
 * The address an agent connects to — and the first half of this resource's catalog identity.
 *
 * Must be the URL a buyer can actually reach, which behind a proxy or a tunnel is not
 * `http://localhost:PORT`. Override it there, or the listing will name an address only this machine
 * can resolve.
 */
const PUBLIC_URL = process.env.PUBLIC_MCP_URL ?? `http://localhost:${PORT}/mcp`;

if (!PAY_TO || !ASSET) {
  console.error("SELLER_ADDRESS and PAYMENT_ASSET are required");
  process.exit(1);
}

const TOOL_NAME = "harbour_tides";

const x402Server = new x402ResourceServer([new HTTPFacilitatorClient({ url: FACILITATOR_URL })]);
x402Server.register("stellar:*", new ExactStellarScheme());
// Fetch the facilitator's supported kinds first. `buildPaymentRequirements` refuses to price a
// scheme/network pair it has not been told the facilitator serves; `paymentMiddleware` does this
// for you on the HTTP path, and building requirements by hand does not.
await x402Server.initialize();

// Ask the facilitator what a payment for this price on this network has to look like, rather than
// assembling `PaymentRequirements` by hand. Stellar `exact` carries `extra.areFeesSponsored`, which
// the stock client hard-requires and our Bazaar refuses to catalog a listing without.
const accepts = await x402Server.buildPaymentRequirements({
  scheme: "exact",
  network: NETWORK,
  price: { amount: AMOUNT, asset: ASSET },
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
});

/**
 * The boot-time guard.
 *
 * `@x402/mcp` would otherwise default this resource's URL to `mcp://tool/harbour_tides`, which looks
 * fine and is uncatalogable: `mcp:` is not a WHATWG special scheme, so its origin parses as the
 * string `"null"` and every seller's `harbour_tides` would collapse onto one shared catalog key.
 * `mcpToolResource` throws here, at startup, rather than letting a seller discover it from an
 * `EXTENSION-RESPONSES` header on a payment that has already happened.
 */
const resource = mcpToolResource({
  url: PUBLIC_URL,
  toolName: TOOL_NAME,
  description: "Tide predictions and sea state for a named harbour, updated hourly.",
  mimeType: "application/json",
  serviceName: "Harbour Tides",
  tags: ["tides", "marine", "weather"],
});

const paid = createPaymentWrapper(x402Server, {
  accepts,
  resource,
  // The discovery declaration. Per-parameter descriptions are not decoration: for an MCP resource
  // they are the whole interface an agent has to work from, and the primary thing search ranks on.
  extensions: describeTool({
    toolName: TOOL_NAME,
    description: "Predicts high and low water times and sea state for a named harbour or coastal station.",
    transport: "streamable-http",
    params: {
      harbour: {
        description: "Name of the harbour or coastal station to forecast, such as Dover or Halifax.",
        example: "Dover",
      },
      hours: {
        description: "How many hours ahead to forecast. Defaults to 24.",
        type: "integer",
        required: false,
        example: 24,
      },
    },
    outputExample: { harbour: "Dover", highWater: "13:42Z", heightMetres: 6.1, seaState: "slight" },
  }),
});

/**
 * A fresh server per request, paired with a stateless transport.
 *
 * Stateless is the right shape for a paid tool — there is no conversation to keep, and a session
 * store is one more thing to operate — but it has a consequence worth stating: an `McpServer`
 * connects to exactly one transport, so a new transport per request needs a new server per request.
 * Reusing one transport across requests fails with "Server not initialized", because each POST
 * arrives without the handshake the previous one completed.
 */
function buildServer(): McpServer {
  const mcp = new McpServer({ name: "harbour-tides", version: "0.1.0" });

  mcp.registerTool(
    TOOL_NAME,
    {
      title: "Harbour tides",
      description: "Tide predictions and sea state for a named harbour. Paid.",
      inputSchema: { harbour: z.string(), hours: z.number().int().optional() },
    },
    // The only x402-aware line in the handler. Everything inside it is an ordinary MCP tool: by the
    // time it runs, payment has been verified — and it settles after the handler returns, so a tool
    // that throws does not charge anybody.
    // `| undefined` spelled out because this package compiles with `exactOptionalPropertyTypes`,
    // under which an optional property and a possibly-undefined one are different types.
    paid(async (args: { harbour?: string | undefined; hours?: number | undefined }) => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            harbour: args.harbour ?? "Dover",
            hours: args.hours ?? 24,
            highWater: "13:42Z",
            heightMetres: 6.1,
            seaState: "slight",
            asOf: new Date().toISOString(),
          }),
        },
      ],
    })),
  );
  return mcp;
}

// ── Streamable HTTP transport ────────────────────────────────────────────────
const httpServer = createServer(async (req, res) => {
  if (!req.url?.startsWith("/mcp")) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found", reason: "This server serves MCP at /mcp." }));
    return;
  }

  // OMITTING sessionIdGenerator is the stateless switch. With a generator present the SDK requires
  // a session and rejects every non-initialize request with 400. The SDK's own docs write it as
  // `sessionIdGenerator: undefined`, but its option type declares `sessionIdGenerator?: () => string`
  // with no `| undefined`, so passing it explicitly does not compile under
  // `exactOptionalPropertyTypes` — and omitting the key is the same value.
  const transport = new StreamableHTTPServerTransport({});
  const mcp = buildServer();
  res.on("close", () => void transport.close());

  try {
    // The cast is upstream's, not ours: the SDK's `Transport` declares `onclose?: () => void`
    // while `StreamableHTTPServerTransport` exposes it as `(() => void) | undefined`, and the two
    // cannot both be right under `exactOptionalPropertyTypes`. Nothing about the runtime value is in
    // question. Filed as an interop question rather than fixed by relaxing the flag.
    await mcp.connect(transport as unknown as Parameters<typeof mcp.connect>[0]);
    let body: unknown;
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      body = raw.length > 0 ? JSON.parse(raw) : undefined;
    }
    await transport.handleRequest(req, res, body);
  } catch (error) {
    console.error("[seller] request failed:", error);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
    }
  }
});

httpServer.listen(PORT, () => {
  console.log(`[seller] MCP endpoint  ${PUBLIC_URL}`);
  console.log(`[seller] paid tool     ${TOOL_NAME} · ${AMOUNT} atomic units on ${NETWORK}`);
  console.log(`[seller] catalog key   (${PUBLIC_URL}, ${TOOL_NAME}) — the pair, not the URL alone`);
  console.log(`[seller] discoverable after its first settled payment — no registration step`);
});
