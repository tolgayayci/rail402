# Changelog

## Unreleased

### Bazaar and search

- Pubnet holds one `payTo` to 250 published listings (`<NET>_BAZAAR_MAX_PUBLISHED_PER_OWNER`; testnet sets no
  share), and withdraws a listing after 90 days without a settlement (`PUBNET_BAZAAR_IDLE_TTL_DAYS`, was 0),
  so a party that publishes from origins it later abandons cannot keep the network full.
- A listing never published, withdrawn for 7 days, is deleted with its versions (`listing_pruned`, migration
  `0036`): free settlements for resources whose origin never confirms them no longer grow the catalog
  database without bound.
- Custom catalog stores implement `countPublishedBy`, `abandonedListings` and the transaction's `remove`.

### Explorer

- An account page reads its seller's payment counts and distinct payers from `seller_summaries`, which the
  indexer keeps with the account totals (migration `0006`, filled from the stored settlements), instead of
  aggregating the seller's settlements on every view.
- A network window publishes only a bare-origin Horizon: an `EXPLORER_ANCHOR_HORIZON_URL` with a path, which
  may carry a provider key, needs `EXPLORER_NETWORK_WINDOW_PUBLIC_ANCHOR_URL`, and the window job refuses to
  start without it.

### Operations and security

- The deploy gate accepts an image only when its build attestation names the signed release commit, as its
  source and as the workflow file that ran (`--source-digest`, `--signer-digest`).
- A contract release waits for approval in the `contract-release` environment, and its attestation must name
  the reviewed revision of stellar.expert's release workflow and the tag's commit; a pubnet `upto` deploy
  checks the same revision.

## 0.5.1 — 2026-10-29

A hardening release from a pre-launch security review of the whole codebase; every finding is listed in the
security report (`docs/security/report.mdx`). Exact settlements that fail or are refused now stay open until the
payer's authorization expires unused or a copy of it lands, and buyers treat them as unknown rather than
unpaid. Every package moves to 0.5.1; apply the new migrations (0028 to 0035) before deploying
the service.

### Facilitator

- A database restore no longer reopens an `upto` authorization settled at zero off-chain. Every restore is
  recorded in the new `settlement_rewinds` table (`restore-dump.sh` writes it in the restore's transaction,
  creating the table for an older dump; the runbook adds it after a point-in-time recovery). Each network
  then holds from a ledger recorded in `settlement_rewind_ledgers` by the new `recordRestoreHold`, which the
  service's network poll runs: from the first reading after the restore of a provider that answers
  `getNetwork` with the network's passphrase and whose newest ledger closed within the last minute (not in
  the future), counting one more ledger for every second since it closed. While nothing is recorded every
  `upto` request holds and `rail402_upto_restore_hold_pending` is 1. `/verify` and `upto` settlements of
  more than zero answer `settle_upto_stellar_authority_unavailable` (retryable) until the chain has passed
  the longest window rule 7 can accept, about 25 minutes by default, whatever ledger time and
  `UPTO_ZERO_SETTLEMENT` are set now. Requests never record or move that ledger and hold from their own
  reading until it is recorded; on a test network the poll starts the hold again from a reset chain once a
  later passing poll corroborates it, and on pubnet never. The migration that adds the tables counts a
  database that already holds settlements, or was migrated more than 10 minutes earlier, as just restored,
  since it may come from a dump taken before the record existed: upgrading an existing deployment holds
  `upto` once. The runtime role can read the record, add a held ledger and change only its ledger value: it
  can end a hold, as it could already reopen an off-chain zero by deleting its settlement row. In-process
  users with a Postgres ledger: the migration counts an existing database as restored, so `upto` stays held
  until your own periodic task runs `recordRestoreHold` (or the owner records the ledger). A ledger that
  records holds (`rewindLedger`) but cannot read them back (`rewindAnchor`) holds every `upto` payment.
- Rule 7 counts a ledger time under one second as one second, and `UPTO_LEDGER_SECONDS` must be at least 1.
- A settle request may carry the resource server's own attempt id (`extensions.rail402.settlement.attempt`,
  16-64 letters, digits, `-` or `_`). The facilitator records the id of the request that holds the
  settlement's claim (migration `0034`, column `settlements.settle_attempt`): the one that started it, or the
  one that took a stale claim over and settled it, whose id (or none) replaces the abandoned request's. It
  echoes that id in every repeat's marker (`EXTENSION-RESPONSES` `rail402.settlement.attempt`), taken from the
  settlement as it is answered, so a repeat that waited through a takeover echoes the request that took the
  claim over. A seller can tell the answer to its own lost or pending attempt from a payment another seller or
  process settled. The id is never part of the request's fingerprint, and the Bazaar never lists `rail402` as
  an extension a resource declares; readers that ignore the new field see the marker as before, and records
  written earlier, or requests without an id, echo none.
- A settlement whose first submission the network refuses for good finishes with
  `settle_…_transaction_submission_failed`, with nothing charged, and frees its channel: an `upto` one at
  once, an `exact` one once the payer's authorization expired unused (see below).
- A settlement refused with `txBadSeq` because another transaction took its channel's sequence number
  gives its channel back within seconds, once the channel's sequence number on the network proves its
  transaction can never apply, and no longer holds the channel until the payment expires (migration `0035`,
  column `settlements.channel_released`). An `upto` one whose sends were never accepted finishes then as
  `settle_upto_stellar_transaction_submission_failed`, with nothing charged (each send's answer is recorded
  on the settlement, so a conflict first answered `TRY_AGAIN_LATER` finishes the same way, on any replica).
  Each decision is counted in `rail402_sequence_conflict_outcomes_total`, and a settlement left waiting is
  logged once per replica with its reason. The channel is quarantined for `SETTLE_CHANNEL_QUARANTINE_MS`
  (60 s), doubled for each further conflict in a row up to 16 times, and quarantined again when it comes
  back with an account sequence number that moved meanwhile.
- A settlement whose own hash reads not found is finished as expired, or as refused, only on an inner-hash
  lookup and a payer's nonce read from an RPC at or past the ledger of that lookup (for an expiry, the ledger
  at which its bounds were seen to pass) and of any sequence proof. A lagging provider, a backend behind a
  balancer or another provider after a failover leaves the settlement waiting for a later read, so a payment
  that landed inside someone else's fee bump is no longer reported as expired with no funds moved.
- A settlement whose own transaction failed on a consumed nonce keeps the failure only when the search for
  the transaction that consumed it read RPCs that have reached the ledger it failed in and the consuming
  ledger. A read behind them, a read error, or an RPC whose history no longer holds the consuming ledger now
  leaves the settlement open for the next pass instead of answering
  `invalid_<scheme>_stellar_payload_nonce_already_used` for a payment that settled through a copy of its
  authorization. One that stays undecided for a minute counts in `rail402_settlements_unresolvable` and logs
  `settlement undecided`. A failure on the used nonce whose nonce reads unused at the ledger it failed in
  (its entry lapsed) is left unresolved and reported instead of kept.
- An `upto` settlement whose rebroadcast the network refuses for good (for example once the sponsor key is
  frozen) no longer finishes as `settle_upto_stellar_transaction_submission_failed` while a send may have
  exposed its transaction and a later ledger can still include it: anyone can wrap that transaction in a
  fee bump of their own until then. It keeps waiting until no later ledger can include it, so a payment
  someone else's fee bump landed meanwhile is answered as settled. One whose sends were all refused still
  finishes at once.
- An `exact` settlement whose transaction was included after the payer's authorization expired (its time
  bound can outlast the authorization) now looks for a copy of the authorization that landed before the
  expiration, as for a consumed nonce. The host checks the expiration before the nonce, so such a payment
  used to be answered `invalid_exact_stellar_signature_expired`; it is now answered as settled with the
  copy's hash.
- An `exact` settlement whose first submission the network refuses for good, or whose channel sequence
  number another transaction took, is no longer answered `settle_exact_stellar_transaction_submission_failed`
  at once: anyone who holds the payment (its payer, the seller, anyone it passed through) can still carry
  the payer's authorization in a transaction of their own until it expires. A copy that landed is answered
  as settled with its hash, and the settlement fails, with nothing charged, only once the authorization
  expired unused. The failure's advice to sign a new payment is therefore never given while the first one
  can still land. In-process users with their own `SettlementLedger` can add `releaseChannel`; without it
  such a settlement keeps its channel until it finishes.
- An `exact` settlement whose own transaction was included and failed on chain is no longer answered with
  the failure at once when its cause leaves the payer's authorization usable (a balance spent after the
  settle-time simulation, a trustline removed or deauthorized, an account or smart account that refused it
  for now, a token error, or a failure without diagnostics): the failure rolls back, nonce included, so
  anyone who holds the payment can still land it until it expires. It answers `settlement_pending`, gives
  its channel back at once, answers success with a copy's hash when one lands, and answers the on-chain
  cause, with the fee counted as wasted, once the authorization expired unused. A consumed nonce still
  finishes at once, and so does an expired authorization when the transaction failed past the payer's own
  expiration ledger; an expired-authorization error raised earlier (by a contract in the call path, or a
  shorter-lived entry) waits like the other causes.

### Service

