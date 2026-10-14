/**
 * The runtime-neutral part of safe-fetch: the `SafeFetch` contract, the egress policy and its
 * defaults, the final-request registry and the codes. It imports nothing from Node, so code that only
 * consumes a `SafeFetch` (for example a browser transport that implements the same contract) can use
 * it without pulling in `node:http`.
 */
import type { EgressPolicy, EgressTimeouts } from "./limits.ts";

export * from "./codes.ts";
export * from "./limits.ts";

/** Anything the `Headers` constructor accepts. */
export type HeadersLike = ConstructorParameters<typeof Headers>[0];

export interface SafeRequestInit {
  readonly method?: string;
  readonly headers?: HeadersLike;
  /** Strings are sent as UTF-8. Streams are not accepted: the size must be known before sending. */
  readonly body?: string | Uint8Array | null;
  readonly signal?: AbortSignal;
  /** Overrides the policy's redirect mode for this request. */
  readonly redirect?: "error" | "same-origin";
  readonly timeouts?: Partial<EgressTimeouts>;
}

/**
 * A fetch-compatible function for URLs that come from untrusted input. It returns a native `Response`
 * and rejects with an `EgressError` (or the caller's abort reason) instead of reaching anything the
 * policy does not allow.
 */
export type SafeFetch = ((input: string | URL, init?: SafeRequestInit) => Promise<Response>) & {
  readonly policy: EgressPolicy;
  /** Closes pooled connections. */
  close(): void;
};

/** The request that finally answered, after any redirects. */
export interface FinalRequest {
  /** The method of the last hop: a 303, or a 301/302 after POST, turns the request into a GET. */
  readonly method: string;
  /** Whether a redirect dropped the request body on the way. */
  readonly bodyDropped: boolean;
}

const finalRequests = new WeakMap<Response, FinalRequest>();

/**
 * Records the request that answered `response`. A `SafeFetch` implementation calls this for every
 * response it returns, so callers can read it back with `finalRequestOf`.
 */
export function markFinalRequest(response: Response, request: FinalRequest): void {
  finalRequests.set(response, Object.freeze({ method: request.method, bodyDropped: request.bodyDropped }));
}

/**
 * The method and body state of the request that answered `response`, for a response a `SafeFetch`
 * returned. A caller that repeats the request (for example with a payment attached) must repeat what
 * the server finally answered, not what it first sent.
 */
export function finalRequestOf(response: Response): FinalRequest | undefined {
  return finalRequests.get(response);
}

/** The port a URL connects to: its explicit port, or the scheme's default. */
export function effectivePort(url: URL): number {
  if (url.port !== "") return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}
