---
title: Errors and verification rules
sidebarTitle: Errors and verification
description: Every check Rail402 makes, the code it returns, where the check lives and which test proves it.
---

Every check Rail402 makes before it sponsors a Stellar payment, in the order it makes them, with
the code it returns, where the check lives and which test proves it. A rejection is always an
HTTP 200 body with `isValid: false` (`/verify`) or `success: false` (`/settle`), a code from
`packages/stellar/src/codes.ts` and a non-empty human-readable reason
(`packages/facilitator/test/state.test.ts`, "wire responses always carry a registered code and a
non-empty reason"). `/settle` never relies on an earlier `/verify`: it runs stages 1–5 again, and
upstream settlement runs stage 6 again before anything is signed or broadcast (see stage 8).

Rail402 does not reimplement verification. Its own checks (stages 1–5) run first, before any
simulation, so a payment that cannot settle is refused cheaply and with a specific code. The only
RPC data they use is the latest ledger number: `/verify` answers from a reading up to 5 seconds old
and refreshes it in the background, while `/settle` waits for a reading no older than 1 second
(`packages/stellar/src/ledger-clock.ts`, tested in `ledger-clock.test.ts`). The unmodified
`@x402/stellar` verifier (stage 6) then runs every check of the `exact` Stellar scheme, including
simulation. Rail402 only adds a diagnosis of why a simulation failed (stage 7) and makes settlement
idempotent and crash-safe (stage 8).

Test files, relative to the repository root:

| Short name     | File                                                                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| app            | `apps/rail402/test/app.test.ts`                                                                                                          |
| service        | `apps/rail402/test/service.integration.test.ts`                                                                                          |
| bazaar         | `apps/rail402/test/bazaar.integration.test.ts`                                                                                           |
| payload        | `packages/stellar/test/payload.test.ts`                                                                                                  |
| diagnostics    | `packages/stellar/test/diagnostics.test.ts`                                                                                              |
| preflight      | `packages/facilitator/test/preflight.test.ts`                                                                                            |
| explain        | `packages/facilitator/test/explain.test.ts`                                                                                              |
| settlement     | `packages/facilitator/test/settlement.integration.test.ts`                                                                               |
| idempotency    | `apps/rail402/test/idempotency.integration.test.ts` (in-memory and Postgres ledgers) and `packages/facilitator/test/idempotency.test.ts` |
| expiration     | `packages/facilitator/test/expiration.integration.test.ts`                                                                               |
| catalog        | `packages/bazaar/src/testing.ts` (run by `packages/bazaar/test/memory-catalog.test.ts` and the Postgres store tests)                     |
| security       | `packages/bazaar/test/security.test.ts`                                                                                                  |
| mcp-origin     | `packages/bazaar/test/mcp-origin.test.ts`                                                                                                |
| assets         | `tools/conformance/test/assets.integration.test.ts`, payments in tokens of 6, 7 and 18 decimals through the service                      |
| crash recovery | `apps/rail402/test/crash-recovery.integration.test.ts`, which kills the service process at each step of a settlement                     |
| upstream e2e   | `tools/conformance/src/upstream-e2e.ts`, the x402 e2e suite run against Rail402                                                          |
| live matrix    | `tools/conformance/src/live-matrix.ts`, run over HTTP against a deployed Rail402 on the public testnet                                   |

Integration tests run against a private Stellar network (`docker compose --profile stellar up`)
with real accounts, a real token contract and real balance changes.

## 0. Request

`apps/rail402/src/app.ts`, before any payment logic.

In this order:

| Check                                                                               | Result                                        | Tested by |
| ----------------------------------------------------------------------------------- | --------------------------------------------- | --------- |
| The caller is within its rate limit                                                 | `rate_limited` (HTTP 429, with `Retry-After`) | app       |
| Body within `BODY_LIMIT_BYTES`                                                      | `payload_too_large` (HTTP 413)                | app       |
| `Content-Type` is `application/json`                                                | `unsupported_media_type` (HTTP 415)           | app       |
| Body is JSON with `x402Version`, `paymentPayload` and `paymentRequirements` objects | `invalid_payload` (HTTP 400)                  | app       |
| The network is one this deployment serves                                           | `invalid_network`                             | app       |
| The scheme is one this network serves (`exact`; `upto` where enabled)               | `unsupported_scheme`                          | app       |
| An API key is presented where the network requires one                              | `unauthorized` (HTTP 401)                     | app       |

## 1. Protocol envelope

`preflight()` in `packages/facilitator/src/preflight.ts`.

| Check                                                            | Code                   | Tested by |
| ---------------------------------------------------------------- | ---------------------- | --------- |
| `x402Version` is 2                                               | `invalid_x402_version` | preflight |
| Requirements and accepted block both use the `exact` scheme      | `unsupported_scheme`   | preflight |
| The requirements' network is the one this scheme instance serves | `invalid_network`      | preflight |
| The accepted block's network equals the requirements' network    | `network_mismatch`     | preflight |

## 2. Operator policy on the requirements

`checkRequirements()` in `packages/facilitator/src/preflight.ts`. Limits come from configuration
([configuration.md](configuration.md)), never from the request.

| Check                                                                    | Code                                                      | Tested by |
| ------------------------------------------------------------------------ | --------------------------------------------------------- | --------- |
| The asset is one this network accepts                                    | `invalid_exact_stellar_requirements_asset_not_accepted`   | preflight |
| `payTo` is a G… or C… address; a muxed M… address is refused (see below) | `invalid_exact_stellar_requirements_invalid_pay_to`       | preflight |
| `amount` is a positive integer string in base units                      | `invalid_exact_stellar_requirements_invalid_amount`       | preflight |
| `amount` is within the asset's configured minimum and maximum            | `invalid_exact_stellar_requirements_amount_out_of_range`  | preflight |
| `maxTimeoutSeconds` is an integer within the configured range            | `invalid_exact_stellar_requirements_timeout_out_of_range` | preflight |
| `extra.areFeesSponsored` is `true`                                       | `invalid_exact_stellar_requirements_fees_not_sponsored`   | preflight |
| The payload's accepted asset, `payTo` and amount equal the requirements  | `invalid_exact_stellar_payload_accepted_mismatch`         | preflight |

A transfer to a muxed `M…` address credits its base `G…` account, and its CAP-67 `transfer` event names that
base account with `{ amount, to_muxed_id }` as data. The `@x402/stellar` exact verifier matches the event's
recipient and amount against `payTo` literally, so such a payment can never verify; Rail402 refuses a muxed
`payTo` before any RPC call instead of failing in simulation; sellers put the base `G…` account in `payTo`
(preflight, muxed integration test).

## 3. Transaction structure

`inspectExactTransaction()` in `packages/stellar/src/payload.ts`. `payload.transaction` is taken
verbatim; nothing in it is rewritten.

| Check                                                                | Code                                                | Tested by          |
| -------------------------------------------------------------------- | --------------------------------------------------- | ------------------ |
| `payload.transaction` is at most the size limit                      | `invalid_exact_stellar_payload_too_large`           | payload            |
| It is a base64 v1 transaction envelope that decodes for this network | `invalid_exact_stellar_payload_malformed`           | payload            |
| Exactly one operation, an `invokeHostFunction` invoking a contract   | `invalid_exact_stellar_payload_wrong_operation`     | payload, preflight |
| The call is `transfer(Address from, Address to, i128 amount)`        | `invalid_exact_stellar_payload_wrong_function_name` | payload            |

## 4. Accounts and amounts

`preflight()`. The facilitator's accounts are the sponsor and every channel account.

| Check                                                                     | Code                                                      | Tested by              |
| ------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------- |
| Neither the transaction nor the operation source is a facilitator account | `invalid_exact_stellar_payload_unsafe_tx_or_op_source`    | preflight              |
| The payer (`from`) is not a facilitator account                           | `invalid_exact_stellar_payload_facilitator_is_payer`      | preflight              |
| The invoked contract is the required asset                                | `invalid_exact_stellar_payload_wrong_asset`               | preflight              |
| `to` is the required `payTo`                                              | `invalid_exact_stellar_payload_wrong_recipient`           | preflight              |
| The payer is not paying its own account (`to` differs from `from`)        | `invalid_exact_stellar_payload_self_payment`              | preflight, live matrix |
| `amount` is exactly the required amount (SEP-41 base units, no rounding)  | `invalid_exact_stellar_payload_wrong_amount`              | preflight, service     |
| No ledger bounds, sequence conditions or extra signers                    | `invalid_exact_stellar_payload_unsupported_preconditions` | preflight              |

## 5. Authorization and expiry

`preflight()`.

| Check                                                                            | Code                                                          | Tested by             |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------- | --------------------- |
| Every entry uses address credentials (legacy or CAP-71 V2), never source-account | `invalid_exact_stellar_payload_unsupported_credential_type`   | preflight             |
| At least one authorization entry                                                 | `invalid_exact_stellar_payload_no_auth_entries`               | preflight             |
| No facilitator account appears in any entry                                      | `invalid_exact_stellar_payload_facilitator_in_auth`           | preflight             |
| No entry authorizes sub-invocations                                              | `invalid_exact_stellar_payload_has_subinvocations`            | preflight             |
| The payer has signed an entry                                                    | `invalid_exact_stellar_payload_missing_payer_signature`       | preflight             |
| No other entry awaits a signature                                                | `invalid_exact_stellar_payload_unexpected_pending_signatures` | preflight             |
| The payer's entry authorizes exactly the call the operation makes                | `invalid_exact_stellar_payload_auth_invocation_mismatch`      | preflight, settlement |
| The authorization has not expired (inclusive of its expiration ledger)           | `invalid_exact_stellar_signature_expired`                     | preflight, settlement |
| It stays valid for at least `EXPIRATION_MARGIN_LEDGERS` more ledgers             | `invalid_exact_stellar_signature_expiration_too_soon`         | preflight, settlement |

## 6. Upstream verifier

`ExactStellarScheme.verify` from `@x402/stellar` 2.27.0, unmodified, called by
`packages/facilitator/src/scheme.ts`. It simulates the transaction against the current ledger in
enforcing mode, which verifies the payer's signature and runs a smart account's `__check_auth`, and
then checks the simulated result. Its fee ceiling is checked at the inclusion-fee bid settlement
would use: a percentile of the network's recent fee stats, reused for 5 seconds and answered stale
for up to 60 seconds while it is refreshed in the background (`packages/facilitator/src/fees.ts`,
tested in `fees.test.ts`). Its codes, which Rail402 returns unchanged:

| Check                                                              | Code                                                                   |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Simulation succeeds                                                | `invalid_exact_stellar_payload_simulation_failed` (refined in stage 7) |
| The settlement fee is within `MAX_TX_FEE_STROOPS`                  | `invalid_exact_stellar_payload_fee_exceeds_maximum`                    |
| The authorization expires no later than `maxTimeoutSeconds` allows | `invalid_exact_stellar_signature_expiration_too_far`                   |
| Every emitted event is a `transfer`                                | `invalid_exact_stellar_payload_event_not_transfer`                     |
| Every event names its contract                                     | `invalid_exact_stellar_payload_event_missing_contract_id`              |
| The event comes from the required asset's contract                 | `invalid_exact_stellar_payload_event_wrong_asset`                      |
| There is a transfer event                                          | `invalid_exact_stellar_payload_no_transfer_events`                     |
| There is only one transfer event                                   | `invalid_exact_stellar_payload_multiple_transfers`                     |
| The event debits the payer                                         | `invalid_exact_stellar_payload_event_wrong_from`                       |
| The event credits `payTo`                                          | `invalid_exact_stellar_payload_event_wrong_to`                         |
| The event moves exactly the required amount                        | `invalid_exact_stellar_payload_event_wrong_amount`                     |

These are covered by upstream's own tests (`typescript/packages/mechanisms/stellar/test` in
x402-foundation/x402), and on Rail402 by the settlement tests (every settlement passes through
them) and the upstream e2e run. Tampering is caught here: changing the amount after signing fails
simulation because the signature no longer verifies (settlement, "rejects tampering").

