import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { paymentMiddleware } from "@x402/hono";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import { describeEndpoint } from "@rail402/seller-helpers";
import { createRateLimiter } from "@rail402/facilitator/rate-limit";
import { createError, X402Error } from "@rail402/errors";
import { uptoContractFor } from "@rail402/scheme-upto-stellar";
import type { PlaygroundConfig } from "./config.js";
import { FRIENDBOT_URL, HORIZON_URL, NETWORK } from "./config.js";
import { createDispenser, createHorizonGateway, type HorizonGateway } from "./dispenser.js";
import { createMeter, MeterRefusal, TAB_SECONDS } from "./meter.js";
import { createShareStore } from "./share.js";
import { createAgentRunStore } from "./agent/runs.js";
import { buildMcpConfig } from "./agent/mcp-config.js";
import { buildSnippet, checkEndpoint } from "./publish.js";
import { decimalToStroops, stroopsToDisplay } from "../shared/amounts.js";

/**
 * The playground server: everything the designed frontend calls that is not the facilitator
 * itself.
 *
 *   - `/session/*`  — bootstrap support: public config and the USDC dispenser.
 *   - `/demo/convert` — a real paid API (exact scheme) behind the STOCK `@x402/hono` middleware,
 *     with discovery metadata, so the playground's first payment is indistinguishable from paying
 *     any third-party x402 seller.
 *   - `/demo/meter/*` — the `upto` bar-tab demo (see meter.ts).
 *   - `/share`      — session permalinks.
 *
 * Same construction rules as the facilitator's app factory: dependencies injected, no network
 * traffic and no timers at construction, every refusal a registry-coded envelope.
 */

