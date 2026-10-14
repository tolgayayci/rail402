import type { Logger } from "pino";
import {
  DEFAULT_TIMEOUTS,
  finalRequestOf,
  isEgressError,
  type EgressStage,
  type SafeRequestInit,
} from "@rail402.dev/safe-fetch";
import type { PlaygroundConfig } from "../config.ts";
import { refuse, type ServerContext } from "../http.ts";
import {
  DailyBudget,
  GLOBAL,
  Gate,
  KeyedSharedRate,
  RateLimiter,
  SharedGate,
  SharedRate,
  type Clock,
} from "../limits.ts";
import { MCP_PAYMENT_META_KEY, isPaymentHeader, mcpPaymentOf } from "../payment-header.ts";
import { codeLabel, type Metrics } from "../metrics.ts";
import { sameOrigin } from "../security.ts";
import type { PlaygroundServerCode } from "../shared/codes.ts";
import {
  RELAY_LIMITS,
  RELAY_RESPONSE,
  RELAY_RESPONSE_HEADERS,
  encodeRelayResponseMeta,
  parseRelayRequest,
  type RelayTimeouts,
} from "../shared/relay-protocol.ts";
import { RelayEgress, type EgressSeams } from "./egress.ts";
import { BodyDeadlineError, readBody, trackBody } from "./wire.ts";

export interface RelayOptions {
  readonly config: PlaygroundConfig;
  readonly metrics: Metrics;
  readonly log: Logger;
  readonly now?: Clock;
  /** Test seams of the egress policy. */
  readonly egress?: EgressSeams;
}

export interface Relay {
  handle(c: ServerContext): Promise<Response>;
  /** Drops idle rate-limit buckets; called periodically. */
  sweep(): void;
  close(): void;
}

/** A rate bucket the relay takes tokens from. */
type Bucket = Pick<RateLimiter, "take" | "refund">;

/** Marks a relay reply that carries a refusal or failure instead of a seller's answer. */
const ERROR_HEADERS = { [RELAY_RESPONSE.kind]: "error" } as const;

/** Egress stages at which nothing was sent to the seller. */
const UNSENT_STAGES: ReadonlySet<EgressStage> = new Set(["url", "dns", "connect", "tls"]);

/**
 * The longest an unpaid, non-streamed request may wait: the SDK's own probe timeouts. Only a paid
 * request (the seller verifies and settles before answering) or a stream may ask for more.
 */
export const UNPAID_TIMEOUT_MAXIMA: RelayTimeouts = Object.freeze({
  headersMs: DEFAULT_TIMEOUTS.headersMs,
  idleMs: DEFAULT_TIMEOUTS.idleMs,
  totalMs: DEFAULT_TIMEOUTS.totalMs,
});

/** Time past a body's total timeout before a body the page stopped reading is cut. */
const BODY_DEADLINE_MARGIN_MS = 10_000;

/** Media types of request bodies the relay forwards; the SDK and MCP send nothing else. */
export const FORWARDED_BODY_TYPES = Object.freeze([
  "application/json",
  "text/plain",
  "application/octet-stream",
] as const);

/** Whether a body with this content type is forwarded; a body without one is. */
function forwardableBody(contentType: string | undefined): boolean {
  if (contentType === undefined) return true;
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return (FORWARDED_BODY_TYPES as readonly string[]).includes(type);
}

/**
 * The timeouts a request is sent with: the page's, clamped to the SDK probe timeouts unless the
 * request is paid or a stream; a stream lasts at most `streamMaxMs`.
 */
export function timeoutsFor(
  asked: Partial<RelayTimeouts> | undefined,
  options: { readonly isPaid: boolean; readonly isStream: boolean; readonly streamMaxMs: number },
): { -readonly [K in keyof RelayTimeouts]?: number } {
  const timeouts: { -readonly [K in keyof RelayTimeouts]?: number } = { ...asked };
  if (!options.isPaid && !options.isStream) {
    for (const key of ["headersMs", "idleMs", "totalMs"] as const) {
      timeouts[key] = Math.min(timeouts[key] ?? UNPAID_TIMEOUT_MAXIMA[key], UNPAID_TIMEOUT_MAXIMA[key]);
    }
  }
  if (options.isStream) {
    timeouts.totalMs = Math.min(timeouts.totalMs ?? options.streamMaxMs, options.streamMaxMs);
  }
  return timeouts;
}

