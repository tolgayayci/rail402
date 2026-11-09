---
title: Configuration
description: Every environment variable the Rail402 service reads, with defaults and validation rules.
---

Rail402 reads its configuration from environment variables once, at startup. Every value is
validated: a missing credential, a malformed value or an unsafe mainnet setting stops the process
with exit code 78 and one line on stderr, `rail402: <code>: <message>`, naming the variable (see
[Startup checks](#startup-checks)). Secrets are never echoed. An empty value is
treated as unset, and booleans are the literal strings `true` or `false`.

The Playground server has settings of its own, listed in
[Run your own Playground](/playground/self-host#configuration).

## Service

| Variable                            | Default           | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                              | `8080`            | HTTP port (1–65535).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `HOST`                              | `0.0.0.0`         | Bind address.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `LOG_LEVEL`                         | `info`            | `fatal`, `error`, `warn`, `info`, `debug` or `trace`. Logs are JSON on stdout.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `STORE`                             | `postgres`        | `postgres` (durable, any number of replicas) or `memory` (one process, not durable).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `DATABASE_URL`                      | —                 | Required with `STORE=postgres`, or `DATABASE_URL_FILE`; with pubnet enabled only the file form. Migrations run automatically at startup.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `MIGRATE_ON_START`                  | `true`            | Apply pending migrations at startup. With `false` the service refuses to start while a migration is pending (`config_schema_outdated`); run `node dist/migrate.js` first.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `DATABASE_MIGRATION_URL`            | —                 | Connection for migrations, as the role that owns the schema, or `DATABASE_MIGRATION_URL_FILE`; with pubnet enabled only the file form, given to `node dist/migrate.js` and never to the service (`config_pubnet_migration_url_in_service`). Unset, migrations use `DATABASE_URL`. See [Database roles](/operations#database-roles).                                                                                                                                                                                                                                       |
| `DATABASE_ACQUIRE_TIMEOUT_MS`       | `5000`            | How long a query waits for a pooled database connection before it fails (100–60000). A saturated pool then refuses with a code instead of queueing requests; see [Serving per network](/operations#serving-per-network).                                                                                                                                                                                                                                                                                                                                                  |
| `NETWORKS`                          | `stellar:testnet` | Comma-separated CAIP-2 networks to serve: `stellar:testnet`, `stellar:pubnet`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `BODY_LIMIT_BYTES`                  | `131072`          | Maximum request body (1024–1048576).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `RESPONSE_WRITE_TIMEOUT_MS`         | `30000`           | How long a client has to take a ready response (1000–600000), from when it and every response before it on the connection are ready: answering, such as `/settle` waiting for confirmation, never counts, and pipelined responses share one deadline. Taken means handed to the operating system's socket buffer. Past it the connection is reset and every response it held released.                                                                                                                                                                                    |
| `MAX_PIPELINED_REQUESTS`            | `4`               | Requests one connection may have waiting for their answers to be sent (1–1000). A client that pipelines more has its connection reset, and the requests it already sent are not answered; a client that waits for each answer before asking again is never affected.                                                                                                                                                                                                                                                                                                      |
| `RATE_LIMIT_PER_MINUTE`             | `600`             | Requests per minute per client IP (an IPv6 client by its /64), shared by all replicas with Postgres; a key holder's `/verify` and `/settle` per key (below). `0` disables.                                                                                                                                                                                                                                                                                                                                                                                                |
| `TRUSTED_PROXY_HOPS`                | `0`               | Reverse proxies whose `X-Forwarded-For` is trusted for the client IP (0–10).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `PUBLIC_HOSTS`                      | —                 | Host-scoped views, `host=network` comma-separated (e.g. `testnet.example.com=stellar:testnet,mainnet.example.com=stellar:pubnet`). A request whose `Host` is listed sees only that network in `/supported` (its kinds and its own facilitator accounts), and `/verify` and `/settle` for another network answer `invalid_network` naming the host that serves it. Unlisted hosts, such as internal callers, see every network; `/ready`, `/health`, `/metrics`, `/usage` and discovery are the same on every host.                                                        |
| `API_KEY_SHA256`                    | —                 | Comma-separated SHA-256 hex digests of accepted API keys (see below).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `SHUTDOWN_GRACE_MS`                 | `30000`           | Time allowed for in-flight settlements to finish on SIGTERM (0–600000). Idle connections and requests whose headers or body are still arriving (none has been acted on) are dropped at once, answers close their connection, and a client gets at most 1 s more to take one: only handlers at work hold the shutdown.                                                                                                                                                                                                                                                     |
| `RECONCILE_INTERVAL_MS`             | `5000`            | How often pending settlements are re-checked on the network (1000–600000).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `SETTLE_CHANNEL_WAIT_MS`            | `5000`            | How long a settlement waits for a free channel account before `settle_exact_stellar_channel_unavailable` (0–120000).                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `SETTLE_CONFIRM_TIMEOUT_MS`         | `25000`           | How long `/settle` waits for confirmation after broadcast before answering `settlement_pending` (0–300000).                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `SETTLE_CHANNEL_QUARANTINE_MS`      | `60000`           | How long a channel account stays out of rotation after another transaction took its sequence number (`txBadSeq`), doubled for each further conflict in a row up to 16 times; when it ends, a channel whose account sequence number moved meanwhile is quarantined again (0–3600000).                                                                                                                                                                                                                                                                                      |
| `SETTLE_RECONCILE_IDLE_MS`          | confirm + 5000    | How long after a settlement's envelope was recorded it is left to the request confirming it, on any replica, before the reconciler drives it (0–600000). Unset: `SETTLE_CONFIRM_TIMEOUT_MS` plus 5000. `0` suits a single replica.                                                                                                                                                                                                                                                                                                                                        |
| `RECONCILE_THIRD_PARTY_SETTLEMENTS` | `true`            | When a settlement fails on-chain because another transaction consumed the payer's authorization first, look that transaction up; if it carried the authorization exactly as signed and moved the payment, answer success with its hash (see verification rules). For `exact`, a failure that leaves the authorization usable also waits until it expired unused, answering success when a copy lands meanwhile. `false` answers every `exact` on-chain failure at once, with no search and no wait; a refused or conflicting submission still waits on the payer's nonce. |
| `RAIL402_VERSION`                   | `dev`             | The version `/health` reports. The image sets it from the build argument of that name.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `METRICS_TOKEN_SHA256`              | —                 | SHA-256 hex digest of a bearer token `/metrics` then requires (`Authorization: Bearer <token>`). Unset, `/metrics` is public. Recommended for pubnet.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `METRICS_PRIVATE_TOKEN_SHA256`      | —                 | SHA-256 hex digest of the bearer token `/metrics/private` and `/health/private` require; unset, neither path exists. **Required with pubnet.** See [Operations](/operations#health-readiness-and-metrics).                                                                                                                                                                                                                                                                                                                                                                |
| `CONTRACT_TTL_POLL_MS`              | `300000`          | How often the TTL of every watched contract is read (10000–86400000).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `CONTRACT_TTL_WARN_LEDGERS`         | `518400`          | A watched contract archived within this many ledgers (about 30 days at 5 s) is a `/health` warning.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `CONTRACT_TTL_CRITICAL_LEDGERS`     | `120960`          | Within this many ledgers (about 7 days) `/health` reports `degraded`. At most `CONTRACT_TTL_WARN_LEDGERS`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

API keys are sent as `Authorization: Bearer <key>` or `X-API-Key: <key>` (both, with different keys,
is refused). See [Access keys](#access-keys) for `API_KEYS_FILE`; `API_KEY_SHA256` holds the SHA-256
digests of keys valid on every network (`echo -n "$KEY" | sha256sum | cut -d' ' -f1`) and is refused once
pubnet is enabled.

`RATE_LIMIT_PER_MINUTE` applies to every endpoint except `/health`, `/ready`, `/metrics` and the private
paths. A limited request gets HTTP 429 with a `Retry-After` header. Without `TRUSTED_PROXY_HOPS`, the
client address is the TCP peer; behind a proxy, set it to the number of proxies so each real client gets
its own limit. A `/verify` or `/settle` with a valid [access key](#access-keys) is limited per key instead
(on a host listed in `PUBLIC_HOSTS`, a key valid for that host's network), so keyless traffic from the
same address or IPv6 /64 never uses up a key holder's requests. A request for a network the key is not
valid for counts against its address's limit as well, like any keyless request. That limit is what the key may send a
minute on all its networks together (`requestsPerMinute`, else `KEY_DEFAULT_REQUESTS_PER_MINUTE`, on
each), and never less than `RATE_LIMIT_PER_MINUTE`. When the shared limiter (Postgres) cannot answer, each
process limits on its own.

| Variable                         | Default | Meaning                                                                                        |
| -------------------------------- | ------- | ---------------------------------------------------------------------------------------------- |
| `SERVICE_FEE_PER_SETTLEMENT_USD` | `0`     | Price per successful settlement for API-key holders, accrued in metering and billed off-chain. |

**Metering.** Every `/verify` and `/settle` that reaches the facilitator is counted per caller
(`key:<id>` for access-key holders, where a key from `API_KEY_SHA256` has the first 16 hex characters of
its digest as id, `public` otherwise), per day, network, operation, outcome and
asset, with the settled volume. A `/settle` answered from an earlier settlement of the same payment is
metered with the outcome `repeat` and no volume, so it never accrues a second service fee. Not metered: transport rejections (HTTP 400, 413, 415 and 429),
`invalid_network` and `unsupported_scheme` refusals, requests refused with HTTP 401 because a required
API key is missing or unknown, and requests the service answers with HTTP 500. With Postgres, rate limits
and metering are shared by every replica.

Each settlement also records its caller and the service fee priced when it was claimed, so a price
change never reprices history. Key holders read their usage at `GET /usage`: `subject`, `days` (31),
`usage` (the daily counts above) and `serviceFee` keep their meaning, with `serviceFee.accruedUsd` now the
sum of the prices recorded with each successful settlement Rail402 landed (`basis:
"per_settlement_recorded_price"`). The body adds `keyId`, `window` and, per network the key may use,
`settlements` (`succeeded`, volume `byAsset`, `sponsoredFeeStroops`: the fees the sponsor was charged for
the key's transactions whatever their outcome, `serviceFeeUsd`) and `limits` (`requestsPerMinute`,
`sponsorBudgetStroopsPerHour`, `sponsorCommitted1hStroops`, `expiresAt`). A failed settlement or a payment
another party's transaction landed accrues no service fee.

`node dist/usage.js export --from YYYY-MM-DD --to YYYY-MM-DD [--key <id>] [--format csv|json]` prints one
row per caller × network × day (settlements, volume per asset, sponsored fee, service fee) for billing
off-chain. It reads `DATABASE_URL` (or `DATABASE_URL_FILE`; only the file with pubnet) and changes nothing.

## Access keys

`API_KEYS_FILE` names a JSON file of access keys, each scoped to networks, with its own request limit,
hourly fee-sponsorship budget and expiry. It holds digests only, never a key:

```json
{
  "schemaVersion": 1,
  "keys": [
    {
      "id": "acme-prod-1",
      "sha256": "<sha256 of the full key, 64 lower-case hex>",
      "label": "Acme, production",
      "networks": ["stellar:pubnet"],
      "requestsPerMinute": 120,
      "sponsorBudgetXlmPerHour": "2",
      "expiresAt": "2027-04-30T00:00:00Z",
      "revoked": false,
      "createdAt": "2026-11-02T10:00:00Z"
    }
  ]
}
```

| Field                     | Rule                                                                                                                      |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `id`                      | 3 to 32 lower-case letters, digits or dashes; unique. Public: it appears in metrics, usage records (`key:<id>`) and logs. |
| `sha256`                  | SHA-256 of the full key string; unique                                                                                    |
| `label`                   | Optional note, up to 64 characters; never shown                                                                           |
| `networks`                | The networks the key may use; each must be served unless `ACCESS_KEYS_FUTURE_NETWORKS=true`                               |
| `requestsPerMinute`       | Optional, 1–100000, per network for `/verify` and `/settle`; default `KEY_DEFAULT_REQUESTS_PER_MINUTE` of the network     |
| `sponsorBudgetXlmPerHour` | Fees the key's settlements may commit per hour per network, as XLM with up to 7 decimals; **required for pubnet keys**    |
| `expiresAt`               | **Required for pubnet keys**, at most `ACCESS_KEY_MAX_LIFETIME_DAYS` after `createdAt`; checked on every request          |
| `revoked`                 | Optional; a revoked key stays listed and is refused                                                                       |
| `createdAt`               | Required                                                                                                                  |

`node dist/keys.js new --id acme-prod-1 --networks stellar:pubnet --sponsor-budget-xlm-per-hour 2
[--requests-per-minute 120] [--days 90]` prints a new key once, on the first line (`r402_<id>_<43
random characters>`; give it to its holder and do not store it), and the record to add on the second.
`node dist/keys.js check <file>` validates a file exactly as the service does, with the networks of
`NETWORKS`, and exits 0 or 78.

The service looks the file up by its path every 10 seconds and re-reads it when its inode, size or
modification time changed, and at once on `SIGHUP`, so issuing, expiring and revoking keys needs no
restart. Replace the file atomically (write a new file next to it, run `keys check` on it, rename it over
the old one). In a container, mount the directory that holds the file and set `API_KEYS_DIR`: a mount of
the single file keeps showing the file it was created with, so a file renamed over it on the host is never
seen inside, and a revoked key would stay valid until a restart. A changed file that fails validation
leaves the previous keys in force, logs the error, raises the critical `/health` warning
`access_keys_reload_failed` and counts `rail402_access_keys_reload_failures_total`. `/health/private`
shows the SHA-256 of the file in force (`access.fileSha256`), so a replacement can be confirmed on every
replica: compare it with the SHA-256 of the new file. A file replaced while the service starts is read
once more when the keys are built, so the digest always describes the keys in force; until a file has
been applied, `access.fileSha256` is `null`. The file must not be writable by its group or others.

**Internal discovery callers.** A key with `"scopes": ["discovery-internal"]` and `"networks": []` is the
identity of an internal discovery front end (for example a hosted discovery service that calls
`/discovery/*` for its own users). On the discovery routes its requests draw on a bucket of their own,
`discoveryRequestsPerMinute` (default `DISCOVERY_INTERNAL_REQUESTS_PER_MINUTE`), instead of the
per-address `RATE_LIMIT_PER_MINUTE`. With `forwardedClientRequestsPerMinute` set, the service also trusts
its `X-Rail402-Client` header (1–64 letters, digits, `.`, `_`, `:` or `-`; other values are ignored) and
gives each forwarded client that many discovery requests per minute, and its own share of concurrent
discovery requests (`DISCOVERY_MAX_IN_FLIGHT_PER_CLIENT`), so every remote user is limited on its own; the
header is ignored from anyone else. Such a key is refused with HTTP 403 on `/verify` and
`/settle` on every network.

How a request's key is decided on one network:

| Key                             | Network requires keys (`REQUIRE_API_KEY=true`) | Network without keys |
| ------------------------------- | ---------------------------------------------- | -------------------- |
| none, unknown, malformed        | HTTP 401 `unauthorized`                        | served as `public`   |
| expired or revoked              | HTTP 401 `unauthorized`, the reason says which | served as `public`   |
| valid, but not for this network | HTTP 403 `forbidden`                           | served as `public`   |
| valid for this network          | served as `key:<id>` with its limits           | served as `key:<id>` |

Once the network and caller are known, each network applies its own limit: a key's `requestsPerMinute`,
or, for keyless callers, `RATE_LIMIT_PER_MINUTE` of the network per client address (unset: no network
limit), shared by every replica with Postgres and refused with HTTP 429 and `Retry-After`. When that
limiter cannot answer, **pubnet requests are refused** with HTTP 503 `service_unavailable` ("Rate limiting
is unavailable"), testnet requests are served. Each settlement records its caller, and the fee sponsor
admits it only within the network's hourly budget and the caller's own: the key's
`sponsorBudgetXlmPerHour`, or for keyless callers `KEYLESS_SPONSOR_BUDGET_XLM_PER_HOUR` of the network,
shared by all of them. A spent caller budget is `settle_exact_stellar_caller_budget_exhausted` (or the
`upto` equivalent), retryable.

| Variable                                 | Default | Meaning                                                                                                                    |
| ---------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------- |
| `API_KEYS_FILE`                          | —       | Absolute path of the access-key file. **This or `API_KEYS_DIR` is required when `PUBNET_REQUIRE_API_KEY=true`.**           |
| `API_KEYS_DIR`                           | —       | Absolute path of a directory holding the access-key file as `keys.json`, instead of `API_KEYS_FILE` (not both).            |
| `ACCESS_KEYS_FUTURE_NETWORKS`            | `false` | Accept keys for networks the service does not serve yet.                                                                   |
| `ACCESS_KEY_MAX_LIFETIME_DAYS`           | `400`   | Longest a key may live, from `createdAt` to `expiresAt` (1–3650).                                                          |
| `ACCESS_KEYS_MAX`                        | `1000`  | Most keys the file may hold (1–100000).                                                                                    |
| `DISCOVERY_INTERNAL_REQUESTS_PER_MINUTE` | `6000`  | Discovery requests per minute of a `discovery-internal` key whose record sets no `discoveryRequestsPerMinute` (1–1000000). |

## Keys through GitHub sign-in

With `KEY_SIGNUP=github` the host that serves `KEY_SIGNUP_NETWORK` (a `PUBLIC_HOSTS` entry) issues access
keys to anyone with a GitHub account, without an operator in the loop:

1. `GET /keys/new` sends the browser to GitHub. No scope is asked for: only the public profile is read.
2. GitHub sends it back to `GET /keys/callback`, which answers with JSON holding the key, shown once:

```json
{
  "key": "r402_gh-1234567_…",
  "keyId": "gh-1234567",
  "github": "octocat",
  "network": "stellar:pubnet",
  "limits": { "requestsPerMinute": 60, "sponsorBudgetXlmPerHour": "0.5" },
  "expiresAt": "2027-02-07T12:00:00.000Z",
  "replacedPreviousKey": false,
  "use": "Send it as \"Authorization: Bearer <key>\" to /verify and /settle on https://mainnet.rail402.dev. …"
}
```

Each GitHub account holds one key, `gh-<GitHub user id>`, for `KEY_SIGNUP_NETWORK` only. Signing in again
issues a new key and the previous one stops working, at most once per `KEY_SIGNUP_REISSUE_MINUTES`. The
database keeps the key's SHA-256 and the account's id and login, never the key or the GitHub token. Every
replica reads the issued keys every 10 seconds; the replica that issued a key accepts it at once. Issued
keys are limited like file keys: their request limit and hourly fee budget apply per settlement. Metrics
count them under one `key_id` label, `issued`.

| Variable                                 | Default          | Meaning                                                                             |
| ---------------------------------------- | ---------------- | ----------------------------------------------------------------------------------- |
| `KEY_SIGNUP`                             | `off`            | `github` serves `/keys/new` and `/keys/callback`; needs `STORE=postgres`            |
| `KEY_SIGNUP_GITHUB_CLIENT_ID`            |                  | The GitHub OAuth app's client id                                                    |
| `KEY_SIGNUP_GITHUB_CLIENT_SECRET(_FILE)` |                  | Its client secret; from a file when pubnet is enabled                               |
| `KEY_SIGNUP_CALLBACK_URL`                |                  | `https://<host>/keys/callback`, the OAuth app's callback URL, on the network's host |
| `KEY_SIGNUP_NETWORK`                     | `stellar:pubnet` | The network issued keys may use                                                     |
| `KEY_SIGNUP_REQUESTS_PER_MINUTE`         | `60`             | Each issued key's request limit on that network                                     |
| `KEY_SIGNUP_SPONSOR_BUDGET_XLM_PER_HOUR` | `0.5`            | Each issued key's hourly fee budget                                                 |
| `KEY_SIGNUP_DAYS`                        | `90`             | How long an issued key lives; at most `ACCESS_KEY_MAX_LIFETIME_DAYS`                |
| `KEY_SIGNUP_PER_HOUR`                    | `30`             | New keys per hour across the service, replacements included                         |
| `KEY_SIGNUP_REISSUE_MINUTES`             | `60`             | Shortest time between two keys of one account                                       |
| `KEY_SIGNUP_MIN_ACCOUNT_AGE_DAYS`        | `30`             | Youngest GitHub account issued a key                                                |

Sign-up requests are limited to 10 a minute per client address. The refusals are listed under
[access-key sign-up](/reference/error-codes#access-key-sign-up) on the error-code page.

**Switches.** The access-key file's top-level `issuedKeys` controls issued keys, and takes effect with the
file's next reload (10 seconds, or at once on `SIGHUP`):

| `issuedKeys`   | New keys                         | Keys already issued                                          |
| -------------- | -------------------------------- | ------------------------------------------------------------ |
| `on` (default) | issued                           | accepted                                                     |
| `no-new`       | refused with `key_signup_closed` | accepted                                                     |
| `off`          | refused with `key_signup_closed` | refused with HTTP 401, the reason says they are switched off |

Keys in the file are never affected. To stop one holder, revoke the account:
`node dist/keys.js issued revoke <gh-id or GitHub login>`; it is refused within 10 seconds on every
replica and the account is issued no other key until `node dist/keys.js issued restore <…>`.
`node dist/keys.js issued list` prints every issued key without its secret. These commands connect with
`DATABASE_URL` (or `DATABASE_URL_FILE`). File key ids cannot start with `gh-`.

## Secrets from files

Every secret can come from a file instead of the environment: set `<NAME>_FILE` to the file's absolute
path, for `DATABASE_URL`, `DATABASE_MIGRATION_URL`, `SEARCH_CURSOR_SECRET`, `TESTNET_SPONSOR_SECRET` and
`PUBNET_SPONSOR_SECRET`.
An environment variable is visible to anyone who can inspect the container or the process; a file
mounted from a secret store is not. The file is read once at startup and its content, trimmed, is the
value. Setting both `<NAME>` and `<NAME>_FILE` is refused (`config_secret_conflict`).

A secret file must be a regular file of at most 4 KiB that neither its group nor others can write
(`config_secret_file_insecure`); a missing, unreadable, empty, oversized or relative path is
`config_secret_file_unreadable`. Errors name the variable and the path, never the content.

**With pubnet enabled every secret comes from a file.** `PUBNET_SPONSOR_SECRET`, `DATABASE_URL`,
`DATABASE_MIGRATION_URL` and `SEARCH_CURSOR_SECRET` in the environment are refused (`config_secret_in_env`), because one process then
also serves the public testnet. `TESTNET_SPONSOR_SECRET` may stay in the environment, though a file is
better. The pubnet sponsor key files (`PUBNET_SPONSOR_SECRET_FILE`, `PUBNET_PREVIOUS_SPONSOR_SECRET_FILE`)
must also be readable by their owner only (mode `0400` or `0600`; group or others able to read is
`config_secret_file_insecure`), the database URL and cursor secret files by their owner and group only
(at most `0440`; others able to read is `config_secret_file_insecure`), and the sponsor key files network-tagged: the first line is `# rail402-key network=stellar:pubnet`, followed by the seed.

```text
# rail402-key network=stellar:pubnet
S...
```

An untagged pubnet sponsor file is refused (`config_secret_file_untagged`), and a file tagged for
another network is refused on any network (`config_secret_network_mismatch`), so a seed generated and
handled as a testnet key cannot become the mainnet sponsor by mistake. Testnet sponsor files may be
untagged.

## Per network

Variables are prefixed `TESTNET_` or `PUBNET_`, for example `TESTNET_RPC_URL`. Only the networks listed
in `NETWORKS` are read.

| Variable                               | Default (testnet)                             | Meaning                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RPC_URL`                              | —                                             | Stellar RPC endpoint (one provider, alias `primary`). Pubnet requires `https`. Set this or `RPC_URLS`, not both (`config_rpc_conflict`).                                                                                                                                                                                                                              |
| `RPC_URLS`                             | —                                             | Several RPC providers in order of preference, comma-separated, each `ALIAS=URL` or a bare URL (aliases `rpc0`, `rpc1`, …; 1–16 lower-case letters, digits or dashes). May come from `RPC_URLS_FILE` when URLs embed keys. See [RPC providers](/operations#rpc-providers).                                                                                             |
| `RPC_SINGLE_PROVIDER`                  | `false`                                       | Pubnet only: accept a single provider while several networks are served (otherwise `config_pubnet_rpc_fallback_missing`).                                                                                                                                                                                                                                             |
| `SPONSOR_SECRET`                       | —                                             | Secret seed (`S…`) of the fee sponsor, or `SPONSOR_SECRET_FILE`; pubnet accepts only the file form. Channel accounts are derived from it. One per network.                                                                                                                                                                                                            |
| `CHANNEL_COUNT`                        | `8`                                           | Channel accounts (1–1000): the number of settlements that can be in flight at once.                                                                                                                                                                                                                                                                                   |
| `ASSETS`                               | Circle USDC; pubnet: required                 | `CONTRACT:SYMBOL:DECIMALS[:MIN:MAX]`, comma-separated; amounts in base units. On pubnet every entry needs its `MIN`.                                                                                                                                                                                                                                                  |
| `MAX_TX_FEE_STROOPS`                   | `2000000`; pubnet: required                   | Ceiling on the simulated `exact` settlement fee. See [fee ceilings](#fee-ceilings).                                                                                                                                                                                                                                                                                   |
| `INCLUSION_FEE_STROOPS`                | `100`; pubnet: required                       | Lowest inclusion-fee bid above the resource fee, and the bid if fee stats fail. At least 100; on pubnet at least 200.                                                                                                                                                                                                                                                 |
| `INCLUSION_FEE_CAP_STROOPS`            | `10000`                                       | Highest inclusion-fee bid, whatever the network reports.                                                                                                                                                                                                                                                                                                              |
| `INCLUSION_FEE_PERCENTILE`             | `p90`                                         | Point of the recent Soroban inclusion-fee distribution (`getFeeStats`) to bid.                                                                                                                                                                                                                                                                                        |
| `ALLOW_INCLUSION_FEE_BELOW_FLOOR`      | `false`                                       | Pubnet only: accept a `PUBNET_INCLUSION_FEE_STROOPS` below 200, whose bids may never be included under mainnet's usual fees.                                                                                                                                                                                                                                          |
| `ALLOW_SINGLE_SIGNER_SPONSOR`          | `false`                                       | Pubnet only: skip the startup check of the sponsor's signers (see [Keys and custody](/operations#keys-and-custody)).                                                                                                                                                                                                                                                  |
| `SPONSOR_COLD_SIGNER`                  | —; pubnet: required                           | The `G…` key, kept off the server, that alone reaches the sponsor account's high threshold; the startup signer check requires it (see [Keys and custody](/operations#keys-and-custody)). Not needed with `ALLOW_SINGLE_SIGNER_SPONSOR=true`.                                                                                                                          |
| `EXPIRATION_MARGIN_LEDGERS`            | `1`, pubnet `2`                               | Ledgers (1–100) an authorization must remain valid for, so settlement cannot land after it expires.                                                                                                                                                                                                                                                                   |
| `TIMEOUT_MIN_SECONDS`                  | `10`                                          | Smallest accepted `maxTimeoutSeconds`.                                                                                                                                                                                                                                                                                                                                |
| `TIMEOUT_MAX_SECONDS`                  | `300`                                         | Largest accepted `maxTimeoutSeconds`.                                                                                                                                                                                                                                                                                                                                 |
| `MIN_SPONSOR_BALANCE_XLM`              | `25`                                          | `/ready` fails below this sponsor balance. Pubnet refuses a value below 1 (`config_pubnet_sponsor_floor_invalid`).                                                                                                                                                                                                                                                    |
| `SPONSOR_RESERVE_XLM`                  | `5`                                           | Settlements are refused while the sponsor holds less than this.                                                                                                                                                                                                                                                                                                       |
| `MAX_SPONSOR_SPEND_XLM_PER_HOUR`       | —                                             | Budget: settlements are refused once this much fee was committed in the last hour. **Required for pubnet.**                                                                                                                                                                                                                                                           |
| `REQUIRE_API_KEY`                      | `false`                                       | Require an API key for `/verify` and `/settle`. **Must be set explicitly for pubnet.**                                                                                                                                                                                                                                                                                |
| `RATE_LIMIT_PER_MINUTE`                | —                                             | Requests per minute per client address for keyless callers on this network, after `RATE_LIMIT_PER_MINUTE` of the service. **Required on pubnet without keys.**                                                                                                                                                                                                        |
| `KEY_DEFAULT_REQUESTS_PER_MINUTE`      | `600`, pubnet `60`                            | Requests per minute on this network for a key whose record sets none.                                                                                                                                                                                                                                                                                                 |
| `KEYLESS_SPONSOR_BUDGET_XLM_PER_HOUR`  | —                                             | Fees keyless settlements may commit per hour on this network, together, in XLM. **Required on pubnet without keys.**                                                                                                                                                                                                                                                  |
| `MAX_SETTLEMENTS_PER_PAYER_PER_MINUTE` | off, pubnet `10`                              | Settlements one payer may start per minute on this network (`settle_…_payer_rate_limited`); `0` turns it off.                                                                                                                                                                                                                                                         |
| `MAX_SETTLEMENTS_PER_PAYTO_PER_MINUTE` | off, pubnet `60`                              | Settlements one `payTo` may receive per minute on this network from one caller (`settle_…_payto_rate_limited`): each access key counts on its own, and keyless callers share one count, so keyless traffic cannot use up a keyed seller's quota; `0` turns it off. Both limits count only payments whose signature was proven, so forged payloads cannot use them up. |
| `PAYER_FAILURES_PER_HOUR`              | off, pubnet `3`                               | Included settlements of one payer that may fail on-chain (each costs the sponsor a fee) in an hour before the payer is refused until the hour moves on (`settle_…_payer_cooldown`); `0` turns it off.                                                                                                                                                                 |
| `AUTO_PROVISION_CHANNELS`              | `true` testnet, `false` pubnet                | Create missing channel accounts at startup; the sponsor pays their reserves.                                                                                                                                                                                                                                                                                          |
| `TTL_CONTRACTS`                        | —                                             | More contracts whose TTL is watched, as `ALIAS:CONTRACT`, comma-separated. Every `ASSETS` contract is watched under its symbol.                                                                                                                                                                                                                                       |
| `UPTO_ENABLED`                         | `true` testnet, `false` pubnet                | Serve the `upto` scheme on this network.                                                                                                                                                                                                                                                                                                                              |
| `UPTO_CONTRACT`                        | canonical testnet contract                    | The `upto` settlement contract (`C…`). Testnet defaults to `CBTVKCHLSGQ3WSV3NKSU6FZR4FZMC6ENMDMXUS5XQ66HYVUUHYE3TU7U`; pubnet requires it.                                                                                                                                                                                                                            |
| `UPTO_WASM_HASH`                       | canonical WASM hash                           | Hex SHA-256 of the contract's WASM. Required with a non-canonical contract and on pubnet. Startup fails if the live contract runs other code.                                                                                                                                                                                                                         |
| `UPTO_ZERO_SETTLEMENT`                 | `onchain`, pubnet `offchain`                  | A zero-amount settlement: `onchain` submits `settle(…, 0)` and consumes the authorization on-chain; `offchain` records it as used. `offchain` needs `STORE=postgres`.                                                                                                                                                                                                 |
| `UPTO_MAX_TX_FEE_STROOPS`              | `5000000`; pubnet: required                   | Ceiling on the simulated `upto` settlement fee. See [fee ceilings](#fee-ceilings).                                                                                                                                                                                                                                                                                    |
| `UPTO_LEDGER_SECONDS`                  | from the RPC                                  | Seconds per ledger for the `upto` expiration window, from 1 to 60. By default the average over the ledgers the network's RPC retains, read at most once a minute; an estimate under 1 second counts as 1.                                                                                                                                                             |
| `UPTO_TTL_KEEPER`                      | `true`                                        | Extend (and, where allowed, restore) the settlement contract in the background.                                                                                                                                                                                                                                                                                       |
| `UPTO_TTL_EXTEND_BELOW_LEDGERS`        | `518400`                                      | Extend once the contract's instance or code entry has fewer ledgers left (about 30 days at 5 s ledgers).                                                                                                                                                                                                                                                              |
| `UPTO_TTL_EXTEND_TO_LEDGERS`           | network maximum − 17280                       | Ledgers past the current one an extension reaches.                                                                                                                                                                                                                                                                                                                    |
| `UPTO_TTL_AUTO_RESTORE`                | `true` testnet, `false` pubnet                | Restore an archived contract without an operator (the sponsor pays).                                                                                                                                                                                                                                                                                                  |
| `UPTO_TTL_MAX_FEE_STROOPS`             | `500000000`; pubnet: required with the keeper | Ceiling on the fee of one extension or restoration. Extending the code entry by the network maximum costs about 32 XLM on testnet.                                                                                                                                                                                                                                    |
| `UPTO_TTL_DAILY_MAX_FEE_STROOPS`       | off; pubnet `UPTO_TTL_MAX_FEE_STROOPS`        | Most the keeper may spend in any 24 hours; a round whose ceiling would pass it waits. Each transaction counts at its ceiling from before it is signed until the fee charged is known (a transaction whose outcome is unknown keeps its ceiling), and toward `MAX_SPONSOR_SPEND_XLM_PER_HOUR`.                                                                         |
| `PREVIOUS_SPONSOR_SECRET`              | —                                             | After a sponsor rotation: the previous sponsor's seed (or `PREVIOUS_SPONSOR_SECRET_FILE`; with pubnet only the file, network-tagged and owner-only). Its derived `upto` authority stays accepted until `PREVIOUS_AUTHORITY_UNTIL`. See [Rotating the sponsor key](/operations#rotating-the-sponsor-key).                                                              |
| `PREVIOUS_AUTHORITY_UNTIL`             | —                                             | ISO 8601 time until which the previous authority is accepted; required with `PREVIOUS_SPONSOR_SECRET`, at most `TIMEOUT_MAX_SECONDS` from startup; a time already passed loads nothing.                                                                                                                                                                               |
| `GATES_READY`                          | `true` with one network, `false` with several | Whether this network's checks decide the aggregate `/ready`. See [Serving per network](/operations#serving-per-network).                                                                                                                                                                                                                                              |
| `ON_STARTUP_CHECK_FAILURE`             | `exit` with one network, `hold` with several  | What a failed chain check at startup does: `exit` stops the process when the chain contradicts the configuration (exit code 78); `hold` starts it with this network held until the check passes. An RPC that fails or does not answer holds the network in both modes.                                                                                                |
| `STARTUP_TIMEOUT_MS`                   | `30000`                                       | With `hold`, how long the startup chain checks may take before the network starts held (1000–600000).                                                                                                                                                                                                                                                                 |

The default asset is Circle USDC on each network: `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`
on testnet and `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` on pubnet, both with 7
decimals. `INCLUSION_FEE_PERCENTILE` is one of `p50`, `p70`, `p80`, `p90`, `p95` or `p99`.

Validation rules beyond the formats:

- `NETWORKS` may not list a network twice, and each network needs its own sponsor account.
- Whenever pubnet is enabled, every setting that decides what the fee sponsor pays for is explicit:
  `PUBNET_RPC_URL` must use `https`, and a provider URL with credentials in its user info, query or
  fragment must come from `PUBNET_RPC_URLS_FILE` (`config_secret_in_env`; put a list whose URLs carry a
  key in their path there too); `PUBNET_REQUIRE_API_KEY` must be `true` or `false`;
  `PUBNET_MAX_SPONSOR_SPEND_XLM_PER_HOUR`, `PUBNET_MAX_TX_FEE_STROOPS`, `PUBNET_INCLUSION_FEE_STROOPS`
  (at least 200 unless `PUBNET_ALLOW_INCLUSION_FEE_BELOW_FLOOR=true`), `PUBNET_ASSETS` and, unless
  `PUBNET_ALLOW_SINGLE_SIGNER_SPONSOR=true`, `PUBNET_SPONSOR_COLD_SIGNER` must be set, and
  every `PUBNET_ASSETS` entry needs a minimum amount of at least 1 base unit, since a smaller payment
  costs the sponsor a full settlement fee. With `upto` on pubnet, `PUBNET_UPTO_MAX_TX_FEE_STROOPS` is
  required, and so is `PUBNET_UPTO_TTL_MAX_FEE_STROOPS` while `PUBNET_UPTO_TTL_KEEPER` is on (the default).
  None of these falls back to a testnet default.
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
- `UPTO_ZERO_SETTLEMENT=offchain` (the pubnet default) needs `STORE=postgres`: an off-chain zero exists only
  in the settlement ledger, which must survive restarts and be shared by every replica, or the same
  authorization could later be settled on-chain for more. A restore loses the records written after its
  restore point, so after one (recorded in `settlement_rewinds`) every network serving `upto`, whatever its
  `UPTO_ZERO_SETTLEMENT` is now, settles no `upto` payment that moves funds until the chain has passed the
  longest window rule 7 can accept, `TIMEOUT_MAX_SECONDS` in 1-second ledgers plus 7, about 25 minutes at
  the default `TIMEOUT_MAX_SECONDS` of 300 and 5-second ledgers (see
  [Restoring a backup](/runbook#restoring-a-backup)).
- The `upto` contract is watched under the TTL alias `upto`, so no asset symbol or `TTL_CONTRACTS`
  alias may be `upto`, and it may be neither an accepted asset nor listed in `TTL_CONTRACTS`.

## Fee ceilings

The sponsor pays every settlement fee, so each network has a ceiling on the fee a settlement may cost:
`MAX_TX_FEE_STROOPS` for `exact` and `UPTO_MAX_TX_FEE_STROOPS` for `upto`. Verification and settlement
compare the fee the simulation asks for (resource fee plus the inclusion bid; for `upto`, the bid counted twice,
for the settlement transaction and for its fee bump) with the ceiling and refuse a
payment above it before anything is signed, with `invalid_exact_stellar_payload_fee_exceeds_maximum` or
`invalid_upto_stellar_payload_fee_exceeds_maximum`.

The `exact` fee bump pays the inclusion bid a second time, so the most one `exact` settlement can cost the
sponsor is `MAX_TX_FEE_STROOPS` plus the highest bid (`INCLUSION_FEE_CAP_STROOPS`); for `upto` it is
`UPTO_MAX_TX_FEE_STROOPS`, which already counts both bids. Each settlement reserves that worst case against the
hourly budgets when it is claimed, and the sponsor refuses to sign a fee bump that would cost more than the
reservation (`settle_exact_stellar_fee_bump_signing_failed`), so the budgets cannot be overshot. Once a
settlement is finished it counts what the sponsor was charged instead: nothing when it expired or the network
refused its submission, and its maximum fee when the charge could not be read.

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
| `exact`, TEST6, smart-account payer, to a payee that already held TEST6        | testnet         | 1,083,927 simulated                     |
| `upto`, OpenZeppelin smart account with a spending-limit policy, first payment | testnet         | 2,339,612 charged (2,692,602 simulated) |
| the same smart account's next `upto` payment                                   | testnet         | 184,655 charged (214,387 simulated)     |

Testnet's rent price follows the size of its ledger state and has kept rising: the smart-account TEST6
payment above carried a resource fee of 794,766 stroops nine days earlier, with the same instructions,
bytes and footprint. Testnet sponsors are funded by Friendbot, so the testnet defaults (2,000,000 and 5,000,000) leave
room for every payment above and for that drift. Pubnet has no defaults: set `PUBNET_MAX_TX_FEE_STROOPS` and
`PUBNET_UPTO_MAX_TX_FEE_STROOPS` for the tokens and payers you choose to serve, since the sponsor pays every
stroop. 300,000 and 500,000 cover the Stellar Asset Contract payments above and refuse the costly first
payments. `MAX_SPONSOR_SPEND_XLM_PER_HOUR` bounds the total.

When the bid cannot follow the network, `rail402_inclusion_fee_pinned_total` counts it per network:
`cause="cap"` when the network asks for more than `INCLUSION_FEE_CAP_STROOPS` (settlements may wait under
surge pricing), `cause="stats_unavailable"` when fee stats could not be read and the floor was bid.
`rail402_inclusion_fee_bid_stroops` is the current bid.

## Startup checks

Configuration problems stop the service before it serves anything, with exit code 78 and
`rail402: <code>: <message>` on stderr. The codes are stable:

| Code                                           | Meaning                                                                                                                                                                                                                                            |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config_invalid`                               | A malformed value, an unknown network, or limits that contradict each other                                                                                                                                                                        |
| `config_rpc_missing`                           | `<NETWORK>_RPC_URL`, `<NETWORK>_RPC_URLS` and `<NETWORK>_RPC_URLS_FILE` are all unset, or `<NETWORK>_RPC_URLS` lists no provider                                                                                                                   |
| `config_sponsor_secret_missing`                | A served network has no sponsor seed: `TESTNET_SPONSOR_SECRET` (or `_FILE`) or, with pubnet, `PUBNET_SPONSOR_SECRET_FILE` is not set                                                                                                               |
| `config_fee_bounds_invalid`                    | `INCLUSION_FEE_STROOPS`, `INCLUSION_FEE_CAP_STROOPS` and the fee ceilings are out of order                                                                                                                                                         |
| `config_pubnet_rpc_insecure`                   | `PUBNET_RPC_URL` does not use `https`                                                                                                                                                                                                              |
| `config_pubnet_api_key_policy_missing`         | `PUBNET_REQUIRE_API_KEY` is not set                                                                                                                                                                                                                |
| `config_pubnet_budget_missing`                 | `PUBNET_MAX_SPONSOR_SPEND_XLM_PER_HOUR` is not set                                                                                                                                                                                                 |
| `config_pubnet_fee_ceiling_missing`            | `PUBNET_MAX_TX_FEE_STROOPS`, `PUBNET_INCLUSION_FEE_STROOPS` or, with `upto`, `PUBNET_UPTO_MAX_TX_FEE_STROOPS` or `PUBNET_UPTO_TTL_MAX_FEE_STROOPS` is not set                                                                                      |
| `config_pubnet_inclusion_floor_too_low`        | `PUBNET_INCLUSION_FEE_STROOPS` is below 200 without `PUBNET_ALLOW_INCLUSION_FEE_BELOW_FLOOR=true`                                                                                                                                                  |
| `config_pubnet_assets_missing`                 | `PUBNET_ASSETS` is not set                                                                                                                                                                                                                         |
| `config_pubnet_asset_min_missing`              | A `PUBNET_ASSETS` entry has no minimum amount, or a minimum of 0                                                                                                                                                                                   |
| `config_upto_contract_missing`                 | `upto` is enabled without the settlement contract it needs: `<NETWORK>_UPTO_CONTRACT` on a network without a canonical one, or `<NETWORK>_UPTO_WASM_HASH` with a non-canonical contract (on pubnet both are always required)                       |
| `config_pubnet_cold_signer_missing`            | `PUBNET_SPONSOR_COLD_SIGNER` is not set while the sponsor signer check is on                                                                                                                                                                       |
| `config_pubnet_sponsor_floor_invalid`          | `PUBNET_MIN_SPONSOR_BALANCE_XLM` is below 1                                                                                                                                                                                                        |
| `config_bazaar_policy_invalid`                 | `PUBNET_BAZAAR_ORIGINLESS_MCP` is set to `publish` (a value that is neither option is `config_invalid`)                                                                                                                                            |
| `config_secret_in_env`                         | A secret that must come from a file is set in the environment, or, with pubnet, `PUBNET_RPC_URL(S)` in the environment carries credentials in a URL                                                                                                |
| `config_secret_conflict`                       | Both `<NAME>` and `<NAME>_FILE` are set                                                                                                                                                                                                            |
| `config_secret_file_unreadable`                | A secret file is missing, unreadable, empty, larger than 4 KiB, not a regular file, or given as a relative path                                                                                                                                    |
| `config_secret_file_insecure`                  | A secret file is writable by its group or others, a pubnet sponsor seed file is readable by anyone but its owner, or, with pubnet, a database URL or cursor secret file is readable by others                                                      |
| `config_secret_file_untagged`                  | The pubnet sponsor key file does not start with its network tag                                                                                                                                                                                    |
| `config_secret_network_mismatch`               | A sponsor key file is tagged for another network                                                                                                                                                                                                   |
| `config_rpc_conflict`                          | Both `<NETWORK>_RPC_URL` and `<NETWORK>_RPC_URLS` are set                                                                                                                                                                                          |
| `config_pubnet_rpc_fallback_missing`           | Several networks are served and `PUBNET_RPC_URLS` lists fewer than two providers, without `PUBNET_RPC_SINGLE_PROVIDER=true`                                                                                                                        |
| `config_pubnet_keyless_limits_missing`         | Pubnet serves keyless callers (`PUBNET_REQUIRE_API_KEY=false`) without `PUBNET_RATE_LIMIT_PER_MINUTE` and `PUBNET_KEYLESS_SPONSOR_BUDGET_XLM_PER_HOUR`                                                                                             |
| `config_access_keys_missing`                   | `REQUIRE_API_KEY=true` without any key, or pubnet requires keys without `API_KEYS_FILE` or `API_KEYS_DIR`                                                                                                                                          |
| `config_access_keys_invalid`                   | `API_KEYS_FILE` and `API_KEYS_DIR` are both set, or the key file is not an absolute path, cannot be read, is not a regular file of at most 1 MiB, is writable by its group or others, or holds an invalid key record                               |
| `config_legacy_api_keys_with_pubnet`           | `API_KEY_SHA256` is set with pubnet enabled: its keys would open every network                                                                                                                                                                     |
| `config_key_signup_invalid`                    | `KEY_SIGNUP=github` without a database store, client id or secret, with a callback URL that is not `https://<host>/keys/callback` on a `PUBLIC_HOSTS` host of `KEY_SIGNUP_NETWORK`, or with `KEY_SIGNUP_DAYS` above `ACCESS_KEY_MAX_LIFETIME_DAYS` |
| `config_metrics_private_token_missing`         | `METRICS_PRIVATE_TOKEN_SHA256` is not set with pubnet enabled                                                                                                                                                                                      |
| `config_public_hosts_invalid`                  | `PUBLIC_HOSTS` is malformed, names a network that is not served, or lists a host twice                                                                                                                                                             |
| `config_database_unreachable`                  | The database cannot be reached or read (preflight)                                                                                                                                                                                                 |
| `config_database_connections_low`              | With pubnet, the database role (or the server) allows fewer connections than one process's pools hold (see [Database roles](/operations#database-roles))                                                                                           |
| `config_database_superuser`                    | With pubnet, the database role is a superuser or may create roles, is a member of such a role or of a server-file or server-program role, or owns the schema or its tables (see [Database roles](/operations#database-roles))                      |
| `config_pubnet_migration_url_in_service`       | With pubnet, `DATABASE_MIGRATION_URL` is given to the service: the process that holds the pubnet sponsor seed never holds the schema owner's credentials too                                                                                       |
| `config_pubnet_migration_role_missing`         | With pubnet, a migration is pending and would be applied through the service's own connection (`MIGRATE_ON_START=true`); run `node dist/migrate.js` as the schema owner instead                                                                    |
| `config_schema_outdated`                       | A migration is pending and `MIGRATE_ON_START=false`                                                                                                                                                                                                |
| `sponsor_signers_unsafe`                       | (pubnet) The sponsor's signer set is unsafe for a key on a server (see [Keys and custody](/operations#keys-and-custody)); with several networks pubnet is held instead                                                                             |
| `upto_contract_mismatch`                       | The live `upto` contract runs other code than `UPTO_WASM_HASH`, or (pubnet) is not on the network; with several networks the network is held instead                                                                                               |
| `asset_decimals_mismatch`, `asset_not_a_token` | An accepted asset's contract contradicts its configuration (see [Accepted assets](/facilitator/assets))                                                                                                                                            |

Any other failure that stops startup, such as missing embedding model files, exits with code 1 and
one line, `rail402: startup_failed: <what failed>`, followed by the code locations of the failure. The
line never carries a URL or a secret seed, whatever was thrown.

**Preflight.** `node dist/check-config.js` (in the image: `docker run --rm --env-file … <image> node
dist/check-config.js`) loads and validates the configuration exactly as the service does, with the same
environment, and with Postgres connects to check the database role and, with `MIGRATE_ON_START=false`,
that no migration is pending (it changes nothing), then exits 0 and prints one JSON line naming the networks and a SHA-256 digest of each
network's effective settings (with Postgres also `database`: the connections the role may hold, the most one
process opens and how many replicas that holds), or exits 78 with the line the service would stop with. With
`CHECK_CONFIG_PENDING_OK=true` (preflight only) pending migrations are expected, for a deploy that applies them
with `node dist/migrate.js` next: it skips only the two pending-migration refusals (`config_schema_outdated`,
`config_pubnet_migration_role_missing`) and still checks the database role. It touches no
Stellar network. Run it before replacing a running service, so a configuration that cannot start never
replaces one that works. The service logs the same digest at startup (`network settings loaded`), so a
preflight and the service it guards, or two replicas, can be compared without printing any setting.

## Bazaar and search

| Variable                                                                           | Default                                | Meaning                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `BAZAAR_ENABLED`                                                                   | `true`                                 | Catalog settled resources and serve `/discovery/*`. With `false`, neither exists.                                                                                                                                                                                                                            |
| `<NET>_BAZAAR_MAX_NEW_LISTINGS_PER_OWNER_PER_HOUR`                                 | testnet `20`, pubnet `5`               | New listings one `payTo` may publish per hour at one origin (scheme, host and port) on that network (1–100000); one past it waits. It counts once that origin confirmed a settlement paying the `payTo` its price there; dust, other hosts and transfers never use it up.                                    |
| `<NET>_BAZAAR_MAX_NEW_LISTINGS_PER_PAYER_PER_HOUR`                                 | testnet `10`, pubnet `5`               | New listings the settlements of one payer may create per hour on that network (1–100000).                                                                                                                                                                                                                    |
| `<NET>_BAZAAR_MAX_NEW_LISTINGS_PER_HOUR`                                           | testnet `1000`, pubnet `200`           | New listings the catalog publishes per hour on that network, counted at first publication (1–10000000); never-published ones do not count, one confirmed while it is spent waits, and `mcp://` tools count apart, within half of it.                                                                         |
| `<NET>_BAZAAR_ORIGIN_CHECKS_PER_HOST_PER_MINUTE`                                   | testnet `30`, pubnet `10`              | Origin requests one host receives per minute from each replica, for listings on that network (1–10000). A check makes up to 9; below that, a large check goes on over several minutes.                                                                                                                       |
| `<NET>_BAZAAR_MAX_PUBLISHED_LISTINGS`                                              | testnet `5000`, pubnet `25000`         | Listings an origin confirmed that network may have published at once (1–10000000); `mcp://` tools count apart, within half of it. A new listing is refused with `bazaar_catalog_full` while it is full.                                                                                                      |
| `<NET>_BAZAAR_MAX_PUBLISHED_PER_OWNER`                                             | testnet `0`, pubnet `250`              | Listings an origin confirmed one payTo may have published at once on that network, so no seller or party holds more than a share of it (0–10000000; `0` sets no share). A new listing past it is refused with `bazaar_catalog_full`, and a pending one its origin confirms is withdrawn with `catalog_full`. |
| `<NET>_BAZAAR_UNVERIFIED_TTL_HOURS`                                                | `168`                                  | Hours a published listing no origin confirmed (an `mcp://` tool) stays after its last settlement before it is withdrawn (1–87600).                                                                                                                                                                           |
| `<NET>_BAZAAR_IDLE_TTL_DAYS`                                                       | `90`                                   | Days any published listing stays after its last settlement before it is withdrawn; `0` never withdraws an idle listing (0–3650).                                                                                                                                                                             |
| `BAZAAR_MAX_LISTING_BYTES`                                                         | `36864`                                | The largest content one listing may publish, in bytes of JSON (4096–1048576); larger listings are refused or withdrawn.                                                                                                                                                                                      |
| `<NET>_BAZAAR_ORIGINLESS_MCP`                                                      | testnet `publish`, pubnet `refuse`     | `publish` lists MCP tools under an `mcp://` URL at trust `settled`; `refuse` rejects them with `bazaar_resource_unverifiable`. Pubnet accepts only `refuse`.                                                                                                                                                 |
| `<NET>_BAZAAR_MIN_SETTLED`                                                         | unset                                  | `CONTRACT:AMOUNT,…`: the smallest settled amount, in base units, that catalogs a resource, per asset. Unlisted assets have no minimum.                                                                                                                                                                       |
| `<NET>_BAZAAR_USD_ASSETS`                                                          | Circle USDC of the network             | Comma-separated asset contracts whose amounts search treats as US dollars for a `maxPrice` in dollars.                                                                                                                                                                                                       |
| `<NET>_BAZAAR_USAGE_DETAIL`                                                        | testnet `settlements`, pubnet `counts` | What the [usage routes](/bazaar/discovery#usage) publish: `settlements` links each settlement to the listing it paid for and lists each listing's latest settlements with their payers; `counts` publishes counts and dates only, so no route links a payer to what it bought.                               |
| `BAZAAR_MAX_NEW_LISTINGS_PER_OWNER_PER_HOUR`, `…_PER_PAYER_PER_HOUR`, `…_PER_HOUR` | —                                      | Earlier catalog-wide names of the quotas above. They apply to testnet only, below its `TESTNET_` variables; pubnet never uses them.                                                                                                                                                                          |
| `ORIGIN_CHECK_INTERVAL_MS`                                                         | `5000`                                 | How often due origin checks run, per network (1000–3600000).                                                                                                                                                                                                                                                 |
| `DISCOVERY_ALLOW_LOOPBACK`                                                         | `false`                                | Catalog and fetch loopback resources, for local development and conformance runs ([Try the Bazaar locally](/facilitator/docker#try-the-bazaar-locally)); refused together with pubnet.                                                                                                                       |
| `SEARCH_EMBEDDINGS`                                                                | `true`                                 | Semantic search with the local embedding model. With `false`, search is lexical-only and ranked (not filter-only) results report `partialResults: true`.                                                                                                                                                     |
| `SEARCH_MODEL_DIR`                                                                 | `.models`                              | Directory holding the pinned model, relative to the working directory. The image sets `/app/models`.                                                                                                                                                                                                         |
| `SEARCH_MODEL_DOWNLOAD`                                                            | `false`                                | Download the pinned model at startup when it is missing (development convenience).                                                                                                                                                                                                                           |
| `SEARCH_CURSOR_SECRET`                                                             | random                                 | At least 32 bytes as hex, or `SEARCH_CURSOR_SECRET_FILE`; with pubnet enabled only the file form. Shared by every replica so search cursors survive restarts and load balancing.                                                                                                                             |
| `SEARCH_RATE_LIMIT_PER_MINUTE`                                                     | `120`                                  | Discovery cost units one client may spend per minute; 0 disables ([Load limits](/bazaar/search#load-limits)).                                                                                                                                                                                                |
| `SEARCH_UNCACHED_COST`                                                             | `5`                                    | Cost of a search that runs the embedding model (1–100); a cached or filter-only search costs 1.                                                                                                                                                                                                              |
| `SEARCH_EMBED_CONCURRENCY`                                                         | `1`                                    | Embeddings run at once, queries and index builds together (1–64).                                                                                                                                                                                                                                            |
| `SEARCH_EMBED_QUEUE`                                                               | `2`                                    | Queries that may wait for an embedding slot; more are answered lexical-only (0–1000).                                                                                                                                                                                                                        |
| `SEARCH_QUERY_CACHE_SIZE`                                                          | `1000`                                 | Query embeddings kept in the least-recently-used cache; 0 disables it.                                                                                                                                                                                                                                       |
| `SEARCH_MAX_SNAPSHOTS`                                                             | `4`                                    | Search index snapshots kept at most, the latest included (1–1000).                                                                                                                                                                                                                                           |
| `SEARCH_MAX_SNAPSHOT_MB`                                                           | `256`                                  | Estimated memory the kept snapshots may hold, in MiB; the latest is always kept.                                                                                                                                                                                                                             |
| `SEARCH_MAX_INDEX_MB_PER_NETWORK`                                                  | `96`                                   | Estimated memory one network's listings may take in a search snapshot, in MiB (1–65536). Listings that no longer fit are left out of search, newest first; listings no origin confirmed (trust `settled`) may take at most half.                                                                             |
| `SEARCH_SIMILARITY_FLOOR`                                                          | `0.3`                                  | Minimum cosine similarity for a semantic match (-1 to 1).                                                                                                                                                                                                                                                    |
| `SEARCH_PAGE_CACHE_SIZE`                                                           | `512`                                  | Listings of result pages kept for reuse within the one-second revision read, at the same catalog revision (0–100000; 0 disables).                                                                                                                                                                            |
| `DISCOVERY_MAX_IN_FLIGHT`                                                          | `32`                                   | Discovery requests served at once, per lane (pubnet, other) (1–10000), each counted until its response has been handed to its client's connection; see [Load limits](/bazaar/search#load-limits).                                                                                                            |
| `DISCOVERY_QUEUE_LENGTH`                                                           | `64`                                   | Discovery requests that may wait for a turn (0–100000); more are refused with `503` `discovery_overloaded`.                                                                                                                                                                                                  |
| `DISCOVERY_QUEUE_TIMEOUT_MS`                                                       | `1000`                                 | Longest a discovery request waits for a turn before it is refused (0–30000).                                                                                                                                                                                                                                 |
| `DISCOVERY_MAX_IN_FLIGHT_PER_CLIENT`                                               | `8`                                    | Discovery requests one client may have served or waiting at once, per lane (1–10000); more get `429`. A front end that forwards no client is one client for all its users; see [Load limits](/bazaar/search#load-limits).                                                                                    |
| `DISCOVERY_DATABASE_POOL_SIZE`                                                     | `5`                                    | Connections of the discovery routes' own database pool, apart from the pool settlements use; pubnet discovery has a second one (1–100).                                                                                                                                                                      |
| `DISCOVERY_DATABASE_ACQUIRE_TIMEOUT_MS`                                            | `1000`                                 | How long a discovery read waits for a connection of its pool before the request is refused with `503` `discovery_overloaded`, and a search index build for one of its own pool of 2 (100–60000).                                                                                                             |

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
DATABASE_URL_FILE=/run/secrets/database-url   # the row-only role
MIGRATE_ON_START=false          # run node dist/migrate.js as the schema owner first
NETWORKS=stellar:pubnet
PUBNET_RPC_URLS_FILE=/run/secrets/pubnet-rpc   # your RPC providers; their URLs often carry a key
PUBNET_SPONSOR_SECRET_FILE=/run/secrets/pubnet-sponsor   # tagged, mode 0400
PUBNET_SPONSOR_COLD_SIGNER=G... # the cold key that alone reaches the sponsor's high threshold
PUBNET_REQUIRE_API_KEY=true
PUBNET_MAX_SPONSOR_SPEND_XLM_PER_HOUR=10
PUBNET_MAX_TX_FEE_STROOPS=300000
PUBNET_INCLUSION_FEE_STROOPS=200
PUBNET_ASSETS=CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75:USDC:7:10000
API_KEYS_DIR=/run/access       # holds keys.json: keys scoped to networks, with budgets
METRICS_PRIVATE_TOKEN_SHA256=...
SEARCH_CURSOR_SECRET_FILE=/run/secrets/search-cursor
TRUSTED_PROXY_HOPS=1
```

On pubnet, channel accounts are not created at startup: run `channels provision` first (see
[Operations](/operations#channel-accounts)). The validation rules above are checked for pubnet at
startup, but pubnet itself has not been exercised end to end. The hosted Rail402 service serves testnet
only.
