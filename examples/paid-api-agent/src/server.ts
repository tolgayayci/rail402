import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { paymentMiddleware } from "@x402/hono";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402/extensions/bazaar";

/**
 * A paid API — the seller side.
 *
 * Nothing here is bespoke. It is the stock `@x402/hono` middleware, the stock
 * `x402ResourceServer`, and the stock `@x402/stellar` server scheme, pointed at our facilitator
 * over the stock `HTTPFacilitatorClient`. That is the point: if a seller needed *our* SDK to sell
 * on Stellar, we would have failed the interoperability requirement.
 */

const PORT = Number(process.env.PORT ?? 4023);
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "http://localhost:4022";
const NETWORK = (process.env.STELLAR_NETWORK ?? "stellar:testnet") as `${string}:${string}`;
const PAY_TO = process.env.SELLER_ADDRESS;
const ASSET = process.env.PAYMENT_ASSET;
const AMOUNT = process.env.PAYMENT_AMOUNT ?? "2500000"; // 0.25 units at 7 decimals

if (!PAY_TO || !ASSET) {
  console.error("SELLER_ADDRESS and PAYMENT_ASSET are required");
  process.exit(1);
}

const x402Server = new x402ResourceServer([new HTTPFacilitatorClient({ url: FACILITATOR_URL })]);
x402Server.register("stellar:*", new ExactStellarScheme());
// Enriches the declaration with the concrete HTTP method and any dynamic-route template.
x402Server.registerExtension(bazaarResourceServerExtension);

const app = new Hono();

app.use(
  "*",
  paymentMiddleware(
    {
      "GET /premium/quote": {
        accepts: {
          scheme: "exact",
          network: NETWORK,
          // Explicit asset + atomic amount rather than a "$0.10" string, so the example works with
          // any SEP-41 token instead of only the default USDC.
          price: { amount: AMOUNT, asset: ASSET },
          payTo: PAY_TO,
          maxTimeoutSeconds: 60,
        },
        description: "A price quote for a named commodity.",
        mimeType: "application/json",
        // Declaring this is the ENTIRE seller-side effort required to become discoverable. There is
        // no registration step, no dashboard and no API key: the facilitator catalogs the resource
        // when the first payment settles. Per-parameter descriptions are what make the endpoint
        // legible to an agent, so they are worth writing properly.
        // declareDiscoveryExtension already returns a `{ bazaar: ... }` object, so it IS the
        // extensions map — wrapping it in another `bazaar` key nests it twice and the facilitator
        // rejects the listing.
        extensions: declareDiscoveryExtension({
          input: { symbol: "XLM" },
          inputSchema: {
            type: "object",
            properties: {
              symbol: {
                type: "string",
                description: "Ticker symbol of the commodity or asset to price, such as XLM or BTC.",
              },
            },
            required: ["symbol"],
          },
          output: {
            example: { symbol: "XLM", price: 0.1234, currency: "USD", asOf: "2026-07-30T00:00:00Z" },
          },
        }),
      },
    },
    x402Server,
  ),
);

app.get("/premium/quote", c =>
  c.json({
    symbol: c.req.query("symbol") ?? "XLM",
    price: 0.1234,
    currency: "USD",
    asOf: new Date().toISOString(),
  }),
);

app.get("/health", c => c.json({ status: "ok" }));

serve({ fetch: app.fetch, port: PORT }, info => {
  console.log(`[server]  paid API on http://localhost:${info.port}/premium/quote`);
  console.log(`[server]  facilitator ${FACILITATOR_URL}`);
  console.log(`[server]  price ${AMOUNT} of ${ASSET} -> ${PAY_TO}`);
});
