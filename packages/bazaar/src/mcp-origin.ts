import {
  Client,
  ProtocolError,
  SSEClientTransport,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type FetchLike,
  type JsonSchemaValidator,
  type jsonSchemaValidator,
} from "@modelcontextprotocol/client";
import type { PaymentRequired } from "@x402/core/types";
import { createSafeFetch, effectivePort, type SafeFetch } from "@rail402.dev/safe-fetch";
import type { OriginResponse } from "./origin.ts";

/** The tool an MCP origin check asks the seller's server about. */
export interface McpToolProbe {
  readonly toolName: string;
  /** `streamable-http` (the default) or `sse`, as the listing's `info.input.transport` declares. */
  readonly transport?: string;
  /** Arguments of the unpaid call: the listing's `info.input.example`, so argument validation passes. */
  readonly arguments?: Readonly<Record<string, unknown>>;
}

export interface McpOriginOptions {
  /** Bound on the whole check: connecting, listing the tools and the unpaid call. */
  readonly timeoutMs?: number;
  /** Allow loopback endpoints (conformance runs on a local network only). */
  readonly allowLoopback?: boolean;
}

const USER_AGENT = "rail402-bazaar-origin-check/1 (+https://rail402.dev)";
const CLIENT_INFO = { name: "rail402-bazaar-origin-check", version: "1" };
/** JSON-RPC codes sellers use to signal payment required: SEP-1036's -32042, and the older 402. */
const PAYMENT_REQUIRED_ERROR_CODES = new Set([-32042, 402]);
/** `tools/list` pages read before the tool counts as not listed. */
const MAX_TOOL_PAGES = 10;
const MAX_ARGUMENTS_BYTES = 16_384;
const MAX_PAYMENT_REQUIRED_BYTES = 65_536;

/** Seller output schemas are never compiled: the check reads a 402, never a tool's output. */
const noValidation: jsonSchemaValidator = {
  getValidator<T>(): JsonSchemaValidator<T> {
    return (input) => ({ valid: true, data: input as T, errorMessage: undefined });
  },
};

/**
 * Asks an MCP server whether it sells a tool: connects over MCP Streamable HTTP (or SSE), checks that
 * `tools/list` declares the tool, and makes one unpaid `tools/call` whose answer must be the x402
 * PaymentRequired. Never pays.
 *
 * Every request goes through safe-fetch: public addresses only (checked in the connection's own
 * lookup), no redirects, bounded sizes and times. The result is `tool_not_listed` when the server does
 * not declare the tool, `not_payment_required` when the unpaid call returned a result, and
 * `unreachable` when the server could not be spoken to (retried like an HTTP origin).
 */
