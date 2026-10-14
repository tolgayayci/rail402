import { createHash, timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getConnInfo } from "@hono/node-server/conninfo";
import { z } from "zod";
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import { httpError, reportCode, toErrorBody, type Rail402Error } from "@rail402.dev/errors";
import {
  repeatOf,
  settleFailed,
  verifyRejected,
  type Logger,
  type StellarFacilitator,
} from "@rail402.dev/facilitator";
import { isStellarNetwork, type ExactStellarCode } from "@rail402.dev/stellar";
import {
  extensionResponsesHeader,
  type Catalog,
  type CatalogOutcome,
  type CatalogStore,
} from "@rail402.dev/bazaar";
import { discoveryRoutes } from "./discovery.ts";
import type { SearchService } from "@rail402.dev/search";
import type { Config } from "./config.ts";
import type { HealthSnapshot } from "./health.ts";
import { reasonLabel, type Metrics } from "./metrics.ts";
import { RateLimiter, rateLimitKey, type ClientRateLimiter } from "./rate-limit.ts";
import { MemoryUsageMeter, accruedFee, type UsageMeter } from "./metering.ts";

export interface Readiness {
  readonly ready: boolean;
  readonly checks: Readonly<Record<string, { readonly ok: boolean; readonly detail?: string }>>;
}

export interface AppDependencies {
  readonly config: Config;
  readonly facilitator: StellarFacilitator;
  readonly metrics: Metrics;
  readonly log: Logger;
  readonly readiness: () => Promise<Readiness>;
  /** The background poller's /health snapshot; without it /health reports liveness only. */
  readonly health?: () => HealthSnapshot;
  readonly version: string;
  readonly bazaar?: {
    readonly catalog: Catalog;
    readonly store: CatalogStore;
    readonly search?: SearchService;
  };
  /** Shared limiter (Postgres); a per-process token bucket is used when absent. */
  readonly rateLimiter?: ClientRateLimiter;
  /** Usage metering; a per-process meter is used when absent. */
  readonly meter?: UsageMeter;
}

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
  "/verify",
  "/settle",
  "/supported",
  "/health",
  "/ready",
  "/metrics",
  "/discovery/resources",
  "/discovery/search",
]);

export function createApp(deps: AppDependencies): Hono {
  const { config, facilitator, metrics, log } = deps;
  const app = new Hono();
  const limiter: ClientRateLimiter = deps.rateLimiter ?? new RateLimiter(config.http.rateLimitPerMinute);
  const meter: UsageMeter = deps.meter ?? new MemoryUsageMeter();
  const sweep = setInterval(() => {
    void Promise.resolve(limiter.sweep()).catch(() => undefined);
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
      : c.req.path.startsWith("/discovery/resources/")
        ? "/discovery/resources/:id"
        : "unmatched";
    metrics.requestDuration.observe(
      { method: c.req.method, route, status: String(c.res.status) },
      (performance.now() - started) / 1_000,
    );
  });

  // Operational endpoints are exempt from limits and auth.
  // Liveness: 200 whenever the process answers. The body is the last snapshot; building it never
  // waits on the network or the database.
  app.get("/health", (c) => c.json(deps.health?.() ?? { status: "ok", version: deps.version }));
  app.get("/ready", async (c) => {
    const readiness = await deps.readiness();
    return c.json(readiness, readiness.ready ? 200 : 503);
  });
  const metricsToken = config.observability.metricsTokenSha256;
  app.get("/metrics", async (c) => {
    if (metricsToken !== undefined && apiKeyDigest(c, new Set([metricsToken]), "bearer") === undefined) {
      c.header("WWW-Authenticate", 'Bearer realm="metrics"');
      return c.json(toErrorBody(httpError("unauthorized")), 401);
    }
    c.header("Content-Type", metrics.registry.contentType);
    return c.body(await metrics.registry.metrics());
  });

  app.use("*", async (c, next) => {
    // Middleware contexts carry an untyped input; the helpers only read headers and write JSON.
    const context = c as Context;
    let retryAfter = 0;
    try {
      retryAfter = await limiter.take(rateLimitKey(clientAddress(context, config.http.trustedProxyHops)));
    } catch (error) {
      // A limiter outage must not take the service down with it.
      log.warn({ err: error }, "rate limiter unavailable");
    }
    if (retryAfter === 0) {
      await next();
      return;
    }
    metrics.rateLimited.inc();
    c.header("Retry-After", String(retryAfter));
    return reject(context, operationOf(c.req.path), httpError("rate_limited"));
  });

  app.get("/supported", (c) => c.json(facilitator.core.getSupported()));

  // Metering: a key holder reads its own usage and any accrued service fee.
  app.get("/usage", async (c) => {
    const digest = apiKeyDigest(c, config.auth.apiKeyHashes);
    if (digest === undefined) return c.json(toErrorBody(httpError("unauthorized")), 401);
    const subject = subjectOf(digest);
    const rows = await meter.usage(subject, 31);
    const settlements = rows
      .filter((row) => row.operation === "settle" && row.outcome === "success")
      .reduce((sum, row) => sum + row.requests, 0);
    return c.json({
      subject,
      days: 31,
      serviceFee: {
        perSettlementUsd: config.serviceFeePerSettlementUsd,
        accruedUsd: accruedFee(config.serviceFeePerSettlementUsd, settlements),
      },
      usage: rows,
    });
  });
  if (deps.bazaar !== undefined)
    app.route("/discovery", discoveryRoutes(deps.bazaar.store, deps.bazaar.search));

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
        if (!supported().kinds.has(`${requirements.scheme}|${network}`)) {
          return outcome(c, operation, network, scheme, rejection(operation, "unsupported_scheme", network));
        }
        const digest = apiKeyDigest(c, config.auth.apiKeyHashes);
        if (networkConfig.requireApiKey && digest === undefined) {
          return reject(c, operation, httpError("unauthorized"));
        }
        const subject = digest === undefined ? "public" : subjectOf(digest);

        try {
          const answered =
            operation === "verify"
              ? await facilitator.core.verify(payload, requirements)
              : await facilitator.core.settle(payload, requirements);
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

/** A stable, non-secret identifier for an API key in usage records. */
function subjectOf(digest: string): string {
  return `key:${digest.slice(0, 16)}`;
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
