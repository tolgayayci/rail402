import { Hono } from "hono";
import type { Context, Next } from "hono";
import { cors } from "hono/cors";
import { getConnInfo } from "@hono/node-server/conninfo";
import { z } from "zod";
import { createError, type ErrorCode } from "@rail402/errors";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { FacilitatorConfig } from "./config/env.js";
import { buildFacilitator } from "./facilitator/build.js";
import {
  CatalogStore,
  createBazaarApp,
  catalogSettledPayment,
  catalogProvisionalPayment,
  DomainVerifier,
  TrustlineChecker,
  SignalStore,
  SqliteCatalogPersistence,
  FederatedCatalog,
  type CatalogPersistence,
} from "@rail402/bazaar";

/**
 * HTTP surface: `/verify`, `/settle`, `/supported` (the standard x402 facilitator interface),
 * plus `/health` and `/metrics` for operations.
 *
 * Every rejection on every route returns `{ code, reason, retryable }` from the shared registry.
 * There is no path through this file that produces a bare status code or a null reason.
 */

/**
 * The facilitator request envelope, per the core spec §7.1/§7.2.
 * Both `/verify` and `/settle` take the same shape; schemes may assign different meaning to
 * fields at settle time (notably `upto`'s phase-dependent `amount`).
 */
const FacilitatorRequestSchema = z.object({
  x402Version: z.number().int().optional(),
  paymentPayload: z.looseObject({}),
  paymentRequirements: z.looseObject({}),
});

export interface AppDeps {
  /**
   * Catalog durability backend, injected.
   *
   * Node deployments build a SQLite backend from `CATALOG_DB_PATH`. Workers cannot — no disk
   * survives an isolate — so the Worker entrypoint injects a D1-backed one instead. Same seam,
   * different storage; nothing else in the app knows the difference.
   */
  readonly persistence?: CatalogPersistence;
  readonly config: FacilitatorConfig;
  readonly startedAt: number;
}

/** Parsed request envelope, shared between the parse middleware, auth, and the handlers. */
interface ParsedRequest {
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
}

type AppEnv = { Variables: { parsedBody: ParsedRequest } };

interface Counters {
  verifyOk: number;
  verifyFail: number;
  settleOk: number;
  settleFail: number;
  rejectedByCode: Map<string, number>;
}

