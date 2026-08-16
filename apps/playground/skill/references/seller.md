# Seller path: make an API endpoint paid and discoverable

Outcome: an HTTP endpoint that answers unpaid requests with a priced `402`, gets paid in testnet
USDC through the Rail402 facilitator, and appears in the Bazaar catalog — with per-parameter
descriptions an agent can act on — after its first settled payment.

Runnable end state: `scripts/seller-starter.mjs`. Adapt it into the user's project rather than
inventing a new shape.

## 1. Install (all public npm, Apache-2.0/MIT)

```sh
npm i @x402/core@2.20.0 @x402/hono@2.20.0 @x402/stellar@2.20.0 @x402/extensions@2.20.0 hono @hono/node-server
```

Express instead of Hono: swap `@x402/hono` for `@x402/express@2.20.0`; the route config object is
identical.

## 2. The seller needs a payTo account WITH a USDC trustline

The `payTo` address receives the payments. It must exist on testnet and hold a trustline to
testnet USDC — an account without one cannot receive the asset (the facilitator refuses with a
coded reason rather than burning the payment). Create one:

```sh
node scripts/make-wallet.mjs        # prints G… (use as SELLER_ADDRESS) and S… (keep private)
```

## 3. Wire the middleware

```js
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { paymentMiddleware } from "@x402/hono";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";

const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "https://facilitator.rail402.dev";
const PAY_TO = process.env.SELLER_ADDRESS;                    // G…, with a USDC trustline
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"; // testnet USDC contract

const x402 = new x402ResourceServer([new HTTPFacilitatorClient({ url: FACILITATOR_URL })]);
x402.register("stellar:*", new ExactStellarScheme());
x402.registerExtension(bazaarResourceServerExtension);        // ← automatic cataloging

const app = new Hono();
app.use(
  "*",
  paymentMiddleware(
    {
      "GET /lookup": {
        accepts: {
          scheme: "exact",
          network: "stellar:testnet",
          price: { amount: "500000", asset: USDC },           // "500000" stroops = 0.05 USDC
          payTo: PAY_TO,
          maxTimeoutSeconds: 60,                               // REQUIRED on v2 requirements
        },
        description: "One-sentence description of what a paid call returns.",
        mimeType: "application/json",
        extensions: declareDiscoveryExtension({
          input: { q: "hello" },                               // example call
          inputSchema: {
            type: "object",
            properties: {
              q: { type: "string", description: "What to look up." },
            },
            required: ["q"],
          },
          output: { example: { result: "…" } },
        }),
      },
    },
    x402,
  ),
);

// The real handler — runs only after payment settles.
app.get("/lookup", c => c.json({ result: c.req.query("q") }));

serve({ fetch: app.fetch, port: 4030 });
```

Rules that are easy to get wrong:

- **`declareDiscoveryExtension(...)` is the whole `extensions` value.** It already returns
  `{ bazaar: … }`; wrapping it again nests it twice and cataloging silently does nothing.
- **Describe every parameter** in `inputSchema.properties.<name>.description`. This is what an
  agent reads to call an endpoint it has never seen, and what Bazaar search ranks on. An
  undescribed parameter is invisible to both.
- **`maxTimeoutSeconds` is required.** The buyer's authorization expiry (~60s of ledgers) is
  derived from it; omitting it makes the listing unconsumable.
- **Amounts are integer strings.** `"500000"`, never `0.05`.
- **POST bodies**: add `bodyType: "json"` to the `declareDiscoveryExtension` config and use
  `"POST /route"` as the key.

## 4. Verify before publishing

Probe your running endpoint (unpaid) through the playground:

```sh
curl -s -X POST https://playground-api-production-5062.up.railway.app/publish/check \
  -H 'content-type: application/json' -d '{"url":"https://your-host/lookup?q=x"}'
```

It reports `is402` / `hasStellarExact` / `hasDiscovery` / `priceDecimal` with a human reason. Fix
anything it flags. (Localhost URLs can't be probed by the hosted playground — either expose a
tunnel or compare your 402 against the checks in `POST /debug/challenge`.)

## 5. First payment ⇒ cataloged

Cataloging is automatic and settlement-gated: the endpoint appears when someone first PAYS it (a
free verify only creates a provisional, zero-ranked entry). Make the first payment yourself:

```sh
node scripts/buyer-starter.mjs --url "https://your-host/lookup?q=hello" --budget 0.10
```

Then confirm it is discoverable:

```sh
curl -s "https://facilitator.rail402.dev/discovery/search?query=<words from your description>"
```

Notes: the resource URL must be publicly reachable (the catalog key is origin + route), and only
`https` origins are payable by strangers. Ranking grows with DISTINCT real payers, not with
self-payments — don't bother gaming it.

## Related

- The Rail402 monorepo ships `@rail402.dev/seller-helpers` (`describeEndpoint`) — a typed wrapper over
  the same stock extension with less boilerplate. It is not on npm yet; if you are working inside
  that repo, prefer it. Everything above uses only published packages.
- Snippet generator: `GET https://playground-api-production-5062.up.railway.app/publish/snippet?framework=hono&path=/lookup&price=0.05&description=…`
  returns this same scaffold pre-filled.
