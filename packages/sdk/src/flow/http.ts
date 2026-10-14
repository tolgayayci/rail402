import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired, SettleResponse } from "@x402/core/types";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { finalRequestOf, isEgressError, type SafeRequestInit } from "@rail402.dev/safe-fetch/shared";
import { concatBytes } from "../bytes.ts";
import { isPaymentError, paymentError, type PaymentError } from "../codes.ts";
import { emit } from "../events.ts";
import type { Money } from "../money.ts";
import { sanitizeJson, sanitizeText, untrustedReason } from "../redact.ts";
import {
  asPaymentError,
  chooseOption,
  markSent,
  markUnresolved,
  MAX_PAYMENT_REQUIRED_BYTES,
  parseRequired,
  planCall,
  preflightFunds,
  reconcileBeforePaying,
  replayStored,
  settle,
  signPayment,
  snapshot,
  storeOutcome,
  upstreamMessage,
  type CallPlan,
  type FlowContext,
  type SignedPayment,
  unknownReceipt,
} from "./common.ts";
import { judgeOptions } from "./quote.ts";
import type { Receipt } from "./receipt.ts";
import { paymentMaterial, scrubOutcome, type PaymentMaterial } from "./scrub.ts";
import {
  HTTP_METHODS,
  type CallResult,
  type HttpMethod,
  type HttpOutcome,
  type PayOptions,
  type PaymentTarget,
  type Quote,
} from "./types.ts";
import type { ListingBinding } from "../policy/decide.ts";

type HttpTarget = Extract<PaymentTarget, { kind: "http" }>;

/** An HTTP request ready for safe-fetch. */
export interface HttpRequest {
  readonly url: string;
  readonly method: HttpMethod;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | Uint8Array | null;
}

/** Request headers a caller may set; everything else is refused. */
export const ALLOWED_REQUEST_HEADERS: readonly string[] = ["accept", "accept-language", "x-request-id"];
/** Content returned inline in a result; the rest is counted and left out. */
export const INLINE_BODY_BYTES = 65_536;
/** Longest wait for the paid response's headers: the seller verifies and settles before answering. */
export const PAID_HEADERS_TIMEOUT_MAX_MS = 120_000;
export const PAID_TOTAL_TIMEOUT_MS = 150_000;
/** Time allowed past the option's `maxTimeoutSeconds` for the seller's settlement to confirm. */
export const PAID_SETTLEMENT_MARGIN_MS = 30_000;

/**
 * Timeouts of a paid request (HTTP or MCP). A seller verifies, serves and settles before it answers,
 * and may stream nothing meanwhile, so both the wait for headers and the longest silence are the
 * option's `maxTimeoutSeconds` plus the settlement margin, at most PAID_HEADERS_TIMEOUT_MAX_MS; the
 * whole exchange is bounded by PAID_TOTAL_TIMEOUT_MS.
 */
export function paidTimeouts(maxTimeoutSeconds: number): {
  readonly headersMs: number;
  readonly idleMs: number;
  readonly totalMs: number;
} {
  const seconds = Number.isFinite(maxTimeoutSeconds) && maxTimeoutSeconds > 0 ? maxTimeoutSeconds : 0;
  const wait = Math.min(Math.ceil(seconds * 1_000) + PAID_SETTLEMENT_MARGIN_MS, PAID_HEADERS_TIMEOUT_MAX_MS);
  return { headersMs: wait, idleMs: wait, totalMs: PAID_TOTAL_TIMEOUT_MS };
}

const MAX_HEADER_VALUE = 1_024;
// Wire codec only: no scheme is registered, so it can never sign.
const codec = new x402HTTPClient(new x402Client());

/**
 * Builds the request for an HTTP target: method, query, allowlisted headers and a body encoded by its
 * type. The URL itself is checked by safe-fetch before anything is sent.
 */
