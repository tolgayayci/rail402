import { createHash, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import type { Logger } from "pino";
import type { FacilitatorClient } from "@x402/core/server";
import type { checkSellerOrigin } from "@rail402.dev/sdk/seller";
import { connectOrigins, publicConfigOf, type PlaygroundConfig } from "./config.ts";
import { refuse, requestIdOf, type RequestLog, type ServerContext, type ServerEnv } from "./http.ts";
import { labRouteOf, mountLab } from "./lab/mount.ts";
import { STELLAR_TOML_PATH } from "./lab/stellar-toml.ts";
import { IpHasher } from "./log.ts";
import { RateLimiter, SharedRate, clientAddress, clientKey, networkKey, type Clock } from "./limits.ts";
import { Metrics } from "./metrics.ts";
import { BAZAAR_PROXY_PREFIX, mountBazaarProxy } from "./proxy/bazaar.ts";
import {
  FacilitatorSupported,
  READINESS,
  SUPPORTED_PROXY_PATH,
  mountFacilitatorProxy,
} from "./proxy/facilitator.ts";
import type { EgressSeams } from "./relay/egress.ts";
import { createRelay } from "./relay/relay.ts";
import { SELLER_CHECK_PATH, mountSellerCheck } from "./seller-check.ts";
import { securityHeaders } from "./security.ts";
import { CONFIG_PATH } from "./shared/public-config.ts";
import { RELAY_PATH } from "./shared/relay-protocol.ts";
import { SPA_ROUTES, StaticSite } from "./static.ts";

export interface AppOptions {
  readonly config: PlaygroundConfig;
  readonly log: Logger;
  readonly metrics?: Metrics;
  /** The built page; `web/dist` next to the server by default. */
  readonly webRoot?: string;
  /** Used by the facilitator and Bazaar proxies; the global fetch by default. */
  readonly fetch?: typeof fetch;
  readonly now?: Clock;
  /** Test seams of the egress policy of the relay and the seller check. */
  readonly egress?: EgressSeams;
  /** The facilitator lab sellers settle through; FACILITATOR_URL over HTTP by default. */
  readonly labFacilitator?: FacilitatorClient;
  /** Replaces the seller check's origin check (tests). */
  readonly sellerCheck?: typeof checkSellerOrigin;
}

export interface PlaygroundApp {
  readonly app: Hono<ServerEnv>;
  readonly metrics: Metrics;
  /** Stops background work and closes pooled connections. */
  close(): void;
}

export const DEFAULT_WEB_ROOT = fileURLToPath(new URL("../web/dist", import.meta.url));

const DISCOVERY = `${BAZAAR_PROXY_PREFIX}/discovery/`;

/** Route labels for logs and metrics; anything else is `unmatched`, keeping label values bounded. */
export function routeOf(path: string): string {
  if (
    [
      "/health",
      "/ready",
      "/metrics",
      CONFIG_PATH,
      RELAY_PATH,
      SUPPORTED_PROXY_PATH,
      SELLER_CHECK_PATH,
      STELLAR_TOML_PATH,
    ].includes(path)
  )
    return path;
  if (path.startsWith(DISCOVERY)) {
    const rest = path.slice(DISCOVERY.length);
    if (rest === "search" || rest === "resources") return `${DISCOVERY}${rest}`;
    if (rest.startsWith("resources/")) {
      return `${DISCOVERY}resources/:id${rest.endsWith("/versions") ? "/versions" : ""}`;
    }
    return "unmatched";
  }
  if (path.startsWith("/lab/")) return labRouteOf(path);
  if (path.startsWith("/assets/")) return "/assets";
  if (SPA_ROUTES.includes(path)) return "page";
  return "unmatched";
}

/**
 * How long a client may take to send a request: its headers, then all of it. A relayed body is at
 * most 64 KiB, so a slower upload is an attempt to hold a relay slot, not a visitor. Responses, which
 * may stream for minutes, are not bounded by these.
 */
export const REQUEST_TIMEOUTS = Object.freeze({ headersMs: 15_000, requestMs: 30_000 });

/**
 * The Playground server: the built page, its public configuration, the relay, the fixed proxies, and
 * the operational endpoints. It holds no secret and no state beyond in-memory limits and caches.
 */
export function createApp(options: AppOptions): PlaygroundApp {
  const { config, log } = options;
  const metrics = options.metrics ?? new Metrics();
  const now = options.now ?? Date.now;
  const site = new StaticSite(options.webRoot ?? DEFAULT_WEB_ROOT);
  const publicConfig = JSON.stringify(publicConfigOf(config));
  const hasher = new IpHasher(now);
  const app = new Hono<ServerEnv>();

  const relay = createRelay({
    config,
    metrics,
    log,
    now,
    ...(options.egress === undefined ? {} : { egress: options.egress }),
  });
  const proxyPerClient = new RateLimiter(config.limits.proxyPerMinute, config.limits.proxyPerMinute, now);
  const proxyUpstream = new SharedRate(config.limits.proxyGlobalPerMinute, config.limits.proxyPerMinute, now);
  const fetchOption = options.fetch === undefined ? {} : { fetch: options.fetch };
  const supported = new FacilitatorSupported({
    config,
    admit: () => proxyUpstream.take(READINESS) === 0,
    ...fetchOption,
    now,
  });

  // Access log and request metrics: route template, status, timing and a hashed client address.
  // Never a target, path parameter, query, header or body.
  app.use("*", async (c, next) => {
    const started = performance.now();
    const requestId = requestIdOf(c.req.header("x-request-id"));
    // Middleware contexts carry an untyped input; the helper only reads headers and the socket.
    const address = clientAddress(c as ServerContext, config.trustedProxyHops);
    const route = routeOf(c.req.path);
    let written = false;
    const requestLog: RequestLog = {
      fields: {},
      deferred: false,
      write(extra = {}) {
        if (written) return;
        written = true;
        const ms = Math.round(performance.now() - started);
        const status = c.res.status;
        metrics.requestDuration.observe({ method: c.req.method, route, status: String(status) }, ms / 1_000);
        log.info(
          {
            reqId: requestId,
            route,
            method: c.req.method,
            status,
            ms,
            ipHash: hasher.hash(address),
            ...requestLog.fields,
            ...extra,
          },
          "request",
        );
      },
    };
    c.set("requestId", requestId);
    c.set("clientKey", clientKey(address));
    c.set("networkKey", networkKey(address));
    c.set("requestLog", requestLog);
    await next();
    c.res.headers.set("x-request-id", requestId);
    if (!requestLog.deferred) requestLog.write();
  });

  app.use(
    "*",
    securityHeaders({ connectOrigins: connectOrigins(config), https: config.publicUrl.startsWith("https:") }),
  );

  // Liveness: answers whenever the process does.
  app.get("/health", (c) => c.json({ status: "ok", version: config.version, commit: config.commit }));

  // Readiness: the page is built and the facilitator answers /supported (cached for a minute).
  app.get("/ready", async (c) => {
    const facilitator = await supported.reachable();
    const ready = facilitator && site.ready;
    return c.json(
      {
        ready,
        checks: {
          config: "ok",
          facilitator: facilitator ? "ok" : "unreachable",
          web: site.ready ? "ok" : "missing",
        },
      },
      ready ? 200 : 503,
    );
  });

  app.get("/metrics", async (c) => {
    const token = config.metricsTokenSha256;
    if (token !== undefined && !bearerMatches(c.req.header("authorization"), token)) {
      c.get("requestLog").fields["code"] = "unauthorized";
      return new Response(null, { status: 401, headers: { "www-authenticate": 'Bearer realm="metrics"' } });
    }
    c.header("content-type", metrics.registry.contentType);
    c.header("cache-control", "no-store");
    return c.body(await metrics.registry.metrics());
  });

  app.get(CONFIG_PATH, (c) => {
    return c.body(publicConfig, 200, { "content-type": "application/json", "cache-control": "no-cache" });
  });

  app.post(RELAY_PATH, (c) => relay.handle(c));
  app.on(["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"], RELAY_PATH, (c) =>
    refuse(c, "playground_request_invalid", {
      reason: "The relay accepts POST only.",
      headers: { "x-relay": "error", allow: "POST" },
    }),
  );

  const bazaarProxy = mountBazaarProxy(app, {
    config,
    metrics,
    perClient: proxyPerClient,
    upstreamGlobal: proxyUpstream,
    now,
    ...fetchOption,
  });
  mountFacilitatorProxy(app, {
    config,
    metrics,
    perClient: proxyPerClient,
    upstreamGlobal: proxyUpstream,
    supported,
    now,
    ...fetchOption,
  });

  const egressOption = options.egress === undefined ? {} : { egress: options.egress };
  const sellerCheck = mountSellerCheck(app, {
    config,
    metrics,
    log,
    now,
    ...egressOption,
    ...(options.sellerCheck === undefined ? {} : { check: options.sellerCheck }),
  });
  const lab = mountLab(app, {
    config,
    metrics,
    log,
    now,
    ...(options.labFacilitator === undefined ? {} : { facilitator: options.labFacilitator }),
  });
  const sweep = setInterval(() => {
    relay.sweep();
    sellerCheck.sweep();
    lab.sweep();
    proxyPerClient.sweep();
    proxyUpstream.sweep();
    bazaarProxy.sweep();
  }, 60_000);
  sweep.unref();

  // The built page: exact files, and index.html for the page's routes.
  app.on(["GET", "HEAD"], "*", async (c, next) => {
    const path = c.req.path.length > 1 ? c.req.path.replace(/\/+$/, "") : c.req.path;
    const file = site.lookup(path);
    if (file === undefined) {
      await next();
      return;
    }
    const headers = { "content-type": file.type, "cache-control": file.cacheControl, etag: file.etag };
    if (c.req.header("if-none-match") === file.etag) return new Response(null, { status: 304, headers });
    return new Response(c.req.method === "HEAD" ? null : file.body, { status: 200, headers });
  });

  app.notFound((c) => refuse(c, "playground_not_found"));
  app.onError((error, c) => {
    log.error({ err: error, reqId: c.get("requestId") }, "unexpected error");
    return refuse(c, "playground_internal_error");
  });

  return {
    app,
    metrics,
    close() {
      clearInterval(sweep);
      relay.close();
    },
  };
}

/** Whether `Authorization: Bearer <token>` hashes to `sha256` (constant-time comparison). */
function bearerMatches(header: string | undefined, sha256: string): boolean {
  if (header?.toLowerCase().startsWith("bearer ") !== true) return false;
  const token = header.slice(7).trim();
  if (token === "") return false;
  const digest = createHash("sha256").update(token).digest();
  return timingSafeEqual(digest, Buffer.from(sha256, "hex"));
}
