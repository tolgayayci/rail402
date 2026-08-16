---
name: x402-stellar
description: >
  Add pay-per-call payments (x402) to an API on Stellar, or discover and pay existing paid APIs.
  Use when the user wants to charge for an API endpoint, monetize an API with micropayments,
  accept USDC per request, make their API discoverable to agents, find paid APIs in the x402
  Bazaar, or have an agent pay for API calls on Stellar testnet.
---

# x402 on Stellar (Rail402)

x402 is the open protocol for pay-per-call HTTP: a seller answers an unpaid request with
`402 Payment Required` and a machine-readable price; the buyer signs a payment authorization; a
**facilitator** verifies and settles it on Stellar and the seller returns the data. Payments are
real on-chain USDC transfers, the buyer needs **no XLM** (fees are sponsored by the facilitator),
and every paid endpoint is **automatically cataloged** in a searchable index (the Bazaar) the first
time it is paid — no registration step.

This skill covers two roles. Read the reference for the one the user needs:

- **Seller** — turn an API endpoint into a paid, agent-discoverable x402 resource:
  read [references/seller.md](references/seller.md)
- **Buyer / agent** — discover a paid API in the Bazaar and pay it programmatically:
  read [references/buyer.md](references/buyer.md)

Runnable starters (plain Node, stock npm packages only) live in `scripts/`:
`make-wallet.mjs` (funded testnet wallet), `seller-starter.mjs` (paid + discoverable endpoint),
`buyer-starter.mjs` (search → pay with a spend cap).

## Live infrastructure (testnet — all free, no API keys)

| What | URL |
|---|---|
| Facilitator (verify/settle/supported) | `https://facilitator.rail402.dev` |
| Bazaar search | `https://facilitator.rail402.dev/discovery/search?query=…` |
| Bazaar catalog | `https://facilitator.rail402.dev/discovery/resources` |
| Playground API (wallet funding, 402 explainers, publish checks) | `https://playground-api-production-5062.up.railway.app` |
| Explorer (x402-aware receipts) | `https://explorer-explorer.up.railway.app` (API) |

The payment asset is **testnet USDC** (issuer `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`,
token contract `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`). Amounts are 7-decimal
integer "stroops" on the wire: `"500000"` = 0.05 USDC. Never do float math on amounts.

## Rules that keep you honest and safe

1. **Testnet only.** Everything here uses `stellar:testnet` and test USDC with no real value. Do
   not point any of it at mainnet.
2. **Always cap spending.** Before paying anything, ask the user for a budget (or state the
   default you chose). Enforce it in the payment client's requirements selector — the code in
   [references/buyer.md](references/buyer.md) shows the one correct place — never by checking an
   earlier unpaid quote.
3. **Stellar addresses are checksummed.** `G…` (account), `C…` (contract), `S…` (secret — never
   log it). You cannot fabricate or edit one by hand; generate keys with the SDK or
   `scripts/make-wallet.mjs`.
4. **Receiving USDC needs a trustline.** A Stellar account must open a trustline to the asset
   before it can hold it. `make-wallet.mjs` does this for you; a seller's `payTo` account without
   one cannot be paid.
5. **Every failure has a machine-readable code.** Rejections carry `{ code, reason, retryable }`.
   Branch on `code`, show the user `reason`, and only retry when `retryable` is true. To decode a
   confusing 402 or inspect a settled payment, POST it to the playground's
   `/debug/challenge` / `/debug/tx`.

## Verify your work

- Seller path done ⇒ `POST https://playground-api-production-5062.up.railway.app/publish/check`
  with `{ "url": "<your endpoint>" }` reports whether the 402 is well-formed, then the first real
  payment makes it appear in `GET /discovery/search?query=…`.
- Buyer path done ⇒ the paid response arrives with a `PAYMENT-RESPONSE` header whose decoded
  `transaction` is a real hash you can open at
  `https://stellar.expert/explorer/testnet/tx/<hash>`.
