---
title: Operations
description: Keys and custody, sponsor protection, channel accounts, metering, recovery and release controls.
---

How to run Rail402 safely: which keys exist and what they can do, how to rotate them, what limits
protect the sponsor, how callers are authenticated and metered, and how state survives failures.
Configuration variables are described in [configuration.md](configuration.md).

## Keys and custody

Rail402 holds one secret per network: the **sponsor** seed (`TESTNET_SPONSOR_SECRET`,
`PUBNET_SPONSOR_SECRET`). Give it to the service through the platform's secret store. It never
belongs in the repository, the image or a log line. As a second line of defence the logger redacts
`sponsorSecret`, `secret`, `envelopeXdr` and `authorization` at the top level of a log line or one
level down, a nested `transaction` (a signed envelope) and request `authorization` headers
(`apps/rail402/src/logger.ts`, tested in `apps/rail402/test/logger.test.ts`).

| Key              | What it does                                                                            | What it can never do                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Sponsor          | Pays every settlement fee through a fee bump; sponsors the reserves of channel accounts | Move a payer's funds: payments are authorized by the payer's own signature over the exact recipient and amount |
| Channel accounts | Act as the source account of settlement transactions, one settlement at a time each     | Hold value: they are created with a zero balance and their reserves are sponsored                              |

Channel keys are derived from the sponsor seed with HKDF-SHA256, per network and index
(`packages/facilitator/src/keys.ts`), so there is nothing extra to store or back up, and whoever
holds the sponsor seed holds the channels too.

Rail402 is non-custodial by construction. Verification refuses any payment in which a facilitator
account is the payer, a transaction or operation source, or a party to an authorization, and the
payer's signed authorization fixes the asset, recipient and amount; changing any of them after
signing fails signature verification (see [verification-rules.md](verification-rules.md)). The
worst case after a leaked sponsor seed is therefore the loss of the sponsor's own XLM, which is why
it should hold only a working balance.

## Protecting the sponsor

| Control           | Setting                             | Effect                                                                                       |
| ----------------- | ----------------------------------- | -------------------------------------------------------------------------------------------- |
| Fee ceiling       | `MAX_TX_FEE_STROOPS`                | Payments whose settlement would cost more are refused at verification.                       |
| Inclusion-fee bid | `INCLUSION_FEE_*`                   | Tracks recent network fees between a floor and a cap, never beyond the cap.                  |
| Reserve floor     | `SPONSOR_RESERVE_XLM`               | Settlements are refused below this balance (`settle_exact_stellar_sponsor_unavailable`).     |
| Hourly budget     | `MAX_SPONSOR_SPEND_XLM_PER_HOUR`    | Settlements are refused once this much fee was committed in the last hour, across replicas.  |
| Readiness         | `MIN_SPONSOR_BALANCE_XLM`           | `/ready` fails below this balance, so a load balancer can stop routing to the instance.      |
| Rate limits       | `RATE_LIMIT_PER_MINUTE`             | Requests per client address per minute, shared by all replicas with Postgres.                |
| API keys          | `REQUIRE_API_KEY`, `API_KEY_SHA256` | Restrict `/verify` and `/settle` to known callers; required to be set explicitly for pubnet. |

Alert on `rail402_sponsor_balance_stroops` approaching the readiness floor,
`rail402_settlements_total` failures by `reason`, `rail402_channels_in_use` equal to
`rail402_channels_total` (every channel busy), and `rail402_background_errors_total`.

## Health, readiness and metrics

These endpoints are never rate-limited and need no key.

- `GET /health` answers `200` with `{"status":"ok","version":"…"}` while the process is up. The image's
  Docker `HEALTHCHECK` uses it.
- `GET /ready` answers `200` when every check passes and `503` otherwise, with the checks in the body:
  `database` (Postgres only), and per network `<network>:rpc`, `<network>:sponsor` (balance at least
  `MIN_SPONSOR_BALANCE_XLM`) and `<network>:channels` (every channel account exists), plus `search` (the
  first search index is built) when the Bazaar is enabled. Route load balancers and deploy health checks
  here.
- `GET /metrics` serves Prometheus metrics:

| Metric                                  | Labels                         | Meaning                                                      |
| --------------------------------------- | ------------------------------ | ------------------------------------------------------------ |
| `rail402_verifications_total`           | `network`, `outcome`, `reason` | Verifications; `reason` is the `invalidReason` code          |
| `rail402_settlements_total`             | `network`, `outcome`, `reason` | Settlements: `success`, `failure` or `pending`               |
| `rail402_http_request_duration_seconds` | `method`, `route`, `status`    | Request latency histogram                                    |
| `rail402_sponsor_balance_stroops`       | `network`                      | Sponsor XLM balance                                          |
| `rail402_channels_in_use`               | `network`                      | Channel accounts leased by a settlement                      |
| `rail402_channels_total`                | `network`                      | Configured channel accounts                                  |
| `rail402_settlements_reconciled_total`  |                                | Pending settlements finished by the reconciler               |
| `rail402_background_errors_total`       | `task`                         | Failures of reconciliation, polling, origin checks, indexing |
| `rail402_catalog_outcomes_total`        | `phase`, `status`, `code`      | Bazaar outcomes reported in `EXTENSION-RESPONSES`            |
| `rail402_rate_limited_total`            |                                | Requests refused by the rate limiter                         |

