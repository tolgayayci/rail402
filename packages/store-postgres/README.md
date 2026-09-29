# @rail402.dev/store-postgres

Postgres stores for Rail402.

Durable settlement ledger, channel-account leases, Bazaar catalog, rate limits and metering on Postgres, with the SQL migrations (`migrate`) that create them. Pass them to [`@rail402.dev/facilitator`](https://www.npmjs.com/package/@rail402.dev/facilitator) for multi-process settlement.

```sh
npm install @rail402.dev/store-postgres
```

Part of [Rail402](https://github.com/tolgayayci/rail402), x402 payments and discovery for Stellar.
Documentation: [docs.rail402.dev](https://docs.rail402.dev). Requires Node.js 24.11 or later. Apache-2.0.
