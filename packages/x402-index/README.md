# @rail402.dev/x402-index

Recognises x402 settlements on Stellar in ledger data and attributes them to facilitators.

The classifier is pure: it reads a ledger's `LedgerCloseMeta`, or one transaction's envelope, result and
meta, and returns settlement rows under the published [indexing rules](./rules/v2.md). It needs no network
access, so the same ledgers and the same registry always give the same rows. The facilitator and upto
contract registries, with their archived public evidence, ship in `registry/`.

```sh
npm install @rail402.dev/x402-index
```

```ts
import { classifyLedger } from "@rail402.dev/x402-index";
import { REGISTRIES } from "@rail402.dev/x402-index/registry";

const result = classifyLedger(ledgerCloseMetaBase64, {
  network: "stellar:testnet",
  epoch: "2025-12-17",
  passphrase: "Test SDF Network ; September 2015",
  registry: REGISTRIES["stellar:testnet"],
});
for (const row of result.rows) console.log(row.txHash, row.scheme, row.amount, row.attribution.tier);
```

Part of [Rail402](https://github.com/tolgayayci/rail402), x402 payments and discovery for Stellar.
Documentation: [docs.rail402.dev](https://docs.rail402.dev). Requires Node.js 24.11 or later. Apache-2.0.