Node.js process metrics are exported with the prefix `rail402_process_`.

## Channel accounts

At startup on testnet, missing channel accounts are created automatically. On pubnet
(`PUBNET_AUTO_PROVISION_CHANNELS=false` by default) an operator creates them explicitly, so the
sponsor never commits reserves without a decision. Run with the service's environment:

```sh
node apps/rail402/dist/channels.js status    --network stellar:pubnet
node apps/rail402/dist/channels.js provision --network stellar:pubnet
node apps/rail402/dist/channels.js retire    --network stellar:pubnet
```

These paths need `pnpm build` in a source checkout. In the container image the files are under
`/app/dist/`, for example `docker compose --profile service exec rail402 node dist/channels.js status`.
Each command prints one JSON line per configured network; `--network` limits it to one.

`status` also reports unfinished settlements and leased channels from Postgres. `retire` merges every
channel back into the sponsor, which returns their reserves; it refuses while any settlement on that
network is unfinished or any channel is leased. With `STORE=memory` there is no durable state to check,
so `retire` requires `--force` and must only run with the service stopped.

## Rotating the sponsor key

Planned rotation, for example yearly or when someone with access leaves:

1. Create and fund the new sponsor account.
2. Stop the service. On shutdown it lets in-flight settlements finish and reconciles once more.
3. Run `channels status` with the **old** secret: it must show no unfinished settlements and no
   leased channels. If a settlement is still pending, start the service again until it reconciles.
4. Run `channels retire` with the old secret. Use `--count` if `CHANNEL_COUNT` was ever higher.
5. Move the old sponsor's remaining XLM to the new sponsor (or merge the old account into it).
6. Set the new secret, run `channels provision` on pubnet, and start the service.

Settlement records are keyed by the payer's authorization, not by the sponsor, so replay protection
and idempotency carry across the rotation.

If the seed is suspected to be compromised, do the same steps immediately, but move the old
sponsor's balance first (step 5 before step 3), because whoever holds the seed can spend it. Payer
funds are not at risk.

To change `CHANNEL_COUNT`: raising it only needs a restart (testnet) or `channels provision`
(pubnet). To lower it, retire with the old count, then provision with the new one.

## Access and metering

Testnet is free and needs no key. For pubnet the operator chooses the business model; Rail402
supplies the mechanisms and hard-wires none of them:

- **Authentication.** Callers send `Authorization: Bearer <key>` or `X-API-Key`. The service
  stores only SHA-256 digests of accepted keys (`API_KEY_SHA256`), so the configuration does not
  leak usable keys. `REQUIRE_API_KEY` is per network.
- **Metering.** Every `/verify` and `/settle` that reaches the facilitator is counted per caller,
  day, network, operation, outcome and asset, with the settled volume. Requests refused before that
  (transport errors, `invalid_network`, `unsupported_scheme`, HTTP 401) and requests answered with
  HTTP 500 are not counted. Callers with a key read their own usage at `GET /usage`. With Postgres
  the counts are shared by every replica.
- **Service fee.** `SERVICE_FEE_PER_SETTLEMENT_USD` (default `0`) accrues a per-settlement fee in
  the metering records for billing off-chain. Nothing is charged on-chain and no extra transaction
  is added to the payment path.

## State, backups and recovery

Everything durable lives in Postgres: the settlement ledger (claims, recorded envelopes, outcomes),
channel leases, the Bazaar catalog and its version history, rate-limit windows and usage. The
service itself is stateless, so any number of replicas can run against one database.

- Use a managed Postgres with point-in-time recovery. A restored database is safe: settlements
  recorded as submitted are finished by the reconciler from their recorded bytes and the chain,
  and a payment already on-chain can never be submitted again because its authorization nonce is
  spent.
- A crash at any point is recovered by the next start: claims without an envelope expire and the
  payment can be retried, and recorded envelopes are reconciled (see "Settlement" in
  [verification-rules.md](verification-rules.md)).
- `STORE=memory` is for local development and conformance runs only: nothing survives a restart,
  and only one replica is safe.

## Release controls

CI (`.github/workflows/ci.yml`) runs on every push to `main` and on every pull request: formatting,
lint, type checking, unit tests, the licence gate with a current
[dependency report](dependency-licenses.md), integration tests against Postgres and a local Stellar
network, and a build of the container image. CI also runs the search evaluation gate
(`pnpm eval:check`: nDCG@10 and Recall@20 may not drop more than 0.02 below the tagged baseline,
hybrid must match or beat BM25, zero filter violations). The conformance evidence, the
canonical-client run and the upstream e2e run, is reproducible with the commands in
`tools/conformance`.
