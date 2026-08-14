import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { callMcpTool } from "./mcp-call.js";

/**
 * The spend cap on the MCP TRANSPORT, bound by a real 402 round-trip.
 *
 * The HTTP path's budget guarantee is covered by the two-faced-server test in mcp.test.ts; the MCP
 * path's was covered only by the nightly canary — a live settlement that does not run in CI. This is
 * the CI gate for it. It stands up a real MCP seller whose one tool always answers with an x402
 * `402` priced ABOVE the caller's ceiling, points the real `callMcpTool` at it, and asserts the cap
 * refuses it with `mcp_budget_exceeded` before anything is signed.
 *
 * No facilitator is involved on purpose: an over-budget challenge is refused by the payment selector
 * BEFORE a payload is created, so settlement never happens and none needs mocking. The 402 is the
 * exact shape `@x402/mcp`'s `createPaymentRequiredResult` returns — a tool result whose
 * `structuredContent` carries `{ x402Version, accepts }` with `isError: true` — so the test cannot
 * pass against a wire shape the real client would not recognise.
 */

const USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const PAY_TO = "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO";
// A valid (checksummed) testnet secret — the same one mcp.test.ts uses for the MCP path. `callMcpTool`
// builds a signer from it up front; the signer is never used to sign here because the budget refuses
// first, but the secret must parse.
const CLIENT_SECRET = "SCPFSWCB5PUBF2XKCAJBSWRTOPSBM4Z3TLDSP2OOFNAUOFHP6XSQAM3O";
const TOOL = "harbour_tides";

/** A seller whose one tool always answers 402 at `amount`, served statelessly over HTTP. */
function startSeller(amount: string): Promise<{ url: string; close: () => Promise<void> }> {
  // x402 v2 PaymentRequirements: exactly the fields the core schema requires (verified against
  // @x402/core/schemas PaymentRequirementsV2Schema — extra per-accept fields make parsePaymentRequired
  // reject the whole challenge, which is how the client silently ignores a malformed 402).
  const accepts = [
    {
      scheme: "exact",
      network: "stellar:testnet",
      amount,
      asset: USDC_SAC,
      payTo: PAY_TO,
      maxTimeoutSeconds: 60,
      extra: { areFeesSponsored: true },
    },
  ];

  const build = (): McpServer => {
    const mcp = new McpServer({ name: "budget-test-seller", version: "0.1.0" });
    mcp.registerTool(
      TOOL,
      { title: "Harbour tides", description: "Paid tide predictions.", inputSchema: { harbour: z.string().optional() } },
      // Always answer with a payment-required result — the exact shape createPaymentRequiredResult
      // returns, and one the core `parsePaymentRequired` schema accepts (top-level `resource` is an
      // OBJECT, not a URL string), so the client recognises it and runs the budget-enforcing selector.
      // Not a shortcut: this is a genuine challenge on the wire. The client parses it from the content
      // text block, so structuredContent being dropped for a schema-less tool does not matter.
      () => {
        const paymentRequired = {
          x402Version: 2,
          resource: {
            url: "https://seller.test/harbour",
            description: "Tide predictions for a named harbour.",
            mimeType: "application/json",
          },
          accepts,
        };
        return {
          structuredContent: paymentRequired,
          content: [{ type: "text" as const, text: JSON.stringify(paymentRequired) }],
          isError: true,
        };
      },
    );
    return mcp;
  };

  return new Promise(resolve => {
    const server: Server = createServer((req, res) => {
      void (async () => {
        // Stateless: a fresh server + transport per request (a server binds to one transport).
        const transport = new StreamableHTTPServerTransport({});
        const mcp = build();
        res.on("close", () => void transport.close());
        try {
          await mcp.connect(transport as unknown as Parameters<typeof mcp.connect>[0]);
          let body: unknown;
          if (req.method === "POST") {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(chunk as Buffer);
            const raw = Buffer.concat(chunks).toString("utf8");
            body = raw.length > 0 ? JSON.parse(raw) : undefined;
          }
          await transport.handleRequest(req, res, body);
        } catch {
          if (!res.headersSent) res.writeHead(500).end();
        }
      })();
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        close: () => new Promise<void>(done => server.close(() => done())),
      });
    });
  });
}

describe("MCP-transport spend cap", () => {
  let seller: { url: string; close: () => Promise<void> } | undefined;
  afterEach(async () => {
    await seller?.close();
    seller = undefined;
  });

  it("refuses an over-budget MCP tool call with a coded error and signs nothing", async () => {
    seller = await startSeller("5000000"); // 0.50 USDC quoted
    const result = await callMcpTool({
      resource: seller.url,
      toolName: TOOL,
      budget: "1000000", // 0.10 USDC ceiling — below the quote
      network: "stellar:testnet",
      stellarSecret: CLIENT_SECRET,
      allowPrivateHosts: true, // the seller is on 127.0.0.1
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("mcp_budget_exceeded");
    expect(result.error?.retryable).toBe(false);
    // The refusal must carry the REAL numbers, not a guess: the price the server quoted and the
    // ceiling that rejected it (a numeric field once published a placeholder string).
    expect(result.error?.details?.["price"]).toBe("5000000");
    expect(result.error?.details?.["maxAmount"]).toBe("1000000");
    expect(result.error?.details?.["toolName"]).toBe(TOOL);
    // No settlement field anywhere — nothing was signed or paid.
    expect(JSON.stringify(result)).not.toContain("transaction");
  });

  it("passes the budget gate when the quote is within the ceiling (then stops at settlement, not the cap)", async () => {
    // The mirror image: a within-budget quote must NOT be refused by the cap. Payment then fails at
    // settlement (there is no facilitator), which surfaces as mcp_upstream_error — the point is only
    // that the refusal is NOT mcp_budget_exceeded, i.e. the cap let an affordable price through.
    seller = await startSeller("500000"); // 0.05 USDC — under the 0.10 ceiling
    const result = await callMcpTool({
      resource: seller.url,
      toolName: TOOL,
      budget: "1000000",
      network: "stellar:testnet",
      stellarSecret: CLIENT_SECRET,
      allowPrivateHosts: true,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).not.toBe("mcp_budget_exceeded");
  });
});
