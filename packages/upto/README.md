# @rail402.dev/upto

The x402 `upto` payment scheme on Stellar: the buyer authorizes a cap, and the seller charges the actual usage, anywhere from zero up to that cap, after serving the request.

The buyer signs one Soroban authorization entry over the payment terms (recipient, token, cap, expiration and the facilitator's settlement authority) for the `x402-upto-stellar` settlement contract. The amount is not part of what the buyer signs. The facilitator later calls `settle(payer, terms, amount)` as the settlement authority. The contract enforces `0 ≤ amount ≤ cap`, and the Soroban host enforces the signature, the expiration and single use of the nonce. The facilitator sponsors every network fee and never holds the buyer's funds.

```sh
npm install @rail402.dev/upto
```

| Entry point                     | Implements                 | For                                                                            |
| ------------------------------- | -------------------------- | ------------------------------------------------------------------------------ |
| `@rail402.dev/upto/client`      | `SchemeNetworkClient`      | buyers: signs `{ authorization }` from the payment requirements                |
| `@rail402.dev/upto/server`      | `SchemeNetworkServer`      | sellers: prices become caps; `uptoSettlementOverrides(amount)` sets the charge |
| `@rail402.dev/upto/facilitator` | `SchemeNetworkFacilitator` | facilitators: verification rules, simulation, settlement                       |
| `@rail402.dev/upto`             |                            | terms codec, authorization inspection, reason codes, constants                 |

Networks without a built-in deployment of the settlement contract need its address configured: `contracts` on the client and `contract` on the facilitator.

A client signs for at most 300 seconds (`maxTimeoutSeconds` option) and only for a `G…` settlement authority, a facilitator accepts `maxTimeoutSeconds` from one ledger more than its expiration margin (15 seconds by default, `minTimeoutSeconds` option) to 300 seconds, and a facilitator that records a zero settlement without submitting it must keep that record durably and share it with every process holding its settlement authority until the authorization expires.

The `@rail402.dev/upto/facilitator` mechanism keeps its settlement records (at-most-once submission, off-chain zeros, pending outcomes) in the memory of one process: run it as the only process holding its settlement authority, or put a shared settlement ledger in front of it. It never answers a settlement that may have been broadcast as failed without its transaction hash: a lost `sendTransaction` answer or a confirmation that runs out of attempts is `settlement_pending` with the hash, and a repeat of the same request keeps polling that transaction, also after the authorization expired, until the network shows it included or proves it absent. While its own hash is not found, it also looks the transaction inside its fee bump up by hash, so a settlement that landed inside another party's fee bump is answered from there, and with an RPC that reads ledger entries it answers one as never included only while the payer's nonce is unused. A settlement refused for a stale sequence number is rebuilt once (`badSequenceRetries` option), then answered `settle_upto_stellar_channel_unavailable`, which may be retried. The fee ceiling (`maxTransactionFeeStroops`, 500,000 stroops by default) covers the resource fee and the inclusion fee, counted twice under a fee bump.

Every refusal has a stable reason code with a non-empty message. `uptoStandardCodes` and `uptoStellarCodes` list every code with its HTTP status, whether a retry can succeed, and a default reason.

Part of [Rail402](https://github.com/tolgayayci/rail402), x402 payments and discovery for Stellar.
Documentation: [docs.rail402.dev](https://docs.rail402.dev). Requires Node.js 24.11 or later. Apache-2.0.