export interface AppDeps {
  readonly config: PlaygroundConfig;
  readonly horizon?: HorizonGateway;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

/** HTTP status for a coded refusal that did not carry its own status. */
function statusFor(code: string): 400 | 402 | 404 | 409 | 429 | 502 | 503 {
  switch (code) {
    case "playground_share_not_found":
    case "playground_meter_tab_not_found":
      return 404;
    case "playground_dispenser_account_not_found":
    case "playground_dispenser_trustline_missing":
    case "playground_dispenser_already_funded":
      return 409;
    case "playground_dispenser_rate_limited":
      return 429;
    case "playground_dispenser_exhausted":
      return 503;
    case "playground_dispenser_failed":
    case "playground_facilitator_unreachable":
      return 502;
    default:
      return 400;
  }
}

export function createApp({ config, horizon, fetchImpl = fetch, now = Date.now }: AppDeps) {
  const startedAt = now();
  const dispenser = createDispenser({
    config,
    horizon: horizon ?? createHorizonGateway(HORIZON_URL),
    now,
  });
  const meter = createMeter({ config, fetchImpl, now });
  const shares = createShareStore({ now });
  const agentRuns = createAgentRunStore(config, now);

  const x402Server = new x402ResourceServer([
    new HTTPFacilitatorClient({ url: config.facilitatorUrl }),
  ]);
  x402Server.register("stellar:*", new ExactStellarScheme());
  x402Server.registerExtension(bazaarResourceServerExtension);

  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: config.corsOrigins.length === 1 && config.corsOrigins[0] === "*"
        ? "*"
        : [...config.corsOrigins],
      // Everything the glass timeline inspects must be readable by browser JavaScript. CORS hides
      // non-simple response headers by default, so each one is named or it is invisible
      // (the incumbent's EXTENSION-RESPONSES bug — emitted, arrived, unreadable).
      exposeHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", "EXTENSION-RESPONSES", "Retry-After"],
    }),
  );

  // ── Session ───────────────────────────────────────────────────────────────

  /** Everything a frontend needs to bootstrap, so nothing is hard-coded client-side. */
  app.get("/session/config", c =>
    c.json({
      network: NETWORK,
      facilitatorUrl: config.facilitatorUrl,
      horizonUrl: HORIZON_URL,
      friendbotUrl: FRIENDBOT_URL,
      usdc: config.usdc,
      uptoContract: uptoContractFor(NETWORK),
      drip: { amountStroops: config.dripStroops.toString() },
      payTo: config.payTo,
      demo: {
        convert: { path: "/demo/convert", scheme: "exact", priceStroops: config.exactPriceStroops.toString() },
        meter: {
          openPath: "/demo/meter/open",
          scheme: "upto",
          unitStroops: config.meterUnitStroops.toString(),
          tabSeconds: TAB_SECONDS,
        },
        agent: {
          runPath: "/agent/run",
          pollPath: "/agent/run/:id",
          mcpConfigPath: "/agent/mcp-config",
          minBudgetStroops: "1000000",
        },
        publish: {
          snippetPath: "/publish/snippet",
          checkPath: "/publish/check",
          resourcesPath: "/bazaar/resources",
        },
      },
    }),
  );

  const fundLimiter = createRateLimiter({
    windowSeconds: config.rate.windowSeconds,
    maxRequests: config.rate.maxPerIp,
    trustProxy: true,
    errorCode: "playground_dispenser_rate_limited",
  });
  app.post("/session/fund", fundLimiter, async c => {
    const body = (await c.req.json().catch(() => null)) as { account?: unknown } | null;
    if (!body || typeof body.account !== "string") {
      return c.json(
        createError("playground_invalid_request", {
          reason: 'POST /session/fund takes a JSON body { "account": "G…" }.',
        }),
        400,
      );
    }
    const drip = await dispenser.fund(body.account);
    return c.json({
      hash: drip.hash,
      amountStroops: drip.amountStroops.toString(),
      asset: { code: config.usdc.code, issuer: config.usdc.issuer },
    });
  });

  // ── Exact demo: a real paid API behind the stock middleware ───────────────

  // Parameter validation runs BEFORE the payment middleware: a malformed request must be refused
  // free of charge, not settled and then rejected.
  app.use("/demo/convert", async (c, next) => {
    const amount = c.req.query("amount");
    const from = c.req.query("from") ?? "USDC";
    if (!amount || !["USDC", "stroops"].includes(from)) {
      return c.json(
        createError("playground_invalid_request", {
          reason:
            'GET /demo/convert takes ?amount=<value> and optional &from=USDC|stroops. Nothing was charged.',
        }),
        400,
      );
    }
    try {
      if (from === "USDC") decimalToStroops(amount);
      else BigInt(amount);
    } catch {
      return c.json(
        createError("playground_invalid_request", {
          reason: `"${amount}" is not a valid ${from} amount. Nothing was charged.`,
        }),
        400,
      );
    }
    return next();
  });

  // Scoped to the one paid route, and CONSTRUCTED on the first request to it: `paymentMiddleware`
  // kicks off a floating facilitator `initialize()` the moment it is built, which would make the
  // app factory touch the network — and leave an unhandled rejection if the facilitator is briefly
  // unreachable. Deferring construction keeps both inside a request, where the middleware also
  // awaits (and retries) that same initialization itself.
  const buildConvertMiddleware = () =>
    paymentMiddleware(
      {
        "GET /demo/convert": {
          accepts: {
            scheme: "exact",
            network: NETWORK,
            price: { amount: config.exactPriceStroops.toString(), asset: config.usdc.sac },
            payTo: config.payTo,
            maxTimeoutSeconds: 60,
          },
          description:
            "Converts between human USDC amounts and the 7-decimal stroop integers every Stellar x402 payment settles in.",
          mimeType: "application/json",
          extensions: describeEndpoint({
            params: {
              amount: {
                description:
                  "The amount to convert: a decimal USDC value like 0.5 (up to 7 decimal places), or an integer stroop count when from=stroops.",
                example: "0.5",
              },
              from: {
                description:
                  "Unit of the input amount: USDC converts to stroops, stroops converts to USDC. Defaults to USDC.",
                required: false,
                enum: ["USDC", "stroops"],
                example: "USDC",
              },
            },
            outputExample: { input: "0.5", from: "USDC", stroops: "5000000", usdc: "0.5" },
          }),
        },
      },
      x402Server,
    );
  let convertMiddleware: ReturnType<typeof buildConvertMiddleware> | undefined;
  app.use("/demo/convert", async (c, next) => {
    convertMiddleware ??= buildConvertMiddleware();
    return convertMiddleware(c, next);
  });

  app.get("/demo/convert", c => {
    const amount = c.req.query("amount") ?? "";
    const from = c.req.query("from") ?? "USDC";
    const stroops = from === "USDC" ? decimalToStroops(amount) : BigInt(amount);
    return c.json({
      input: amount,
      from,
      stroops: stroops.toString(),
      usdc: stroopsToDisplay(stroops),
    });
  });

  // ── Upto meter: open / call / close ───────────────────────────────────────

  function publicUrl(c: Context, path: string): string {
    if (config.publicUrl) return `${config.publicUrl}${path}`;
    const url = new URL(c.req.url);
    return `${url.origin}${path}`;
  }

  app.post("/demo/meter/open", async c => {
    const header = c.req.header("PAYMENT-SIGNATURE");
    if (!header) {
      const challenge = meter.paymentRequired(publicUrl(c, "/demo/meter/open"));
      c.header("PAYMENT-REQUIRED", encodePaymentRequiredHeader(challenge));
      return c.json(challenge, 402);
    }
    let payload: PaymentPayload;
    try {
      payload = decodePaymentSignatureHeader(header) as PaymentPayload;
    } catch {
      return c.json(
        createError("playground_invalid_request", {
          reason: "The PAYMENT-SIGNATURE header is not valid base64-encoded JSON.",
        }),
        400,
      );
    }
    return c.json(await meter.open(payload));
  });

  const tabBody = async (c: Context): Promise<string> => {
    const body = (await c.req.json().catch(() => null)) as { tabId?: unknown } | null;
    if (!body || typeof body.tabId !== "string") {
      throw new MeterRefusal(
        400,
        createError("playground_invalid_request", {
          reason: 'This endpoint takes a JSON body { "tabId": "<id from /demo/meter/open>" }.',
        }),
      );
    }
    return body.tabId;
  };

  app.post("/demo/meter/call", async c => c.json(meter.call(await tabBody(c))));
  app.post("/demo/meter/close", async c => c.json(await meter.close(await tabBody(c))));

  // ── Facilitator proxies ───────────────────────────────────────────────────
  // The break-it scene and the Bazaar scene need the browser to reach the facilitator, which does
  // not serve CORS by default. Rather than depend on that deploy-time configuration, the playground
  // forwards these calls verbatim from its own origin: the refusal (or the search result) is
  // genuinely the facilitator's, reached same-origin. The proxy adds nothing and hides nothing.
  const forward = async (c: Context, path: "/verify" | "/settle"): Promise<Response> => {
    const body = await c.req.text();
    let upstream: Response;
    try {
      upstream = await fetchImpl(`${config.facilitatorUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
    } catch (err) {
      return c.json(
        createError("playground_facilitator_unreachable", {
          reason: `The facilitator at ${config.facilitatorUrl} could not be reached: ${err instanceof Error ? err.message : String(err)}.`,
        }),
        502,
      );
    }
    // Pass the facilitator's own status and JSON through untouched.
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { "content-type": "application/json" },
    });
  };
  app.post("/attack/verify", c => forward(c, "/verify"));
  app.post("/attack/settle", c => forward(c, "/settle"));

  app.get("/bazaar/search", async c => {
    const qs = new URL(c.req.url).search;
    let upstream: Response;
    try {
      upstream = await fetchImpl(`${config.facilitatorUrl}/discovery/search${qs}`);
    } catch (err) {
      return c.json(
        createError("playground_facilitator_unreachable", {
          reason: `The Bazaar at ${config.facilitatorUrl} could not be reached: ${err instanceof Error ? err.message : String(err)}.`,
        }),
        502,
      );
    }
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { "content-type": "application/json" },
    });
  });

  app.get("/bazaar/resources", async c => {
    const qs = new URL(c.req.url).search;
    let upstream: Response;
    try {
      upstream = await fetchImpl(`${config.facilitatorUrl}/discovery/resources${qs}`);
    } catch (err) {
      return c.json(
        createError("playground_facilitator_unreachable", {
          reason: `The Bazaar at ${config.facilitatorUrl} could not be reached: ${err instanceof Error ? err.message : String(err)}.`,
        }),
        502,
      );
    }
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { "content-type": "application/json" },
    });
  });

  // ── Agents scene ──────────────────────────────────────────────────────────
  // A run creates a real smart account and makes several real settlements (~60-90s), so it is a
  // background job the browser starts once and then follows by polling for new events.
  app.post("/agent/run", async c => {
    const body = (await c.req.json().catch(() => null)) as { budget?: unknown } | null;
    if (!body || typeof body.budget !== "string") {
      return c.json(
        createError("playground_invalid_request", {
          reason: 'POST /agent/run takes a JSON body { "budget": "<USDC amount>" }, e.g. "0.5".',
        }),
        400,
      );
    }
    let budgetStroops: bigint;
    try {
      budgetStroops = decimalToStroops(body.budget);
    } catch {
      return c.json(
        createError("playground_invalid_request", {
          reason: `"${body.budget}" is not a valid USDC budget (up to 7 decimal places).`,
        }),
        400,
      );
    }
    // A budget must be large enough for the beats to divide sensibly (the smallest slice is /10).
    if (budgetStroops < 1_000_000n) {
      return c.json(
        createError("playground_invalid_request", {
          reason: "The agent budget must be at least 0.1 USDC so the demo's payments divide sensibly.",
        }),
        400,
      );
    }
    const { id } = agentRuns.start(budgetStroops);
    return c.json({ id });
  });

  app.get("/agent/run/:id", c => {
    const since = Number(c.req.query("since") ?? "-1");
    const snapshot = agentRuns.poll(c.req.param("id"), Number.isFinite(since) ? since : -1);
    if (!snapshot) {
      return c.json(
        createError("playground_share_not_found", {
          reason: "No agent run with this id. It may have been evicted; start a new one.",
        }),
        404,
      );
    }
    return c.json(snapshot);
  });

  app.post("/agent/mcp-config", async c => {
    const body = (await c.req.json().catch(() => null)) as
      | { sessionSecret?: unknown; budget?: unknown }
      | null;
    if (!body || typeof body.sessionSecret !== "string" || !body.sessionSecret.startsWith("S")) {
      return c.json(
        createError("playground_invalid_request", {
          reason: 'POST /agent/mcp-config takes { "sessionSecret": "S…" } (a testnet secret key), optionally { "budget": "<USDC>" }.',
        }),
        400,
      );
    }
    let budgetStroops: bigint | undefined;
    if (typeof body.budget === "string") {
      try {
        budgetStroops = decimalToStroops(body.budget);
      } catch {
        budgetStroops = undefined;
      }
    }
    return c.json(buildMcpConfig(config, body.sessionSecret, budgetStroops));
  });

  // ── Bazaar publish wizard ─────────────────────────────────────────────────
  app.get("/publish/snippet", c => {
    const framework = c.req.query("framework") === "express" ? "express" : "hono";
    const snippet = buildSnippet(config, {
      framework,
      path: c.req.query("path") ?? "/premium",
      priceDecimal: c.req.query("price") ?? "0.01",
      description: c.req.query("description") ?? "A paid API endpoint.",
    });
    return c.json(snippet);
  });

  app.post("/publish/check", async c => {
    const body = (await c.req.json().catch(() => null)) as { url?: unknown } | null;
    if (!body || typeof body.url !== "string") {
      return c.json(
        createError("playground_invalid_request", {
          reason: 'POST /publish/check takes a JSON body { "url": "https://…" }.',
        }),
        400,
      );
    }
    return c.json(await checkEndpoint(body.url, fetchImpl));
  });

  // ── Share ─────────────────────────────────────────────────────────────────

  app.post("/share", async c => {
    const body = (await c.req.json().catch(() => null)) as { events?: unknown } | null;
    return c.json(shares.put(body?.events));
  });
  app.get("/share/:id", c => c.json(shares.get(c.req.param("id"))));

  // ── Ops ───────────────────────────────────────────────────────────────────

  app.get("/health", c =>
    c.json({
      status: "ok",
      service: "rail402-playground",
      network: NETWORK,
      facilitatorUrl: config.facilitatorUrl,
      uptimeSeconds: Math.floor((now() - startedAt) / 1000),
    }),
  );

  app.notFound(c =>
    c.json(
      createError("playground_invalid_request", {
        reason: `No such endpoint: ${c.req.method} ${new URL(c.req.url).pathname}. See GET /session/config for the API surface.`,
      }),
      404,
    ),
  );

  app.onError((err, c) => {
    if (err instanceof MeterRefusal) {
      return c.json(err.payload, err.status);
    }
    if (err instanceof X402Error) {
      const payload = err.payload;
      const status = statusFor(payload.code);
      const retryAfter = (payload.details as { retryAfterSeconds?: number } | undefined)
        ?.retryAfterSeconds;
      if (retryAfter !== undefined) c.header("Retry-After", String(retryAfter));
      return c.json(payload, status);
    }
    console.error("[playground] unexpected error", err);
    return c.json(
      createError("playground_invalid_request", {
        reason: `Unexpected server error: ${err instanceof Error ? err.message : String(err)}.`,
      }),
      500,
    );
  });

  return { app };
}
