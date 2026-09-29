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
(`packages/facilitator/src/latest-ledger.ts`, tested in `latest-ledger.test.ts`). The unmodified
`@x402/stellar` verifier (stage 6) then runs every check of the `exact` Stellar scheme, including
simulation. Rail402 only adds a diagnosis of why a simulation failed (stage 7) and makes settlement
idempotent and crash-safe (stage 8).

Test files, relative to the repository root:

| Short name   | File                                                                                                                 |
| ------------ | -------------------------------------------------------------------------------------------------------------------- |
| app          | `apps/rail402/test/app.test.ts`                                                                                      |
| service      | `apps/rail402/test/service.integration.test.ts`                                                                      |
| bazaar       | `apps/rail402/test/bazaar.integration.test.ts`                                                                       |
| payload      | `packages/stellar/test/payload.test.ts`                                                                              |
| diagnostics  | `packages/stellar/test/diagnostics.test.ts`                                                                          |
| preflight    | `packages/facilitator/test/preflight.test.ts`                                                                        |
| explain      | `packages/facilitator/test/explain.test.ts`                                                                          |
| settlement   | `packages/facilitator/test/settlement.integration.test.ts`                                                           |
| catalog      | `packages/bazaar/src/testing.ts` (run by `packages/bazaar/test/memory-catalog.test.ts` and the Postgres store tests) |
| security     | `packages/bazaar/test/security.test.ts`                                                                              |
| upstream e2e | `tools/conformance/src/upstream-e2e.ts`, the x402 e2e suite run against Rail402                                      |
| live matrix  | `tools/conformance/src/live-matrix.ts`, run over HTTP against a deployed Rail402 on the public testnet               |

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
| The scheme is `exact`                                                               | `unsupported_scheme`                          | app       |
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

| Check                                                                   | Code                                                      | Tested by |
| ----------------------------------------------------------------------- | --------------------------------------------------------- | --------- |
| The asset is one this network accepts                                   | `invalid_exact_stellar_requirements_asset_not_accepted`   | preflight |
| `payTo` is a G…, C… or M… address                                       | `invalid_exact_stellar_requirements_invalid_pay_to`       | preflight |
| `amount` is a positive integer string in base units                     | `invalid_exact_stellar_requirements_invalid_amount`       | preflight |
| `amount` is within the asset's configured minimum and maximum           | `invalid_exact_stellar_requirements_amount_out_of_range`  | preflight |
| `maxTimeoutSeconds` is an integer within the configured range           | `invalid_exact_stellar_requirements_timeout_out_of_range` | preflight |
| `extra.areFeesSponsored` is `true`                                      | `invalid_exact_stellar_requirements_fees_not_sponsored`   | preflight |
| The payload's accepted asset, `payTo` and amount equal the requirements | `invalid_exact_stellar_payload_accepted_mismatch`         | preflight |

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

| Check                                                                            | Code                                                      | Tested by              |
| -------------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------- |
| Neither the transaction nor the operation source is a facilitator account        | `invalid_exact_stellar_payload_unsafe_tx_or_op_source`    | preflight              |
| The payer (`from`) is not a facilitator account                                  | `invalid_exact_stellar_payload_facilitator_is_payer`      | preflight              |
| The invoked contract is the required asset                                       | `invalid_exact_stellar_payload_wrong_asset`               | preflight              |
| `to` is the required `payTo`                                                     | `invalid_exact_stellar_payload_wrong_recipient`           | preflight              |
| The payer is not paying its own account (`to` differs from `from`, muxed or not) | `invalid_exact_stellar_payload_self_payment`              | preflight, live matrix |
| `amount` is exactly the required amount (SEP-41 base units, no rounding)         | `invalid_exact_stellar_payload_wrong_amount`              | preflight, service     |
| No ledger bounds, sequence conditions or extra signers                           | `invalid_exact_stellar_payload_unsupported_preconditions` | preflight              |

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
| Simulation asks for a restore of archived state             | `invalid_exact_stellar_payload_archived_state`              | explain                 |
| A settlement included in a ledger failed for another reason | `invalid_transaction_state`                                 | explain                 |

Anything unrecognised keeps upstream's `invalid_exact_stellar_payload_simulation_failed`.

## 8. Settlement

