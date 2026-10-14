import { createRequire } from "node:module";
import {
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type JSONRPCRequest,
  type McpServerFactory,
  type Result,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { sanitizeText } from "@rail402.dev/sdk";
import { rpcCodes, toolCodes, type RpcCode } from "./codes.ts";
import { SERVER_INSTRUCTIONS, type Tools } from "./tools.ts";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

export const SERVER_INFO = { name: "rail402-mcp", title: "Rail402 for Stellar", version } as const;

/** Longest SDK detail kept in a coded reason. */
const MAX_DETAIL_CHARS = 300;

const CODE_BY_JSON_RPC: ReadonlyMap<number, RpcCode> = new Map([
  [ProtocolErrorCode.MethodNotFound, "rpc_method_unknown"],
  [ProtocolErrorCode.InvalidParams, "rpc_params_invalid"],
]);

type RequestHandler = (request: JSONRPCRequest, ctx: ServerContext) => Promise<Result>;

/** A failure of this server's own code, kept apart from the SDK's request validation. */
class HandlerFailure extends Error {}

/**
 * A JSON-RPC error with `data: { code, reason }`, so a client reads the same fields as in a tool
 * result's error. An error that already carries a code keeps it.
 */
export function codedProtocolError(error: unknown): ProtocolError {
  if (error instanceof ProtocolError) {
    const data = error.data as { code?: unknown } | undefined;
    if (typeof data?.code === "string") return error;
    const code = CODE_BY_JSON_RPC.get(error.code) ?? "rpc_internal_error";
    return withCode(error.code, error.message, code, isRecord(error.data) ? error.data : {});
  }
  if (error instanceof HandlerFailure) {
    return withCode(ProtocolErrorCode.InternalError, "Internal error", "rpc_internal_error", {});
  }
  // The SDK's schema check of the request's params throws a plain Error naming the failing path.
  const message = error instanceof Error ? error.message : "Invalid params";
  return withCode(ProtocolErrorCode.InvalidParams, message, "rpc_params_invalid", {});
}

function withCode(
  jsonRpcCode: number,
  message: string,
  code: RpcCode,
  data: Readonly<Record<string, unknown>>,
): ProtocolError {
  const detail = issueOf(message) ?? message.replace(/\s+/g, " ").trim();
  const reason =
    code === "rpc_internal_error" || detail === "" || detail === "Method not found"
      ? rpcCodes[code].reason
      : `${rpcCodes[code].reason} ${sanitizeText(detail, MAX_DETAIL_CHARS)}`;
  return new ProtocolError(jsonRpcCode, message, { ...data, code, reason });
}

/** The first schema issue of an SDK validation message (a JSON list of issues), as `at <path>: <message>`. */
function issueOf(message: string): string | undefined {
  const start = message.indexOf("[");
  if (start < 0) return undefined;
  try {
    const issues = JSON.parse(message.slice(start)) as unknown;
    const first = Array.isArray(issues) ? (issues[0] as unknown) : undefined;
    if (!isRecord(first)) return undefined;
    const { message: text, path } = first as { message?: unknown; path?: unknown };
    if (typeof text !== "string") return undefined;
    const where = Array.isArray(path) ? path.map(String).join(".") : "";
    return where === "" ? text : `At ${where}: ${text}`;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The low-level server with every JSON-RPC error coded: the SDK's own refusals (an unknown method, a
 * `tools/call` without a tool name or with arguments that are not an object) carry
 * `data: { code, reason }` like the tools' errors do.
 */
// eslint-disable-next-line @typescript-eslint/no-deprecated
class CodedServer extends Server {
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  constructor(...args: ConstructorParameters<typeof Server>) {
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    super(...args);
    this.fallbackRequestHandler = (request) => {
      const reason = `${rpcCodes.rpc_method_unknown.reason} Unknown method: ${sanitizeText(request.method, 128)}.`;
      return Promise.reject(
        new ProtocolError(ProtocolErrorCode.MethodNotFound, "Method not found", {
          code: "rpc_method_unknown",
          reason,
        }),
      );
    };
  }

  protected override _wrapHandler(method: string, handler: RequestHandler): RequestHandler {
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const wrapped = super._wrapHandler(method, handler);
    return async (request, ctx) => {
      try {
        return await wrapped(request, ctx);
      } catch (error) {
        throw codedProtocolError(error);
      }
    };
  }
}

/** Runs one of this server's handlers, marking its own failures apart from the SDK's validation. */
async function own<T>(run: () => T | Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new HandlerFailure(error instanceof Error ? error.message : String(error));
  }
}

/**
 * A factory of low-level MCP servers sharing one set of tools. The serving entries call it once per
 * stdio connection or HTTP request; the tools hold the state (buyer, budget, limits) across them.
 *
 * A request that never reaches a tool is a JSON-RPC error whose `data` carries `{ code, reason }`:
 * `tool_unknown` (`-32602`) for an unknown tool, `rpc_params_invalid` (`-32602`) for params the MCP
 * schema refuses, `rpc_method_unknown` (`-32601`) for a method the server does not serve. Every other
 * failure is a tool result with `isError` and a coded `structuredContent.error`.
 */
export function createServerFactory(tools: Tools): McpServerFactory {
  return () => {
    // The low-level server on purpose: the tools publish their own JSON Schemas (no $ref, both
    // result branches) and map every failure to a coded result, which the high-level API does not allow.
    const server = new CodedServer(SERVER_INFO, {
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS,
    });
    server.setRequestHandler("tools/list", () =>
      own(() => ({
        tools: tools.definitions.map((definition) => ({
          name: definition.name,
          title: definition.title,
          description: definition.description,
          inputSchema: definition.inputSchema as { type: "object" },
          outputSchema: definition.outputSchema as { type: "object" },
          annotations: { title: definition.title, ...definition.annotations },
        })),
      })),
    );
    server.setRequestHandler("tools/call", (request, context) =>
      own(() => {
        const { name } = request.params;
        if (!tools.has(name)) {
          const reason = `${toolCodes.tool_unknown.reason} Unknown tool: ${sanitizeText(name, 128)}.`;
          throw new ProtocolError(ProtocolErrorCode.InvalidParams, reason, { code: "tool_unknown", reason });
        }
        return tools.call(name, request.params.arguments, context.mcpReq.signal);
      }),
    );
    return server;
  };
}
