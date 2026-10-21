---
title: Configuration
description: Every environment variable the Rail402 service reads, with defaults and validation rules.
---

Rail402 reads its configuration from environment variables once, at startup. Every value is
validated: a missing credential, a malformed value or an unsafe mainnet setting stops the process
with exit code 78 and a message naming the variable. Secrets are never echoed. An empty value is
treated as unset, and booleans are the literal strings `true` or `false`.

The Playground server has settings of its own, listed in
[Run your own Playground](/playground/self-host#configuration).

## Service

| Variable                            | Default           | Meaning                                                                                                                                                                                                                                                          |
| ----------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                              | `8080`            | HTTP port (1–65535).                                                                                                                                                                                                                                             |
| `HOST`                              | `0.0.0.0`         | Bind address.                                                                                                                                                                                                                                                    |
| `LOG_LEVEL`                         | `info`            | `fatal`, `error`, `warn`, `info`, `debug` or `trace`. Logs are JSON on stdout.                                                                                                                                                                                   |
| `STORE`                             | `postgres`        | `postgres` (durable, any number of replicas) or `memory` (one process, not durable).                                                                                                                                                                             |
| `DATABASE_URL`                      | —                 | Required with `STORE=postgres`. Migrations run automatically at startup.                                                                                                                                                                                         |
| `NETWORKS`                          | `stellar:testnet` | Comma-separated CAIP-2 networks to serve: `stellar:testnet`, `stellar:pubnet`.                                                                                                                                                                                   |
| `BODY_LIMIT_BYTES`                  | `131072`          | Maximum request body (1024–1048576).                                                                                                                                                                                                                             |
| `RATE_LIMIT_PER_MINUTE`             | `600`             | Requests per minute per client IP (an IPv6 client by its /64), shared by all replicas with Postgres. `0` disables.                                                                                                                                               |
| `TRUSTED_PROXY_HOPS`                | `0`               | Reverse proxies whose `X-Forwarded-For` is trusted for the client IP (0–10; Railway: `1`).                                                                                                                                                                       |
| `API_KEY_SHA256`                    | —                 | Comma-separated SHA-256 hex digests of accepted API keys (see below).                                                                                                                                                                                            |
| `SHUTDOWN_GRACE_MS`                 | `30000`           | Time allowed for in-flight settlements to finish on SIGTERM (0–600000).                                                                                                                                                                                          |
| `RECONCILE_INTERVAL_MS`             | `5000`            | How often pending settlements are re-checked on the network (1000–600000).                                                                                                                                                                                       |
| `SETTLE_CHANNEL_WAIT_MS`            | `5000`            | How long a settlement waits for a free channel account before `settle_exact_stellar_channel_unavailable` (0–120000).                                                                                                                                             |
| `SETTLE_CONFIRM_TIMEOUT_MS`         | `25000`           | How long `/settle` waits for confirmation after broadcast before answering `settlement_pending` (0–300000).                                                                                                                                                      |
| `SETTLE_RECONCILE_IDLE_MS`          | confirm + 5000    | How long after a settlement's envelope was recorded it is left to the request confirming it, on any replica, before the reconciler drives it (0–600000). Unset: `SETTLE_CONFIRM_TIMEOUT_MS` plus 5000. `0` suits a single replica.                               |
| `RECONCILE_THIRD_PARTY_SETTLEMENTS` | `true`            | When a settlement fails on-chain because another transaction consumed the payer's authorization first, look that transaction up; if it carried the authorization exactly as signed and moved the payment, answer success with its hash (see verification rules). |
| `RAIL402_VERSION`                   | `dev`             | The version `/health` reports. The image sets it from the build argument of that name.                                                                                                                                                                           |
| `METRICS_TOKEN_SHA256`              | —                 | SHA-256 hex digest of a bearer token `/metrics` then requires (`Authorization: Bearer <token>`). Unset, `/metrics` is public. Recommended for pubnet.                                                                                                            |
| `CONTRACT_TTL_POLL_MS`              | `300000`          | How often the TTL of every watched contract is read (10000–86400000).                                                                                                                                                                                            |
| `CONTRACT_TTL_WARN_LEDGERS`         | `518400`          | A watched contract archived within this many ledgers (about 30 days at 5 s) is a `/health` warning.                                                                                                                                                              |
| `CONTRACT_TTL_CRITICAL_LEDGERS`     | `120960`          | Within this many ledgers (about 7 days) `/health` reports `degraded`. At most `CONTRACT_TTL_WARN_LEDGERS`.                                                                                                                                                       |

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
asset, with the settled volume. A `/settle` answered from an earlier settlement of the same payment is
metered with the outcome `repeat` and no volume, so it never accrues a second service fee. Not metered: transport rejections (HTTP 400, 413, 415 and 429),
`invalid_network` and `unsupported_scheme` refusals, requests refused with HTTP 401 because a required
API key is missing or unknown, and requests the service answers with HTTP 500. Key holders read their
own usage and accrued service fee at `GET /usage`. With Postgres, rate limits and metering are shared by
every replica.

## Per network

Variables are prefixed `TESTNET_` or `PUBNET_`, for example `TESTNET_RPC_URL`. Only the networks listed
in `NETWORKS` are read.

| Variable                         | Default (testnet)              | Meaning                                                                                                                                                               |
| -------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RPC_URL`                        | —                              | Stellar RPC endpoint. Pubnet requires `https`.                                                                                                                        |
| `SPONSOR_SECRET`                 | —                              | Secret seed (`S…`) of the fee sponsor. Channel accounts are derived from it. One per network.                                                                         |
| `CHANNEL_COUNT`                  | `8`                            | Channel accounts (1–1000): the number of settlements that can be in flight at once.                                                                                   |
| `ASSETS`                         | Circle USDC                    | `CONTRACT:SYMBOL:DECIMALS[:MIN:MAX]`, comma-separated; amounts in base units.                                                                                         |
| `MAX_TX_FEE_STROOPS`             | `1000000`, pubnet `300000`     | Ceiling on the simulated `exact` settlement fee. See [fee ceilings](#fee-ceilings).                                                                                   |
| `INCLUSION_FEE_STROOPS`          | `100`                          | Lowest inclusion-fee bid above the resource fee (at least 100), and the bid if fee stats fail.                                                                        |
| `INCLUSION_FEE_CAP_STROOPS`      | `10000`                        | Highest inclusion-fee bid, whatever the network reports.                                                                                                              |
| `INCLUSION_FEE_PERCENTILE`       | `p90`                          | Point of the recent Soroban inclusion-fee distribution (`getFeeStats`) to bid.                                                                                        |
| `EXPIRATION_MARGIN_LEDGERS`      | `1`                            | Ledgers (1–100) an authorization must remain valid for, so settlement cannot land after it expires.                                                                   |
| `TIMEOUT_MIN_SECONDS`            | `10`                           | Smallest accepted `maxTimeoutSeconds`.                                                                                                                                |
| `TIMEOUT_MAX_SECONDS`            | `300`                          | Largest accepted `maxTimeoutSeconds`.                                                                                                                                 |
| `MIN_SPONSOR_BALANCE_XLM`        | `25`                           | `/ready` fails below this sponsor balance.                                                                                                                            |
| `SPONSOR_RESERVE_XLM`            | `5`                            | Settlements are refused while the sponsor holds less than this.                                                                                                       |
| `MAX_SPONSOR_SPEND_XLM_PER_HOUR` | —                              | Budget: settlements are refused once this much fee was committed in the last hour. **Required for pubnet.**                                                           |
| `REQUIRE_API_KEY`                | `false`                        | Require an API key for `/verify` and `/settle`. **Must be set explicitly for pubnet.**                                                                                |
| `AUTO_PROVISION_CHANNELS`        | `true` testnet, `false` pubnet | Create missing channel accounts at startup; the sponsor pays their reserves.                                                                                          |
| `TTL_CONTRACTS`                  | —                              | More contracts whose TTL is watched, as `ALIAS:CONTRACT`, comma-separated. Every `ASSETS` contract is watched under its symbol.                                       |
| `UPTO_ENABLED`                   | `true` testnet, `false` pubnet | Serve the `upto` scheme on this network.                                                                                                                              |
| `UPTO_CONTRACT`                  | canonical testnet contract     | The `upto` settlement contract (`C…`). Testnet defaults to `CBTVKCHLSGQ3WSV3NKSU6FZR4FZMC6ENMDMXUS5XQ66HYVUUHYE3TU7U`; pubnet requires it.                            |
| `UPTO_WASM_HASH`                 | canonical WASM hash            | Hex SHA-256 of the contract's WASM. Required with a non-canonical contract and on pubnet. Startup fails if the live contract runs other code.                         |
| `UPTO_ZERO_SETTLEMENT`           | `onchain`, pubnet `offchain`   | A zero-amount settlement: `onchain` submits `settle(…, 0)` and consumes the authorization on-chain; `offchain` records it as used. `offchain` needs `STORE=postgres`. |
| `UPTO_MAX_TX_FEE_STROOPS`        | `5000000`, pubnet `500000`     | Ceiling on the simulated `upto` settlement fee. See [fee ceilings](#fee-ceilings).                                                                                    |
| `UPTO_LEDGER_SECONDS`            | from the RPC                   | Seconds per ledger for the `upto` expiration window. By default the average over the ledgers the network's RPC retains, read at most once a minute.                   |
| `UPTO_TTL_KEEPER`                | `true`                         | Extend (and, where allowed, restore) the settlement contract in the background.                                                                                       |
| `UPTO_TTL_EXTEND_BELOW_LEDGERS`  | `518400`                       | Extend once the contract's instance or code entry has fewer ledgers left (about 30 days at 5 s ledgers).                                                              |
| `UPTO_TTL_EXTEND_TO_LEDGERS`     | network maximum − 17280        | Ledgers past the current one an extension reaches.                                                                                                                    |
| `UPTO_TTL_AUTO_RESTORE`          | `true` testnet, `false` pubnet | Restore an archived contract without an operator (the sponsor pays).                                                                                                  |
| `UPTO_TTL_MAX_FEE_STROOPS`       | `500000000`                    | Ceiling on the fee of one extension or restoration. Extending the code entry by the network maximum costs about 32 XLM on testnet.                                    |

The default asset is Circle USDC on each network: `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`
on testnet and `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` on pubnet, both with 7
decimals. `INCLUSION_FEE_PERCENTILE` is one of `p50`, `p70`, `p80`, `p90`, `p95` or `p99`.

Validation rules beyond the formats:

- `NETWORKS` may not list a network twice, and each network needs its own sponsor account.
- `PUBNET_RPC_URL` must use `https`, `PUBNET_REQUIRE_API_KEY` must be set to `true` or `false`, and
  `PUBNET_MAX_SPONSOR_SPEND_XLM_PER_HOUR` must be set whenever pubnet is enabled: mainnet access control
  and what the fee sponsor may spend are always explicit decisions.
- `REQUIRE_API_KEY=true` needs at least one digest in `API_KEY_SHA256`.
- `TIMEOUT_MIN_SECONDS` may not exceed `TIMEOUT_MAX_SECONDS`, `INCLUSION_FEE_STROOPS` may not exceed
  `MAX_TX_FEE_STROOPS`, and `INCLUSION_FEE_CAP_STROOPS` must lie between the two.
- With `upto` on, `TIMEOUT_MAX_SECONDS` must be at least `(EXPIRATION_MARGIN_LEDGERS + 1) × 5`: `upto`
  refuses a shorter `maxTimeoutSeconds`, whose authorization would expire before it can be settled.
- `ASSETS` entries need a `C…` contract address, a symbol of 1 to 12 letters or digits, decimals of 0
  to 38, and a minimum no larger than the maximum; no contract may be listed twice.
- At startup every `ASSETS` contract is read from the network: a token whose `decimals()` differs from
  the configured decimals, or a contract without a `decimals()` function, stops the service with exit
  code 78 and `asset_decimals_mismatch` or `asset_not_a_token` in the message. A contract that is not
  deployed yet, an RPC that does not answer, or a `decimals()` read that fails in any other way keeps
  `/ready` failing until the check passes. See
  [Accepted assets](/facilitator/assets).
- `PUBNET_UPTO_ENABLED=true` needs `PUBNET_UPTO_CONTRACT` and `PUBNET_UPTO_WASM_HASH`; a non-canonical
  `UPTO_CONTRACT` needs `UPTO_WASM_HASH`, and a hash given for the canonical contract must be its hash.
- `INCLUSION_FEE_STROOPS` may not exceed `UPTO_MAX_TX_FEE_STROOPS`, and `UPTO_TTL_EXTEND_TO_LEDGERS`
  must exceed `UPTO_TTL_EXTEND_BELOW_LEDGERS`.
- `UPTO_ZERO_SETTLEMENT=offchain` (the pubnet default) needs `STORE=postgres`: an off-chain zero exists
  only in the settlement ledger, which must survive restarts and be shared by every replica, or the
  same authorization could later be settled on-chain for more.
- The `upto` contract is watched under the TTL alias `upto`, so no asset symbol or `TTL_CONTRACTS`
  alias may be `upto`, and it may be neither an accepted asset nor listed in `TTL_CONTRACTS`.

## Fee ceilings

The sponsor pays every settlement fee, so each network has a ceiling on the fee a settlement may cost:
`MAX_TX_FEE_STROOPS` for `exact` and `UPTO_MAX_TX_FEE_STROOPS` for `upto`. Verification and settlement
compare the fee the simulation asks for (resource fee plus the inclusion bid; for `upto`, the bid counted twice,
for the settlement transaction and for its fee bump) with the ceiling and refuse a
payment above it before anything is signed, with `invalid_exact_stellar_payload_fee_exceeds_maximum` or
`invalid_upto_stellar_payload_fee_exceeds_maximum`.

Most payments cost far less than the ceilings. The costly ones are first payments, which create ledger state
and pay its rent: a recipient's first balance of a token, or a smart account's first record in its
spending-limit policy. Fees observed, in stroops: the private-network rows while running the integration tests,
the testnet rows in rehearsals of the conformance harnesses. They are single observations that no test asserts;
the fee of every transaction of a recorded run is on the [conformance evidence](/reference/conformance) page,
and it varies with network conditions:

| Payment                                                                        | Network         | Fee                                     |
| ------------------------------------------------------------------------------ | --------------- | --------------------------------------- |
| `exact`, USDC (Stellar Asset Contract), `G…` payer                             | private network | 88,864 charged                          |
| `upto` partial settlement, USDC, `G…` payer                                    | private network | 134,335 charged (173,008 simulated)     |
| `exact`, TEST6 (a custom SEP-41 token), the first payment of a payee or payer  | testnet         | 315,702 to 463,067 charged              |
| `upto`, OpenZeppelin smart account with a spending-limit policy, first payment | testnet         | 2,339,612 charged (2,692,602 simulated) |
| the same smart account's next `upto` payment                                   | testnet         | 184,655 charged (214,387 simulated)     |

Testnet sponsors are funded by Friendbot, so the testnet defaults (1,000,000 and 5,000,000) leave room for
every payment above. The pubnet defaults (300,000 and 500,000) cover the Stellar Asset Contract payments above
but refuse the costly first payments; raise them on pubnet only for the tokens and payers you choose to
serve, since the sponsor pays every stroop. `MAX_SPONSOR_SPEND_XLM_PER_HOUR` bounds the total.

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

The **`upto` settlement authority** is the account every `upto` payment names in the terms the payer
signs (`extra.facilitatorAddress` in `/supported`). It is the operation source of each `upto`
settlement, and only it can choose the amount settled, up to the signed cap. It is derived from the
sponsor secret too and holds a zero balance with its reserve sponsored. A service that serves `upto`
creates it at startup when it is missing, whatever `AUTO_PROVISION_CHANNELS` says, and replicas starting
together take turns so only one creates it. If it cannot be created yet (for example, the sponsor is not
funded), the service still starts: `exact` works, `upto` payments are refused with
`settle_upto_stellar_authority_unavailable`, `/health` reports `upto_authority_missing`, and every poll
tries again. `upto authority provision` creates it by hand.

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
PUBNET_MAX_SPONSOR_SPEND_XLM_PER_HOUR=50
API_KEY_SHA256=...              # echo -n "$KEY" | sha256sum | cut -d' ' -f1
SEARCH_CURSOR_SECRET=...
TRUSTED_PROXY_HOPS=1
```

On pubnet, channel accounts are not created at startup: run `channels provision` first (see
[Operations](/operations#channel-accounts)). The validation rules above are checked for pubnet at
startup, but pubnet itself has not been exercised end to end. The hosted Rail402 service serves testnet
only.
