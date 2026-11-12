---
title: Operations
description: Keys and custody, sponsor protection, channel accounts, metering, recovery and release controls.
---

How to run Rail402 safely: which keys exist and what they can do, how to rotate them, what limits
protect the sponsor, how callers are authenticated and metered, and how state survives failures.
Configuration variables are described in [Configuration](/configuration).

## Keys and custody

Rail402 holds one secret per network: the **sponsor** seed (`TESTNET_SPONSOR_SECRET`,
`PUBNET_SPONSOR_SECRET`). Give it to the service as a file from the platform's secret store
(`<NAME>_FILE`, see [secrets from files](/configuration#secrets-from-files)); with pubnet enabled the
service refuses it, the database URL and the search cursor secret from the environment, and requires the
pubnet sponsor file to be network-tagged and readable by its owner only. It never belongs in the
repository, the image or a log line. As a second line of defence the logger redacts
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

**Pubnet sponsor signers.** The service holds the sponsor key, so on pubnet that key must not be able to
change the account's signers or merge it. At startup the service reads the sponsor account and refuses
(with several networks: holds pubnet, `sponsor_signers_unsafe`) unless the key meets the medium threshold
(fee bumps need low; provisioning channels and the authority and the `upto` keeper need medium) but not
the high one, and the cold key named in `PUBNET_SPONSOR_COLD_SIGNER`, kept off the server, reaches the
high threshold on its own. It must be the only way to reach high: the hot key and every other signer
together stay below it, no key derived from the sponsor seed (a channel or the `upto` authority) may be a
signer at all, and pre-authorized transaction, hash-x and signed-payload signers count toward that sum (a
hash-x preimage is public once used). For example: add the cold key with weight 2, then set the master
weight to 1 and the thresholds to low 1, medium 1, high 2. A stolen hot key then spends at most the hot
balance; the cold key can still replace it. `PUBNET_ALLOW_SINGLE_SIGNER_SPONSOR=true` skips the check. The service does not split fee bumps onto a
separate low-threshold key: the same process needs a medium-threshold key for provisioning and contract
upkeep, and channels and the authority derive from the sponsor seed, so a second hot key would not
reduce what a compromise of the process exposes.

Rail402 is non-custodial by construction. Verification refuses any payment in which a facilitator
account is the payer, a transaction or operation source, or a party to an authorization, and the
payer's signed authorization fixes the asset, recipient and amount; changing any of them after
signing fails signature verification (see [Verification rules](/verification-rules)). The
worst case after a leaked sponsor seed is therefore the loss of the sponsor's own XLM, which is why
it should hold only a working balance.

### Mainnet sponsor custody

On a real-funds network the sponsor is a **hot** account that holds a working balance, and a **cold
treasury** account, kept offline on a hardware wallet, funds it and controls it. The tools are in
[`deploy/keys`](https://github.com/tolgayayci/rail402/tree/main/deploy/keys) and
`deploy/stellar-keys.ts`:

1. **Generate the sponsor seed offline**, on a machine that has never been and will not be connected to a
   network, with the key generator and Node image checked before they cross over:
   - on a networked machine, take `deploy/stellar-keys.ts` from the signed release tag and note its
     SHA-256; pull the Node image the Dockerfiles name by digest
     (`node:24.19.0-trixie-slim@sha256:ab3eebe9…`, the full digest is in `Dockerfile`) and save it with
     `docker save`;
   - carry both to the offline machine, `docker load` the image and check that `docker image inspect`
     shows the same digest and that the script's SHA-256 matches;
   - write the key file to removable media:
     `docker run --rm --network none -v "$PWD:/w" -w /w node@sha256:<digest> node stellar-keys.ts --key-file stellar:pubnet --out pubnet-sponsor.key`.
     It prints the public key and writes a file of mode `0400`: the tag line
     `# rail402-key network=stellar:pubnet`, then the seed. The service refuses a pubnet sponsor key file
     without that tag, so a seed handled as a testnet key cannot become the mainnet sponsor by mistake.
     Record the public key with the key custodians; it is the recorded sponsor address of step 4. There is no
     Friendbot on pubnet: the treasury creates and funds the account. Generating the seed in a container
     without network on the service's own host is not offline generation; it is acceptable only for a hot key
     that lives on that host anyway, and should be named as such.
2. **Store the key file as a file secret.** Compose delivers a `file:` secret as a bind mount of the host
   file at `/run/secrets/<name>`: the container sees the host file's mode and owner, and `mode`, `uid`
   and `gid` in the compose file are ignored for file secrets. Copy the key file unchanged, tag included,
   make it mode `0400`, owned by the user the service runs as (uid 1000 in the image; with user-namespace
   remapping, the host uid that maps to it), so the service can read it and no other user can, and point
   `PUBNET_SPONSOR_SECRET_FILE` at it. `node deploy/stellar-keys.ts --public-of <file>` reads the public
   key back, to compare with the record. Shred the copy on the removable media once the treasury holds its
   backup.
3. **Add the cold signer and set thresholds**, with the seed staying on the offline machine:
   - on the networked machine, `node deploy/keys/cli.ts signer-setup --network pubnet --sponsor G… --cold G…
--unsigned` prints a review (network, source, each operation, transaction hash) and the unsigned
     transaction (`xdr …`); save the XDR to a file and carry it to the offline machine (with
     `--sequence <the sponsor's sequence>` the command needs no network either);
   - on the offline machine, with the same checked `stellar-keys.ts` and Node image as step 1,
     `node stellar-keys.ts --sign-xdr setup.xdr --with pubnet-sponsor.key --network stellar:pubnet` prints
     the source account, the transaction hash and the signed transaction. It uses only Node's own
     crypto, refuses a key file tagged for another network and an envelope that is already signed. Check
     that the source and the hash match the review;
   - carry only the signed XDR back and submit it (for example `curl -d tx=<xdr>
https://horizon.stellar.org/transactions`).

   The setup gives the hot key weight 10 and the cold key weight 20, with thresholds low 1, medium 10, high 20:
   the hot key can sponsor fees, create channel accounts and pay (medium), but only the cold key can
   change signers or thresholds or merge the account (high). `check-signers` reads the account back and
   fails unless that holds. Then set `PUBNET_SPONSOR_COLD_SIGNER` to the cold key's `G…` address: pubnet
   does not start without it (`config_pubnet_cold_signer_missing`), and is held with
   `sponsor_signers_unsafe` while the signer set does not match it.

4. **Top up from the treasury.** `node deploy/keys/cli.ts top-up --network pubnet --treasury G…
--sponsor G… --recorded-sponsor <file> --amount <XLM>` refuses any destination other than the
   sponsor address recorded at step 1, and prints the review and the unsigned transaction for the
   hardware wallet; compare the hash the device shows with the review before signing.

5. **Register the hosted accounts with the Explorer** (the hosted Rail402 service only; a self-hosted
   instance is listed, if at all, as its operator's facilitator). Before the service settles on pubnet,
   add the sponsor, the channel accounts and the `upto` settlement authority that `/supported`
   advertises to `packages/x402-index/registry/pubnet.json` as accounts of the `rail402` facilitator,
   from the ledger the service starts settling at, with the archived `/supported` answer as evidence,
   and bump `registryVersion` ([the registry](/reference/indexing-rules)). Once the service runs,
   `pnpm --filter @rail402.dev/explorer registry-check --hosted-pubnet <service URL> --skip-wasm` must
   report every advertised account as `ok`. Restart every Explorer indexer after the registry change:
   at start it re-attributes stored rows under the new registry.

`node deploy/keys/cli.ts rehearse` runs steps 3 and 4 and the leak response below on the testnet with
fresh accounts and checks the outcome: the setup is signed the offline way (`--sign-xdr`'s code); after
it the hot key alone fails to remove the cold signer (`op_bad_auth`), still creates an account, and a
top-up to any address but the recorded sponsor is refused before it is built. For the leak response it
prepares the cold key's freeze, then has the hot key bump the sponsor's sequence (as the holder of a
leaked seed could); the freeze still applies, a separate sweep follows, and afterwards a payment signed
by the hot key alone is refused (`tx_bad_auth`).

**When the hot seed leaks, lock it out first.** `node deploy/keys/cli.ts freeze --network pubnet
--sponsor G… --cold G…` prints the review and the unsigned transaction for the cold key's hardware
wallet. It sets the hot key's weight to 0 on the sponsor, a high-threshold change only the cold key can
make. The cold treasury is the transaction's source and fee payer, and only the operation names the
sponsor, so the freeze does not use the sponsor's sequence number: the leaked seed cannot make it fail
by submitting its own transactions or bumping the sponsor's sequence. Once it applies, the leaked seed
can no longer pay, sponsor or fee-bump from the account, and the service with that seed stops settling,
so rotate next (below).

What the holder of the leaked seed can still do is spend the hot balance until the freeze applies:
payments and transactions it submits before the freeze, or earlier in the same ledger, go through. A
leaked hot seed therefore costs at most the hot balance it spends before the freeze applies, which the
hot balance itself caps. It cannot remove the cold signer, change the thresholds or merge the account.

Then **sweep** what is left: `node deploy/keys/cli.ts sweep --network pubnet --sponsor G… --cold G…
--amount <XLM>` builds a second cold-signed transaction, again from the cold account, that moves the
amount from the frozen sponsor to the treasury. Read the sponsor's balance after the freeze and leave
its reserve. The sweep is separate so that a balance spent before the freeze cannot make the freeze
fail; if the balance is lower than the amount, only the sweep fails (`op_underfunded`), and it can be
rebuilt with the smaller amount.

## Protecting the sponsor

| Control           | Setting                                                                        | Effect                                                                                                                                                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fee ceiling       | `MAX_TX_FEE_STROOPS`, `UPTO_MAX_TX_FEE_STROOPS`                                | Payments whose settlement would cost more are refused at verification ([fee ceilings](/configuration#fee-ceilings)).                                                                                                                                                                                       |
| Inclusion-fee bid | `INCLUSION_FEE_*`                                                              | Tracks recent network fees between a floor and a cap, never beyond the cap; pubnet's floor is at least 200.                                                                                                                                                                                                |
| Reserve floor     | `SPONSOR_RESERVE_XLM`                                                          | Settlements are refused below this balance (`settle_exact_stellar_sponsor_unavailable`).                                                                                                                                                                                                                   |
| Hourly budget     | `MAX_SPONSOR_SPEND_XLM_PER_HOUR`                                               | A settlement is admitted only while the fees committed in the last hour, plus its own fee ceiling, stay within the budget; the check and the claim are one atomic step across replicas, so concurrent settlements cannot overshoot it.                                                                     |
| Unknown balance   | (pubnet)                                                                       | Pubnet refuses settlements until the sponsor's balance has been read (`…_sponsor_unavailable`).                                                                                                                                                                                                            |
| Payer and payTo   | `MAX_SETTLEMENTS_PER_PAYER_PER_MINUTE`, `MAX_SETTLEMENTS_PER_PAYTO_PER_MINUTE` | Settlements one payer may start and one `payTo` may receive per minute (the `payTo` count is kept per access key, with one shared count for keyless callers); on by default on pubnet.                                                                                                                     |
| Failure cooldown  | `PAYER_FAILURES_PER_HOUR`                                                      | A payer whose settlements failed on-chain that often in the last hour is refused until the hour moves on. A failure counts once its settlement finishes: an `exact` one that leaves the payer's authorization usable finishes only once the authorization expired unused, up to `maxTimeoutSeconds` later. |
| Contract upkeep   | `UPTO_TTL_MAX_FEE_STROOPS`, `UPTO_TTL_DAILY_MAX_FEE_STROOPS`                   | The `upto` keeper's fees count toward the hourly budget and are capped per day.                                                                                                                                                                                                                            |
| Caller budget     | key `sponsorBudgetXlmPerHour`, `KEYLESS_SPONSOR_BUDGET_XLM_PER_HOUR`           | Each key, and keyless callers together, may commit only their own hourly fees (`…_caller_budget_exhausted`).                                                                                                                                                                                               |
| Readiness         | `MIN_SPONSOR_BALANCE_XLM`                                                      | `/ready` fails below this balance, so a load balancer can stop routing to the instance.                                                                                                                                                                                                                    |
| Rate limits       | `RATE_LIMIT_PER_MINUTE`                                                        | Requests per client address (IPv6: per /64) per minute, shared by all replicas with Postgres; a `/verify` or `/settle` with an access key per key, at least as many as the key's own limits allow.                                                                                                         |
| API keys          | `REQUIRE_API_KEY`, `API_KEY_SHA256`                                            | Restrict `/verify` and `/settle` to known callers; required to be set explicitly for pubnet.                                                                                                                                                                                                               |

Alert on `rail402_sponsor_balance_stroops` approaching the readiness floor (`rail402_sponsor_balance_floor_stroops`),
`rail402_settlements_total` failures by `reason`, `rail402_channels_in_use` equal to
`rail402_channels_total` (every channel busy), a rising `rail402_channel_lease_timeouts_total`,
`rail402_sponsor_fees_stroops_total{outcome="wasted"}`, any `rail402_sponsor_guard_refusals_total`, any
`rail402_sequence_conflicts_total{kind="bad_seq"}` (see below), any `rail402_settlements_unresolvable` above zero, rising
`rail402_rpc_transport_errors_total`, `rail402_rpc_ledger_age_seconds` above 60,
`rail402_inclusion_fee_pinned_total` rising (bids pinned at the cap or fee stats unreadable),
`rail402_contract_ttl_ledgers` below 120960 (about 7 days at 5 s ledgers),
`rail402_upto_authority_balance_stroops` above zero, any
`rail402_upto_ttl_keeper_actions_total{outcome="failed"}`, any
`rail402_search_index_builds_total{outcome!="ok"}`, and `rail402_background_errors_total`. `/health`
turns the same conditions into warnings. Alert per network as well: each network's `/ready/<network>`
(with two networks in one process neither gates `/ready`), and the share of each network's hourly budget
committed (`rail402_sponsor_budget_used_ratio`). On the database host, alert when WAL archiving fails or
falls behind, when the newest backup is old, and when a filesystem fills. The [operator runbook](/runbook) lists these conditions as
Prometheus alerts, each with a severity, an owner role, the first step and the recovery, and
[`deploy/monitoring`](https://github.com/tolgayayci/rail402/tree/main/deploy/monitoring) holds a ready
Prometheus, Alertmanager and blackbox configuration with those rules.

Each network reconciles on its own, with one round at a time per network: a network whose settlement
ledger or RPC fails or hangs never holds up another network's round (the failure is logged and counted
under `rail402_background_errors_total{task="reconcile"}`).

A settlement recorded less than `SETTLE_RECONCILE_IDLE_MS` ago (by default `SETTLE_CONFIRM_TIMEOUT_MS` plus
5 seconds) is left to the request confirming it, on whichever replica it runs, so no replica's recovery pass
rebroadcasts another replica's in-flight settlement. A `txBadSeq` counted under
`rail402_sequence_conflicts_total{kind="bad_seq"}` is then a real conflict on any number of replicas. The
first broadcast of a settlement goes through `@x402/stellar`, which does not report the network's result
code, so a conflict (a channel's sequence used elsewhere) is counted on the rebroadcast that follows it, and
that settlement then fails (an `exact` one once the payer's authorization expired unused, see below). `try_again_later` counts a full network queue, which delays a submission without
changing it.

A settlement finishes at such a conflict only on proof: the channel's sequence number has passed the
transaction's, and an RPC at or past that read finds neither its hash nor its inner hash. The payer's
authorization nonce is read too (and, when a send of its bytes may have been accepted, the inner hash once
more), and those reads must come from an RPC at or past the same ledger; a lagging provider, or another one
after a failover, leaves the settlement waiting (`rpc_behind`) instead of finishing it. Once the proof holds the
settlement's bytes can never apply, so it gives its channel back at once (quarantined, and released by nothing
later), whatever its outcome still waits for. Anyone who holds an `exact` payment can carry its authorization
in a transaction of their own until it expires: such a settlement finishes as settled through a copy that
landed, or as `settle_exact_stellar_transaction_submission_failed` once the authorization expired unused, and
`rail402_sequence_conflict_outcomes_total` counts the wait as `declined` with `may_be_public`.

## RPC providers

Each network can name several RPC providers, in order of preference (`RPC_URLS`, see
[Configuration](/configuration#per-network)). One is active at a time. Every settlement takes the
provider active when it is claimed and simulates and submits through it alone, so a switch never sends one
settlement through two providers; confirmation, reconciliation and the poll read through whichever is
active, and a settlement's recorded bytes may be rebroadcast through it (never a rebuilt transaction). Every
call of the service's own RPC clients fails after 10 seconds. The upstream `exact` verifier builds its own
client without a timeout, so `/verify` stops waiting for it after the same 10 seconds and answers
`unexpected_verify_error` (retry it); its settlement client is bounded by the claim window below. A
provider that stops answering therefore cannot hold a `/verify` request, nor a settlement past
its claim window: a settlement that has signed nothing 30 seconds after its claim stops there, signs nothing
afterwards, and is refused with `unexpected_settle_error` (retry it), so its channel is never leased to a
second settlement while it may still sign. The
15-second poll reads every provider's health: after the active one was unhealthy at two polls in a row the
first healthy provider in order takes over, and a higher-priority provider healthy at five polls in a row
takes back over. `/health` shows `rpc.active` and `rpc.providers` (aliases only; URLs, which often embed a
provider key, are never shown or logged) and the warning `rpc_failover_active` while a fallback serves;
`rail402_rpc_active`, `rail402_rpc_failovers_total` and the `provider` label of
`rail402_rpc_requests_total` follow it. With several networks served, pubnet requires two providers
unless `PUBNET_RPC_SINGLE_PROVIDER=true`.

## Serving per network

One process can serve testnet and pubnet. Each network has its own state: `starting`, `serving` or
`held`. A network that is starting or held refuses its own `/verify` and `/settle` with HTTP 503,
`service_unavailable`, `Retry-After: 30` and a reason naming the network and why (for example
`stellar:pubnet is not serving: its RPC cannot be reached. Retry later.`), while the other networks keep
serving. `/supported` keeps listing a held network's kinds.

At startup every network checks the chain at once: its accepted assets, its channel accounts and, with
`upto`, the settlement contract's code and authority. What a failed check does is set per network by
`ON_STARTUP_CHECK_FAILURE`: `exit` stops the process with exit code 78 when the chain contradicts the
configuration (the default with one network, as before), `hold` starts it with that network held (the
default with several), bounded by `STARTUP_TIMEOUT_MS`. A check that fails for any other reason, such as
an RPC that errors or does not answer, holds only that network in both modes; the others keep serving.
The 15-second poll repeats a held network's checks and serves it once they pass, without a restart.
Pubnet additionally serves only while every money-relevant fact of the last poll is good, and is held
otherwise:

| Hold reason                | When                                                                                          | Clears by itself    |
| -------------------------- | --------------------------------------------------------------------------------------------- | ------------------- |
| `rpc_unreachable`          | The RPC failed or did not answer the startup checks or (pubnet) the last poll                 | yes                 |
| `sponsor_missing`          | The sponsor account does not exist (at startup, when it must create accounts; pubnet: always) | yes                 |
| `sponsor_balance_unknown`  | (pubnet) No sponsor balance has been read yet                                                 | yes                 |
| `sponsor_below_reserve`    | (pubnet) The sponsor holds less than `SPONSOR_RESERVE_XLM`                                    | yes                 |
| `asset_unverified`         | (pubnet) An accepted asset could not be read yet                                              | yes                 |
| `channels_missing`         | The network refused the startup's channel creation, or (pubnet) not every channel exists      | yes                 |
| `provisioning_busy`        | Another replica held the provisioning lock for the whole startup wait (120 s)                 | yes                 |
| `asset_contradicts_config` | An accepted asset's decimals contradict its configuration                                     | no: fix and restart |
| `sponsor_signers_unsafe`   | (pubnet) The sponsor key meets the high threshold, or the cold signer does not reach it alone | yes                 |
| `upto_contract_mismatch`   | The live `upto` contract runs other code than `UPTO_WASM_HASH`                                | no: fix and restart |

Pubnet stays `starting` until its first poll. Static configuration errors (a missing setting, a secret in
the environment) are not held: they stop the whole process, so run `check-config` before a deploy (see
[Startup checks](/configuration#startup-checks)). `rail402_network_serving{network}` is 1 while a network
serves and `rail402_network_hold{network, reason}` is 1 for the reason it is held.

With several networks served and Postgres as the store, pubnet uses a connection pool of its own (5
connections, same database and role) for its settlement ledger, channel leases, request and per-party
limits, metering and the sponsor lock of its provisioning and `upto` contract TTL rounds, so testnet work
holding every shared connection cannot stall a pubnet settlement.
Every pool gives up on a connection after `DATABASE_ACQUIRE_TIMEOUT_MS`: a pubnet limiter that cannot get
one refuses with a code (HTTP 503 `service_unavailable`, or `settle_…_sponsor_unavailable` for the
per-party limits) instead of queueing the request; testnet serves without its network limit then.

The service-wide limit (`RATE_LIMIT_PER_MINUTE`) is checked before the request body is read, so only a
host listed in `PUBLIC_HOSTS`, or a process that serves pubnet alone, tells it the network. It is kept per
client address (an IPv6 client by its /64), except for a `/verify` or `/settle` with a usable access key:
that request is charged to a bucket of its key on every host, so keyless traffic of either network,
unknown paths and refused requests from the same address or /64 never use up a key holder's requests. On
a host listed in `PUBLIC_HOSTS` the key must be one that host's network admits; elsewhere any key that is
not revoked, expired or for discovery only, and a request whose network turns out not to admit the key
pays its address's limit as well, like any keyless request, so a key never carries keyless payments past
that limit. The key's bucket holds what the key may send a minute on all
its networks together (its `requestsPerMinute`, else `KEY_DEFAULT_REQUESTS_PER_MINUTE`, on each), and
never less than `RATE_LIMIT_PER_MINUTE`, so the key's per-network limits, applied once the body is read,
are the ones that refuse it. Where a request is known to be pubnet's (the pubnet host, or any host of a
process serving pubnet alone), the key is decided first, in memory: a key pubnet admits is limited
through pubnet's pool (the one pool when pubnet is served alone), and any other caller (keyless, or with
a key pubnet refuses) in the process only.
With `PUBNET_REQUIRE_API_KEY=true`, `/verify` and `/settle` then refuse such a caller before any database
work; with keyless pubnet they hold it to `PUBNET_RATE_LIMIT_PER_MINUTE` as well. So no pubnet `/verify` or
`/settle` on the pubnet host waits for a shared connection to be admitted, and no anonymous request there
takes a connection of the pool pubnet's settlements use for its per-address limit. With the Bazaar, the
discovery routes keep their limits on the discovery pools instead; without it, a `/discovery/` path is
limited like any other. With several networks, every other host uses the shared pool; serve pubnet callers
through the pubnet host. A limiter that cannot answer falls back to a
per-process bucket. A client already over its limit is refused from memory, without another write, until
its window ends; requests already on their way to the database when its first refusal comes back still
write. Two reads of pubnet's still use the shared pool: `/usage`, and cataloging a pubnet settlement's
discovery metadata, which a saturated shared pool delays (a `/settle` response waits at most 2 seconds for
it and then reports `processing`, a `/verify` preview at most 250 ms).

The discovery routes (`/discovery/*`) read the catalog and keep their per-address and internal-identity
limits through a pool of their own (`DISCOVERY_DATABASE_POOL_SIZE`, 5 connections by default, same
database and role) that gives up after `DISCOVERY_DATABASE_ACQUIRE_TIMEOUT_MS` (1 s), so discovery load
never holds a connection a settlement, its limits, metering or readiness need. The search index is built
through a pool of its own (2 connections, same acquire timeout) that no request takes, so discovery load
never holds a connection an index build needs; a search that finds a build failing answers from the
previous index. Ahead of every limit and database read, at most `DISCOVERY_MAX_IN_FLIGHT` discovery
requests (32) run at once, each counted until its response has been handed to its client's connection,
and `DISCOVERY_QUEUE_LENGTH` (64) wait, each
for at most `DISCOVERY_QUEUE_TIMEOUT_MS` (1 s); the rest are refused at once with `503`
`discovery_overloaded` and `Retry-After: 1`. A discovery read that gets no connection in time is refused the
same way, and an unreachable catalog database with `503` `discovery_catalog_unavailable`; discovery never
answers a busy database with a `500`. `rail402_discovery_shed_total{route, reason}` counts the refusals
(more than 20 for one reason in 10 minutes raises the Rail402DiscoveryShedding ticket), and `rail402_discovery_in_flight` and `rail402_discovery_queued` show the queue.
One client holds at most `DISCOVERY_MAX_IN_FLIGHT_PER_CLIENT` (8) of a lane's requests at once; more are
refused with `429` `rate_limited` and `Retry-After: 1`. A client is an address, or a forwarded client of a
`discovery-internal` key whose record sets `forwardedClientRequestsPerMinute`. A front end that forwards no
client (the Playground, the Explorer or the hosted MCP endpoint without such a key) is one client for all
its users, so give each front end a `discovery-internal` key; a key without `forwardedClientRequestsPerMinute`
is bounded by the lane only. Since a response the client does not take holds its request until
`RESPONSE_WRITE_TIMEOUT_MS` (30 s) passes, the slots also bound the discovery pages the process keeps for
clients that have not taken them. One client that reads slowly fills at most its share of a lane; clients
from enough addresses can still fill one, as with any discovery flood, and only for as long as they keep
asking.

Discovery admits in two lanes with these limits each: requests scoped to pubnet (`network=stellar:pubnet`
or a pubnet host) and every other request. With pubnet served next to testnet, the pubnet lane reads and
keeps its limits through a second discovery pool of `DISCOVERY_DATABASE_POOL_SIZE` connections, so a
testnet discovery flood never sheds pubnet discovery. With Postgres, one process opens at most the shared
pool (10), pubnet's (5), the discovery pools', the search index's (2) connections and one more for
readiness; size the database role for every replica's pools (see [Database roles](#database-roles)).

## Health, readiness and metrics

These endpoints are never rate-limited, and none of them takes a connection of a pool settlements use:
`/health` and `/metrics` answer from memory (the background work keeps what they show current), and
`/ready` probes the database through a connection of its own. `/health` and `/ready` need no key;
`/metrics` needs one only when `METRICS_TOKEN_SHA256` is set. Because `/health` and `/ready` are public, a failure appears there
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
    "version": "0.5.7",
    "state": "healthy",
    "checkedAt": "2026-09-30T12:00:00.000Z",
    "warnings": [],
    "networks": {
      "stellar:testnet": {
        "state": "serving",
        "holdReason": null,
        "servingSince": "2026-09-30T11:40:00.000Z",
        "status": "healthy",
        "rpc": { "ok": true, "latestLedger": 4941750, "ledgerAgeSeconds": 3, "transportErrors1h": 0 },
        "sponsor": {
          "address": "G…",
          "funded": true,
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
      "p95Ms": 9.4,
      "ranker": {
        "model": "all-minilm-l6-v2",
        "revision": "1110a243fdf4706b3f48f1d95db1a4f5529b4d41",
        "files": {
          "model": "6fd5d72fe4589f189f8ebc006442dbb529bb7ce38f8082112682524616046452",
          "tokenizer": "be50c3628f2bf5bb5e3a7f17b1f74611b2561a3a27eeab05e5aa30f411572037"
        },
        "similarityFloor": 0.3,
        "depth": 100,
        "embeddings": true,
        "searchPackage": "0.5.7",
        "evalBaseline": "search-eval-v1.1.0"
      }
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
  | `sponsor_budget_high`            | warning  | The fees committed in the last hour reached `SPONSOR_BUDGET_WARN_PERCENT` of the hourly budget              |
  | `rpc_failover_active`            | warning  | The primary RPC provider failed and a fallback serves (see "RPC providers")                                 |
  | `network_held`                   | critical | The network refuses `/verify` and `/settle` until its checks pass (see "Serving per network")               |

  "1h" figures count the last hour from per-minute samples of the service's counters (since the start
  of the process while it is younger than an hour); `last1h` counts the settlements claimed in the last
  hour by their current state, across replicas with Postgres. Latencies are `null` without
  observations. `upto` appears on networks that serve it. Everything shown is already public: the
  sponsor and authority addresses are in `/supported`. Each network also reports its own `state`
  (`starting`, `serving` or `held`), `holdReason`, `servingSince` and `status` (`degraded` while that
  network has a critical warning), so each network can be watched on its own. `sponsor.funded` says
  whether the balance is at least `MIN_SPONSOR_BALANCE_XLM`.

  For **pubnet**, the public `/health` shows `sponsor.funded` but leaves out the sponsor balance, the
  committed and wasted fees, channels in use and lease waits, its warnings carry no balances, and it
  leaves out `sponsor_budget_high` altogether, so nobody can time a drain of the mainnet budget from
  the outside. Testnet is shown in full. The public `/health` never shows access keys: their counts,
  last reload and the SHA-256 of the key file are in `/health/private` only, and the public
  `access_keys_reload_failed` warning names no error.

- `GET /ready` answers `200` when every check passes and `503` otherwise, with the checks in the body:
  `database` (Postgres only), `search` (the first search index is built) when the Bazaar is enabled,
  and, for each network whose `GATES_READY` is on, `<network>:serving`, `<network>:rpc`,
  `<network>:sponsor` (balance at least `MIN_SPONSOR_BALANCE_XLM`), `<network>:assets` (every accepted
  token is deployed with its configured decimals; see [Accepted assets](/facilitator/assets)) and
  `<network>:channels` (every channel account exists). `GATES_READY` is on by default when one network is
  served and off when several are, so one network can never take the others out of a load balancer.
  Route load balancers and deploy health checks here. The `database` check asks whether the database
  answers, through one connection of its own, so load that fills the other pools (testnet's work on the
  shared pool, pubnet's on its own) never fails it. It fails when the database refuses the connection,
  including when the role has no connection left (size its limit as [Database roles](#database-roles)
  says), and when it does not connect or answer within `DATABASE_ACQUIRE_TIMEOUT_MS`; a connection that
  stopped answering is then dropped and the next check opens a new one. It runs at most once every 2
  seconds, and concurrent requests share the one running, so a flood of `/ready` requests never takes
  database connections from settlements. While a new check runs, `/ready` answers from the last one, so
  a slow database holds no readiness request (the first check after startup is waited for).
- `GET /ready/testnet` and `GET /ready/pubnet` answer `200` while that network serves and its checks
  (`serving`, `rpc`, `sponsor`, `assets`, `channels`) pass, `503` otherwise, and `404` for a network the
  service does not serve. The body adds `network`, `state` and `holdReason`. Pubnet's `sponsor` detail is
  `funded`, `below minimum` or `balance unknown`, never the balance.
- `GET /metrics` serves Prometheus metrics. It is public unless `METRICS_TOKEN_SHA256` holds the SHA-256
  hex digest of a token; then it requires `Authorization: Bearer <token>` and answers `401` with the
  code `unauthorized` otherwise. Whatever the token, `/metrics` never shows a series labelled with an
  access key, and of pubnet's series it keeps only `rail402_verifications_total`,
  `rail402_settlements_total`, `rail402_settlement_repeats_total`, `rail402_settlements_finalized_total`,
  `rail402_settlement_duration_seconds`, `rail402_rpc_latest_ledger`, `rail402_rpc_ledger_age_seconds`,
  `rail402_contract_ttl_ledgers`, `rail402_upto_settlements_total` and `rail402_network_serving`, and
  those without their `reason` label (series that differ only in it are added up), since a refusal
  code such as `…_sponsor_unavailable` would show when the budget is spent. Every other pubnet series
  (sponsor balance, committed and wasted fees, guard refusals, channel use and anything added later) is
  private, so testnet's published metrics stay public without exposing the mainnet budget.
- `GET /metrics/private` serves every series, and `GET /health/private` the full `/health` snapshot with
  pubnet's balances. Both require `Authorization: Bearer <token>` matching `METRICS_PRIVATE_TOKEN_SHA256`
  (required with pubnet) and answer `401` otherwise; without that setting neither path exists (`404`).
  Point the Prometheus scraper here. Every label takes values from a bounded set:
  networks, schemes and reason codes from the [registry](/reference/error-codes) (else `unregistered`),
  RPC methods from a fixed list (else `other`), contract aliases from configuration. Series whose labels
  are known at startup are exported at `0` from the first scrape: per configured network and scheme the
  `success` settlements and `valid` verifications, every `kind` of sequence conflict and RPC or Horizon
  transport error, guard refusals, lease timeouts, ledger-read and TTL-check failures, and the search
  index builds, embedding failures and search latency histogram. Alerts on them need no `absent()` guard.

| Metric                                          | Labels                                               | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rail402_verifications_total`                   | `network`, `scheme`, `outcome`, `reason`             | Verifications; `reason` is the `invalidReason` code, or `unregistered` for a code outside the [registry](/reference/error-codes)                                                                                                                                                                                                                                                                                                                               |
| `rail402_settlements_total`                     | `network`, `scheme`, `outcome`, `reason`             | Settle responses other than repeats: `success`, `failure` or `pending`; `reason` is the `errorReason` code, or `unregistered`                                                                                                                                                                                                                                                                                                                                  |
| `rail402_settlement_repeats_total`              | `network`, `scheme`                                  | Settle requests answered from an earlier settlement of the same payment                                                                                                                                                                                                                                                                                                                                                                                        |
| `rail402_settlements_finalized_total`           | `network`, `scheme`, `state`, `reason`, `settled_by` | Settlements reaching a final state (`succeeded`, `failed`, `expired`), once each                                                                                                                                                                                                                                                                                                                                                                               |
| `rail402_settlements_third_party_total`         | `network`, `scheme`                                  | Payments another transaction landed first with the payer's authorization exactly as signed, answered as settled in that transaction (see verification rules, "Front-running")                                                                                                                                                                                                                                                                                  |
| `rail402_settlement_duration_seconds`           | `network`, `scheme`, `state`                         | Histogram of the time from claiming a settlement to its final state                                                                                                                                                                                                                                                                                                                                                                                            |
| `rail402_settlements_reconciled_total`          | `network`, `outcome`                                 | Reconciliation attempts of recorded settlements: the final state reached, `pending`, or `unresolvable`                                                                                                                                                                                                                                                                                                                                                         |
| `rail402_settlements_unfinished`                | `network`                                            | Settlements broadcast and not final yet                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `rail402_settlements_unresolvable`              | `network`                                            | Unfinished settlements whose landing can be neither proven nor ruled out: past their time bound, the RPC no longer retains their ledgers, or the payer's authorization was consumed by a transaction that could not be identified; or the reads that would decide them have come from an RPC behind the ledgers they must cover, or failed, for a minute; or a failure on a used nonce whose entry lapsed (see "State, backups and recovery")                  |
| `rail402_settlement_ledger_read_failures_total` | `network`                                            | Verifications that skipped the settlement-ledger check because the ledger could not be read                                                                                                                                                                                                                                                                                                                                                                    |
| `rail402_sponsor_balance_stroops`               | `network`                                            | Sponsor XLM balance                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `rail402_sponsor_balance_floor_stroops`         | `network`                                            | The network's readiness floor for its sponsor, `<NET>_MIN_SPONSOR_BALANCE_XLM` in stroops                                                                                                                                                                                                                                                                                                                                                                      |
| `rail402_sponsor_fees_stroops_total`            | `network`, `outcome`                                 | Fees charged to the sponsor for included settlements: `charged` when they succeeded, `wasted` when they failed on-chain, including when another transaction landed the payment first, counted when the settlement finishes (an `exact` failure that leaves the payer's authorization usable, once it expired unused)                                                                                                                                           |
| `rail402_sponsor_fees_committed_stroops`        | `network`                                            | Upper bound of the fees committed in the last hour across replicas (open settlements' reservations or maximum fees, finished ones' charged fees), the figure the hourly budget compares against                                                                                                                                                                                                                                                                |
| `rail402_sponsor_guard_refusals_total`          | `network`, `reason`                                  | Settlements refused to protect the sponsor: `reserve` (balance below `SPONSOR_RESERVE_XLM`), `balance_unknown` (pubnet, not read yet), `budget` (`MAX_SPONSOR_SPEND_XLM_PER_HOUR`), `caller_budget`, `payer_rate`, `payto_rate`, `payer_cooldown`, `limiter_unavailable`                                                                                                                                                                                       |
| `rail402_channels_in_use`                       | `network`                                            | Channel accounts leased by a settlement, counted from the channel pool every second in the background (a scrape never queries the database)                                                                                                                                                                                                                                                                                                                    |
| `rail402_channels_total`                        | `network`                                            | Configured channel accounts                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `rail402_channel_lease_wait_seconds`            | `network`                                            | Histogram of the time a settlement waited for a channel account                                                                                                                                                                                                                                                                                                                                                                                                |
| `rail402_channel_lease_timeouts_total`          | `network`                                            | Settlements refused because no channel account freed up within `SETTLE_CHANNEL_WAIT_MS`                                                                                                                                                                                                                                                                                                                                                                        |
| `rail402_submissions_total`                     | `network`, `status`                                  | Settlement transaction submissions by the network's answer (`PENDING`, `DUPLICATE`, `TRY_AGAIN_LATER`, `ERROR`, or `UPSTREAM_ERROR` for a failed first submission that is then rebroadcast)                                                                                                                                                                                                                                                                    |
| `rail402_sequence_conflicts_total`              | `network`, `kind`                                    | Submissions refused with `txBadSeq` (`bad_seq`) or `TRY_AGAIN_LATER` (`try_again_later`); a rebroadcast of bytes the network already applied also answers `txBadSeq`                                                                                                                                                                                                                                                                                           |
| `rail402_sequence_conflict_outcomes_total`      | `network`, `outcome`, `reason`                       | Settlements whose channel sequence number another transaction took: `finished_early` at the conflict (`never_accepted`, `authorization_unused`, `landed`, `settled_elsewhere`) or `declined`, left waiting (`may_be_public`, `unproven`, `sequence_not_reached`, `transaction_found`, `rpc_behind`, `history_not_retained`, `check_failed`, `nonce_unreadable`, `ledger_unreadable`); once per settlement and replica for each new decision. Private on pubnet |
| `rail402_rpc_requests_total`                    | `network`, `provider`, `method`, `outcome`           | Stellar RPC calls Rail402 makes itself, by provider alias and JSON-RPC method (a fixed list, else `other`) and outcome: `ok`, `rpc_error` (a JSON-RPC error answer), `http_error`, `timeout` or `network_error`                                                                                                                                                                                                                                                |
| `rail402_rpc_request_duration_seconds`          | `network`, `method`                                  | Histogram of the duration of those calls                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `rail402_rpc_transport_errors_total`            | `network`, `target`, `kind`                          | Failed HTTP exchanges with the configured RPC (`rpc`) or the public Horizon that `@x402/stellar` reads its ledger-time estimate from (`horizon`), from any client in the process, including the upstream verifier's own: `network` (no answer), `http_5xx` or `http_429`                                                                                                                                                                                       |
| `rail402_rpc_active`                            | `network`, `provider`                                | 1 for the network's active RPC provider (by alias), 0 for the others; private for pubnet                                                                                                                                                                                                                                                                                                                                                                       |
| `rail402_rpc_failovers_total`                   | `network`, `from`, `to`                              | Switches of the active RPC provider; private for pubnet                                                                                                                                                                                                                                                                                                                                                                                                        |
| `rail402_rpc_latest_ledger`                     | `network`                                            | Latest ledger the RPC reported at the last poll                                                                                                                                                                                                                                                                                                                                                                                                                |
| `rail402_rpc_ledger_age_seconds`                | `network`                                            | Seconds since that ledger closed, computed at each scrape; while no ledger was read yet, since the replica started watching the network                                                                                                                                                                                                                                                                                                                        |
| `rail402_contract_ttl_ledgers`                  | `network`, `contract`, `entry`                       | Ledgers until a watched contract's `instance` or `code` entry is archived; negative once it is. `contract` is the alias: an accepted asset's symbol, `upto` for the `upto` settlement contract, or an alias from `TTL_CONTRACTS`                                                                                                                                                                                                                               |
| `rail402_contract_ttl_check_errors_total`       | `network`                                            | Contract TTL checks that could not read the ledger                                                                                                                                                                                                                                                                                                                                                                                                             |
| `rail402_upto_settlements_total`                | `network`, `amount`, `mode`                          | Successful `upto` settlements other than repeats, by the amount settled against the signed cap (`zero`, `partial`, `max`) and whether a transaction carried it (`onchain`) or the authorization was consumed without one (`offchain`)                                                                                                                                                                                                                          |
| `rail402_upto_authority_balance_stroops`        | `network`                                            | Native balance of the `upto` settlement authority; it holds nothing, so anything above zero needs an operator                                                                                                                                                                                                                                                                                                                                                  |
| `rail402_upto_restore_hold_pending`             | `network`                                            | 1 while `upto` is held after a restore and no ledger to count the hold from could be recorded yet: every `upto` request is refused until one is (check the RPC provider's passphrase and the age of its newest ledger)                                                                                                                                                                                                                                         |
| `rail402_upto_ttl_keeper_actions_total`         | `network`, `action`, `outcome`                       | Extensions (`extend`) and restorations (`restore`) of the `upto` contract by the keeper or an operator command, `ok` or `failed`                                                                                                                                                                                                                                                                                                                               |
| `rail402_catalog_outcomes_total`                | `phase`, `status`, `code`                            | Bazaar outcomes: `verify` and `settle` as reported in `EXTENSION-RESPONSES`, and the background phases `outbox` (queued settlements), `origin_check` (`origin_confirmed`, `origin_withdrawn`, `origin_retry`, `publication_deferred`), `enrich` (`facts_refreshed`, `facts_unavailable`) and `retention` (`listing_expired`, `listing_pruned`)                                                                                                                 |
| `rail402_catalog_listings`                      | `state`                                              | Catalog listings by state: `pending`, `published`, `quarantined`                                                                                                                                                                                                                                                                                                                                                                                               |
| `rail402_catalog_outbox_pending`                |                                                      | Settled payments queued for cataloging and not cataloged yet                                                                                                                                                                                                                                                                                                                                                                                                   |
| `rail402_search_index_builds_total`             | `outcome`                                            | Search index builds: `ok`, `degraded` (the embedder failed; the index serves lexical-only, partial results) or `failed` (the catalog could not be read; the previous index stays)                                                                                                                                                                                                                                                                              |
| `rail402_search_embedding_failures_total`       | `stage`                                              | Embeddings that failed or ran out of time, of a listing (`document`) or a query (`query`)                                                                                                                                                                                                                                                                                                                                                                      |
| `rail402_search_query_embeddings_total`         | `outcome`                                            | How searches got their query embedding: `cached` (from the query-embedding cache), `computed`, `saturated` (the embedder was at its concurrency cap, so the search ran lexical-only and partial), `failed` or `none` (no embedding needed)                                                                                                                                                                                                                     |
| `rail402_search_snapshots`                      |                                                      | Search index snapshots kept: the latest, and older ones a valid cursor still uses, up to `SEARCH_MAX_SNAPSHOTS`                                                                                                                                                                                                                                                                                                                                                |
| `rail402_search_snapshot_bytes`                 |                                                      | Estimated memory held by the kept snapshots, capped by `SEARCH_MAX_SNAPSHOT_MB`                                                                                                                                                                                                                                                                                                                                                                                |
| `rail402_search_index_age_seconds`              |                                                      | Seconds since the search index was last confirmed current with the catalog                                                                                                                                                                                                                                                                                                                                                                                     |
| `rail402_search_duration_seconds`               | `method`, `partial`                                  | Histogram of the time to answer a search, by `method` (`hybrid`, `lexical`, `filter`) and whether the results were partial                                                                                                                                                                                                                                                                                                                                     |
| `rail402_http_request_duration_seconds`         | `method`, `route`, `status`                          | Request latency histogram                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `rail402_http_connections_reset_total`          | `reason`                                             | Connections the server reset: `write_timeout` (the client did not take a ready response within `RESPONSE_WRITE_TIMEOUT_MS`, or during shutdown within 1 s) or `backlog` (it pipelined more than `MAX_PIPELINED_REQUESTS` requests); each reset is also logged at `debug` with the number of responses dropped                                                                                                                                                  |
| `rail402_background_errors_total`               | `task`                                               | Failures of reconciliation, polling, origin checks, indexing                                                                                                                                                                                                                                                                                                                                                                                                   |
| `rail402_inclusion_fee_bid_stroops`             | `network`                                            | The inclusion-fee bid of the last fee-stats reading                                                                                                                                                                                                                                                                                                                                                                                                            |
| `rail402_inclusion_fee_pinned_total`            | `network`, `cause`                                   | Fee-stats readings whose bid did not follow the network: `cap` (the network asked for more than `INCLUSION_FEE_CAP_STROOPS`) or `stats_unavailable` (the floor was bid blind)                                                                                                                                                                                                                                                                                  |
| `rail402_network_serving`                       | `network`                                            | 1 while the network serves `/verify` and `/settle`, 0 while it is starting or held                                                                                                                                                                                                                                                                                                                                                                             |
| `rail402_network_hold`                          | `network`, `reason`                                  | 1 for the reason a network is held (see "Serving per network"), 0 for the others                                                                                                                                                                                                                                                                                                                                                                               |
| `rail402_rate_limited_total`                    | `scope`                                              | Requests refused by a rate limit: `ip` (per client address, every route), `key` (an access key's own bucket on `/verify` and `/settle`, before the network is known) or `network` (per key or address on one network)                                                                                                                                                                                                                                          |
| `rail402_rate_limiter_failures_total`           | `scope`                                              | Requests the shared rate limiter could not answer: `ip` and `key` fall back to a per-process limit; `network` refuses pubnet requests and serves testnet ones                                                                                                                                                                                                                                                                                                  |
| `rail402_access_requests_total`                 | `network`, `key_id`, `outcome`                       | `/verify` and `/settle` requests by access key (`public`, `invalid`, or the key's id) and outcome (`served`, `unauthorized`, `forbidden`, `rate_limited`); private (see below)                                                                                                                                                                                                                                                                                 |
| `rail402_sponsor_budget_used_ratio`             | `network`                                            | Fees committed in the last hour as a share of `MAX_SPONSOR_SPEND_XLM_PER_HOUR` (1 = spent); private for pubnet                                                                                                                                                                                                                                                                                                                                                 |
| `rail402_access_sponsor_committed_stroops`      | `network`, `key_id`                                  | Fees each access key with a sponsor budget committed in the last hour; private                                                                                                                                                                                                                                                                                                                                                                                 |
| `rail402_access_keys`                           | `network`, `state`                                   | Access keys per network and state (`active`, `expired`, `revoked`)                                                                                                                                                                                                                                                                                                                                                                                             |
| `rail402_access_keys_reload_failures_total`     |                                                      | Changes to `API_KEYS_FILE` that failed validation; the previous keys stay in force                                                                                                                                                                                                                                                                                                                                                                             |
| `rail402_discovery_rate_limited_total`          | `route`                                              | Discovery requests refused with `429` by a per-client limit, the cost limit or the share of a lane one client may hold at once (`DISCOVERY_MAX_IN_FLIGHT_PER_CLIENT`), by route (`/discovery/search`, `/discovery/resources`, `/discovery/resources/:id`, `/discovery/resources/:id/versions`)                                                                                                                                                                 |
| `rail402_discovery_shed_total`                  | `route`, `reason`                                    | Discovery requests refused with `503` under load, by route and reason: `admission` (every slot and queue place was taken, or the wait in the queue ran out; `discovery_overloaded`), `database_busy` (no connection of the discovery pool within `DISCOVERY_DATABASE_ACQUIRE_TIMEOUT_MS`, or a read cut by its statement timeout; `discovery_overloaded`), `database_unavailable` (`discovery_catalog_unavailable`)                                            |
| `rail402_discovery_in_flight`                   |                                                      | Discovery requests being served now, each counted until its response has been handed to its client's connection, at most `DISCOVERY_MAX_IN_FLIGHT` per lane                                                                                                                                                                                                                                                                                                    |
| `rail402_discovery_queued`                      |                                                      | Discovery requests waiting for a turn now, at most `DISCOVERY_QUEUE_LENGTH` per lane                                                                                                                                                                                                                                                                                                                                                                           |
| `rail402_search_listings_left_out`              | `network`                                            | Published listings the latest search snapshot left out because the network's share of the index (`SEARCH_MAX_INDEX_MB_PER_NETWORK`) was full                                                                                                                                                                                                                                                                                                                   |

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
6. Set the new secret (and, with `upto`, the old one as `PREVIOUS_SPONSOR_SECRET` with
   `PREVIOUS_AUTHORITY_UNTIL`, below), run `channels provision` on pubnet, and start the service.

7. For the hosted service, close the old accounts' registry ranges at the switch ledger and add the new
   sponsor, channel accounts and settlement authority (step 5 of the
   [key ceremony](#mainnet-sponsor-custody)); `registry-check --hosted-<network> <service URL>` must
   pass before the Explorer indexers restart. Until the registry change is merged, the new accounts'
   settlements show as unattributed x402-shaped matches; the restart re-attributes them.

Settlement records are keyed by the payer's authorization, not by the sponsor, so replay protection
and idempotency carry across the rotation.

The `upto` settlement authority rotates with the sponsor, because it is derived from it. Every `upto`
authorization names the authority it was signed for (`extra.facilitatorAddress`), and only that
authority can settle it. A payment verified before the switch and not settled by then cannot be settled
by the new authority. So that the service with the new secret still settles them, start it with the old
secret as `PREVIOUS_SPONSOR_SECRET` (a file with pubnet, tagged like the sponsor's) and
`PREVIOUS_AUTHORITY_UNTIL` set to the switch time plus `TIMEOUT_MAX_SECONDS` (300 s by default; a later
time is refused). Until then, a payment naming the old authority is checked and settled under it (the new
sponsor still pays the fee, through the new channels); afterwards it is refused with
`invalid_upto_stellar_requirements_facilitator_mismatch`, every authorization naming the old authority has
expired, and the buyer is not charged. `/supported` names only the new authority. Keep the old authority
account (do not run `channels retire` with the old secret yet) until the grace is over; a leaked old seed
can settle captured payloads only during it.

Sellers copy the authority into their `402` responses from `/supported`, and the stock x402 resource
server reads `/supported` when it initializes, which the `@x402/express` and `@x402/hono` middleware do
once, at startup. After the
switch, a running seller keeps offering the old authority, and every new `upto` payment to it is refused
with `invalid_upto_stellar_requirements_facilitator_mismatch` until the seller restarts or re-initializes
its resource server. Tell the sellers that use the service to restart right after the switch; `exact`
payments are not affected. See [the settlement authority](/facilitator/upto#the-settlement-authority).

If the seed is suspected to be compromised, the order changes, because whoever holds the seed can spend
the balance:

1. **Lock the old key out** with the cold key: `deploy/keys/cli.ts freeze` (above), at once, before
   anything else.
2. **Sweep** the old sponsor's balance to the treasury once the freeze has applied:
   `deploy/keys/cli.ts sweep` (above), a second cold-signed transaction.
3. **Rotate**: steps 1 to 6 above with the new sponsor. The old key can no longer sign, so `channels
status`, `retire` and the merge of step 5 need the cold key (or are skipped: the channel accounts hold
   only their reserves).

Payer funds are not at risk.

To change `CHANNEL_COUNT`: raising it only needs a restart (testnet) or `channels provision`
(pubnet). To lower it, retire with the old count, then provision with the new one.

## Access and metering

Testnet is free and needs no key. For pubnet the operator chooses the business model; Rail402
supplies the mechanisms and hard-wires none of them:

- **Authentication.** Callers send `Authorization: Bearer <key>` or `X-API-Key`. Keys live in
  `API_KEYS_FILE` as SHA-256 digests, each scoped to networks with its own request limit, hourly
  fee-sponsorship budget and expiry, reloaded without a restart (see [Access keys](/configuration#access-keys));
  a testnet key never opens pubnet. `REQUIRE_API_KEY` is per network. The logger redacts
  `Authorization` and `X-API-Key` headers; keep every log of the edge proxy from recording `X-API-Key` too,
  not only its access log: Caddy also logs, with the request's headers and outside the site's access log, a
  request it could not proxy, a response cut off mid-body, a request whose Host matches a site only without
  case, and, with debugging on, every proxied request.
  [`deploy/proxy/Caddyfile.example`](https://github.com/tolgayayci/rail402/blob/main/deploy/proxy/Caddyfile.example)
  deletes it, and the payment headers (`Payment-Signature`, `X-Payment`, and `X-Relay-H-Payment-Signature`,
  the payment the Playground's relay forwards to a seller), in every logger: the sites' access logs and
  the global default and error loggers.
- **Metering.** Every `/verify` and `/settle` that reaches the facilitator is counted per caller,
  day, network, operation, outcome and asset, with the settled volume. A repeated `/settle` for a
  payment already settled is counted with the outcome `repeat` and no volume. Requests refused before that
  (transport errors, `invalid_network`, `unsupported_scheme`, HTTP 401) and requests answered with
  HTTP 500 are not counted. Callers with a key read their own usage at `GET /usage`. With Postgres
  the counts are shared by every replica.
- **Service fee.** `SERVICE_FEE_PER_SETTLEMENT_USD` (default `0`) accrues a per-settlement fee for
  key holders, recorded with each settlement at the price in force when it was claimed, for original
  successful settlements Rail402 landed only; `node dist/usage.js export` lists it per caller, network and
  day with the sponsored fees, for billing off-chain (see [Configuration](/configuration#service)). Nothing is charged on-chain and no extra transaction
  is added to the payment path.

## Database roles

The service needs only to read and write rows. Run it as a role that is neither a superuser nor allowed
to create roles, and run migrations as a separate role that owns the schema. With pubnet enabled the
service and `check-config` refuse (`config_database_superuser`) a connection whose role is a superuser or
may create roles, is a member of such a role or of `pg_execute_server_program`, `pg_write_server_files` or
`pg_read_server_files`, or owns the schema or any of its tables (directly or through a role it is a member
of), because such a role could rewrite every network's records, run programs on the database server, or
alter and drop the tables. For the same reason pubnet never applies migrations through the service's own
connection: with `MIGRATE_ON_START=true` and no `DATABASE_MIGRATION_URL`, a pending migration stops startup
(`config_pubnet_migration_role_missing`), and the service refuses to hold the owner's credentials at all
(`DATABASE_MIGRATION_URL` with pubnet is `config_pubnet_migration_url_in_service`). The roles are created once by the operator, never by a migration;
for a schema `rail402`:

```sql
CREATE ROLE rail402_owner LOGIN PASSWORD '…';             -- owns the schema; migrations only
CREATE ROLE rail402_app LOGIN PASSWORD '…' CONNECTION LIMIT 66;  -- 2 replicas × 28, plus 10
GRANT USAGE, CREATE ON SCHEMA rail402 TO rail402_owner;
GRANT USAGE ON SCHEMA rail402 TO rail402_app;
ALTER DEFAULT PRIVILEGES FOR ROLE rail402_owner IN SCHEMA rail402
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO rail402_app;
ALTER DEFAULT PRIVILEGES FOR ROLE rail402_owner IN SCHEMA rail402
  GRANT USAGE, SELECT ON SEQUENCES TO rail402_app;
```

Give the service `DATABASE_URL_FILE` as `rail402_app` (with `?options=-c%20search_path%3Drail402`) and
`MIGRATE_ON_START=false`, and run `node dist/migrate.js` with `DATABASE_MIGRATION_URL_FILE` as
`rail402_owner` before each start of a new release; the service refuses to start while a migration is
pending (`config_schema_outdated`). The migrate command prints the migrations it applied as one JSON line;
concurrent and repeated runs are safe. `packages/store-postgres/test/roles.integration.test.ts` runs every
store as such a role and checks that it cannot create tables, create roles or run server programs, and
that a role holding any of the rights above is refused.

Size the runtime role's `CONNECTION LIMIT` for every pool of every replica at once, plus room for
`check-config` and the CLI commands (10 is plenty): a pool that finds the role's last slot taken refuses
its requests, and anonymous load alone can fill the shared and discovery pools of every replica. One
process holds at most the shared pool (10), the readiness connection (1), with the Bazaar the discovery
pool (`DISCOVERY_DATABASE_POOL_SIZE`, 5) and the search index's pool (2) and, with pubnet served next to
another network, pubnet's pool (5) and the pubnet discovery pool (`DISCOVERY_DATABASE_POOL_SIZE`): 28 for
testnet and pubnet with the Bazaar, so replicas × 28 plus 10, 66 for two replicas. The server's
`max_connections` (100 by default) must hold every role's limit together with
`superuser_reserved_connections`. At startup the service reads both limits and logs
the connections one process needs and how many replicas the role holds (`database connection budget`);
`check-config` prints the same under `database`. With pubnet, a limit below one process's pools stops
startup (`config_database_connections_low`); testnet alone starts and logs a warning.

## State, backups and recovery

Everything durable lives in Postgres: the settlement ledger (claims, recorded envelopes, outcomes),
channel leases, the Bazaar catalog and its version history, rate-limit windows and usage. The
service itself is stateless, so any number of replicas can run against one database.

### Backups

For a self-hosted Postgres, [`deploy/postgres`](https://github.com/tolgayayci/rail402/tree/main/deploy/postgres)
adds continuous archiving with pgBackRest to the same Alpine Postgres image (`Dockerfile`): every WAL segment
is archived within a minute (`postgresql.backup.conf`, `archive_timeout = 60`), full backups run on a
schedule, and everything is encrypted with AES-256 before it leaves the host. pgBackRest reads its settings,
the repository key and the cipher passphrase included, from a file delivered as a file secret
(`PGBACKREST_CONFIG`), never from the container's environment. Keep the passphrase off the host too; the
sponsor seeds are not in the database and are backed up separately (see
[Mainnet sponsor custody](#mainnet-sponsor-custody)).

Making the off-host copy tamper-resistant takes two tiers, because pgBackRest rewrites its `backup.info` and
`archive.info` files on every backup and deletes expired backup sets, so a store that refuses every
overwrite breaks it. `pgbackrest.conf.example` describes them for an S3-compatible bucket: versioning, with a
host key that can write objects but cannot delete versions or change the bucket's settings, and object lock
on the versions, so overwrites and deletes only add versions while the earlier ones stay for the retention
period. That layout has not been exercised by the drill below, which uses a local repository; run the same
steps against the real bucket, with its policy locked, before relying on it.

`deploy/postgres/restore-drill.sh` proves the restore path on throwaway containers: it creates the owner and
runtime roles (`roles.sql`, `grants.sql`), applies every Rail402 migration as the owner, writes rows (one of
them carrying a random marker), takes a full backup, writes more rows, notes a target time and the row count
and checksum of every table at that time, writes rows that must not survive, then restores into an empty
data volume to the target time and compares. It exits non-zero unless every table matches, no later row came
back, the runtime role can still read and write rows (and still cannot create a table), the marker is found
in the data directory but nowhere in the repository (the backup is encrypted), and the archive and backup
metrics read back (`tools/conformance/test/restore-drill.integration.test.ts` runs it). In a local run the
full backup took 32 seconds and the restore to a point in time 10 seconds. It does not prove the off-host
repository, its retention policy or the time to restore a large database.

`deploy/postgres/backup-metrics.sh` turns Postgres' archiver statistics and pgBackRest's backup list into a
metrics file for node_exporter's textfile collector; run it every minute. The `rail402-host` alert group pages
when archiving fails or falls behind, when the newest backup is more than 30 hours old or, with archiving on
for 6 hours, no completed backup is listed at all (none was taken, or `pgbackrest info` cannot read the
repository), and when a host filesystem runs out of space (see the [operator runbook](/runbook)). Take the
first full backup right after turning archiving on, and schedule backups whenever archiving is on: WAL
without a base backup cannot be restored.

A logical dump (`pg_dump --format custom`) is restored with `deploy/postgres/restore-dump.sh`, in one
transaction: with `--owner` and `--app` it creates the dump's objects as the owner role and re-applies
`grants.sql`, so the role split below survives the restore
(`tools/conformance/test/roles.integration.test.ts` restores a dump and checks both roles afterwards).

### Database roles

Run migrations and requests as two different Postgres roles, neither of them a superuser.
[`deploy/postgres/roles.sql`](https://github.com/tolgayayci/rail402/blob/main/deploy/postgres/roles.sql),
run once with `psql` as a superuser, creates an **owner** role that owns the schema and runs the
migrations, and a **runtime** role. It revokes the database from `PUBLIC`, keeps both roles out of the
`postgres` and `template1` databases, and hands tables that already exist, for example from an earlier setup
that used one superuser role, to the owner.
[`deploy/postgres/grants.sql`](https://github.com/tolgayayci/rail402/blob/main/deploy/postgres/grants.sql),
run after `roles.sql` and again after every migration and restore, lets the runtime role read and write rows
of every table, now and after later migrations, with these exceptions: the migration bookkeeping
(`schema_migrations`) and the record of restores (`settlement_rewinds`, written by the owner) are read-only
to it, the listing history (`listing_versions`, `listing_observations`) can be added to but never changed
or removed, and of the ledgers settlement is held from after a restore (`settlement_rewind_ledgers`) it may
add rows and change only the ledger value, never remove one. Changing it can end a hold (set it to 0), as
the runtime role could already reopen an off-chain zero by deleting its settlement row; the service itself
moves it only after a corroborated network reset. It cannot create, alter, drop or
truncate tables, create roles, or run server programs (`COPY … TO PROGRAM`). An integration test runs both
files through `psql` in a throwaway Postgres container, migrates as the owner and checks each of those
refusals for the runtime role (`tools/conformance/test/roles.integration.test.ts`).

- Replicas share the channel pool: a channel is leased with `FOR UPDATE SKIP LOCKED`, so two replicas
  never lease the same channel, and a settlement's final state is written once, by compare-and-set.
  Two replicas on one database and one sponsor settle 3 batches of 20 concurrent payments, each sent
  to one replica and at the same time to the other, with 20 transactions per batch, identical answers
  for every pair, every envelope sent once and no sequence conflict
  (`apps/rail402/test/replicas.integration.test.ts`). A replica's reconciler leaves a settlement to the
  request confirming it, on this replica or another, until it was recorded `SETTLE_RECONCILE_IDLE_MS` ago;
  after a crash the settlement is driven from its recorded bytes once that time has passed. A single
  replica can set `SETTLE_RECONCILE_IDLE_MS=0` to drive them at once after a restart.

- Use a managed Postgres with point-in-time recovery. A restored database is safe once its restore is
  recorded: settlements recorded as submitted are finished by the reconciler from their recorded bytes and
  the chain, and a payment already on-chain can never be submitted again because its authorization nonce is
  spent. An `upto` zero settled off-chain spends no nonce, so the restore may have discarded the only record
  that its authorization was used: every restore adds a row to `settlement_rewinds` (`restore-dump.sh` in
  its own transaction, creating the table for a dump older than it; after a point-in-time recovery, the
  operator, see [Restoring a backup](/runbook#restoring-a-backup)). From the ledger then recorded per
  network (`settlement_rewind_ledgers`), `/verify` refuses every `upto` payment and no `upto` settlement of
  more than zero goes through on that network until the chain has passed the longest window rule 7 can
  accept, whatever ledger time and `UPTO_ZERO_SETTLEMENT` are set now: `TIMEOUT_MAX_SECONDS` in 1-second
  ledgers (the shortest ledger time rule 7 counts) plus 7, about 25 minutes at the default
  `TIMEOUT_MAX_SECONDS` of 300 and 5-second ledgers. Counting ledgers, a slow chain cannot end it early.
  That ledger is recorded only by the service's network poll (`recordRestoreHold`), from the first reading
  after the restore of a provider that answers `getNetwork` with the network's passphrase and whose newest
  ledger closed within the last minute (not in the future): that ledger plus one for every second since it
  closed, the most the chain can have reached, so an honest reading up to a minute old cannot set it too
  low. Until then, and whatever any request reads, every `upto` request holds from its own reading, so one
  reading from a provider that lags, serves another network or lies cannot set it too low. While nothing is
  recorded, `rail402_upto_restore_hold_pending` is 1, and the service logs a warning every fourth poll. A
  network reset, whose ledgers count from the start again (testnet, a local network started again), starts
  the hold once more from the new chain's ledger, decided by the poll alone and never on pubnet: the reading
  must be more than a hold below the recorded ledger and pass the same two checks, and a later passing poll
  must see the new chain again; no earlier authorization exists there. After a test network's reset the poll
  fails until the sponsor exists again, so this counts from re-provisioning it. A provider that lies with
  the right passphrase and a fresh-looking ledger can still record a low first ledger, on any network:
  configure only providers you trust. An in-process facilitator calls `recordRestoreHold` from a periodic
  task of its own; without it, `upto` stays held after a restore until you record the ledger, and after a
  reset until the new chain passes the old count, or until you end it. To end a hold at once (a test
  network, or a reset you have checked), set the recorded ledger to 0 as the owner:
  `UPDATE settlement_rewind_ledgers SET ledger = 0 WHERE network = '<network>'`. The migration that adds the
  record counts a database that already holds settlements, or was migrated more than 10 minutes earlier, as
  just restored, since it may come from a dump taken before the record existed.
- A crash at any point is recovered by the next start: claims without an envelope expire and the
  payment can be retried, and recorded envelopes are reconciled once `SETTLE_RECONCILE_IDLE_MS` passed (see
  [Settlement](/verification-rules#8-settlement) in the verification rules). The service, one replica with
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
  are not found, and the payer's authorization nonce is unconsumed, or every RPC that answered still
  retains every ledger since the claim (with a 60 s margin). Absence holds only up to the ledger a read
  was answered at, so the inner-hash lookup and the nonce read must come from an RPC at or past the ledger
  at which the bounds were seen to pass. A read from a lagging provider, a backend behind a balancer or
  another provider after a failover proves nothing: the settlement keeps waiting, a later pass decides
  it, and the service logs
  `a read that would prove the settlement absent came from an RPC behind the ledger its proof holds at`.
  The same holds for a settlement whose transaction was included and failed on a consumed nonce: the
  search for the transaction that consumed it (see the verification rules, "Front-running") keeps the
  failure only on reads from an RPC that has reached the ledger the transaction failed in, and a read
  behind it, a scan by an RPC whose history starts after the consuming ledger, or a read error leaves the
  settlement for the next pass. A settlement that stays undecided on such reads for a minute (counted
  from its first undecided pass in the process that reconciles it; a restart starts the minute again)
  is reported as unresolvable too, with the log line `settlement undecided`: compare the RPC providers'
  latest ledgers first. It still finishes on the first pass whose reads decide it. A failure on the
  used nonce whose nonce reads unused at the ledger it failed in (the nonce's entry lapsed, see the
  verification rules) is reported as unresolvable at once. Two other cases leave that unproven, and the
  settlement stays unfinished instead:
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
[dependency report](/dependency-licenses), integration tests against Postgres and a local Stellar
network, and a build of the container image. CI also runs the search evaluation gate
(`pnpm eval:check`: nDCG@10 and Recall@20 may not drop more than 0.02 below the tagged baseline,
hybrid must match or beat BM25, zero filter violations), `pnpm pack:check` (every publishable package
installs and runs from its tarball alone), the contract crates' formatting, lints and tests, and container
builds that reproduce the committed contract WASM. The conformance evidence is recorded with one command,
`pnpm evidence` ([Conformance evidence](/reference/conformance#reproduce)).

CI also scans every lockfile for published advisories: `osv-scanner` over `pnpm-lock.yaml` and each
contract crate's `Cargo.lock`, and `cargo audit` over the contract crates. An advisory that does not
apply is ignored in `osv-scanner.toml` with its reason and an expiry date, never silently. Every action
in the workflows is pinned by commit, and every base image (and the Dockerfile syntax image) of every
Dockerfile in the repository by digest, except the standalone example seller and the docs check, which
install published packages and are never deployed from here; a unit test
(`tools/conformance/test/workflows.test.ts`) fails when a pin or a scanner is missing, and CI builds every
deployable image (the service, the Playground, the Explorer and the hosted MCP endpoint).

### Releasing

A version tag (`v*.*.*`) runs `.github/workflows/release.yml`. Before anything is published, its
`verify` job checks that the tagged commit is on `main`, runs `pnpm verify` on it (the integration, scan
and contract jobs of CI are not repeated; the deploy gate below requires every CI check run of the commit to
be green), and runs the findings
gate `node tools/conformance/src/findings.ts --release <tag>`, which refuses the tag unless
`testedRevision.tag` in [`docs/security/findings.json`](/security/report) names it and no critical or
high finding is open or accepted. Only then does the `image` job build and push three container images to
the GitHub Container Registry under the version tag (there is no moving `latest` tag): the service
(`ghcr.io/<owner>/<repo>`), the Explorer (`…-explorer`) and the hosted MCP endpoint (`…-mcp`), each with its
own build provenance attestation and SBOM, and write each digest to the job summary.

To cut a release:

1. Set `testedRevision` in `docs/security/findings.json` to the new tag and commit it with the version
   bump; `pnpm report` re-renders the security report.
2. Create a **signed**, annotated tag on that commit (`git tag -s vX.Y.Z -m "vX.Y.Z"`) and push it.
3. Wait for the release workflow; record the three image digests from its summary.

### Deploying a release

A production deploy runs `deploy/check-deployable.ts` before it changes anything:

```sh
node deploy/check-deployable.ts --repo <owner>/<repo> --fetch \
  --image facilitator=ghcr.io/<owner>/<repo>@sha256:<digest> \
  --image explorer=ghcr.io/<owner>/<repo>-explorer@sha256:<digest> \
  --image mcp=ghcr.io/<owner>/<repo>-mcp@sha256:<digest> \
  --require facilitator --require explorer --require mcp [--kit <deploy kit directory>]
```

It refuses (exit 1, one line per reason) unless HEAD is exactly a `vX.Y.Z` tag that is annotated and
signed with an SSH key listed in
[`deploy/release-signers`](https://github.com/tolgayayci/rail402/blob/main/deploy/release-signers). The
signature is checked with `ssh-keygen -Y verify` against that file alone, in the `git` namespace: git's own
tag verification is not used, because git picks the verifier from the signature block and would check an
OpenPGP-signed tag against the operator's keyring, where a key of unknown trust passes. A tag signed with
OpenPGP or X.509, or carrying a second signature block, is refused. Further, origin has the same tag object,
HEAD is on `origin/main`, the working tree is clean, every GitHub check run for the commit finished green,
every image is named by digest and passes `gh attestation verify` for the release workflow
(`--signer-workflow <repo>/.github/workflows/release.yml`) run for that tag (`--source-ref refs/tags/<tag>`)
from the signed commit, both as the build's source and as the workflow file that ran (`--source-digest` and
`--signer-digest`), so an image another commit built under the same tag name is refused, and every image named with `--require` is given.

**What the gate does not cover.** It certifies the commit and the images. Files a deployment keeps outside
the release (its compose files, host scripts and service settings, including the fee ceilings, budgets,
asset minimums and cold signer of a pubnet network) are not reviewed by it. With `--kit <directory>` it
prints that directory's digest (`kit: sha256:…`: SHA-256 over `sha256sum`-style lines of every file in
byte order of its relative path, leaving out `secrets/*.env`), so a deploy can hand it to the host, which
recomputes it over the files that arrived and records it with the release; two deploys can then be
compared, and the files behind a recorded digest identified. Review such files the way the release
itself is reviewed. The service logs a digest of each network's effective settings at startup (`network
settings loaded`), and `check-config` prints the same digest before a deploy.
A new release signer is added to `deploy/release-signers` in a reviewed commit before it signs a tag.
Branch protection for `main` and the signing requirement are repository settings; the gate does not depend
on them, but they stop an unsigned tag from being pushed at all.

### Zero-downtime deploys

Run two replicas of the facilitator against one database (see [State, backups and recovery](#state-backups-and-recovery)
for why that is safe) behind a proxy that routes only to a replica whose `/ready` answers, and restart them
one at a time: stop a replica only while the other answers `/ready`, and wait for the restarted one to
answer `/ready` before stopping the other. Run the configuration check (`node dist/check-config.js`) of the
new release before touching the database, with `CHECK_CONFIG_PENDING_OK=true` when the release adds a
migration (the check still verifies the database role; only the pending-migration refusals are skipped),
then apply the migrations as the schema owner (`node dist/migrate.js` with `DATABASE_MIGRATION_URL`), run
the check again without that setting, and only then replace the replicas. Keep migrations expand-only (add, never rename or drop, in
the release that introduces a change), because the old replicas keep serving on the migrated schema until
they are replaced. With one process
serving both networks, `/ready` is the process-level check: neither network's chain state takes a replica
out of rotation (per-network readiness is `/ready/<network>`).
[`deploy/proxy/Caddyfile.example`](https://github.com/tolgayayci/rail402/blob/main/deploy/proxy/Caddyfile.example)
does this with Caddy: active health checks on `/ready` every 5 seconds, and a request that finds no ready
replica waits up to 10 seconds for one instead of failing. An integration test runs that file in Caddy in
front of two replicas, stops and restarts one of them under continuous requests, and sees no failed request
(`tools/conformance/test/proxy.integration.test.ts`). Each replica finishes its in-flight settlements within
its 30-second shutdown grace, and anything still open is reconciled from its recorded envelope.

### npm packages

The npm packages are published by hand, from the tagged commit:

1. Check out the tag on a clean tree and run `pnpm install --frozen-lockfile`, `pnpm verify`,
   `pnpm build` and `pnpm pack:check`; every package carries the tag's version.
2. Publish every public workspace package with `pnpm -r publish --access public`, from an npm account
   with two-factor authentication for publishing; pnpm rewrites `workspace:` dependencies to the released
   version.
3. Check the published versions with `npm view @rail402.dev/<package> version`.
