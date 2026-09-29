---
title: Configuration
description: Every environment variable the Rail402 service reads, with defaults and validation rules.
---

Rail402 reads its configuration from environment variables once, at startup. Every value is
validated: a missing credential, a malformed value or an unsafe mainnet setting stops the process
with exit code 78 and a message naming the variable. Secrets are never echoed. An empty value is
treated as unset, and booleans are the literal strings `true` or `false`.

## Service

| Variable                | Default           | Meaning                                                                                    |
| ----------------------- | ----------------- | ------------------------------------------------------------------------------------------ |
| `PORT`                  | `8080`            | HTTP port (1–65535).                                                                       |
| `HOST`                  | `0.0.0.0`         | Bind address.                                                                              |
| `LOG_LEVEL`             | `info`            | `fatal`, `error`, `warn`, `info`, `debug` or `trace`. Logs are JSON on stdout.             |
| `STORE`                 | `postgres`        | `postgres` (durable, any number of replicas) or `memory` (one process, not durable).       |
| `DATABASE_URL`          | —                 | Required with `STORE=postgres`. Migrations run automatically at startup.                   |
| `NETWORKS`              | `stellar:testnet` | Comma-separated CAIP-2 networks to serve: `stellar:testnet`, `stellar:pubnet`.             |
| `BODY_LIMIT_BYTES`      | `131072`          | Maximum request body (1024–1048576).                                                       |
| `RATE_LIMIT_PER_MINUTE` | `600`             | Requests per minute per client IP, shared by all replicas with Postgres. `0` disables.     |
| `TRUSTED_PROXY_HOPS`    | `0`               | Reverse proxies whose `X-Forwarded-For` is trusted for the client IP (0–10; Railway: `1`). |
| `API_KEY_SHA256`        | —                 | Comma-separated SHA-256 hex digests of accepted API keys (see below).                      |
| `SHUTDOWN_GRACE_MS`     | `30000`           | Time allowed for in-flight settlements to finish on SIGTERM (0–600000).                    |
| `RECONCILE_INTERVAL_MS` | `5000`            | How often pending settlements are re-checked on the network (1000–600000).                 |
| `RAIL402_VERSION`       | `dev`             | The version `/health` reports. The image sets it from the build argument of that name.     |

API keys are sent as `Authorization: Bearer <key>` or `X-API-Key: <key>`. Compute a key's digest with
`echo -n "$KEY" | sha256sum | cut -d' ' -f1`.

The rate limit applies to every endpoint except `/health`, `/ready` and `/metrics`. A limited request
gets HTTP 429 with a `Retry-After` header. Without `TRUSTED_PROXY_HOPS`, the client address is the TCP
peer; behind a proxy, set it to the number of proxies so each real client gets its own limit.

| Variable                         | Default | Meaning                                                                                        |
| -------------------------------- | ------- | ---------------------------------------------------------------------------------------------- |
| `SERVICE_FEE_PER_SETTLEMENT_USD` | `0`     | Price per successful settlement for API-key holders, accrued in metering and billed off-chain. |

**Metering.** Every `/verify` and `/settle` that reaches the facilitator is counted per caller
(`key:<hash prefix>` for API-key holders, `public` otherwise), per day, network, operation, outcome and
asset, with the settled volume. Not metered: transport rejections (HTTP 400, 413, 415 and 429),
`invalid_network` and `unsupported_scheme` refusals, requests refused with HTTP 401 because a required
API key is missing or unknown, and requests the service answers with HTTP 500. Key holders read their
own usage and accrued service fee at `GET /usage`. With Postgres, rate limits and metering are shared by
every replica.

## Per network

Variables are prefixed `TESTNET_` or `PUBNET_`, for example `TESTNET_RPC_URL`. Only the networks listed
in `NETWORKS` are read.

| Variable                         | Default (testnet)              | Meaning                                                                                        |
| -------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------- |
| `RPC_URL`                        | —                              | Stellar RPC endpoint. Pubnet requires `https`.                                                 |
| `SPONSOR_SECRET`                 | —                              | Secret seed (`S…`) of the fee sponsor. Channel accounts are derived from it. One per network.  |
| `CHANNEL_COUNT`                  | `8`                            | Channel accounts (1–1000): the number of settlements that can be in flight at once.            |
| `ASSETS`                         | Circle USDC                    | `CONTRACT:SYMBOL:DECIMALS[:MIN:MAX]`, comma-separated; amounts in base units.                  |
| `MAX_TX_FEE_STROOPS`             | `300000`                       | Ceiling on the simulation-derived settlement fee.                                              |
| `INCLUSION_FEE_STROOPS`          | `100`                          | Lowest inclusion-fee bid above the resource fee (at least 100), and the bid if fee stats fail. |
| `INCLUSION_FEE_CAP_STROOPS`      | `10000`                        | Highest inclusion-fee bid, whatever the network reports.                                       |
| `INCLUSION_FEE_PERCENTILE`       | `p90`                          | Point of the recent Soroban inclusion-fee distribution (`getFeeStats`) to bid.                 |
| `EXPIRATION_MARGIN_LEDGERS`      | `1`                            | Ledgers an authorization must remain valid for, so settlement cannot land after it expires.    |
| `TIMEOUT_MIN_SECONDS`            | `10`                           | Smallest accepted `maxTimeoutSeconds`.                                                         |
| `TIMEOUT_MAX_SECONDS`            | `300`                          | Largest accepted `maxTimeoutSeconds`.                                                          |
| `MIN_SPONSOR_BALANCE_XLM`        | `25`                           | `/ready` fails below this sponsor balance.                                                     |
| `SPONSOR_RESERVE_XLM`            | `5`                            | Settlements are refused while the sponsor holds less than this.                                |
| `MAX_SPONSOR_SPEND_XLM_PER_HOUR` | —                              | Optional budget: settlements are refused once this much fee was committed in the last hour.    |
| `REQUIRE_API_KEY`                | `false`                        | Require an API key for `/verify` and `/settle`. **Must be set explicitly for pubnet.**         |
| `AUTO_PROVISION_CHANNELS`        | `true` testnet, `false` pubnet | Create missing channel accounts at startup; the sponsor pays their reserves.                   |

