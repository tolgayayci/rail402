# Changelog

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
- `.railway/railway.ts` keeps every setting an operator set, so `railway config apply` no longer removes a
  tuned rate limit, API key or quota; a test fails when a setting is neither declared nor left unmanaged
  with a reason.
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

- One-command deploys with Docker (`deploy/docker.sh`) and Railway (`deploy/railway.sh`); a container image on
  GHCR for every version tag.
- Packages on npm: `@rail402.dev/facilitator`, `bazaar`, `search`, `store-postgres`, `stellar`, `errors`.
- A reproducible search evaluation (`pnpm eval`) with a CI gate, and conformance runs against a live
  facilitator.
