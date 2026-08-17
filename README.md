# Rail402

x402 payments infrastructure for Stellar: a facilitator, a discovery layer (Bazaar), an MCP server for agents, a payments explorer, and the SDKs to build on all of it.

Live facilitator (testnet): https://facilitator.rail402.dev

## What's here

| Directory | What it is |
| --- | --- |
| `apps/facilitator` | x402 verify / settle / supported service for `stellar:testnet`, with sponsored fees and the Bazaar co-deployed |
| `apps/bazaar` | catalog, automatic cataloging at verify/settle, `/discovery/resources` and `/discovery/search` (hybrid BM25 + embedding ranking) |
| `apps/mcp-discovery` | MCP server exposing search and a spend-capped paid-call tool |
| `apps/explorer` | indexes and classifies x402 settlements from the Stellar ledger, serves a public read API |
| `apps/cli` | command-line wallet and agent tool (`rail402`) |
| `apps/playground` | interactive demo of the discover → pay loop |
| `apps/docs` | documentation site |
| `packages/*` | error registry, seller/agent helpers, the `upto` scheme, conformance harness, canaries, umbrella SDK |
| `contracts/` | Soroban contracts: `upto` settlement and an agent spending policy |
| `examples/` | end-to-end integrations: paid API + agent, MCP tool seller, smart-account buyer |

Payment schemes: `exact` and `upto` (authorize a ceiling, settle actual usage — backed by a small Soroban contract). Buyers can be classic keypairs or smart accounts; network fees are sponsored so buyers need no XLM.

## Run it

```bash
pnpm install
pnpm --filter @rail402.dev/facilitator dev   # needs a funded testnet secret, see apps/facilitator/.env.example
```

Or with Docker (facilitator + Bazaar in one image):

```bash
docker build -t rail402 . && docker run -p 8080:8080 --env-file .env rail402
```

## Checks

```bash
pnpm verify   # lint + typecheck + tests + dependency license gate
pnpm test
```

Settlement evidence (transaction hashes, conformance runs, rejection audits) is generated into `docs/status/`.

## Packages

Published under the `@rail402.dev` scope on npm.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
