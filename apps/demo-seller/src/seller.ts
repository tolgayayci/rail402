/**
 * A public x402 seller on Stellar (testnet by default, or pubnet), built from the stock x402 packages: express
 * `paymentMiddleware`, the Stellar `exact` server scheme, the bazaar server extension and, for the
 * MCP tools, `@x402/mcp`. Every paid route and tool is declared with the Rail402 seller helpers, so
 * its Bazaar discovery metadata is complete and valid: a settled payment through Rail402 catalogs it,
 * and its unpaid 402 response is what Rail402's origin check confirms the listing against.
 * `POST /translate` also declares the payment-identifier extension, which discovery lists and
 * filters on. `GET /history` and the MCP tool `hourly_forecast` are metered with the `upto` scheme
 * (metered.ts): the buyer authorizes a cap and the seller settles what the call used. Each settled
 * payment is served once (`withSettleDedupe`), on every route and tool, and the payments the seller
 * asks the facilitator about are limited per client and in total (limits.ts).
 */
import express, { type Express } from "express";
import { HTTPFacilitatorClient, x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import { paymentMiddleware } from "@x402/express";
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import {
  PAYMENT_IDENTIFIER,
  declarePaymentIdentifierExtension,
  paymentIdentifierResourceServerExtension,
} from "@x402/extensions/payment-identifier";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import {
  UptoStellarServerScheme,
  exact,
  httpRoute,
  param,
  setUptoCharge,
  withSettleDedupe,
  type PaymentOption,
} from "@rail402.dev/sdk/seller";
import { Networks } from "@stellar/stellar-sdk";
import { DEFAULT_PAID_LIMITS, PaidRequestLimits, type PaidLimits } from "./limits.ts";
import { mcpHandler } from "./mcp.ts";
import {
  METERED_PRICES,
  baseUnits,
  declareHistoryRoute,
  historyDays,
  historyFor,
  meteredOption,
  uptoReadiness,
  type StellarNetwork,
} from "./metered.ts";

/** The network the seller serves when none is configured. */
export const NETWORK = "stellar:testnet" as const;

/** The hosted Rail402 testnet facilitator. */
export const DEFAULT_FACILITATOR_URL = "https://testnet.rail402.dev";

export interface SellerOptions {
  /** The Stellar account (G…, C… or M…) that receives every payment. */
  readonly payTo: string;
  /** `stellar:testnet` (default) or `stellar:pubnet`: the network every payment option names. */
  readonly network?: StellarNetwork;
  /** The facilitator that verifies and settles payments; Rail402's hosted testnet by default. */
  readonly facilitator?: FacilitatorClient;
  /** The facilitator's URL, shown on the free index route. */
  readonly facilitatorUrl?: string;
  /**
   * Reverse proxies in front of the seller (Express `trust proxy`). Behind a TLS proxy, this makes the
   * resource URLs in 402 responses use the public `https` scheme and host.
   */
  readonly trustProxy?: number;
  /**
   * The seller's public origin ("https://demo.rail402.dev"). The MCP tools are declared at
   * `<publicUrl>/mcp`; without it, the endpoint is taken from each request's scheme and host.
   */
  readonly publicUrl?: string;
  /**
   * The token prices are paid in: a SEP-41 contract and its decimals. Circle's USDC on the seller's
   * network by default; a local network passes the USDC it issued.
   */
  readonly asset?: { readonly contract: string; readonly decimals: number };
  /**
   * Serve the metered `upto` route and tool (true by default). They need a facilitator that serves
   * `upto` on the seller's network.
   */
  readonly metered?: boolean;
  /**
   * Payments the seller asks the facilitator about per minute, per client and for all clients
   * (`DEFAULT_PAID_LIMITS`). Each costs a verification and, when valid, a settlement, so keep the
   * total well under the facilitator's limit for one address.
   */
  readonly paidLimits?: PaidLimits;
}

/** Each HTTP route's price in whole units of the payment asset (USDC); the MCP tools are in mcp.ts. */
export const PRICES = {
  weather: "0.001",
  users: "0.001",
  translate: "0.002",
} as const;

/** The `exact` payment option for a price in whole units of `asset` (Circle's USDC by default). */
export function exactOption(
  payTo: string,
  amount: string,
  asset?: SellerOptions["asset"],
  network: StellarNetwork = NETWORK,
): PaymentOption {
  return exact({
    network,
    payTo,
    price: asset === undefined ? `$${amount}` : { amount, asset: asset.contract, decimals: asset.decimals },
  });
}

export { TOOL_PRICES, declareTools, type McpTools } from "./mcp.ts";
export { sellerConfig, type DemoSellerConfig } from "./config.ts";
export { DEFAULT_PAID_LIMITS, MAX_CLIENTS, PaidRequestLimits, type PaidLimits } from "./limits.ts";
export {
  METERED_PRICES,
  baseUnits,
  declareHistoryRoute,
  declareHourlyForecast,
  meteredOption,
} from "./metered.ts";

/**
 * The seller's app: three paid HTTP routes and a metered one, the MCP tools at `POST /mcp`, and free
 * informational routes.
 */
export function createSeller(options: SellerOptions): Express {
  const network = options.network ?? NETWORK;
  // An idempotent facilitator such as Rail402 answers every /settle of one payment with its success,
  // and copies of a payment sent together all pass /verify before the first one settles. Every
  // resource server settles through this client, so a payment is served once whatever its flow.
  const facilitator = withSettleDedupe(
    options.facilitator ?? new HTTPFacilitatorClient({ url: DEFAULT_FACILITATOR_URL }),
  );
  // The facilitator limits this seller by its address: payments that only have the right shape, from
  // anyone, must not use up what paying buyers need. Counted on every resource server.
  const limits = new PaidRequestLimits(options.paidLimits ?? DEFAULT_PAID_LIMITS);
  const resourceServer = new x402ResourceServer(facilitator)
    .register(network, new ExactStellarScheme())
    .registerExtension(bazaarResourceServerExtension)
    .registerExtension(paymentIdentifierResourceServerExtension)
    .onBeforeVerify(limits.beforeVerify);
  const pay = (amount: string): PaymentOption => exactOption(options.payTo, amount, options.asset, network);

  const weather = httpRoute({
    method: "GET",
    path: "/weather",
    description: "Current weather for a city",
    payment: pay(PRICES.weather),
    query: {
      city: param.string({ description: "City name", required: true, example: "Istanbul", maxLength: 80 }),
    },
    output: { example: { city: "Istanbul", temperature: 21, conditions: "sunny" } },
  });
  const users = httpRoute({
    method: "GET",
    path: "/users/:id",
    description: "Public profile of a user",
    payment: pay(PRICES.users),
    pathParams: { id: param.string({ description: "User id", example: "42", maxLength: 40 }) },
    output: { example: { id: "42", name: "Ada", joined: "2026-01-01" } },
  });
  const translate = httpRoute({
    method: "POST",
    path: "/translate",
    description: "Translate a short text into another language",
    payment: pay(PRICES.translate),
    body: {
      type: "json",
      params: {
        text: param.string({
          description: "Text to translate, up to 500 characters",
          required: true,
          example: "Hello",
          maxLength: 500,
        }),
        to: param.string({
          description: "Target language code, e.g. tr",
          required: true,
          example: "tr",
          maxLength: 8,
        }),
      },
    },
    output: { example: { text: "Merhaba", to: "tr" } },
  });

  // The metered resources get their own resource server and middleware: a facilitator without upto
  // then fails only those, never the exact routes.
  const metered = options.metered !== false;
  const meteredServer = metered
    ? new x402ResourceServer(facilitator)
        .register(network, new UptoStellarServerScheme())
        .registerExtension(bazaarResourceServerExtension)
        .onBeforeVerify(limits.beforeVerify)
    : undefined;
  const meteredPayment = metered ? meteredOption(options.payTo, options.asset, network) : undefined;
  const history = meteredPayment === undefined ? undefined : declareHistoryRoute(meteredPayment);
  const meteredReady = meteredServer === undefined ? undefined : uptoReadiness(meteredServer, network);

  const app = express();
  app.set("trust proxy", options.trustProxy ?? 0);
  app.use(express.json({ limit: "16kb" }));
  // Before the payment middleware and the MCP endpoint: the limits key each payment by its client.
  app.use(limits.track);
  app.use(
    paymentMiddleware(
      {
        [weather.key]: weather.config,
        [users.key]: users.config,
        [translate.key]: {
          ...translate.config,
          extensions: {
            // An optional idempotency key: a retried POST with the same identifier is one payment.
            [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(),
            ...translate.config.extensions,
          },
        },
      },
      resourceServer,
    ),
  );
  if (meteredServer !== undefined && meteredReady !== undefined && history !== undefined) {
    // The stock middleware stops the process when its facilitator lacks a route's scheme, so the
    // metered route checks for upto itself and answers 503 until the facilitator serves it.
    app.get("/history", (_req, res, next) => {
      meteredReady().then(
        () => {
          next();
        },
        () => {
          res
            .status(503)
            .json({ error: "Metered payments are unavailable: the facilitator does not serve upto." });
        },
      );
    });
    app.use(paymentMiddleware({ [history.key]: history.config }, meteredServer, undefined, undefined, false));
  }

  app.get("/weather", (req, res) => {
    const city = typeof req.query["city"] === "string" ? req.query["city"].slice(0, 80) : "Istanbul";
    res.json({ city, temperature: 21, conditions: "sunny" });
  });
  app.get("/users/:id", (req, res) => {
    res.json({ id: req.params.id.slice(0, 40), name: "Ada", joined: "2026-01-01" });
  });
  app.post("/translate", (req, res) => {
    const body = (req.body ?? {}) as { text?: unknown; to?: unknown };
    const text = typeof body.text === "string" ? body.text.slice(0, 500) : "";
    const to = typeof body.to === "string" ? body.to.slice(0, 8) : "tr";
    // A demonstration: the seller echoes the text; the point is the payment and the listing.
    res.json({ text, to });
  });

  if (history !== undefined) {
    const perDay = baseUnits(METERED_PRICES.perDay, options.asset, network);
    app.get("/history", (req, res) => {
      const days = historyDays(req.query["days"]);
      if (days === undefined) {
        // Nothing is settled for a failed request: the buyer's authorization simply expires.
        res.status(400).json({ error: "days must be a whole number from 1 to 30" });
        return;
      }
      const city = typeof req.query["city"] === "string" ? req.query["city"].slice(0, 80) : "Istanbul";
      setUptoCharge(res, perDay * BigInt(days));
      res.json(historyFor(city, days, perDay));
    });
  }

  const mcp = mcpHandler({
    resourceServer,
    pay,
    ...(meteredServer === undefined || meteredPayment === undefined || meteredReady === undefined
      ? {}
      : {
          metered: {
            resourceServer: meteredServer,
            ready: meteredReady,
            payment: meteredPayment,
            perHour: baseUnits(METERED_PRICES.perHour, options.asset, network),
          },
        }),
    ...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
  });
  app.post("/mcp", mcp.post);
  app.all("/mcp", mcp.other);

  // SEP-1: this domain lists the payTo account in ACCOUNTS, under the passphrase of the seller's network. Only together with the payTo account naming
  // this host as its home_domain (set on the account itself) does the Bazaar raise this seller's
  // origin-verified listings to `domain_verified`: a one-way claim proves nothing.
  app.get("/.well-known/stellar.toml", (_req, res) => {
    res
      .type("text/plain")
      .set("access-control-allow-origin", "*")
      .send(
        `VERSION = "2.7.0"\nNETWORK_PASSPHRASE = "${network === "stellar:pubnet" ? Networks.PUBLIC : Networks.TESTNET}"\nACCOUNTS = ["${options.payTo}"]\n`,
      );
  });
  // Free: not an x402 resource, so a listing for it is never published.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.get("/", (_req, res) => {
    res.json({
      network,
      facilitator: options.facilitatorUrl ?? DEFAULT_FACILITATOR_URL,
      paid: ["GET /weather?city=…", "GET /users/:id", "POST /translate"],
      metered: history === undefined ? [] : ["GET /history?city=…&days=…"],
      mcp: {
        endpoint: "POST /mcp",
        paid: ["forecast", "air_quality"],
        metered: metered ? ["hourly_forecast"] : [],
        free: ["ping"],
      },
      free: ["GET /health"],
    });
  });
  return app;
}