/**
 * `POST /api/relay`: sends one seller request for the Playground page and streams the answer back.
 *
 * In order: the kill switch; the same-origin check; the relay headers (target, method, redirect mode,
 * timeouts, allowlisted forwarded headers); a payment header, which must hold an x402 payment; the
 * loop and deny lists; the daily bytes (per client, per network and in total); the in-flight slots
 * (per client, per network, per destination host) and stream slots; the body (at most 64 KiB, of a
 * JSON, text or octet-stream type); an MCP payment in the body, which makes the request paid; the
 * per-client and per-network rates, the paid pool (the trusted hosts have their own) and the per-host
 * rate; then the request itself through safe-fetch. Global limits are fair-shared: one network (an
 * IPv4 address or an IPv6 /48) holds at most its share. An unpaid request waits no longer than the
 * SDK's probe timeouts unless it is a stream. A paid request never follows a redirect. A client that
 * disconnects aborts the upstream request; one that abandons its upload or stops reading the answer
 * gives its slots back.
 *
 * Nothing about the target beyond its host, and no header or body, is logged.
 */
export function createRelay(options: RelayOptions): Relay {
  const { config, metrics, log } = options;
  const limits = config.limits;
  const now = options.now ?? Date.now;
  const egress = new RelayEgress(config, options.egress);
  const unpaid = new RateLimiter(limits.relayUnpaidPerMinute, limits.relayUnpaidBurst, now);
  const unpaidNetwork = new RateLimiter(
    limits.relayUnpaidPerNetworkPerMinute,
    limits.relayUnpaidPerNetworkPerMinute,
    now,
  );
  const paid = new RateLimiter(limits.relayPaidPerMinute, limits.relayPaidPerMinute, now);
  const paidGlobal = new SharedRate(limits.relayPaidGlobalPerMinute, limits.relayPaidPerMinute, now);
  const trustedPaidGlobal = new SharedRate(
    limits.relayTrustedPaidGlobalPerMinute,
    limits.relayPaidPerMinute,
    now,
  );
  const perHost = new KeyedSharedRate(limits.relayHostPerMinute, limits.relayUnpaidPerMinute, now);
  const perTrustedHost = new KeyedSharedRate(
    limits.relayTrustedHostPerMinute,
    limits.relayUnpaidPerMinute,
    now,
  );
  const inFlight = new Gate(limits.relayInFlightPerIp);
  const inFlightGlobal = new SharedGate(limits.relayInFlightGlobal, limits.relayInFlightPerIp);
  const inFlightHost = new Gate(limits.relayInFlightPerHost);
  const streams = new Gate(limits.relayStreamsPerIp);
  const bytes = new DailyBudget(limits.relayBytesPerIpPerDay, now);
  const networkBytes = new DailyBudget(limits.relayBytesPerNetworkPerDay, now);
  const globalBytes = new DailyBudget(limits.relayBytesGlobalPerDay, now);

  const fail = (
    c: ServerContext,
    code: PlaygroundServerCode,
    isPaid: boolean,
    extra: { reason?: string; retryAfter?: number; limit?: string } = {},
  ): Response => {
    metrics.relayRequests.inc({ outcome: code, paid: String(isPaid) });
    if (extra.limit !== undefined) metrics.rateLimited.inc({ limit: extra.limit });
    return refuse(c, code, {
      reason: extra.reason,
      retryAfter: extra.retryAfter,
      headers: ERROR_HEADERS,
    });
  };

  /**
   * Takes a token from each bucket in turn. On a refusal it returns the ones taken and says which limit
   * refused; otherwise it gives a way to return them all, for a request refused by a later check.
   */
  const takeAll = (
    buckets: readonly (readonly [Bucket, string, string])[],
  ):
    | { readonly ok: true; readonly refund: () => void }
    | { readonly ok: false; readonly limit: string; readonly retryAfter: number } => {
    const taken: (readonly [Bucket, string])[] = [];
    const refundAll = () => {
      for (const [done, doneKey] of taken.splice(0)) done.refund(doneKey);
    };
    for (const [bucket, key, limit] of buckets) {
      const retryAfter = bucket.take(key);
      if (retryAfter > 0) {
        refundAll();
        return { ok: false, limit, retryAfter };
      }
      taken.push([bucket, key]);
    }
    return { ok: true, refund: refundAll };
  };

  const handle = async (c: ServerContext): Promise<Response> => {
    const requestLog = c.get("requestLog");
    const client = c.get("clientKey");
    const network = c.get("networkKey");
    if (!config.features.relay) return fail(c, "playground_feature_disabled", false);
    if (!sameOrigin(c.req.raw.headers, config.publicUrl)) {
      return fail(c, "playground_origin_not_allowed", false);
    }
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, name) => {
      headers[name] = value;
    });
    const parsed = parseRelayRequest(headers);
    if (!parsed.ok) return fail(c, parsed.code, false, { reason: parsed.reason });
    const request = parsed.value;
    const signature = request.headers["payment-signature"];
    let isPaid = signature !== undefined;
    // Only a real payment counts against the paid limits every visitor shares.
    if (isPaid && !isPaymentHeader(signature ?? "")) {
      return fail(c, "playground_request_invalid", false, {
        reason: "PAYMENT-SIGNATURE does not hold an x402 version 2 payment payload.",
      });
    }
    const verdict = egress.judge(request.target);
    if (!verdict.ok) return fail(c, verdict.code, isPaid, { reason: verdict.reason });
    requestLog.fields["host"] = verdict.host;

    for (const [budget, key, what] of [
      [bytes, client, "This client used up its daily relay transfer budget."],
      [networkBytes, network, "This network used up its daily relay transfer budget."],
      [globalBytes, GLOBAL, "The relay used up its daily transfer budget."],
    ] as const) {
      const exhausted = budget.check(key);
      if (exhausted > 0) {
        return fail(c, "playground_rate_limited", isPaid, {
          reason: what,
          retryAfter: exhausted,
          limit: "relay_bytes",
        });
      }
    }

    // The in-flight slots are taken before the body is read, so a slow upload holds one of its own.
    // Every exit releases them, except a body handed to the page, which releases them when it ends.
    const accept = request.headers["accept"] ?? "";
    const isStream = /text\/event-stream/i.test(accept);
    const releases: (() => void)[] = [];
    const releaseAll = () => {
      for (const release of releases.splice(0)) release();
    };
    for (const [gate, key, what] of [
      [inFlight, client, "relay_in_flight"],
      [inFlightGlobal, network, "relay_in_flight_global"],
      [inFlightHost, verdict.host, "relay_in_flight_host"],
      ...(isStream ? ([[streams, client, "relay_streams"]] as const) : []),
    ] as const) {
      const release = gate.enter(key);
      if (release === undefined) {
        releaseAll();
        metrics.rateLimited.inc({ limit: what });
        return fail(c, "playground_relay_busy", isPaid);
      }
      releases.push(release);
    }
    let handedOff = false;
    try {
      const read = await readBody(c.req.raw, RELAY_LIMITS.requestBodyBytes);
      if (!read.ok) {
        if (read.reason === "aborted") {
          requestLog.fields["code"] = "client_closed";
          metrics.relayRequests.inc({ outcome: "client_closed", paid: String(isPaid) });
          return new Response(null, { status: 499 });
        }
        return fail(c, "playground_request_too_large", isPaid, {
          reason: `The relayed request body exceeds ${String(RELAY_LIMITS.requestBodyBytes)} bytes.`,
        });
      }
      if (read.body !== undefined && (request.method === "GET" || request.method === "HEAD")) {
        return fail(c, "playground_request_invalid", isPaid, {
          reason: `A ${request.method} request cannot carry a body.`,
        });
      }
      if (read.body !== undefined && !forwardableBody(request.headers["content-type"])) {
        return fail(c, "playground_request_invalid", isPaid, {
          reason: `The relay forwards a body only as ${FORWARDED_BODY_TYPES.join(", ")}.`,
        });
      }
      // An MCP tool call carries its payment in the JSON-RPC body: it is a paid request too.
      const mcpPayment = mcpPaymentOf(read.body);
      if (mcpPayment === "invalid") {
        return fail(c, "playground_request_invalid", false, {
          reason: `params._meta["${MCP_PAYMENT_META_KEY}"] does not hold an x402 version 2 payment payload.`,
        });
      }
      isPaid ||= mcpPayment === "payment";
      requestLog.fields["paid"] = isPaid;

      const paidPool = verdict.trusted ? trustedPaidGlobal : paidGlobal;
      const taken = takeAll(
        isPaid
          ? [
              [paid, client, "relay_paid"],
              [paidPool, network, "relay_paid_global"],
            ]
          : [
              [unpaid, client, "relay_unpaid"],
              [unpaidNetwork, network, "relay_unpaid_network"],
            ],
      );
      if (!taken.ok) {
        return fail(c, "playground_rate_limited", isPaid, taken);
      }
      const hostRate = verdict.trusted ? perTrustedHost : perHost;
      const hostRetry = hostRate.take(verdict.host, network);
      if (hostRetry > 0) {
        // Nothing was sent: the client's tokens go back.
        taken.refund();
        metrics.rateLimited.inc({ limit: "relay_host" });
        metrics.relayRequests.inc({ outcome: "playground_relay_host_busy", paid: String(isPaid) });
        return refuse(c, "playground_relay_host_busy", {
          retryAfter: hostRetry,
          headers: ERROR_HEADERS,
        });
      }

      const timeouts = timeoutsFor(request.timeouts, {
        isPaid,
        isStream,
        streamMaxMs: limits.relayStreamMaxMs,
      });
      const init: SafeRequestInit = {
        method: request.method,
        headers: request.headers,
        body: read.body ?? null,
        signal: c.req.raw.signal,
        redirect: isPaid ? "error" : request.redirect,
        timeouts,
      };

      const started = performance.now();
      let response: Response;
      try {
        response = await egress.fetchFor(verdict.url, verdict.trusted)(verdict.url, init);
      } catch (error) {
        if (c.req.raw.signal.aborted) {
          requestLog.fields["code"] = "client_closed";
          metrics.relayRequests.inc({ outcome: "client_closed", paid: String(isPaid) });
          return new Response(null, { status: 499 });
        }
        if (isEgressError(error)) {
          // Nothing reached a seller: the shared paid pool gets its token back (the client's stays
          // spent, so this cannot be repeated faster than the client's own paid rate).
          if (isPaid && UNSENT_STAGES.has(error.stage)) paidPool.refund(network);
          requestLog.fields["code"] = error.code;
          requestLog.fields["stage"] = error.stage;
          metrics.relayRequests.inc({ outcome: codeLabel(error.code), paid: String(isPaid) });
          return new Response(
            JSON.stringify({
              error: {
                code: error.code,
                reason: error.reason,
                retryable: error.retryable,
                details: { stage: error.stage },
              },
            }),
            {
              status: error.status,
              headers: { "content-type": "application/json", "cache-control": "no-store", ...ERROR_HEADERS },
            },
          );
        }
        if (error instanceof TypeError) {
          // safe-fetch refuses a header value or method fetch cannot send before contacting anyone.
          return fail(c, "playground_request_invalid", isPaid, {
            reason: "A forwarded header value or the method cannot be sent.",
          });
        }
        log.error({ err: error, reqId: c.get("requestId") }, "relay failed unexpectedly");
        return fail(c, "playground_internal_error", isPaid);
      }

      const ttfbMs = performance.now() - started;
      metrics.relayUpstreamLatency.observe({ paid: String(isPaid) }, ttfbMs / 1_000);
      metrics.relayRequests.inc({ outcome: "upstream", paid: String(isPaid) });
      const final = finalRequestOf(response);
      const sellerHeaders: Record<string, string> = {};
      for (const name of RELAY_RESPONSE_HEADERS) {
        const value = response.headers.get(name);
        if (value !== null) sellerHeaders[name] = value;
      }
      const meta = encodeRelayResponseMeta({
        status: response.status,
        statusText: response.statusText,
        url: response.url,
        method: final?.method ?? request.method,
        redirected: response.redirected,
        bodyDropped: final?.bodyDropped ?? false,
        ttfbMs,
        headers: sellerHeaders,
      });
      requestLog.fields["upstreamStatus"] = response.status;

      let received = 0;
      const finish = (stage?: string) => {
        releaseAll();
        requestLog.write({ bytes: received, ...(stage === undefined ? {} : { stage }) });
      };
      let body: ReadableStream<Uint8Array> | null = null;
      if (response.body !== null) {
        requestLog.deferred = true;
        body = trackBody(
          response.body,
          (size) => {
            received += size;
            bytes.add(client, size);
            networkBytes.add(network, size);
            globalBytes.add(GLOBAL, size);
            metrics.relayResponseBytes.inc(size);
          },
          (end) => {
            if (end.kind === "error") {
              const error = end.error;
              if (isEgressError(error)) requestLog.fields["code"] = error.code;
              else if (error instanceof BodyDeadlineError) requestLog.fields["code"] = "body_not_read";
              finish(isEgressError(error) ? error.stage : "response");
            } else {
              if (end.kind === "cancelled") requestLog.fields["code"] = "client_closed";
              finish();
            }
          },
          // The seller's body ends within its total timeout; a page that stops reading it does not
          // keep the slots past that.
          (timeouts.totalMs ?? DEFAULT_TIMEOUTS.totalMs) + BODY_DEADLINE_MARGIN_MS,
        );
        handedOff = true;
      }
      return new Response(body, {
        status: 200,
        headers: {
          ...meta,
          "content-type": "application/octet-stream",
          "cache-control": "no-store",
        },
      });
    } finally {
      if (!handedOff) releaseAll();
    }
  };

  return {
    handle,
    sweep() {
      for (const bucket of [
        unpaid,
        unpaidNetwork,
        paid,
        paidGlobal,
        trustedPaidGlobal,
        perHost,
        perTrustedHost,
      ]) {
        bucket.sweep();
      }
    },
    close() {
      egress.close();
    },
  };
}
