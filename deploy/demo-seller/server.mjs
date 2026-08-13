import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { paymentMiddleware } from "@x402/hono";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402/extensions/bazaar";

/**
 * Rail402 demo seller — a real, public, USDC-priced x402 endpoint for the live Bazaar.
 *
 * It exists so the production catalog holds something a reviewer's stock client can actually
 * discover and pay end to end. Everything here is stock `@x402/*` — the same middleware, resource
 * server, and Stellar scheme any third-party seller would use — because "a seller needs our SDK to
 * sell on Stellar" would fail the interoperability requirement. The only Rail402-specific
 * thing is the facilitator it points at.
 *
 * Deployed as a standalone Railway service (`deploy/demo-seller`), separate from the facilitator.
 */

const PORT = Number(process.env.PORT ?? 8080);
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "https://facilitator.rail402.dev";
const NETWORK = (process.env.STELLAR_NETWORK ?? "stellar:testnet");
const PAY_TO = process.env.SELLER_ADDRESS;
// Testnet USDC by default — the default asset (issuer GBBD47IF…). Its Stellar
// Asset Contract id; the facilitator derives the same id from the classic asset, so a lookalike
// cannot masquerade as USDC in the catalog.
const ASSET = process.env.PAYMENT_ASSET ?? "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const AMOUNT = process.env.PAYMENT_AMOUNT ?? "1000000"; // 0.10 USDC at 7 decimals — atomic units.

/**
 * The public URL the catalog should key this resource on.
 *
 * Pinned explicitly, not derived from the request, because behind a TLS-terminating proxy (Railway)
 * the app sees plain http on an internal host, and the catalog key must be the https URL an agent
 * on the public internet actually reaches. `@x402/core` honours `resource` over the request URL
 * (x402HTTPResourceServer: `routeConfig.resource || adapter.getUrl()`).
 */
const PUBLIC_RESOURCE_URL = process.env.PUBLIC_RESOURCE_URL;

if (!PAY_TO) {
  console.error("SELLER_ADDRESS is required (the Stellar account that receives payment).");
  process.exit(1);
}
if (!PUBLIC_RESOURCE_URL) {
  console.error(
    "PUBLIC_RESOURCE_URL is required so the catalog keys this listing on the public https URL, " +
      "e.g. https://<your-domain>/quote — never the internal request URL.",
  );
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
      "GET /quote": {
        // Key the catalog on the public https URL, not the internal proxied request URL.
        resource: PUBLIC_RESOURCE_URL,
        accepts: {
          scheme: "exact",
          network: NETWORK,
          // Explicit asset + atomic amount (never a "$0.10" string) so this works for any SEP-41
          // token, and so the price is unambiguous stroops rather than a parsed decimal.
          price: { amount: AMOUNT, asset: ASSET },
          payTo: PAY_TO,
          maxTimeoutSeconds: 60,
        },
        description: "Live foreign-exchange and crypto spot quote for a currency or asset pair.",
        mimeType: "application/json",
        // Declaring this is the ENTIRE seller-side effort to become discoverable: no registration,
        // no dashboard, no API key. Per-parameter descriptions are what make the endpoint legible to
        // an agent, so they are written properly — the Bazaar's semantic search indexes them.
        extensions: declareDiscoveryExtension({
          input: { base: "XLM", quote: "USD" },
          inputSchema: {
            type: "object",
            properties: {
              base: {
                type: "string",
                description:
                  "Base currency or asset to price, as a ticker symbol — for example XLM, BTC, ETH, or USDC.",
              },
              quote: {
                type: "string",
                description:
                  "Quote currency the price is denominated in, such as USD, EUR, or GBP. Defaults to USD.",
              },
            },
            required: ["base"],
          },
          output: {
            example: { base: "XLM", quote: "USD", price: 0.1234, asOf: "2026-08-13T00:00:00Z" },
          },
        }),
      },
    },
    x402Server,
  ),
);

// The paid handler. A demo, so the quote is synthetic — but the shape, the parameters, and the
// payment flow are all real.
app.get("/quote", c => {
  const base = (c.req.query("base") ?? "XLM").toUpperCase();
  const quote = (c.req.query("quote") ?? "USD").toUpperCase();
  // Deterministic pseudo-price so repeated calls look stable; this is not market data.
  const seed = [...`${base}/${quote}`].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) % 100000, 7);
  const price = Number((0.01 + (seed % 5000) / 1000).toFixed(4));
  return c.json({ base, quote, price, asOf: new Date().toISOString(), source: "rail402-demo" });
});

app.get("/health", c => c.json({ status: "ok", resource: PUBLIC_RESOURCE_URL, facilitator: FACILITATOR_URL }));

app.get("/", c =>
  c.json({
    service: "rail402-demo-seller",
    paid: "GET /quote?base=XLM&quote=USD (x402, 0.10 testnet USDC)",
    facilitator: FACILITATOR_URL,
  }),
);

serve({ fetch: app.fetch, port: PORT, hostname: "0.0.0.0" }, info => {
  console.log(`[demo-seller] listening on :${info.port}`);
  console.log(`[demo-seller] resource ${PUBLIC_RESOURCE_URL}`);
  console.log(`[demo-seller] facilitator ${FACILITATOR_URL}`);
  console.log(`[demo-seller] price ${AMOUNT} of ${ASSET} -> ${PAY_TO}`);
});