- `/ready` probes the database at most once every 2 seconds, through one connection of its own, so a full
  shared pool (testnet's load) or a busy pubnet pool never takes the process out of a load balancer. A probe
  that gets no answer within `DATABASE_ACQUIRE_TIMEOUT_MS` fails and drops its connection.
- A `/verify` or `/settle` with a usable access key is held to a service-wide limit of its own key instead
  of its client address's, on every host: keyless traffic of either network, unknown paths and refused
  requests from the same address or IPv6 /64 no longer use up a key holder's requests. The key's bucket
  holds what it may send a minute on all its networks (`requestsPerMinute`, else
  `KEY_DEFAULT_REQUESTS_PER_MINUTE`, on each) and at least `RATE_LIMIT_PER_MINUTE`, so a key's own limit
  above `RATE_LIMIT_PER_MINUTE` is reachable. A request for a network that does not admit the key pays its
  address's limit as well, like any keyless request. Its refusals count as
  `rail402_rate_limited_total{scope="key"}`.
- On the pubnet host, and in a process that serves pubnet alone, a pubnet key holder's service-wide limit is
  kept through pubnet's own database pool (the one pool when pubnet is served alone) and every other
  caller's in the process, decided from the key in memory: testnet traffic filling the shared pool never
  delays the admission of a pubnet `/verify` or `/settle`, and no anonymous request there takes a
  connection of the pool pubnet's settlements use for that limit. Without the Bazaar, a `/discovery/` path
  is limited like any other; with it, the discovery routes keep their limits on the discovery pools.
  Pubnet's provisioning and `upto` TTL rounds take their lock through pubnet's pool too. `/usage` and the
  cataloging of settlements still use the shared pool.
- `rail402_channels_in_use` is counted every second in the background instead of at each scrape, so the
  public `/metrics` never takes a database connection.
- A client already over a rate limit is refused from memory, without another database write, until the
  window ends; requests already on their way to the database when the first refusal comes back still
  write.
- At startup the service reads how many connections its database role may hold and logs how many replicas
  that holds; `check-config` prints it under `database`. With pubnet, a limit below one process's pools (28
  for testnet and pubnet with the Bazaar) stops startup with `config_database_connections_low`. The example
  role limit is now 66, for two replicas.
- A client that stops reading, or reads too slowly, no longer holds its connection and the responses waiting
  on it: a connection's responses, pipelined ones included, must be handed to the network within
  `RESPONSE_WRITE_TIMEOUT_MS` (30 s) of being ready, and one connection may have at most
  `MAX_PIPELINED_REQUESTS` (4) requests waiting for their answers; otherwise the connection is reset and
  counted in `rail402_http_connections_reset_total{reason}`. A discovery request keeps its admission slot
  until its response has been sent, and one client may have at most `DISCOVERY_MAX_IN_FLIGHT_PER_CLIENT` (8)
  discovery requests per lane, more being refused with `429` `rate_limited`; a front end that forwards no
  client counts as one client, and the Playground's Bazaar proxy forwards each visitor when given a
  `discovery-internal` key in `BAZAAR_KEY_FILE`. On `SIGTERM`, idle connections and requests whose headers or
  body are still arriving are dropped (none has been acted on yet), answers close their connection, and a
  client gets at most 1 s more to take one, so only handlers still at work hold the shutdown up; the last log
  lines are written out, in order, before the process exits.

### Bazaar and search