export function buildHttpRequest(target: HttpTarget): HttpRequest {
  const method = (target.method ?? "GET").toUpperCase() as HttpMethod;
  if (!HTTP_METHODS.includes(method)) {
    throw paymentError("payment_request_invalid", {
      reason: `The method must be one of ${HTTP_METHODS.join(", ")}.`,
    });
  }
  if (typeof target.url !== "string" || !URL.canParse(target.url)) {
    throw paymentError("egress_url_invalid", { reason: "The resource is not an absolute URL." });
  }
  const url = new URL(target.url);
  for (const [name, value] of Object.entries(target.query ?? {})) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values as readonly unknown[]) {
      if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
        throw paymentError("payment_request_invalid", {
          reason: `The query parameter "${sanitizeText(name, 64)}" must be a string, number or boolean.`,
        });
      }
      url.searchParams.append(name, String(item));
    }
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(target.headers ?? {})) {
    const lower = name.toLowerCase();
    if (!ALLOWED_REQUEST_HEADERS.includes(lower)) {
      throw paymentError("payment_request_invalid", {
        reason: `The header "${sanitizeText(name, 64)}" cannot be set; allowed: ${ALLOWED_REQUEST_HEADERS.join(", ")}.`,
      });
    }
    if (typeof value !== "string" || value.length > MAX_HEADER_VALUE || /[\r\n\0]/.test(value)) {
      throw paymentError("payment_request_invalid", {
        reason: `The header "${lower}" must be a single-line string of at most ${MAX_HEADER_VALUE} characters.`,
      });
    }
    headers[lower] = value;
  }
  let body: string | Uint8Array | null = null;
  if (target.body !== undefined && target.body !== null) {
    if (method === "GET" || method === "HEAD") {
      throw paymentError("payment_request_invalid", { reason: `A ${method} request cannot carry a body.` });
    }
    if (typeof target.body === "string") {
      body = target.body;
      headers["content-type"] = "text/plain; charset=utf-8";
    } else if (target.body instanceof Uint8Array) {
      body = target.body;
      headers["content-type"] = "application/octet-stream";
    } else {
      let json: string | undefined;
      try {
        json = JSON.stringify(target.body);
      } catch {
        json = undefined;
      }
      if (json === undefined) {
        throw paymentError("payment_request_invalid", { reason: "The body cannot be encoded as JSON." });
      }
      body = json;
      headers["content-type"] = "application/json";
    }
  }
  return { url: url.href, method, headers, body };
}

interface Probe {
  readonly response: Response;
  /**
   * The request that answered, after any same-origin redirects: its URL, and its method and body when
   * a redirect turned it into a GET (a 303, or a 301/302 after POST). The paid request repeats exactly
   * that request.
   */
  readonly request: HttpRequest;
}

async function probe(
  context: FlowContext,
  request: HttpRequest,
  redirect: SafeRequestInit["redirect"],
  signal: AbortSignal | undefined,
): Promise<Probe> {
  const response = await context.fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect,
    ...(signal === undefined ? {} : { signal }),
  });
  const final = finalRequestOf(response);
  const url = response.url === "" ? request.url : response.url;
  if (final === undefined || final.method === request.method)
    return { response, request: { ...request, url } };
  const headers = Object.fromEntries(
    Object.entries(request.headers).filter(([name]) => !name.toLowerCase().startsWith("content-")),
  );
  return {
    response,
    request: { url, method: final.method as HttpMethod, headers, body: null },
  };
}

/** The seller's PAYMENT-REQUIRED header, bounded and validated. */
function paymentRequiredOf(response: Response): PaymentRequired {
  const header = response.headers.get("payment-required");
  if (header === null || header === "") {
    throw paymentError("payment_requirements_invalid", {
      reason: "The 402 response has no PAYMENT-REQUIRED header (x402 version 2).",
    });
  }
  if (header.length > MAX_PAYMENT_REQUIRED_BYTES) {
    throw paymentError("payment_requirements_invalid", {
      reason: "The PAYMENT-REQUIRED header is too large.",
    });
  }
  let decoded: unknown;
  try {
    decoded = decodePaymentRequiredHeader(header);
  } catch {
    throw paymentError("payment_requirements_invalid", {
      reason: "The PAYMENT-REQUIRED header is not base64-encoded JSON.",
    });
  }
  return parseRequired(decoded);
}

export interface HttpCallOptions {
  /** A listing binds the payment and disables redirects on the unpaid probe. */
  readonly listing?: {
    readonly binding: ListingBinding;
    readonly receivable?: CallPlan["listedReceivable"];
  };
}

/**
 * Pays for an HTTP resource: an unpaid probe, then, when it answers 402, one guarded signature and one
 * paid request. The paid request is never redirected and never repeated; a free resource resolves with
 * `paid: false`.
 */
export async function payHttp(
  context: FlowContext,
  target: HttpTarget,
  options: PayOptions,
  call: HttpCallOptions = {},
): Promise<CallResult> {
  const request = buildHttpRequest(target);
  const plan = planCall(context, options, request.url, call.listing);
  const replayed = await replayStored(context, plan);
  if (replayed !== undefined) return replayed;

  emit(context.onEvent, { type: "probe", callId: plan.callId, resource: request.url });
  let probed: Probe;
  try {
    probed = await probe(context, request, call.listing === undefined ? "same-origin" : "error", plan.signal);
  } catch (error) {
    throw asPaymentError(error, plan.callId);
  }
  if (probed.response.status !== 402) {
    return {
      callId: plan.callId,
      paid: false,
      payment: null,
      response: await readOutcome(probed.response),
      budget: snapshot(context),
      replayed: false,
    };
  }
  await probed.response.body?.cancel().catch(() => undefined);
  const required = withCall(() => paymentRequiredOf(probed.response), plan.callId);
  await reconcileBeforePaying(context, plan);
  const { chosen } = chooseOption(context, plan, required);
  await preflightFunds(context, plan, chosen);
  const signed = await signPayment(context, plan, required, chosen);
  return sendPaid(context, plan, probed.request, signed);
}

