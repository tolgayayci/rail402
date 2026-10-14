import type { LookupAddress } from "node:dns";
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import type { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { ipLiteral } from "./address.ts";
import { EgressError, type EgressStage } from "./codes.ts";
import { resolvePolicy, type EgressPolicy, type EgressPolicyInput, type EgressTimeouts } from "./limits.ts";
import { REFUSED_LOOKUP, pinnedLookup } from "./lookup.ts";
import { REDIRECT_STATUSES, nextHop } from "./redirect.ts";
import { markFinalRequest, type HeadersLike, type SafeFetch, type SafeRequestInit } from "./shared.ts";
import { addressClassifier, checkUrl } from "./url.ts";

/** Request headers the caller cannot set: they belong to the connection, and are set here or dropped. */
const DROPPED_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
  "expect",
  "accept-encoding",
]);
/** Not counted against the caller's header budget: an x402 payment header is large by design. */
const UNCOUNTED_HEADERS = new Set(["payment-signature"]);
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const NORMALIZED_METHODS = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);
const FORBIDDEN_METHODS = new Set(["CONNECT", "TRACE", "TRACK"]);
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);
const DNS_ERRORS = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_FAIL",
  "EAI_NONAME",
  "EAI_NODATA",
  "ENODATA",
  "ESERVFAIL",
  "ENOTIMP",
  "EBADNAME",
  "ETIMEOUT",
]);
/** Hosts whose validated addresses are remembered for the connected-address check. */
const MAX_REMEMBERED_HOSTS = 1_024;

/**
 * Creates a fetch for untrusted URLs on `node:http(s)`:
 *
 * 1. The URL is checked before any lookup: scheme, port, credentials, size, and the host. IP literals
 *    are classified here, because Node skips a custom `lookup` for them.
 * 2. Request headers and body are size-checked; nothing is sent when they are over the limit.
 * 3. Connections resolve through `pinnedLookup`, which refuses a host if any of its addresses is
 *    private, and dial only the validated addresses. Environment proxies are never used.
 * 4. Once connected, the socket's remote address must be one the lookup validated for that host.
 * 5. Response headers and the decoded body are capped; gzip, deflate and br are decoded.
 * 6. Redirects are refused unless the request opts into same-origin redirects, which are then
 *    followed up to the policy's maximum, each hop checked again.
 * 7. Connect, headers, idle and total timeouts apply, and the caller's signal aborts.
 * 8. Connections are bounded per host and in total; a kept connection closes when it sits unused.
 *
 * Errors name the host and the class of problem, never a resolved address.
 */
