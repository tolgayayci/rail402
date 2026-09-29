/**
 * A public x402 seller on the Stellar testnet, built only from the stock x402 packages: express
 * `paymentMiddleware`, the Stellar `exact` server scheme and the bazaar server extension. Every paid
 * route declares Bazaar discovery metadata, so a settled payment through Rail402 catalogs it, and its
 * unpaid 402 response is what Rail402's origin check confirms the listing against. `POST /translate`
 * also declares the payment-identifier extension, which discovery lists and filters on.
 */
import express, { type Express } from "express";
import { HTTPFacilitatorClient, x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import { paymentMiddleware } from "@x402/express";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import {
  PAYMENT_IDENTIFIER,
  declarePaymentIdentifierExtension,
  paymentIdentifierResourceServerExtension,
} from "@x402/extensions/payment-identifier";
import { ExactStellarScheme } from "@x402/stellar/exact/server";

export const NETWORK = "stellar:testnet" as const;

export interface SellerOptions {
  /** The Stellar account (G…, C… or M…) that receives every payment. */
  readonly payTo: string;
  /** The facilitator that verifies and settles payments; Rail402's hosted testnet by default. */
  readonly facilitator?: FacilitatorClient;
  /**
   * Reverse proxies in front of the seller (Express `trust proxy`). Behind a TLS proxy, this makes the
   * resource URLs in 402 responses use the public `https` scheme and host.
   */
  readonly trustProxy?: number;
}

/** The seller's routes: path, price in USD (settled in testnet USDC) and what it sells. */
export function createSeller(options: SellerOptions): Express {
  const facilitator =
    options.facilitator ?? new HTTPFacilitatorClient({ url: "https://testnet.rail402.dev" });
  const resourceServer = new x402ResourceServer(facilitator)
    .register(NETWORK, new ExactStellarScheme())
    .registerExtension(bazaarResourceServerExtension)
    .registerExtension(paymentIdentifierResourceServerExtension);
  const accepts = (price: string) => ({ scheme: "exact", price, network: NETWORK, payTo: options.payTo });

  const app = express();
  app.set("trust proxy", options.trustProxy ?? 0);
  app.use(express.json({ limit: "16kb" }));
  app.use(
    paymentMiddleware(
      {
        "GET /weather": {
          accepts: accepts("$0.001"),
          description: "Current weather for a city",
          mimeType: "application/json",
          extensions: declareDiscoveryExtension({
            input: { city: "Istanbul" },
            inputSchema: {
              properties: { city: { type: "string", description: "City name" } },
              required: ["city"],
            },
            output: { example: { city: "Istanbul", temperature: 21, conditions: "sunny" } },
          }),
        },
        "GET /users/:id": {
          accepts: accepts("$0.001"),
          description: "Public profile of a user",
          mimeType: "application/json",
          extensions: declareDiscoveryExtension({
            output: { example: { id: "42", name: "Ada", joined: "2026-01-01" } },
          }),
        },
        "POST /translate": {
          accepts: accepts("$0.002"),
          description: "Translate a short text into another language",
          mimeType: "application/json",
          extensions: {
            // An optional idempotency key: a retried POST with the same identifier is one payment.
            [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(),
            ...declareDiscoveryExtension({
              bodyType: "json",
              input: { text: "Hello", to: "tr" },
              inputSchema: {
                properties: {
                  text: { type: "string", description: "Text to translate, up to 500 characters" },
                  to: { type: "string", description: "Target language code, e.g. tr" },
                },
                required: ["text", "to"],
              },
              output: { example: { text: "Merhaba", to: "tr" } },
            }),
          },
        },
      },
      resourceServer,
    ),
  );

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
  // SEP-1: this domain claims the payTo account, which lifts its listings to `domain_verified`.
  app.get("/.well-known/stellar.toml", (_req, res) => {
    res
      .type("text/plain")
      .set("access-control-allow-origin", "*")
      .send(
        `VERSION = "2.7.0"\nNETWORK_PASSPHRASE = "Test SDF Network ; September 2015"\nACCOUNTS = ["${options.payTo}"]\n`,
      );
  });
  // Free: not an x402 resource, so a listing for it is never published.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  app.get("/", (_req, res) => {
    res.json({
      network: NETWORK,
      facilitator: "https://testnet.rail402.dev",
      paid: ["GET /weather?city=…", "GET /users/:id", "POST /translate"],
      free: ["GET /health"],
    });
  });
  return app;
}
