import { createHash, timingSafeEqual } from "node:crypto";
import { ServerResponse } from "node:http";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { HttpBindings } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { z } from "zod";
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import { httpError, reportCode, toErrorBody, type Rail402Error } from "@rail402.dev/errors";
import {
  PUBLIC_CALLER,
  addUsd,
  repeatOf,
  settleFailed,
  withCaller,
  type CallerContext,
  type CallerUsage,
  verifyRejected,
  type Logger,
  type StellarFacilitator,
} from "@rail402.dev/facilitator";
import { PUBNET, isStellarNetwork, type ExactStellarCode, type StellarNetwork } from "@rail402.dev/stellar";
import {
  bazaarError,
  extensionResponsesHeader,
  type Catalog,
  type CatalogOutcome,
  type CatalogStore,
} from "@rail402.dev/bazaar";
import {
  DISCOVERY_RETRY_AFTER_SECONDS,
  DiscoveryAdmissions,
  defaultUsageDetail,
  discoveryLaneContext,
  discoveryLaneOf,
  discoveryRouteOf,
  discoveryRoutes,
  type DiscoveryCharge,
} from "./discovery.ts";
import { exposition, publicExposition } from "./metrics-exposure.ts";
import type { SearchService } from "@rail402.dev/search";
import type { Config } from "./config.ts";
import { HELD_RETRY_AFTER_SECONDS, type HoldReason, type NetworkServingState } from "./network-state.ts";
import { publicHealth, type HealthSnapshot } from "./health.ts";
import { reasonLabel, type Metrics } from "./metrics.ts";
import {
  LocalCallerRateLimiter,
  LocalKeyedRateLimiter,
  rateLimitKey,
  type CallerRateLimiter,
  type KeyedRateLimiter,
} from "./rate-limit.ts";
import {
  AccessKeys,
  legacyKeys,
  metricKeyId,
  presentedKey,
  type AccessKeyRecord,
  type PresentedKey,
} from "./access.ts";
import { SIGNUP_REQUESTS_PER_MINUTE, signupRoutes, type IssuedKeyStore } from "./signup.ts";
import { MemoryUsageMeter, accruedFee, type UsageMeter } from "./metering.ts";

export interface ReadinessCheck {
  readonly ok: boolean;
  readonly detail?: string;
}

export interface Readiness {
  readonly ready: boolean;
  readonly checks: Readonly<Record<string, ReadinessCheck>>;
}

/** One network's readiness (`/ready/testnet`, `/ready/pubnet`). */
export interface NetworkReadiness extends Readiness {
  readonly network: string;
  readonly state: NetworkServingState;
  readonly holdReason: HoldReason | null;
}

export interface AppDependencies {
  readonly config: Config;
  readonly facilitator: StellarFacilitator;
  readonly metrics: Metrics;
  readonly log: Logger;
  readonly readiness: () => Promise<Readiness>;
  /** One network's readiness; without it `/ready/<network>` is not served. */
  readonly networkReadiness?: (network: string) => NetworkReadiness | undefined;
  /** Why a network refuses `/verify` and `/settle` now (it is starting or held); undefined while it serves. */
  readonly refusal?: (network: string) => string | undefined;
  /** The background poller's /health snapshot; without it /health reports liveness only. */
  readonly health?: () => HealthSnapshot;
  readonly version: string;
  readonly bazaar?: {
    readonly catalog: Catalog;
    readonly store: CatalogStore;
    readonly search?: SearchService;
  };
  /**
   * The service-wide limit taken before a request's body is read, per client address or, for a key
   * holder's `/verify` and `/settle`, per key (Postgres, shared by replicas); a per-process one is used
   * when absent.
   */
  readonly rateLimiter?: CallerRateLimiter;
  /**
   * That limit for a pubnet request whose key pubnet admits (Postgres, on pubnet's own pool, when pubnet
   * is served next to another network). Without it such requests take `rateLimiter`. Either way, every
   * other caller of pubnet is limited per process (see `callerLimit`).
   */
  readonly pubnetRateLimiter?: CallerRateLimiter;
  /** Usage metering; a per-process meter is used when absent. */
  readonly meter?: UsageMeter;
  /**
   * Settlement-ledger usage of a caller since a time (sponsored fees and recorded service fees); without
   * it `/usage` prices successful settlements at the current fee.
   */
  readonly settlementUsage?: (subject: string, since: Date) => Promise<readonly CallerUsage[]>;
  /** Fees a caller's settlements committed in the last hour on a network, for `/usage` limits. */
  readonly callerCommitted?: (network: string, subject: string) => Promise<bigint>;
  /** The access keys, reloaded by the runtime; built once from the configuration when absent. */
  readonly accessKeys?: AccessKeys;
  /**
   * The per-network limiter applied once the network and the caller are known (Postgres, shared by
   * replicas); a per-process one is used when absent.
   */
  readonly networkLimiter?: KeyedRateLimiter;
  /**
   * The discovery routes' per-address limit and internal-identity buckets (Postgres, on the discovery
   * pool); `rateLimiter` and `networkLimiter` take them when absent.
   */
  readonly discoveryLimiter?: CallerRateLimiter;
  /** Where keys issued through sign-in are kept; with `KEY_SIGNUP` on, `/keys/*` is served with it. */
  readonly issuedKeys?: IssuedKeyStore;
  /** The `fetch` the sign-up routes call GitHub with; the global one when absent. */
  readonly signupFetch?: typeof fetch;
}

/** The service-wide limit one request is charged to: a bucket and the limiter that keeps it. */
interface CallerCharge {
  readonly limiter: CallerRateLimiter;
  /**
   * `addr:<address>` (an IPv6 client by its /64) or `key:<id>`: whatever address a proxy lets a client
   * claim, it never names a key's bucket or one of the other limits that share the store.
   */
  readonly bucket: string;
  /** A key's bucket: its size per minute. An address's is `RATE_LIMIT_PER_MINUTE`. */
  readonly perMinute?: number;
  /**
   * A key's bucket: the charge of the client's address, kept where callers the host's network does not
   * admit are limited. The request pays it as well once its network turns out not to admit the key, so
   * a key never carries keyless requests past its address's limit.
   */
  readonly address?: CallerCharge;
}