export function createSafeFetch(input: EgressPolicyInput = {}): SafeFetch {
  const policy = resolvePolicy(input);
  const isAllowed = addressClassifier(policy);
  const validated = new Map<string, Set<string>>();
  const checkedSockets = new WeakSet<Socket>();
  const observe = (hostname: string, addresses: readonly LookupAddress[]) => {
    let known = validated.get(hostname);
    if (known === undefined) {
      if (validated.size >= MAX_REMEMBERED_HOSTS) {
        const [oldest] = validated.keys();
        if (oldest !== undefined) validated.delete(oldest);
      }
      known = new Set();
      validated.set(hostname, known);
    }
    for (const entry of addresses) known.add(normalizeAddress(entry.address));
  };
  const lookup = pinnedLookup(isAllowed, policy.resolve, observe);
  // `timeout` on the agent is the idle limit of a kept connection: Node closes a free socket that
  // stays unused that long. A request in progress sets its own socket timeout.
  const agentOptions = {
    keepAlive: policy.keepAlive,
    maxSockets: policy.maxSocketsPerHost,
    maxTotalSockets: policy.maxTotalSockets,
    maxFreeSockets: policy.maxFreeSocketsPerHost,
    timeout: policy.idleSocketMs,
    lookup,
  };
  const agents = { "http:": new HttpAgent(agentOptions), "https:": new HttpsAgent(agentOptions) };

  /** Whether a connected socket reached an address this fetch validated for the URL's host. */
  const remoteAllowed = (socket: Socket, url: URL): boolean => {
    if (checkedSockets.has(socket)) return true;
    const remote = socket.remoteAddress;
    if (remote === undefined) return false;
    const address = normalizeAddress(remote);
    if (!isAllowed(address)) return false;
    const literal = ipLiteral(url.hostname);
    const allowed = literal !== undefined || validated.get(url.hostname)?.has(address) === true;
    if (allowed) checkedSockets.add(socket);
    return allowed;
  };

  const exchange = (request: Outgoing): Promise<Exchanged> =>
    new Promise((resolve, reject) => {
      const { url, timeouts, signals } = request;
      let stage: EgressStage = "connect";
      let settled = false;
      let idleAfterHeaders = false;
      const timers = new Set<NodeJS.Timeout>();
      const startTimer = (ms: number, error: () => EgressError) => {
        const timer = setTimeout(() => {
          fail(error());
        }, ms);
        timers.add(timer);
        return timer;
      };
      const stopTimers = () => {
        for (const timer of timers) clearTimeout(timer);
        timers.clear();
      };
      const onAbort = () => {
        fail(signals.reason());
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        stopTimers();
        signals.combined.removeEventListener("abort", onAbort);
        outgoing.destroy();
        reject(error);
      };

      const send = url.protocol === "https:" ? httpsRequest : httpRequest;
      const outgoing = send(
        url,
        {
          method: request.method,
          headers: headerObject(request.headers),
          agent: url.protocol === "https:" ? agents["https:"] : agents["http:"],
          lookup,
          maxHeaderSize: policy.limits.responseHeaderBytes,
          // Until the headers arrive the server may be working (a paid request settles first), so the
          // socket may stay silent as long as the headers timeout allows; after them, idleMs applies.
          timeout: Math.max(timeouts.idleMs, timeouts.headersMs),
        },
        (response) => {
          if (settled) {
            response.destroy();
            return;
          }
          if (!remoteAllowed(response.socket, url)) {
            response.destroy();
            fail(notAllowedRemote(url));
            return;
          }
          outgoing.setTimeout(timeouts.idleMs);
          settled = true;
          stopTimers();
          signals.combined.removeEventListener("abort", onAbort);
          resolve({ message: response, idleTimedOut: () => idleAfterHeaders });
        },
      );

      startTimer(timeouts.headersMs, () => timeout("headers", stage));
      outgoing.on("socket", (socket: Socket) => {
        if (!socket.connecting) {
          stage = "request";
          return;
        }
        const connectTimer = startTimer(timeouts.connectMs, () => timeout("connect", stage));
        // Registered before the request is flushed, so nothing is written to a refused address.
        socket.once("connect", () => {
          if (!remoteAllowed(socket, url)) {
            fail(notAllowedRemote(url));
            return;
          }
          if (url.protocol === "https:") {
            stage = "tls";
          } else {
            clearTimeout(connectTimer);
            stage = "request";
          }
        });
        socket.once("secureConnect", () => {
          clearTimeout(connectTimer);
          stage = "request";
        });
      });
      outgoing.on("timeout", () => {
        if (!settled) {
          fail(timeout("idle", stage));
          return;
        }
        // While the body streams, an idle socket ends the response with egress_timeout.
        idleAfterHeaders = true;
        outgoing.destroy();
      });
      outgoing.on("error", (error: NodeJS.ErrnoException) => {
        fail(signals.combined.aborted ? signals.reason() : classify(error, stage));
      });
      if (signals.combined.aborted) {
        onAbort();
        return;
      }
      signals.combined.addEventListener("abort", onAbort, { once: true });
      outgoing.end(request.body);
    });

  const safeFetch = async (input: string | URL, init: SafeRequestInit = {}): Promise<Response> => {
    let url = checkUrl(input, policy);
    let method = normalizeMethod(init.method ?? "GET");
    let headers = requestHeaders(init.headers, policy);
    let body = requestBody(init.body, method, headers, policy);
    let bodyDropped = false;
    const timeouts = { ...policy.timeouts, ...init.timeouts };
    const mode = init.redirect ?? policy.redirects.mode;
    const signals = requestSignals(init.signal, timeouts.totalMs);
    if (signals.combined.aborted) throw signals.reason();

    for (let hops = 0; ; hops++) {
      const { message: response, idleTimedOut } = await exchange({
        url,
        method,
        headers,
        body,
        timeouts,
        signals,
      });
      const location = response.headers.location;
      const status = response.statusCode ?? 0;
      if (REDIRECT_STATUSES.has(status) && typeof location === "string") {
        discard(response);
        if (mode === "error") {
          throw new EgressError("egress_redirect_not_allowed", "redirect", {
            reason: `The server answered with a ${String(status)} redirect, and redirects are not followed.`,
          });
        }
        if (hops >= policy.redirects.max) {
          throw new EgressError("egress_too_many_redirects", "redirect", {
            reason: `The server redirected more than ${String(policy.redirects.max)} times.`,
          });
        }
        const hop = nextHop(url, status, location, method, policy);
        url = hop.url;
        method = hop.method;
        if (hop.dropBody) {
          bodyDropped = bodyDropped || body !== undefined;
          body = undefined;
          headers = headers.filter(([name]) => !name.startsWith("content-"));
        }
        continue;
      }
      const answered = toResponse(response, {
        url,
        method,
        redirected: hops > 0,
        idleTimedOut,
        signals,
        policy,
      });
      markFinalRequest(answered, { method, bodyDropped });
      return answered;
    }
  };

  return Object.assign(safeFetch, {
    policy,
    close: () => {
      agents["http:"].destroy();
      agents["https:"].destroy();
    },
  });
}

