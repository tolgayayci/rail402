/**
 * A stock x402 MCP seller for tests: @modelcontextprotocol/sdk v1 with @x402/mcp's payment wrapper,
 * served over stateless Streamable HTTP, stateful Streamable HTTP or the legacy SSE transport.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import type { PaymentRequirements } from "@x402/core/types";
import { createPaymentWrapper } from "@x402/mcp";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { Networks } from "@stellar/stellar-sdk";
import { z } from "zod";
import { TESTNET } from "@rail402.dev/stellar";
import { paymentEcho } from "@rail402.dev/testkit";

export type McpMode = "stateless" | "stateful" | "sse";

export interface McpSellerOptions {
  readonly mode: McpMode;
  readonly facilitator: FacilitatorClient;
  readonly payTo: string;
  readonly asset: string;
  /** Base units. */
  readonly amount: string;
  /** How long the paid `slow` tool works before answering (default 0). */
  readonly slowMs?: number;
}

export interface McpSeller {
  readonly url: string;
  readonly port: number;
  /** Tool calls the seller received, with whether they carried a payment. */
  readonly calls: { readonly tool: string; readonly paid: boolean }[];
  /** The `_meta["x402/payment"]` payloads the seller received, in order. */
  readonly payments: Record<string, unknown>[];
  close(): Promise<void>;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? undefined : (JSON.parse(text) as unknown);
}

export async function startMcpSeller(options: McpSellerOptions): Promise<McpSeller> {
  const resourceServer = new x402ResourceServer(options.facilitator).register(
    TESTNET,
    new ExactStellarScheme(),
  );
  await resourceServer.initialize();
  const accepts: PaymentRequirements[] = await resourceServer.buildPaymentRequirements({
    scheme: "exact",
    network: TESTNET,
    payTo: options.payTo,
    price: { amount: options.amount, asset: options.asset },
  });
  const calls: McpSeller["calls"] = [];
  const payments: McpSeller["payments"] = [];
  let endpoint = "";

  const build = (): McpServer => {
    const server = new McpServer({ name: "test-seller", version: "1.0.0" });
    const paid = (tool: string) =>
      createPaymentWrapper(resourceServer, {
        accepts,
        resource: { url: endpoint, description: `The ${tool} tool` },
      });
    const record = (tool: string, extra: unknown) => {
      const meta = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta;
      const payment = meta?.["x402/payment"];
      calls.push({ tool, paid: payment !== undefined });
      if (typeof payment === "object" && payment !== null) payments.push(payment as Record<string, unknown>);
    };
    const forecast = paid("forecast")((args: { city: string }) => ({
      content: [{ type: "text" as const, text: `Sunny in ${args.city}` }],
    }));
    server.registerTool(
      "forecast",
      { description: "Weather forecast for a city", inputSchema: { city: z.string() } },
      (args, extra) => {
        record("forecast", extra);
        return forecast(args, extra);
      },
    );
    const slow = paid("slow")(async () => {
      await new Promise((resolve) => setTimeout(resolve, options.slowMs ?? 0));
      return { content: [{ type: "text" as const, text: "done after a while" }] };
    });
    server.registerTool(
      "slow",
      { description: "A paid tool that works a while", inputSchema: {} },
      (args, extra) => {
        record("slow", extra);
        return slow(args, extra);
      },
    );
    const broken = paid("broken")(() => ({
      content: [{ type: "text" as const, text: "the tool failed" }],
      isError: true,
    }));
    server.registerTool(
      "broken",
      { description: "A paid tool that fails", inputSchema: {} },
      (args, extra) => {
        record("broken", extra);
        return broken(args, extra);
      },
    );
    // Answers with the payment it was paid with, in every form a careless seller might echo it.
    server.registerTool(
      "echo-payment",
      { description: "A paid tool that echoes its request", inputSchema: {} },
      (args, extra) => {
        record("echo-payment", extra);
        const payment = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta?.["x402/payment"];
        const echo =
          typeof payment === "object" && payment !== null
            ? paymentEcho(payment as Record<string, unknown>, Networks.TESTNET)
            : {};
        return paid("echo-payment")(() => ({
          content: [
            { type: "text" as const, text: JSON.stringify(echo) },
            { type: "text" as const, text: `paid with ${String(echo["paymentJson"])}` },
          ],
          structuredContent: echo,
        }))(args, extra);
      },
    );
    server.registerTool(
      "echo",
      { description: "A free tool", inputSchema: { text: z.string() } },
      (args, extra) => {
        record("echo", extra);
        return { content: [{ type: "text" as const, text: args.text }] };
      },
    );
    return server;
  };

  const sessions = new Map<string, StreamableHTTPServerTransport>();
  // The legacy SSE transport is deprecated upstream; sellers still serve it, so it is tested on purpose.
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const sse = new Map<string, SSEServerTransport>();

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = new URL(request.url ?? "/", "http://seller").pathname;
    if (options.mode === "sse") {
      if (request.method === "GET" && path === "/mcp") {
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        const transport = new SSEServerTransport("/messages", response);
        sse.set(transport.sessionId, transport);
        response.on("close", () => sse.delete(transport.sessionId));
        await build().connect(transport);
        return;
      }
      if (request.method === "POST" && path === "/messages") {
        const id = new URL(request.url ?? "/", "http://seller").searchParams.get("sessionId") ?? "";
        const transport = sse.get(id);
        if (transport === undefined) {
          response.writeHead(404).end();
          return;
        }
        await transport.handlePostMessage(request, response, await readJson(request));
        return;
      }
      response.writeHead(404).end();
      return;
    }
    if (path !== "/mcp") {
      response.writeHead(404).end();
      return;
    }
    if (options.mode === "stateless") {
      if (request.method !== "POST") {
        response.writeHead(405).end();
        return;
      }
      const server = build();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      response.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(request, response, await readJson(request));
      return;
    }
    const sessionId = request.headers["mcp-session-id"];
    const known = typeof sessionId === "string" ? sessions.get(sessionId) : undefined;
    if (known !== undefined) {
      await known.handleRequest(
        request,
        response,
        request.method === "POST" ? await readJson(request) : undefined,
      );
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(400).end();
      return;
    }
    const body = await readJson(request);
    if (!isInitializeRequest(body)) {
      response.writeHead(400, { "content-type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: no session" },
          id: null,
        }),
      );
      return;
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId !== undefined) sessions.delete(transport.sessionId);
    };
    await build().connect(transport);
    await transport.handleRequest(request, response, body);
  };

  const http: Server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500).end();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  endpoint = `http://127.0.0.1:${String(port)}/mcp`;
  return {
    url: endpoint,
    port,
    calls,
    payments,
    close: async () => {
      for (const transport of sessions.values()) await transport.close();
      for (const transport of sse.values()) await transport.close();
      http.closeAllConnections();
      await new Promise((resolve) => http.close(resolve));
    },
  };
}

/** A facilitator that accepts every payment and reports a settlement, for flow tests without a chain. */
export function acceptingFacilitator(transaction: string): FacilitatorClient {
  return {
    getSupported: () =>
      Promise.resolve({
        kinds: [{ x402Version: 2, scheme: "exact", network: TESTNET, extra: { areFeesSponsored: true } }],
        extensions: [],
        signers: {},
      }),
    verify: () => Promise.resolve({ isValid: true, payer: "" }),
    settle: () => Promise.resolve({ success: true, transaction, network: TESTNET, payer: "" }),
  } as unknown as FacilitatorClient;
}
