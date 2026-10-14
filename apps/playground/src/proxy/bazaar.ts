import type { Hono } from "hono";
import type { PlaygroundConfig } from "../config.ts";
import { refuse, type ServerContext, type ServerEnv } from "../http.ts";
import type { Clock, RateLimiter, SharedRate } from "../limits.ts";
import { sameOrigin } from "../security.ts";
import type { Metrics } from "../metrics.ts";
import { relayUserAgent } from "../shared/relay-protocol.ts";
import { UpstreamJson, jsonReply } from "./upstream.ts";

export const BAZAAR_PROXY_PREFIX = "/api/bazaar";

/** How long answers are reused: search results 5 s, listings, versions and lists 2 s. */
export const BAZAAR_CACHE_MS = Object.freeze({ search: 5_000, listing: 2_000 });

/** Largest Bazaar answer passed through. */
export const BAZAAR_MAX_BYTES = 2 * 1_048_576;
export const PROXY_TIMEOUT_MS = 10_000;
/** Longest query string passed through; Rail402 validates its content. */
const MAX_QUERY_BYTES = 4_096;

export interface ProxyOptions {
  readonly config: PlaygroundConfig;
  readonly metrics: Metrics;
  /** Per-client limit shared by the Bazaar and facilitator proxies. */
  readonly perClient: RateLimiter;
  /** Global limit on upstream fetches (cache misses) shared by both proxies, fair-shared by network. */
  readonly upstreamGlobal: SharedRate;
  readonly fetch?: typeof fetch;
  readonly now?: Clock;
}

/**
 * Refuses a proxy request another site's page made: the proxies serve the Playground page only, and
 * a cross-site request would spend the upstream budget every visitor shares. A browser always says
 * where a request comes from; a client that is not a browser passes, bounded by the limits.
 */
export function proxyOrigin(c: ServerContext, config: PlaygroundConfig): Response | undefined {
  if (sameOrigin(c.req.raw.headers, config.publicUrl)) return undefined;
  return refuse(c, "playground_origin_not_allowed");
}

/**
 * Read-only proxy to the configured Bazaar's discovery API, so the page can read it from its own
 * origin (the Bazaar sends no CORS headers). Only these four routes exist, the target host is fixed,
 * and the query string passes through untouched: the Bazaar validates it and answers coded errors,
 * which reach the page unchanged. Requests from other sites are refused.
 */
export function mountBazaarProxy(app: Hono<ServerEnv>, options: ProxyOptions): { sweep(): void } {
  const { config, metrics } = options;
  const upstream = new UpstreamJson({
    timeoutMs: PROXY_TIMEOUT_MS,
    maxBytes: BAZAAR_MAX_BYTES,
    userAgent: relayUserAgent(config.version, config.publicUrl),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const base = `${config.urls.bazaar}/discovery`;

  const proxy = async (c: ServerContext, path: string, ttlMs: number): Promise<Response> => {
    const foreign = proxyOrigin(c, config);
    if (foreign !== undefined) return foreign;
    const retryAfter = options.perClient.take(c.get("clientKey"));
    if (retryAfter > 0) {
      metrics.rateLimited.inc({ limit: "proxy" });
      return refuse(c, "playground_rate_limited", { retryAfter });
    }
    const search = new URL(c.req.url).search;
    if (search.length > MAX_QUERY_BYTES) {
      return refuse(c, "playground_request_invalid", { reason: "The query string is too long." });
    }
    const started = performance.now();
    const network = c.get("networkKey");
    const result = await upstream.get(
      `${base}${path}${search}`,
      ttlMs,
      () => options.upstreamGlobal.take(network) === 0,
    );
    if (!result.ok) {
      metrics.proxyRequests.inc({ target: "bazaar", outcome: result.busy === true ? "busy" : "failed" });
      if (result.busy === true) {
        metrics.rateLimited.inc({ limit: "proxy_global" });
        return refuse(c, "playground_rate_limited", { reason: result.reason, retryAfter: 1 });
      }
      return refuse(c, "playground_upstream_unavailable", { reason: `Bazaar: ${result.reason}` });
    }
    if (!result.cached)
      metrics.proxyUpstreamLatency.observe({ target: "bazaar" }, (performance.now() - started) / 1_000);
    metrics.proxyRequests.inc({ target: "bazaar", outcome: result.cached ? "hit" : "fetched" });
    return jsonReply(result.answer);
  };

  const listingPath = (c: ServerContext): string | undefined => {
    const id = c.req.param("id") ?? "";
    // Re-encoded, so the id stays one path segment; dot segments would climb the Bazaar's path.
    if (id === "" || id === "." || id === "..") return undefined;
    return `/resources/${encodeURIComponent(id)}`;
  };

  app.get(`${BAZAAR_PROXY_PREFIX}/discovery/search`, (c) => proxy(c, "/search", BAZAAR_CACHE_MS.search));
  app.get(`${BAZAAR_PROXY_PREFIX}/discovery/resources`, (c) =>
    proxy(c, "/resources", BAZAAR_CACHE_MS.listing),
  );
  app.get(`${BAZAAR_PROXY_PREFIX}/discovery/resources/:id`, (c) => {
    const path = listingPath(c);
    if (path === undefined)
      return refuse(c, "playground_request_invalid", { reason: "The listing id is invalid." });
    return proxy(c, path, BAZAAR_CACHE_MS.listing);
  });
  app.get(`${BAZAAR_PROXY_PREFIX}/discovery/resources/:id/versions`, (c) => {
    const path = listingPath(c);
    if (path === undefined)
      return refuse(c, "playground_request_invalid", { reason: "The listing id is invalid." });
    return proxy(c, `${path}/versions`, BAZAAR_CACHE_MS.listing);
  });
  return {
    sweep: () => {
      upstream.sweep();
    },
  };
}