## 7. Why a simulation failed

Upstream reports every failed simulation as `invalid_exact_stellar_payload_simulation_failed`.
Rail402 re-simulates in enforcing mode and names the on-chain cause from the host's diagnostic
events (`explainSimulation()` in `packages/facilitator/src/explain.ts`,
`classifyTransferFailure()` in `packages/stellar/src/diagnostics.ts`). The same mapping names the
cause of a settlement transaction that was included but failed.

| Host error                                                  | Code                                                        | Tested by               |
| ----------------------------------------------------------- | ----------------------------------------------------------- | ----------------------- |
| Auth `ExistingValue`: this nonce was already used (replay)  | `invalid_exact_stellar_payload_nonce_already_used`          | diagnostics, settlement |
| Crypto `InvalidInput`: the signature does not verify        | `invalid_exact_stellar_payload_invalid_signature`           | diagnostics, settlement |
| The signature expired between checks                        | `invalid_exact_stellar_signature_expired`                   | diagnostics, settlement |
| A smart account's `__check_auth` failed                     | `invalid_exact_stellar_payload_smart_account_rejected`      | diagnostics, settlement |
| Other authorization failure                                 | `invalid_exact_stellar_payload_unauthorized_invocation`     | diagnostics             |
| SAC #13, missing trustline on `payTo`                       | `invalid_exact_stellar_payload_recipient_trustline_missing` | diagnostics, settlement |
| SAC #13, missing trustline on the payer                     | `invalid_exact_stellar_payload_payer_trustline_missing`     | diagnostics, settlement |
| SAC #10, balance lower than the amount                      | `insufficient_funds`                                        | diagnostics, settlement |
| SAC #6, account missing                                     | `invalid_exact_stellar_payload_account_missing`             | diagnostics             |
| SAC #11, trustline not authorized by the issuer             | `invalid_exact_stellar_payload_trustline_not_authorized`    | diagnostics             |
| A custom token's own error, payer balance below the amount  | `insufficient_funds`                                        | explain, assets         |
| A custom token's own error otherwise                        | `invalid_exact_stellar_payload_token_rejected`              | diagnostics, explain    |
| Simulation asks for a restore of archived state             | `invalid_exact_stellar_payload_archived_state`              | explain                 |
| A settlement included in a ledger failed for another reason | `invalid_transaction_state`                                 | explain                 |