interface Exchanged {
  readonly message: IncomingMessage;
  /** Whether the socket went idle after the headers arrived. */
  readonly idleTimedOut: () => boolean;
}

/** Reads and drops a response body so its connection can be reused. */
function discard(message: IncomingMessage): void {
  message.on("error", () => undefined);
  message.resume();
}

interface Signals {
  readonly combined: AbortSignal;
  /** The error a request rejects with once `combined` has aborted. */
  readonly reason: () => Error;
}

interface Outgoing {
  readonly url: URL;
  readonly method: string;
  readonly headers: [string, string][];
  readonly body: Uint8Array | undefined;
  readonly timeouts: EgressTimeouts;
  readonly signals: Signals;
}

function requestSignals(caller: AbortSignal | undefined, totalMs: number): Signals {
  const total = AbortSignal.timeout(totalMs);
  const combined = caller === undefined ? total : AbortSignal.any([caller, total]);
  return {
    combined,
    reason: () =>
      caller?.aborted === true
        ? (caller.reason as Error)
        : new EgressError("egress_timeout", "response", {
            reason: `The request did not complete within ${String(totalMs)} ms.`,
          }),
  };
}

/** Header pairs as `http.request` takes them; repeated names become arrays. */
function headerObject(pairs: readonly (readonly [string, string])[]): Record<string, string | string[]> {
  const object: Record<string, string | string[]> = {};
  for (const [name, value] of pairs) {
    const existing = object[name];
    object[name] =
      existing === undefined ? value : [...(Array.isArray(existing) ? existing : [existing]), value];
  }
  return object;
}

function normalizeMethod(method: string): string {
  if (!TOKEN.test(method)) throw new TypeError(`invalid HTTP method ${JSON.stringify(method)}`);
  const upper = method.toUpperCase();
  if (FORBIDDEN_METHODS.has(upper)) throw new TypeError(`the ${upper} method is not allowed`);
  return NORMALIZED_METHODS.has(upper) ? upper : method;
}

