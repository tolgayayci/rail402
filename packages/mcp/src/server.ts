import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  CLIENT_CAPABILITIES_META_KEY,
  ProtocolError,
  ProtocolErrorCode,
  Server,
  acceptedContent,
  createRequestStateCodec,
  inputRequired,
  type ClientCapabilities,
  type JSONRPCRequest,
  type McpServerFactory,
  type Result,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { sanitizeText } from "@rail402.dev/sdk/discovery";
import { z } from "zod";
import { rpcCodes, rpcErrorData, toolCodes, type RpcCode } from "./codes.ts";
import {
  ConfirmationRequired,
  confirmationMessage,
  confirmedIntent,
  isConfirmedIntent,
  type ConfirmationAnswer,
  type ConfirmedIntent,
} from "./confirmation.ts";
import { SERVER_INSTRUCTIONS, type ToolResult } from "./search.ts";
import type { ToolCallContext } from "./confirmation.ts";

/** The tools a server serves: rail402-mcp's own (`createTools`) or the hosted read-only set. */
export interface ServedTools {
  readonly definitions: readonly {
    readonly name: string;
    readonly title: string;
    readonly description: string;
    readonly inputSchema: Record<string, unknown>;
    readonly outputSchema: Record<string, unknown>;
    readonly annotations: Readonly<Record<string, boolean>>;
  }[];
  has(name: string): boolean;
  call(name: string, args: unknown, signal?: AbortSignal, context?: ToolCallContext): Promise<ToolResult>;
}

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
 * A JSON-RPC error with `data: { code, reason, retryable, paid }`, so a client reads the same fields
 * as in a tool result's error. An error that already carries a code keeps it.
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
  return new ProtocolError(jsonRpcCode, message, { ...data, ...rpcErrorData(code, reason) });
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
 * `data: { code, reason, retryable, paid }` like the tools' errors do.
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
        new ProtocolError(
          ProtocolErrorCode.MethodNotFound,
          "Method not found",
          rpcErrorData("rpc_method_unknown", reason),
        ),
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

/**
 * What a confirmation's request state seals: the payment terms asked about, a single-use id, and a
 * digest of the exact tool call (name and arguments) it was asked for.
 */
interface SealedConfirmation extends ConfirmedIntent {
  readonly id: string;
  readonly call: string;
}

function isSealedConfirmation(value: unknown): value is SealedConfirmation {
  if (!isConfirmedIntent(value)) return false;
  const record = value as unknown as Record<string, unknown>;
  return typeof record["id"] === "string" && typeof record["call"] === "string";
}

/** JSON with object keys sorted, so the same arguments always give the same digest. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  // JSON.stringify gives undefined for values JSON cannot represent.
  const text = JSON.stringify(value) as string | undefined;
  return text === undefined ? "null" : text;
}

/** The digest of one tool call that a confirmation is bound to. */
export function toolCallDigest(name: string, args: unknown): string {
  return createHash("sha256")
    .update(canonicalJson([name, args ?? {}]))
    .digest("base64url");
}

/** How long a confirmation's request state is accepted. */
const CONFIRMATION_TTL_SECONDS = 600;

/**
 * Ids of the confirmations already answered, kept until their request state expires, so each state is
 * accepted once. Bounded: when it is full of unexpired ids, further answers are refused rather than an
 * id forgotten early.
 */
export class UsedConfirmations {
  private readonly used = new Map<string, number>();
  private readonly max: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(max = 10_000, ttlMs = CONFIRMATION_TTL_SECONDS * 1000, now: () => number = Date.now) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  /** Records `id`; false when it was used before or the store is full. */
  use(id: string): boolean {
    const now = this.now();
    // Insertion order is expiry order: drop the expired ones from the front.
    for (const [known, expires] of this.used) {
      if (expires > now) break;
      this.used.delete(known);
    }
    if (this.used.has(id) || this.used.size >= this.max) return false;
    this.used.set(id, now + this.ttlMs);
    return true;
  }
}

function confirmationRefusal(code: "rpc_confirmation_used" | "rpc_confirmation_mismatch"): ProtocolError {
  const { reason } = rpcCodes[code];
  return new ProtocolError(ProtocolErrorCode.InvalidParams, reason, rpcErrorData(code, reason));
}

