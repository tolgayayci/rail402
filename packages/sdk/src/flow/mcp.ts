import {
  Client,
  ProtocolError,
  SSEClientTransport,
  SdkError,
  SdkErrorCode,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type FetchLike,
  type JsonSchemaValidator,
  type jsonSchemaValidator,
} from "@modelcontextprotocol/client";
import type { PaymentRequired, SettleResponse } from "@x402/core/types";
import { isEgressError, type EgressTimeouts, type SafeFetch } from "@rail402.dev/safe-fetch/shared";
import { utf8Length } from "../bytes.ts";
import { paymentError, type PaymentError } from "../codes.ts";
import { emit } from "../events.ts";
import type { Money } from "../money.ts";
import type { ListingBinding } from "../policy/decide.ts";
import { sanitizeJson, sanitizeText, untrustedReason } from "../redact.ts";
import {
  asPaymentError,
  chooseOption,
  markSent,
  markUnresolved,
  parseRequired,
  planCall,
  preflightFunds,
  reconcileBeforePaying,
  replayStored,
  settle,
  signPayment,
  snapshot,
  storeOutcome,
  unknownReceipt,
  upstreamMessage,
  type CallPlan,
  type FlowContext,
  type SignedPayment,
} from "./common.ts";
import {
  INLINE_BODY_BYTES,
  PAID_HEADERS_TIMEOUT_MAX_MS,
  PAID_TOTAL_TIMEOUT_MS,
  paidTimeouts,
} from "./http.ts";
import { judgeOptions } from "./quote.ts";
import type { Receipt } from "./receipt.ts";
import { paymentMaterial, scrubOutcome } from "./scrub.ts";
import type { CallResult, McpOutcome, PayOptions, PaymentTarget, Quote } from "./types.ts";

type McpTarget = Extract<PaymentTarget, { kind: "mcp" }>;

/** The x402 MCP transport's `_meta` keys. */
export const MCP_PAYMENT_META_KEY = "x402/payment";
export const MCP_PAYMENT_RESPONSE_META_KEY = "x402/payment-response";
/** JSON-RPC codes some sellers use to signal payment required: SEP-1036's -32042, and the older 402. */
const PAYMENT_REQUIRED_ERROR_CODES = new Set([-32042, 402]);
/** Largest serialized tool arguments sent. */
export const MAX_TOOL_ARGUMENTS_BYTES = 65_536;
const PROBE_TIMEOUT_MS = 30_000;
/** Room left in a request body for the JSON-RPC envelope around the tool call's params. */
const JSON_RPC_ENVELOPE_BYTES = 256;
const TOOL_NAME = /^[A-Za-z0-9_.\-/]{1,128}$/;
const CLIENT_INFO = { name: "rail402", version: "1" };

/** Seller output schemas are never compiled: a paid call has no reason to trust or execute them. */
const noValidation: jsonSchemaValidator = {
  getValidator<T>(): JsonSchemaValidator<T> {
    return (input) => ({ valid: true, data: input as T, errorMessage: undefined });
  },
};

interface Session {
  readonly client: Client;
  readonly fetch: SafeFetch;
  /** Timeouts for the session's next requests (the paid call's), over the egress policy's. */
  setTimeouts(timeouts: Partial<EgressTimeouts>): void;
  close(): Promise<void>;
}

function validateTarget(target: McpTarget): void {
  if (typeof target.url !== "string" || !/^https?:\/\//i.test(target.url)) {
    throw paymentError("mcp_endpoint_unresolvable");
  }
  if (!URL.canParse(target.url)) {
    throw paymentError("egress_url_invalid", { reason: "The MCP endpoint is not a valid URL." });
  }
  if (typeof target.toolName !== "string" || !TOOL_NAME.test(target.toolName)) {
    throw paymentError("payment_request_invalid", {
      reason: "A tool name is 1-128 letters, digits, dots, dashes, underscores or slashes.",
    });
  }
  const size = utf8Length(JSON.stringify(target.arguments ?? {}));
  if (size > MAX_TOOL_ARGUMENTS_BYTES) {
    throw paymentError("egress_request_too_large", {
      reason: `The tool arguments are ${String(size)} bytes; at most ${String(MAX_TOOL_ARGUMENTS_BYTES)} are sent.`,
    });
  }
}

