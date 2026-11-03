import { defineCodes, mergeCodes } from "@rail402.dev/errors";
import { agentCodes, defaultPaid, type AgentCode, type Paid } from "@rail402.dev/sdk/discovery";

/** Failures of the MCP tool layer itself, before or around the SDK. */
export const toolCodes = defineCodes({
  tool_input_invalid: {
    status: 400,
    retryable: false,
    reason: "The tool arguments do not match the tool's input schema.",
  },
  tool_rate_limited: {
    status: 429,
    retryable: true,
    reason: "Too many calls of this tool; wait a moment and retry.",
  },
  tool_unknown: { status: 404, retryable: false, reason: "This server has no tool with that name." },
  tool_cancelled: {
    status: 499,
    retryable: false,
    reason: "The call was cancelled before anything was signed; nothing was paid.",
  },
  tool_internal_error: {
    status: 500,
    retryable: false,
    reason: "The server failed unexpectedly; retry a payment only with the same idempotencyKey.",
  },
});

export type ToolCode = keyof typeof toolCodes;

/**
 * JSON-RPC errors of the server, carried as `error.data: { code, reason, retryable, paid }` next to the
 * JSON-RPC code. Nothing is ever paid when one is returned: they answer requests that never reach a tool.
 */
export const rpcCodes = defineCodes({
  rpc_method_unknown: {
    status: 404,
    retryable: false,
    reason: "This server does not serve that MCP method; it serves tools (tools/list and tools/call).",
  },
  rpc_params_invalid: {
    status: 400,
    retryable: false,
    reason: "The request's params do not match the MCP schema of its method.",
  },
  rpc_internal_error: {
    status: 500,
    retryable: false,
    reason: "The server failed to answer the request; nothing was paid.",
  },
  rpc_rate_limited: {
    status: 429,
    retryable: true,
    reason: "Too many requests from this client; wait for the Retry-After time and retry.",
  },
  rpc_overloaded: {
    status: 503,
    retryable: true,
    reason: "The server is answering as many requests as it takes at once; retry shortly.",
  },
  rpc_confirmation_used: {
    status: 409,
    retryable: false,
    reason:
      "This payment confirmation was already answered once; call the tool again to be asked again. Nothing was paid.",
  },
  rpc_confirmation_mismatch: {
    status: 400,
    retryable: false,
    reason:
      "This payment confirmation was given for a different tool call; a confirmation covers only the exact call it was asked for. Nothing was paid.",
  },
  rpc_batch_unsupported: {
    status: 400,
    retryable: false,
    reason: "This endpoint takes one JSON-RPC message per request; send each call as its own request.",
  },
  rpc_upstream_budget: {
    status: 503,
    retryable: true,
    reason:
      "The endpoint has used its share of Bazaar requests for this minute; wait for the Retry-After time and retry.",
  },
});

export type RpcCode = keyof typeof rpcCodes;

/** The codes a JSON-RPC error carries: the server's own, and `tool_unknown` for a tool it does not serve. */
export type RpcErrorCode = RpcCode | "tool_unknown";

/** A JSON-RPC error's `data`: the fields of a tool result's error, with nothing paid. */
export function rpcErrorData(
  code: RpcErrorCode,
  reason: string,
): {
  readonly code: RpcErrorCode;
  readonly reason: string;
  readonly retryable: boolean;
  readonly paid: "none";
} {
  const spec = code === "tool_unknown" ? toolCodes.tool_unknown : rpcCodes[code];
  return { code, reason, retryable: spec.retryable, paid: "none" };
}

/** Every code a rail402-mcp tool result can carry: the SDK's codes and the tool layer's. */
export const mcpServerCodes = mergeCodes(agentCodes, toolCodes);

export type McpServerCode = keyof typeof mcpServerCodes;

const TOOL_PAID: Readonly<Record<ToolCode, Paid>> = {
  tool_input_invalid: "none",
  tool_rate_limited: "none",
  tool_unknown: "none",
  tool_cancelled: "none",
  // An unexpected failure during a payment cannot rule out that money moved.
  tool_internal_error: "unknown",
};

/** The `paid` value a code carries unless the error states otherwise. */
export function defaultPaidFor(code: McpServerCode): Paid {
  return Object.hasOwn(TOOL_PAID, code) ? TOOL_PAID[code as ToolCode] : defaultPaid[code as AgentCode];
}

export function isMcpServerCode(value: unknown): value is McpServerCode {
  return typeof value === "string" && Object.hasOwn(mcpServerCodes, value);
}