export function createApp({ config, startedAt, persistence }: AppDeps) {
  const { facilitator, signerAddresses, feeBumpAddress } = buildFacilitator(config);

  // The schemes this facilitator actually serves on a network, derived from the same source as
  // `/supported`, so an `unsupported_scheme` rejection can never contradict what is advertised
  // (the old payload hardcoded `["exact"]` while `/supported` advertised `upto` too).
  const supportedSchemesFor = (network: string | undefined): string[] => {
    try {
      return (facilitator.getSupported().kinds as { scheme: string; network: string }[])
        .filter(k => k.network === network)
        .map(k => k.scheme);
    } catch {
      return [];
    }
  };

  // Bazaar co-deployed in-process. The module boundary stays clean (it is a separate package with
  // its own service entrypoint), but running it here means cataloging needs no network hop and the
  // seller gets the EXTENSION-RESPONSES verdict on the same response that settled their payment.
  // Online search signals: zero-result queries, searches that never convert to a paid
  // call, and which result a buyer actually paid for. These feed the human-reviewed judgment set;
  // nothing here influences live ranking, because conversions are caller-reported and therefore
  // forgeable. See apps/bazaar/src/search/signals.ts.
  const signals = new SignalStore();
  // Durable when configured, in-memory otherwise. The catalog is derived state, but nothing replays
  // settlement history to rebuild it, so an unconfigured restart genuinely forgets every seller.
  // Ranking is identical either way — the retriever indexes what is in memory, which is now restored
  // at boot rather than starting empty.
  const catalogDb =
    persistence ?? (config.catalogDbPath ? new SqliteCatalogPersistence({ path: config.catalogDbPath }) : undefined);
  // Read-only mirrors of other catalogs, merged at read time and clearly labelled ("Stellar is not a walled garden"). Empty unless an operator configures a source AND records that
  // a human read its terms — mirroring republishes somebody else's data, so it fails closed.
  const federated = new FederatedCatalog(config.federationSources);
  const catalog = new CatalogStore(undefined, signals, catalogDb, federated);
  // SEP-1 seller verification. Ties the party being paid to the domain being listed, which is what
  // stops a squatter claiming an endpoint they do not own. Never
  // awaited on the settlement path — see `catalogSettledPayment`.
  const domains = new DomainVerifier();
  // Trustline pre-flight. Answers "can this payee actually receive what the listing is priced in?"
  // at discovery time instead of at settlement time, which on Stellar is the difference between an
  // agent picking a different seller and an agent signing a payment that cannot land.
  // Advisory, cached, never on the settlement path, and it never gates cataloging.
  const trustlines = new TrustlineChecker();
  const servedNetworks = config.networks.map(n => n.network);

  const counters: Counters = {
    verifyOk: 0,
    verifyFail: 0,
    settleOk: 0,
    settleFail: 0,
    rejectedByCode: new Map(),
  };
  const countRejection = (code: string | undefined) => {
    const key = code ?? "unknown";
    counters.rejectedByCode.set(key, (counters.rejectedByCode.get(key) ?? 0) + 1);
  };

  const app = new Hono<AppEnv>();

  if (config.corsOrigins.length > 0) {
    // `EXTENSION-RESPONSES` must be listed explicitly or a browser client cannot read it. CORS only
    // exposes the handful of "simple" response headers to JavaScript by default, so a custom header
    // is emitted, arrives, and is then hidden by the browser — the seller sees nothing and has no way
    // to tell that from the header never being sent. That is precisely the half of the incumbent's
    // bug that is easy to miss: it is reported both as never emitting the header AND as leaving
    // `access-control-expose-headers` empty, so even a fixed emitter would still be unreadable.
    app.use(
      "*",
      cors({ origin: [...config.corsOrigins], exposeHeaders: ["EXTENSION-RESPONSES"] }),
    );
  }

  // ── Rate limiting ─────────────────────────────────────────────────────────
  // Fixed-window counter, in-process. Deliberately simple: the free testnet endpoint needs
  // basic burst protection (threat model: DoS on free endpoints), and an operator running
  // multiple replicas should front them with a shared limiter rather than rely on this.
  const buckets = new Map<string, { count: number; resetAt: number }>();
  if (config.rateLimit.enabled) {
    app.use("/verify", rateLimit);
    app.use("/settle", rateLimit);
  }

  /**
   * Identify a caller for rate-limiting purposes.
   *
   * Order matters, and the original order was backwards. `X-Forwarded-For`'s **first** element is
   * whatever the client sent — Cloudflare and most proxies APPEND rather than replace — so
   * preferring it handed every caller a free bypass: rotate the header, get a fresh bucket
   * Headers a trusted proxy sets itself come first now, and when we do
   * fall back to `X-Forwarded-For` we take the **last** hop, which is the one our own proxy wrote.
   *
   * With no proxy headers at all we use the socket address rather than a single shared
   * `"anonymous"` bucket. That bucket was worse than no limiter: one noisy caller exhausted the
   * window for the entire internet, which is a denial of service we would have inflicted on
   * ourselves.
   */
  function clientKey(c: Context<AppEnv>): string {
    // Every client-IP header (`cf-connecting-ip`, `x-real-ip`, `x-forwarded-for`) is client-settable
    // unless a trusted proxy in front sets it and strips the incoming value. So they are believed
    // ONLY when the operator asserts that proxy via TRUST_PROXY. Trusting them unconditionally — the
    // earlier bug — handed every caller a free rate-limit bypass: rotate the header, get a fresh
    // bucket (the XFF-ordering fix left these two ungated). Within the
    // gate we take the last `x-forwarded-for` hop, which is the one our own proxy wrote.
    if (config.trustProxy) {
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

  async function rateLimit(c: Context<AppEnv>, next: Next) {
    const key = clientKey(c);
    const now = Date.now();
    const windowMs = config.rateLimit.windowSeconds * 1000;
    const bucket = buckets.get(key);

    if (!bucket || now >= bucket.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (bucket.count >= config.rateLimit.maxRequests) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      c.header("Retry-After", String(retryAfter));
      return c.json(
        createError("facilitator_rate_limited", {
          reason: `Rate limit exceeded: at most ${config.rateLimit.maxRequests} requests per ${config.rateLimit.windowSeconds}s. Retry in ${retryAfter}s.`,
          details: { retryAfterSeconds: retryAfter },
        }),
        429,
      );
    }
    bucket.count += 1;
    return next();
  }

  // ── Caller authentication ─────────────────────────────────────────────────
  // Off by default so testnet is free and frictionless. When keys are configured,
  // networks listed in AUTH_EXEMPT_NETWORKS stay open — an operator can charge for pubnet while
  // keeping testnet public.
  // Body parsing runs BEFORE auth so the per-network exemption can see which network is being
  // paid on. Ordering matters: with auth first, `parsedBody` would always be undefined and the
  // AUTH_EXEMPT_NETWORKS carve-out would silently never apply.
  async function parseBodyMiddleware(c: Context<AppEnv>, next: Next) {
    const parsed = await parseBody(c);
    if ("error" in parsed) return c.json(parsed.error, 400);
    c.set("parsedBody", parsed);
    return next();
  }

  async function requireAuth(c: Context<AppEnv>, next: Next) {
    if (config.apiKeys.length === 0) return next();

    const body = c.get("parsedBody");
    const network = body?.paymentRequirements?.network;
    if (typeof network === "string" && config.authExemptNetworks.includes(network)) {
      return next();
    }

    const header = c.req.header("authorization") ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!token || !config.apiKeys.includes(token)) {
      return c.json(
        createError("facilitator_authentication_required", {
          reason: `Caller authentication required for ${typeof network === "string" ? network : "this request"}. Supply a valid API key as \`Authorization: Bearer <key>\`.`,
          details: { exemptNetworks: config.authExemptNetworks },
        }),
        401,
      );
    }
    return next();
  }

  // ── Routes ────────────────────────────────────────────────────────────────

  app.get("/health", c =>
    c.json({
      status: "ok",
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      networks: config.networks.map(n => n.network),
      signers: signerAddresses.length,
      feeBump: feeBumpAddress ? "enabled" : "disabled",
      catalog: {
        entries: catalog.size,
        ...(catalog.federatedSize > 0 || federated.refusals.length > 0
          ? {
              federated: catalog.federatedSize,
              ...(federated.refusals.length > 0
                ? { federationRefused: federated.refusals.map(r => r.code) }
                : {}),
            }
          : {}),
        // The degraded-mode story, stated where an operator will actually see it.
        // "durable" means writes are landing; "degraded" means the catalog is still SERVING but will
        // not survive a restart, with the reason attached.
        storage: catalogDb === undefined ? "memory" : catalog.persistenceDegraded ? "degraded" : "durable",
        ...(catalog.persistenceDegraded ? { storageError: catalog.persistenceDegraded } : {}),
      },
    }),
  );

  app.get("/supported", c => {
    try {
      const supported = facilitator.getSupported();
      // Advertise `bazaar` because the discovery endpoints below genuinely serve it. The public
      // x402.org facilitator advertises no bazaar and serves no /discovery/* — we keep the two in
      // agreement, which is the whole point of the advertised-vs-reachable critique.
      // Advertise `bazaar` ONLY where /discovery/* is actually reachable. A deployment that claims
      // the extension and then 404s the endpoints is the advertised-versus-reachable failure this
      // project documents in other facilitators — and a stock client reading `extensions` would
      // believe it. On a split deployment (stateless facilitator on Workers, Bazaar on a stateful
      // host) the Worker sets SERVES_DISCOVERY=0 and tells the truth.
      const extensions = config.servesDiscovery
        ? [...supported.extensions, "bazaar"]
        : [...supported.extensions];
      return c.json({ ...supported, extensions });
    } catch (error) {
      return c.json(
        createError("unexpected_verify_error", {
          reason: `Could not build the supported response: ${asMessage(error)}`,
        }),
        500,
      );
    }
  });

  app.post("/verify", parseBodyMiddleware, requireAuth, async c => {
    const parsed = c.get("parsedBody");

    try {
      const response = await facilitator.verify(
        parsed.paymentPayload,
        parsed.paymentRequirements,
      );
      if (response.isValid) {
        counters.verifyOk += 1;
        // Hybrid cataloging: catalog the resource PROVISIONALLY at verify, so it shows up
        // "during payment verification" the way the upstream reference facilitator does and the e2e
        // conformance suite expects. A provisional entry is discoverable but carries no ranking
        // signals and no ownership; the settle-path call below is what confirms it, ranks it, and
        // makes it the seller's — so the anti-spam property is unchanged and a hostile `/verify` can
        // neither rank nor spoof nor lock out a listing. The seller also gets the `processing` /
        // `rejected` verdict here rather than settling a payment to discover a typo.
        //
        // Isolated for the same reason as the settle-path catalog call below: a throw here must not
        // turn a valid verification into a retryable error the agent loops on.
        try {
          const header = catalogProvisionalPayment(
            catalog,
            parsed.paymentPayload,
            parsed.paymentRequirements,
            new Date().toISOString(),
            servedNetworks,
            config.allowPrivateHosts,
          );
          if (header) c.header("EXTENSION-RESPONSES", header);
        } catch (provisionalError) {
          console.error("provisional cataloging failed on a valid verification (verification stands):", provisionalError);
        }
      } else {
        counters.verifyFail += 1;
        countRejection(response.invalidReason);
      }
      return c.json(response);
    } catch (error) {
      counters.verifyFail += 1;
      const { payload, status } = classifyFacilitatorThrow(
        error,
        parsed.paymentRequirements,
        config,
        "unexpected_verify_error",
        supportedSchemesFor,
      );
      countRejection(payload.code);
      return c.json(payload, status);
    }
  });

  app.post("/settle", parseBodyMiddleware, requireAuth, async c => {
    const parsed = c.get("parsedBody");

    try {
      const response = await facilitator.settle(
        parsed.paymentPayload,
        parsed.paymentRequirements,
      );
      if (response.success) {
        counters.settleOk += 1;
        // Automatic cataloging: no separate registration step. Gated on SUCCESSFUL settlement, so
        // every listing costs a real on-chain payment — the strongest anti-spam property we have.
        //
        // Cataloging is a side-effect of a completed payment, never a condition of it. The money has
        // already moved and `response.transaction` is the proof, so a throw in the ingest path must
        // NOT be caught by the handler's outer catch and turned into a retryable 500 — that would
        // tell the buyer their settled payment failed and invite a double-payment. Isolate it: the
        // settlement stands regardless, and a cataloging fault is logged for operators.
        try {
          const header = catalogSettledPayment(
            catalog,
            parsed.paymentPayload,
            parsed.paymentRequirements,
            response.payer,
            new Date().toISOString(),
            servedNetworks,
            domains,
            trustlines,
            config.allowPrivateHosts,
          );
          if (header) c.header("EXTENSION-RESPONSES", header);
        } catch (catalogError) {
          console.error("cataloging failed after a successful settlement (settlement stands):", catalogError);
        }
      } else {
        counters.settleFail += 1;
        countRejection(response.errorReason);
      }
      return c.json(response);
    } catch (error) {
      counters.settleFail += 1;
      const { payload, status } = classifyFacilitatorThrow(
        error,
        parsed.paymentRequirements,
        config,
        "unexpected_settle_error",
        supportedSchemesFor,
      );
      countRejection(payload.code);
      return c.json(payload, status);
    }
  });

  /**
   * Search-signal report — query text, so it is NOT public.
   *
   * Aggregate rates go to `/metrics` where anyone may read them. The query strings themselves are
   * user-supplied content, and publishing one caller's searches to another is the kind of leak that
   * is obvious in hindsight and invisible until it happens. So this endpoint requires a configured
   * API key and returns 404 — not 403 — when no keys are set, because an operator running the open
   * testnet default should not even learn that the route exists.
   */
  app.get("/ops/signals", c => {
    if (config.apiKeys.length === 0) {
      return c.json(
        createError("invalid_payload", {
          reason:
            "No such endpoint: GET /ops/signals. The search-signal report exposes raw query text and is only served when FACILITATOR_API_KEYS is configured.",
        }),
        404,
      );
    }
    const header = c.req.header("authorization") ?? "";
    const token = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!token || !config.apiKeys.includes(token)) {
      return c.json(
        createError("facilitator_authentication_required", {
          reason:
            "The search-signal report requires a valid API key as `Authorization: Bearer <key>`, because it returns raw search query text.",
        }),
        401,
      );
    }
    return c.json({ ...signals.report(), proposedJudgments: signals.proposedJudgments() });
  });

  app.get("/metrics", c => {
    // Aggregates only — never query text. A Prometheus label carrying user-supplied search strings
    // would be both a cardinality bomb and a data leak.
    const s = signals.report(0);
    const lines = [
      "# HELP x402_verify_total Verification outcomes.",
      "# TYPE x402_verify_total counter",
      `x402_verify_total{outcome="valid"} ${counters.verifyOk}`,
      `x402_verify_total{outcome="invalid"} ${counters.verifyFail}`,
      "# HELP x402_settle_total Settlement outcomes.",
      "# TYPE x402_settle_total counter",
      `x402_settle_total{outcome="success"} ${counters.settleOk}`,
      `x402_settle_total{outcome="failure"} ${counters.settleFail}`,
      "# HELP x402_rejections_total Rejections by machine-readable code.",
      "# TYPE x402_rejections_total counter",
      ...[...counters.rejectedByCode.entries()].map(
        ([code, n]) => `x402_rejections_total{code="${code}"} ${n}`,
      ),
      "# HELP x402_bazaar_searches_total Discovery searches served.",
      "# TYPE x402_bazaar_searches_total counter",
      `x402_bazaar_searches_total ${s.searches}`,
      "# HELP x402_bazaar_zero_result_rate Share of searches returning nothing. The clearest retrieval gap signal.",
      "# TYPE x402_bazaar_zero_result_rate gauge",
      `x402_bazaar_zero_result_rate ${s.zeroResultRate.toFixed(4)}`,
      "# HELP x402_bazaar_conversion_rate Share of searches followed by a paid call citing their token.",
      "# TYPE x402_bazaar_conversion_rate gauge",
      `x402_bazaar_conversion_rate ${s.conversionRate.toFixed(4)}`,
      "# HELP x402_bazaar_mean_converted_rank Mean rank of the resource a buyer paid for. Drifting up means ranking is degrading.",
      "# TYPE x402_bazaar_mean_converted_rank gauge",
      `x402_bazaar_mean_converted_rank ${s.meanConvertedRank ?? 0}`,
      // Operator status stats — aggregate and unattributed, never per-caller (F1). The facilitator
      // is free; these describe the service, not who used it.
      "# HELP x402_uptime_seconds Process uptime.",
      "# TYPE x402_uptime_seconds gauge",
      `x402_uptime_seconds ${Math.floor((Date.now() - startedAt) / 1000)}`,
      "# HELP x402_catalog_entries Resources currently in the discovery catalog.",
      "# TYPE x402_catalog_entries gauge",
      `x402_catalog_entries ${catalog.size}`,
    ];
    return c.text(lines.join("\n") + "\n", 200, { "Content-Type": "text/plain; version=0.0.4" });
  });

  // Stock clients (`withBazaar()`) call /discovery/* on the facilitator's own base URL.
  app.route("/", createBazaarApp({ store: catalog, startedAt }));

  app.notFound(c =>
    c.json(
      createError("invalid_payload", {
        reason: `No such endpoint: ${c.req.method} ${new URL(c.req.url).pathname}. This facilitator serves /verify, /settle, /supported, /discovery/resources, /discovery/search, /health and /metrics.`,
      }),
      404,
    ),
  );

  /**
   * Refresh every mirror, then keep refreshing on a timer. Returns a stop function.
   *
   * Not started by `createApp`: a timer created at construction leaks into every test that builds an
   * app, and a boot-time fetch would make constructing one depend on the network. The service
   * entrypoint starts it; tests and the eval harness never do.
   */
  const startFederation = (): (() => void) => {
    if (config.federationSources.length === 0) return () => {};
    const tick = () => {
      void federated.refresh().then(results => {
        for (const r of results) {
          if (r.error) console.error(`federation: ${r.error.code} — ${r.error.reason}`);
        }
      });
    };
    tick();
    const timer = setInterval(tick, config.federationRefreshSeconds * 1000);
    // Unref so a mirror refresh never keeps the process alive through a shutdown.
    timer.unref();
    return () => clearInterval(timer);
  };

  return {
    app,
    facilitator,
    signerAddresses,
    feeBumpAddress,
    catalog,
    signals,
    domains,
    federated,
    startFederation,
  };
}