- Search index builds and the background index check read the catalog through a database pool of their
  own (2 connections, counted in each process's connection budget) that no request takes, so discovery load on either network never holds a connection
  a build needs; a search whose build cannot read the catalog answers from the previous index instead of
  failing. `SearchService` takes the build's store as `indexStore`.
- A `payTo`'s hourly quota of new listings (`<NET>_BAZAAR_MAX_NEW_LISTINGS_PER_OWNER_PER_HOUR`) is kept per
  origin (scheme, host and port), and a listing counts toward it only once its origin confirmed a settlement
  that paid the `payTo` its price there (for `upto`, the whole cap), never after an ownership transfer, and
  never past the quota. Listings on another party's host, dust payments for spellings of a seller's route
  that its server answers alike, and listings handed over to a seller no longer use up the seller's quota.
  Listings record when they were charged (`quotaChargedAt`, migration 0028); listings cataloged earlier are
  not charged. Custom catalog stores take the origin in `CatalogTransaction.countCreatedBy`, match it with
  `resourceOrigin` (or `RESOURCE_ORIGIN_PATTERN` in their own query language), count by `quotaChargedAt`,
  and keep the `settledAmount` of the option `requestOriginCheck` receives.
- A pending or withdrawn listing whose usage is private no longer shows `lastSettled` on
  `GET /discovery/resources/{id}`: its usage stays private while its content is withheld.
- `mcp://` tools, which no origin confirms and any payer can list for any `payTo`, are counted apart from
  listings an origin confirmed: on testnet they take at most half of `<NET>_BAZAAR_MAX_NEW_LISTINGS_PER_HOUR`
  and half of `<NET>_BAZAAR_MAX_PUBLISHED_LISTINGS`, and never use up the quota or the room of sellers with an
  origin. Custom catalog stores take `unverified` in `CatalogTransaction.countListedSince` (below) and
  `countPublished` and count listings at trust `settled` with it, the others without.
- The hourly quotas of new listings (`<NET>_BAZAAR_MAX_NEW_LISTINGS_PER_HOUR`, and a `payTo`'s per origin) are
  spent when a listing is first published, no longer only when it is created: a listing its origin confirms
  while a quota is spent waits, pending or withdrawn, and its check runs again once the earliest listing that
  quota counts leaves the hour, without spending a retry and without asking the origin meanwhile
  (`rail402_catalog_outcomes_total{code="publication_deferred"}`). Listings created at once, or kept pending
  for hours, no longer publish past the quotas together. A `payTo`'s quota counts a listing from its first
  publication. Custom catalog stores replace `CatalogTransaction.countCreatedSince(network, since)` with
  `countListedSince(network, since, unverified)`, which counts by `listedAt` whatever the state and holds its
  count until the transaction ends; it and `countCreatedBy` return the count and the earliest time counted
  (`QuotaCount`), and `deferOriginCheck` takes `spend` (migration 0030 indexes `listed_at`).
- A route-template listing's example (`info.input.pathParams`), whose path decides who may take the listing
  over, is the path the settlement that created it paid, no longer the `pathParams` its payer echoed, and then
  the path at which the check that listed it, first or again after a withdrawal, confirmed it. A route template
  whose paid path does not percent-decode is not used.
- A published listing is decided by one origin answer only, at its resource or its route template's example
  path, asked as its origin confirmed it: a settlement at another path of the route, or a claim at the
  claimant's own path, can neither change nor withdraw it, and a claim moves it only when that answer names
  the claimant and not the owner. A published MCP tool is decided by its listed call the same way: while that
  call fails for now the check is retried, without calling the tool with a payload's arguments; once it is
  answered without a 402, a call a payer proposed counts only when its 402 lists the tool for its owner, and
  only the listed call's answer withdraws it. While a check of a listing not yet listed is open, it keeps the
  paths the settlements paying its owner proposed, up to 4 per asset (the largest payments) and 8 in all (the
  latest) (`OriginCheck.candidates`, migration 0033, which gives checks requested before their own path and
  payment). It asks them largest payments first, within its host's per-minute budget, and lists the listing
  from an answer that lists it for its owner, one whose settlement paid that answer's price first; an answer
  for a payment below its price waits while a path not asked yet was paid at least that price, and that path
  is asked first. A run that runs out of the budget first records what it found (`CheckCandidate.asked`), and
  the next run goes on from there instead of asking everything again. A tool not yet confirmed is listed when
  it offers a payment settled for it, the one that created it or one its check keeps. Later settlements never
  reset a check's retries: one that pays the owner of a listing not yet listed makes its check due now and has
  its path asked again, and that run spends no retry when it comes before the next one (`OriginCheck.early`,
  migration 0033), and one for a published listing that comes while its check runs no longer skips its retry
  delay. Route-template examples kept from before are unconfirmed (`Listing.confirmedExample`, the confirmed
  path as it was asked, migration 0031): they still weigh claims, but never withdraw or rewrite a listing
  until their own answer lists it. Custom catalog stores keep a check's candidates and how its runs found them
  (`mergeCandidates`, `markCandidates`), its retry count, and, across a request that does not make it due now,
  its due time, claim and `requestId`; `completeOriginCheck` runs a check again when a request added a
  candidate during the run.

### Explorer

- The Explorer indexes x402 settlements on Stellar by the published indexing rules (v2): an indexer with
  checkpoints, a live tail and Horizon anchors checked before every commit, public pages, a read API, live
  lookups and a report whose manifest `pnpm explorer:rebuild` reproduces byte for byte from public ledgers
  (`--anchors-from` checks the anchors a published manifest lists).
- Indexing rules v2: an `exact` row names its payer only when the chain proves that the payer authorized
  the transfer (new check E7). Either the token is a verified Stellar Asset Contract, whose `transfer`
  always requires that authorization, or the payer's own key signed the authorization entry, checked
  over the payload the network signs for `Address` and `AddressV2` credentials. A token that is not a
  Stellar Asset Contract can skip `require_auth`, so its transfers succeed with an entry nobody signed;
  `@rail402.dev/x402-index` now excludes them as `unproven_authorization`, and with them, in such tokens
  only, contract payers and accounts that signed only through other signers. E3 and E4 are reworded to
  describe the entry's fields. `RULES_VERSION` is `2`, rules v1 stays documented in `rules/v1.md`, and the
  indexer reads every ledger indexed under v1 again when it starts. Until it has, and for epochs it no
  longer indexes, the Explorer's pages, API and report leave out rows, account totals, reports and network
  windows of other rules, and look such a transaction up live instead. Only the payer's own signature is
  verified, so a transfer costs one signature check whatever its entry carries. `AuthorizationView`
  carries the raw `entry`, and `signedByPayer` and `authorizationPayload` are exported.

### MCP

- A pubnet confirmation covers only the budget window it was shown for. When the window renews, or the session
  is restarted, before the answer arrives, the payment is asked about again with the new window's end and
  budget, instead of the earlier approval covering the new window. `ConfirmedIntent` carries the `window`.

### SDK and CLI

- A refused payment whose facilitator code is a cause an `exact` transaction can fail with on chain without
  ending the payer's authorization (`insufficient_funds`, `invalid_transaction_state`, and
  `invalid_exact_stellar_payload_` with `invalid_signature`, `smart_account_rejected`, `account_missing`,
  `payer_trustline_missing`, `recipient_trustline_missing`, `trustline_not_authorized`, `token_rejected` or
  `unauthorized_invocation`) now reports `paid: "unknown"` and is never retryable, in the SDK, rail402-mcp
  and the CLI: the same payment can still land until its authorization expires, so paying again could pay
  twice.
- `inspectTransaction` and `rail402 tx` say an `exact` payer authorized the transfer only when the chain
  proves it, as E7 does; otherwise the check reads "an authorization entry for … alone, not proven by the
  chain". `x402Shape` takes that proof as `proven` on each authorization.
- The CLI's human output no longer passes terminal control sequences from a seller's 402 to the terminal.
  `rail402 quote` printed an option's scheme, raw amount and `payTo`, and `rail402 seller check` its `payTo`
  and asset, as received; they and every other value from a seller, the Bazaar or the network are now
  shown without control or bidirectional characters, one-line values without line breaks, and a response
  body without carriage returns. `--json` output is unchanged. SDK reasons that quote a seller (an upstream
  error message, a `seller check` finding, a lint path) are cleaned the same way.
- An idempotency key belongs to the payer on its network, not to a budget window. A retry with the same key
  after the window renewed or a new session started (`rail402 session start --force`) used to find no earlier
  call and sign a second payment, even when the chain had proven the first one settled; it now replays the
  earlier outcome or reports `paid: "settled"`, and pays again only once the chain shows the earlier
  authorization expired unused. Every ledger checks the key across the payer's windows inside its atomic
  reserve. The guarantee lasts as long as the ledger keeps the key: the SQLite ledger keeps it, the in-memory
  ledger until its process exits, `StorageSpendLedger` until seven days after the key's window ended with its
  payments resolved. The payment identifier sent to the seller is no longer derived from the window: it is
  chosen at random the first time a key pays a resource and kept with the key (`Reservation.paymentId`), so
  every payment of the call carries the same identifier and nobody can work it out from the payer and a
  guessable key; a freed key used for another resource gets a new one. `paymentIdentifier()` is deprecated in
  favour of `randomPaymentIdentifier()`. `SpendLedger` gains `findIdempotencyKey(network, payer, key)`; a
  custom ledger must implement it, and keep `ReservationRequest.paymentId` with the key. The SQLite ledger
  moves to schema version 3 (a `payment_id` column) when this version opens it. Earlier versions of the SDK,
  the CLI and rail402-mcp, which check keys per window, refuse that file as written by a newer version
  (`payment_ledger_unavailable`) instead of paying a keyed call twice, so upgrade every process that shares
  the ledger (the CLI and rail402-mcp do by default) together.
- `withSettleDedupe` serves a payment whose first `/settle` answer was `settlement_pending`. The stock
  resource server settles such a payment again at once, and Rail402 answers that retry from its record with
  the repeat marker; the wrapper used to refuse it with `seller_settlement_repeat`, so the buyer paid and got
  nothing. Each `/settle` the wrapper sends now carries a new random attempt id, and the marker is set aside
  only when it echoes one of the wrapper's own attempts that may have settled the payment without a success
  served for it: the facilitator answered `settlement_pending`, or `/settle` brought no answer of the
  facilitator's own (anything but its x402 settle body, such as a timeout, a reset connection, or an empty,
  HTML or other non-x402 page from a proxy, CDN or firewall in front of it). That success is served once. A
  marked success that echoes another id (a payment another seller, replica or an earlier run of this process
  settled, including one that took over this wrapper's stale claim), no id, or an id already resumed is
  refused, whatever the timing. A refusal in the facilitator's own x402 body, a rate limit included, waits for
  nothing. The recovery needs a facilitator that records and echoes the attempt id, so deploy the service with
  or before this SDK; against an earlier facilitator a buyer whose answer was lost or pending is refused, as
  before. `attemptIds: false` turns the ids off for a facilitator other than Rail402, which would receive an
  extension key it does not know, and with it the recovery: a pending or lost-answer buyer is then refused, as
  before. A buyer's second send after a lost answer reaches the wrapper on `upfront` routes only: in the
  `authorization` flow `/verify` refuses it. A repeat refused by its marker is no longer recorded in `memory`.
  Without the marker, `memory` alone recognises repeats: give every wrapper that can accept the same payment
  one shared `memory`.

### Operations and security

- The proxy example (`deploy/proxy/Caddyfile.example`) keeps `X-API-Key` and the payment headers out of every
  log, not only the access log: its default logger and a logger for handler errors delete them too. The
  payment headers include `X-Relay-H-Payment-Signature`, under which the Playground's relay forwards a
  buyer's payment. Caddy logs
  a request's headers outside the site's access log for a request it could not proxy (no ready replica, a
  failed round trip), a response cut off mid-body, a Host that matches a site only without case, and with
  debugging on. Host names no site claims now get a 404.

### Tooling

- The test kit's smart-account payer is a contract built in this repository
  (`contracts/testing/ed25519-account`, reproducible like the other contracts): its constructor binds the
  owner key in the transaction that creates the account, and nothing can change the key afterwards. The
  previous fixture set its owner in a separate call that any account could repeat. Before a pubnet conformance
  run sends USDC to a contract account, it reads the account on chain and refuses
  (`pubnet_contract_owner_unverified`) one that does not run a known account's code, or a fixture account
  whose owner is not the run's key.

## 0.5.0 — 2026-10-28

One service now serves `stellar:testnet` and `stellar:pubnet` side by side, each network isolated from the
other: its own secrets, readiness, limits, budgets, metering and database pool, with pubnet settings that
fail closed. This release adds RPC failover, the Explorer and its indexing rules, a hosted discovery-only
MCP endpoint, pubnet guards for buyers and agents, recovery drills and a public security report. Every
package moves to 0.5.0, and `@rail402.dev/x402-index` is published for the first time.

### Networks and pubnet

- `NETWORKS` selects the networks one process serves. A problem on one network (an unreachable RPC, a missing
  or underfunded sponsor, unverified assets, unprovisioned channels) holds only that network, which answers
  its own requests with a coded, retryable 503, while the others serve; `/ready/<network>` and
  `rail402_network_hold{network, reason}` report it. Startup holds name what failed: `rpc_unreachable` only
  for RPC failures, `sponsor_missing`, `channels_missing` and `provisioning_busy` otherwise.
- Pubnet refuses to start without explicit fee ceilings, assets, an hourly sponsor spend cap and a cold
  signer (`PUBNET_SPONSOR_COLD_SIGNER`) that alone reaches the sponsor's high threshold; secrets come from
  files with owner-only permissions, never from the environment. `check-config` reports every startup code
  before a deploy.
- Public hosts can be scoped to one network, so `/supported` and payments on that host serve only it; pubnet
  can require access keys, and its metrics and refusal details stay off public views.
- Several RPC providers per network with failover between polls; each settlement simulates and submits
  through the provider it was claimed under.

### Facilitator

- Testnet's default `MAX_TX_FEE_STROOPS` is 2,000,000: testnet's rent price rose until a smart account's
  TEST6 payment was simulated at 1,083,927 stroops and refused under the old 1,000,000. Pubnet still has no
  default.
- An `exact` payment whose operation sets its own source account is refused with the new code
  `invalid_exact_stellar_payload_operation_source_set`. The payer's authorization does not cover the operation
  source and settlement cannot sign for it, so such a payment could never land; it used to verify and then
  hold a channel until its authorization expired.
- A settlement whose first submission the network refuses for good finishes at once with
  `settle_…_transaction_submission_failed`, with nothing charged, and frees its channel.
- Finished settlements count the fee they were charged against the hourly budgets: nothing when they expired
  or were refused, their maximum fee when the charge is unknown.
- Every call of the service's own RPC clients fails after 10 seconds, and a settlement that has signed nothing
  30 seconds after its claim stops with `unexpected_settle_error` and signs nothing afterwards. The upstream
  `exact` verifier, whose client has no timeout, is cut off after the same 10 seconds with a retryable
  `unexpected_verify_error`.
- A simulation the RPC failed without running the host is answered `unexpected_verify_error` or
  `unexpected_settle_error` (retryable) instead of refusing the payment as invalid.
- The fee bump's full cost is reserved before signing and a settlement above the fee ceiling is never
  signed; payer and payTo limits count only payments whose signatures were proved, and failing payers cool
  down.
- The previous `upto` settlement authority stays valid through a sponsor rotation.
- Each network reconciles on its own: a network whose ledger or RPC fails or hangs no longer holds up the
  others.
- `MAX_SETTLEMENTS_PER_PAYTO_PER_MINUTE` counts per access key, with one shared count for keyless callers.
- On pubnet a non-zero `upto` settlement below the asset's minimum is refused with
  `invalid_upto_stellar_requirements_amount_out_of_range`.
- A settlement refused with `txBadSeq` because another transaction took its channel's sequence number
  finishes within seconds as `settle_<scheme>_stellar_transaction_submission_failed`, with nothing charged,
  once the channel's sequence number on the network proves its transaction can never apply and no send of
  it was ever accepted (each send's answer is recorded on the settlement, so a conflict first answered
  `TRY_AGAIN_LATER` finishes the same way, on any replica); it no longer holds the channel until the
  payment expires. Each decision is counted in `rail402_sequence_conflict_outcomes_total`, and a settlement
  left waiting is logged once per replica with its reason. The channel is quarantined for
  `SETTLE_CHANNEL_QUARANTINE_MS` (60 s), doubled for each further conflict in a row up to 16 times, and
  quarantined again when it comes back with an account sequence number that moved meanwhile.
- `createStellarFacilitator` refuses a setup with `FacilitatorSetupError`, whose `code` is stable and,
  where the service checks the same setting, the same as the service's startup code. Pubnet now requires
  explicit `assets` (`config_pubnet_assets_missing`) instead of defaulting to USDC; a missing sponsor seed or
  RPC URL is refused as `config_sponsor_secret_missing` or `config_rpc_missing` on any network.

### Service

- `API_KEYS_DIR` reads the access keys from `keys.json` in a mounted directory, so a key file replaced by
  rename is seen without a restart. Reloads also notice a replaced file of the same size and time.
  `/health/private` shows the SHA-256 of the key file in force; the public `/health` no longer shows access
  keys.
- `/ready` probes the database at most once every 2 seconds.
- A network without a sponsor seed, an RPC provider or, with `upto`, the settlement contract it needs stops
  startup with its own code, `config_sponsor_secret_missing`, `config_rpc_missing` or
  `config_upto_contract_missing`, instead of `config_invalid`.
- With pubnet: `DATABASE_MIGRATION_URL` is refused for the service (`config_pubnet_migration_url_in_service`),
  database URL and cursor secret files readable by others are refused, and a pubnet RPC URL carrying
  credentials in its user info, query or fragment must come from `PUBNET_RPC_URLS_FILE`.

### Bazaar and search

- Catalog quotas, schema validation and origin checks run per network and lane, with stricter pubnet
  defaults; a listing's unconfirmed metadata is withheld on its detail and history, and settlements are never
  summed across networks.
- Search snapshots are bounded by measured size and per-network shares, with a query cache, an embedder cap
  and a cost bucket; internal discovery callers are charged per forwarded client and never share a bucket
  with payments.
- A quarantined MCP tool comes back with its owner's next settlement when its listed call no longer gets a
  402, for example a tool listed before it declared an example for a required argument: the origin check
  then calls the tool once more with the example that settlement's payload declares, and uses only a 402 to
  that call. A quarantined listing whose check fails for another reason records the new reason in a new
  `quarantine` version, and the store refuses a `quarantine` version without a reason (migration 0027).
  Custom catalog stores implement `CatalogTransaction.latestReason` and keep the proposed call of
  `requestOriginCheck`.
- A listing's token facts are no longer kept empty for six hours when the RPC failed while they were read:
  the listing keeps the facts it had and is read again on the next round. `AssetDirectory.readFacts` tells
  an RPC failure (it rejects) from a contract that is not a readable token (undefined).

### Explorer

- The Explorer indexes x402 settlements on Stellar by the published indexing rules (v1): an indexer with
  checkpoints, a live tail and Horizon anchors checked before every commit, public pages, a read API, live
  lookups and a report whose manifest `pnpm explorer:rebuild` reproduces byte for byte from public ledgers
  (`--anchors-from` checks the anchors a published manifest lists).
- A registry of facilitator and `upto` contract accounts, seeded from public evidence, attributes each
  settlement; testnet beta contracts are labelled.

### MCP

- A hosted, discovery-only MCP endpoint with its own image, an upstream budget and no batches.
- MCP confirmations are single-use, and pubnet requires an explicit confirmation choice.

### SDK and CLI

- `inspectTransaction` (and `rail402 tx`) now reads transactions through `@rail402.dev/x402-index`, the
  package the Explorer classifies with. Muxed accounts still show as the network shows them: a muxed
  source, fee source or authorization address is its `M…` strkey, and a transfer's recipient is written as
  its event topic names it. A transaction with an account or address the reader cannot represent is
  refused with the new code `transaction_unreadable` (422) instead of `rpc_unavailable`.
- `@rail402.dev/sdk` depends on the new `@rail402.dev/x402-index`, so both are published together.
- Pubnet buyer safety in the SDK, CLI and MCP server: explicit https endpoints, required caps with ceilings,
  pubnet-tagged key files, payments to verified Bazaar listings only, a person's confirmation of the first
  payment to each recipient and listing, budget windows that do not renew with keyed budgets in the
  persistent store, and pinned `upto` settlement authorities.
- The SDK reads every page of a listing's version history and validates its Explorer providers.
- Receipts, `rail402 tx`, rail402-mcp tool results and the Playground now link to the Rail402 Explorer by
  default (`https://explorer.rail402.dev/testnet/tx/<hash>` on testnet, `/tx/<hash>` on pubnet; accounts
  and contracts under `/account/`). The link carries the hash the settle response returns, a fee bump's
  outer hash, which the Explorer opens directly. `RAIL402_EXPLORER=stellar.expert` (`explorer:
"stellar.expert"` in code, `EXPLORER=stellar.expert` for the Playground) keeps the earlier links.
- A refused payment (`payment_rejected`) reports `retryable` and `paid` from the facilitator's code the seller
  passed on, through one table (`refusalOutcomes`) that the SDK's `PaymentError`, the rail402-mcp tool error
  and the CLI all use. It is retryable when the facilitator's code is (a busy channel, a rate limit, a spent
  budget), and never more. A refusal after which the payment may still settle or may already have moved funds
  (`settlement_pending`, `…_settlement_in_progress`, `…_idempotency_conflict`,
  `…_transaction_submission_failed`, which upstream facilitators also send for a transaction the network
  already holds, `settle_exact_stellar_transaction_failed` and `settle_upto_stellar_settled_elsewhere`)
  reports `paid: unknown` and is not retryable (CLI exit 5), since a new payment could pay twice.