/** The form a payment confirmation asks for: one boolean. */
const CONFIRM_SCHEMA = {
  type: "object" as const,
  properties: {
    confirm: { type: "boolean" as const, title: "Pay", description: "Sign this payment." },
  },
  required: ["confirm"],
};

const confirmContent = z.object({ confirm: z.boolean() });

/**
 * The answer a retried call carries for a confirmation this server asked about: the verified intent
 * from the request state, approved only when the user accepted with `confirm: true`. A declined or
 * cancelled form, or any other content, is a refusal. The state must belong to this exact call
 * (`rpc_confirmation_mismatch`) and is accepted once (`rpc_confirmation_used`), so one approval never
 * signs a second payment.
 */
function confirmationAnswer(
  context: ServerContext,
  name: string,
  args: unknown,
  used: UsedConfirmations,
): ConfirmationAnswer | undefined {
  const state = context.mcpReq.requestState();
  if (state === undefined) return undefined;
  if (!isSealedConfirmation(state)) throw confirmationRefusal("rpc_confirmation_mismatch");
  if (state.call !== toolCallDigest(name, args)) throw confirmationRefusal("rpc_confirmation_mismatch");
  if (!used.use(state.id)) throw confirmationRefusal("rpc_confirmation_used");
  const content = acceptedContent(context.mcpReq.inputResponses, "confirm", confirmContent);
  return { approved: content?.confirm === true, intent: state };
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
 * A request that never reaches a tool is a JSON-RPC error whose `data` carries
 * `{ code, reason, retryable, paid }`, with `paid: "none"`: `tool_unknown` (`-32602`) for an unknown
 * tool, `rpc_params_invalid` (`-32602`) for params the MCP schema refuses, `rpc_method_unknown`
 * (`-32601`) for a method the server does not serve. Every other failure is a tool result with
 * `isError` and a coded `structuredContent.error`.
 */
export function createServerFactory(
  tools: ServedTools,
  options: {
    readonly instructions?: string;
    /** Where answered confirmations are recorded; one per process by default. */
    readonly usedConfirmations?: UsedConfirmations;
  } = {},
): McpServerFactory {
  // Seals the intent a confirmation was asked about; the key never leaves this process, so only a
  // retry of a question this process asked within ten minutes is accepted, once, for the same call.
  const codec = createRequestStateCodec<SealedConfirmation>({
    key: crypto.getRandomValues(new Uint8Array(32)),
    ttlSeconds: CONFIRMATION_TTL_SECONDS,
    bind: (ctx) => `rail402-mcp/confirm\0${ctx.mcpReq.method}\0${ctx.sessionId ?? ""}`,
  });
  const used = options.usedConfirmations ?? new UsedConfirmations();
  return () => {
    // The low-level server on purpose: the tools publish their own JSON Schemas (no $ref, both
    // result branches) and map every failure to a coded result, which the high-level API does not allow.
    const server = new CodedServer(SERVER_INFO, {
      capabilities: { tools: {} },
      instructions: options.instructions ?? SERVER_INSTRUCTIONS,
      requestState: { verify: (state, ctx) => codec.verify(state, ctx) },
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
          throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            reason,
            rpcErrorData("tool_unknown", reason),
          );
        }
        const envelope = context.mcpReq.envelope as Record<string, unknown> | undefined;
        const capabilities =
          (envelope?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined) ??
          // 2025-era connections declare their capabilities once, at initialize.
          // eslint-disable-next-line @typescript-eslint/no-deprecated
          server.getClientCapabilities();
        const call = {
          canElicit: capabilities?.elicitation !== undefined,
          answer: confirmationAnswer(context, name, request.params.arguments, used),
        };
        return tools
          .call(name, request.params.arguments, context.mcpReq.signal, call)
          .catch(async (error: unknown) => {
            if (!(error instanceof ConfirmationRequired)) throw error;
            return inputRequired({
              inputRequests: {
                confirm: inputRequired.elicit({
                  message: confirmationMessage(error.intent),
                  requestedSchema: CONFIRM_SCHEMA,
                }),
              },
              requestState: await codec.mint(
                {
                  ...confirmedIntent(error.intent),
                  id: randomUUID(),
                  call: toolCallDigest(name, request.params.arguments),
                },
                context,
              ),
            });
          });
      }),
    );
    return server;
  };
}