/** Parse and shape-check a facilitator request, returning a coded error rather than a bare 400. */
async function parseBody(c: Context<AppEnv>): Promise<
  | { paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements }
  | { error: ReturnType<typeof createError> }
> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return {
      error: createError("invalid_payload", {
        reason: "Request body is not valid JSON.",
      }),
    };
  }

  const parsed = FacilitatorRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const missing = parsed.error.issues.map(i => i.path.join(".") || "(root)");
    return {
      error: createError("invalid_payload", {
        reason: `Request must contain "paymentPayload" and "paymentRequirements" objects. Problems at: ${missing.join(", ")}.`,
        details: { fields: missing },
      }),
    };
  }

  // x402 amounts are integer atomic units (7-decimal stroops). A decimal or non-numeric amount can
  // never settle, and `BigInt("10.5")` throws deep in the scheme, surfacing as a RETRYABLE
  // unexpected error — so an agent loops on a seller misconfiguration that will never succeed. Catch
  // it here as a non-retryable requirements error, for both schemes, with a legible reason.
  const req = parsed.data.paymentRequirements as { amount?: unknown };
  if (req.amount !== undefined && !/^\d+$/.test(String(req.amount))) {
    return {
      error: createError("invalid_payment_requirements", {
        reason: `paymentRequirements.amount must be a non-negative integer string in atomic units (7-decimal stroops); got ${JSON.stringify(req.amount)}. A decimal or non-numeric amount cannot be settled.`,
        details: { amount: String(req.amount) },
      }),
    };
  }

  return {
    paymentPayload: parsed.data.paymentPayload as unknown as PaymentPayload,
    paymentRequirements: parsed.data.paymentRequirements as unknown as PaymentRequirements,
  };
}

function asMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "An unexpected internal error occurred.";
}

/**
 * Classify an exception thrown by `@x402/core`'s registry into a spec-defined code and an
 * honest HTTP status.
 *
 * `x402Facilitator` throws plain `Error`s for "no facilitator registered for …". Reporting those
 * as `unexpected_verify_error` / HTTP 500 would be wrong three times over: it is a client error,
 * not a server fault; the spec already defines `invalid_x402_version` and `invalid_network` for
 * exactly this; and `unexpected_*` is marked retryable, which would tell an agent to keep retrying
 * a request that can never succeed. Misreporting retryability is worse than a vague message —
 * it turns one bad request into a retry loop.
 */
function classifyFacilitatorThrow(
  error: unknown,
  requirements: PaymentRequirements | undefined,
  config: FacilitatorConfig,
  fallback: "unexpected_verify_error" | "unexpected_settle_error",
  supportedSchemesFor: (network: string | undefined) => string[],
): { payload: ReturnType<typeof createError>; status: 400 | 500 } {
  const message = asMessage(error);

  if (/no facilitator registered for x402 version/i.test(message)) {
    return {
      payload: createError("invalid_x402_version", {
        reason: `This facilitator implements x402 version 2 only. ${message}.`,
      }),
      status: 400,
    };
  }

  if (/no facilitator registered for scheme/i.test(message)) {
    const network = requirements?.network;
    const known = config.networks.some(n => n.network === network);
    // Distinguish "we don't do that chain" from "we don't do that scheme on a chain we support".
    if (!known) {
      return {
        payload: createError("invalid_network", {
          reason: `Network ${network ?? "(unspecified)"} is not served by this facilitator. Supported: ${config.networks.map(n => n.network).join(", ")}.`,
          details: { supported: config.networks.map(n => n.network) },
        }),
        status: 400,
      };
    }
    const schemes = supportedSchemesFor(network);
    return {
      payload: createError("unsupported_scheme", {
        reason:
          schemes.length > 0
            ? `Scheme ${requirements?.scheme ?? "(unspecified)"} is not supported on ${network}. This facilitator implements: ${schemes.map(s => `"${s}"`).join(", ")}.`
            : `Scheme ${requirements?.scheme ?? "(unspecified)"} is not supported on ${network}.`,
        details: { network, supportedSchemes: schemes },
      }),
      status: 400,
    };
  }

  return { payload: createError(fallback, { reason: message }), status: 500 };
}

export type { ErrorCode };
