import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { paymentMiddleware } from "@x402/hono";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import { describeEndpoint } from "@rail402.dev/seller-helpers";
import { createRateLimiter } from "@rail402.dev/facilitator/rate-limit";
import { createError, X402Error } from "@rail402.dev/errors";
import { uptoContractFor } from "@rail402.dev/scheme-upto-stellar";
import type { PlaygroundConfig } from "./config.js";
import { FRIENDBOT_URL, HORIZON_URL, NETWORK } from "./config.js";
import { createDispenser, createHorizonGateway, type HorizonGateway } from "./dispenser.js";
import { createMeter, MeterRefusal, TAB_SECONDS } from "./meter.js";
import { createShareStore } from "./share.js";
import { createAgentRunStore } from "./agent/runs.js";
import { buildMcpConfig } from "./agent/mcp-config.js";
import { buildSnippet, checkEndpoint } from "./publish.js";
import {
  DEFAULT_STATUS_DIR,
  buildConformanceReport,
  errorRegistryStats,
  listErrorRegistry,
  loadStatusEvidence,
  type StatusEvidence,
} from "./conformance.js";
import { analyzeChallenge, reshapeExplorerTx, type ExplorerPaymentDetail } from "./debug.js";
import { DEFAULT_SKILL_DIR, loadSkillFiles, type SkillFile } from "./skill.js";
import { DEFAULT_BUNDLE_PATH, loadBrowserBundle, type BrowserBundle } from "./browser-bundle.js";
import { checkInterop } from "./interop.js";
import { TrustlineChecker } from "@rail402.dev/bazaar";
import { StrKey } from "@stellar/stellar-sdk";
import { txUrl } from "../browser/format.js";
import {
  createLabStore,
  LabError,
  DEFAULT_PERIOD_LEDGERS,
  MIN_PERIOD_LEDGERS,
  MAX_PERIOD_LEDGERS,
  MIN_LIMIT_STROOPS,
  MAX_LIMIT_STROOPS,
  MAX_PAY_STROOPS,
} from "./lab/lab.js";
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
  /** Where docs/status/*.json live. Overridden in tests; the default resolves to the repo copy. */
  readonly statusDir?: string;
  /** Where the x402-stellar Agent Skill files live. Overridden in tests. */
  readonly skillDir?: string;
  /** Path to the pre-built browser bundle served at /lib/browser.js. Overridden in tests. */
  readonly browserBundlePath?: string;
}

/**
 * Upper bound on the Agents-scene budget. The scene funds the smart account with 3x the budget
 * (so the deliberately-over-budget payment is refused by the on-ledger policy rather than by an
 * empty balance), and the surplus strands in the abandoned contract — so without a cap, a single
 * `{ "budget": "50" }` would try to move 150 USDC out of the dispenser. Matches the Policy Lab's
 * MAX_LIMIT_STROOPS. The frontend should still default to the minimum (0.1) to keep the demo cheap.
 */
const MAX_AGENT_BUDGET_STROOPS = 3_000_000n; // 0.3 USDC

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

