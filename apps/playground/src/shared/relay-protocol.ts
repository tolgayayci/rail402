/**
 * The wire protocol between the Playground page and its same-origin relay, `POST /api/relay`.
 *
 * The page sends one seller request per relay call: the target and options in `x-relay-*` headers,
 * the seller headers prefixed with `x-relay-h-`, and the raw body. When the seller answered, the relay
 * replies 200 with `x-relay: upstream`, the seller's status and final URL in `x-relay-*` headers, the
 * allowlisted seller headers re-prefixed with `x-relay-h-`, and the seller's body streamed through.
 * When the relay refused or failed before any answer, it replies `x-relay: error` with the code's
 * HTTP status and a JSON error body.
 *
 * Pure: no Node and no DOM APIs, so the server and the page share it.
 */
import type { PlaygroundServerCode } from "./codes.ts";

export const RELAY_PATH = "/api/relay";

/** Request headers that carry the relay call's own parameters. */
export const RELAY_REQUEST = Object.freeze({
  target: "x-relay-target",
  method: "x-relay-method",
  redirect: "x-relay-redirect",
  timeouts: "x-relay-timeouts",
} as const);

/** Response headers that describe the seller's answer. */
export const RELAY_RESPONSE = Object.freeze({
  /** `upstream` when the seller answered, `error` when the relay refused or failed. */
  kind: "x-relay",
  status: "x-relay-status",
  statusText: "x-relay-status-text",
  /** The final URL, after any followed redirect. */
  url: "x-relay-url",
  /** The final method (a 303 turns a POST into a GET). */
  method: "x-relay-method",
  redirected: "x-relay-redirected",
  /** Whether a followed redirect dropped the request body. */
  bodyDropped: "x-relay-body-dropped",
  /** Milliseconds from sending the request to the seller's response headers. */
  ttfbMs: "x-relay-ttfb-ms",
} as const);

/** Prefix of forwarded seller headers, in both directions. */
export const RELAY_HEADER_PREFIX = "x-relay-h-";

/**
 * Seller request headers the page may forward. Cookies, authorization and proxy headers never pass.
 * `mcp-method` and `mcp-name` mirror a JSON-RPC request's method and tool name, as the MCP client
 * sends them on every request.
 */
export const RELAY_REQUEST_HEADERS: readonly string[] = Object.freeze([
  "accept",
  "accept-language",
  "content-type",
  "x-request-id",
  "payment-signature",
  "mcp-session-id",
  "mcp-protocol-version",
  "mcp-method",
  "mcp-name",
  "last-event-id",
]);

/** Seller response headers passed back to the page. Everything else (cookies, location, …) is dropped. */
export const RELAY_RESPONSE_HEADERS: readonly string[] = Object.freeze([
  "content-type",
  "payment-required",
  "payment-response",
  "extension-responses",
  "server-timing",
  "mcp-session-id",
  "mcp-protocol-version",
  "retry-after",
  "cache-control",
]);

export const RELAY_METHODS = Object.freeze(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const);
export type RelayMethod = (typeof RELAY_METHODS)[number];

/** `error` refuses every redirect; `same-origin` follows up to RELAY_MAX_REDIRECTS on the same origin. */
export const RELAY_REDIRECT_MODES = Object.freeze(["error", "same-origin"] as const);
export type RelayRedirectMode = (typeof RELAY_REDIRECT_MODES)[number];
export const RELAY_MAX_REDIRECTS = 3;

export const RELAY_LIMITS = Object.freeze({
  /** Longest relay target URL, in bytes. */
  targetBytes: 2_048,
  /** Largest request body forwarded to a seller. */
  requestBodyBytes: 65_536,
  /** Largest decoded seller body passed back; the stream is cut past it. */
  responseBodyBytes: 1_048_576,
});

/** Per-request timeouts the page may ask for, clamped to the SDK's maxima for a paid request. */
export interface RelayTimeouts {
  readonly headersMs: number;
  readonly idleMs: number;
  readonly totalMs: number;
}

export const RELAY_TIMEOUT_MAXIMA: RelayTimeouts = Object.freeze({
  headersMs: 120_000,
  idleMs: 120_000,
  totalMs: 150_000,
});

/** The user agent the relay and the lab sellers send upstream. */
export function relayUserAgent(version: string, publicUrl: string): string {
  return `rail402-playground/${version} (+${publicUrl.replace(/\/+$/, "")})`;
}

/** One seller request, as the page describes it to the relay. */
export interface RelayRequest {
  readonly target: string;
  readonly method: RelayMethod;
  readonly redirect: RelayRedirectMode;
  readonly timeouts?: Partial<RelayTimeouts> | undefined;
  /** Seller headers by lower-case name; only RELAY_REQUEST_HEADERS are allowed. */
  readonly headers: Readonly<Record<string, string>>;
}