`StellarExactScheme.settle()` in `packages/facilitator/src/scheme.ts` runs stages 1–5 again. Then
`SettlementEngine.settle()` in `packages/facilitator/src/engine.ts` admits the settlement through the
sponsor guard, claims the authorization and leases a channel account. Upstream's
`ExactStellarScheme.settle` runs stage 6 again, and a rejection there is diagnosed as in stage 7;
otherwise it settles the payment with the leased channel account as the transaction source and the
sponsor paying the fee through a fee bump. The facilitator is never
the source of the transferred funds (settlement, "payer debited, payTo credited, facilitator only
pays the fee").

| Step and check                                                                                                                                                | Code                                                 | Tested by                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------- |
| The sponsor guard admits the settlement: balance above `SPONSOR_RESERVE_XLM`, hourly fee budget not spent                                                     | `settle_exact_stellar_sponsor_unavailable`           | settlement, `fees.test.ts`        |
| The authorization (network, payer, nonce) was not already settled in a different envelope                                                                     | `settle_exact_stellar_idempotency_conflict`          | settlement                        |
| A duplicate of a settlement in progress waits for it; if it outlasts the wait before signing                                                                  | `settle_exact_stellar_settlement_in_progress`        | settlement                        |
| A repeated settle returns the original result and moves funds once                                                                                            | (the original response)                              | settlement                        |
| A channel account is free within the wait                                                                                                                     | `settle_exact_stellar_channel_unavailable`           | settlement                        |
| The signed envelope is recorded before broadcast; if it cannot be, nothing is broadcast                                                                       | `settle_exact_stellar_fee_bump_signing_failed`       | settlement                        |
| The transaction lands in a ledger and succeeds                                                                                                                | success                                              | settlement, service, upstream e2e |
| It lands and fails                                                                                                                                            | stage 7 code, or `invalid_transaction_state`         | explain                           |
| A ledger closes after its time bound without it: it can never land, no funds moved                                                                            | `settle_exact_stellar_transaction_expired`           | settlement                        |
| The network refuses bytes that can never apply (bad signature, missing account); a fee or balance shortfall keeps rebroadcasting until the time bound decides | `settle_exact_stellar_transaction_submission_failed` | settlement                        |
| Not final within `confirmTimeoutMs` of recording the envelope, however long upstream would poll; the reconciler finishes it later                             | `settlement_pending` (with the transaction hash)     | settlement                        |
| An unexpected internal error                                                                                                                                  | `unexpected_verify_error`, `unexpected_settle_error` | app (`unexpected_verify_error`)   |

Only the recorded bytes are ever resubmitted, so a lost response or a restart can never produce a
second transaction for the same authorization (settlement, "recovers after a lost submission
response").

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

`packages/stellar/test/codes.test.ts` fails if a code is added without being listed here.

## Bazaar cataloging

Cataloging runs after a successful settlement (and is previewed at `/verify`, which waits at most
250 ms for it) and never affects the payment. Its outcome is reported to the seller in the
`EXTENSION-RESPONSES` header, which never exceeds 4,096 bytes: reasons are cut to 300 characters and
an outcome too large for the budget is reduced to its status and code. Codes are in
`packages/bazaar/src/codes.ts`.

| Check                                                                                                                                     | Code                               | Tested by         |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ----------------- |
| The payment is x402 version 2                                                                                                             | `bazaar_unsupported_version`       | catalog           |
| The extension has `info` and `schema` objects                                                                                             | `bazaar_extension_malformed`       | catalog           |
| `schema` compiles as JSON Schema 2020-12                                                                                                  | `bazaar_schema_invalid`            | security          |
| `schema` has no external `$ref` or `$id`                                                                                                  | `bazaar_schema_external_reference` | catalog           |
| `schema` and `info` are within size and depth budgets                                                                                     | `bazaar_schema_too_large`          | security          |
| Validation finishes within its time budget (isolated worker, 250 ms)                                                                      | `bazaar_schema_timeout`            | security          |
| At most 16 validations wait for the worker; more are refused at once                                                                      | `bazaar_schema_timeout`            | security          |
| `info` satisfies `schema`                                                                                                                 | `bazaar_info_invalid`              | catalog, security |
| `info.input` is a valid HTTP or MCP description                                                                                           | `bazaar_info_unsupported`          | catalog           |
| The resource URL is an absolute http(s) URL without credentials                                                                           | `bazaar_resource_invalid`          | catalog, security |
| The resource host is public (no private, loopback or link-local addresses)                                                                | `bazaar_resource_unsafe`           | catalog, security |
| The payer is not paying itself (defence in depth: stage 4 already refuses a self-payment)                                                 | `bazaar_self_payment`              | catalog           |
| Only the listing's owner, the settled `payTo`, can change it                                                                              | `bazaar_owner_conflict`            | catalog, bazaar   |
| An MCP tool is scoped to its owner, so no seller can claim another seller's tool                                                          | (separate listing)                 | catalog           |
| One settlement catalogs at most one resource (a replayed settlement is refused)                                                           | `bazaar_settlement_reused`         | catalog           |
| The owner, the payer and the whole catalog are within their hourly limits of new listings                                                 | `bazaar_rate_limited`              | catalog           |
| The catalog store is reachable                                                                                                            | `bazaar_catalog_unavailable`       | catalog           |
| Invalid optional metadata (service name, tags, icon) is dropped, not fatal                                                                | (listed in `dropped`)              | catalog           |
| A `routeTemplate` is used only if, percent-decoded, it is safe (no `..`, `://`, NUL, CR, LF, backslash or `//`) and matches the paid path | (template ignored)                 | catalog, security |
| Equivalent spellings of one URL (percent-encoding, dot segments, case) are one listing                                                    | (same listing)                     | catalog, security |
| A new HTTP listing, and any change to one, is published only once the resource's own 402 confirms it                                      | `awaiting_origin_verification`     | catalog, bazaar   |
| Only well-formed Stellar options of that 402 are published (C… asset, G/C/M `payTo`, integer amount)                                      | (option ignored)                   | catalog           |
| A resource that answers anything but a usable 402, or stays unreachable through every retry, is withdrawn                                 | (listing quarantined)              | catalog           |
| Trust is `domain_verified` only while the resource host's SEP-1 `stellar.toml` lists the owner in `ACCOUNTS`                              | (trust)                            | catalog           |

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
