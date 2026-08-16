# Buyer / agent path: discover a paid API and pay it, with a spend cap

Outcome: a funded testnet wallet, a Bazaar search that finds a resource, and a paid call through
the stock x402 client whose spending is HARD-CAPPED — ending in an on-ledger settlement hash.

Runnable end state: `scripts/buyer-starter.mjs`.

## 1. Fund a wallet (no XLM needed for payments — fees are sponsored)

```sh
node scripts/make-wallet.mjs
```

This creates a keypair, funds it with test XLM (friendbot), opens the USDC trustline, and asks the
playground dispenser for a drip of test USDC. Export the printed secret:

```sh
export CLIENT_STELLAR_PRIVATE_KEY=S…   # testnet-only key; never log or commit an S… key
```

## 2. Discover

Natural-language search over everything sellers have cataloged:

```sh
curl -s "https://facilitator.rail402.dev/discovery/search?query=convert%20currency" | jq '.resources[0]'
```

Each result carries `resource` (the URL), `accepts` (scheme/network/amount/payTo — the price in
stroops), and per-parameter descriptions under the bazaar extension schema
(`…input.properties.queryParams.properties.<name>.description`) — read those to construct a valid
call. `GET /discovery/resources` is the browsable, filterable catalog
(`?type=`, `?payTo=`, `?scheme=`, `?network=`, `?limit=`, `?offset=`).

Judge payability before paying: a Stellar `exact` option must carry
`extra.areFeesSponsored: true` (the stock client refuses to pay without it). To get a full
defect report for any challenge, POST it to the playground:
`POST /debug/challenge { "challenge": <402 body or PAYMENT-REQUIRED header> }`.

## 3. Pay — with the cap enforced in the ONLY reliable place

```js
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { createEd25519Signer, ExactStellarScheme } from "@x402/stellar";

const BUDGET_STROOPS = 1000000n; // 0.10 USDC — ALWAYS set one; ask the user for it

// The requirements selector runs on the request that is actually paid, immediately before
// anything is signed. Enforce the budget HERE. Checking an earlier unpaid quote instead is a
// real vulnerability: a seller can quote cheap on the probe and expensive on the paid request.
const budgetSelector = (_x402Version, requirements) => {
  const payable = requirements
    .filter(r => r.network?.startsWith("stellar:") && typeof r.amount === "string")
    .filter(r => /^\d+$/.test(r.amount) && BigInt(r.amount) <= BUDGET_STROOPS)
    .sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? -1 : 1));
  if (payable.length === 0) {
    const cheapest = requirements[0]?.amount ?? "?";
    throw new Error(`budget exceeded: cheapest option ${cheapest} stroops > cap ${BUDGET_STROOPS}`);
  }
  return payable[0];
};

const signer = createEd25519Signer(process.env.CLIENT_STELLAR_PRIVATE_KEY, "stellar:testnet");
const client = new x402Client(budgetSelector);
client.register("stellar:*", new ExactStellarScheme(signer));
const paidFetch = wrapFetchWithPayment(fetch, client);

const res = await paidFetch("https://…/lookup?q=hello");     // 402 → sign → settle → 200, automatic
const data = await res.json();
```

Read the receipt — the settled transaction hash arrives on the response:

```js
import { decodePaymentResponseHeader } from "@x402/core/http";
const receipt = decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE"));
// receipt.transaction → verify at https://stellar.expert/explorer/testnet/tx/<hash>
```

Caveats that cost real debugging time:

- **`@x402/fetch` destroys thrown error objects** (rethrows `new Error("Failed to create payment
  payload: " + message)` — no class, no cause). If you must branch on a refusal (e.g. budget
  exceeded), record it in a closure variable inside the selector before throwing; only the message
  text survives the wrapper.
- A budget refused in the selector means **nothing was signed and nothing was spent**.
- Payment failures come back as `{ code, reason, retryable }`. Retry only `retryable: true`.
  A settled-then-failed resource call means money moved — never blind-retry a paid request.

## 4. Alternative: the MCP route (no code)

`POST https://playground-api-production-5062.up.railway.app/agent/mcp-config` with
`{ "sessionSecret": "S…", "budget": "0.10" }` returns a ready-to-paste MCP server config exposing
`search_stellar_resources` and `pay_and_call` (spend cap mandatory) to Claude Code / Cursor. The
`@rail402.dev/mcp-discovery` package is not on npm yet — the response's `note` explains how to run it
from a checkout.

## Decode any payment later

`POST https://playground-api-production-5062.up.railway.app/debug/tx { "hash": "<64-hex>" }`
returns the explained view: scheme, buyer/seller, fee sponsorship read off the ledger, and a
step-by-step narration. Its `confidence` field is honest — `rail402` / `verified-facilitator` /
`x402-shaped` (inferred from shape, unconfirmed) — surface it, never flatten it.
