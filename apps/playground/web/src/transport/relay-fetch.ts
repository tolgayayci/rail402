/**
 * The seller transport over the Playground's same-origin relay (`POST /api/relay`). A browser cannot
 * open SSRF-safe connections or send `PAYMENT-SIGNATURE` across origins, so every seller other than
 * the Playground's own lab sellers is reached through the relay, which applies safe-fetch on the
 * server. This fetch implements the `SafeFetch` contract the SDK's payment flows expect:
 *
 * - an answer from the seller becomes a native `Response` with the seller's status, allowlisted
 *   headers, final URL and streamed body, registered with `markFinalRequest`;
 * - an `egress_*` refusal of the relay becomes the same `EgressError`, at the stage the relay names;
 * - any other refusal of the relay (`playground_*`, such as a rate limit) happened before the seller
 *   was contacted: it becomes `egress_connection_failed` at stage `connect`, with the relay's code in
 *   `details.relay`;
 * - losing the relay itself is stage `connect`, except for a paid request, whose outcome is then
 *   unknown (stage `response`). A request is paid when it carries `PAYMENT-SIGNATURE` or, for an MCP
 *   tool call, a JSON-RPC body with a payment in `params._meta["x402/payment"]`.
 */
import {
  EgressError,
  egressCodes,
  markFinalRequest,
  type EgressCode,
  type EgressPolicy,
  type EgressStage,
  type SafeFetch,
  type SafeRequestInit,
} from "@rail402.dev/safe-fetch/shared";
import {
  RELAY_METHODS,
  RELAY_REQUEST_HEADERS,
  RELAY_TIMEOUT_MAXIMA,
  encodeRelayRequest,
  isRelayErrorBody,
  parseRelayResponseMeta,
  type RelayMethod,
  type RelayTimeouts,
} from "../../../src/shared/relay-protocol.ts";
import { mcpRequestOf } from "../engine/decode.ts";
import { abortedByCaller, bodyBytes, copyBytes, headerBytes, readJson, withTimeout } from "./body.ts";

export interface RelayFetchOptions {
  /** The relay's absolute URL: the Playground origin plus `RELAY_PATH`. */
  readonly relayUrl: string;
  /** The policy the transport reports; the relay enforces the server's own. */
  readonly policy: EgressPolicy;
  /**
   * Refuse ports outside the policy before sending. Off in local mode, where the relay reaches any
   * loopback port.
   */
  readonly checkPorts?: boolean;
  readonly fetch?: typeof fetch;
}

const EGRESS_STAGES: readonly EgressStage[] = [
  "url",
  "dns",
  "connect",
  "tls",
  "request",
  "redirect",
  "response",
];
/** Statuses whose response has no body. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);
/** Largest relay error body read. */
const ERROR_BODY_BYTES = 65_536;
/** Time on top of the seller's own total timeout before the page gives up on the relay. */
const RELAY_MARGIN_MS = 10_000;
const PAYMENT_HEADER = "payment-signature";

/** A refusal the relay would make, raised before sending (`details.relay` holds its code). */
export function relayRefusal(code: string, reason: string): EgressError {
  return new EgressError("egress_connection_failed", "connect", { reason, details: { relay: code } });
}

/** The relay's code of an egress error raised by this transport, when it came from the relay. */
export function relayCodeOf(error: EgressError): string | undefined {
  const relay = error.details?.["relay"];
  return typeof relay === "string" ? relay : undefined;
}

export function createRelayFetch(options: RelayFetchOptions): SafeFetch {
  const { relayUrl, policy } = options;
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);
  const checkPorts = options.checkPorts ?? true;

  const relayFetch = async (input: string | URL, init: SafeRequestInit = {}): Promise<Response> => {
    const target = checkTarget(typeof input === "string" ? input : input.href, policy, checkPorts);
    const method = (init.method ?? "GET").toUpperCase();
    if (!(RELAY_METHODS as readonly string[]).includes(method)) {
      throw relayRefusal(
        "playground_relay_method_not_allowed",
        "The relay forwards only GET, HEAD, POST, PUT, PATCH and DELETE.",
      );
    }
    const headers = new Headers(init.headers);
    const forwarded: Record<string, string> = {};
    for (const [header, value] of headers) {
      const name = header.toLowerCase();
      if (!RELAY_REQUEST_HEADERS.includes(name)) {
        throw relayRefusal(
          "playground_relay_header_not_allowed",
          `The header ${name} is not forwarded; allowed: ${RELAY_REQUEST_HEADERS.join(", ")}.`,
        );
      }
      forwarded[name] = value;
    }
    if (headerBytes(headers, [PAYMENT_HEADER]) > policy.limits.requestHeaderBytes) {
      throw new EgressError("egress_request_too_large", "request", {
        reason: `The request headers exceed ${String(policy.limits.requestHeaderBytes)} bytes.`,
      });
    }
    const body = init.body ?? null;
    if (bodyBytes(body) > policy.limits.requestBodyBytes) {
      throw new EgressError("egress_request_too_large", "request", {
        reason: `The request body exceeds ${String(policy.limits.requestBodyBytes)} bytes.`,
      });
    }
    const paid = headers.has(PAYMENT_HEADER) || carriesMcpPayment(body);
    const timeouts = clampTimeouts(init.timeouts);
    const signal = withTimeout(init.signal, (timeouts.totalMs ?? policy.timeouts.totalMs) + RELAY_MARGIN_MS);
    if (init.signal?.aborted === true) throw init.signal.reason;

    let response: Response;
    try {
      response = await send(relayUrl, {
        method: "POST",
        headers: encodeRelayRequest({
          target: target.href,
          method: method as RelayMethod,
          // A paid request is never redirected: the payment would follow it elsewhere.
          redirect: paid ? "error" : (init.redirect ?? policy.redirects.mode),
          timeouts,
          headers: forwarded,
        }),
        ...(body === null ? {} : { body: typeof body === "string" ? body : copyBytes(body) }),
        signal,
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
      });
    } catch (error) {
      if (abortedByCaller(init.signal)) throw init.signal?.reason ?? error;
      throw new EgressError(
        signal.aborted ? "egress_timeout" : "egress_connection_failed",
        paid ? "response" : "connect",
        { reason: "The Playground relay could not be reached." },
      );
    }

    const parsed = parseRelayResponseMeta((name) => response.headers.get(name));
    if (parsed?.kind !== "upstream") {
      throw await relayError(response, parsed === undefined, paid);
    }
    const { meta } = parsed;
    if (meta.status < 200 || meta.status > 599) {
      await response.body?.cancel().catch(() => undefined);
      throw new EgressError("egress_connection_failed", "response", {
        reason: `The seller answered with HTTP ${String(meta.status)}, which is not a final response.`,
      });
    }
    const empty = NULL_BODY_STATUSES.has(meta.status) || method === "HEAD";
    if (empty) await response.body?.cancel().catch(() => undefined);
    const answer = new Response(empty ? null : response.body, {
      status: meta.status,
      statusText: meta.statusText,
      headers: meta.headers,
    });
    Object.defineProperty(answer, "url", { value: meta.url });
    Object.defineProperty(answer, "redirected", { value: meta.redirected });
    markFinalRequest(answer, { method: meta.method, bodyDropped: meta.bodyDropped });
    return answer;
  };

  return Object.assign(relayFetch, { policy, close: () => undefined });
}