export async function probeMcpTool(
  endpoint: string,
  tool: McpToolProbe,
  options: McpOriginOptions = {},
): Promise<OriginResponse> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { kind: "unreachable", reason: "invalid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { kind: "unreachable", reason: `unsupported scheme ${url.protocol}` };
  }
  const args = tool.arguments ?? {};
  if (Buffer.byteLength(JSON.stringify(args)) > MAX_ARGUMENTS_BYTES) {
    return { kind: "unreachable", reason: "the listing's example arguments are too large to send" };
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  const signal = AbortSignal.timeout(timeoutMs);
  const fetch = createSafeFetch({
    schemes: ["https:", "http:"],
    // The seller's own endpoint: its own port is allowed.
    ports: [...new Set([443, 80, effectivePort(url)])],
    allowPrivateNetwork: options.allowLoopback === true ? "loopback" : false,
    userAgent: USER_AGENT,
    limits: { responseBodyBytes: 262_144 },
    timeouts: { connectMs: 3_000, headersMs: 5_000, idleMs: 5_000, totalMs: timeoutMs },
  });
  const fetchLike = mcpFetch(fetch);
  const transport =
    tool.transport === "sse"
      ? // Deprecated upstream in favour of Streamable HTTP, but still how SSE-only sellers are reached.
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        new SSEClientTransport(url, { fetch: fetchLike })
      : new StreamableHTTPClientTransport(url, {
          fetch: fetchLike,
          reconnectionOptions: {
            maxRetries: 0,
            initialReconnectionDelay: 1_000,
            maxReconnectionDelay: 1_000,
            reconnectionDelayGrowFactor: 1,
          },
        });
  const client = new Client(CLIENT_INFO, {
    capabilities: {},
    jsonSchemaValidator: noValidation,
    versionNegotiation: { mode: "auto" },
    inputRequired: { autoFulfill: false },
    listMaxPages: MAX_TOOL_PAGES,
  });
  try {
    await client.connect(transport, { timeout: timeoutMs, signal });
    const { tools } = await client.listTools(undefined, { timeout: timeoutMs, signal });
    if (!tools.some((declared) => declared.name === tool.toolName)) return { kind: "tool_not_listed" };
    let result: CallToolResult;
    try {
      result = await client.callTool(
        { name: tool.toolName, arguments: { ...args } },
        { timeout: timeoutMs, signal },
      );
    } catch (error) {
      const required = paymentRequiredFromError(error);
      if (required !== undefined) return { kind: "payment_required", paymentRequired: required };
      if (error instanceof ProtocolError && /not found|unknown tool/i.test(error.message)) {
        return { kind: "tool_not_listed" };
      }
      throw error;
    }
    const required = paymentRequiredFromResult(result);
    if (required !== undefined) return { kind: "payment_required", paymentRequired: required };
    // A result without payment: the tool is free, or refused the call for another reason.
    return { kind: "not_payment_required", status: 200 };
  } catch (error) {
    return { kind: "unreachable", reason: failure(error) };
  } finally {
    await client.close().catch(() => undefined);
    fetch.close();
  }
}

/** Adapts safe-fetch to the MCP client's fetch: string bodies only, redirects refused. */
function mcpFetch(fetch: SafeFetch): FetchLike {
  return (target, init) => {
    const body = init?.body;
    if (body !== undefined && body !== null && typeof body !== "string") {
      return Promise.reject(new TypeError("MCP requests carry JSON text bodies only"));
    }
    return fetch(target, {
      ...(init?.method === undefined ? {} : { method: init.method }),
      ...(init?.headers === undefined ? {} : { headers: init.headers }),
      body: body ?? null,
      ...(init?.signal === undefined || init.signal === null ? {} : { signal: init.signal }),
      redirect: "error",
    });
  };
}

function isPaymentRequired(value: unknown): value is PaymentRequired {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "x402Version" in value &&
    Array.isArray((value as { accepts?: unknown }).accepts)
  );
}

function bounded(value: unknown): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(value)) <= MAX_PAYMENT_REQUIRED_BYTES;
  } catch {
    return false;
  }
}

/** The PaymentRequired of an `isError` tool result: `structuredContent` first, then `content[0]` text. */
export function paymentRequiredFromResult(result: CallToolResult): PaymentRequired | undefined {
  if (result.isError !== true) return undefined;
  if (isPaymentRequired(result.structuredContent) && bounded(result.structuredContent)) {
    return result.structuredContent;
  }
  const [first] = result.content;
  if (first?.type !== "text" || first.text.length > MAX_PAYMENT_REQUIRED_BYTES) return undefined;
  try {
    const parsed = JSON.parse(first.text) as unknown;
    return isPaymentRequired(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The PaymentRequired of a JSON-RPC payment-required error: in `data`, or under `data.x402`. */
export function paymentRequiredFromError(error: unknown): PaymentRequired | undefined {
  if (!(error instanceof ProtocolError) || !PAYMENT_REQUIRED_ERROR_CODES.has(error.code)) return undefined;
  const data = error.data as Record<string, unknown> | undefined;
  if (isPaymentRequired(data) && bounded(data)) return data;
  const nested = data?.["x402"];
  return isPaymentRequired(nested) && bounded(nested) ? nested : undefined;
}

function failure(error: unknown): string {
  const cause = error instanceof Error ? (error.cause ?? error) : error;
  const reason =
    cause !== null && typeof cause === "object" && typeof (cause as { reason?: unknown }).reason === "string"
      ? (cause as { reason: string }).reason
      : cause instanceof Error
        ? cause.message
        : "the MCP server could not be reached";
  return reason.slice(0, 200);
}
