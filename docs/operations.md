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
level down, a nested `transaction` (a signed envelope) and request `authorization` headers. A logged
error keeps its type, message, code, stack and cause, but never the request URL, body, headers or response
an HTTP client attached to it, so an RPC URL with a provider key in it or a JSON-RPC body with a signed
envelope does not reach the log (`apps/rail402/src/logger.ts`, tested in `apps/rail402/test/logger.test.ts`).

| Key                         | What it does                                                                                                           | What it can never do                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Sponsor                     | Pays every settlement fee through a fee bump; sponsors the reserves of channel accounts                                | Move a payer's funds: payments are authorized by the payer's own signature over the exact recipient and amount |
| Channel accounts            | Act as the source account of settlement transactions, one settlement at a time each                                    | Hold value: they are created with a zero balance and their reserves are sponsored                              |
| `upto` settlement authority | Is the operation source of `upto` settlements and chooses the amount settled, from zero up to the cap the payer signed | Exceed the cap, change the recipient or token, reuse an authorization, or move funds of its own: it holds none |

Channel keys are derived from the sponsor seed with HKDF-SHA256, per network and index
(`packages/facilitator/src/keys.ts`), and so is each network's `upto` settlement authority
(`packages/facilitator/src/authority.ts`), so there is nothing extra to store or back up, and whoever
holds the sponsor seed holds the channels and the authority too.

Rail402 is non-custodial by construction. Verification refuses any payment in which a facilitator
account is the payer, a transaction or operation source, or a party to an authorization, and the
payer's signed authorization fixes the asset, recipient and amount; changing any of them after
signing fails signature verification (see [verification-rules.md](verification-rules.md)). The
worst case after a leaked sponsor seed is therefore the loss of the sponsor's own XLM, which is why
it should hold only a working balance.

## Protecting the sponsor