/** Takes one request from a charge's bucket: 0 when allowed, else seconds to wait. */
function takeCharge(limiter: CallerRateLimiter, charge: CallerCharge): number | Promise<number> {
  return charge.perMinute === undefined
    ? limiter.take(charge.bucket)
    : limiter.takeLimit(charge.bucket, charge.perMinute);
}

/** The header an internal discovery identity forwards its own client's identifier in. */
const FORWARDED_CLIENT_HEADER = "x-rail402-client";
/** A forwarded client identifier: short and plain, so it cannot grow buckets without bound per value. */
const FORWARDED_CLIENT = /^[A-Za-z0-9._:-]{1,64}$/;

/** Days of usage `/usage` reports. */
const USAGE_DAYS = 31;

/** Longest a settle response waits for cataloging before reporting `processing`. */
const CATALOG_BUDGET_MS = 2_000;
/** How long /verify waits for the Bazaar preview; verification never waits longer for cataloging. */
const PREVIEW_BUDGET_MS = 250;

/** The facilitator's request body, as sent by the stock HTTPFacilitatorClient. */
const facilitatorRequest = z.object({
  x402Version: z.number().int(),
  paymentPayload: z.looseObject({
    x402Version: z.number().int(),
    accepted: z.looseObject({ scheme: z.string(), network: z.string() }),
    payload: z.looseObject({}),
  }),
  paymentRequirements: z.looseObject({ scheme: z.string(), network: z.string() }),
});

type Operation = "verify" | "settle";

/** Route labels for metrics; anything else is counted as "unmatched" to keep label cardinality bounded. */
const ROUTES = new Set([
  "/usage",
  "/keys/new",
  "/keys/callback",
  "/verify",
  "/settle",
  "/supported",
  "/health",
  "/ready",
  "/ready/testnet",
  "/ready/pubnet",
  "/metrics",
  "/metrics/private",
  "/health/private",
  "/discovery/resources",
  "/discovery/search",
]);