- rail402-mcp's JSON-RPC errors carry `retryable` and `paid: "none"` in their `data`, like a tool's error.
- `rail402 seller check` and `checkSellerOrigin` judge a resource as the hosted catalog does, which lists
  public hosts only. A loopback resource used to be reported as listable whenever the check was allowed to
  reach it (`--allow-private-network`, `allowLoopback`); it is now refused with `bazaar_resource_unsafe` and
  the catalog's reason, and the command exits 3. Reaching a host and judging it are separate:
  `allowLoopback` and the egress flags only let the check connect, and the new `discoveryAllowLoopback`
  (`--discovery-allow-loopback`, also on `seller validate`) judges as a testnet catalog run with
  `DISCOVERY_ALLOW_LOOPBACK=true` does. `seller validate` no longer takes its verdict from
  `--allow-private-network`. On pubnet the option is refused (`seller_network_unsupported`, CLI exit 2), as
  is `validateListing`'s `allowLoopback`.

### Operations and security

- Prometheus alerting with a runbook-backed alert catalog, per-network readiness on the status page, backups
  with WAL archiving and a restore drill, and recovery drills that fail when their checks do not hold.
- Separate migration and runtime database roles (`migrate` command); pubnet refuses roles that inherit
  privileges or own the schema.
- The mainnet key ceremony (`deploy/keys/cli.ts`): sponsor key files generated on an offline machine, the
  cold signer set up with an offline signature, and a leak response whose freeze comes from the cold account,
  so the leaked key cannot block it, followed by a separate sweep.
- Release and deploy gates: attested images, tag signers pinned to SSH keys, dependency scans and pinned
  images.
- A public security report rendered from the findings register and the threat model.
- Alerting follows the recovery drills: a page silences only the tickets of its own cause on its own
  network; the sponsor balance alert watches every network against its own exported floor (a ticket on
  testnet); the Explorer lag alert also reports an indexer that answers but does not progress; the RPC
  ledger age grows at each scrape, so a replica that never read a ledger or whose polls fail is reported
  stale; and sustained discovery load shedding raises a ticket.

### Tooling

- The Playground and agent runs send their build and pack-check output to standard error, so the evidence
  document they print on standard output is JSON only.
- The deployment files of the previous hosting platform (its configuration directory, `deploy/playground.sh`
  and their guide) and its development dependency are removed. The Dockerfiles and `deploy/docker.sh`
  remain.
- Every `@x402/*` package moves from 2.27.0 to 2.28.0. Upstream published 2.28.0 to align versions: its
  built code is identical to 2.27.0, so verification, settlement, error codes and fee handling do not
  change. `@stellar/stellar-sdk` stays at 16.3.0, which `@x402/stellar` 2.28.0 still accepts. The upstream
  watch list now pins the 2.28.0 release and the current revisions of the v2 specification, the HTTP
  transport, the `exact` scheme and the end-to-end suite's guide, none of which changes Rail402's behaviour.

## 0.4.2 — 2026-10-20

Fixes since 0.4.1: a payer whose account refuses its signature is named a bad signature instead of expired
terms or a token error, `upto` refuses timeouts too short to settle and a `C…` settlement authority, and the
`upto` facilitator mechanism settles more safely around sequence conflicts, fee bumps and repeated requests.
Every package moves to 0.4.2.

### Facilitator

- A `G…` payer whose account refuses the signature (a key that is not its signer, too little weight for its
  thresholds) is refused with `invalid_upto_stellar_payload_invalid_signature` for `upto`; the host raises
  that refusal as `Error(Contract, #5)` in the settlement contract's frame, which used to be read as the
  contract's own `Expired` and answered `invalid_upto_stellar_signature_expired`. A `C…` payer's refusal is
  `invalid_upto_stellar_payload_smart_account_rejected`, and the settlement contract's #4 and #5 still name
  not-yet-valid and expired terms when no account failed authentication. The reason names the host's cause,
  such as "signer does not belong to account".
- `exact` had the same mix-up: a payer account's failed authentication is now decided before the token's own
  errors, so it is `invalid_exact_stellar_payload_invalid_signature` (`G…`),
  `invalid_exact_stellar_payload_smart_account_rejected` (`C…`) or
  `invalid_exact_stellar_payload_account_missing` (a payer that does not exist) whatever the token's kind.
  Through a SEP-41 token, or one whose kind is not known, it used to be
  `invalid_exact_stellar_payload_token_rejected` with error #5.
- When the RPC returns no diagnostic events, `upto` reads the event log in the simulation's error string, with
  each error's contract and message, so the same failures get the same codes.
