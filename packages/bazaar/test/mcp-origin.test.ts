import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ProtocolError } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  paymentRequiredFor,
  paymentRequiredFromError,
  paymentRequiredFromResult,
  probeMcpTool,
} from "@rail402.dev/bazaar";

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? undefined : (JSON.parse(text) as unknown);
}

/** An MCP seller on loopback: stateless Streamable HTTP, one paid tool and one free tool. */
describe("MCP origin checks", () => {
  const required = paymentRequiredFor({ url: "https://api.example.com/mcp", kind: "mcp" });
  const calls: { name: string; arguments: unknown }[] = [];
  let server: Server;
  let endpoint: string;

  beforeAll(async () => {
    server = createServer((request, response) => {
      void (async () => {
        const mcp = new McpServer({ name: "seller", version: "1.0.0" }, { capabilities: { tools: {} } });
        mcp.server.setRequestHandler(ListToolsRequestSchema, () => ({
          tools: [
            { name: "forecast", inputSchema: { type: "object" } },
            { name: "free", inputSchema: { type: "object" } },
          ],
        }));
        mcp.server.setRequestHandler(CallToolRequestSchema, (call) => {
          calls.push({ name: call.params.name, arguments: call.params.arguments });
          if (call.params.name === "forecast") {
            return {
              isError: true,
              structuredContent: required as unknown as Record<string, unknown>,
              content: [{ type: "text", text: JSON.stringify(required) }],
            };
          }
          return { content: [{ type: "text", text: "sunny" }] };
        });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        response.on("close", () => {
          void transport.close();
          void mcp.close();
        });
        await mcp.connect(transport);
        const body = request.method === "POST" ? await readJson(request) : undefined;
        await transport.handleRequest(request, response, body);
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    endpoint = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    calls.length = 0;
  });

  it("reads a tool's PaymentRequired from its unpaid call, sending the example arguments", async () => {
    const response = await probeMcpTool(
      endpoint,
      { toolName: "forecast", arguments: { city: "Istanbul" } },
      { allowLoopback: true },
    );
    expect(response).toEqual({ kind: "payment_required", paymentRequired: required });
    expect(calls).toEqual([{ name: "forecast", arguments: { city: "Istanbul" } }]);
  });

  it("reports a tool the server does not declare, without calling it", async () => {
    expect(await probeMcpTool(endpoint, { toolName: "history" }, { allowLoopback: true })).toEqual({
      kind: "tool_not_listed",
    });
    expect(calls).toEqual([]);
  });

  it("reports a tool that answers an unpaid call without asking for payment", async () => {
    expect(await probeMcpTool(endpoint, { toolName: "free" }, { allowLoopback: true })).toEqual({
      kind: "not_payment_required",
      status: 200,
    });
  });

  it("never reaches a loopback server unless loopback is allowed", async () => {
    const response = await probeMcpTool(endpoint, { toolName: "forecast" });
    expect(response.kind).toBe("unreachable");
    expect(calls).toEqual([]);
  });

  it("reports a server that does not speak MCP as unreachable, so the check is retried", async () => {
    const plain = createServer((_request, response) => response.writeHead(404).end());
    await new Promise<void>((resolve) => plain.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${String((plain.address() as AddressInfo).port)}/mcp`;
      const response = await probeMcpTool(url, { toolName: "forecast" }, { allowLoopback: true });
      expect(response).toMatchObject({ kind: "unreachable" });
      expect((response as { reason: string }).reason).not.toBe("");
    } finally {
      await new Promise((resolve) => plain.close(resolve));
    }
  });

  it("refuses URLs that are not http(s) and oversized arguments before connecting", async () => {
    expect(await probeMcpTool("mcp://tool/forecast", { toolName: "forecast" })).toMatchObject({
      kind: "unreachable",
    });
    const huge = { text: "x".repeat(20_000) };
    expect(
      await probeMcpTool(endpoint, { toolName: "forecast", arguments: huge }, { allowLoopback: true }),
    ).toMatchObject({ kind: "unreachable" });
    expect(calls).toEqual([]);
  });

  it("reads PaymentRequired from a payment-required JSON-RPC error and from a tool result", () => {
    expect(paymentRequiredFromError(new ProtocolError(-32042, "payment required", required))).toEqual(
      required,
    );
    expect(paymentRequiredFromError(new ProtocolError(402, "payment required", { x402: required }))).toEqual(
      required,
    );
    expect(paymentRequiredFromError(new ProtocolError(-32602, "invalid", required))).toBeUndefined();
    expect(
      paymentRequiredFromResult({
        isError: true,
        content: [{ type: "text", text: JSON.stringify(required) }],
      }),
    ).toEqual(required);
    expect(
      paymentRequiredFromResult({ content: [{ type: "text", text: JSON.stringify(required) }] }),
    ).toBeUndefined();
  });
});
