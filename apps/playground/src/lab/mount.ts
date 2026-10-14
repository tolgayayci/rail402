import { Hono, type MiddlewareHandler } from "hono";
import type { Logger } from "pino";
import { HTTPFacilitatorClient, x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import { paymentMiddleware } from "@x402/hono";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { TESTNET } from "@rail402.dev/stellar";
import { UptoStellarServerScheme } from "@rail402.dev/sdk/seller";
import type { PlaygroundConfig } from "../config.ts";
import { errorResponse, refuse, type ServerEnv } from "../http.ts";
import { RateLimiter, SharedRate, type Clock } from "../limits.ts";
import { isPaymentHeader } from "../payment-header.ts";
import type { Metrics } from "../metrics.ts";
import { LAB_PATHS, LAB_PREFIX } from "../shared/lab.ts";
import { TRACE_HEADER, decodeTrace } from "../shared/trace.ts";
import { cityOf, forecastFor, declareSellRoute, sellBazaarExtension } from "./sell.ts";
import { GREEDY_ROUTE_KEY, greedyHandler, greedyRouteConfig } from "./greedy.ts";
import { offerHandler, type OfferId } from "./offers.ts";
import { STELLAR_TOML_HEADERS, STELLAR_TOML_PATH, stellarToml } from "./stellar-toml.ts";
import { TraceRecorder } from "./trace.ts";

export interface LabOptions {
  readonly config: PlaygroundConfig;
  readonly metrics: Metrics;
  readonly log: Logger;
  readonly now?: Clock;
  /** The facilitator lab sellers verify and settle through; FACILITATOR_URL over HTTP by default. */
  readonly facilitator?: FacilitatorClient;
}

export interface Lab {
  /** Drops idle rate-limit buckets; called periodically. */
  sweep(): void;
}

/** After a failed facilitator /supported read, lab payments wait this long before trying again. */
const RETRY_SUPPORTED_MS = 5_000;

/** Headers of a payment middleware answer that stay on a reply replaced by a coded error. */
const KEPT_HEADERS = ["payment-required", "payment-response"] as const;

/** The metrics label of a lab path: its route, or `unmatched`. */
export function labRouteOf(path: string): string {
  if (/^\/lab\/sell\/forecast\/[^/]+$/.test(path)) return LAB_PATHS.sell;
  if (path === LAB_PATHS.greedy) return LAB_PATHS.greedy;
  for (const offer of Object.values(LAB_PATHS.offers)) if (path === offer) return offer;
  return "unmatched";
}

/**
 * The Playground's own sellers under `/lab/`, and the domain's stellar.toml.
 *
 * Every lab request is rebuilt on `PUBLIC_URL` before the sellers see it, so the resource URLs in
 * their 402s and in the catalog are the public https URLs even behind a TLS-terminating proxy. The
 * sellers are the stock `@x402/hono` payment middleware with the Stellar `exact` and `upto` server
 * schemes, settling through the configured facilitator; each response carries `Rail402-Trace`.
 * Limits: unpaid and paid requests per client, and paid requests across all clients (fair-shared by
 * network), since every paid request costs a verify and a settle at the facilitator. A payment header
 * that holds no payment is refused before any limit counts it; one the sellers refuse without calling
 * the facilitator gives the shared pool its token back.
 */
export function mountLab(app: Hono<ServerEnv>, options: LabOptions): Lab {
  const { config, metrics } = options;
  const now = options.now ?? Date.now;
  const limits = config.limits;
  const unpaid = new RateLimiter(limits.labUnpaidPerMinute, limits.labUnpaidPerMinute, now);
  const paid = new RateLimiter(limits.labPaidPerMinute, limits.labPaidPerMinute, now);
  const paidGlobal = new SharedRate(limits.labPaidGlobalPerMinute, limits.labPaidPerMinute, now);
  const payTo = config.payTo;

  if (!config.features.lab || payTo === undefined) {
    app.get(`${LAB_PREFIX}*`, (c) => refuse(c, "playground_feature_disabled"));
    return { sweep() {} };
  }

  const toml = stellarToml(config, payTo);
  app.get(STELLAR_TOML_PATH, (c) => c.body(toml, 200, { ...STELLAR_TOML_HEADERS }));

  const sellers = labSellers({ ...options, now }, payTo);
  app.get(`${LAB_PREFIX}*`, async (c) => {
    const client = c.get("clientKey");
    const signature = c.req.header("payment-signature");
    const legacy = c.req.header("x-payment");
    const isPaid = signature !== undefined || legacy !== undefined;
    c.get("requestLog").fields["paid"] = isPaid;
    // HEAD reaches GET routes: it may ask for the 402, but a payment needs the GET it pays for.
    if (isPaid && c.req.method === "HEAD") {
      return refuse(c, "playground_request_invalid", { reason: "A paid lab request must be a GET." });
    }
    // Only a real payment counts against the paid limits every visitor shares.
    if (
      (signature !== undefined && !isPaymentHeader(signature)) ||
      (legacy !== undefined && !isPaymentHeader(legacy, [1, 2]))
    ) {
      return refuse(c, "playground_request_invalid", {
        reason: "The payment header does not hold an x402 payment payload.",
      });
    }
    const buckets: [Pick<RateLimiter, "take" | "refund">, string, string][] = isPaid
      ? [
          [paid, client, "lab_paid"],
          [paidGlobal, c.get("networkKey"), "lab_paid_global"],
        ]
      : [[unpaid, client, "lab_unpaid"]];
    const taken: [Pick<RateLimiter, "refund">, string][] = [];
    for (const [bucket, key, limit] of buckets) {
      const retryAfter = bucket.take(key);
      if (retryAfter > 0) {
        for (const [done, doneKey] of taken) done.refund(doneKey);
        metrics.rateLimited.inc({ limit });
        return refuse(c, "playground_rate_limited", { retryAfter });
      }
      taken.push([bucket, key]);
    }
    // The sellers see the request on the public origin: resource URLs never name an internal host.
    const url = new URL(c.req.url);
    const request = new Request(`${config.publicUrl}${url.pathname}${url.search}`, {
      method: "GET",
      headers: c.req.raw.headers,
      signal: c.req.raw.signal,
    });
    const response = await sellers.fetch(request);
    // A payment the sellers refused without asking the facilitator (a payload that only has the shape
    // of one) cost the facilitator nothing: the pool every visitor shares gets its token back. The
    // client's own paid token stays spent, so this cannot be repeated faster than its paid rate.
    if (isPaid && decodeTrace(response.headers.get(TRACE_HEADER))?.verify === undefined) {
      paidGlobal.refund(c.get("networkKey"));
    }
    const code = response.headers.get(CODE_HEADER);
    if (code !== null) {
      c.get("requestLog").fields["code"] = code;
      response.headers.delete(CODE_HEADER);
    }
    return response;
  });

  return {
    sweep() {
      for (const bucket of [unpaid, paid, paidGlobal]) bucket.sweep();
    },
  };
}

/** Carries a refusal's code from the sellers' sub-app to the access log; removed before sending. */
const CODE_HEADER = "x-playground-code";

function coded(...args: Parameters<typeof errorResponse>): Response {
  const response = errorResponse(...args);
  response.headers.set(CODE_HEADER, args[0]);
  return response;
}

/** The sub-app serving the lab sellers on requests already rebuilt on PUBLIC_URL. */
function labSellers(options: LabOptions & { readonly now: Clock }, payTo: string): Hono {
  const { config, metrics, log, now } = options;
  const recorder = new TraceRecorder(metrics);
  const facilitator = recorder.wrap(
    options.facilitator ?? new HTTPFacilitatorClient({ url: config.urls.facilitator }),
  );
  const exactServer = new x402ResourceServer(facilitator)
    .register(TESTNET, new ExactStellarScheme())
    .registerExtension(sellBazaarExtension);
  const uptoServer = new x402ResourceServer(facilitator).register(TESTNET, new UptoStellarServerScheme());
  const sell = declareSellRoute(config, payTo);

  const lab = new Hono();
  lab.use("*", recorder.middleware(labRouteOf));
  // The stock middleware answers a facilitator failure with 502 and an internal failure with 500,
  // with upstream text in the body. Both become a coded refusal; x402 headers and the trace stay.
  lab.use("*", async (c, next) => {
    await next();
    if (c.res.status !== 500 && c.res.status !== 502) return;
    const kept: Record<string, string> = {};
    for (const name of KEPT_HEADERS) {
      const value = c.res.headers.get(name);
      if (value !== null) kept[name] = value;
    }
    c.res = undefined;
    c.res = coded("playground_lab_unavailable", { headers: kept });
  });
  // Only a city name gets a 402: free text never reaches the listing or a payment.
  lab.use(LAB_PATHS.sell, async (c, next) => {
    if (cityOf(new URL(c.req.url).pathname) === undefined) {
      c.res = coded("playground_not_found", {
        reason: "The sandbox serves a city name: letters, spaces, dots, apostrophes and hyphens, up to 40.",
      });
      return;
    }
    await next();
  });
  lab.use(
    LAB_PATHS.sell,
    ready(exactServer, now, (server) => server.getSupportedKind(2, TESTNET, "exact")),
  );
  lab.use(
    LAB_PATHS.greedy,
    ready(uptoServer, now, (server) => server.getSupportedKind(2, TESTNET, "upto")),
  );
  // The readiness checks above initialize each resource server; the middleware never does it itself.
  lab.use(paymentMiddleware({ [sell.key]: sell.config }, exactServer, undefined, undefined, false));
  lab.use(
    paymentMiddleware(
      { [GREEDY_ROUTE_KEY]: greedyRouteConfig(config, payTo) },
      uptoServer,
      undefined,
      undefined,
      false,
    ),
  );

  lab.get(LAB_PATHS.sell, (c) => c.json(forecastFor(cityOf(new URL(c.req.url).pathname) ?? "")));
  lab.get(LAB_PATHS.greedy, greedyHandler);
  for (const [id, path] of Object.entries(LAB_PATHS.offers)) {
    lab.get(path, offerHandler(id as OfferId, config, payTo));
  }

  lab.notFound(() => coded("playground_not_found"));
  lab.onError((error) => {
    log.error({ err: error }, "lab seller failed unexpectedly");
    return coded("playground_internal_error");
  });
  return lab;
}

/**
 * Initializes a resource server from the facilitator's /supported before its route takes payments,
 * and refuses with `playground_lab_unavailable` while the facilitator cannot be read or does not serve
 * the route's scheme. A failure is retried after a few seconds.
 */
function ready(
  server: x402ResourceServer,
  now: Clock,
  serves: (server: x402ResourceServer) => unknown,
): MiddlewareHandler {
  let state: Promise<boolean> | undefined;
  let failedAt = Number.NEGATIVE_INFINITY;
  const check = (): Promise<boolean> => {
    state ??= server.initialize().then(
      () => serves(server) !== undefined,
      () => false,
    );
    return state.then((ok) => {
      if (!ok) {
        state = undefined;
        failedAt = now();
      }
      return ok;
    });
  };
  return async (c, next) => {
    const ok = now() - failedAt < RETRY_SUPPORTED_MS ? false : await check();
    if (!ok) {
      c.res = coded("playground_lab_unavailable", {
        reason: "The facilitator cannot be reached or does not serve this payment scheme; retry shortly.",
        retryAfter: Math.ceil(RETRY_SUPPORTED_MS / 1_000),
      });
      return;
    }
    await next();
  };
}