/** The seller's answer, as the relay reports it next to the streamed body. */
export interface RelayResponseMeta {
  readonly status: number;
  readonly statusText: string;
  readonly url: string;
  readonly method: string;
  readonly redirected: boolean;
  readonly bodyDropped: boolean;
  readonly ttfbMs: number;
  /** Allowlisted seller headers by lower-case name. */
  readonly headers: Readonly<Record<string, string>>;
}

/** Body of an `x-relay: error` reply. `details.stage` names the egress stage for `egress_*` codes. */
export interface RelayErrorBody {
  readonly error: {
    readonly code: string;
    readonly reason: string;
    readonly retryable: boolean;
    readonly details?: Readonly<{ stage?: string } & Record<string, unknown>>;
  };
}

export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: PlaygroundServerCode; readonly reason: string };

/** The name a seller header travels under. */
export function forwardedName(name: string): string {
  return `${RELAY_HEADER_PREFIX}${name.toLowerCase()}`;
}

/** Formats timeouts for `x-relay-timeouts`: `headers=…,idle=…,total=…` in milliseconds. */
export function formatTimeouts(timeouts: Partial<RelayTimeouts>): string {
  const parts: string[] = [];
  if (timeouts.headersMs !== undefined) parts.push(`headers=${String(timeouts.headersMs)}`);
  if (timeouts.idleMs !== undefined) parts.push(`idle=${String(timeouts.idleMs)}`);
  if (timeouts.totalMs !== undefined) parts.push(`total=${String(timeouts.totalMs)}`);
  return parts.join(",");
}

const TIMEOUT_KEYS: Readonly<Record<string, keyof RelayTimeouts>> = {
  headers: "headersMs",
  idle: "idleMs",
  total: "totalMs",
};

/** Parses `x-relay-timeouts`, clamping each value to RELAY_TIMEOUT_MAXIMA. */
export function parseTimeouts(value: string): Parsed<Partial<RelayTimeouts>> {
  const timeouts: Partial<Record<keyof RelayTimeouts, number>> = {};
  if (value.trim() === "") return { ok: true, value: timeouts };
  for (const part of value.split(",")) {
    const match = /^\s*([a-z]+)=(\d{1,9})\s*$/.exec(part);
    const key = match?.[1] === undefined ? undefined : TIMEOUT_KEYS[match[1]];
    const ms = Number(match?.[2]);
    if (key === undefined || timeouts[key] !== undefined || !Number.isSafeInteger(ms) || ms < 1) {
      return invalid("x-relay-timeouts must be headers=…,idle=…,total=… in whole milliseconds.");
    }
    timeouts[key] = Math.min(ms, RELAY_TIMEOUT_MAXIMA[key]);
  }
  return { ok: true, value: timeouts };
}

/** The relay call's headers for a seller request (the body is sent as is). */
export function encodeRelayRequest(request: RelayRequest): Record<string, string> {
  const headers: Record<string, string> = {
    [RELAY_REQUEST.target]: request.target,
    [RELAY_REQUEST.method]: request.method,
    [RELAY_REQUEST.redirect]: request.redirect,
  };
  const timeouts = request.timeouts === undefined ? "" : formatTimeouts(request.timeouts);
  if (timeouts !== "") headers[RELAY_REQUEST.timeouts] = timeouts;
  for (const [name, value] of Object.entries(request.headers)) headers[forwardedName(name)] = value;
  return headers;
}

/**
 * Reads a relay call's headers (lower-case names, as both Node and Fetch expose them). Refuses a
 * missing or oversized target, an unknown method or redirect mode, malformed timeouts and any
 * forwarded header off the allowlist. The target's scheme, host and port are judged later by the
 * egress policy.
 */
export function parseRelayRequest(
  headers: Readonly<Record<string, string | undefined>>,
): Parsed<RelayRequest> {
  const target = headers[RELAY_REQUEST.target] ?? "";
  if (target === "" || utf8Length(target) > RELAY_LIMITS.targetBytes || !URL.canParse(target)) {
    return { ok: false, code: "playground_relay_target_invalid", reason: reasonOf(target) };
  }
  const method = (headers[RELAY_REQUEST.method] ?? "").toUpperCase();
  if (!isRelayMethod(method)) {
    return {
      ok: false,
      code: "playground_relay_method_not_allowed",
      reason: "x-relay-method must be one of GET, HEAD, POST, PUT, PATCH or DELETE.",
    };
  }
  const redirect = headers[RELAY_REQUEST.redirect] ?? "error";
  if (!(RELAY_REDIRECT_MODES as readonly string[]).includes(redirect)) {
    return invalid("x-relay-redirect must be error or same-origin.");
  }
  const timeouts = parseTimeouts(headers[RELAY_REQUEST.timeouts] ?? "");
  if (!timeouts.ok) return timeouts;
  const forwarded: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!name.startsWith(RELAY_HEADER_PREFIX) || value === undefined) continue;
    const seller = name.slice(RELAY_HEADER_PREFIX.length);
    if (!RELAY_REQUEST_HEADERS.includes(seller)) {
      return {
        ok: false,
        code: "playground_relay_header_not_allowed",
        reason: `The header ${seller} is not forwarded; allowed: ${RELAY_REQUEST_HEADERS.join(", ")}.`,
      };
    }
    forwarded[seller] = value;
  }
  return {
    ok: true,
    value: {
      target,
      method,
      redirect: redirect as RelayRedirectMode,
      ...(Object.keys(timeouts.value).length === 0 ? {} : { timeouts: timeouts.value }),
      headers: forwarded,
    },
  };
}