Error numbers belong to the contract that raises them, so the SAC rows apply only to a Stellar Asset
Contract. The facilitator learns each accepted token's kind from its contract instance (the service reads
it at startup). A custom SEP-41 token's error `#N` is reported as
`invalid_exact_stellar_payload_token_rejected` with the reason "The token contract rejected the transfer
with error #N.", unless a read-only `balance(from)` shows the payer holds less than the amount, which is
`insufficient_funds`. A token whose kind cannot be read is treated as a custom one.

Anything unrecognised keeps upstream's `invalid_exact_stellar_payload_simulation_failed`.

## 8. Settlement

`StellarExactScheme.settle()` in `packages/facilitator/src/scheme.ts` first decodes the payload and
looks its authorization (network, payer, nonce) up in the settlement ledger. A request whose
settlement was already submitted is answered from the ledger before anything else is decided, so a
repeat gets the recorded result however late it arrives, even after the authorization expired or
while the sponsor guard refuses new settlements. Otherwise it runs stages 1–5 again. Then
`SettlementEngine.settle()` in `packages/facilitator/src/engine.ts` admits the settlement through the
sponsor guard, claims the authorization and leases a channel account. Upstream's
`ExactStellarScheme.settle` runs stage 6 again, and a rejection there is diagnosed as in stage 7;
otherwise it settles the payment with the leased channel account as the transaction source and the
sponsor paying the fee through a fee bump. The facilitator is never
the source of the transferred funds (settlement, "payer debited, payTo credited, facilitator only
pays the fee").

A repeat is the same request when its fingerprint matches: SHA-256 over the canonical JSON of the
scheme, network, asset, `payTo`, the settle-time `amount` and the signed transaction
(`packages/facilitator/src/fingerprint.ts`). Settlements recorded before fingerprints existed compare
the signed transaction alone. Rejections decided before anything is signed (stages 1–7, the sponsor
guard, `settle_exact_stellar_channel_unavailable`) leave no record, so the same payment can be retried
once the cause is fixed, for example after `payTo` adds a trustline.

| Step and check                                                                                                                                                | Code                                                 | Tested by                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------- |
| The sponsor guard admits the settlement: balance above `SPONSOR_RESERVE_XLM`, hourly fee budget not spent                                                     | `settle_exact_stellar_sponsor_unavailable`           | settlement, `fees.test.ts`        |
| A repeat of a submitted settlement returns the recorded response and moves funds once; it is marked in `EXTENSION-RESPONSES` (below)                          | (the recorded response)                              | settlement, idempotency           |
| The authorization is not already held by a different request: another envelope, `payTo`, asset, network or amount; the reason names the recorded transaction  | `settle_exact_stellar_idempotency_conflict`          | settlement, idempotency           |
| A duplicate of a settlement in progress waits for it; if it outlasts the wait before signing                                                                  | `settle_exact_stellar_settlement_in_progress`        | settlement, idempotency           |
| A channel account is free within the wait                                                                                                                     | `settle_exact_stellar_channel_unavailable`           | settlement                        |
| The signed envelope is recorded before broadcast; if it cannot be, nothing is broadcast                                                                       | `settle_exact_stellar_fee_bump_signing_failed`       | settlement                        |
| The transaction lands in a ledger and succeeds                                                                                                                | success                                              | settlement, service, upstream e2e |
| It lands and fails                                                                                                                                            | stage 7 code, or `invalid_transaction_state`         | explain                           |
| A ledger closes after its time bound without it, and nothing carried the authorization (hash, inner hash, payer's nonce or retained history): no funds moved  | `settle_exact_stellar_transaction_expired`           | settlement, crash recovery        |
| The network refuses bytes that can never apply (bad signature, missing account); a fee or balance shortfall keeps rebroadcasting until the time bound decides | `settle_exact_stellar_transaction_submission_failed` | settlement                        |
| Not final within `confirmTimeoutMs` of recording the envelope, however long upstream would poll; the reconciler finishes it later                             | `settlement_pending` (with the transaction hash)     | settlement                        |
| An unexpected internal error                                                                                                                                  | `unexpected_verify_error`, `unexpected_settle_error` | app (`unexpected_verify_error`)   |

Only the recorded bytes are ever resubmitted, so a lost response or a restart can never produce a
second transaction for the same authorization (settlement, "recovers after a lost submission
response"; crash recovery, which kills the service process at each step). After the time bound,
"not found" for the transaction's own hash proves nothing by itself: its inner hash is looked up too (in
case someone wrapped it in their own fee bump), and the payer's authorization nonce is read. A consumed
nonce finishes the settlement only once the transaction that consumed it is identified on chain. When
neither landing nor absence can be proven (the RPC no longer retains the ledgers since the claim, or
the nonce was consumed by a transaction that cannot be identified), the settlement stays unfinished and
is reported as unresolvable instead of expired (see [operations.md](operations.md), "State, backups
and recovery").

**Repeats are marked.** A settle response answered from an earlier settlement carries
`{"rail402":{"settlement":{"repeat":true,"settledBy":"rail402"}}}` in the `EXTENSION-RESPONSES`
header, next to any `bazaar` outcome, and the body is the recorded response unchanged. The stock
`HTTPFacilitatorClient` exposes it as `extensionResponses.rail402`, and resource servers never forward
it to the buyer. A seller that must serve each payment once can refuse a request whose settlement is a
repeat. Repeats are counted in `rail402_settlement_repeats_total`, not in `rail402_settlements_total`,
and metered as `repeat` (see [Operations](/operations)).

**Front-running.** A settlement transaction carries the payer's signed authorization, and anyone
who sees it before it lands can copy that authorization entry into a transaction of their own. If
the copy lands first, the payment still happens exactly as the payer signed it, and Rail402's own
transaction then fails on the consumed nonce. Rail402 answers such a payment as settled, with the
other transaction's hash, only when the chain proves it (`packages/facilitator/src/third-party.ts`):

1. the payer's nonce entry exists, and the ledger that consumed it closed no earlier than the
   settle request was claimed, so the authorization was not spent before Rail402 was asked;
2. a successful transaction in that ledger carries an address-credential authorization entry for
   the payer with the same nonce and expiration ledger and a byte-equal root invocation;
3. that transaction emitted the matching `transfer` event from the asset contract.

The search runs only after Rail402's own transaction was included and failed on the consumed nonce
(or with a cause the RPC's diagnostics do not name). Anything short of all three, or any read
error, keeps the failure. The settlement is recorded with `settled_by = third_party`; the response
is `success` with the other transaction's hash, repeats return it with
`"settledBy":"third_party"` in the repeat marker, and the fee of Rail402's failed transaction is
counted as wasted. Set `RECONCILE_THIRD_PARTY_SETTLEMENTS=false` to answer the failure instead.

| Behaviour                                                                                                         | Tested by |
| ----------------------------------------------------------------------------------------------------------------- | --------- |
| An attacker lands a copy of the payer's authorization first: success with the attacker's hash, funds moved once   | front-run |
| The fee of Rail402's failed transaction is counted once as wasted; a repeat returns the same response             | front-run |
| An authorization consumed before the request was claimed stays `invalid_exact_stellar_payload_nonce_already_used` | front-run |
| With the reconciliation off, the failure is answered                                                              | front-run |

**Verify reads the ledger.** After stages 1–5, `/verify` looks the authorization up, read-only, so an
authorization that is being settled, or was, is never reported as valid:

| Ledger state of the authorization         | Code                                                                              | Tested by   |
| ----------------------------------------- | --------------------------------------------------------------------------------- | ----------- |
| Claimed or submitted, not final           | `settle_exact_stellar_settlement_in_progress`                                     | idempotency |
| Settled; the reason names the transaction | `invalid_exact_stellar_payload_nonce_already_used`                                | idempotency |
| Failed or expired                         | the recorded code, with "This authorization was already submitted for settlement" | idempotency |

If the ledger cannot be read, the check is skipped and counted in
`rail402_settlement_ledger_read_failures_total`; verification stays available and the network's own
nonce check still refuses a spent authorization.

## `upto` payments

An `upto` payment carries one signed Soroban authorization entry instead of a transaction (see
[upto payments](/facilitator/upto)). Rail402 checks it in the same spirit as `exact`: everything that
can be decided without the network first, then an enforcing simulation of the settlement itself, then
settlement through the same engine. `/verify` checks the payment for its cap; `/settle` checks it
again for the amount being settled. The static rules are `checkUptoPayment()` in
`packages/upto/src/facilitator/rules.ts` and `inspectUptoAuthorization()` in
`packages/upto/src/authorization.ts`, run by `uptoPreflight()` in
`packages/facilitator/src/upto-preflight.ts`; the simulation rules are in
`packages/upto/src/facilitator/simulation.ts`; `StellarUptoScheme` in
`packages/facilitator/src/upto-scheme.ts` puts them in order.

### U1. Envelope and operator policy

| Check                                                                                | Code                                                     | Tested by                 |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------- | ------------------------- |
| The scheme and network are a kind this service serves (`GET /supported`)             | `unsupported_scheme` (HTTP layer)                        | app                       |
| `x402Version` is 2                                                                   | `invalid_x402_version`                                   | upto-preflight            |
| Requirements and accepted block both use `upto`                                      | `unsupported_scheme`                                     | upto-preflight            |
| The requirements' network is the one this scheme instance serves                     | `invalid_network`                                        | upto-preflight            |
| The accepted block's network equals the requirements' network                        | `network_mismatch`                                       | upto-preflight            |
| `maxTimeoutSeconds` is an integer within `TIMEOUT_MIN_SECONDS`–`TIMEOUT_MAX_SECONDS` | `invalid_upto_stellar_requirements_timeout_out_of_range` | upto-preflight, mechanism |
| The cap is within the asset's configured minimum and maximum                         | `invalid_upto_stellar_requirements_amount_out_of_range`  | upto-preflight            |

### U2. Requirements (rule 2)

| Check                                                                                                                           | Code                                                     | Tested by                                |
| ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------- |
| `asset` is the `C…` address of a token this network accepts                                                                     | `invalid_upto_stellar_requirements_asset_not_accepted`   | upto-preflight, mechanism                |
| `payTo` is not a muxed `M…` address (the token moves with `transfer_from`, which takes no muxed id)                             | `invalid_upto_stellar_payload_unsupported_recipient`     | upto-preflight                           |
| `payTo` is a `G…` or `C…` address, and not a facilitator account, the settlement contract or the asset                          | `invalid_upto_stellar_requirements_invalid_pay_to`       | upto-preflight, mechanism                |
| `extra.areFeesSponsored` is `true`                                                                                              | `invalid_upto_stellar_requirements_fees_not_sponsored`   | upto-preflight                           |
| `extra.facilitatorAddress` is this facilitator's settlement authority                                                           | `invalid_upto_stellar_requirements_facilitator_mismatch` | upto-preflight, upto-tamper              |
| The accepted block has the same network, asset, `payTo` and `maxTimeoutSeconds`, and `extra` includes the requirements' `extra` | `invalid_upto_stellar_payload_accepted_mismatch`         | upto-preflight                           |
| The accepted amount (the cap) and the requirements' amount are integers in base units; the cap is positive and within `i128`    | `invalid_upto_stellar_requirements_invalid_amount`       | upto-preflight, mechanism                |
| At `/verify`, the amount equals the cap                                                                                         | `invalid_upto_stellar_payload_accepted_mismatch`         | upto-preflight                           |
| At `/settle`, the amount is at most the cap (zero is allowed)                                                                   | `invalid_upto_stellar_payload_settlement_exceeds_amount` | upto-preflight, upto-tamper, upto-payers |

### U3. The authorization entry (rules 3–4)

| Check                                                                                                         | Code                                                       | Tested by                          |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------- |
| `payload.authorization` is a string of at most 8 KiB                                                          | `invalid_upto_stellar_payload_too_large`                   | codec, upto-preflight              |
| It decodes as exactly one base64 `SorobanAuthorizationEntry`                                                  | `invalid_upto_stellar_payload_malformed`                   | codec, upto-preflight              |
| Its credentials are address credentials (legacy or CAP-71 V2), never source-account or with delegates         | `invalid_upto_stellar_payload_unsupported_credential_type` | codec, upto-preflight, upto-tamper |
| The entry is signed                                                                                           | `invalid_upto_stellar_payload_missing_payer_signature`     | upto-preflight, upto-tamper        |
| The root is a contract call of this network's settlement contract                                             | `invalid_upto_stellar_payload_wrong_contract`              | upto-preflight, upto-tamper        |
| The call is `settle` with exactly one argument                                                                | `invalid_upto_stellar_payload_wrong_function`              | codec, upto-preflight, upto-tamper |
| The argument is the six-field terms map with exactly the expected types, byte-equal to its canonical encoding | `invalid_upto_stellar_payload_invalid_terms`               | codec, upto-preflight              |

### U4. The signed terms (rules 5–6)

| Check                                                                                                                              | Code                                                      | Tested by                       |
| ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------- |
| `terms.recipient` is `payTo`                                                                                                       | `invalid_upto_stellar_payload_wrong_recipient`            | upto-preflight, upto-tamper     |
| `terms.token` is the asset                                                                                                         | `invalid_upto_stellar_payload_wrong_asset`                | upto-preflight, upto-tamper     |
| `terms.facilitator` is this facilitator's settlement authority                                                                     | `invalid_upto_stellar_payload_facilitator_mismatch`       | upto-preflight, upto-tamper     |
| `terms.max_amount` is the accepted amount (the cap)                                                                                | `invalid_upto_stellar_payload_wrong_amount`               | upto-preflight, upto-tamper     |
| `terms.expiration_ledger` equals the credential's `signatureExpirationLedger`                                                      | `invalid_upto_stellar_payload_expiration_mismatch`        | upto-preflight, upto-tamper     |
| `terms.valid_after_ledger` is at most the next ledger                                                                              | `invalid_upto_stellar_payload_not_yet_valid`              | upto-preflight, upto-settlement |
| The tree is exactly `settle(terms)` with one child, `token.approve(payer, contract, cap, expiration_ledger)`, and nothing below it | `invalid_upto_stellar_payload_invalid_authorization_tree` | upto-preflight, upto-tamper     |

### U5. Expiration, payer and delegated signers (rules 7–9)

| Check                                                                                                                                                                                                                                   | Code                                                        | Tested by                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------- |
| The authorization has not expired (inclusive of its expiration ledger)                                                                                                                                                                  | `invalid_upto_stellar_signature_expired`                    | upto-preflight, upto-settlement, expiration |
| It stays valid for at least `EXPIRATION_MARGIN_LEDGERS` more ledgers                                                                                                                                                                    | `invalid_upto_stellar_signature_expiration_too_soon`        | upto-preflight, upto-settlement, expiration |
| It expires no later than `current + ceil(maxTimeoutSeconds / ledger seconds) + 2`                                                                                                                                                       | `invalid_upto_stellar_signature_expiration_too_far`         | upto-preflight, upto-settlement, expiration |
| The payer is not a facilitator account or the settlement contract                                                                                                                                                                       | `invalid_upto_stellar_payload_facilitator_is_payer`         | upto-preflight                              |
| The payer is not `payTo`                                                                                                                                                                                                                | `invalid_upto_stellar_payload_self_payment`                 | upto-preflight                              |
| `signerAuthorizations`, when present, belong to a `C…` payer: at most 4 distinct signed entries of at most 8 KiB, each for a signer other than the payer and the facilitator, whose root is the payer's `__check_auth` with no children | `invalid_upto_stellar_payload_invalid_signer_authorization` | codec, upto-preflight                       |

`too_far` and `not_yet_valid` can be caused by a ledger reading a few seconds old, so `/verify` decides
them again on a fresh reading before refusing (upto-scheme).

### U6. Readiness and the settlement ledger

| Check                                                                                     | Code                                              | Tested by                 |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------- |
| The settlement authority's account exists (an off-chain zero settlement does not need it) | `settle_upto_stellar_authority_unavailable`       | upto-scheme, upto-service |
| `/verify`: the authorization is not being settled                                         | `settle_upto_stellar_settlement_in_progress`      | upto-scheme, idempotency  |
| `/verify`: the authorization was not settled already                                      | `invalid_upto_stellar_payload_nonce_already_used` | upto-scheme, idempotency  |

### U7. Simulation (rules 10–12)

The facilitator builds the settlement exactly as it would submit it, `settle(payer, terms, amount)`
with the settlement authority as the operation source and its source-account authorization, and
simulates it in enforcing mode for the phase's amount: the cap at `/verify`, the amount at `/settle`.
The payer's signature, a smart account's `__check_auth` and the token's balance and trustline rules
all run. A failure is named from the host's diagnostic events; contract error numbers are attributed
to the contract that raised them, because the settlement contract and a Stellar Asset Contract share
numbers.

| Finding                                                                                                                                                                                                                                                           | Code                                                                                                                | Tested by                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Auth `ExistingValue`: the nonce was already used                                                                                                                                                                                                                  | `invalid_upto_stellar_payload_nonce_already_used`                                                                   | mechanism, upto-tamper, upto-settlement |
| The payer's signature does not verify, or the settlement is not authorized as signed                                                                                                                                                                              | `invalid_upto_stellar_payload_invalid_signature`                                                                    | mechanism, upto-tamper                  |
| A `C…` payer's `__check_auth`, or a verifier or policy it calls, refused                                                                                                                                                                                          | `invalid_upto_stellar_payload_smart_account_rejected`                                                               | mechanism, upto-payers                  |
| A `G…` payer's signature fails because its account does not exist; or SAC #6                                                                                                                                                                                      | `invalid_upto_stellar_payload_account_missing`                                                                      | upto-scheme, upto-settlement            |
| SAC #10 (or #100 of an OpenZeppelin SEP-41 token): the payer holds less than the phase amount                                                                                                                                                                     | `insufficient_funds`                                                                                                | mechanism, upto-settlement              |
| SAC #13 on `payTo` / on the payer                                                                                                                                                                                                                                 | `invalid_upto_stellar_payload_recipient_trustline_missing` / `invalid_upto_stellar_payload_payer_trustline_missing` | mechanism, upto-settlement              |
| SAC #11: a trustline not authorized by the issuer                                                                                                                                                                                                                 | `invalid_upto_stellar_payload_trustline_not_authorized`                                                             | mechanism                               |
| Settlement contract #1 (cap not positive)                                                                                                                                                                                                                         | `invalid_upto_stellar_payload_invalid_terms`                                                                        | mechanism, contract                     |
| Settlement contract #2 (negative amount)                                                                                                                                                                                                                          | `invalid_upto_stellar_requirements_invalid_amount`                                                                  | mechanism, contract                     |
| Settlement contract #3 (amount over the cap)                                                                                                                                                                                                                      | `invalid_upto_stellar_payload_settlement_exceeds_amount`                                                            | mechanism, contract, upto-tamper        |
| Settlement contract #4 / #5 (not yet valid / expired)                                                                                                                                                                                                             | `invalid_upto_stellar_payload_not_yet_valid` / `invalid_upto_stellar_signature_expired`                             | mechanism, contract                     |
| Settlement contract #6 (the recipient is the contract)                                                                                                                                                                                                            | `invalid_upto_stellar_requirements_invalid_pay_to`                                                                  | mechanism, contract                     |
| The simulation would restore the settlement contract's archived instance or code                                                                                                                                                                                  | `invalid_upto_stellar_settlement_contract_archived`                                                                 | mechanism, upto-scheme, upto-archival   |
| The simulation would restore other archived state                                                                                                                                                                                                                 | `invalid_upto_stellar_payload_archived_state`                                                                       | mechanism                               |
| Any other simulation failure                                                                                                                                                                                                                                      | `invalid_upto_stellar_payload_simulation_failed`                                                                    | mechanism                               |
| The fee (resource fee plus the inclusion bid) is within `UPTO_MAX_TX_FEE_STROOPS`                                                                                                                                                                                 | `invalid_upto_stellar_payload_fee_exceeds_maximum`                                                                  | mechanism, upto-settlement              |
| Exactly one balance event: a `transfer` of the phase amount from the payer to `payTo` by the asset (none for zero), and no balance event involves a facilitator account; a payer or `payTo` that is the asset's issuer emits `mint` or `burn` and is refused here | `invalid_upto_stellar_payload_unexpected_balance_change`                                                            | mechanism                               |
| Exactly one `upto_settled` event from the settlement contract, naming the payer, `payTo`, token, amount, cap and authority                                                                                                                                        | `invalid_upto_stellar_payload_settlement_event_mismatch`                                                            | mechanism                               |

### U8. Settlement

`StellarUptoScheme.settle()` first looks the authorization (network, payer, nonce) up in the settlement
ledger, as `exact` does, and the same engine settles it (stage 8): sponsor guard, claim, channel lease,
envelope recorded before broadcast, confirmation from the recorded bytes, crash recovery and
reconciliation. The transaction's source is the leased channel, the settlement operation's source is
the settlement authority, and the sponsor pays through a fee bump; its ledger bounds end at
`expiration_ledger + 1`. The fingerprint of an `upto` request covers the scheme, network, asset,
`payTo`, the authorization, any signer entries and the settle amount
(`packages/facilitator/src/fingerprint.ts`).

| Step and check                                                                                          | Code                                                 | Tested by                                   |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------- |
| A repeat (same authorization, same amount) returns the recorded response and moves funds once           | (the recorded response)                              | upto-scheme, upto-settlement, upto-replicas |
| The same authorization for a different amount; the reason names the recorded amount and transaction     | `settle_upto_stellar_idempotency_conflict`           | upto-scheme, upto-settlement, upto-replicas |
| A duplicate of a settlement in progress outlasts the wait                                               | `settle_upto_stellar_settlement_in_progress`         | upto-scheme                                 |
| The sponsor guard refuses (not for an off-chain zero, which costs nothing)                              | `settle_upto_stellar_sponsor_unavailable`            | upto-scheme                                 |
| No channel account is free within the wait                                                              | `settle_upto_stellar_channel_unavailable`            | upto-scheme                                 |
| The signed envelope cannot be recorded before broadcast; nothing is broadcast                           | `settle_upto_stellar_fee_bump_signing_failed`        | mechanism                                   |
| The network refuses the bytes for good; neither the inner hash nor the payer's nonce shows they landed  | `settle_upto_stellar_transaction_submission_failed`  | upto-engine                                 |
| It lands and fails; the cause is named as in U7 where the diagnostics allow                             | U7 code, or `settle_upto_stellar_transaction_failed` | mechanism, upto-engine                      |
| It can no longer land (a time or ledger bound passed) and provably did not (inner hash, nonce, history) | `settle_upto_stellar_transaction_expired`            | mechanism, upto-engine, expiration          |
| Not final within `SETTLE_CONFIRM_TIMEOUT_MS`; the reconciler finishes it                                | `settlement_pending` (with the hash)                 | mechanism, upto-engine                      |
| Another holder of the authority landed the same authorization first for the same amount                 | success, `settledBy: third_party`                    | upto-engine, front-run                      |
| … for a different amount                                                                                | `settle_upto_stellar_settled_elsewhere`              | upto-engine, front-run                      |
| A zero amount with `UPTO_ZERO_SETTLEMENT=offchain`: recorded as used, no transaction, `transaction: ""` | success                                              | upto-scheme, upto-service                   |

On-chain, independently of these checks: only the settlement authority can settle (a different
submitter fails in the host's authorization check), the contract refuses an amount over the cap with
`#3`, and a second use of one authorization fails on the payer's nonce (contract, upto-tamper,
upto-replicas).

Test files of the `upto` rules:

| Short name      | File                                                                   |
| --------------- | ---------------------------------------------------------------------- |
| upto-preflight  | `packages/facilitator/test/upto-preflight.test.ts` (one case per code) |
| mechanism       | `packages/upto/test/facilitator.test.ts`                               |
| codec           | `packages/upto/test/codec.test.ts`                                     |
| upto-scheme     | `packages/facilitator/test/upto-scheme.test.ts`                        |
| upto-engine     | `packages/facilitator/test/upto-engine.test.ts`                        |
| front-run       | `packages/facilitator/test/front-run.integration.test.ts`              |
| upto-tamper     | `apps/rail402/test/upto-tamper.integration.test.ts`                    |
| upto-settlement | `apps/rail402/test/upto-settlement.integration.test.ts`                |
| upto-payers     | `apps/rail402/test/upto-payers.integration.test.ts`                    |
| upto-replicas   | `apps/rail402/test/upto-replicas.integration.test.ts`                  |
| upto-archival   | `apps/rail402/test/upto-archival.integration.test.ts`                  |
| upto-service    | `apps/rail402/test/upto.integration.test.ts`                           |
| contract        | `contracts/stellar/upto/src/test/` (Rust, `cargo test`)                |

## Expiration

A payment's authorization is valid on-chain up to and including its `signatureExpirationLedger`:
the network refuses it only once the current ledger is past that number. Two bounds decide which
expiration ledgers Rail402 accepts, one from upstream and one of its own.

**Where the expiration comes from.** The stock client (`@x402/stellar`'s `ExactStellarScheme`
client) signs with

```
signatureExpirationLedger = latest + ceil(maxTimeoutSeconds / est)
```

where `latest` is the RPC's latest ledger and `est` is the average close time of the 20 most recent
ledgers on public Horizon (`horizon-testnet.stellar.org` for `stellar:testnet`,
`horizon.stellar.org` for `stellar:pubnet`), rounded up. If Horizon cannot be read, `est` is 5
seconds. With 5-second ledgers, `maxTimeoutSeconds: 60` gives `latest + 12` and 300 gives
`latest + 60`. Accepted `maxTimeoutSeconds` values are `TIMEOUT_MIN_SECONDS`–`TIMEOUT_MAX_SECONDS`
(10–300 by default); anything else is `invalid_exact_stellar_requirements_timeout_out_of_range`.

**Upper bound (upstream).** The upstream verifier computes `maxLedger` with the same formula at
verify time and refuses `signatureExpirationLedger > maxLedger + 2` with
`invalid_exact_stellar_signature_expiration_too_far`. The two ledgers of tolerance absorb a ledger
closing between the client's reading and the facilitator's. Rail402 keeps this check as upstream
defines it and adds no upper bound of its own.

**Lower bound (Rail402).** With `current` the latest ledger Rail402 has read (stage 5):

| Expiration ledger                                       | Result                                                |
| ------------------------------------------------------- | ----------------------------------------------------- |
| `< current`                                             | `invalid_exact_stellar_signature_expired`             |
| `≥ current` and `< current + EXPIRATION_MARGIN_LEDGERS` | `invalid_exact_stellar_signature_expiration_too_soon` |
| `≥ current + EXPIRATION_MARGIN_LEDGERS`                 | passes this check                                     |

The margin (`EXPIRATION_MARGIN_LEDGERS`, 1 by default, 1 to 100) keeps the sponsor from paying for a
settlement that would land after the authorization expired: an authorization that expires at the
current ledger is still valid on the network, but a settlement submitted now lands in a later ledger.
A margin of 0 is refused at startup.

**After submission.** The settlement transaction's time bound is `maxTimeoutSeconds` from when it is
built, and it can outlive the authorization. If the authorization expires after the transaction is
submitted but before it is included, the transaction fails on-chain: the response is
`invalid_exact_stellar_signature_expired` with the transaction hash, the settlement is recorded as
failed, no funds move, and the fee the sponsor paid is counted in
`rail402_sponsor_fees_stroops_total{outcome="wasted"}`. A later repeat of a payment that did settle
returns the original success, however long after its expiration it arrives (stage 8).

| Behaviour                                                                                                 | Tested by   |
| --------------------------------------------------------------------------------------------------------- | ----------- |
| The expiration a payment carries is `latest + ceil(maxTimeoutSeconds / est)` (60 s → +12, 300 s → +60)    | expiration  |
| A payment verifies and settles before its expiration ledger, and lands no later than it                   | expiration  |
| A payment verified in the same window is refused by verify and settle after it, with nothing submitted    | expiration  |
| Lower edge at a fixed ledger `L`: `L − 1` expired, `L` too soon, `L + 1` valid                            | expiration  |
| Upper edge at `L` with 5-second ledgers: `L + 14` valid, `L + 15` too far; the same when Horizon fails    | expiration  |
| Upper edge at `L` with 6-second ledgers: `L + 12` valid, `L + 13` too far                                 | expiration  |
| An authorization expiring between submission and inclusion: failed on-chain, coded, fee counted as wasted | expiration  |
| A repeat after the expiration returns the original success                                                | expiration  |
| On the public testnet: a short-lived payment is refused once expired, and a fresh one settles             | live matrix |

**`upto`.** An `upto` authorization carries its expiration twice: in the signed terms
(`expiration_ledger`) and in the credential (`signatureExpirationLedger`); the two must be equal
(`invalid_upto_stellar_payload_expiration_mismatch`). The `upto` client derives it with the same
formula, from its own ledger-time estimate. Rail402 checks the window itself, with the `upto` codes:

| Expiration ledger `E`                                  | Result                                               |
| ------------------------------------------------------ | ---------------------------------------------------- |
| `< current`                                            | `invalid_upto_stellar_signature_expired`             |
| `< current + EXPIRATION_MARGIN_LEDGERS`                | `invalid_upto_stellar_signature_expiration_too_soon` |
| `> latest + ceil(maxTimeoutSeconds / min(est, 5)) + 2` | `invalid_upto_stellar_signature_expiration_too_far`  |
| otherwise                                              | passes this check                                    |

`est` is the network's seconds per ledger: `UPTO_LEDGER_SECONDS` when set, otherwise the average close
time over the ledgers the network's own RPC retains, read at most once a minute (5 s while the RPC
cannot tell). The in-process facilitator uses the same default for `upto.ledgerSeconds`; no other
service is asked. Capping `est` at the nominal 5 seconds means a client that assumed 5-second ledgers
on a slower network is never refused as too far.

One thing differs after submission: the settlement transaction's ledger bounds end at
`expiration_ledger + 1`, so a transaction held past the authorization's expiration is refused by the
network before inclusion (`txTooLate`) and the sponsor pays no fee. Rail402 finishes it as
`settle_upto_stellar_transaction_expired` once the ledger bound has passed and the payer's nonce,
read at a ledger no later than `expiration_ledger`, shows that nothing carried the authorization.

| Behaviour (`upto`)                                                                                                    | Tested by  |
| --------------------------------------------------------------------------------------------------------------------- | ---------- |
| `expiration_ledger` and `signatureExpirationLedger` are both `latest + ceil(maxTimeoutSeconds / est)`                 | expiration |
| A payment settles part of its cap before `expiration_ledger`; one verified in the same window is refused after it     | expiration |
| Lower edge at a fixed ledger `L`: `L − 1` expired, `L` too soon, `L + 1` valid                                        | expiration |
| Upper edge at `L` for 60 s: 5-second and 6-second estimates `L + 14` valid, `L + 15` too far; 4-second `L + 15` valid | expiration |
| Without `ledgerSeconds`, the estimate comes from the network's RPC (about 1 s locally: `L + 15` valid), not Horizon   | expiration |
| A settlement held past the expiration is refused by the network (`txTooLate`) and costs the sponsor nothing           | expiration |
| A repeat for the same amount after the expiration returns the original success                                        | expiration |

## Codes that are defined but not emitted

Kept so the code list matches the x402 specification and upstream, and so a response relayed
from another component is still recognised:

| Code                                              | Why Rail402 does not emit it                                                                                     |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `invalid_payment_requirements`                    | Stage 2 returns a specific `invalid_exact_stellar_requirements_*` code instead.                                  |
| `invalid_scheme`                                  | Rail402 returns upstream's `unsupported_scheme`.                                                                 |
| `verification_failed`                             | Used only if upstream ever rejects without naming a reason.                                                      |
| `settle_exact_stellar_signer_selection_failed`    | The engine leases the channel before calling upstream, so selection cannot fail.                                 |
| `settle_exact_stellar_transaction_signing_failed` | Channel keys sign in-process and do not report signing errors; a thrown error becomes `unexpected_settle_error`. |
| `settle_exact_stellar_transaction_failed`         | Once an envelope is recorded, the engine decides the outcome from the chain (stage 8).                           |
| `settle_upto_stellar_signer_selection_failed`     | As for `exact`: the engine leases the channel before the `upto` mechanism runs.                                  |
| `settle_upto_stellar_transaction_signing_failed`  | As for `exact`: the channel and authority keys sign in-process.                                                  |

`packages/stellar/test/codes.test.ts` fails if an `exact` or `upto` code is added without being listed in
this document.

## Bazaar cataloging

Cataloging runs after a successful settlement (and is previewed at `/verify`, which waits at most
250 ms for it) and never affects the payment. Its outcome is reported to the seller in the
`EXTENSION-RESPONSES` header, which never exceeds 4,096 bytes: reasons are cut to 300 characters and
an outcome too large for the budget is reduced to its status and code. Codes are in
`packages/bazaar/src/codes.ts`.

| Check                                                                                                                                        | Code                               | Tested by           |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------- |
| The payment is x402 version 2                                                                                                                | `bazaar_unsupported_version`       | catalog             |
| The extension has `info` and `schema` objects                                                                                                | `bazaar_extension_malformed`       | catalog             |
| `schema` compiles as JSON Schema 2020-12                                                                                                     | `bazaar_schema_invalid`            | security            |
| `schema` has no external `$ref` or `$id`                                                                                                     | `bazaar_schema_external_reference` | catalog             |
| `schema` and `info` are within size and depth budgets                                                                                        | `bazaar_schema_too_large`          | security            |
| Validation finishes within its time budget (isolated worker, 250 ms)                                                                         | `bazaar_schema_timeout`            | security            |
| At most 16 validations wait for the worker; more are refused at once                                                                         | `bazaar_schema_timeout`            | security            |
| `info` satisfies `schema`                                                                                                                    | `bazaar_info_invalid`              | catalog, security   |
| `info.input` is a valid HTTP or MCP description                                                                                              | `bazaar_info_unsupported`          | catalog             |
| The resource URL is an absolute http(s) URL without credentials                                                                              | `bazaar_resource_invalid`          | catalog, security   |
| The resource host is public (no private, loopback or link-local addresses)                                                                   | `bazaar_resource_unsafe`           | catalog, security   |
| The payer is not paying itself (defence in depth: stage 4 already refuses a self-payment)                                                    | `bazaar_self_payment`              | catalog             |
| Only the listing's owner, the settled `payTo`, can change it                                                                                 | `bazaar_owner_conflict`            | catalog, bazaar     |
| An MCP tool is scoped to its owner, so no seller can claim another seller's tool                                                             | (separate listing)                 | catalog             |
| One settlement catalogs at most one resource (a replayed settlement is refused)                                                              | `bazaar_settlement_reused`         | catalog             |
| The payment settled in a transaction (an off-chain zero `upto` settlement has none to bind a listing to)                                     | `bazaar_settlement_offchain`       | catalog             |
| The payment moved value: an `upto` settlement of zero, on chain or off, needs no balance or trustline and proves nothing about `payTo`       | `bazaar_settlement_zero`           | catalog             |
| An `upto` listing is priced at the cap the buyer signed (`accepted.amount`), never the amount settled                                        | (listed price)                     | catalog             |
| The owner, the payer and the whole catalog are within their hourly limits of new listings                                                    | `bazaar_rate_limited`              | catalog             |
| The catalog store is reachable                                                                                                               | `bazaar_catalog_unavailable`       | catalog             |
| Invalid optional metadata (service name, tags, icon) is dropped, not fatal                                                                   | (listed in `dropped`)              | catalog             |
| A `routeTemplate` is used only if, percent-decoded, it is safe (no `..`, `://`, NUL, CR, LF, backslash or `//`) and matches the paid path    | (template ignored)                 | catalog, security   |
| Equivalent spellings of one URL (percent-encoding, dot segments, case) are one listing                                                       | (same listing)                     | catalog, security   |
| A new HTTP listing, and any change to one, is published only once the resource's own 402 confirms it                                         | `awaiting_origin_verification`     | catalog, bazaar     |
| An MCP tool at an http(s) endpoint is published, or changed, only once its unpaid `tools/call` answers with a 402 naming the owner           | `awaiting_origin_verification`     | catalog, mcp-origin |
| An MCP tool its origin never confirmed is published only if the tool offers the settled scheme, network, asset, `payTo` and price (cap)      | (listing quarantined)              | catalog             |
| An MCP tool under an `mcp://` URL has no origin: it is listed on settlement at trust `settled` and keeps its first-seen content              | `cataloged`                        | catalog             |
| Only well-formed Stellar options of that 402 are published (C… asset, G/C/M `payTo`, integer amount)                                         | (option ignored)                   | catalog             |
| A resource that answers anything but a usable 402, or stays unreachable through every retry, is withdrawn, with a coded reason               | (listing quarantined)              | catalog             |
| Only listings the owner's origin confirmed count toward the owner's hourly quota                                                             | `bazaar_rate_limited`              | catalog             |
| `domain_verified` needs origin-verified content and the two-way SEP-1 binding (`ACCOUNTS` lists the owner, its `home_domain` names the host) | (trust)                            | catalog             |

Discovery requests: a malformed or unknown query parameter returns `discovery_invalid_parameter`
and an unknown listing `discovery_listing_not_found` (bazaar).

## Response shapes

Verification and settlement outcomes are HTTP 200 with the x402 response body:

```json
{
  "isValid": false,
  "invalidReason": "invalid_exact_stellar_payload_wrong_amount",
  "invalidMessage": "…",
  "payer": "G…"
}
```

```json
{
  "success": false,
  "errorReason": "settle_exact_stellar_transaction_expired",
  "errorMessage": "…",
  "transaction": "",
  "network": "stellar:testnet"
}
```

Transport-level rejections of `/verify` and `/settle` (stage 0) keep that shape, so the stock client
raises a typed `VerifyError` or `SettleError`, and add an `error` object. Every other endpoint returns
only the `error` object:

```json
{
  "isValid": false,
  "invalidReason": "invalid_payload",
  "invalidMessage": "Malformed request: x402Version: Invalid input: expected number, received undefined.",
  "error": {
    "code": "bad_request",
    "reason": "Malformed request: x402Version: Invalid input: expected number, received undefined.",
    "retryable": false
  }
}
```

## Transport codes

Defined in `packages/errors/src/index.ts`, shared by every endpoint.

| Code                     | HTTP | When                                                                                                                 |
| ------------------------ | ---- | -------------------------------------------------------------------------------------------------------------------- |
| `bad_request`            | 400  | The body is not JSON or lacks `x402Version`, `paymentPayload` or `paymentRequirements` (wire code `invalid_payload`) |
| `unauthorized`           | 401  | An API key is required and missing or unknown (`/verify`, `/settle` where required; `/usage` always)                 |
| `not_found`              | 404  | No route matches the path                                                                                            |
| `payload_too_large`      | 413  | The body exceeds `BODY_LIMIT_BYTES`                                                                                  |
| `unsupported_media_type` | 415  | `/verify` or `/settle` without `Content-Type: application/json`                                                      |
| `rate_limited`           | 429  | The client exceeded `RATE_LIMIT_PER_MINUTE`; `Retry-After` says when to retry                                        |
| `internal_error`         | 500  | An unexpected error outside the payment logic                                                                        |

`forbidden` (403), `method_not_allowed` (405) and `service_unavailable` (503) are defined but not
currently returned.

## Search codes

Defined in `packages/search/src/service.ts`, returned by `GET /discovery/search` with HTTP 400.

| Code                    | When                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| `search_query_required` | `query` is blank                                                                                               |
| `search_query_too_long` | `query` is longer than 500 characters after trimming, up to 2,000 (beyond that: `discovery_invalid_parameter`) |
| `search_invalid_cursor` | The cursor is malformed, altered, signed with another key or belongs to another search                         |
| `search_cursor_expired` | The cursor expired or its index snapshot is gone; repeat the search without a cursor                           |