function requestHeaders(init: HeadersLike | undefined, policy: EgressPolicy): [string, string][] {
  const headers = new Headers(init);
  const list: [string, string][] = [];
  let bytes = 0;
  for (const [name, value] of headers) {
    if (DROPPED_HEADERS.has(name) || name.startsWith("proxy-")) continue;
    if (!UNCOUNTED_HEADERS.has(name)) bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 4;
    list.push([name, value]);
  }
  if (bytes > policy.limits.requestHeaderBytes) {
    throw new EgressError("egress_request_too_large", "request", {
      reason: `The request headers exceed ${String(policy.limits.requestHeaderBytes)} bytes.`,
    });
  }
  if (!headers.has("user-agent")) list.push(["user-agent", policy.userAgent]);
  if (!headers.has("accept")) list.push(["accept", "*/*"]);
  // Compressed answers are still decoded, but asking for none keeps the size limit honest.
  list.push(["accept-encoding", "identity"]);
  return list;
}

function requestBody(
  body: SafeRequestInit["body"],
  method: string,
  headers: [string, string][],
  policy: EgressPolicy,
): Uint8Array | undefined {
  if (body === undefined || body === null) return undefined;
  if (method === "GET" || method === "HEAD") throw new TypeError(`a ${method} request cannot have a body`);
  let bytes: Uint8Array;
  if (typeof body === "string") {
    bytes = Buffer.from(body, "utf8");
    if (!headers.some(([name]) => name === "content-type")) {
      headers.push(["content-type", "text/plain;charset=UTF-8"]);
    }
  } else if (body instanceof Uint8Array) {
    bytes = body;
  } else {
    throw new TypeError("the request body must be a string or a Uint8Array");
  }
  if (bytes.byteLength > policy.limits.requestBodyBytes) {
    throw new EgressError("egress_request_too_large", "request", {
      reason: `The request body exceeds ${String(policy.limits.requestBodyBytes)} bytes.`,
    });
  }
  return bytes;
}

interface ResponseContext {
  readonly url: URL;
  readonly method: string;
  readonly redirected: boolean;
  readonly idleTimedOut: () => boolean;
  readonly signals: Signals;
  readonly policy: EgressPolicy;
}

function toResponse(message: IncomingMessage, context: ResponseContext): Response {
  const status = message.statusCode ?? 0;
  if (status < 200 || status > 599) {
    message.destroy();
    throw new EgressError("egress_connection_failed", "response", {
      reason: `The server answered with the invalid status ${String(status)}.`,
    });
  }
  const nullBody = context.method === "HEAD" || NULL_BODY_STATUSES.has(status);
  const encoding = (message.headers["content-encoding"] ?? "").trim().toLowerCase();
  const decoded = !nullBody && encoding !== "" && encoding !== "identity";

  const headers = new Headers();
  const raw = message.rawHeaders;
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const name = (raw[index] ?? "").toLowerCase();
    if (decoded && (name === "content-encoding" || name === "content-length")) continue;
    try {
      headers.append(name, raw[index + 1] ?? "");
    } catch {
      // A header value fetch cannot represent is dropped rather than failing the response.
    }
  }

  let body: ReadableStream<Uint8Array> | null = null;
  if (nullBody) {
    discard(message);
  } else {
    let source: Readable = message;
    if (decoded) {
      const decoder = decoderFor(encoding);
      if (decoder === undefined) {
        message.destroy();
        throw new EgressError("egress_response_too_large", "response", {
          reason: `The response uses the unsupported content encoding "${encoding.slice(0, 32)}".`,
        });
      }
      message.on("error", (error) => {
        decoder.destroy(error);
      });
      source = message.pipe(decoder);
    }
    body = limitedBody(message, source, context);
  }

  let response: Response;
  try {
    response = new Response(body, { status, statusText: message.statusMessage ?? "", headers });
  } catch {
    message.destroy();
    throw new EgressError("egress_connection_failed", "response", {
      reason: "The server answered with a response that cannot be represented.",
    });
  }
  Object.defineProperty(response, "url", { value: context.url.href });
  Object.defineProperty(response, "redirected", { value: context.redirected });
  return response;
}

function decoderFor(encoding: string) {
  switch (encoding) {
    case "gzip":
    case "x-gzip":
      return createGunzip();
    case "deflate":
      return createInflate();
    case "br":
      return createBrotliDecompress();
    default:
      return undefined;
  }
}

/**
 * The decoded body as a web stream, errored with `egress_response_too_large` past the limit, with
 * `egress_timeout` on idle or total timeouts, and with the caller's reason on abort.
 */
