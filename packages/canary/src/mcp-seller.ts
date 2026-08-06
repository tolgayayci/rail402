import { createServer, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { createPaymentWrapper } from "@x402/mcp";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { z } from "zod";

/**
 * A synthetic seller that sells an **MCP tool** rather than an HTTP endpoint.
 *
 * Stock parts only, like the HTTP synthetic seller: the stock `x402ResourceServer`, the stock
 * `@x402/stellar` server scheme, `createPaymentWrapper` from `@x402/mcp` and
 * `declareDiscoveryExtension` exactly as published. Nothing in this file is ours, on purpose — a
 * canary built from our own seller helpers would prove that our code agrees with our code.
 *
 * The resource URL is the **http endpoint**, not `mcp://tool/<name>`. That is not a style choice:
 * `mcp:` is not a WHATWG special scheme, so its origin parses as the string `"null"` and the spec's
 * origin+path catalog key would collapse to a key every seller shares. The facilitator refuses it
 * with a reason that says so; this seller does the right thing so the canary measures the loop
 * rather than the rejection.
 */

/** Natural-language query the canary searches for. Shares no token with the tool name, on purpose. */
export const MCP_QUERY = "tide times and sea conditions at a coastal port";
export const MCP_TOOL_NAME = "harbour_tides";
export const MCP_PARAMETER_DESCRIPTION =
  "Name of the harbour or coastal station to forecast, such as Dover or Halifax.";

export interface SyntheticMcpSeller {
  /** The MCP endpoint URL — the first half of this resource's catalog identity. */
  readonly endpointUrl: string;
  /** Catalog key form. MCP resources are keyed on the PAIR, so this alone is not the identity. */
  readonly catalogKey: string;
  readonly toolName: string;
  close(): Promise<void>;
}

export interface McpSellerOptions {
  readonly facilitatorUrl: string;
  readonly network: string;
  readonly payTo: string;
  readonly asset: string;
  readonly amount: string;
  /** Unique per run so repeated runs never contend for one catalog key. */
  readonly runId: string;
}

export async function startSyntheticMcpSeller(options: McpSellerOptions): Promise<SyntheticMcpSeller> {
  const x402Server = new x402ResourceServer([new HTTPFacilitatorClient({ url: options.facilitatorUrl })]);
  x402Server.register("stellar:*", new ExactStellarScheme());
  // Fetch the facilitator's supported kinds before pricing anything. `buildPaymentRequirements`
  // refuses to price a scheme/network pair it has not been told the facilitator serves — the HTTP
  // middleware does this for you, and building requirements by hand does not.
  await x402Server.initialize();

  const accepts = await x402Server.buildPaymentRequirements({
    scheme: "exact",
    network: options.network as `${string}:${string}`,
    price: { amount: options.amount, asset: options.asset },
    payTo: options.payTo,
    maxTimeoutSeconds: 60,
  });

  const server: Server = await new Promise(resolve => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("the synthetic MCP seller did not bind a TCP port");
  }
  // The path carries runId for the same reason the HTTP seller's does: a listing is owned by the
  // payTo that settled it, so two runs sharing a key would collide on ownership and the second
  // would be refused — correctly, but it would read as a canary failure rather than the
  // anti-spoofing control working.
  const path = `/mcp/${options.runId}`;
  const endpointUrl = `http://127.0.0.1:${address.port}${path}`;

  const paid = createPaymentWrapper(x402Server, {
    accepts,
    resource: {
      url: endpointUrl,
      description: "Tide predictions and sea state for a named harbour, updated hourly.",
      mimeType: "application/json",
      serviceName: "Harbour Tides",
      tags: ["tides", "marine", "weather"],
    },
    extensions: declareDiscoveryExtension({
      toolName: MCP_TOOL_NAME,
      description: "Predicts high and low water times and sea state for a named harbour or coastal station.",
      transport: "streamable-http",
      inputSchema: {
        type: "object",
        properties: {
          harbour: { type: "string", description: MCP_PARAMETER_DESCRIPTION },
        },
        required: ["harbour"],
      },
      example: { harbour: "Dover" },
      output: { example: { harbour: "Dover", highWater: "13:42Z", heightMetres: 6.1 } },
    }),
  });

  // A fresh server per request, paired with a stateless transport.
  //
  // Stateless is the right shape for a paid tool — there is no conversation to keep, and a session
  // store is one more thing an operator has to run — but it has a consequence worth stating: an
  // `McpServer` connects to exactly one transport, so a new transport per request needs a new
  // server per request. Reusing one server across transports fails, and reusing one transport
  // across requests fails differently ("Server not initialized"), because each POST arrives without
  // the handshake the previous one completed.
  const buildServer = (): McpServer => {
    const mcp = new McpServer({ name: "harbour-tides-canary", version: "0.1.0" });
    mcp.registerTool(
      MCP_TOOL_NAME,
      {
        title: "Harbour tides",
        description: "Tide predictions and sea state for a named harbour. Paid.",
        inputSchema: { harbour: z.string() },
      },
      paid(async (args: { harbour?: string | undefined }) => ({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              harbour: args.harbour ?? "Dover",
              highWater: "13:42Z",
              heightMetres: 6.1,
            }),
          },
        ],
      })),
    );
    return mcp;
  };

  server.on("request", (req, res) => {
    void (async () => {
      if (!req.url?.startsWith(path)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      // OMITTING sessionIdGenerator is the stateless switch. With a generator present the SDK
      // requires a session and rejects every non-initialize request with 400. The SDK's own docs
      // write it as `sessionIdGenerator: undefined`, but its option type declares
      // `sessionIdGenerator?: () => string` with no `| undefined`, so passing it explicitly does not
      // compile under `exactOptionalPropertyTypes` — and omitting the key is the same value.
      const transport = new StreamableHTTPServerTransport({});
      const mcp = buildServer();
      res.on("close", () => void transport.close());
      try {
        // The SDK's `Transport` declares `onclose?: () => void` while the concrete transport exposes
        // `(() => void) | undefined`; under `exactOptionalPropertyTypes` those are different types.
        // Upstream's declaration mismatch, not a runtime question.
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
        console.error("[canary mcp seller] request failed:", error);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "internal error" }));
        }
      }
    })();
  });

  return {
    endpointUrl,
    catalogKey: endpointUrl,
    toolName: MCP_TOOL_NAME,
    close: () =>
      new Promise<void>(resolve => {
        server.close(() => resolve());
      }),
  };
}