- `upto` refuses a `maxTimeoutSeconds` shorter than one ledger more than `EXPIRATION_MARGIN_LEDGERS`
  (`(EXPIRATION_MARGIN_LEDGERS + 1) × 5` seconds, 10 s with the service's default margin of 1), whose
  authorization would expire before it can be settled. Verification and settlement check one range, and every
  `invalid_upto_stellar_requirements_timeout_out_of_range` reason names it the same way. With `upto` on, the
  service refuses to start when `TIMEOUT_MAX_SECONDS` is below that minimum.
- The `upto` fee ceiling (`UPTO_MAX_TX_FEE_STROOPS`) is compared with the resource fee plus the inclusion bid
  counted twice, once for the settlement transaction and once for its fee bump, which is what the sponsor
  pays; a payment above it is refused with `invalid_upto_stellar_payload_fee_exceeds_maximum`.

### upto

- The client refuses a `C…` `extra.facilitatorAddress`: the settlement authority is the source of the settle
  operation, which only a `G…` account can be.
- `@rail402.dev/upto/facilitator` accepts `maxTimeoutSeconds` from `minTimeoutSeconds` (default one ledger
  more than its expiration margin, 15 s for the default margin of 2) to `maxTimeoutSeconds`.
  `minTimeoutSecondsFor(margin)` gives the default.
- A settlement refused for a stale sequence number (`txBadSeq`) is rebuilt once with a fresh sequence number
  (`badSequenceRetries`, default 1), then answered `settle_upto_stellar_channel_unavailable`, which may be
  retried; no funds moved. Rail402 sets `badSequenceRetries: 0`, because its settlement ledger records every
  envelope before broadcast and answers a refused one itself.
- While a settlement's own hash is not found, the transaction inside its fee bump is also looked up by hash,
  so a settlement that landed inside another party's fee bump is answered from there, with the hash of the
  envelope that included it. With an RPC that reads ledger entries (`UptoRpc.getLedgerEntries`), a settlement
  is answered `settle_upto_stellar_transaction_expired` only while the payer's authorization nonce is unused.
- A second request to settle the same authorization for another amount is answered
  `settle_upto_stellar_idempotency_conflict` only when the first reached the network: its reason says whether
  the authorization was already settled, is being settled, or was submitted and failed on chain. When the
  first failed before anything was broadcast, the second is settled on its own.
- The test vectors settle the whole cap, a part and zero, for an account payer and a contract-account payer
  (with and without its delegated signer), name the policy they are checked under, and add refusals for a
  `payTo` that is the asset, the settlement contract or the contract-account payer, and for a timeout below
  the minimum.

### Contracts and tooling

- `contracts/testing/upto-adversarial` runs the deployed `upto` WASM (its SHA-256 checked against the
  deployment record) against hostile payers, tokens, sellers and relayers: replays, signatures moved onto
  other terms or below a multisig threshold, overlapping authorizations, a token that tries to re-enter
  `settle` or reports a transfer it never made, entries for another network or deployment, and expiration
  bounds. CI runs it. The `upto` page explains which tokens a facilitator should trust, and why only listed
  `ASSETS` are settled.
- The testnet `upto` contract is verified on stellar.expert by the `upto-contract-v1.0.0` release.
- The deployment record names the repository that holds the contract's source (`repository`, also for each
  `previous` entry) and lists TTL extensions made after the deployment under `ttl_extensions`; the contract
  page shows both. The testnet contract's instance and code now live until ledgers 8403670 and 8403673.
  `pnpm upstream:export` accepts that repository's URL as a value in a deployment record.
- Contract builds in the build image run with a writable `HOME`, so git dependencies fetch under any user.

### Conformance

- The hosted live Playground run drives the deployed Playground
  (`--playground https://playground.rail402.dev`): 18 of 19 cases pass, the sell case included.

## 0.4.1 — 2026-10-09

Fixes since 0.4.0: a muxed `payTo` is refused for `exact`, replicas no longer rebroadcast each other's
settlements, search shows current settlement counts, and `rail402-mcp`'s JSON-RPC errors carry a code.
Every package moves to 0.4.1.

### Facilitator

- A muxed (`M…`) `payTo` is refused for `exact` with `invalid_exact_stellar_requirements_invalid_pay_to` and a
  reason naming it, before anything is simulated. Its CAP-67 transfer event names the base account with
  `{ amount, to_muxed_id }` as data, which the `@x402/stellar` exact verifier cannot match to `payTo`, so such
  a payment could never verify; it used to fail in simulation with `invalid_exact_stellar_payload_event_wrong_to`.
  The seller helpers (`exact`, `upto`), the buyer's `exact` option check (`payment_recipient_not_permitted`)
  and the demo seller (`PAY_TO`) refuse it the same way.
- The reconciler leaves a settlement to the request confirming it, on whichever replica it runs, until its
  envelope was recorded `SETTLE_RECONCILE_IDLE_MS` ago (default `SETTLE_CONFIRM_TIMEOUT_MS` plus 5 seconds;
  `SettlementTiming.reconcileIdleMs` in process). One replica's recovery pass used to rebroadcast another's
  in-flight settlement, which the network answered `txBadSeq` and `rail402_sequence_conflicts_total` counted.
  `SettlementLedger.unfinished` takes `{ idleForMs }`, measured by the ledger's own clock. After a crash a
  settlement is driven once that time has passed; a single replica can set `SETTLE_RECONCILE_IDLE_MS=0`.
- Series whose labels are known at startup are exported at `0` from the first `/metrics` scrape.

### Bazaar and search

- `/discovery/search` reads each result's `settlements`, `lastSettled` and Stellar facts from the catalog when
  it serves the page, so they match `/discovery/resources`; a repeat settlement or a facts refresh starts no
  new index revision, and the index's copy used to show the values of the revision it was built at. Ranks and
  cursors are unchanged. `CatalogStore` gains `getMany(ids)`.

### Agent tools

- `rail402-mcp` answers a request that never reaches a tool with a JSON-RPC error whose `data` carries `{
code, reason }`: `rpc_method_unknown` (`-32601`) for a method it does not serve, `rpc_params_invalid`
  (`-32602`) for a `tools/call` without a tool name or with arguments that are not an object (and other
  params the MCP schema refuses), and `rpc_internal_error` (`-32603`), next to `tool_unknown`. The codes are
  exported as `rpcCodes` and listed in the error-code reference.
- `rail402 --help` lists `--scheme exact|upto` and every flag each command takes.

### Playground

- The session budget check's run names the transaction of the payment that fits before the refusal
  (`transactions` in the run summary and report), and its result links it.

### Conformance

- The conformance page shows `/supported` as the hosted service answered it, and the local answer only when no
  hosted run is recorded.
- Against a hosted service the upstream e2e suite's Bazaar validation is shown as not applicable, with why:
  the suite expects its HTTP listings at `http://localhost:<port>` URLs it builds itself, and a hosted catalog
  refuses loopback origins.
- The live agent run records how each listing it pays came to be, from `/discovery/resources`: its first
  cataloging, the settlement transaction of its version 1 (checked in stellar.expert) and its version history,
  and that the run's payment counted against it. Its cases `sdk-http-first-call` and `sdk-mcp-first-call` are
  now `sdk-http-cataloged` and `sdk-mcp-cataloged`: a hosted catalog keeps its listings across runs.
- Each live agent surface (SDK, `rail402`, `rail402-mcp`) refuses a network, asset, recipient and amount
  outside the policy, a price above the per-call cap and one above the session budget, with its own payment
  events showing the refusal and no signature; the rejection audit runs against a deployed service too
  (`rejection-audit-hosted-stellar-testnet.json`).
- The MCP rejection audit also sends a `tools/call` without a tool name and an unknown method. The live
  Playground run records the session check's first payment, and the concurrency run holds `txBadSeq` to zero
  on two replicas as on one.
- Tests cover `upto` payments signed through a delegated smart-account signer, the safe-fetch check of the
  connected address, and the TLS and unreadable-asset refusals.
- `scripts/contracts/verify.sh --recipe sep58` rebuilds a contract with the test contracts' SEP-58 recipe. The
  replaced testnet `upto` contract `CCNU3CYA…AYPB` is that build of the current source, and the deployment record
  names its source revision and recipe; the contract page shows each replaced deployment's deploy transaction
  and source revision.

## 0.4.0 — 2026-10-08

A browser Playground for x402 on Stellar, and browser entries in the packages it is built on. Every package
moves to 0.4.0.

### Playground

- `apps/playground`: a page and a stateless server that make real payments on `stellar:testnet` and show each
  message, signature and transaction behind them. A testnet wallet is created or imported in the page,
  encrypted under a non-extractable key in IndexedDB, held by one tab at a time, and set up with Friendbot, a
  USDC trustline and 1 USDC from the testnet exchange. A per-call cap is required for every paying run.
- The lab runs four scenarios against the demo seller, Rail402 and the Bazaar (pay with `exact`, pay per use
  with `upto`, an agent paying an MCP tool through the `rail402-mcp` tools, and selling through a sandbox
  route that is cataloged and found by search), with experiments for a cap below the price, the same payment
  sent twice, and a seller asking to settle twice its cap. Each run draws a swimlane whose rows name their
  source, an inspector, the matching code and an outcome with explorer links, and exports a run report.
- The Pay page pays the demo route, a Bazaar listing or any URL, and runs seven refusal checks (network,
  asset, amount, recipient, per-call cap, session budget, private address). The Sell page checks a seller's
  endpoint as the catalog does and shows a `payTo`'s listings and versions; the Agents page shows the MCP
  server configuration and an example run; the Bazaar page searches the catalog.
- The server relays seller requests through `@rail402.dev/safe-fetch` (https on port 443 to public addresses,
  same-origin callers only, allowlisted headers, per-client, per-host and daily limits), proxies the Bazaar
  and the facilitator's `/supported`, serves the page with a strict content security policy, and refuses to
  start with a secret seed in its environment. Its codes are listed under "Playground server" and
  "Playground page" in the error-code reference.
- A Docker image (`apps/playground/Dockerfile`), unit, integration and Chromium tests with a canary secret
  scan, and a live run on the public testnet (`tools/conformance/src/live-playground.ts`, `live-playground`
  and `live-playground-hosted` in `pnpm evidence`). The threat model covers the relay, the seller check, the
  wallet and the lab sellers.

### Packages

- `@rail402.dev/sdk/browser`: `createBrowserBuyer` over a transport the page supplies, with the same policy,
  guard, ledgers, discovery and payment flows as `createBuyer`, and no Node module in its import graph.
  `StorageSpendLedger` keeps a budget in a synchronous key-value store such as `localStorage` and refuses a
  stored ledger it cannot read until it is reset. Testnet onboarding (`fundWithFriendbot`, `addTrustline`,
  `buyAsset`) moves from the CLI into the SDK; `fundWithFriendbot` now returns Friendbot's transaction hash.
- `@rail402.dev/sdk`: a transport failure turned into a payment error keeps the egress error's details
  (such as the code of the relay that refused the request) next to its stage.
- `@rail402.dev/mcp/tools`: `createTools` without the server, for any buyer, in Node or a browser.
- `@rail402.dev/safe-fetch/shared`: the `SafeFetch` types, policy defaults, `markFinalRequest` and
  `finalRequestOf` with no Node module; `maxSocketsPerHost` is a policy option (default 4).
