import type { Context, Next } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { createError, type ErrorCode } from "@rail402.dev/errors";

/**
 * Caller identification and fixed-window rate limiting, extracted from the app factory so other
 * services (the playground's USDC dispenser) reuse the audited logic instead of re-deriving it.
 * The identification ORDER is the security-relevant part: a fresh
 * implementation gets it backwards the same way the original did.
 */

/**
 * Identify a caller for rate-limiting purposes.
 *
 * Order matters, and the original order was backwards. `X-Forwarded-For`'s **first** element is
 * whatever the client sent — Cloudflare and most proxies APPEND rather than replace — so
 * preferring it handed every caller a free bypass: rotate the header, get a fresh bucket.
 * Headers a trusted proxy sets itself come first now, and when we do
 * fall back to `X-Forwarded-For` we take the **last** hop, which is the one our own proxy wrote.
 *
 * With no proxy headers at all we use the socket address rather than a single shared
 * `"anonymous"` bucket. That bucket was worse than no limiter: one noisy caller exhausted the
 * window for the entire internet, which is a denial of service we would have inflicted on
 * ourselves.
 */
export function clientKey(c: Context, trustProxy: boolean): string {
  // Every client-IP header (`cf-connecting-ip`, `x-real-ip`, `x-forwarded-for`) is client-settable
  // unless a trusted proxy in front sets it and strips the incoming value. So they are believed
  // ONLY when the operator asserts that proxy via TRUST_PROXY. Trusting them unconditionally — the
  // earlier bug — handed every caller a free rate-limit bypass: rotate the header, get a fresh
  // bucket (the XFF-ordering fix left these two ungated). Within the
  // gate we take the last `x-forwarded-for` hop, which is the one our own proxy wrote.
  if (trustProxy) {
    const trusted = c.req.header("cf-connecting-ip") ?? c.req.header("x-real-ip");
    if (trusted) return trusted.trim();
    const hops = (c.req.header("x-forwarded-for") ?? "").split(",").map(h => h.trim()).filter(Boolean);
    const nearest = hops[hops.length - 1];
    if (nearest) return nearest;
  }

  // With no trusted proxy, the socket address is the only thing a caller cannot forge.
  try {
    const address = getConnInfo(c).remote.address;
    if (address) return address;
  } catch {
    // No Node socket (Cloudflare Workers): the isolate only ever runs behind Cloudflare, which
    // sets `cf-connecting-ip` and strips any client-supplied value, so it is authoritative HERE
    // and only here. This branch is unreachable on the Node server, where getConnInfo succeeds.
    const cf = c.req.header("cf-connecting-ip");
    if (cf) return cf.trim();
  }
  return "unattributable";
}

export interface RateLimiterOptions {
  readonly windowSeconds: number;
  readonly maxRequests: number;
  readonly trustProxy: boolean;
  /** Registry code returned on refusal. Defaults to the facilitator's own. */
  readonly errorCode?: ErrorCode;
}

/**
 * Fixed-window counter, in-process. Deliberately simple: a free testnet endpoint needs basic
 * burst protection (threat model: DoS on free endpoints), and an operator running multiple
 * replicas should front them with a shared limiter rather than rely on this.
 *
 * Each call creates an independent bucket map, so two routes given separate limiters do not
 * share windows.
 */
export function createRateLimiter(options: RateLimiterOptions) {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  const code = options.errorCode ?? "facilitator_rate_limited";

  return async function rateLimit(c: Context, next: Next) {
    const key = clientKey(c, options.trustProxy);
    const now = Date.now();
    const windowMs = options.windowSeconds * 1000;
    const bucket = buckets.get(key);

    if (!bucket || now >= bucket.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (bucket.count >= options.maxRequests) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      c.header("Retry-After", String(retryAfter));
      return c.json(
        createError(code, {
          reason: `Rate limit exceeded: at most ${options.maxRequests} requests per ${options.windowSeconds}s. Retry in ${retryAfter}s.`,
          details: { retryAfterSeconds: retryAfter },
        }),
        429,
      );
    }
    bucket.count += 1;
    return next();
  };
}