/** Adapts safe-fetch to the MCP client's fetch: string bodies only, redirects refused. */
function mcpFetch(fetch: SafeFetch, timeouts: () => Partial<EgressTimeouts> | undefined): FetchLike {
  return (url, init) => {
    const body = init?.body;
    if (body !== undefined && body !== null && typeof body !== "string") {
      return Promise.reject(new TypeError("MCP requests carry JSON text bodies only"));
    }
    return fetch(url, {
      ...(init?.method === undefined ? {} : { method: init.method }),
      ...(init?.headers === undefined ? {} : { headers: init.headers }),
      body: body ?? null,
      ...(init?.signal === undefined || init.signal === null ? {} : { signal: init.signal }),
      redirect: "error",
      ...(timeouts() === undefined ? {} : { timeouts: timeouts() }),
    });
  };
}

/** Opens an MCP session to `target` over a fetch from `openSession`, which the session closes. */
async function open(
  openSession: () => SafeFetch,
  target: McpTarget,
  signal: AbortSignal | undefined,
): Promise<Session> {
  const url = new URL(target.url);
  const fetch = openSession();
  // The legacy SSE transport answers every request on one stream opened at connect, so that stream
  // must stay open through the paid call's wait: its silence and total bounds are the paid call's.
  let timeouts: Partial<EgressTimeouts> | undefined =
    target.transport === "sse"
      ? { idleMs: PAID_HEADERS_TIMEOUT_MAX_MS, totalMs: PAID_TOTAL_TIMEOUT_MS + 2 * PROBE_TIMEOUT_MS }
      : undefined;
  const fetchLike = mcpFetch(fetch, () => timeouts);
  const transport =
    target.transport === "sse"
      ? // Deprecated upstream in favour of Streamable HTTP, but still how SSE-only sellers are reached.
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        new SSEClientTransport(url, { fetch: fetchLike })
      : new StreamableHTTPClientTransport(url, {
          fetch: fetchLike,
          // A broken stream is never resumed or re-sent: one call, at most one payment.
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
  });
  const close = async () => {
    await client.close().catch(() => undefined);
    fetch.close();
  };
  try {
    await client.connect(transport, {
      timeout: PROBE_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    await close();
    throw protocolFailure(error);
  }
  return {
    client,
    fetch,
    setTimeouts: (next) => {
      timeouts = next;
    },
    close,
  };
}

/** A failure talking to the seller's MCP server before any payment. */
function protocolFailure(error: unknown): unknown {
  if (error instanceof DOMException && error.name === "AbortError") return error;
  if (isEgressError(error)) return error;
  const cause = error instanceof Error ? (error.cause ?? error) : error;
  if (isEgressError(cause)) return cause;
  return paymentError("mcp_protocol_error", {
    reason: `The seller's MCP server failed: ${upstreamMessage(error)}`,
  });
}

type Probe =
  | { readonly kind: "free"; readonly result: CallToolResult }
  | { readonly kind: "payment"; readonly required: PaymentRequired };

async function probe(session: Session, target: McpTarget, signal: AbortSignal | undefined): Promise<Probe> {
  let result: CallToolResult;
  try {
    result = await session.client.callTool(
      { name: target.toolName, arguments: { ...target.arguments } },
      { timeout: PROBE_TIMEOUT_MS, ...(signal === undefined ? {} : { signal }) },
    );
  } catch (error) {
    const required = paymentRequiredFromError(error);
    if (required !== undefined) return { kind: "payment", required: parseRequired(required) };
    throw classifyCallError(error);
  }
  const required = paymentRequiredFromResult(result);
  if (required !== undefined) return { kind: "payment", required: parseRequired(required) };
  if (unknownToolResult(result)) throw paymentError("mcp_tool_not_found");
  return { kind: "free", result };
}

/**
 * Makes one unpaid call of a tool and reports whether it asked for payment; never signs. A free tool
 * runs on this call. Seller checks use it to read a tool's live payment requirements.
 */
export async function probeTool(
  openSession: () => SafeFetch,
  target: McpTarget,
  signal?: AbortSignal,
): Promise<{ readonly kind: "free" } | { readonly kind: "payment"; readonly required: PaymentRequired }> {
  validateTarget(target);
  const session = await open(openSession, target, signal);
  try {
    const probed = await probe(session, target, signal);
    return probed.kind === "free" ? { kind: "free" } : probed;
  } finally {
    await session.close();
  }
}

export function classifyCallError(error: unknown): unknown {
  if (error instanceof SdkError) {
    if (
      error.code === SdkErrorCode.UnsupportedResultType ||
      error.code === SdkErrorCode.InputRequiredRoundsExceeded
    ) {
      return paymentError("mcp_input_required_unsupported");
    }
  }
  if (error instanceof ProtocolError && (error.code === -32602 || error.code === -32601)) {
    if (/not found|unknown tool/i.test(error.message)) return paymentError("mcp_tool_not_found");
  }
  return protocolFailure(error);
}

/** MCP SDK v1 servers answer an unknown tool with an error result carrying the protocol error's text. */
function unknownToolResult(result: CallToolResult): boolean {
  const [first, ...rest] = result.content;
  return (
    result.isError === true &&
    rest.length === 0 &&
    first?.type === "text" &&
    /^MCP error -3260[12]: Tool .{1,128} not found$/.test(first.text)
  );
}

function isPaymentRequiredShape(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "x402Version" in value &&
    Array.isArray((value as { accepts?: unknown }).accepts)
  );
}

/** PaymentRequired from a tool result: `structuredContent` first, then the JSON text of `content[0]`. */
export function paymentRequiredFromResult(result: CallToolResult): unknown {
  if (result.isError !== true) return undefined;
  if (
    isPaymentRequiredShape(result.structuredContent) &&
    jsonBytes(result.structuredContent) <= INLINE_BODY_BYTES
  ) {
    return result.structuredContent;
  }
  const [first] = result.content;
  if (first?.type === "text" && first.text.length <= INLINE_BODY_BYTES) {
    try {
      const parsed = JSON.parse(first.text) as unknown;
      if (isPaymentRequiredShape(parsed)) return parsed;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** PaymentRequired from a JSON-RPC error: in `data`, or under `data.x402`. */
export function paymentRequiredFromError(error: unknown): unknown {
  if (!(error instanceof ProtocolError) || !PAYMENT_REQUIRED_ERROR_CODES.has(error.code)) return undefined;
  const data = error.data as Record<string, unknown> | undefined;
  if (isPaymentRequiredShape(data)) return data;
  if (isPaymentRequiredShape(data?.["x402"])) return data["x402"];
  return undefined;
}

/** Seller content as bounded text: text items cleaned, anything else summarized. */
export function toOutcome(result: CallToolResult): McpOutcome {
  let budget = INLINE_BODY_BYTES;
  let truncated = false;
  const content = result.content.map((item) => {
    let text: string;
    if (item.type === "text") {
      text = item.text;
    } else {
      const mime = "mimeType" in item && typeof item.mimeType === "string" ? item.mimeType : item.type;
      const size =
        "data" in item && typeof item.data === "string" ? Math.floor((item.data.length * 3) / 4) : 0;
      text = `[${sanitizeText(mime, 100)}, ${String(size)} bytes omitted]`;
    }
    if (text.length > budget) {
      truncated = true;
      text = text.slice(0, Math.max(0, budget));
    }
    budget -= text.length;
    return { type: "text" as const, text: sanitizeText(text, INLINE_BODY_BYTES) };
  });
  let structuredContent: unknown;
  if (result.structuredContent !== undefined) {
    if (jsonBytes(result.structuredContent) <= INLINE_BODY_BYTES) {
      structuredContent = sanitizeJson(result.structuredContent, INLINE_BODY_BYTES);
    } else truncated = true;
  }
  return {
    kind: "mcp",
    isError: result.isError === true,
    content,
    ...(structuredContent === undefined ? {} : { structuredContent }),
    truncated,
  };
}

export interface McpCallOptions {
  readonly listing?: { readonly binding: ListingBinding; readonly receivable?: CallPlan["listedReceivable"] };
}

/**
 * Pays for an MCP tool call over the x402 MCP transport: an unpaid `tools/call`, then, when the tool
 * asks for payment, one guarded signature and one paid call carrying it in `_meta`. A free tool runs
 * on the unpaid call (as the transport specifies). The seller's tool list is never read and its
 * schemas are never compiled; interactive `input_required` answers are refused before any payment.
 */
export async function payMcp(
  context: FlowContext,
  target: McpTarget,
  options: PayOptions,
  call: McpCallOptions = {},
): Promise<CallResult> {
  validateTarget(target);
  const plan = planCall(context, options, `${target.url} tool=${target.toolName}`, call.listing);
  const replayed = await replayStored(context, plan);
  if (replayed !== undefined) return replayed;

  emit(context.onEvent, { type: "probe", callId: plan.callId, resource: plan.resource });
  let session: Session;
  try {
    session = await open(() => context.openSession(), target, plan.signal);
  } catch (error) {
    throw asPaymentError(error, plan.callId);
  }
  try {
    let probed: Probe;
    try {
      probed = await probe(session, target, plan.signal);
    } catch (error) {
      throw asPaymentError(error, plan.callId);
    }
    if (probed.kind === "free") {
      return {
        callId: plan.callId,
        paid: false,
        payment: null,
        response: toOutcome(probed.result),
        budget: snapshot(context),
        replayed: false,
      };
    }
    await reconcileBeforePaying(context, plan);
    const { chosen } = chooseOption(context, plan, probed.required);
    await preflightFunds(context, plan, chosen);
    const signed = await signPayment(context, plan, probed.required, chosen);
    return await sendPaid(context, plan, session, target, signed);
  } finally {
    await session.close();
  }
}

async function sendPaid(
  context: FlowContext,
  plan: CallPlan,
  session: Session,
  target: McpTarget,
  signed: SignedPayment,
): Promise<CallResult> {
  let reported: PaymentError | undefined;
  const fail = (error: PaymentError): never => {
    storeOutcome(context, signed, { error });
    reported = error;
    throw error;
  };
  const params = {
    name: target.toolName,
    arguments: { ...target.arguments },
    _meta: { [MCP_PAYMENT_META_KEY]: signed.payload },
  };
  // Checked before anything leaves: a request the egress policy would refuse to send is not a payment.
  const limit = session.fetch.policy.limits.requestBodyBytes;
  const size = jsonBytes(params) + JSON_RPC_ENVELOPE_BYTES;
  if (size > limit) {
    markUnresolved(context, signed, "egress_request_too_large");
    return fail(
      paymentError("egress_request_too_large", {
        reason: `The paid tool call would be about ${String(size)} bytes with its payment; at most ${String(limit)} are sent. Nothing was sent; the reserved budget stays pending until the authorization expires.`,
        paid: "none",
        callId: plan.callId,
      }),
    );
  }
  const timeouts = paidTimeouts(signed.option.maxTimeoutSeconds);
  session.setTimeouts(timeouts);
  markSent(context, signed);
  let result: CallToolResult;
  try {
    // The caller's signal is not passed on: once sent, the call completes and its outcome is kept.
    result = await session.client.callTool(params, { timeout: timeouts.headersMs });
  } catch (error) {
    markUnresolved(context, signed, "payment_settlement_unconfirmed");
    const required = paymentRequiredFromError(error);
    if (required !== undefined) {
      return fail(
        paymentError("payment_rejected", {
          details: { upstream: rejectionOf(required) },
          callId: plan.callId,
        }),
      );
    }
    const egress = egressCause(error);
    const undelivered = egress !== undefined && UNDELIVERED_STAGES.has(egress.stage);
    return fail(
      paymentError("payment_settlement_unconfirmed", {
        reason: undelivered
          ? "The paid tool call could not be delivered, so nothing reached the seller; the reserved budget stays pending until the authorization expires."
          : `The paid tool call failed after it was sent: ${upstreamMessage(error)}`,
        ...(undelivered ? { paid: "none" } : {}),
        details: egress === undefined ? undefined : { stage: egress.stage, cause: egress.code },
        callId: plan.callId,
      }),
    );
  }

  try {
    return await answered(context, plan, signed, result, fail);
  } catch (error) {
    if (error === reported) throw error;
    // Anything unexpected after the payment left must not read as "nothing paid".
    markUnresolved(context, signed, "payment_settlement_unconfirmed");
    return fail(
      paymentError("payment_settlement_unconfirmed", {
        reason: `Handling the seller's answer failed after the payment was sent: ${upstreamMessage(error)}`,
        paid: "unknown",
        callId: plan.callId,
      }),
    );
  }
}

/** Handles the seller's answer to the paid tool call. */
async function answered(
  context: FlowContext,
  plan: CallPlan,
  signed: SignedPayment,
  result: CallToolResult,
  fail: (error: PaymentError) => never,
): Promise<CallResult> {
  const settlement = settlementOf(result);
  if (settlement?.success === true) {
    const receipt = await settle(context, signed, settlement);
    const outcome = toOutcome(result);
    if (outcome.isError) {
      return fail(
        paymentError("payment_resource_failed", {
          reason: "The payment settled, but the tool reported an error.",
          callId: plan.callId,
          receipt,
        }),
      );
    }
    return finish(context, signed, plan, outcome, receipt);
  }
  const required = paymentRequiredFromResult(result);
  if (required !== undefined || settlement?.success === false) {
    markUnresolved(context, signed, "payment_rejected");
    return fail(
      paymentError("payment_rejected", {
        details: {
          upstream: settlement === undefined ? rejectionOf(required) : settlementRejection(settlement),
        },
        callId: plan.callId,
      }),
    );
  }
  markUnresolved(context, signed, "payment_settlement_unconfirmed");
  const outcome = toOutcome(result);
  if (outcome.isError) {
    return fail(
      paymentError("payment_settlement_unconfirmed", {
        reason: "The tool reported an error without a settlement report; check the budget before retrying.",
        callId: plan.callId,
      }),
    );
  }
  return finish(context, signed, plan, outcome, unknownReceipt(context, signed));
}

/** The paid call's result, with the call's own payment removed from the seller's content. */
function finish(
  context: FlowContext,
  signed: SignedPayment,
  plan: CallPlan,
  response: McpOutcome,
  payment: Receipt,
): CallResult {
  const result: CallResult = {
    callId: plan.callId,
    paid: true,
    payment,
    response: scrubOutcome(response, paymentMaterial(signed.payload, context.network)),
    budget: snapshot(context),
    replayed: false,
  };
  storeOutcome(context, signed, { result });
  return result;
}

/** Egress stages at which a request never reached the seller. */
const UNDELIVERED_STAGES: ReadonlySet<string> = new Set(["url", "dns", "connect", "tls"]);

/** The egress failure behind an MCP client error, if any. */
function egressCause(error: unknown): { readonly stage: string; readonly code: string } | undefined {
  for (let current = error, depth = 0; current !== undefined && depth < 4; depth++) {
    if (isEgressError(current)) return { stage: current.stage, code: current.code };
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

function jsonBytes(value: unknown): number {
  try {
    const json = JSON.stringify(value) as string | undefined;
    return json === undefined ? 0 : utf8Length(json);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function settlementOf(result: CallToolResult): SettleResponse | undefined {
  const value = result._meta?.[MCP_PAYMENT_RESPONSE_META_KEY];
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { success?: unknown }).success !== "boolean"
  ) {
    return undefined;
  }
  return value as SettleResponse;
}

function rejectionOf(required: unknown): Record<string, unknown> {
  const error = (required as { error?: unknown } | undefined)?.error;
  return { reason: typeof error === "string" ? untrustedReason(error, 300) : "payment required again" };
}

function settlementRejection(settlement: SettleResponse): Record<string, unknown> {
  return {
    reason: untrustedReason(settlement.errorMessage ?? settlement.errorReason ?? "settlement failed", 300),
    ...(settlement.errorReason === undefined ? {} : { code: untrustedReason(settlement.errorReason, 100) }),
  };
}

/**
 * Runs the unpaid tool call and judges each payment option; never signs. A free tool runs on this
 * call, so quoting it executes it: the quote carries a warning.
 */
export async function quoteMcp(
  context: FlowContext,
  target: McpTarget,
  options: {
    readonly maxAmount?: Money;
    readonly signal?: AbortSignal;
    readonly listing?: ListingBinding;
  } = {},
): Promise<Quote> {
  const callId = crypto.randomUUID();
  validateTarget(target);
  let session: Session;
  try {
    session = await open(() => context.openSession(), target, options.signal);
  } catch (error) {
    throw asPaymentError(error, callId);
  }
  const warnings = ["A free MCP tool runs on the unpaid call: quoting it executed it."];
  try {
    let probed: Probe;
    try {
      probed = await probe(session, target, options.signal);
    } catch (error) {
      throw asPaymentError(error, callId);
    }
    if (probed.kind === "free") {
      return {
        callId,
        resource: target.url,
        paymentRequired: false,
        status: 200,
        options: [],
        chosen: null,
        refused: null,
        warnings,
      };
    }
    const judged = judgeOptions(context, probed.required, options.maxAmount, options.listing);
    return { callId, resource: target.url, paymentRequired: true, status: 402, ...judged, warnings: [] };
  } finally {
    await session.close();
  }
}
