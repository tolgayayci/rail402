/**
 * The seller transport for the Playground's own lab sellers (`/lab/*`), which are served from the
 * page's origin and called with the browser's fetch, without the relay. It honours the same
 * `SafeFetch` contract as the relay transport: no redirects, the policy's size and time limits, and
 * every response registered with `markFinalRequest`. Any other URL is refused.
 */
import {
  EgressError,
  markFinalRequest,
  type EgressPolicy,
  type SafeFetch,
  type SafeRequestInit,
} from "@rail402.dev/safe-fetch/shared";
import { LAB_PREFIX } from "../../../src/shared/lab.ts";
import { abortedByCaller, bodyBytes, copyBytes, limitStream, withTimeout } from "./body.ts";

export interface DirectFetchOptions {
  /** The Playground's origin, e.g. `https://playground.rail402.dev`. */
  readonly origin: string;
  readonly policy: EgressPolicy;
  readonly fetch?: typeof fetch;
}

/** Whether a URL is one of the Playground's lab sellers on `origin`. */
export function isLabUrl(input: string | URL, origin: string): boolean {
  try {
    const url = typeof input === "string" ? new URL(input) : input;
    return url.origin === new URL(origin).origin && url.pathname.startsWith(LAB_PREFIX);
  } catch {
    return false;
  }
}

export function createDirectFetch(options: DirectFetchOptions): SafeFetch {
  const { origin, policy } = options;
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);

  const directFetch = async (input: string | URL, init: SafeRequestInit = {}): Promise<Response> => {
    const href = typeof input === "string" ? input : input.href;
    if (!isLabUrl(href, origin)) {
      throw new EgressError("egress_destination_not_allowed", "url", {
        reason: "Only the Playground's own lab sellers are called without the relay.",
      });
    }
    const body = init.body ?? null;
    if (bodyBytes(body) > policy.limits.requestBodyBytes) {
      throw new EgressError("egress_request_too_large", "request", {
        reason: `The request body exceeds ${String(policy.limits.requestBodyBytes)} bytes.`,
      });
    }
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    const paid = headers.has("payment-signature");
    const totalMs = init.timeouts?.totalMs ?? policy.timeouts.totalMs;
    const signal = withTimeout(init.signal, totalMs);
    if (init.signal?.aborted === true) throw init.signal.reason;
    let response: Response;
    try {
      response = await send(href, {
        method,
        headers,
        ...(body === null ? {} : { body: typeof body === "string" ? body : copyBytes(body) }),
        signal,
        // Lab sellers never redirect; a redirect is refused like safe-fetch refuses it.
        redirect: "error",
        credentials: "same-origin",
        cache: "no-store",
      });
    } catch (error) {
      if (abortedByCaller(init.signal)) throw init.signal?.reason ?? error;
      throw new EgressError(
        signal.aborted ? "egress_timeout" : "egress_connection_failed",
        paid ? "response" : "connect",
        { reason: "The lab seller could not be reached." },
      );
    }
    const answer = new Response(
      response.body === null ? null : limitStream(response.body, policy.limits.responseBodyBytes),
      { status: response.status, statusText: response.statusText, headers: response.headers },
    );
    Object.defineProperty(answer, "url", { value: response.url === "" ? href : response.url });
    markFinalRequest(answer, { method, bodyDropped: false });
    return answer;
  };

  return Object.assign(directFetch, { policy, close: () => undefined });
}
