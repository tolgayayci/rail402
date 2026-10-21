# Rail402

[![CI](https://github.com/tolgayayci/rail402/actions/workflows/ci.yml/badge.svg)](https://github.com/tolgayayci/rail402/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@rail402.dev/facilitator?label=%40rail402.dev%2Ffacilitator)](https://www.npmjs.com/package/@rail402.dev/facilitator)
[![Licence](https://img.shields.io/badge/licence-Apache--2.0-blue)](LICENSE)

**x402 payments and discovery for Stellar.** Rail402 is an [x402](https://github.com/x402-foundation/x402)
facilitator: it verifies and settles pay-per-request payments on Stellar and pays the network fee, so buyers
need no XLM. Every API or MCP tool that gets paid through it is cataloged in its Bazaar, where agents and
developers can find it with filters or plain-language search.

- Works with the stock x402 packages (`@x402/fetch`, `@x402/express`, `@x402/stellar`); nothing
  Rail402-specific to install in your client or server.
- Two schemes: `exact` (a fixed price) and `upto` (the buyer signs a cap, the seller settles what the call
  used, through a Soroban settlement contract).
- Non-custodial: the buyer signs the payment, the seller receives it directly, Rail402 only sponsors the fee.
- Agent tools: a buyer SDK, an MCP server (`rail402-mcp`) and a CLI (`rail402`) that find and pay resources
  under a spending cap.
- Hosted testnet instance, free and without an API key; or run your own with one command.
- Apache-2.0.

**Release state.** The npm packages are at **0.4.2** (2026-10-20): the facilitator, the Bazaar and search,
`upto`, the agent tools (`@rail402.dev/sdk`, `@rail402.dev/mcp`, `@rail402.dev/cli`) and their browser
entries. The hosted testnet service runs 0.4.2 with `exact` and `upto`. The latest service release and
container image is **0.2.1** (`exact` only); later versions of the service run from a checkout. The newest
GitHub release, [`upto-contract-v1.0.0`](https://github.com/tolgayayci/rail402/releases/tag/upto-contract-v1.0.0_contracts_stellar_upto_x402-upto-stellar_pkg1.0.0_cli28.1.0),
publishes the `upto` settlement contract's WASM. The
[changelog](CHANGELOG.md) lists what each release adds. The sections below say which release each command
uses.

Documentation: **[docs.rail402.dev](https://docs.rail402.dev)**

## Try it in a minute

The hosted testnet facilitator (0.4.2, `exact` and `upto`) is public:

```sh
curl https://testnet.rail402.dev/supported
curl "https://testnet.rail402.dev/discovery/search?query=weather%20forecast%20under%201%20cent"
```

To pay from a browser instead, open the Playground at [playground.rail402.dev](https://playground.rail402.dev).

## Sell an API

Point a stock x402 resource server at Rail402. With Express:

```sh
npm install express@5 @x402/express@2.27.0 @x402/core@2.27.0 @x402/stellar@2.27.0 @x402/extensions@2.27.0
```

```ts
import express from "express";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { paymentMiddleware } from "@x402/express";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { ExactStellarScheme } from "@x402/stellar/exact/server";

const facilitator = new HTTPFacilitatorClient({ url: "https://testnet.rail402.dev" });
const server = new x402ResourceServer(facilitator)
  .register("stellar:testnet", new ExactStellarScheme())
  .registerExtension(bazaarResourceServerExtension);

const app = express();
app.use(
  paymentMiddleware(
    {
      "GET /weather": {
        accepts: { scheme: "exact", price: "$0.01", network: "stellar:testnet", payTo: process.env.PAY_TO! },
        description: "Current weather for a city",
        extensions: declareDiscoveryExtension({ input: { city: "Ankara" } }),
      },
    },
    server,
  ),
);
app.get("/weather", (_req, res) => res.json({ temperature: 21, conditions: "sunny" }));
app.listen(4021);
```

Each paid request settles in testnet USDC straight to `PAY_TO`. Deployed on a public host, the endpoint is
listed in the Bazaar after its first payment. Full walkthrough, including a receiving account with a USDC
trustline: [Quickstart for sellers](https://docs.rail402.dev/quickstart/sellers).

## Pay for one

```sh
npm install @x402/fetch@2.27.0 @x402/core@2.27.0 @x402/stellar@2.27.0
```

```ts
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";

const pay = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [
    {
      network: "stellar:testnet",
      client: new ExactStellarScheme(createEd25519Signer(process.env.BUYER_SECRET!, "stellar:testnet")),
    },
  ],
});
const response = await pay("https://demo.rail402.dev/weather?city=Ankara");
console.log(response.status, await response.json());
```

The buyer needs testnet USDC and no XLM for fees. Creating a funded account takes one script:
[Quickstart for buyers](https://docs.rail402.dev/quickstart/buyers).

## Run your own facilitator

With the released container image (0.2.1, `exact` only), a testnet facilitator is three commands. Create a fee sponsor, fund it with
Friendbot, and start the service (`STORE=memory` keeps state in the process; use Postgres for anything
that must survive a restart):

```sh
docker run --rm ghcr.io/tolgayayci/rail402:0.2.1 node -e \
  'const k = require("@stellar/stellar-sdk").Keypair.random(); console.log(k.publicKey(), k.secret())'
curl "https://friendbot.stellar.org?addr=G..."          # the public key printed above
docker run -p 8080:8080 -e STORE=memory \
  -e TESTNET_RPC_URL=https://soroban-testnet.stellar.org -e TESTNET_SPONSOR_SECRET=S... \
  ghcr.io/tolgayayci/rail402:0.2.1
```

`curl localhost:8080/ready` answers `200` once the channel accounts exist, within seconds.

For a durable setup with Postgres, one command each from a clone (this builds the checked-out source, so it
includes everything below); both create a fee sponsor funded by Friendbot and wait until the service is ready:

```sh
git clone https://github.com/tolgayayci/rail402.git && cd rail402
./deploy/docker.sh                  # Docker on this machine: Postgres + Rail402 on 127.0.0.1:8080
./deploy/railway.sh my-facilitator  # Railway (after `railway login`): Postgres + Rail402 + a public domain
```

Or embed the settlement engine in your own server with `npm install @rail402.dev/facilitator`:
[In-process](https://docs.rail402.dev/facilitator/in-process).
Configuration, keys and operations: [Configuration](https://docs.rail402.dev/configuration),
[Operations](https://docs.rail402.dev/operations).

## What's inside

| Feature     | Endpoint or command                | Details                                                                                          |
| ----------- | ---------------------------------- | ------------------------------------------------------------------------------------------------ |
| Facilitator | `/supported`, `/verify`, `/settle` | x402 v2 `exact` scheme on `@x402/stellar`; G… and C… accounts; crash-safe, idempotent settlement |
| `upto`      | `/verify`, `/settle`               | Capped payments settled for the amount used through the Soroban `upto` contract                  |
| Bazaar      | `GET /discovery/resources`         | Listings created from settled payments, bound to the paid `payTo`, with version history          |
| Search      | `GET /discovery/search`            | BM25F plus local embeddings, fused with RRF; filters and constraints read from the query         |
| Agent tools | SDK, `rail402-mcp`, `rail402`      | Find, pay and call resources under a spending cap, with SSRF-safe egress                         |
| Playground  | `apps/playground`                  | A browser page that pays on the testnet and shows every message, signature and transaction       |

Every rejection has a stable code and a reason: [Verification rules](https://docs.rail402.dev/verification-rules).
The upstream x402 e2e suite passes against Rail402 on the Stellar testnet
([conformance runs](https://docs.rail402.dev/reference/conformance)), and search quality is measured on a
public dataset with one command, `pnpm eval` ([search evaluation](https://docs.rail402.dev/reference/search-evaluation)).

`stellar:pubnet` can be configured; the hosted instance runs on testnet.

## Packages

| Package                                                                                    | What it is                                                        | On npm |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | ------ |
| [`@rail402.dev/facilitator`](https://www.npmjs.com/package/@rail402.dev/facilitator)       | The settlement engine, usable in-process as an x402 facilitator   | 0.4.2  |
| [`@rail402.dev/bazaar`](https://www.npmjs.com/package/@rail402.dev/bazaar)                 | The Bazaar catalog built from settled payments                    | 0.4.2  |
| [`@rail402.dev/search`](https://www.npmjs.com/package/@rail402.dev/search)                 | Natural-language search over the catalog                          | 0.4.2  |
| [`@rail402.dev/store-postgres`](https://www.npmjs.com/package/@rail402.dev/store-postgres) | Postgres stores for settlements, channel accounts and the catalog | 0.4.2  |
| [`@rail402.dev/stellar`](https://www.npmjs.com/package/@rail402.dev/stellar)               | Stellar payload inspection and failure diagnosis                  | 0.4.2  |
| [`@rail402.dev/errors`](https://www.npmjs.com/package/@rail402.dev/errors)                 | Stable error codes and reasons                                    | 0.4.2  |
| [`@rail402.dev/upto`](https://www.npmjs.com/package/@rail402.dev/upto)                     | The `upto` scheme: client, resource server and facilitator        | 0.4.2  |
| [`@rail402.dev/sdk`](https://www.npmjs.com/package/@rail402.dev/sdk)                       | Buyer SDK: pay under a spending cap, discover through the Bazaar  | 0.4.2  |
| [`@rail402.dev/mcp`](https://www.npmjs.com/package/@rail402.dev/mcp)                       | MCP server (`rail402-mcp`) for AI agents                          | 0.4.2  |
| [`@rail402.dev/cli`](https://www.npmjs.com/package/@rail402.dev/cli)                       | Command-line tool (`rail402`)                                     | 0.4.2  |
| [`@rail402.dev/safe-fetch`](https://www.npmjs.com/package/@rail402.dev/safe-fetch)         | Outbound HTTP for untrusted URLs, SSRF-safe                       | 0.4.2  |

## Develop

Requires Node.js 24.11 or later and pnpm 11 (`corepack enable`, or `mise install`), and Docker for the
integration tests. See [CONTRIBUTING.md](CONTRIBUTING.md).

```sh
pnpm install
pnpm verify                                 # format, lint, typecheck, unit tests, licence gate
docker compose --profile stellar up -d      # Postgres + a private Stellar network
pnpm test:integration
```

| Path                      | Contents                                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| `apps/rail402`            | The HTTP service                                                                                   |
| `apps/demo-seller`        | A public example seller built only from the stock x402 packages                                    |
| `apps/playground`         | The Playground: a page and server for trying x402 payments in a browser                            |
| `packages/facilitator`    | Settlement engine on `@x402/stellar`: preflight, idempotent crash-safe settle                      |
| `packages/upto`           | The `upto` scheme for Stellar: client, resource server and facilitator                             |
| `packages/stellar`        | Stellar payload inspection, reason codes, diagnosis of on-chain failures                           |
| `packages/bazaar`         | The catalog: integrity rules, origin verification, version history                                 |
| `packages/search`         | Natural-language search                                                                            |
| `packages/store-postgres` | Durable ledger, channel leases, catalog, rate limits and metering                                  |
| `packages/sdk`            | Buyer SDK: spending policy, budget ledger, discovery and paid calls                                |
| `packages/mcp`            | MCP server for agents                                                                              |
| `packages/cli`            | Command-line tool                                                                                  |
| `packages/safe-fetch`     | SSRF-safe outbound HTTP                                                                            |
| `contracts/stellar`       | The `upto` settlement contract, its deployment records and reproducible build                      |
| `contracts/testing`       | Test contracts: the TEST6 token, a spending-limit policy, composition and `upto` adversarial tests |
| `examples`                | An SDK buyer and an MCP agent                                                                      |
| `tools/conformance`       | Conformance runs against a live facilitator, with recorded results                                 |
| `tools/search-eval`       | Search evaluation dataset, harness and CI gate                                                     |

## Licence

[Apache-2.0](LICENSE). `pnpm license:gate` fails the build if any production dependency is not permissively
licensed; see the [dependency licence report](docs/dependency-licenses.md).
