import { describe, expect, it } from "vitest";
import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import {
  MCP_PATH,
  codedProtocolError,
  createHttpHandler,
  createServerFactory,
  rpcCodes,
  type Tools,
} from "@rail402.dev/mcp";

/** One JSON-RPC request to a stateless (2025) server, answered as an SSE message. */
async function rpc(tools: Tools, method: string, params: unknown): Promise<Record<string, unknown>> {
  const handler = createHttpHandler(createServerFactory(tools), {
    token: undefined,
    allowedHosts: ["127.0.0.1"],
    allowedOrigins: ["127.0.0.1"],
  });
  try {
    const response = await handler.fetch(
      new Request(`http://127.0.0.1${MCP_PATH}`, {
        method: "POST",
        headers: {
          host: "127.0.0.1",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }),
      }),
    );
    const text = await response.text();
    const data = /^data: (.*)$/m.exec(text)?.[1];
    if (data === undefined) throw new Error(`no message in ${text}`);
    return JSON.parse(data) as Record<string, unknown>;
  } finally {
    await handler.close();
  }
}

const brokenTools: Tools = {
  get definitions(): Tools["definitions"] {
    throw new Error("definitions unavailable: secret detail");
  },
  has: (name): name is "get_budget" => name === "get_budget",
  call: () => Promise.reject(new Error("unreachable")),
};

describe("JSON-RPC errors", () => {
  it("codes a failure of the server's own handler as an internal error without its message", async () => {
    const answer = await rpc(brokenTools, "tools/list", {});
    expect(answer["error"]).toEqual({
      code: -32603,
      message: "Internal error",
      data: { code: "rpc_internal_error", reason: rpcCodes.rpc_internal_error.reason },
    });
    expect(JSON.stringify(answer)).not.toContain("secret detail");
  });

  it("codes an unknown method and invalid params, with a reason naming the problem", async () => {
    expect((await rpc(brokenTools, "prompts/list", {}))["error"]).toMatchObject({
      code: -32601,
      data: {
        code: "rpc_method_unknown",
        reason: `${rpcCodes.rpc_method_unknown.reason} Unknown method: prompts/list.`,
      },
    });
    expect((await rpc(brokenTools, "tools/call", { name: 42 }))["error"]).toMatchObject({
      code: -32602,
      data: {
        code: "rpc_params_invalid",
        reason: `${rpcCodes.rpc_params_invalid.reason} At params.name: Invalid input: expected string, received number`,
      },
    });
  });

  it("keeps a code an error already carries and maps the rest by their JSON-RPC code", () => {
    const tagged = new ProtocolError(ProtocolErrorCode.InvalidParams, "x", {
      code: "tool_unknown",
      reason: "r",
    });
    expect(codedProtocolError(tagged)).toBe(tagged);
    expect(codedProtocolError(new ProtocolError(ProtocolErrorCode.InternalError, "boom"))).toMatchObject({
      code: -32603,
      data: { code: "rpc_internal_error", reason: rpcCodes.rpc_internal_error.reason },
    });
    expect(
      codedProtocolError(new ProtocolError(ProtocolErrorCode.InvalidParams, "bad", { envelope: { k: 1 } })),
    ).toMatchObject({ code: -32602, data: { envelope: { k: 1 }, code: "rpc_params_invalid" } });
    expect(codedProtocolError(new Error("plain"))).toMatchObject({
      code: -32602,
      data: { code: "rpc_params_invalid", reason: `${rpcCodes.rpc_params_invalid.reason} plain` },
    });
  });
});