The default asset is Circle USDC on each network: `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`
on testnet and `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` on pubnet, both with 7
decimals. `INCLUSION_FEE_PERCENTILE` is one of `p50`, `p70`, `p80`, `p90`, `p95` or `p99`.

Validation rules beyond the formats:

- `NETWORKS` may not list a network twice, and each network needs its own sponsor account.
- `PUBNET_RPC_URL` must use `https`, and `PUBNET_REQUIRE_API_KEY` must be set to `true` or `false`
  whenever pubnet is enabled: mainnet access control is always an explicit decision.
- `REQUIRE_API_KEY=true` needs at least one digest in `API_KEY_SHA256`.
- `TIMEOUT_MIN_SECONDS` may not exceed `TIMEOUT_MAX_SECONDS`, `INCLUSION_FEE_STROOPS` may not exceed
  `MAX_TX_FEE_STROOPS`, and `INCLUSION_FEE_CAP_STROOPS` must lie between the two.
- `ASSETS` entries need a `C…` contract address, a symbol of 1 to 12 letters or digits, decimals of 0
  to 38, and a minimum no larger than the maximum; no contract may be listed twice.

## Bazaar and search

| Variable                                     | Default   | Meaning                                                                                                                                                  |
| -------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BAZAAR_ENABLED`                             | `true`    | Catalog settled resources and serve `/discovery/*`. With `false`, neither exists.                                                                        |
| `BAZAAR_MAX_NEW_LISTINGS_PER_OWNER_PER_HOUR` | `20`      | New listings one `payTo` may create per hour (1–100000). Listings the origin check withdrew do not count.                                                |
| `BAZAAR_MAX_NEW_LISTINGS_PER_PAYER_PER_HOUR` | `10`      | New listings the settlements of one payer may create per hour (1–100000).                                                                                |
| `BAZAAR_MAX_NEW_LISTINGS_PER_HOUR`           | `1000`    | New listings the whole catalog accepts per hour (1–10000000).                                                                                            |
| `ORIGIN_CHECK_INTERVAL_MS`                   | `5000`    | How often due origin checks run (1000–3600000).                                                                                                          |
| `DISCOVERY_ALLOW_LOOPBACK`                   | `false`   | Catalog and fetch loopback resources. For local conformance runs only; refused together with pubnet.                                                     |
| `SEARCH_EMBEDDINGS`                          | `true`    | Semantic search with the local embedding model. With `false`, search is lexical-only and ranked (not filter-only) results report `partialResults: true`. |
| `SEARCH_MODEL_DIR`                           | `.models` | Directory holding the pinned model, relative to the working directory. The image sets `/app/models`.                                                     |
| `SEARCH_MODEL_DOWNLOAD`                      | `false`   | Download the pinned model at startup when it is missing (development convenience).                                                                       |
| `SEARCH_CURSOR_SECRET`                       | random    | At least 32 bytes as hex. Shared by every replica so search cursors survive restarts and load balancing.                                                 |
| `SEARCH_SIMILARITY_FLOOR`                    | `0.3`     | Minimum cosine similarity for a semantic match (-1 to 1).                                                                                                |

With embeddings on, the service refuses to start if the model files are missing or their SHA-256 hashes
do not match the pinned manifest. `pnpm models:fetch` downloads and verifies them into `.models/`; the
container image already contains them.

## Accounts

The **sponsor** pays every settlement fee through a fee-bump transaction and the base reserve of
every channel account. It never holds or sends payment funds. Fund it with XLM only.

**Channel accounts** are the source accounts of settlement transactions, one per in-flight
settlement, so concurrent settlements never compete for a sequence number. They are derived from
the sponsor secret (HKDF-SHA256), hold a zero balance, and need no separate secret or backup.

## Examples

A testnet instance with the bundled Postgres needs only:

```sh
DATABASE_URL=postgres://rail402:rail402@localhost:5432/rail402
TESTNET_RPC_URL=https://soroban-testnet.stellar.org
TESTNET_SPONSOR_SECRET=S...
SEARCH_CURSOR_SECRET=...        # openssl rand -hex 32
```

A pubnet-only instance that requires API keys:

```sh
DATABASE_URL=postgres://...
NETWORKS=stellar:pubnet
PUBNET_RPC_URL=https://...      # your RPC provider
PUBNET_SPONSOR_SECRET=S...
PUBNET_REQUIRE_API_KEY=true
API_KEY_SHA256=...              # echo -n "$KEY" | sha256sum | cut -d' ' -f1
SEARCH_CURSOR_SECRET=...
TRUSTED_PROXY_HOPS=1
```

On pubnet, channel accounts are not created at startup: run `channels provision` first (see
[operations.md](operations.md#channel-accounts)). The validation rules above are checked for pubnet at
startup, but pubnet itself has not been exercised end to end. The hosted Rail402 service serves testnet
only.