- `@rail402.dev/safe-fetch`: connections are bounded across hosts (`maxTotalSockets`, default 256), a kept
  connection closes after `idleSocketMs` unused (15 s) with at most `maxFreeSocketsPerHost` kept (2), and
  `keepAlive: false` closes every connection after its answer.
- `keySetupSigner(key, passphrase, { asset, maxBuy })` is bound to one asset: one `changeTrust` adding its
  trustline at the default limit, or one direct `pathPaymentStrictReceive` of at most `maxBuy` from XLM to the
  account itself, with a fee of at most 100,000 stroops.
- `checkSellerOrigin` takes an `egress` policy, and reads whether at most `MAX_RECEIVABLE_CHECKS` (8) distinct
  asset and `payTo` pairs can receive, a few at a time, however many options a 402 lists. `@rail402.dev/errors` loads its diagnostics channel lazily,
  so the code sets load in a browser.

### Settlement contract

- The `upto` contract on testnet is now `CBTVKCHLSGQ3WSV3NKSU6FZR4FZMC6ENMDMXUS5XQ66HYVUUHYE3TU7U` (WASM
  `cc2d2fef…ca797`, salt `sha256("x402-upto-stellar/v1.1")`): the same source and interface, built the way
  stellar.expert's release workflow builds it, with SEP-55 `source_repo=github:tolgayayci/rail402` metadata.
  `UPTO_TESTNET_DEPLOYMENT` and `UPTO_DEPLOYMENT_SALT_HEX` name it, so a service on the new version settles
  `upto` through it unless `TESTNET_UPTO_CONTRACT` is set. The previous contract
  `CCNU3CYA6HCLF5HQSPV3UU2FYVGJ4QWKLCJPMCRSSU6ZKF6LJSN5AYPB` stays on chain unchanged and is listed under
  `previous` in `contracts/stellar/deployments/testnet.json`.
- `scripts/contracts/build.sh` builds the upto contract with the official stellar-cli 28.1.0 release binary
  (SHA-256 checked) and `--optimize`, as that workflow does; the test contracts keep their SEP-58 builds.
  `verify.sh` also checks the crate's source archive against the deployment record, and `deploy.sh` keeps the
  record it replaces under `previous`.
- A tag `upto-contract-v<version>` runs `.github/workflows/contract-release.yml`: it checks that the build
  reproduces the deployed WASM, releases the contract through `stellar-expert/soroban-build-workflow` (GitHub
  release, build-provenance attestation, stellar.expert validation request), and checks that the released WASM
  is the deployed one and is attested by that workflow.

## 0.3.0

Agents can now find and pay x402 resources on Stellar under a spending cap: a buyer SDK, an MCP server
(`rail402-mcp`) and a CLI (`rail402`), with seller helpers that declare paid routes and tools the Bazaar
catalogs as is. Sellers can charge for what a call used with the `upto` scheme, settled through a Soroban
contract deployed on testnet. The facilitator gains a threat model, an operational test report, `upto`
settlement, broader metrics and health, and conformance runs over both schemes. Every package moves to
0.3.0.

### Facilitator and conformance

- `pnpm evidence` (`tools/conformance/run-evidence.sh`) runs every conformance harness on the testnet in
  order against a local Rail402 from the checkout, then renders the pages; `--rehearse` prints instead of
  recording.
- Its error-code coverage step renders the pages before the unit suite checks them, retries a failed
  integration test once and lists the files that still fail; `pnpm report:check --final` also fails on a
  coverage record older than the evidence. The run keeps any query string of `RAIL402_DATABASE_URL`, and its
  local replicas report `<version>+<commit>` on `/health`.
- A run against a deployed Rail402 is kept beside the local one (`<kind>-hosted-stellar-testnet.json`), and
  `pnpm evidence` records the canonical run against `RAIL402_EVIDENCE_HOSTED_URL` too. The upstream e2e run
  cites the `@x402/stellar` release tag, or a remote branch that holds a pre-merge commit, and refuses to
  record one that no remote branch contains. The harnesses' fixed seller accounts are derived from the
  operator's sponsor seed instead of public labels, and evidence naming a local path is refused.
- The conformance summary counts front-running and observability from the operational tests on the private
  network, labelled so, since no testnet run can fault the network.
- The per-client rate limit keys an IPv6 client by its /64 and an IPv4-mapped address as IPv4.
- Provisioning and the `upto` TTL keeper serialize on a lock keyed by the sponsor account, so deployments
  with other sponsors on the same database no longer wait for each other, and the operator's `upto.js ttl
