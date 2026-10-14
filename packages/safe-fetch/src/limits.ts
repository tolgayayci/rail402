import pkg from "../package.json" with { type: "json" };

/** Resolves a host name to every address it has. Used in place of the system resolver in tests. */
export type Resolver = (host: string) => Promise<readonly { address: string; family: 4 | 6 }[]>;

export interface EgressTimeouts {
  /** TCP connect plus TLS handshake. */
  readonly connectMs: number;
  /** From sending the request until the response headers arrive. */
  readonly headersMs: number;
  /** Longest silence on the socket once the response headers arrived (before them, `headersMs` bounds it). */
  readonly idleMs: number;
  /** The whole exchange, redirects and body included. */
  readonly totalMs: number;
}

export interface EgressLimits {
  readonly urlBytes: number;
  readonly requestBodyBytes: number;
  /** Caller headers, excluding `PAYMENT-SIGNATURE`. */
  readonly requestHeaderBytes: number;
  readonly responseHeaderBytes: number;
  /** Counted after content decoding, so a compressed bomb is stopped at this size. */
  readonly responseBodyBytes: number;
}

export interface EgressPolicy {
  readonly schemes: readonly ("https:" | "http:")[];
  readonly ports: readonly number[];
  /**
   * `"loopback"` also allows this machine (127.0.0.0/8, ::1, `localhost`), for local development and
   * tests. No other private address is ever allowed.
   */
  readonly allowPrivateNetwork: false | "loopback";
  /** `error` refuses every redirect; `same-origin` follows up to `max` hops on the same host and port. */
  readonly redirects: { readonly mode: "error" | "same-origin"; readonly max: number };
  readonly limits: EgressLimits;
  readonly timeouts: EgressTimeouts;
  readonly userAgent: string;
  /** Connections kept open to one host and port at a time; further requests wait for a free one. */
  readonly maxSocketsPerHost: number;
  /** Connections open at once across every host; further requests wait for a free one. */
  readonly maxTotalSockets: number;
  /**
   * Whether an answered connection is kept for the next request to the same host and port. Kept
   * connections are closed after `idleSocketMs` without use, and at most `maxFreeSocketsPerHost` are
   * kept per host, so many distinct hosts cannot pile up idle sockets.
   */
  readonly keepAlive: boolean;
  /** How long a kept connection may sit unused before it is closed. */
  readonly idleSocketMs: number;
  /** Unused connections kept per host and port. */
  readonly maxFreeSocketsPerHost: number;
  /** Test seam: replaces the system resolver. */
  readonly resolve?: Resolver | undefined;
  /** Test seam: replaces the address classifier. */
  readonly isAllowedAddress?: ((address: string) => boolean) | undefined;
}

export type EgressPolicyInput = Partial<
  Omit<EgressPolicy, "limits" | "timeouts" | "redirects"> & {
    readonly limits: Partial<EgressLimits>;
    readonly timeouts: Partial<EgressTimeouts>;
    readonly redirects: Partial<EgressPolicy["redirects"]>;
  }
>;

export const DEFAULT_USER_AGENT = `rail402/${pkg.version} (+https://rail402.dev)`;

export const DEFAULT_LIMITS: EgressLimits = Object.freeze({
  urlBytes: 2_048,
  requestBodyBytes: 65_536,
  requestHeaderBytes: 8_192,
  responseHeaderBytes: 65_536,
  responseBodyBytes: 1_048_576,
});

export const DEFAULT_TIMEOUTS: EgressTimeouts = Object.freeze({
  connectMs: 5_000,
  headersMs: 15_000,
  idleMs: 15_000,
  totalMs: 60_000,
});

/** Connections per host and port unless the policy sets `maxSocketsPerHost`. */
export const DEFAULT_MAX_SOCKETS_PER_HOST = 4;

/** Connections across every host unless the policy sets `maxTotalSockets`. */
export const DEFAULT_MAX_TOTAL_SOCKETS = 256;

/** Idle time before a kept connection is closed, unless the policy sets `idleSocketMs`. */
export const DEFAULT_IDLE_SOCKET_MS = 15_000;

/** Unused connections kept per host unless the policy sets `maxFreeSocketsPerHost`. */
export const DEFAULT_MAX_FREE_SOCKETS_PER_HOST = 2;

/** Hops followed when a request opts into `same-origin` redirects. */
export const DEFAULT_MAX_REDIRECTS = 3;

/** A complete policy: https only on port 443 (80 too when http is allowed), public addresses, no redirects. */
export function resolvePolicy(input: EgressPolicyInput = {}): EgressPolicy {
  const schemes = input.schemes ?? ["https:"];
  for (const scheme of schemes) {
    if (!(["https:", "http:"] as unknown[]).includes(scheme))
      throw new TypeError(`unsupported scheme ${scheme}`);
  }
  const ports = input.ports ?? (schemes.includes("http:") ? [443, 80] : [443]);
  for (const port of ports) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535)
      throw new TypeError(`invalid port ${String(port)}`);
  }
  const allowPrivateNetwork = input.allowPrivateNetwork ?? false;
  if (!([false, "loopback"] as unknown[]).includes(allowPrivateNetwork)) {
    throw new TypeError('allowPrivateNetwork must be false or "loopback"');
  }
  const redirects = {
    mode: input.redirects?.mode ?? "error",
    max: input.redirects?.max ?? DEFAULT_MAX_REDIRECTS,
  } as const;
  if (!(["error", "same-origin"] as unknown[]).includes(redirects.mode)) {
    throw new TypeError('redirects.mode must be "error" or "same-origin"');
  }
  positive({ max: redirects.max }, true);
  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  positive(limits);
  const timeouts = { ...DEFAULT_TIMEOUTS, ...input.timeouts };
  positive(timeouts);
  const maxSocketsPerHost = input.maxSocketsPerHost ?? DEFAULT_MAX_SOCKETS_PER_HOST;
  const maxTotalSockets = input.maxTotalSockets ?? DEFAULT_MAX_TOTAL_SOCKETS;
  const idleSocketMs = input.idleSocketMs ?? DEFAULT_IDLE_SOCKET_MS;
  const maxFreeSocketsPerHost = input.maxFreeSocketsPerHost ?? DEFAULT_MAX_FREE_SOCKETS_PER_HOST;
  positive({ maxSocketsPerHost, maxTotalSockets, idleSocketMs, maxFreeSocketsPerHost });
  const keepAlive = input.keepAlive ?? true;
  if (typeof keepAlive !== "boolean") throw new TypeError("keepAlive must be a boolean");
  return Object.freeze({
    schemes: Object.freeze([...schemes]),
    ports: Object.freeze([...ports]),
    allowPrivateNetwork,
    redirects: Object.freeze(redirects),
    limits: Object.freeze(limits),
    timeouts: Object.freeze(timeouts),
    userAgent: input.userAgent ?? DEFAULT_USER_AGENT,
    maxSocketsPerHost,
    maxTotalSockets,
    keepAlive,
    idleSocketMs,
    maxFreeSocketsPerHost,
    resolve: input.resolve,
    isAllowedAddress: input.isAllowedAddress,
  });
}

function positive(values: Readonly<Record<string, number>>, allowZero = false): void {
  for (const [name, value] of Object.entries(values)) {
    if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
      throw new TypeError(`${name} must be a ${allowZero ? "non-negative" : "positive"} integer`);
    }
  }
}
