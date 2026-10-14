# @rail402.dev/sdk

Pay x402 resources on Stellar from TypeScript under a spending cap, discover them through the Rail402 Bazaar,
and describe your own paid endpoints and MCP tools.

- **Buyer**: pays HTTP endpoints and paid MCP tools with the unmodified `@x402/stellar` `exact` client, and capped
  usage-based `upto` prices with the `@rail402.dev/upto` client, behind a signing guard that checks every
  authorization against your spending policy immediately before it is signed. An upto payment reserves its cap
  and keeps only the charge the chain proves.
  Receipts carry the settlement transaction hash and its explorer link, verified on chain.
- **Discovery**: natural-language search of the Bazaar, and payments bound to a listing's owner and price.
- **Seller helpers** (`@rail402.dev/sdk/seller`): paid routes and tools with discovery metadata the Rail402
  catalog accepts as is, validated before the first sale.

```sh
npm install @rail402.dev/sdk
```

```ts
import { createBuyer } from "@rail402.dev/sdk";

const buyer = await createBuyer({
  network: "stellar:testnet",
  signer: { secretFile: "~/.config/rail402/keys/stellar-testnet.key" },
});

const paid = await buyer.pay(
  { kind: "http", url: "https://demo.rail402.dev/weather", query: { city: "Ankara" } },
  { maxAmount: { amount: "0.01", asset: "USDC" } },
);
console.log(paid.payment?.transaction, paid.payment?.explorerUrl, paid.response);

const found = await buyer.searchAndPay("current weather for a city", {
  maxAmount: { amount: "0.01" },
  call: { query: { city: "Izmir" } },
});
console.log(found.chosen.listingId, found.payment?.explorerUrl);
```

The network is always explicit: `stellar:testnet` has default endpoints and caps (0.10 USDC per call, 1.00 USDC
per 24-hour window); `stellar:pubnet` requires an RPC URL, a Bazaar URL and caps. Every failure is a
`PaymentError` with a stable `code`, a non-empty `reason` and `paid` (`none`, `not_settled`, `settled` or
`unknown`).

| Entry point               | Contents                                                                                                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@rail402.dev/sdk`        | `createBuyer`, spending policy, signing guard, discovery, codes                                                                                                  |
| `@rail402.dev/sdk/sqlite` | `SqliteSpendLedger`: one budget shared by several processes                                                                                                      |
| `@rail402.dev/sdk/seller` | `httpRoute`, `mcpTool`, `exact`, `upto`, `param`, `setUptoCharge`, `meteredToolServer`, `chargeUpto`, `validateListing`, `checkSellerOrigin`, `withSettleDedupe` |

Guides: [buyer SDK](https://docs.rail402.dev/agents/sdk), [seller helpers](https://docs.rail402.dev/sellers/helpers),
[spending policy and signing guard](https://docs.rail402.dev/reference/spending-policy),
[error codes](https://docs.rail402.dev/reference/error-codes#client-codes).

Part of [Rail402](https://github.com/tolgayayci/rail402), x402 payments and discovery for Stellar.
Documentation: [docs.rail402.dev](https://docs.rail402.dev). Requires Node.js 24.11 or later. Apache-2.0.