export function createApp({
  config,
  horizon,
  fetchImpl = fetch,
  now = Date.now,
  statusDir = DEFAULT_STATUS_DIR,
  skillDir = DEFAULT_SKILL_DIR,
  browserBundlePath = DEFAULT_BUNDLE_PATH,
}: AppDeps) {
  const startedAt = now();
  const dispenser = createDispenser({
    config,
    horizon: horizon ?? createHorizonGateway(HORIZON_URL),
    now,
  });
  const meter = createMeter({ config, fetchImpl, now });
  const shares = createShareStore({ now });
  const agentRuns = createAgentRunStore(config, now);
  const lab = createLabStore(config, { fetchImpl, now });

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
      explorer: { url: config.explorerUrl, apiUrl: config.explorerApiUrl },
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
          maxBudgetStroops: MAX_AGENT_BUDGET_STROOPS.toString(),
        },
        publish: {
          snippetPath: "/publish/snippet",
          checkPath: "/publish/check",
          resourcesPath: "/bazaar/resources",
        },
        lab: {
          sessionPath: "/lab/session",
          statePath: "/lab/session/:id",
          payPath: "/lab/session/:id/pay",
          limitPath: "/lab/session/:id/limit",
          minLimitStroops: MIN_LIMIT_STROOPS.toString(),
          maxLimitStroops: MAX_LIMIT_STROOPS.toString(),
          defaultPeriodLedgers: DEFAULT_PERIOD_LEDGERS,
        },
        conformance: {
          panelPath: "/conformance",
          errorsPath: "/conformance/errors",
        },
        debug: {
          txPath: "/debug/tx",
          challengePath: "/debug/challenge",
        },
        skill: { path: "/skill" },
        trustline: { path: "/session/trustline" },
        interop: { path: "/bazaar/interop-check" },
        browserLib: { path: "/lib/browser.js" },
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

  // Trustline pre-flight: can this account RECEIVE the playground's USDC? Turns the
  // hidden onboarding step into a one-line teaching beat. Advisory — the reused checker caches,
  // shares in-flight requests, and answers `unknown` (with a reason) when Horizon cannot say.
  const trustlines = new TrustlineChecker({ fetchImpl, now });
  app.get("/session/trustline", async c => {
    const account = c.req.query("account");
    if (!account) {
      return c.json(
        createError("playground_invalid_request", {
          reason: "GET /session/trustline takes ?account=<G… address> — the account whose ability to receive USDC you want checked.",
        }),
        400,
      );
    }
    if (StrKey.isValidContract(account)) {
      return c.json(
        createError("playground_invalid_request", {
          reason:
            "This is a contract address (C…). Contract accounts hold token balances in contract storage, where trustlines do not exist — the question does not apply, and a payment to it needs no trustline.",
        }),
        400,
      );
    }
    if (!StrKey.isValidEd25519PublicKey(account)) {
      return c.json(
        createError("playground_invalid_request", {
          reason: `"${account}" is not a valid Stellar account address — the strkey checksum fails. Addresses cannot be typed by hand; copy one exactly.`,
        }),
        400,
      );
    }
    const verdict = await trustlines.check(NETWORK, config.usdc.sac, account);
    return c.json({
      account,
      asset: config.usdc,
      ...(verdict ?? {
        state: "unknown",
        checkedAt: new Date(now()).toISOString(),
        reason: "The trustline question could not be resolved for this asset.",
      }),
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

  // Interop indicator ("not a walled garden"): does this listing round-trip through the
  // wire shapes stock SDK clients read? An unlisted or malformed listing is an analysis result
  // (ok:false with the failing check), not an HTTP error.
  app.get("/bazaar/interop-check", async c =>
    c.json(await checkInterop(c.req.query("url"), { facilitatorUrl: config.facilitatorUrl, fetchImpl })),
  );

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
    // ...and small enough that one run cannot drain the dispenser. The scene funds the smart
    // account with 3x the budget (so the over-budget attempt is refused by the POLICY, not by an
    // empty balance), and the surplus strands in the abandoned contract — so an uncapped budget is
    // an uncapped drain. Same ceiling as the Policy Lab.
    if (budgetStroops > MAX_AGENT_BUDGET_STROOPS) {
      return c.json(
        createError("playground_invalid_request", {
          reason: `The agent budget is capped at ${stroopsToDisplay(MAX_AGENT_BUDGET_STROOPS)} USDC so a single run cannot drain the dispenser (the scene funds the account with 3x the budget).`,
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

  // ── C-Account Policy Lab ──────────────────────────────────────────────────
  // Independent of the browser-session scenes: deploy a real OZ smart account with a policy you
  // configure, then run payments against it and watch the chain enforce the budget. Deployment is a
  // background job (several Soroban txs); payments and limit changes are awaited.
  // A payment amount may be any positive USDC value — including over budget, which is the point of
  // the "get refused" scenario — so it is not clamped to the limit range the way a budget is.
  const amountOr400 = (raw: unknown): { value: bigint } | { error: string } => {
    if (typeof raw !== "string") return { error: "An amount (USDC, as a string) is required." };
    let stroops: bigint;
    try {
      stroops = decimalToStroops(raw);
    } catch {
      return { error: `"${raw}" is not a valid USDC amount (up to 7 decimal places).` };
    }
    if (stroops <= 0n) return { error: "The amount must be greater than zero." };
    if (stroops > MAX_PAY_STROOPS) {
      return { error: `A test payment is capped at ${stroopsToDisplay(MAX_PAY_STROOPS)} USDC (over-budget attempts must be funded so the policy, not balance, refuses them).` };
    }
    return { value: stroops };
  };

  const parseLimit = (raw: unknown): bigint | { error: string } => {
    if (typeof raw !== "string") return { error: "A budget (USDC amount, as a string) is required." };
    let stroops: bigint;
    try {
      stroops = decimalToStroops(raw);
    } catch {
      return { error: `"${raw}" is not a valid USDC amount (up to 7 decimal places).` };
    }
    if (stroops < MIN_LIMIT_STROOPS || stroops > MAX_LIMIT_STROOPS) {
      return {
        error: `The budget must be between ${stroopsToDisplay(MIN_LIMIT_STROOPS)} and ${stroopsToDisplay(MAX_LIMIT_STROOPS)} USDC (the lab caps it so a session cannot drain the dispenser).`,
      };
    }
    return stroops;
  };

  app.post("/lab/session", async c => {
    const body = (await c.req.json().catch(() => null)) as { limit?: unknown; periodLedgers?: unknown } | null;
    const limit = parseLimit(body?.limit);
    if (typeof limit === "object") {
      return c.json(createError("playground_invalid_request", { reason: limit.error }), 400);
    }
    let periodLedgers = DEFAULT_PERIOD_LEDGERS;
    if (body?.periodLedgers !== undefined) {
      const p = Number(body.periodLedgers);
      if (!Number.isInteger(p) || p < MIN_PERIOD_LEDGERS || p > MAX_PERIOD_LEDGERS) {
        return c.json(
          createError("playground_invalid_request", {
            reason: `periodLedgers must be an integer between ${MIN_PERIOD_LEDGERS} and ${MAX_PERIOD_LEDGERS}.`,
          }),
          400,
        );
      }
      periodLedgers = p;
    }
    return c.json(lab.deploy({ limitStroops: limit, periodLedgers }));
  });

  app.get("/lab/session/:id", async c => {
    const state = await lab.get(c.req.param("id"));
    if (!state) {
      return c.json(
        createError("playground_share_not_found", { reason: "No lab session with this id. Start a new one." }),
        404,
      );
    }
    return c.json(state);
  });

  app.post("/lab/session/:id/pay", async c => {
    const body = (await c.req.json().catch(() => null)) as
      | { scheme?: unknown; amount?: unknown; ceiling?: unknown; actual?: unknown }
      | null;
    const scheme = body?.scheme;
    try {
      if (scheme === "exact") {
        const amount = amountOr400(body?.amount);
        if ("error" in amount) return c.json(createError("playground_invalid_request", { reason: amount.error }), 400);
        return c.json(await lab.pay(c.req.param("id"), { scheme: "exact", amountStroops: amount.value }));
      }
      if (scheme === "upto") {
        const ceiling = amountOr400(body?.ceiling);
        const actual = amountOr400(body?.actual);
        if ("error" in ceiling) return c.json(createError("playground_invalid_request", { reason: ceiling.error }), 400);
        if ("error" in actual) return c.json(createError("playground_invalid_request", { reason: actual.error }), 400);
        if (actual.value > ceiling.value) {
          return c.json(createError("playground_invalid_request", { reason: "The actual amount cannot exceed the ceiling." }), 400);
        }
        return c.json(await lab.pay(c.req.param("id"), { scheme: "upto", ceilingStroops: ceiling.value, actualStroops: actual.value }));
      }
      return c.json(createError("playground_invalid_request", { reason: 'scheme must be "exact" (with amount) or "upto" (with ceiling + actual).' }), 400);
    } catch (err) {
      if (err instanceof LabError) return c.json(createError(err.code as never, { reason: err.message }), err.status);
      throw err;
    }
  });

  app.post("/lab/session/:id/limit", async c => {
    const body = (await c.req.json().catch(() => null)) as { scheme?: unknown; limit?: unknown } | null;
    if (body?.scheme !== "exact" && body?.scheme !== "upto") {
      return c.json(createError("playground_invalid_request", { reason: 'scheme must be "exact" or "upto".' }), 400);
    }
    const limit = parseLimit(body.limit);
    if (typeof limit === "object") return c.json(createError("playground_invalid_request", { reason: limit.error }), 400);
    try {
      return c.json(await lab.setLimit(c.req.param("id"), { scheme: body.scheme, limitStroops: limit }));
    } catch (err) {
      if (err instanceof LabError) return c.json(createError(err.code as never, { reason: err.message }), err.status);
      throw err;
    }
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

  // ── Conformance panel ─────────────────────────────────────────────────────
  // The acceptance criteria as data — the reviewer's console. `supported` is fetched
  // live per call and the supported-extra criterion is judged from that same body; the measured
  // criteria come from the docs/status artifacts shipped with the image (lazy-loaded once). A
  // criterion without evidence renders `unknown`; the e2e-suite row renders whatever the recorded
  // run actually says, which today is `failing` (2 of 4 scenarios, diagnosed upstream).
  let statusEvidence: StatusEvidence | undefined;
  app.get("/conformance", async c => {
    let upstream: Response;
    try {
      upstream = await fetchImpl(`${config.facilitatorUrl}/supported`);
    } catch (err) {
      return c.json(
        createError("playground_facilitator_unreachable", {
          reason: `The facilitator at ${config.facilitatorUrl} could not be reached for /supported: ${err instanceof Error ? err.message : String(err)}.`,
        }),
        502,
      );
    }
    if (!upstream.ok) {
      return c.json(
        createError("playground_facilitator_unreachable", {
          reason: `The facilitator at ${config.facilitatorUrl} answered /supported with HTTP ${upstream.status}, so the live half of the conformance panel cannot be built.`,
        }),
        502,
      );
    }
    let supported: unknown;
    try {
      supported = await upstream.json();
    } catch {
      return c.json(
        createError("playground_facilitator_unreachable", {
          reason: `The facilitator at ${config.facilitatorUrl} answered /supported with a body that is not JSON.`,
        }),
        502,
      );
    }
    statusEvidence ??= loadStatusEvidence(statusDir);
    return c.json(
      buildConformanceReport({
        network: NETWORK,
        facilitatorUrl: config.facilitatorUrl,
        supported,
        evidence: statusEvidence,
        checkedAt: new Date(now()).toISOString(),
      }),
    );
  });

  app.get("/conformance/errors", c =>
    c.json({ ...errorRegistryStats(), errors: listErrorRegistry() }),
  );

  // ── Debug my payment ──────────────────────────────────────────────────────
  // Paste a settled hash → the explorer's classification re-shaped into the glass timeline; paste
  // a 402 → an explanation of what it costs and every defect that would stop a stock client.
  // "Replay" of a settled payment is impossible by design (single-use nonce) — the frontend's
  // re-execute button makes a FRESH payment to the decoded sellerUrl instead.
  app.post("/debug/tx", async c => {
    const body = (await c.req.json().catch(() => null)) as
      | { hash?: unknown; network?: unknown }
      | null;
    const hash = typeof body?.hash === "string" ? body.hash.trim().toLowerCase() : undefined;
    if (!hash || !/^[0-9a-f]{64}$/.test(hash)) {
      return c.json(
        createError("playground_invalid_request", {
          reason:
            'POST /debug/tx takes a JSON body { "hash": "<64-hex transaction hash>" }, optionally { "network": "stellar:testnet" }.',
        }),
        400,
      );
    }
    const network = typeof body?.network === "string" ? body.network : NETWORK;
    let upstream: Response;
    try {
      upstream = await fetchImpl(
        `${config.explorerApiUrl}/tx/${hash}?network=${encodeURIComponent(network)}`,
      );
    } catch (err) {
      return c.json(
        createError("playground_explorer_unreachable", {
          // The fallback link must not depend on the service that just failed: point at the raw
          // ledger view, which is independent of the Rail402 explorer being up.
          reason: `The explorer at ${config.explorerApiUrl} could not be reached: ${err instanceof Error ? err.message : String(err)}. Raw ledger view: ${txUrl(hash)}`,
        }),
        502,
      );
    }
    const text = await upstream.text();
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    if (upstream.status === 404 && payload && typeof payload === "object" && "code" in payload) {
      // The explorer's own coded refusal (explorer_tx_not_found, retryable — ingestion tails the
      // ledger with a few seconds of lag). Relay it verbatim; it is already the honest answer.
      return c.json(payload as Record<string, unknown>, 404);
    }
    if (!upstream.ok || !payload || typeof payload !== "object") {
      return c.json(
        createError("playground_explorer_unreachable", {
          reason: `The explorer at ${config.explorerApiUrl} answered HTTP ${upstream.status} with ${payload ? "an unexpected shape" : "a non-JSON body"}, so the transaction could not be decoded.`,
        }),
        502,
      );
    }
    return c.json(reshapeExplorerTx(payload as ExplorerPaymentDetail, { explorerUrl: config.explorerUrl }));
  });

  app.post("/debug/challenge", async c => {
    const body = (await c.req.json().catch(() => null)) as { challenge?: unknown } | null;
    if (!body || body.challenge === undefined || body.challenge === null) {
      return c.json(
        createError("playground_invalid_request", {
          reason:
            'POST /debug/challenge takes { "challenge": <the 402 response body, or the base64 PAYMENT-REQUIRED header value> }.',
        }),
        400,
      );
    }
    return c.json(analyzeChallenge(body.challenge, { usdcSac: config.usdc.sac }));
  });

  // ── The x402-stellar Agent Skill ──────────────────────────────────────────
  // The playground URL as an install point: GET /skill is SKILL.md; the files it references are
  // under /skill/<relative path>. Served from a boot-time snapshot, keyed lookups only.
  let skillFiles: ReadonlyMap<string, SkillFile> | undefined;
  const serveSkillFile = (c: Context, relative: string): Response => {
    skillFiles ??= loadSkillFiles(skillDir);
    const file = skillFiles.get(relative);
    if (!file) {
      return c.json(
        createError("playground_invalid_request", {
          reason: `No such skill file: ${relative}. GET /skill lists what exists.`,
        }),
        404,
      );
    }
    return c.body(file.content, 200, { "content-type": file.contentType });
  };
  app.get("/skill", c => serveSkillFile(c, "SKILL.md"));
  app.get("/skill/references/:file", c => serveSkillFile(c, `references/${c.req.param("file")}`));
  app.get("/skill/scripts/:file", c => serveSkillFile(c, `scripts/${c.req.param("file")}`));

  // ── The browser payment engine, as a self-contained ESM module ─────────────
  // A frontend imports `@rail402.dev/playground/browser` from this URL — no build step, no npm. The
  // bundle inlines signing, session, meter, attacks, bazaar, format, @stellar/stellar-sdk, the
  // stock x402 SDK, and a Buffer polyfill. Cached hard: the content is immutable per deploy.
  let browserBundle: BrowserBundle | null | undefined;
  app.get("/lib/browser.js", c => {
    if (browserBundle === undefined) browserBundle = loadBrowserBundle(browserBundlePath);
    if (!browserBundle) {
      return c.json(
        createError("playground_invalid_request", {
          reason:
            "The browser bundle is not present in this deployment. Run bundle/build-browser-bundle.mjs before building the image.",
        }),
        503,
      );
    }
    return c.body(browserBundle.content, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "public, max-age=3600",
    });
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