export function createApp(deps: AppDependencies): Hono {
  const { config, facilitator, metrics, log } = deps;
  const app = new Hono();
  const limiter: CallerRateLimiter =
    deps.rateLimiter ?? new LocalCallerRateLimiter(config.http.rateLimitPerMinute);
  // Takes over the address and key limits while the shared limiter cannot answer, so no route goes
  // unlimited.
  const fallbackLimiter = new LocalCallerRateLimiter(config.http.rateLimitPerMinute);
  const networkLimiter: KeyedRateLimiter = deps.networkLimiter ?? new LocalKeyedRateLimiter();
  const discoveryFallback = new LocalKeyedRateLimiter();
  const accessKeys =
    deps.accessKeys ??
    new AccessKeys(config.auth.keys, {
      rules: config.auth.rules,
      legacy: legacyKeys(
        config.auth.apiKeyHashes,
        config.networks.map((network) => network.network),
      ),
    });
  const meter: UsageMeter = deps.meter ?? new MemoryUsageMeter();
  const sweep = setInterval(() => {
    void Promise.resolve(limiter.sweep()).catch(() => undefined);
    void Promise.resolve(networkLimiter.sweep()).catch(() => undefined);
    fallbackLimiter.sweep();
  }, 60_000);
  sweep.unref();
  const configured = new Map(config.networks.map((network) => [network.network, network]));
  // Scheme labels come from what the facilitator serves, so a caller cannot grow the label set.
  let served: { schemes: ReadonlySet<string>; kinds: ReadonlySet<string> } | undefined;
  const supported = () => {
    const { kinds } = facilitator.core.getSupported();
    served ??= {
      schemes: new Set(kinds.map((kind) => kind.scheme)),
      kinds: new Set(kinds.map((kind) => `${kind.scheme}|${kind.network}`)),
    };
    return served;
  };
  const schemeLabel = (scheme: string) => (supported().schemes.has(scheme) ? scheme : "unsupported");

  app.use("*", async (c, next) => {
    const started = performance.now();
    await next();
    const route = ROUTES.has(c.req.path)
      ? c.req.path
      : c.req.path.startsWith("/discovery/resources/") ||
          c.req.path.startsWith("/discovery/sellers/") ||
          c.req.path === "/discovery/settlements"
        ? discoveryRouteOf(c.req.path)
        : "unmatched";
    metrics.requestDuration.observe(
      { method: c.req.method, route, status: String(c.res.status) },
      (performance.now() - started) / 1_000,
    );
  });

  // Operational endpoints are exempt from limits and auth.
  // Liveness: 200 whenever the process answers. The body is the last snapshot; building it never
  // waits on the network or the database.
  app.get("/health", (c) => {
    const snapshot = deps.health?.();
    return c.json(snapshot === undefined ? { status: "ok", version: deps.version } : publicHealth(snapshot));
  });
  app.get("/ready", async (c) => {
    const readiness = await deps.readiness();
    return c.json(readiness, readiness.ready ? 200 : 503);
  });
  for (const [path, network] of [
    ["/ready/testnet", "stellar:testnet"],
    ["/ready/pubnet", "stellar:pubnet"],
  ] as const) {
    app.get(path, (c) => {
      const readiness = configured.has(network) ? deps.networkReadiness?.(network) : undefined;
      if (readiness === undefined) return c.json(toErrorBody(httpError("not_found")), 404);
      return c.json(readiness, readiness.ready ? 200 : 503);
    });
  }
  const metricsToken = config.observability.metricsTokenSha256;
  app.get("/metrics", async (c) => {
    if (metricsToken !== undefined && apiKeyDigest(c, new Set([metricsToken]), "bearer") === undefined) {
      c.header("WWW-Authenticate", 'Bearer realm="metrics"');
      return c.json(toErrorBody(httpError("unauthorized")), 401);
    }
    c.header("Content-Type", metrics.registry.contentType);
    return c.body(await publicExposition(metrics.registry));
  });
  // Everything, for the operator's scraper and dashboards: pubnet budget figures and per-key series too.
  const privateToken = config.observability.metricsPrivateTokenSha256;
  const privately = (c: Context): Response | undefined => {
    if (privateToken === undefined) return c.json(toErrorBody(httpError("not_found")), 404);
    if (apiKeyDigest(c, new Set([privateToken]), "bearer") === undefined) {
      c.header("WWW-Authenticate", 'Bearer realm="private"');
      return c.json(toErrorBody(httpError("unauthorized")), 401);
    }
    return undefined;
  };
  app.get("/metrics/private", async (c) => {
    const refused = privately(c);
    if (refused !== undefined) return refused;
    c.header("Content-Type", metrics.registry.contentType);
    return c.body(await exposition(metrics.registry));
  });
  app.get("/health/private", (c) => {
    const refused = privately(c);
    if (refused !== undefined) return refused;
    return c.json(deps.health?.() ?? { status: "ok", version: deps.version });
  });

  // --- discovery settings (DISCOVERY) ---
  // Load shedding, ahead of every limit and database read: discovery beyond what the process can
  // serve is refused at once with a coded 503, so it never piles up behind settlements and health.
  // Each lane (pubnet, everything else) has its own gate: testnet load never sheds pubnet discovery.
  // A slot is held until the response has been handed to its client's connection, not only until the
  // handler answers, so the pages the process keeps for clients that have not taken them are bounded
  // by the slots; RESPONSE_WRITE_TIMEOUT_MS bounds how long. One client holds at most its share of a
  // lane, so a client that reads slowly cannot take every slot.
  if (deps.bazaar !== undefined) {
    const admissions = new DiscoveryAdmissions(config.discovery.admission);
    const gauges = () => {
      metrics.discoveryInFlight.set(admissions.inFlight);
      metrics.discoveryQueued.set(admissions.queued);
    };
    const perClient = config.discovery.admission.maxInFlightPerClient;
    /** Requests each client has in a lane, admitted or waiting, by `lane|client`. */
    const shares = new Map<string, number>();
    app.use("/discovery/*", async (c, next) => {
      const context = c as Context;
      const lane = discoveryLaneOf(scopedNetwork(context) ?? c.req.query("network"));
      const client = discoveryClientOf(context);
      const share = client === undefined ? undefined : `${lane}|${client}`;
      if (share !== undefined && (shares.get(share) ?? 0) >= perClient) {
        metrics.discoveryRateLimited.inc({ route: discoveryRouteOf(c.req.path) });
        c.header("Retry-After", String(DISCOVERY_RETRY_AFTER_SECONDS));
        return c.json(toErrorBody(httpError("rate_limited")), 429);
      }
      if (share !== undefined) shares.set(share, (shares.get(share) ?? 0) + 1);
      const leaveShare = () => {
        if (share === undefined) return;
        const left = (shares.get(share) ?? 1) - 1;
        if (left > 0) shares.set(share, left);
        else shares.delete(share);
      };
      const admission = admissions.lane(lane);
      const entering = admission.enter();
      gauges();
      if (!(await entering)) {
        leaveShare();
        gauges();
        metrics.discoveryShed.inc({ route: discoveryRouteOf(c.req.path), reason: "admission" });
        c.header("Retry-After", String(DISCOVERY_RETRY_AFTER_SECONDS));
        return c.json(toErrorBody(bazaarError("discovery_overloaded")), 503);
      }
      gauges();
      try {
        // Stores and limiters built with `laneRouted` use this lane's connections.
        await discoveryLaneContext.run(lane, next);
        return undefined;
      } finally {
        afterSent(context, () => {
          admission.leave();
          leaveShare();
          gauges();
        });
      }
    });
  }

  /**
   * The client a discovery request counts against for its share of a lane: the forwarded client when
   * an internal discovery identity trusts that header, none for such an identity's own requests (a
   * front end for many users, bounded by the lane itself), and the client's address otherwise. The
   * `addr:` prefix keeps an address, whatever a proxy lets a client claim, from naming a forwarded
   * client's share.
   */
  function discoveryClientOf(c: Context): string | undefined {
    const internal = accessKeys.discoveryCaller(
      presentedKey(c.req.header("authorization"), c.req.header("x-api-key")),
    );
    if (internal === undefined) return `addr:${rateLimitKey(clientAddress(c, config.http.trustedProxyHops))}`;
    const forwarded = c.req.header(FORWARDED_CLIENT_HEADER);
    return internal.forwardedClientRequestsPerMinute !== undefined &&
      forwarded !== undefined &&
      FORWARDED_CLIENT.test(forwarded)
      ? `k:${internal.id}|c:${forwarded}`
      : undefined;
  }
  const discoveryLimiter = deps.discoveryLimiter;
  const discoveryServed = deps.bazaar !== undefined;
  // --- end discovery settings ---

  const pubnetLimiter = deps.pubnetRateLimiter ?? limiter;
  const pubnetAlone = config.networks.length === 1 && configured.has(PUBNET);

  /**
   * The record of a usable payment key: one `network` admits, or, where the network is not known before
   * the body is read, any key that is not revoked, expired or for discovery only.
   */
  const payerOf = (presented: PresentedKey, network: string | undefined): AccessKeyRecord | undefined => {
    if (network !== undefined) {
      const required = isStellarNetwork(network) ? configured.get(network)?.requireApiKey : undefined;
      const decision = accessKeys.decide(presented, network, required ?? true);
      return decision.kind === "served" ? decision.record : undefined;
    }
    const record = accessKeys.holder(presented);
    return record?.scopes.includes("discovery-internal") === false ? record : undefined;
  };

  /**
   * A key's own bucket, kept by `keeper`. Its size is what the key may send a minute on every network it
   * may use (its `requestsPerMinute`, else each network's default), never less than
   * `RATE_LIMIT_PER_MINUTE`, so the key's per-network limits, applied once the body is read, are what
   * limit it.
   */
  const keyCharge = (
    keeper: CallerRateLimiter,
    record: AccessKeyRecord,
    address: CallerCharge,
  ): CallerCharge => ({
    limiter: keeper,
    bucket: `key:${record.id}`,
    address,
    perMinute: Math.max(
      config.http.rateLimitPerMinute,
      config.networks
        .filter((network) => record.networks.includes(network.network))
        .reduce((sum, network) => sum + (record.requestsPerMinute ?? network.keyRequestsPerMinute), 0),
    ),
  });

  /**
   * The bucket of a request's service-wide limit, and the limiter that keeps it, decided from the path,
   * the host and the key in memory, before the body is read.
   *
   * A `/verify` or `/settle` with a usable payment key is charged to a bucket of that key (`key:<id>`,
   * see `keyCharge`) on every host: anonymous traffic and other networks' callers sharing its
   * address or /64 never spend it. Where the host or the process names the network, the key must be one
   * that network admits; elsewhere any usable key is, and a request whose network turns out not to admit
   * it pays its address's bucket as well, like any keyless caller. Every other request is charged to its
   * client address (`addr:<address>`, an IPv6 client by its /64). With `RATE_LIMIT_PER_MINUTE=0` the
   * limit is off, for keys too.
   *
   * Where a request is known to be pubnet's before its body is read (the pubnet host, or a process that
   * serves pubnet alone), an anonymous caller's limit never takes a database connection pubnet's
   * settlements use: a caller pubnet admits is limited through `pubnetRateLimiter` (pubnet's own pool),
   * or the one shared limiter when pubnet has no pool of its own; anyone else (keyless, or with a key
   * pubnet refuses) per process. `/verify` and `/settle` then refuse them before any database work where
   * pubnet requires keys, and hold them to pubnet's keyless limit where it does not. So the admission of
   * a pubnet `/verify` or `/settle` on the pubnet host never waits for the shared pool, whose queue
   * testnet's traffic can fill. Discovery requests keep their limits on the discovery pools instead.
   */
  const callerLimit = (c: Context): CallerCharge => {
    const address = `addr:${rateLimitKey(clientAddress(c, config.http.trustedProxyHops))}`;
    // The discovery routes keep their limits on the discovery pools; without the Bazaar they do not
    // exist, and a request for one is limited like any other path.
    if (discoveryServed && c.req.path.startsWith("/discovery/")) {
      return { limiter: discoveryLimiter ?? limiter, bucket: address };
    }
    const presented = presentedKey(c.req.header("authorization"), c.req.header("x-api-key"));
    const payment = config.http.rateLimitPerMinute > 0 && operationOf(c.req.path) !== undefined;
    const network = pubnetAlone ? PUBNET : scopedNetwork(c);
    if (network === PUBNET) {
      const anonymous = { limiter: fallbackLimiter, bucket: address };
      const admitted = payerOf(presented, PUBNET);
      if (admitted === undefined) return anonymous;
      return payment
        ? keyCharge(pubnetLimiter, admitted, anonymous)
        : { limiter: pubnetLimiter, bucket: address };
    }
    const anonymous = { limiter, bucket: address };
    const payer = payment ? payerOf(presented, network) : undefined;
    return payer === undefined ? anonymous : keyCharge(limiter, payer, anonymous);
  };

  /**
   * Seconds a charge's bucket asks the request to wait (0 = go). A limiter outage must not take the
   * service down with it, nor leave it unlimited: the per-process limiter takes over.
   */
  async function chargeWait(charge: CallerCharge): Promise<number> {
    const scope = charge.perMinute === undefined ? "ip" : "key";
    let wait: number;
    try {
      wait = await takeCharge(charge.limiter, charge);
    } catch (error) {
      log.warn({ err: error }, "rate limiter unavailable; limiting per process");
      metrics.rateLimiterFailures.inc({ scope });
      wait = await takeCharge(fallbackLimiter, charge);
    }
    if (wait > 0) metrics.rateLimited.inc({ scope });
    return wait;
  }

  /**
   * The key charges `/verify` and `/settle` requests passed the service-wide limit with, by the request's
   * context: the one object its middleware and handler share (`bodyLimit` may replace `c.req.raw`).
   */
  const keyCharges = new WeakMap<object, CallerCharge>();

  app.use("*", async (c, next) => {
    // Middleware contexts carry an untyped input; the helpers only read headers and write JSON.
    const context = c as Context;
    // An internal discovery front end draws on its own bucket (and, when trusted, one per forwarded
    // client) instead of the per-address limit, on the discovery routes only.
    if (c.req.path.startsWith("/discovery/")) {
      const internal = accessKeys.discoveryCaller(
        presentedKey(c.req.header("authorization"), c.req.header("x-api-key")),
      );
      if (internal !== undefined) {
        const forwarded = c.req.header(FORWARDED_CLIENT_HEADER);
        const wait = await discoveryWait(internal, forwarded);
        if (wait === 0) {
          // --- discovery settings (DISCOVERY) ---
          discoveryCallers.set(c.req.raw, { record: internal, forwarded });
          // --- end discovery settings ---
          await next();
          return;
        }
        metrics.rateLimited.inc({ scope: "discovery" });
        c.header("Retry-After", String(wait));
        return reject(context, undefined, httpError("rate_limited"));
      }
    }
    const charge = callerLimit(context);
    const retryAfter = await chargeWait(charge);
    if (retryAfter === 0) {
      if (charge.address !== undefined) keyCharges.set(c, charge);
      await next();
      return;
    }
    c.header("Retry-After", String(retryAfter));
    return reject(context, operationOf(c.req.path), httpError("rate_limited"));
  });

  /**
   * Seconds a discovery request of an internal identity must wait (0 = go): the forwarded client's
   * bucket first, when the key trusts the header and the value is well formed (a client over its limit
   * does not use up the identity's), then the identity's own. A limiter
   * failure falls back to per-process buckets: discovery never moves money.
   */
  // --- discovery settings (DISCOVERY) ---
  /** The internal discovery identity a request passed the limits as, and its forwarded client. */
  const discoveryCallers = new WeakMap<
    Request,
    { readonly record: AccessKeyRecord; readonly forwarded: string | undefined }
  >();

  /**
   * The cost buckets a discovery request of an internal identity is charged to: the forwarded client's
   * own (as large as a direct client's), when the key trusts the header and the value is well formed,
   * then the identity's, sized to its request limit. Undefined for every other request, which is
   * charged to its address.
   */
  function discoveryCharges(request: Request): readonly DiscoveryCharge[] | undefined {
    const caller = discoveryCallers.get(request);
    if (caller === undefined) return undefined;
    const { record, forwarded } = caller;
    const charges: DiscoveryCharge[] = [];
    if (
      record.forwardedClientRequestsPerMinute !== undefined &&
      forwarded !== undefined &&
      FORWARDED_CLIENT.test(forwarded)
    ) {
      charges.push({ key: `k:${record.id}|c:${forwarded}`, perMinute: config.discovery.limits.perMinute });
    }
    charges.push({
      key: `k:${record.id}`,
      perMinute: record.discoveryRequestsPerMinute ?? config.auth.discoveryInternalPerMinute,
    });
    return charges;
  }
  // --- end discovery settings ---

  async function discoveryWait(record: AccessKeyRecord, forwarded: string | undefined): Promise<number> {
    const buckets: [string, number][] = [];
    const perClient = record.forwardedClientRequestsPerMinute;
    if (perClient !== undefined && forwarded !== undefined && FORWARDED_CLIENT.test(forwarded)) {
      buckets.push([`discovery|k:${record.id}|c:${forwarded}`, perClient]);
    }
    buckets.push([
      `discovery|k:${record.id}`,
      record.discoveryRequestsPerMinute ?? config.auth.discoveryInternalPerMinute,
    ]);
    for (const [bucket, perMinute] of buckets) {
      let wait: number;
      try {
        wait = await (discoveryLimiter ?? networkLimiter).takeLimit(bucket, perMinute);
      } catch (error) {
        metrics.rateLimiterFailures.inc({ scope: "discovery" });
        log.warn({ err: error }, "rate limiter unavailable; limiting discovery per process");
        wait = discoveryFallback.takeLimit(bucket, perMinute);
      }
      if (wait > 0) return wait;
    }
    return 0;
  }

  /** The network a request's `Host` is scoped to (`PUBLIC_HOSTS`); undefined for every other host. */
  const scopedNetwork = (c: Context): string | undefined => {
    if (config.publicHosts.size === 0) return undefined;
    const host = (c.req.header("host") ?? "").toLowerCase();
    return config.publicHosts.get(host) ?? config.publicHosts.get(host.replace(/:\d+$/, ""));
  };
  /** The host serving `network`, to name in a refusal. */
  const hostFor = (network: string) => [...config.publicHosts].find(([, mapped]) => mapped === network)?.[0];

  const signup = config.keySignup;
  if (signup !== undefined && deps.issuedKeys !== undefined) {
    app.route(
      "/keys",
      signupRoutes({
        config: signup,
        store: deps.issuedKeys,
        accessKeys,
        metrics,
        log,
        onSignupHost: (c) => scopedNetwork(c) === signup.network,
        signupWait: async (c) => {
          const bucket = `signup|addr:${rateLimitKey(clientAddress(c, config.http.trustedProxyHops))}`;
          try {
            return await networkLimiter.takeLimit(bucket, SIGNUP_REQUESTS_PER_MINUTE);
          } catch {
            metrics.rateLimiterFailures.inc({ scope: "ip" });
            return fallbackLimiter.takeLimit(bucket, SIGNUP_REQUESTS_PER_MINUTE);
          }
        },
        ...(deps.signupFetch === undefined ? {} : { fetch: deps.signupFetch }),
      }),
    );
  }

  app.get("/supported", (c) => {
    const supported = facilitator.core.getSupported();
    const network = scopedNetwork(c);
    if (network === undefined) return c.json(supported);
    // A scoped host is a view of one network: its kinds and its own facilitator accounts only.
    const own = facilitator.networks.get(network as StellarNetwork);
    const accounts = own === undefined ? undefined : own.engine.facilitatorAddresses;
    return c.json({
      ...supported,
      kinds: supported.kinds.filter((kind) => kind.network === network),
      signers: Object.fromEntries(
        Object.entries(supported.signers).map(([family, addresses]) => [
          family,
          accounts === undefined ? addresses : addresses.filter((address) => accounts.has(address)),
        ]),
      ),
    });
  });

  // Metering: a key holder reads its own usage and any accrued service fee.
  app.get("/usage", async (c) => {
    const holder = accessKeys.holder(presentedKey(c.req.header("authorization"), c.req.header("x-api-key")));
    if (holder === undefined) return c.json(toErrorBody(httpError("unauthorized")), 401);
    const subject = subjectOf(holder);
    const days = USAGE_DAYS;
    const rows = await meter.usage(subject, days);
    const today = new Date();
    const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - days));
    const ledger = deps.settlementUsage === undefined ? undefined : await deps.settlementUsage(subject, from);
    const successes = rows
      .filter((row) => row.operation === "settle" && row.outcome === "success")
      .reduce((sum, row) => sum + row.requests, 0);
    const networks: Record<string, unknown> = {};
    for (const network of config.networks) {
      if (!holder.networks.includes(network.network)) continue;
      const mine = ledger?.filter((entry) => entry.network === network.network) ?? [];
      const byAsset = new Map<string, bigint>();
      for (const row of rows) {
        if (row.network !== network.network || row.operation !== "settle" || row.outcome !== "success")
          continue;
        byAsset.set(row.asset, (byAsset.get(row.asset) ?? 0n) + BigInt(row.settledAmount));
      }
      const committed = await deps.callerCommitted?.(network.network, subject);
      const budget = holder.sponsorBudgetStroopsPerHour;
      networks[network.network] = {
        settlements: {
          succeeded:
            ledger === undefined
              ? rows
                  .filter(
                    (row) =>
                      row.network === network.network &&
                      row.operation === "settle" &&
                      row.outcome === "success",
                  )
                  .reduce((sum, row) => sum + row.requests, 0)
              : mine.reduce((sum, entry) => sum + entry.succeeded, 0),
          byAsset: [...byAsset].map(([asset, amount]) => {
            const symbol = network.assets.find((candidate) => candidate.contract === asset)?.symbol;
            return { asset, ...(symbol === undefined ? {} : { symbol }), amount: amount.toString() };
          }),
          ...(ledger === undefined
            ? {}
            : {
                sponsoredFeeStroops: mine
                  .reduce((sum, entry) => sum + entry.sponsoredFeeStroops, 0n)
                  .toString(),
                serviceFeeUsd: addUsd(mine.map((entry) => entry.serviceFeeUsd)),
              }),
        },
        limits: {
          requestsPerMinute: holder.requestsPerMinute ?? network.keyRequestsPerMinute,
          ...(budget === undefined ? {} : { sponsorBudgetStroopsPerHour: budget.toString() }),
          ...(committed === undefined ? {} : { sponsorCommitted1hStroops: committed.toString() }),
          ...(holder.expiresAt === undefined ? {} : { expiresAt: holder.expiresAt.toISOString() }),
        },
      };
    }
    return c.json({
      subject,
      keyId: holder.id,
      days,
      window: { from: from.toISOString().slice(0, 10), to: today.toISOString().slice(0, 10) },
      serviceFee: {
        perSettlementUsd: config.serviceFeePerSettlementUsd,
        // The sum of the prices recorded with each settlement; a price change never reprices history.
        accruedUsd:
          ledger === undefined
            ? accruedFee(config.serviceFeePerSettlementUsd, successes)
            : addUsd(ledger.map((entry) => entry.serviceFeeUsd)),
        basis: ledger === undefined ? "current_price" : "per_settlement_recorded_price",
      },
      networks,
      usage: rows,
    });
  });
  if (deps.bazaar !== undefined)
    app.route(
      "/discovery",
      // --- discovery settings (DISCOVERY) ---
      discoveryRoutes(
        deps.bazaar.store,
        deps.bazaar.search,
        {
          ...config.discovery.limits,
          // Prefixed like the share above, so no address names an internal identity's cost buckets.
          clientKey: (c) => `addr:${rateLimitKey(clientAddress(c, config.http.trustedProxyHops))}`,
          charges: (c) => discoveryCharges(c.req.raw),
          onLimited: (route) => {
            metrics.discoveryRateLimited.inc({ route });
          },
        },
        {
          failed: (route, reason, error) => {
            metrics.discoveryShed.inc({ route, reason });
            if (reason === "database_unavailable")
              log.warn({ err: error, route }, "discovery: the catalog database did not answer");
          },
        },
        (network) => config.discovery.networks[network]?.usageDetail ?? defaultUsageDetail(network),
      ),
      // --- end discovery settings ---
    );

  for (const operation of ["verify", "settle"] as const) {
    app.post(
      `/${operation}`,
      bodyLimit({
        maxSize: config.http.bodyLimitBytes,
        onError: (c) => reject(c, operation, httpError("payload_too_large")),
      }),
      async (c) => {
        if (!(c.req.header("content-type") ?? "").toLowerCase().includes("application/json")) {
          return reject(c, operation, httpError("unsupported_media_type"));
        }
        let parsed: z.infer<typeof facilitatorRequest>;
        try {
          const result = facilitatorRequest.safeParse(await c.req.json());
          if (!result.success) {
            return reject(
              c,
              operation,
              httpError("bad_request", { reason: describe(result.error) }),
              "invalid_payload",
            );
          }
          parsed = result.data;
        } catch {
          return reject(
            c,
            operation,
            httpError("bad_request", { reason: "The body is not valid JSON." }),
            "invalid_payload",
          );
        }
        // Stellar schemes are defined for x402 v2 only; the core would throw on anything else.
        if (parsed.x402Version !== 2 || parsed.paymentPayload.x402Version !== 2) {
          return reject(
            c,
            operation,
            httpError("bad_request", {
              reason: `x402Version ${String(parsed.x402Version === 2 ? parsed.paymentPayload.x402Version : parsed.x402Version)} is not supported; Stellar payments use x402 v2.`,
            }),
            "invalid_payload",
          );
        }

        const payload = parsed.paymentPayload as unknown as PaymentPayload;
        const requirements = parsed.paymentRequirements as unknown as PaymentRequirements;
        const network = requirements.network;

        // Refuse what no registered scheme can serve with a coded body instead of the core's exception.
        const networkConfig = isStellarNetwork(network) ? configured.get(network) : undefined;
        const scheme = schemeLabel(requirements.scheme);
        if (networkConfig === undefined)
          return outcome(c, operation, network, scheme, rejection(operation, "invalid_network", network));
        // A host scoped to one network refuses the others, naming the host that serves them.
        const scoped = scopedNetwork(c);
        if (scoped !== undefined && scoped !== network) {
          const elsewhere = hostFor(network);
          const reason = `This host serves ${scoped} only${elsewhere === undefined ? "" : `; send ${network} payments to ${elsewhere}`}.`;
          return outcome(
            c,
            operation,
            network,
            scheme,
            operation === "verify"
              ? verifyRejected("invalid_network", reason)
              : settleFailed({ code: "invalid_network", network, reason }),
          );
        }
        if (!supported().kinds.has(`${requirements.scheme}|${network}`)) {
          return outcome(c, operation, network, scheme, rejection(operation, "unsupported_scheme", network));
        }
        // A network that is starting or held refuses its own payments; the others keep serving.
        const held = deps.refusal?.(network);
        if (held !== undefined) {
          c.header("Retry-After", String(HELD_RETRY_AFTER_SECONDS));
          return reject(c, operation, httpError("service_unavailable", { reason: held }));
        }
        const decision = accessKeys.decide(
          presentedKey(c.req.header("authorization"), c.req.header("x-api-key")),
          network,
          networkConfig.requireApiKey,
        );
        const keyId = decision.kind === "served" ? metricKeyId(decision.record) : decision.keyId;
        if (decision.kind === "unauthorized" || decision.kind === "forbidden") {
          metrics.accessRequests.inc({ network, key_id: keyId, outcome: decision.kind });
          return reject(c, operation, httpError(decision.kind, { reason: decision.reason }));
        }
        const record = decision.kind === "served" ? decision.record : undefined;
        // A key this network does not admit pays here as a keyless caller. Its own bucket let the request
        // in (on a host that does not name the network, any usable key does), so its address pays too.
        const charged = keyCharges.get(c);
        if (record === undefined && charged?.address !== undefined) {
          const wait = await chargeWait(charged.address);
          if (wait > 0) {
            c.header("Retry-After", String(wait));
            return reject(c, operation, httpError("rate_limited"));
          }
        }

        // The network's own limit, once the network and the caller are known: per key, else per address.
        const perMinute =
          record?.requestsPerMinute ??
          (record === undefined
            ? networkConfig.keylessRequestsPerMinute
            : networkConfig.keyRequestsPerMinute);
        if (perMinute !== undefined) {
          const bucket = `n:${network}|${record === undefined ? `ip:${rateLimitKey(clientAddress(c, config.http.trustedProxyHops))}` : `k:${record.id}`}`;
          let wait: number;
          try {
            wait = await networkLimiter.takeLimit(bucket, perMinute);
          } catch (error) {
            metrics.rateLimiterFailures.inc({ scope: "network" });
            if (network === PUBNET) {
              // Mainnet never runs unlimited: without the limiter its payments wait.
              log.error({ err: error, network }, "rate limiter unavailable; refusing pubnet requests");
              c.header("Retry-After", String(HELD_RETRY_AFTER_SECONDS));
              return reject(
                c,
                operation,
                httpError("service_unavailable", { reason: "Rate limiting is unavailable; retry shortly." }),
              );
            }
            log.warn({ err: error, network }, "rate limiter unavailable; serving without the network limit");
            wait = 0;
          }
          if (wait > 0) {
            metrics.rateLimited.inc({ scope: "network" });
            metrics.accessRequests.inc({ network, key_id: keyId, outcome: "rate_limited" });
            c.header("Retry-After", String(wait));
            return reject(c, operation, httpError("rate_limited"));
          }
        }
        metrics.accessRequests.inc({ network, key_id: keyId, outcome: "served" });
        const subject = record === undefined ? PUBLIC_CALLER : subjectOf(record);
        const caller: CallerContext = {
          subject,
          // Key holders accrue the service fee at today's price, recorded with each settlement.
          ...(record === undefined ? {} : { serviceFeeUsd: config.serviceFeePerSettlementUsd }),
          ...(record?.sponsorBudgetStroopsPerHour === undefined
            ? {}
            : { sponsorBudgetStroopsPerHour: record.sponsorBudgetStroopsPerHour }),
        };

        try {
          const answered = await withCaller(caller, () =>
            operation === "verify"
              ? facilitator.core.verify(payload, requirements)
              : facilitator.core.settle(payload, requirements),
          );
          // Extension responses (e.g. the repeat marker) travel in EXTENSION-RESPONSES only: the body
          // is what the resource server relays to the buyer in PAYMENT-RESPONSE.
          const { extensionResponses, ...result } = answered;
          const cataloged = await catalogOutcome(operation, payload, requirements, result);
          if (cataloged !== undefined) {
            metrics.catalogOutcomes.inc({ phase: operation, status: cataloged.status, code: cataloged.code });
          }
          if (cataloged !== undefined || extensionResponses !== undefined) {
            c.header("EXTENSION-RESPONSES", extensionResponsesHeader(cataloged, extensionResponses));
          }
          const repeat = "success" in answered && repeatOf(answered) !== undefined;
          await meterUsage(subject, operation, requirements, result, repeat);
          if (!repeat && "success" in result && result.success && requirements.scheme === "upto") {
            countUpto(network, payload, result);
          }
          return outcome(c, operation, network, scheme, result, 200, repeat);
        } catch (error) {
          log.error({ err: error, network, operation }, "facilitator call threw");
          const code = operation === "verify" ? "unexpected_verify_error" : "unexpected_settle_error";
          return outcome(c, operation, network, scheme, rejection(operation, code, network), 500);
        }
      },
    );
  }

  app.notFound((c) => c.json(toErrorBody(httpError("not_found")), 404));
  app.onError((error, c) => {
    log.error({ err: error, path: c.req.path }, "unhandled request error");
    return reject(c, operationOf(c.req.path), httpError("internal_error"));
  });

  /**
   * Records one verify or settle against the caller's usage; never fails the request. A settle
   * answered from an existing settlement is metered as `repeat`, never as another success.
   */
  async function meterUsage(
    subject: string,
    operation: Operation,
    requirements: PaymentRequirements,
    result: VerifyResponse | SettleResponse,
    repeat: boolean,
  ): Promise<void> {
    const outcome =
      "isValid" in result
        ? result.isValid
          ? "valid"
          : "invalid"
        : repeat
          ? "repeat"
          : result.success
            ? "success"
            : result.errorReason === "settlement_pending"
              ? "pending"
              : "failure";
    try {
      await meter.record({
        subject,
        network: requirements.network,
        operation,
        outcome,
        asset: typeof requirements.asset === "string" ? requirements.asset.slice(0, 64) : "",
        settledAmount: outcome === "success" ? settledAmount(requirements, result) : "0",
      });
    } catch (error) {
      log.warn({ err: error }, "usage metering failed");
    }
  }

  /** Counts a successful `upto` settlement by the amount settled against the cap the payer signed. */
  function countUpto(network: string, payload: PaymentPayload, result: SettleResponse): void {
    const amount = /^\d{1,39}$/.test(result.amount ?? "") ? BigInt(result.amount ?? "0") : undefined;
    const capText = payload.accepted.amount;
    const cap = /^\d{1,39}$/.test(capText) ? BigInt(capText) : undefined;
    if (amount === undefined || cap === undefined || !isStellarNetwork(network)) return;
    metrics.uptoSettlements.inc({
      network,
      amount: amount === 0n ? "zero" : amount >= cap ? "max" : "partial",
      mode: result.transaction === "" ? "offchain" : "onchain",
    });
  }

  /** The Bazaar outcome for the EXTENSION-RESPONSES sidechannel; never fails the payment. */
  async function catalogOutcome(
    operation: Operation,
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    result: VerifyResponse | SettleResponse,
  ): Promise<CatalogOutcome | undefined> {
    const bazaar = deps.bazaar;
    if (bazaar === undefined) return undefined;
    try {
      if (operation === "verify") {
        if (!("isValid" in result) || !result.isValid) return undefined;
        const checking = new Promise<CatalogOutcome>((resolve) => {
          setTimeout(() => {
            resolve({
              status: "processing",
              code: "awaiting_settlement",
              reason:
                "The discovery metadata is still being checked; it is cataloged once the payment settles.",
            });
          }, PREVIEW_BUDGET_MS).unref();
        });
        return await Promise.race([bazaar.catalog.preview(payload, requirements), checking]);
      }
      if (!("success" in result) || !result.success) return undefined;
      // Queued before cataloging starts, so a crash cannot lose it (processQueued finishes it).
      const recording = bazaar.catalog.recordDurably({
        payload,
        requirements,
        payer: result.payer ?? "",
        transaction: result.transaction,
      });
      const pending = new Promise<CatalogOutcome>((resolve) => {
        setTimeout(() => {
          resolve({
            status: "processing",
            code: "cataloging_in_progress",
            reason:
              "The payment settled; cataloging is taking longer than usual and continues in the background.",
          });
        }, CATALOG_BUDGET_MS).unref();
      });
      return await Promise.race([recording, pending]);
    } catch (error) {
      log.error({ err: error, operation }, "cataloging failed");
      return undefined;
    }
  }

  /** Counts and sends a verify or settle answer. Repeats are counted by the settlement observer instead. */
  function outcome(
    c: Context,
    operation: Operation,
    network: string,
    scheme: string,
    result: VerifyResponse | SettleResponse,
    status: 200 | 500 = 200,
    repeat = false,
  ) {
    const label = isStellarNetwork(network) ? network : "unknown";
    if ("isValid" in result) {
      metrics.verifications.inc({
        network: label,
        scheme,
        outcome: result.isValid ? "valid" : "invalid",
        reason: reasonLabel(result.invalidReason),
      });
    } else if (!repeat) {
      const pending = result.errorReason === "settlement_pending";
      metrics.settlements.inc({
        network: label,
        scheme,
        outcome: result.success ? "success" : pending ? "pending" : "failure",
        reason: reasonLabel(result.errorReason),
      });
    }
    return c.json(result, status);
  }

  return app;
}

