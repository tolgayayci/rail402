#!/usr/bin/env node
/**
 * A complete x402 seller on Stellar testnet: one paid endpoint behind the STOCK @x402/hono
 * middleware, priced in test USDC, settled by the Rail402 facilitator, and carrying Bazaar
 * discovery metadata with per-parameter descriptions — so it is cataloged and searchable after
 * its first settled payment (no registration step).
 *
 * Usage:  SELLER_ADDRESS=G… node seller-starter.mjs
 * Needs:  npm i @x402/core@2.20.0 @x402/hono@2.20.0 @x402/stellar@2.20.0 @x402/extensions@2.20.0 hono @hono/node-server
 *         SELLER_ADDRESS must be a testnet account WITH a USDC trustline (make-wallet.mjs mints one).
 *
 * Verify it, then make its first payment:
 *   curl -s -X POST https://playground-api-production-5062.up.railway.app/publish/check \
 *        -H 'content-type: application/json' -d '{"url":"https://<public-host>/lookup?q=x"}'
 *   node buyer-starter.mjs --url "https://<public-host>/lookup?q=hello" --budget 0.10
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { paymentMiddleware } from "@x402/hono";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";

const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "https://facilitator.rail402.dev";
const PAY_TO = process.env.SELLER_ADDRESS;
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"; // testnet USDC token contract
const PORT = Number(process.env.PORT ?? 4030);

if (!PAY_TO || !PAY_TO.startsWith("G")) {
  console.error("Set SELLER_ADDRESS to a testnet G… account holding a USDC trustline (see make-wallet.mjs).");
  process.exit(1);
}

const x402 = new x402ResourceServer([new HTTPFacilitatorClient({ url: FACILITATOR_URL })]);
x402.register("stellar:*", new ExactStellarScheme());
x402.registerExtension(bazaarResourceServerExtension); // ← automatic cataloging on first payment

const app = new Hono();
app.use(
  "*",
  paymentMiddleware(
    {
      "GET /lookup": {
        accepts: {
          scheme: "exact",
          network: "stellar:testnet",
          price: { amount: "500000", asset: USDC }, // "500000" stroops = 0.05 USDC — integers only
          payTo: PAY_TO,
          maxTimeoutSeconds: 60, // REQUIRED: the buyer's authorization expiry derives from it
        },
        description: "Echoes the looked-up term with a timestamp — replace with your real API.",
        mimeType: "application/json",
        // declareDiscoveryExtension() already returns { bazaar: … } — do NOT wrap it again.
        // Per-parameter descriptions are what agents read AND what Bazaar search ranks on.
        extensions: declareDiscoveryExtension({
          input: { q: "hello" },
          inputSchema: {
            type: "object",
            properties: {
              q: { type: "string", description: "The term to look up and echo back." },
            },
            required: ["q"],
          },
          output: { example: { result: "hello", at: "2026-01-01T00:00:00Z" } },
        }),
      },
    },
    x402,
  ),
);

// The real handler — the middleware lets it run only after payment settles on-chain.
app.get("/lookup", c => c.json({ result: c.req.query("q") ?? null, at: new Date().toISOString() }));

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`x402 seller listening on http://localhost:${PORT}/lookup?q=hello`);
  console.log(`  facilitator: ${FACILITATOR_URL}`);
  console.log(`  payTo:       ${PAY_TO}`);
  console.log("  unpaid requests get a 402 challenge; the first settled payment catalogs it in the Bazaar");
});
