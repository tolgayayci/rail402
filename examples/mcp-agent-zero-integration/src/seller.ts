import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { paymentMiddleware } from "@x402/hono";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { describeEndpoint } from "@rail402.dev/seller-helpers";

/**
 * The service the agent will discover.
 *
 * The agent has never heard of this server. It becomes findable purely by being paid for once —
 * there is no registration step, no dashboard, and no API key anywhere in this file.
 *
 * Note `describeEndpoint`: the parameter descriptions written here are what the agent reads to
 * learn how to call an endpoint it has never seen, and what Bazaar search ranks on. They are the
 * whole interface.
 */
const PORT = Number(process.env.PORT ?? 4023);
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "http://localhost:4022";
const NETWORK = (process.env.STELLAR_NETWORK ?? "stellar:testnet") as `${string}:${string}`;
const PAY_TO = process.env.SELLER_ADDRESS;
const ASSET = process.env.PAYMENT_ASSET;

if (!PAY_TO || !ASSET) {
  console.error("SELLER_ADDRESS and PAYMENT_ASSET are required");
  process.exit(1);
}

const x402Server = new x402ResourceServer([new HTTPFacilitatorClient({ url: FACILITATOR_URL })]);
x402Server.register("stellar:*", new ExactStellarScheme());
x402Server.registerExtension(bazaarResourceServerExtension);

const app = new Hono();

app.use(
  "*",
  paymentMiddleware(
    {
      "GET /commodity/price": {
        accepts: {
          scheme: "exact",
          network: NETWORK,
          price: { amount: process.env.PAYMENT_AMOUNT ?? "2500000", asset: ASSET },
          payTo: PAY_TO,
          maxTimeoutSeconds: 60,
        },
        description: "Spot price for a commodity or digital asset, by ticker symbol.",
        mimeType: "application/json",
        extensions: describeEndpoint({
          params: {
            symbol: {
              description:
                "Ticker symbol of the commodity or digital asset to price, such as XLM, BTC or GOLD.",
              example: "XLM",
            },
            currency: {
              description: "ISO 4217 currency code to quote the price in. Defaults to USD.",
              required: false,
              example: "USD",
            },
          },
          outputExample: { symbol: "XLM", price: 0.1234, currency: "USD", asOf: "2026-07-31T00:00:00Z" },
        }),
      },
    },
    x402Server,
  ),
);

app.get("/commodity/price", c =>
  c.json({
    symbol: c.req.query("symbol") ?? "XLM",
    price: 0.1234,
    currency: c.req.query("currency") ?? "USD",
    asOf: new Date().toISOString(),
  }),
);

serve({ fetch: app.fetch, port: PORT }, info => {
  console.log(`[seller] http://localhost:${info.port}/commodity/price`);
  console.log(`[seller] discoverable after its first settled payment — no registration step`);
});