| Control           | Setting                                         | Effect                                                                                                                 |
| ----------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Fee ceiling       | `MAX_TX_FEE_STROOPS`, `UPTO_MAX_TX_FEE_STROOPS` | Payments whose settlement would cost more are refused at verification ([fee ceilings](configuration.md#fee-ceilings)). |
| Inclusion-fee bid | `INCLUSION_FEE_*`                               | Tracks recent network fees between a floor and a cap, never beyond the cap.                                            |
| Reserve floor     | `SPONSOR_RESERVE_XLM`                           | Settlements are refused below this balance (`settle_exact_stellar_sponsor_unavailable`).                               |
| Hourly budget     | `MAX_SPONSOR_SPEND_XLM_PER_HOUR`                | Settlements are refused once this much fee was committed in the last hour, across replicas.                            |
| Readiness         | `MIN_SPONSOR_BALANCE_XLM`                       | `/ready` fails below this balance, so a load balancer can stop routing to the instance.                                |
| Rate limits       | `RATE_LIMIT_PER_MINUTE`                         | Requests per client address (IPv6: per /64) per minute, shared by all replicas with Postgres.                          |
| API keys          | `REQUIRE_API_KEY`, `API_KEY_SHA256`             | Restrict `/verify` and `/settle` to known callers; required to be set explicitly for pubnet.                           |

Alert on `rail402_sponsor_balance_stroops` approaching the readiness floor,
`rail402_settlements_total` failures by `reason`, `rail402_channels_in_use` equal to
`rail402_channels_total` (every channel busy), a rising `rail402_channel_lease_timeouts_total`,
`rail402_sponsor_fees_stroops_total{outcome="wasted"}`, any `rail402_sponsor_guard_refusals_total`, any
`rail402_sequence_conflicts_total{kind="bad_seq"}` (see below), any `rail402_settlements_unresolvable` above zero, rising
`rail402_rpc_transport_errors_total`, `rail402_rpc_ledger_age_seconds` above 60,
`rail402_contract_ttl_ledgers` below 120960 (about 7 days at 5 s ledgers),
`rail402_upto_authority_balance_stroops` above zero, any
`rail402_upto_ttl_keeper_actions_total{outcome="failed"}`, any
`rail402_search_index_builds_total{outcome!="ok"}`, and `rail402_background_errors_total`. `/health`
turns the same conditions into warnings.

A settlement recorded less than `SETTLE_RECONCILE_IDLE_MS` ago (by default `SETTLE_CONFIRM_TIMEOUT_MS` plus
5 seconds) is left to the request confirming it, on whichever replica it runs, so no replica's recovery pass
rebroadcasts another replica's in-flight settlement. A `txBadSeq` counted under
`rail402_sequence_conflicts_total{kind="bad_seq"}` is then a real conflict on any number of replicas. The
first broadcast of a settlement goes through `@x402/stellar`, which does not report the network's result
code, so a conflict (a channel's sequence used elsewhere) is counted on the rebroadcast that follows it, and
that settlement then fails. `try_again_later` counts a full network queue, which delays a submission without
changing it.

## Health, readiness and metrics

These endpoints are never rate-limited. `/health` and `/ready` need no key; `/metrics` needs one only
when `METRICS_TOKEN_SHA256` is set. Because `/health` and `/ready` are public, a failure appears there
only as its kind (`connection refused`, `host not found`, `timed out`, `HTTP 503`, or `failed`), followed
by "details in the service log"; the error itself, which can name internal hosts, database users or a
simulation's diagnostics, is logged. `/metrics` carries sponsor and authority balances and settlement
counts: set `METRICS_TOKEN_SHA256` on any deployment whose `/metrics` is reachable from outside.

- `GET /health` answers `200` whenever the process is up; the image's Docker `HEALTHCHECK` uses it. Its
  body is a snapshot the background poll rebuilds every 15 seconds, so answering it never waits on the
  network or the database:

  ```json
  {
    "status": "ok",
    "version": "0.4.2",
    "state": "healthy",
    "checkedAt": "2026-09-30T12:00:00.000Z",
    "warnings": [],
    "networks": {
      "stellar:testnet": {
        "rpc": { "ok": true, "latestLedger": 4941750, "ledgerAgeSeconds": 3, "transportErrors1h": 0 },
        "sponsor": {
          "address": "G…",
          "balanceStroops": "99875000000",
          "committed1hStroops": "1200000",
          "wasted1hStroops": "0"
        },
        "channels": { "total": 8, "inUse": 0, "leaseWaitP95Ms": 4.8, "leaseTimeouts1h": 0 },
        "settlements": {
          "last1h": { "succeeded": 12, "failed": 0, "expired": 0, "pending": 0 },
          "unfinished": 0,
          "unresolvable": 0,
          "repeats1h": 1
        },
        "sequenceConflicts1h": 0,
        "contracts": {
          "USDC": { "id": "CBIELTK6…DAMA", "instanceTtlLedgers": 2245736 },
          "upto": { "id": "CBTVKCHL…TU7U", "instanceTtlLedgers": 3108544, "codeTtlLedgers": 3108545 }
        },
        "upto": {
          "contract": "CBTVKCHLSGQ3WSV3NKSU6FZR4FZMC6ENMDMXUS5XQ66HYVUUHYE3TU7U",
          "authority": {
            "address": "G…",
            "present": true,
            "balanceStroops": "0",
            "spendableStroops": "0",
            "tokens": []
          },
          "keeper": {
            "enabled": true,
            "autoRestore": true,
            "checkedAt": "2026-09-30T11:58:00.000Z",
            "plan": "none",
            "lastAction": null,
            "error": null
          }
        }
      }
    },
    "catalog": {
      "listings": { "pending": 0, "published": 14, "quarantined": 1 },
      "outboxPending": 0,
      "outcomes1h": { "settle": { "success": 3 }, "origin_check": { "success": 3 } }
    },
    "search": {
      "indexRevision": 42,
      "indexAgeSeconds": 4,
      "lastBuild": "ok",
      "embeddingFailures1h": 0,
      "p50Ms": 3.1,
      "p95Ms": 9.4
    }
  }
  ```

  `state` is `starting` until the first poll finished, `degraded` while any warning has severity
  `critical`, and `healthy` otherwise. Each warning has a stable `code`, a `severity` and a `message`,
  and names its `network` and `contract` where it applies:

  | Code                             | Severity | When                                                                                                        |
  | -------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
  | `rpc_unhealthy`                  | critical | The RPC did not answer the last poll                                                                        |
  | `ledger_stale`                   | critical | The RPC's latest ledger closed more than 60 s ago                                                           |
  | `sponsor_below_floor`            | critical | The sponsor holds less than `MIN_SPONSOR_BALANCE_XLM`                                                       |
  | `settlement_ledger_unreadable`   | critical | The settlement ledger could not be read                                                                     |
  | `settlements_unresolvable`       | critical | `rail402_settlements_unresolvable` is above zero (see "State, backups and recovery")                        |
  | `contract_missing`               | critical | A watched contract is not in the live ledger state: never deployed, or archived                             |
  | `contract_archived`              | critical | A watched contract's instance or code entry is archived; payments that call it fail until it is restored    |
  | `contract_ttl_critical`          | critical | A watched contract's instance or code is archived in fewer than `CONTRACT_TTL_CRITICAL_LEDGERS`             |
  | `contract_ttl_low`               | warning  | … in fewer than `CONTRACT_TTL_WARN_LEDGERS`                                                                 |
  | `contract_ttl_unchecked`         | warning  | The last TTL check could not read the ledger (the previous readings are shown)                              |
  | `catalog_unreadable`             | critical | The catalog store could not be read                                                                         |
  | `search_index_failed`            | critical | The last search index build could not read the catalog                                                      |
  | `search_index_degraded`          | warning  | The search index was built without embeddings (lexical-only, partial results)                               |
  | `upto_authority_missing`         | critical | The `upto` settlement authority does not exist; `upto` payments are refused, and each poll creates it again |
  | `upto_authority_funded`          | warning  | The `upto` settlement authority can spend XLM beyond its reserve; it should hold nothing it can spend       |
  | `upto_authority_holds_tokens`    | warning  | The `upto` settlement authority holds a balance of an accepted token; it never receives payments            |
  | `upto_contract_restore_required` | critical | The `upto` contract is archived and automatic restoration is off; an operator must restore it               |
  | `upto_ttl_keeper_failed`         | warning  | The last extension or restoration round of the `upto` contract failed                                       |

  "1h" figures count the last hour from per-minute samples of the service's counters (since the start
  of the process while it is younger than an hour); `last1h` counts the settlements claimed in the last
  hour by their current state, across replicas with Postgres. Latencies are `null` without
  observations. `upto` appears on networks that serve it. Everything shown is already public: the
  sponsor and authority addresses are in `/supported`.

- `GET /ready` answers `200` when every check passes and `503` otherwise, with the checks in the body:
  `database` (Postgres only), and per network `<network>:rpc`, `<network>:sponsor` (balance at least
  `MIN_SPONSOR_BALANCE_XLM`), `<network>:assets` (every accepted token is deployed with its configured
  decimals; see [Accepted assets](/facilitator/assets)) and `<network>:channels` (every channel account
  exists), plus `search` (the first search index is built) when the Bazaar is enabled. Route load
  balancers and deploy health checks here.
- `GET /metrics` serves Prometheus metrics. It is public unless `METRICS_TOKEN_SHA256` holds the SHA-256
  hex digest of a token; then it requires `Authorization: Bearer <token>` and answers `401` with the
  code `unauthorized` otherwise. Set it on pubnet. Every label takes values from a bounded set:
  networks, schemes and reason codes from the [registry](/reference/error-codes) (else `unregistered`),
  RPC methods from a fixed list (else `other`), contract aliases from configuration. Series whose labels
  are known at startup are exported at `0` from the first scrape: per configured network and scheme the
  `success` settlements and `valid` verifications, every `kind` of sequence conflict and RPC or Horizon
  transport error, guard refusals, lease timeouts, ledger-read and TTL-check failures, and the search
  index builds, embedding failures and search latency histogram. Alerts on them need no `absent()` guard.

| Metric                                          | Labels                                               | Meaning                                                                                                                                                                                                                                                                  |
| ----------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `rail402_verifications_total`                   | `network`, `scheme`, `outcome`, `reason`             | Verifications; `reason` is the `invalidReason` code, or `unregistered` for a code outside the [registry](/reference/error-codes)                                                                                                                                         |
| `rail402_settlements_total`                     | `network`, `scheme`, `outcome`, `reason`             | Settle responses other than repeats: `success`, `failure` or `pending`; `reason` is the `errorReason` code, or `unregistered`                                                                                                                                            |
| `rail402_settlement_repeats_total`              | `network`, `scheme`                                  | Settle requests answered from an earlier settlement of the same payment                                                                                                                                                                                                  |
| `rail402_settlements_finalized_total`           | `network`, `scheme`, `state`, `reason`, `settled_by` | Settlements reaching a final state (`succeeded`, `failed`, `expired`), once each                                                                                                                                                                                         |
| `rail402_settlements_third_party_total`         | `network`, `scheme`                                  | Payments another transaction landed first with the payer's authorization exactly as signed, answered as settled in that transaction (see verification rules, "Front-running")                                                                                            |
| `rail402_settlement_duration_seconds`           | `network`, `scheme`, `state`                         | Histogram of the time from claiming a settlement to its final state                                                                                                                                                                                                      |
| `rail402_settlements_reconciled_total`          | `network`, `outcome`                                 | Reconciliation attempts of recorded settlements: the final state reached, `pending`, or `unresolvable`                                                                                                                                                                   |
| `rail402_settlements_unfinished`                | `network`                                            | Settlements broadcast and not final yet                                                                                                                                                                                                                                  |
| `rail402_settlements_unresolvable`              | `network`                                            | Unfinished settlements past their time bound whose landing can be neither proven nor ruled out: the RPC no longer retains their ledgers, or the payer's authorization was consumed by a transaction that could not be identified (see "State, backups and recovery")     |
| `rail402_settlement_ledger_read_failures_total` | `network`                                            | Verifications that skipped the settlement-ledger check because the ledger could not be read                                                                                                                                                                              |
| `rail402_sponsor_balance_stroops`               | `network`                                            | Sponsor XLM balance                                                                                                                                                                                                                                                      |
| `rail402_sponsor_fees_stroops_total`            | `network`, `outcome`                                 | Fees charged to the sponsor for included settlements: `charged` when they succeeded, `wasted` when they failed on-chain, including when another transaction landed the payment first                                                                                     |
| `rail402_sponsor_fees_committed_stroops`        | `network`                                            | Upper bound of the fees committed in the last hour (the recorded envelopes' maximum fees), across replicas; the hourly budget compares against it                                                                                                                        |
| `rail402_sponsor_guard_refusals_total`          | `network`, `reason`                                  | Settlements refused to protect the sponsor: `reserve` (balance below `SPONSOR_RESERVE_XLM`) or `budget` (`MAX_SPONSOR_SPEND_XLM_PER_HOUR` reached)                                                                                                                       |
| `rail402_channels_in_use`                       | `network`                                            | Channel accounts leased by a settlement, read from the channel pool at each scrape                                                                                                                                                                                       |
| `rail402_channels_total`                        | `network`                                            | Configured channel accounts                                                                                                                                                                                                                                              |
| `rail402_channel_lease_wait_seconds`            | `network`                                            | Histogram of the time a settlement waited for a channel account                                                                                                                                                                                                          |
| `rail402_channel_lease_timeouts_total`          | `network`                                            | Settlements refused because no channel account freed up within `SETTLE_CHANNEL_WAIT_MS`                                                                                                                                                                                  |
| `rail402_submissions_total`                     | `network`, `status`                                  | Settlement transaction submissions by the network's answer (`PENDING`, `DUPLICATE`, `TRY_AGAIN_LATER`, `ERROR`, or `UPSTREAM_ERROR` for a failed first submission that is then rebroadcast)                                                                              |
| `rail402_sequence_conflicts_total`              | `network`, `kind`                                    | Submissions refused with `txBadSeq` (`bad_seq`) or `TRY_AGAIN_LATER` (`try_again_later`); a rebroadcast of bytes the network already applied also answers `txBadSeq`                                                                                                     |
| `rail402_rpc_requests_total`                    | `network`, `method`, `outcome`                       | Stellar RPC calls Rail402 makes itself, by JSON-RPC method (a fixed list, else `other`) and outcome: `ok`, `rpc_error` (a JSON-RPC error answer), `http_error`, `timeout` or `network_error`                                                                             |
| `rail402_rpc_request_duration_seconds`          | `network`, `method`                                  | Histogram of the duration of those calls                                                                                                                                                                                                                                 |
| `rail402_rpc_transport_errors_total`            | `network`, `target`, `kind`                          | Failed HTTP exchanges with the configured RPC (`rpc`) or the public Horizon that `@x402/stellar` reads its ledger-time estimate from (`horizon`), from any client in the process, including the upstream verifier's own: `network` (no answer), `http_5xx` or `http_429` |
| `rail402_rpc_latest_ledger`                     | `network`                                            | Latest ledger the RPC reported at the last poll                                                                                                                                                                                                                          |
| `rail402_rpc_ledger_age_seconds`                | `network`                                            | Seconds since that ledger closed, at the last poll                                                                                                                                                                                                                       |
| `rail402_contract_ttl_ledgers`                  | `network`, `contract`, `entry`                       | Ledgers until a watched contract's `instance` or `code` entry is archived; negative once it is. `contract` is the alias: an accepted asset's symbol, `upto` for the `upto` settlement contract, or an alias from `TTL_CONTRACTS`                                         |
| `rail402_contract_ttl_check_errors_total`       | `network`                                            | Contract TTL checks that could not read the ledger                                                                                                                                                                                                                       |
| `rail402_upto_settlements_total`                | `network`, `amount`, `mode`                          | Successful `upto` settlements other than repeats, by the amount settled against the signed cap (`zero`, `partial`, `max`) and whether a transaction carried it (`onchain`) or the authorization was consumed without one (`offchain`)                                    |
| `rail402_upto_authority_balance_stroops`        | `network`                                            | Native balance of the `upto` settlement authority; it holds nothing, so anything above zero needs an operator                                                                                                                                                            |
| `rail402_upto_ttl_keeper_actions_total`         | `network`, `action`, `outcome`                       | Extensions (`extend`) and restorations (`restore`) of the `upto` contract by the keeper or an operator command, `ok` or `failed`                                                                                                                                         |
| `rail402_catalog_outcomes_total`                | `phase`, `status`, `code`                            | Bazaar outcomes: `verify` and `settle` as reported in `EXTENSION-RESPONSES`, and the background phases `outbox` (queued settlements), `origin_check` (`origin_confirmed`, `origin_withdrawn`, `origin_retry`) and `enrich` (`facts_refreshed`, `facts_unavailable`)      |
| `rail402_catalog_listings`                      | `state`                                              | Catalog listings by state: `pending`, `published`, `quarantined`                                                                                                                                                                                                         |
| `rail402_catalog_outbox_pending`                |                                                      | Settled payments queued for cataloging and not cataloged yet                                                                                                                                                                                                             |
| `rail402_search_index_builds_total`             | `outcome`                                            | Search index builds: `ok`, `degraded` (the embedder failed; the index serves lexical-only, partial results) or `failed` (the catalog could not be read; the previous index stays)                                                                                        |
| `rail402_search_embedding_failures_total`       | `stage`                                              | Embeddings that failed or ran out of time, of a listing (`document`) or a query (`query`)                                                                                                                                                                                |
| `rail402_search_index_age_seconds`              |                                                      | Seconds since the search index was last confirmed current with the catalog                                                                                                                                                                                               |
| `rail402_search_duration_seconds`               | `method`, `partial`                                  | Histogram of the time to answer a search, by `method` (`hybrid`, `lexical`, `filter`) and whether the results were partial                                                                                                                                               |
| `rail402_http_request_duration_seconds`         | `method`, `route`, `status`                          | Request latency histogram                                                                                                                                                                                                                                                |
| `rail402_background_errors_total`               | `task`                                               | Failures of reconciliation, polling, origin checks, indexing                                                                                                                                                                                                             |
| `rail402_rate_limited_total`                    |                                                      | Requests refused by the rate limiter                                                                                                                                                                                                                                     |

Node.js process metrics are exported with the prefix `rail402_process_`.

### Contract TTLs

Every Soroban contract a payment touches lives in ledger entries with a time to live. Once the network
passes an entry's `liveUntilLedgerSeq` it is archived, and every payment that touches the contract
fails until someone restores it. Rail402 reads the instance entry of every accepted asset's contract
(the USDC Stellar Asset Contract by default), and the code entry of WASM contracts, every
`CONTRACT_TTL_POLL_MS`, with two `getLedgerEntries` calls per network. On a network that serves `upto`,
the settlement contract is watched too, under the alias `upto`. More contracts are watched with
`TESTNET_TTL_CONTRACTS` / `PUBNET_TTL_CONTRACTS`. Extend a contract's TTL before it reaches
`CONTRACT_TTL_CRITICAL_LEDGERS`, for example with the Stellar CLI:
`stellar contract extend --id <C…> --ledgers-to-extend 535680 --source-account <account> --network <network>`
extends the instance, and `--wasm-hash <hash>` instead of `--id` extends the code.

### The `upto` settlement contract

The contract, its deployments and how to verify them are described in
[upto settlement contract](/reference/upto-contract); how `upto` payments work in [upto payments](/facilitator/upto).
The `upto` contract stores nothing per payment, so only its instance entry and its code entry pay rent.
Rail402 keeps them live itself. After each TTL reading, the keeper (`UPTO_TTL_KEEPER`) extends both
entries once either has fewer than `UPTO_TTL_EXTEND_BELOW_LEDGERS` left, to
`UPTO_TTL_EXTEND_TO_LEDGERS` (by default the network maximum less one day). The sponsor pays, and a
Postgres advisory lock lets one replica at a time do it. Extending and restoring are permissionless:
anyone may pay for them, and neither changes the contract.

A payment never extends or restores the contract. Since protocol 23 a freshly simulated invocation of
an archived contract would restore it inside the transaction and bill the rent to whoever pays the fee,
so while the contract is archived `/verify` and `/settle` refuse `upto` payments with
`invalid_upto_stellar_settlement_contract_archived` and submit nothing. `exact` payments are not
affected, and `/ready` does not fail. Where `UPTO_TTL_AUTO_RESTORE` is on (testnet by default) the
keeper restores the entries and extends them in its next round. Elsewhere `/health` reports
`upto_contract_restore_required` and an operator restores the contract:

1. Detect: `/health` shows `contract_archived` for `upto` (or `rail402_contract_ttl_ledgers{contract="upto"}`
   is negative), and `upto ttl status` reports `"archived"` entries and the plan `restore_required`.
2. Restore and extend, with the service's environment:

   ```sh
   node apps/rail402/dist/upto.js ttl status  --network stellar:pubnet
   node apps/rail402/dist/upto.js ttl restore --network stellar:pubnet
   ```

   `ttl restore` restores the archived entries, then extends both; the sponsor pays. It prints the
   transactions and the entries' remaining ledgers. The Stellar CLI does the same from any funded
   account: `stellar contract restore --id <C…> --durability persistent` and
   `stellar contract restore --wasm-hash <hash>`, then `stellar contract extend` for both with
   `--ledgers-to-extend`.

3. Verify: `ttl status` shows no archived entry and a `liveUntilLedgerSeq` in the future
   (`instanceLiveUntil`, `codeLiveUntil`), and the next `/health` shows no `upto` warning.

`upto ttl extend [--to LEDGERS]` extends both entries now, whatever their TTL. A restored entry comes
back with the network's minimum TTL, so a restoration is always followed by an extension. Both commands
take the keeper's lock, so they never run alongside a replica's keeper.

After deploying a contract of your own, extend it at once: a new instance lives only the network's
minimum TTL (about 7 days on testnet).

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

`provision` also creates the network's `upto` settlement authority: like a channel, it is derived from the
sponsor's secret, holds no balance and has its reserve paid by the sponsor. It is the operation source of
every `upto` settlement and never pays or receives anything, so `status` reports it under `authority` with
its balance, which must stay `0`. On a network that serves `upto`, the service creates the authority at
startup when it is missing, on pubnet too, one replica at a time; if it cannot yet (an unfunded sponsor),
the service starts anyway, refuses `upto` payments with `settle_upto_stellar_authority_unavailable` and
creates it on a later poll. `upto.js authority provision` creates it alone and `upto.js authority status`
reports it.

`status` also reports unfinished settlements, leased channels and the transaction hashes of unresolvable
settlements (`unresolvableSettlements`, see "State, backups and recovery") from Postgres. `retire` merges every
channel and the authority back into the sponsor, which returns their reserves; it refuses while any settlement
on that network is unfinished or any channel is leased. With `STORE=memory` there is no durable state to check,
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

The `upto` settlement authority rotates with the sponsor, because it is derived from it. Every `upto`
authorization names the authority it was signed for (`extra.facilitatorAddress`), and only that
authority can settle it. A payment verified before the switch and not settled by then cannot be settled
by the service with the new secret: it is refused with
`invalid_upto_stellar_requirements_facilitator_mismatch`, and the buyer is not charged. Keep the old
secret and the old authority account (do not run `channels retire` yet) until `TIMEOUT_MAX_SECONDS`
(300 s by default) after the switch: until then a service started with the old secret can still settle
those payments, and afterwards every authorization naming the old authority has expired.

Sellers copy the authority into their `402` responses from `/supported`, and the stock x402 resource
server reads `/supported` when it initializes, which the `@x402/express` and `@x402/hono` middleware do
once, at startup. After the
switch, a running seller keeps offering the old authority, and every new `upto` payment to it is refused
with `invalid_upto_stellar_requirements_facilitator_mismatch` until the seller restarts or re-initializes
its resource server. Tell the sellers that use the service to restart right after the switch; `exact`
payments are not affected. See [the settlement authority](/facilitator/upto#the-settlement-authority).

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
  day, network, operation, outcome and asset, with the settled volume. A repeated `/settle` for a
  payment already settled is counted with the outcome `repeat` and no volume. Requests refused before that
  (transport errors, `invalid_network`, `unsupported_scheme`, HTTP 401) and requests answered with
  HTTP 500 are not counted. Callers with a key read their own usage at `GET /usage`. With Postgres
  the counts are shared by every replica.
- **Service fee.** `SERVICE_FEE_PER_SETTLEMENT_USD` (default `0`) accrues a per-settlement fee in
  the metering records for billing off-chain, for original successful settlements only. Nothing is charged on-chain and no extra transaction
  is added to the payment path.

## State, backups and recovery

Everything durable lives in Postgres: the settlement ledger (claims, recorded envelopes, outcomes),
channel leases, the Bazaar catalog and its version history, rate-limit windows and usage. The
service itself is stateless, so any number of replicas can run against one database.

- Replicas share the channel pool: a channel is leased with `FOR UPDATE SKIP LOCKED`, so two replicas
  never lease the same channel, and a settlement's final state is written once, by compare-and-set.
  Two replicas on one database and one sponsor settle 3 batches of 20 concurrent payments, each sent
  to one replica and at the same time to the other, with 20 transactions per batch, identical answers
  for every pair, every envelope sent once and no sequence conflict
  (`apps/rail402/test/replicas.integration.test.ts`). A replica's reconciler leaves a settlement to the
  request confirming it, on this replica or another, until it was recorded `SETTLE_RECONCILE_IDLE_MS` ago;
  after a crash the settlement is driven from its recorded bytes once that time has passed. A single
  replica can set `SETTLE_RECONCILE_IDLE_MS=0` to drive them at once after a restart.

- Use a managed Postgres with point-in-time recovery. A restored database is safe: settlements
  recorded as submitted are finished by the reconciler from their recorded bytes and the chain,
  and a payment already on-chain can never be submitted again because its authorization nonce is
  spent.
- A crash at any point is recovered by the next start: claims without an envelope expire and the
  payment can be retried, and recorded envelopes are reconciled once `SETTLE_RECONCILE_IDLE_MS` passed (see "Settlement" in
  [verification-rules.md](verification-rules.md)). The service, one replica with
  `SETTLE_RECONCILE_IDLE_MS=0`, is killed with `SIGKILL` in tests at
  each point where a crash could lose track of a payment: after the network accepted the transaction,
  after the envelope was recorded but before it was broadcast, after inclusion but before the result
  was seen, and while the transaction's time bound passes. Each time the restarted process finds or
  rebroadcasts the original bytes, never a replacement; funds move at most once and the channel is
  released (`apps/rail402/test/crash-recovery.integration.test.ts`).
- Recovery may send the identical recorded transaction several times: while it waits for the chain to
  show it final, the reconciler rebroadcasts the same bytes every few poll intervals, and a copy the
  network already holds is answered `DUPLICATE` (or `txBadSeq` once it applied). It never builds, signs
  or sends a different transaction for the same payment. In the recorded testnet crash runs a restarted
  process sent the same envelope up to five times, and every run shows exactly one distinct envelope and
  funds moving at most once (see the conformance report, "Crash recovery").
- A settlement past its time or ledger bound is declared `expired` (or failed) only on proof that it
  did not land: its own hash and its inner hash (in case someone wrapped it in their own fee bump)
  are not found, and the payer's authorization nonce is unconsumed, or the RPC still retains every
  ledger since the claim (with a 60 s margin). Two cases leave that unproven, and the settlement stays
  unfinished instead:
  - the RPC no longer retains the ledgers it could have landed in (it was recorded before an outage
    longer than the retention window);
  - the payer's authorization nonce was consumed, but the transaction that consumed it could not be
    identified on chain.

  A failed read of the nonce also leaves the proof open for that reconciliation pass; the next pass
  tries again. `rail402_settlements_unresolvable` counts the unfinished settlements of the last pass,
  the service logs `settlement unresolvable` with the transaction hash, and `channels status` lists the
  hash. To resolve one, look the transaction hash and the payer's recent transactions up in Horizon, a
  history archive or an explorer such as stellar.expert: a transaction that carried the payer's signed
  authorization settled the payment, and none means no funds moved. Nothing is ever resubmitted for
  such a settlement, and its channel stays leased until it is resolved, because the transaction may
  have consumed the channel's sequence number.

- `STORE=memory` is for local development and conformance runs only: nothing survives a restart,
  and only one replica is safe.

## Release controls

CI (`.github/workflows/ci.yml`) runs on every push to `main` and on every pull request: formatting,
lint, type checking, unit tests, the licence gate with a current
[dependency report](dependency-licenses.md), integration tests against Postgres and a local Stellar
network, and a build of the container image. CI also runs the search evaluation gate
(`pnpm eval:check`: nDCG@10 and Recall@20 may not drop more than 0.02 below the tagged baseline,
hybrid must match or beat BM25, zero filter violations), `pnpm pack:check` (every publishable package
installs and runs from its tarball alone), the contract crates' formatting, lints and tests, and container
builds that reproduce the committed contract WASM. The conformance evidence is recorded with one command,
`pnpm evidence` ([Conformance evidence](/reference/conformance#reproduce)).

A version tag (`v*.*.*`) publishes the container image to the GitHub Container Registry
(`.github/workflows/release.yml`). The npm packages are published by hand, from the tagged commit:

1. Check out the tag on a clean tree and run `pnpm install --frozen-lockfile`, `pnpm verify`,
   `pnpm build` and `pnpm pack:check`; every package carries the tag's version.
2. Publish every public workspace package with `pnpm -r publish --access public`, from an npm account
   with two-factor authentication for publishing; pnpm rewrites `workspace:` dependencies to the released
   version.
3. Check the published versions with `npm view @rail402.dev/<package> version`.