function limitedBody(
  message: IncomingMessage,
  source: Readable,
  context: ResponseContext,
): ReadableStream<Uint8Array> {
  const limit = context.policy.limits.responseBodyBytes;
  let received = 0;
  let done = false;
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const finish = (error?: unknown) => {
          if (done) return;
          done = true;
          context.signals.combined.removeEventListener("abort", onAbort);
          if (error === undefined) {
            controller.close();
          } else {
            controller.error(error);
            source.destroy();
            message.destroy();
          }
        };
        const onAbort = () => {
          finish(context.signals.reason());
        };
        if (context.signals.combined.aborted) {
          onAbort();
          return;
        }
        context.signals.combined.addEventListener("abort", onAbort, { once: true });
        source.on("data", (chunk: Buffer) => {
          if (done) return;
          received += chunk.byteLength;
          if (received > limit) {
            finish(
              new EgressError("egress_response_too_large", "response", {
                reason: `The response body exceeds ${String(limit)} bytes.`,
              }),
            );
            return;
          }
          controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
          if ((controller.desiredSize ?? 0) <= 0) source.pause();
        });
        source.on("end", () => {
          finish();
        });
        source.on("error", (error: NodeJS.ErrnoException) => {
          if (context.idleTimedOut()) finish(timeout("idle", "response"));
          else if (source === message) finish(classify(error, "response"));
          else
            finish(
              new EgressError("egress_connection_failed", "response", {
                reason: "The response body could not be decoded.",
              }),
            );
        });
        message.on("aborted", () => {
          finish(
            context.idleTimedOut()
              ? timeout("idle", "response")
              : new EgressError("egress_connection_failed", "response", {
                  reason: "The connection closed before the response body was complete.",
                }),
          );
        });
      },
      pull() {
        source.resume();
      },
      cancel() {
        done = true;
        source.destroy();
        message.destroy();
      },
    },
    { highWaterMark: 1 },
  );
}

function timeout(which: "connect" | "headers" | "idle", stage: EgressStage): EgressError {
  const reasons = {
    connect: "The connection was not established in time.",
    headers: "The server did not send response headers in time.",
    idle: "The connection was idle for too long.",
  } as const;
  return new EgressError("egress_timeout", stage, { reason: reasons[which] });
}

function notAllowedRemote(url: URL): EgressError {
  return new EgressError("egress_destination_not_allowed", "connect", {
    reason: `The connection to ${url.hostname} reached an address that was not validated.`,
  });
}

/** Maps a transport error to a code. The reason never repeats the error message, which can hold addresses. */
function classify(error: NodeJS.ErrnoException, stage: EgressStage): EgressError {
  const code = typeof error.code === "string" ? error.code : "";
  const details = code === "" ? undefined : { error: code };
  if (code === REFUSED_LOOKUP) {
    return new EgressError("egress_destination_not_allowed", "dns", { reason: error.message, details });
  }
  if (DNS_ERRORS.has(code)) {
    return new EgressError("egress_dns_failed", "dns", { details });
  }
  if (code === "HPE_HEADER_OVERFLOW") {
    return new EgressError("egress_response_too_large", "response", {
      reason: "The response headers exceed the size limit.",
      details,
    });
  }
  if (code.startsWith("HPE_")) {
    return new EgressError("egress_connection_failed", "response", {
      reason: "The server sent an invalid HTTP response.",
      details,
    });
  }
  if (
    stage === "tls" ||
    code.startsWith("ERR_TLS") ||
    code.startsWith("ERR_SSL") ||
    code.includes("CERT") ||
    code.startsWith("UNABLE_TO_")
  ) {
    return new EgressError("egress_tls_failed", "tls", { details });
  }
  return new EgressError("egress_connection_failed", stage, { details });
}

/** Lower-case, with IPv4-mapped IPv6 (::ffff:a.b.c.d) reduced to the IPv4 address. */
function normalizeAddress(address: string): string {
  const lower = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  return mapped?.[1] ?? lower;
}