extend` and `ttl restore` wait for a running task instead of giving up at once.
- The hosted service's deployment configuration keeps every setting an operator set, so applying it no
  longer removes a tuned rate limit, API key or quota; a test fails when a setting is neither declared nor
  left unmanaged with a reason.
- The live Bazaar run covers a resource priced in the TEST6 test token, an `upto` resource listed at its cap,
  an off-chain zero `upto` settlement that catalogs nothing, and a US dollar price ceiling that excludes
  TEST6. It records schemaVersion 2 evidence and starts its own sellers by default.
- The rejection audit sends every static and simulation refusal of an `upto` payment to `/verify` and
  `/settle`. The live matrix settles zero, part and all of an `upto` cap from a smart account too, lets a
  smart account's spending limit refuse a cap above it, and settles one authorization sent five times at once
  exactly once.
- `tools/conformance/src/upto-contract.ts` checks the deployed `upto` contract against its record, the chain,
  `stellar contract fetch` and a reproducible rebuild.
- The error-code page shows which codes the test suites and recorded runs produce, with the reason for each
  one that neither produces (`pnpm codes:coverage --write`).
- The service creates the `upto` settlement authority at startup whenever `upto` is served, and replicas
  starting together take turns provisioning channel accounts and the authority. An authority that cannot be
  created yet no longer stops startup: `upto` payments answer `settle_upto_stellar_authority_unavailable` until
  a poll creates it. `/health` warns when the authority can spend XLM or holds an accepted token
  (`upto_authority_holds_tokens`). Concurrent migrations on an empty database no longer fail.
- Testnet's default `MAX_TX_FEE_STROOPS` is 1,000,000 (pubnet stays 300,000); the configuration reference
  lists the measured fees behind the fee ceilings.
- An accepted asset stops the service as `asset_not_a_token` only when its contract definitely has no
  `decimals()`; any other failed read keeps `/ready` failing and is retried.
- New pages describe `upto` payments and the `upto` settlement contract (deployment, reproducible build and
  verification, TTL runbook), and the verification rules list every `upto` check with its code and tests.
- A zero `upto` settlement never catalogs a resource, on chain (`bazaar_settlement_zero`) or off: a listing
  needs a settlement that moved value to its `payTo`.
- Pubnet does not start without `PUBNET_MAX_SPONSOR_SPEND_XLM_PER_HOUR`, and settles `upto` zeros off-chain by
  default. `UPTO_ZERO_SETTLEMENT=offchain` needs `STORE=postgres`, and `EXPIRATION_MARGIN_LEDGERS` is at
  least 1.
- A recorded settlement is finished as failed or expired only on proof that it did not land: its inner
  transaction (in case another party wrapped it in a fee bump) and the payer's authorization nonce are checked
  first, a rebroadcast refused as too late no longer fails it, and an `upto` settlement expires at its ledger
  bound.
- The `upto` facilitator reads the ledger close time from its own RPC, cached, instead of asking Horizon on
  every request, and accepts the expiration of a client that estimated 5-second ledgers when it estimates
  slower ones. The `upto` client signs for at most 300 seconds by default (`maxTimeoutSeconds`).

- A threat model covers replay, front-running, fee sponsorship, catalog poisoning, SSRF, smart accounts, paid
  MCP calls, the `upto` contract, `exact` payments and operations. Its tables are generated from
  `docs/security/threats.json`, and a test fails when a cited source symbol, test or conformance case no
  longer exists.
- An operational test report lists the failure and attack exercises (replay, front-running, balance and
  expiry races, the fee ceiling and budget, crashes, outages, SSRF, catalog attacks, paid MCP calls, the
  `upto` contract), each with the tests that run it. `tools/conformance/src/ops.ts` runs them and records
  what they observed as evidence the report is rendered from.
- New integration tests show what the fee sponsor pays when a payer spends its balance between verify and
  settle (nothing) or between the settle-time simulation and inclusion (one fee, named `insufficient_funds`
  and counted as wasted), and that the fee ceiling and the hourly fee budget refuse before anything is signed.
- An error-code reference lists every code the service returns, with its HTTP status, retryability and
  default reason; codes, statuses and retryability are pinned by the test suite.
- The `reason` label of `rail402_verifications_total` and `rail402_settlements_total` is `unregistered` for a
  code outside the registry, which keeps its cardinality bounded.
- The conformance page is rendered from checked evidence files; harnesses record evidence only from a clean
  commit on `main`.
- A repeated `/settle` is answered from the settlement ledger before any other check, so it returns the
  recorded result even after the authorization expired or while the sponsor guard refuses new settlements.
  The repeat is marked in `EXTENSION-RESPONSES` under `rail402`, metered as `repeat` and never counted or
  billed as another settlement.
- A request for an authorization already held with a different envelope, `payTo`, asset or amount is refused
  with `settle_exact_stellar_idempotency_conflict`, whose reason names the recorded transaction. Settlements
  recorded before this release keep comparing the signed transaction alone.
- `/verify` consults the settlement ledger: an authorization being settled answers
  `settle_exact_stellar_settlement_in_progress`, a settled one `invalid_exact_stellar_payload_nonce_already_used`.
- Breaking for custom settlement ledgers: `claim` takes a `RequestFingerprint` instead of a payload hash,
  `finish` takes optional details, and `find` and `countByState` are new. The Postgres ledger adds migration
  `0011_settlement_requests`.
- `SETTLE_CHANNEL_WAIT_MS` and `SETTLE_CONFIRM_TIMEOUT_MS` configure the channel wait and the confirmation
  window.
- New metrics for repeats, final states and durations, submissions, sequence conflicts, sponsor fees charged
  and wasted, channel lease waits and timeouts, and unfinished settlements; `rail402_verifications_total` and
  `rail402_settlements_total` gain a `scheme` label and `rail402_settlements_reconciled_total` gains `network`
  and `outcome`. The settlement engine reports through a `SettlementObserver`.
- The reconciler declares a settlement `expired` only while the RPC still retains every ledger since the
  settlement was claimed. Otherwise the settlement stays unfinished and is reported as unresolvable: in
  `rail402_settlements_unresolvable`, as the `unresolvable` outcome of `rail402_settlements_reconciled_total`,
  in the log, and in `channels status` (`unresolvableSettlements`).
- Crash recovery is tested by killing the service process with `SIGKILL` after the network accepted a
  settlement, before its broadcast, after its inclusion, and across its expiry: the restarted process
  finishes each from the recorded envelope without submitting a replacement.
- The verification rules document authorization expiry: how the expiration ledger follows from
  `maxTimeoutSeconds`, upstream's upper bound, Rail402's lower bound and margin, and an authorization that
  expires after its settlement was submitted. Integration tests pin both bounds at exact ledgers.
- A payment that another party's transaction landed first, carrying the payer's authorization exactly as
  signed, is answered as settled in that transaction when Rail402's own transaction fails on the consumed
  nonce. The proof comes from the chain: the nonce was consumed after the request was claimed, by a successful
  transaction with a byte-equal authorization entry and the matching `transfer` event. The settlement is
  recorded with `settled_by = third_party`, counted in `rail402_settlements_third_party_total`, and the fee of
  Rail402's failed transaction is counted as wasted. `RECONCILE_THIRD_PARTY_SETTLEMENTS=false` turns it off.
- `/verify` and `/settle` refuse an x402 version other than 2 with HTTP 400 `invalid_payload` and a reason,
  instead of answering `unexpected_verify_error` / `unexpected_settle_error` with HTTP 500.
- A payment from a `G…` account that does not exist is named `invalid_exact_stellar_payload_account_missing`
  instead of `invalid_exact_stellar_payload_invalid_signature`.
- The canonical-client run (`tools/conformance/src/canonical.ts`, replacing `canonical-exact.ts`) records the
  wire through a transparent forwarder and checks it: the signed payload is `{ transaction }` only, the seller
  forwards it byte-equal, and the settled transaction carries the payer's authorization entry byte-equal. It
  covers `G…` and smart-account payers and compares `/supported` with the x402.org facilitator's Stellar kind.
- The live matrix adds concurrent and late repeats and the repeat marker, and the upstream e2e run can target
  an already running facilitator (`--target hosted`) through the forwarder. The rejection audit
  (`tools/conformance/src/rejection-audit.ts`) checks every refusal over HTTP for a registered, expected code
  and a non-empty reason. All of them record schemaVersion 2 evidence.
- The conformance harnesses run `upto` as well as `exact`: the canonical run pays a stock seller with the
  `@rail402.dev/upto` client and server (`--scheme exact,upto`, in USDC and TEST6, `G…` and smart-account
  payers) and checks the `{ authorization }` payload lands on-chain byte-equal; the live matrix adds `upto`
  settlements of part of the cap, all of it and zero, a charge above the cap, a repeat for another amount and
  the expiry window; `concurrency.ts` takes `--scheme upto|mixed`; and the upstream e2e run takes
  `--schemes exact,upto`, recording a run from an unmerged upstream branch as such.
- `tools/conformance/src/fault-recovery.ts` kills a Rail402 process on the public testnet at K0 and K1 (both
  schemes) and K3 and proves the restarted process finishes each settlement from its record alone.
- `rejection-audit.ts --mcp` spawns `rail402-mcp` over stdio and checks every tool refusal is an `isError`
  result with a registered code, a reason and `paid: "none"`, and an unknown tool a JSON-RPC error with a code.
- The conformance page gains the tested release, a summary by check, `/supported`, the settlement matrix,
  expiration, idempotency, concurrency, crash recovery, front-running, upstream runs by mode and scheme, MCP,
  known limitations and every command to reproduce them.
- The expiration, idempotency, crash-recovery, concurrency, front-running and asset suites run over `upto`
  too, in 6-, 7- and 18-decimal tokens: an `upto` settlement held past its expiration ledger is refused by the
  network before inclusion and costs the sponsor nothing.
- The reconciler no longer rebroadcasts a settlement that a request in the same process is still confirming.
- `rail402_channels_in_use` is read from the channel pool at every scrape instead of every 15 seconds.
- Concurrency is tested with 3 batches of 20 settlements over 8 channels with duplicates injected into each
  batch, and with two service replicas on one Postgres; `tools/conformance/src/concurrency.ts` runs the same
  batches over HTTP against a deployment.
- `/health` returns a snapshot the background poll rebuilds every 15 seconds: `state` (`healthy`, `degraded`,
  `starting`), coded warnings, and per network the RPC's latest ledger and age, the sponsor's balance and
  fees committed and wasted in the last hour, channel use and lease waits, settlement counts, repeats,
  sequence conflicts and the TTL of watched contracts, plus catalog and search figures. It still answers
  200 while the process is up and does no I/O.
- The TTL of every accepted asset's contract (the USDC Stellar Asset Contract by default), and of contracts
  listed in `TESTNET_TTL_CONTRACTS` / `PUBNET_TTL_CONTRACTS`, is read every `CONTRACT_TTL_POLL_MS` and
  exported as `rail402_contract_ttl_ledgers{network,contract,entry}`; `CONTRACT_TTL_WARN_LEDGERS` and
  `CONTRACT_TTL_CRITICAL_LEDGERS` turn it into `/health` warnings. `@rail402.dev/stellar` exports the reader,
  `readContractTtl`.
- New metrics for Stellar RPC calls by method and outcome, transport failures of the RPC and the public
  Horizon from any client in the process, the RPC's latest ledger and its age, sponsor guard refusals and
  committed fees, catalog listings by state and the cataloging queue, the catalog's background outcomes
  (`outbox`, `origin_check`, `enrich`), search index builds, embedding failures, index age and search
  latency. A test holds every label to a bounded set.
- `METRICS_TOKEN_SHA256` optionally protects `/metrics` with a bearer token.
- The operations guide explains how to alert on sequence conflicts with several replicas, where a recovery
  pass's rebroadcast of an already landed settlement is also answered `txBadSeq`.
- `/health` and `/ready` show a failure only as its kind (`connection refused`, `timed out`, `HTTP 503`, …),
  never the raw error, which can name internal hosts or database users; the error is logged. A logged error
  no longer carries an HTTP client's request URL, body, headers or response, so a keyed RPC URL or a signed
  envelope stays out of the log.
- `pnpm evidence` runs the live agent step on the builds, runs the benchmark (now schemaVersion 2 evidence)
  and refreshes the error-code coverage record, fails the operational exercises when the local network or
  Postgres is down instead of recording skipped rows, never puts the sponsor seed on a command line, can
  also run the upstream e2e suite against a deployed service (`RAIL402_EVIDENCE_HOSTED_URL`), and ends with
  `pnpm report:check --final`, which fails while any evidence is in the older format or cites a commit that
  is not on `main`. The upstream e2e run raises the catalog's new-listing quotas for its single buyer and
  records them and the catalog's outcomes; its paid MCP calls count toward the `mcp` check, and the report
  shows each run's Bazaar validation and when no hosted run is recorded.
- The operational test report covers smart accounts: a payment signed by a key the account does not accept,
  an OpenZeppelin account paying under a spending limit, and a smart account whose `__check_auth` passes the
  settle-time simulation and fails at inclusion (named `smart_account_rejected`, its fee counted as wasted).
- `Catalog` accepts a `CatalogObserver` and `SearchService` a `SearchObserver`; `SponsorBudget` accepts an
  `onRefusal` hook. Breaking for custom catalog stores: `CatalogStore.stats()` is new.
- Every `ASSETS` token is read from the network at startup. A token whose `decimals()` differs from the
  configured decimals, or a contract that is not a token, stops the service with exit code 78
  (`asset_decimals_mismatch`, `asset_not_a_token`); a token not yet deployed or not readable keeps the new
  `/ready` check `<network>:assets` failing until it is. See the new page on accepted assets.
- The Stellar Asset Contract's error numbers name a failure only for a Stellar Asset Contract. A custom
  SEP-41 token's own error is `insufficient_funds` when the payer's balance is below the amount, and
  otherwise the new code `invalid_exact_stellar_payload_token_rejected` with the error number.
  `AcceptedAsset` gains an optional `kind` (`sac` or `sep41`), read from the contract when unset, and
  `AssetDirectory` gains `inspect` and `balance`.
- Payments in a Stellar Asset Contract (7 decimals) and in a SEP-41 test token with 6 and with 18 decimals,
  from `G…` and `C…` payers, are tested end to end through the service, including amounts beyond 64 bits.

### Contracts

- `x402-upto-stellar`, a Soroban settlement contract for the x402 `upto` scheme: the payer signs a cap, the
  named settlement authority chooses the amount (0 up to the cap), and the host's nonce makes every
  authorization single-use. No admin, no storage, no upgrade path.
- Reproducible SEP-58 builds in a digest-pinned `stellar-cli` image (`scripts/contracts/build.sh`,
  `scripts/contracts/verify.sh`); CI checks that the committed wasm rebuilds bit for bit.
- The licence gate also checks the Rust dependency trees under `contracts/`.
- A SEP-41 test token for test networks (`contracts/testing/test-token`): decimals chosen at deployment,
  an open faucet, no admin. It is built on OpenZeppelin `stellar-tokens` and committed as a reproducible
  wasm fixture.
- An approve-aware spending-limit policy for OpenZeppelin smart accounts
  (`contracts/testing/approve-spending-limit`) that budgets `approve` as well as `transfer`, so smart-account
  payers can use `upto` under a spending limit. Composition tests run the upto contract against the
  OpenZeppelin smart account, its ed25519 verifier and this policy with real signatures.
- The upto contract is deployed on testnet at `CCNU3CYA6HCLF5HQSPV3UU2FYVGJ4QWKLCJPMCRSSU6ZKF6LJSN5AYPB`,
  and the 6-decimal test token `TEST6` at `CDS45IRSWVDBV4JM2FPZ52EYXYO54J6DJL35GOSXOTRA4BYM6FFRK2BK`, each with a
  deployment record (`contracts/*/deployments/`). `scripts/contracts/deploy.sh` deploys a committed wasm at an
  address derived from the deployer and a fixed salt, extends it to the maximum TTL and writes the record;
  `scripts/contracts/verify.sh --network testnet` rebuilds the recorded commit and compares it with the
  deployed wasm.

### Packages

- `@rail402.dev/upto`: the x402 `upto` scheme on Stellar. A client that signs one authorization entry over
  the payment terms, a resource-server scheme with settlement overrides, and a facilitator mechanism that
  verifies the payment for its cap, settles the actual amount with the settlement authority as operation
  source, and submits each authorization at most once. Every refusal has a stable code and a reason. Test
  vectors are generated with `pnpm --filter @rail402.dev/upto vectors` and replayed by the contract tests.
  On `stellar:testnet` it uses the deployed settlement contract unless another one is configured. The
  default settlement fee ceiling is 500,000 stroops.
- `@rail402.dev/facilitator` settles `upto` payments: a network configured with `upto` in
  `createStellarFacilitator` registers the `upto` scheme next to `exact` (in-process as well). Its settlement
  authority is derived from the sponsor's secret (`deriveAuthorityKeypair`) and created like a channel
  account (`provisionAuthority`); it is listed among the facilitator's signers and treated as a facilitator
  account by every payment check. `upto` settles through the same engine as `exact`: the settlement ledger, the
  channel lease, the envelope recorded before broadcast, confirmation, reconciliation and the search for a
  third-party landing. A repeat with the same amount is answered from the ledger; the same authorization
  for a different amount is refused with `settle_upto_stellar_idempotency_conflict`, which names the
  recorded amount and carries the recorded transaction; a landing by another transaction for a different
  amount answers `settle_upto_stellar_settled_elsewhere`. Zero settles on-chain by default;
  `zeroSettlement: "offchain"` records the authorization as used and answers `transaction: ""`. A
  simulation that would restore the settlement contract's archived instance or code inside the payment is
  refused with `invalid_upto_stellar_settlement_contract_archived`. `upto` has its own fee ceiling
  (500,000 stroops by default).
- `@rail402.dev/stellar` registers the `upto` codes as `uptoStellarCodes`, inspects `upto` payloads and
  recorded settlements, and names a missing payer account in a failed `upto` settlement. The reason of
  `unsupported_scheme` no longer names a scheme.
- Breaking for custom settlement ledgers: `claim` takes optional details (`scheme`, `amount`), records carry
  `scheme` and `amount`, and `finish` accepts `claimedBy` to complete an `upto` zero-amount settlement that
  has no transaction. The Postgres ledger adds migration `0012_upto_settlements`, which relaxes the envelope
  check for exactly that case.
- `channels provision` also creates the `upto` settlement authority, `channels status` reports it with its
  balance, and `channels retire` merges it back into the sponsor.
- The service's `upto` fee ceiling (`UPTO_MAX_TX_FEE_STROOPS`) defaults to 5,000,000 stroops on testnet and
  500,000 on pubnet: a smart account's first payment under a spending-limit policy also pays for the policy's
  record of the account, which costs several times a later payment.
- An `upto` authorization that looks too far ahead on a ledger reading a few seconds old (an expiration past
  the window, or a start ledger not yet reached) is decided again on a fresh reading before it is refused.
- `upto` is tested end to end through the service on a local network: `G…`, custom-account and OpenZeppelin
  smart-account payers settling zero, part and all of the cap with balance and event checks that prove the
  facilitator holds nothing, an 18-decimal token, tampering with every signed field, an amount over the cap
  and a foreign submitter refused on-chain, concurrent and replayed settlements, funds, trustlines, expiry,
  start ledgers, the fee ceiling, smart-account spending limits and crash recovery.

### Buyer SDK, MCP server, CLI and seller helpers

- `@rail402.dev/sdk`: `createBuyer` pays an HTTP endpoint or an MCP tool by URL (`pay`), a Bazaar listing
  (`payListing`, bound to the listing's owner and price) or the best search result (`searchAndPay`), and
  quotes without paying (`quote`). A spending policy (networks, assets, recipients, per-call and session caps,
  listing trust) is checked before anything is signed, and a signing guard checks each Soroban authorization
  against the option the policy chose, signs at most once per call, and refuses anything else. Budgets live
  in memory or in a SQLite ledger shared by processes, reserve the cap before signing and return the
  remainder only when the chain proves the settlement. Receipts name the transaction and its stellar.expert
  link; `inspectTransaction` explains a transaction and attributes it to a facilitator. Testnet defaults are
  0.10 USDC per call and 1.00 USDC per 24 hours; pubnet has no defaults. Every refusal has a registered code,
  a reason and a `paid` verdict (`none`, `not_settled`, `settled`, `unknown`). An idempotency key replays its
  own call's outcome and is refused for any other resource.
- `upto` payments from the SDK, the CLI and the MCP server: the buyer authorizes a cap for the pinned
  settlement contract and a facilitator other than the payer or the recipient, the seller settles what the
  call used, and the rest of the cap returns to the budget after proof.
- `@rail402.dev/sdk/seller`: `httpRoute`, `mcpTool`, `param.*`, `exact()` and `upto()` build configuration for
  the stock x402 middleware and `@x402/mcp` with complete, valid discovery metadata; `validateListing` shows
  what the catalog will list; `checkSellerOrigin` checks a live seller the way the catalog does;
  `withSettleDedupe` refuses a repeated settlement for `upfront` routes; `setUptoCharge`,
  `meteredToolServer` and `chargeUpto` settle the amount an `upto` route or tool used.
- `@rail402.dev/mcp` (`rail402-mcp`): the MCP tools `search_stellar_resources`, `pay_and_call` (a spending cap
  is required) and `get_budget` over stdio, or over a loopback, token-protected HTTP transport. Results have
  output schemas; refusals are `isError` results with a code, a reason and `paid`. Seller text is returned
  as bounded, sanitized, untrusted data.
- `@rail402.dev/cli` (`rail402`): `search`, `resources`, `listing`, `quote`, `pay`, `purchase`, `tx`, `session`,
  `keys`, `account setup|status` (Friendbot, a USDC trustline and testnet USDC) and `seller check|validate`,
  with one JSON document per command under `--json` and documented exit statuses.
- `@rail402.dev/safe-fetch`: the egress policy every agent-chosen URL goes through, also used by the Bazaar:
  https only by default, private, loopback, link-local and metadata addresses refused (including encoded
  and IPv4-mapped forms), the resolved address pinned for the connection, redirects limited and re-checked,
  request and response sizes and timeouts bounded.
- An error-code reference for client codes beside the service codes, with each code's `paid` verdict and CLI
  exit status.
- Secret scanning in the test suites: a canary key's seed, authorization entries, signatures and payment
  headers never appear in tool schemas, results, logs, traces, errors, ledgers or CLI output, even when a
  seller echoes the payment into its answer: a paid call's result and its stored replay carry the seller's
  content with the call's own payment replaced by `[redacted]`.
- The demo seller serves paid MCP tools (`forecast`, `air_quality`) and metered `upto` resources: `GET
/history` charged per day returned and the MCP tool `hourly_forecast` charged per forecast hour, each capped
  at 0.01 USDC. Examples: `examples/sdk-buyer` and `examples/mcp-agent`, which finds and pays a tool with no
  endpoint configured.
- `pnpm pack:check` packs every publishable package, installs the tarballs into an empty project and checks
  the bins, every entry point, the type declarations and the licence of every installed package; it runs in
  CI. Each tarball carries the licence and a README.
- `tools/conformance/src/live-agent.ts` records agents paying on the public testnet with the packages
  installed from their tarballs: an HTTP API and an MCP tool cataloged by their first paid call, found by
  search, paid through their listings and called from the SDK, the MCP server and the CLI, with `exact` and
  `upto`; the refusals an agent relies on, with balances unchanged; a stellar.expert check of every
  transaction; and a secret scan of everything the tools produced. The check `agent-payments` counts its
  cases on the conformance page.

## 0.2.1

The same code as 0.2.0, republished: on npm, `@rail402.dev/bazaar` 0.2.0 cannot be installed, and with it
neither can `@rail402.dev/search` and `@rail402.dev/store-postgres` 0.2.0. Use 0.2.1.

## 0.2.0

The first release of Rail402 from this repository. Earlier `@rail402.dev` packages on npm (0.1.x) came from a
prototype with a different API and are deprecated.

### Facilitator

- `/supported`, `/verify` and `/settle` for the x402 v2 `exact` scheme on `stellar:testnet`, built on the
  unmodified `@x402/stellar` 2.27.0 scheme; `stellar:pubnet` is configurable.
- Fees are sponsored through channel accounts derived from one sponsor key; the facilitator is never the source
  of a payment.
- `G…` and `C…` payers and recipients, SEP-41 amounts, trustline and balance checks, expiry, tampering and
  replay protection, with a stable code and reason for every rejection.
- Idempotent, crash-safe settlement with a Postgres ledger, and reconciliation of pending settlements.
- API keys, per-caller metering, a configurable service fee and Postgres-backed rate limits.

### Bazaar

- Cataloging of HTTP endpoints and MCP tools from settled payments that carry the `bazaar` extension, bound to
  the settled `payTo`, confirmed against the resource's own 402 and, where the domain's SEP-1 `stellar.toml`
  lists the owner, marked `domain_verified`.
- `GET /discovery/resources` with filters, stable pagination and a public version history per listing; one
  resource sold on several networks is one item.
- `GET /discovery/search`: BM25F and local embeddings fused with RRF, hard filters, constraints read from the
  query text, signed cursors.

### Tooling

- One-command deploys with Docker (`deploy/docker.sh`) and for the hosted service; a container image on
  GHCR for every version tag.
- Packages on npm: `@rail402.dev/facilitator`, `bazaar`, `search`, `store-postgres`, `stellar`, `errors`.
- A reproducible search evaluation (`pnpm eval`) with a CI gate, and conformance runs against a live
  facilitator.