/** Whether a request body is an MCP tool call carrying its payment in the JSON-RPC message. */
function carriesMcpPayment(body: SafeRequestInit["body"]): boolean {
  if (typeof body !== "string" && !(body instanceof Uint8Array)) return false;
  return mcpRequestOf(body)?.view.hasPayment === true;
}

/** The syntactic checks safe-fetch makes before connecting; the relay judges the destination. */
function checkTarget(input: string, policy: EgressPolicy, checkPorts: boolean): URL {
  const invalid = (reason: string) => new EgressError("egress_url_invalid", "url", { reason });
  if (input === "") throw invalid("The URL is empty.");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(input)) throw invalid("The URL contains control characters.");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw invalid("The URL is not an absolute URL.");
  }
  if (new TextEncoder().encode(url.href).byteLength > policy.limits.urlBytes) {
    throw invalid(`The URL exceeds ${String(policy.limits.urlBytes)} bytes.`);
  }
  if (url.username !== "" || url.password !== "") throw invalid("The URL must not contain credentials.");
  if (!(policy.schemes as readonly string[]).includes(url.protocol)) {
    throw new EgressError("egress_scheme_not_allowed", "url", {
      reason: `The scheme ${url.protocol.replace(":", "")} is not allowed; allowed: ${policy.schemes
        .map((scheme) => scheme.replace(":", ""))
        .join(", ")}.`,
    });
  }
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (checkPorts && !policy.ports.includes(port)) {
    throw new EgressError("egress_port_not_allowed", "url", {
      reason: `Port ${String(port)} is not allowed; allowed: ${policy.ports.join(", ")}.`,
    });
  }
  return url;
}

function clampTimeouts(timeouts: SafeRequestInit["timeouts"]): Partial<RelayTimeouts> {
  const clamped: { -readonly [K in keyof RelayTimeouts]?: number } = {};
  if (timeouts?.headersMs !== undefined) {
    clamped.headersMs = Math.min(timeouts.headersMs, RELAY_TIMEOUT_MAXIMA.headersMs);
  }
  if (timeouts?.idleMs !== undefined) {
    clamped.idleMs = Math.min(timeouts.idleMs, RELAY_TIMEOUT_MAXIMA.idleMs);
  }
  if (timeouts?.totalMs !== undefined) {
    clamped.totalMs = Math.min(timeouts.totalMs, RELAY_TIMEOUT_MAXIMA.totalMs);
  }
  return clamped;
}

/** The error an `x-relay: error` reply (or an answer that is no relay reply at all) stands for. */
async function relayError(response: Response, foreign: boolean, paid: boolean): Promise<EgressError> {
  const unknownStage: EgressStage = paid ? "response" : "connect";
  if (foreign) {
    await response.body?.cancel().catch(() => undefined);
    return new EgressError("egress_connection_failed", unknownStage, {
      reason: `The Playground relay answered HTTP ${String(response.status)} without a relay reply.`,
    });
  }
  const body = await readJson(response.body, ERROR_BODY_BYTES);
  if (!isRelayErrorBody(body)) {
    return new EgressError("egress_connection_failed", unknownStage, {
      reason: "The Playground relay failed without a readable error.",
    });
  }
  const { code, reason } = body.error;
  if (Object.hasOwn(egressCodes, code)) {
    const stage = body.error.details?.stage;
    return new EgressError(code as EgressCode, isStage(stage) ? stage : "connect", { reason });
  }
  return relayRefusal(code, reason);
}

function isStage(value: unknown): value is EgressStage {
  return typeof value === "string" && (EGRESS_STAGES as readonly string[]).includes(value);
}

/** A copy of the bytes in a buffer of their own, as `fetch` wants a plain ArrayBuffer view. */