async function sendPaid(
  context: FlowContext,
  plan: CallPlan,
  request: HttpRequest,
  signed: SignedPayment,
): Promise<CallResult> {
  let reported: PaymentError | undefined;
  const fail = (error: PaymentError): never => {
    storeOutcome(context, signed, { error });
    reported = error;
    throw error;
  };
  const paymentHeader = codec.encodePaymentSignatureHeader(signed.payload);
  const material = paymentMaterial(signed.payload, context.network, Object.values(paymentHeader)[0]);
  markSent(context, signed);
  let response: Response;
  try {
    // The caller's signal is not passed on: once sent, the call completes and its outcome is kept.
    response = await context.fetch(request.url, {
      method: request.method,
      headers: { ...request.headers, ...paymentHeader },
      body: request.body,
      redirect: "error",
      timeouts: paidTimeouts(signed.option.maxTimeoutSeconds),
    });
  } catch (error) {
    markUnresolved(context, signed, "payment_settlement_unconfirmed");
    if (isEgressError(error) && error.code === "egress_redirect_not_allowed") {
      return fail(paymentError("payment_redirect_after_payment", { callId: plan.callId }));
    }
    const undelivered = isEgressError(error) && ["url", "dns", "connect", "tls"].includes(error.stage);
    return fail(
      paymentError("payment_settlement_unconfirmed", {
        reason: undelivered
          ? "The paid request could not be delivered, so nothing reached the seller; the reserved budget stays pending until the authorization expires."
          : `The paid request failed after it was sent: ${upstreamMessage(error)}`,
        ...(undelivered ? { paid: "none" } : {}),
        details: isEgressError(error) ? { stage: error.stage, cause: error.code } : undefined,
        callId: plan.callId,
      }),
    );
  }

  try {
    return await answered(context, plan, signed, material, response, fail);
  } catch (error) {
    if (error === reported) throw error;
    // Anything unexpected after the payment left (a malformed seller answer, a ledger write) must
    // not read as "nothing paid": the outcome is unknown until the chain proves it.
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

/** Handles the seller's answer to the paid request. */
async function answered(
  context: FlowContext,
  plan: CallPlan,
  signed: SignedPayment,
  material: PaymentMaterial,
  response: Response,
  fail: (error: PaymentError) => never,
): Promise<CallResult> {
  const getHeader = (name: string) => response.headers.get(name);
  let settlement: SettleResponse | undefined;
  let settlementMalformed = false;
  if (getHeader("payment-response") !== null) {
    try {
      settlement = codec.getPaymentSettleResponse(getHeader);
    } catch {
      settlementMalformed = true;
    }
  }

  if (settlement?.success === true) {
    const receipt = await settle(context, signed, settlement);
    const outcome = await readOutcome(response);
    if (response.status >= 400) {
      return fail(
        paymentError("payment_resource_failed", {
          reason: `The payment settled, but the resource answered with HTTP ${String(response.status)}.`,
          details: { status: response.status },
          callId: plan.callId,
          receipt,
        }),
      );
    }
    return finish(context, signed, plan, material, outcome, receipt);
  }

  if (response.status === 402 || settlement?.success === false) {
    await response.body?.cancel().catch(() => undefined);
    markUnresolved(context, signed, "payment_rejected");
    return fail(
      paymentError("payment_rejected", {
        details: { upstream: rejection(settlement, response) },
        callId: plan.callId,
      }),
    );
  }

  markUnresolved(context, signed, "payment_settlement_unconfirmed");
  if (response.status >= 400 || settlementMalformed) {
    await response.body?.cancel().catch(() => undefined);
    return fail(
      paymentError("payment_settlement_unconfirmed", {
        reason: settlementMalformed
          ? "The seller's PAYMENT-RESPONSE header is malformed; check the budget before retrying."
          : `The seller answered HTTP ${String(response.status)} without reporting a settlement; check the budget before retrying.`,
        details: { status: response.status },
        callId: plan.callId,
      }),
    );
  }
  // Answered without a settlement report: the payment stays pending until reconciliation proves it.
  const outcome = await readOutcome(response);
  return finish(context, signed, plan, material, outcome, unknownReceipt(context, signed));
}

/** The paid call's result, with the call's own payment removed from the seller's content. */
function finish(
  context: FlowContext,
  signed: SignedPayment,
  plan: CallPlan,
  material: PaymentMaterial,
  response: HttpOutcome,
  payment: Receipt,
): CallResult {
  const result: CallResult = {
    callId: plan.callId,
    paid: true,
    payment,
    response: scrubOutcome(response, material),
    budget: snapshot(context),
    replayed: false,
  };
  storeOutcome(context, signed, { result });
  return result;
}

/** What the seller said when refusing a payment, sanitized and bounded. */
function rejection(settlement: SettleResponse | undefined, response: Response): Record<string, unknown> {
  if (settlement !== undefined) {
    return {
      reason: untrustedReason(settlement.errorMessage ?? settlement.errorReason ?? "settlement failed", 300),
      ...(settlement.errorReason === undefined ? {} : { code: untrustedReason(settlement.errorReason, 100) }),
    };
  }
  try {
    const required = decodePaymentRequiredHeader(response.headers.get("payment-required") ?? "");
    return { reason: untrustedReason(required.error ?? "payment required again", 300) };
  } catch {
    return { reason: `HTTP ${String(response.status)}` };
  }
}

/** Runs the unpaid probe and judges each payment option; never signs. */
export async function quoteHttp(
  context: FlowContext,
  target: HttpTarget,
  options: {
    readonly maxAmount?: Money;
    readonly signal?: AbortSignal;
    readonly listing?: ListingBinding;
  } = {},
): Promise<Quote> {
  const callId = crypto.randomUUID();
  const request = buildHttpRequest(target);
  let probed: Probe;
  try {
    probed = await probe(
      context,
      request,
      options.listing === undefined ? "same-origin" : "error",
      options.signal,
    );
  } catch (error) {
    throw asPaymentError(error, callId);
  }
  await probed.response.body?.cancel().catch(() => undefined);
  if (probed.response.status !== 402) {
    return {
      callId,
      resource: probed.request.url,
      paymentRequired: false,
      status: probed.response.status,
      options: [],
      chosen: null,
      refused: null,
      warnings: [],
    };
  }
  const required = withCall(() => paymentRequiredOf(probed.response), callId);
  const judged = judgeOptions(context, required, options.maxAmount, options.listing);
  return {
    callId,
    resource: probed.request.url,
    paymentRequired: true,
    status: 402,
    ...judged,
    warnings: [],
  };
}

/**
 * Reads a response into a bounded outcome: JSON is parsed when it fits inline, text has control
 * characters removed, binary content is summarized. A body cut off by the response limit is marked
 * truncated instead of failing the call.
 */
export async function readOutcome(response: Response): Promise<HttpOutcome> {
  const contentType = response.headers.get("content-type");
  const { head, bytes, complete } = await drain(response, INLINE_BODY_BYTES);
  const truncated = !complete || bytes > INLINE_BODY_BYTES;
  const base = { kind: "http" as const, status: response.status, contentType, bytes, truncated };
  if (bytes === 0) return base;
  const type = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const isJson = type === "application/json" || type.endsWith("+json");
  const isText =
    isJson ||
    type.startsWith("text/") ||
    type === "" ||
    ["application/xml", "application/javascript", "application/x-www-form-urlencoded"].includes(type) ||
    type.endsWith("+xml");
  if (!isText) {
    return { ...base, text: `[${sanitizeText(type, 100)}, ${String(bytes)} bytes omitted]` };
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(head);
  if (isJson && !truncated) {
    try {
      return { ...base, json: sanitizeJson(JSON.parse(text) as unknown, INLINE_BODY_BYTES) };
    } catch {
      // Not valid JSON after all: returned as text.
    }
  }
  return { ...base, text: sanitizeText(text, INLINE_BODY_BYTES) };
}

async function drain(
  response: Response,
  keep: number,
): Promise<{ head: Uint8Array; bytes: number; complete: boolean }> {
  if (response.body === null) return { head: new Uint8Array(), bytes: 0, complete: true };
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (kept < keep) {
        const part = value.subarray(0, keep - kept);
        chunks.push(part);
        kept += part.byteLength;
      }
    }
  } catch {
    return { head: concatBytes(chunks), bytes, complete: false };
  }
  return { head: concatBytes(chunks), bytes, complete: true };
}

function withCall<T>(fn: () => T, callId: string): T {
  try {
    return fn();
  } catch (error) {
    if (isPaymentError(error)) {
      throw paymentError(error.code, { reason: error.reason, details: error.details, callId });
    }
    throw error;
  }
}