/**
 * The amount a successful settlement moved: the response's `amount` where the scheme reports one
 * (`upto` settles at most the requirements' amount), otherwise the requirements' amount.
 */
function settledAmount(requirements: PaymentRequirements, result: VerifyResponse | SettleResponse): string {
  const reported = "success" in result ? result.amount : undefined;
  const amount = reported ?? requirements.amount;
  return /^\d{1,39}$/.test(amount) ? amount : "0";
}

function rejection(
  operation: Operation,
  code: ExactStellarCode,
  network: string,
): VerifyResponse | SettleResponse {
  return operation === "verify" ? verifyRejected(code) : settleFailed({ code, network });
}

/**
 * Transport-level rejections. On /verify and /settle the body keeps the x402 response shape, so the
 * stock client raises a typed VerifyError / SettleError with the code, and it also carries `error`.
 */
function reject(c: Context, operation: Operation | undefined, error: Rail402Error, wireCode?: string) {
  const status = error.status as 400;
  const body = toErrorBody(error);
  const code = wireCode ?? error.code;
  if (wireCode !== undefined) reportCode(wireCode);
  if (operation === "verify") {
    return c.json({ isValid: false, invalidReason: code, invalidMessage: error.reason, ...body }, status);
  }
  if (operation === "settle") {
    return c.json(
      {
        success: false,
        errorReason: code,
        errorMessage: error.reason,
        transaction: "",
        network: "",
        ...body,
      },
      status,
    );
  }
  return c.json(body, status);
}