/** Headers of a relay reply carrying a seller's answer. Seller headers off the allowlist are dropped. */
export function encodeRelayResponseMeta(meta: RelayResponseMeta): Record<string, string> {
  const headers: Record<string, string> = {
    [RELAY_RESPONSE.kind]: "upstream",
    [RELAY_RESPONSE.status]: String(meta.status),
    [RELAY_RESPONSE.statusText]: headerSafe(meta.statusText),
    [RELAY_RESPONSE.url]: meta.url,
    [RELAY_RESPONSE.method]: meta.method,
    [RELAY_RESPONSE.redirected]: String(meta.redirected),
    [RELAY_RESPONSE.bodyDropped]: String(meta.bodyDropped),
    [RELAY_RESPONSE.ttfbMs]: String(Math.max(0, Math.round(meta.ttfbMs))),
  };
  for (const [name, value] of Object.entries(meta.headers)) {
    const lower = name.toLowerCase();
    if (RELAY_RESPONSE_HEADERS.includes(lower)) headers[forwardedName(lower)] = value;
  }
  return headers;
}

/**
 * Reads a relay reply's headers. Returns `error` for an `x-relay: error` reply (read the JSON body),
 * the seller's answer for `x-relay: upstream`, and undefined for anything else (not a relay reply).
 */
export function parseRelayResponseMeta(
  get: (name: string) => string | null,
): { readonly kind: "error" } | { readonly kind: "upstream"; readonly meta: RelayResponseMeta } | undefined {
  const kind = get(RELAY_RESPONSE.kind);
  if (kind === "error") return { kind: "error" };
  if (kind !== "upstream") return undefined;
  const status = Number(get(RELAY_RESPONSE.status));
  const url = get(RELAY_RESPONSE.url) ?? "";
  if (!Number.isInteger(status) || status < 100 || status > 599 || !URL.canParse(url)) return undefined;
  const headers: Record<string, string> = {};
  for (const name of RELAY_RESPONSE_HEADERS) {
    const value = get(forwardedName(name));
    if (value !== null) headers[name] = value;
  }
  const ttfb = Number(get(RELAY_RESPONSE.ttfbMs));
  return {
    kind: "upstream",
    meta: {
      status,
      statusText: get(RELAY_RESPONSE.statusText) ?? "",
      url,
      method: get(RELAY_RESPONSE.method) ?? "GET",
      redirected: get(RELAY_RESPONSE.redirected) === "true",
      bodyDropped: get(RELAY_RESPONSE.bodyDropped) === "true",
      ttfbMs: Number.isFinite(ttfb) && ttfb >= 0 ? ttfb : 0,
      headers,
    },
  };
}

/** Whether a parsed relay error body has the documented shape. */
export function isRelayErrorBody(value: unknown): value is RelayErrorBody {
  if (value === null || typeof value !== "object") return false;
  const error = (value as { error?: unknown }).error;
  if (error === null || typeof error !== "object") return false;
  const { code, reason, retryable } = error as Record<string, unknown>;
  return (
    typeof code === "string" && typeof reason === "string" && reason !== "" && typeof retryable === "boolean"
  );
}

function isRelayMethod(method: string): method is RelayMethod {
  return (RELAY_METHODS as readonly string[]).includes(method);
}

function invalid(reason: string): { ok: false; code: "playground_request_invalid"; reason: string } {
  return { ok: false, code: "playground_request_invalid", reason };
}

function reasonOf(target: string): string {
  if (target === "") return "x-relay-target is required.";
  if (utf8Length(target) > RELAY_LIMITS.targetBytes) {
    return `x-relay-target is longer than ${String(RELAY_LIMITS.targetBytes)} bytes.`;
  }
  return "x-relay-target is not an absolute URL.";
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** A status text usable as a header value: printable ASCII only, at most 128 characters. */
function headerSafe(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, "").slice(0, 128);
}
