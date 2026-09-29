# @rail402.dev/facilitator

An x402 facilitator for Stellar that runs in your own process.

The settlement engine behind the Rail402 service, built on the unmodified [`@x402/stellar`](https://www.npmjs.com/package/@x402/stellar) scheme: strict verification, fee sponsorship through channel accounts, and idempotent, crash-safe settlement. `inProcessClient` turns it into a stock x402 `FacilitatorClient`, so a resource server can settle its own payments without an external facilitator.

```sh
npm install @rail402.dev/facilitator
```

```ts
import { createStellarFacilitator, inProcessClient } from "@rail402.dev/facilitator";
import { x402ResourceServer } from "@x402/core/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";

const facilitator = createStellarFacilitator({
  networks: [
    {
      network: "stellar:testnet",
      rpcUrl: "https://soroban-testnet.stellar.org",
      sponsorSecret: process.env.SPONSOR_SECRET!,
      channelCount: 2,
    },
  ],
});
const server = new x402ResourceServer(inProcessClient(facilitator)).register(
  "stellar:testnet",
  new ExactStellarScheme(),
);
```

The full example, including provisioning the channel accounts, is in [In-process](https://docs.rail402.dev/facilitator/in-process).

Part of [Rail402](https://github.com/tolgayayci/rail402), x402 payments and discovery for Stellar.
Documentation: [docs.rail402.dev](https://docs.rail402.dev). Requires Node.js 24.11 or later. Apache-2.0.