function operationOf(path: string): Operation | undefined {
  return path === "/verify" ? "verify" : path === "/settle" ? "settle" : undefined;
}

function describe(error: z.ZodError): string {
  const [issue] = error.issues;
  if (issue === undefined) return "The request body is malformed.";
  const where = issue.path.length === 0 ? "body" : issue.path.join(".");
  return `Malformed request: ${where}: ${issue.message}.`;
}

/**
 * The configured hash the request's key matches, if any (constant-time comparison). The key comes
 * from `Authorization: Bearer`, or from `X-API-Key` unless only a bearer token is accepted.
 */
function apiKeyDigest(
  c: Context,
  hashes: ReadonlySet<string>,
  accept: "bearer" | "any" = "any",
): string | undefined {
  const header = c.req.header("authorization");
  const key =
    header?.toLowerCase().startsWith("bearer ") === true
      ? header.slice(7).trim()
      : accept === "any"
        ? c.req.header("x-api-key")
        : undefined;
  if (key === undefined || key === "") return undefined;
  const digest = createHash("sha256").update(key).digest();
  let matched: string | undefined;
  for (const hash of hashes) {
    if (timingSafeEqual(digest, Buffer.from(hash, "hex"))) matched = hash;
  }
  return matched;
}

/** A stable, non-secret identifier for an API key in usage and settlement records. */
function subjectOf(record: AccessKeyRecord): string {
  return `key:${record.id}`;
}

/** The client address, honouring X-Forwarded-For only from the configured number of trusted proxies. */
function clientAddress(c: Context, trustedHops: number): string {
  if (trustedHops > 0) {
    const forwarded = (c.req.header("x-forwarded-for") ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "");
    const address = forwarded[forwarded.length - trustedHops];
    if (address !== undefined) return address;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Calls `then` once the response to `c` has been handed to its client's connection, or that
 * connection has closed. At once when there is no Node response to wait for (a request made in
 * process) or it is already closed.
 */
function afterSent(c: Context, then: () => void): void {
  const outgoing = (c.env as Partial<HttpBindings> | undefined)?.outgoing;
  if (!(outgoing instanceof ServerResponse) || outgoing.destroyed) {
    then();
    return;
  }
  outgoing.once("close", then);
}
