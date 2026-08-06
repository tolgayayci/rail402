/**
 * The single shared error registry (the registry rule: "Adding an error = adding it to the registry +
 * docs, never an inline string").
 *
 * ## Provenance discipline
 *
 * Codes tagged `spec` or `library` are a WIRE CONTRACT WE DO NOT OWN. Their string values are
 * reproduced verbatim from:
 *   - specs/x402-specification-v2.md §9                    @ 90688e5
 *   - specs/schemes/exact/scheme_exact_stellar.md          @ c4d2de6
 *   - @x402/stellar v2.20.0 src/exact/facilitator/scheme.ts
 * Renaming one silently breaks stock clients and the upstream e2e suite. Do not "improve" them.
 *
 * Codes tagged `local` cover failure modes the library collapses into a single generic code — most
 * importantly `invalid_exact_stellar_payload_simulation_failed`, which today means any of
 * "no trustline", "insufficient balance", "replayed", or "archived state". An agent cannot act on
 * that. Each local code follows the existing naming convention so it can be proposed upstream
 * as-is; `refines` records what it splits out of.
 *
 */

import type { ErrorDefinition } from "./types.js";

export const ERROR_REGISTRY = {
  // ───────────────────────────────────────────────────────────────────────────
  // Protocol-level — x402 v2 specification §9
  // ───────────────────────────────────────────────────────────────────────────
  invalid_x402_version: {
    reason: "Unsupported x402 protocol version. This facilitator implements version 2 only.",
    retryable: false,
    surface: "protocol",
    provenance: "spec",
  },
  invalid_scheme: {
    reason: "The requested payment scheme is not valid for this payment.",
    retryable: false,
    surface: "protocol",
    provenance: "spec",
  },
  unsupported_scheme: {
    reason: "This facilitator does not support the requested payment scheme on this network.",
    retryable: false,
    surface: "protocol",
    provenance: "spec",
  },
  invalid_network: {
    reason: "The requested network is not a Stellar network supported by this facilitator.",
    retryable: false,
    surface: "protocol",
    provenance: "spec",
  },
  network_mismatch: {
    reason: "The network in the payment payload does not match the network in the payment requirements.",
    retryable: false,
    surface: "protocol",
    provenance: "library",
  },
  invalid_payload: {
    reason: "The payment payload is malformed or contains invalid data.",
    retryable: false,
    surface: "protocol",
    provenance: "spec",
  },
  invalid_payment_requirements: {
    reason: "The payment requirements object is invalid or malformed.",
    retryable: false,
    surface: "protocol",
    provenance: "spec",
  },
  insufficient_funds: {
    reason: "The payer does not hold enough of the payment asset to complete this payment.",
    retryable: false,
    surface: "protocol",
    provenance: "spec",
    remediation: "Fund the payer account with the payment asset and retry with a fresh authorization.",
  },
  invalid_transaction_state: {
    reason: "The blockchain transaction failed or was rejected by the network.",
    retryable: true,
    surface: "settlement",
    provenance: "spec",
  },
  unexpected_verify_error: {
    reason: "An unexpected error occurred while verifying the payment.",
    retryable: true,
    surface: "facilitator",
    provenance: "spec",
  },
  unexpected_settle_error: {
    reason: "An unexpected error occurred while settling the payment.",
    retryable: true,
    surface: "settlement",
    provenance: "spec",
  },

  // ───────────────────────────────────────────────────────────────────────────
  // `exact` on Stellar — structural validation (@x402/stellar, verbatim)
  // ───────────────────────────────────────────────────────────────────────────
  invalid_exact_stellar_payload_malformed: {
    reason: "The payload transaction is missing or is not a base64-encoded Stellar transaction.",
    retryable: false,
    surface: "facilitator",
    provenance: "library",
  },
  invalid_exact_stellar_payload_wrong_operation: {
    reason:
      "The transaction must contain exactly one invokeHostFunction operation invoking a contract.",
    retryable: false,
    surface: "facilitator",
    provenance: "library",
  },
  invalid_exact_stellar_payload_wrong_asset: {
    reason: "The contract invoked by the transaction is not the asset named in the payment requirements.",
    retryable: false,
    surface: "facilitator",
    provenance: "library",
  },
  invalid_exact_stellar_payload_wrong_function_name: {
    reason: "The transaction must call transfer(from, to, amount) with exactly three arguments.",
    retryable: false,
    surface: "facilitator",
    provenance: "library",
  },
  invalid_exact_stellar_payload_wrong_recipient: {
    reason: "The transfer recipient does not match the payTo address in the payment requirements.",
    retryable: false,
    surface: "facilitator",
    provenance: "library",
  },
  invalid_exact_stellar_payload_wrong_amount: {
    reason: "The transfer amount does not exactly match the amount in the payment requirements.",
    retryable: false,
    surface: "facilitator",
    provenance: "library",
  },
  invalid_exact_stellar_payload_simulation_failed: {
    reason: "Simulating the payment transaction against current ledger state failed.",
    retryable: false,
    surface: "facilitator",
    provenance: "library",
    remediation:
      "This is the library's catch-all. Prefer one of the refined codes below when the cause is known.",
  },
  invalid_exact_stellar_payload_fee_exceeds_maximum: {
    reason:
      "The simulation-derived settlement fee exceeds this facilitator's configured maximum transaction fee.",
    retryable: false,
    surface: "facilitator",
    provenance: "spec",
    remediation:
      "Operator: raise MAX_TRANSACTION_FEE_STROOPS. The 50,000 stroop default is known to be too low for some Soroban resource fees.",
  },

  // ── Facilitator-safety invariants (scheme_exact_stellar.md §4) ──
  invalid_exact_stellar_payload_unsafe_tx_or_op_source: {
    reason: "The transaction or operation source account is a facilitator address, which is not permitted.",
    retryable: false,
    surface: "facilitator",
    provenance: "library",
  },
  invalid_exact_stellar_payload_facilitator_is_payer: {
    reason: "The transfer sender is a facilitator address. The facilitator is never the source of funds.",
    retryable: false,
    surface: "facilitator",
    provenance: "library",
  },
  invalid_exact_stellar_payload_facilitator_in_auth: {
    reason: "A facilitator address appears in an authorization entry, which is not permitted.",
    retryable: false,
    surface: "facilitator",
    provenance: "library",
  },
  invalid_exact_stellar_payload_has_subinvocations: {
    reason:
      "An authorization entry contains sub-invocations, which could authorize actions beyond the transfer.",
    retryable: false,
    surface: "facilitator",
    provenance: "library",
  },

  // ── Simulation event checks (proves exactly one expected balance change) ──
  invalid_exact_stellar_payload_no_transfer_events: {
    reason: "The simulation emitted no token transfer event.",
    retryable: false,
    surface: "facilitator",
    provenance: "library",
  },
  invalid_exact_stellar_payload_multiple_transfers: {
    reason: "The simulation emitted more than one transfer event. Only the declared transfer is permitted.",
    retryable: false,
    surface: "facilitator",
    provenance: "library",
  },
  invalid_exact_stellar_payload_event_not_transfer: {
    reason: "The simulation emitted a contract event that is not a token transfer.",
    retryable: false,
    surface: "facilitator",
    provenance: "library",
  },
  invalid_exact_stellar_payload_event_missing_contract_id: {
    reason: "A simulated contract event is missing its contract id and cannot be attributed to the asset.",
    retryable: false,
    surface: "facilitator",
    provenance: "library",
  },
  invalid_exact_stellar_payload_event_wrong_asset: {
    reason: "The simulated transfer event was emitted by a contract other than the declared asset.",
    retryable: false,
    surface: "facilitator",
    provenance: "library",
  },
  invalid_exact_stellar_payload_event_wrong_from: {
    reason: "The simulated transfer event sender does not match the payer in the payload.",
    retryable: false,
    surface: "facilitator",
    provenance: "library",
  },
  invalid_exact_stellar_payload_event_wrong_to: {
    reason: "The simulated transfer event recipient does not match the payTo address.",
    retryable: false,
    surface: "facilitator",
    provenance: "library",
  },
  invalid_exact_stellar_payload_event_wrong_amount: {
    reason: "The simulated transfer event amount does not match the required amount.",
    retryable: false,
    surface: "facilitator",
    provenance: "library",
  },

  // ── Authorization entries ──
  invalid_exact_stellar_payload_no_auth_entries: {
    reason: "The transaction contains no Soroban authorization entries.",
    retryable: false,
    surface: "facilitator",
    provenance: "library",
  },
  invalid_exact_stellar_payload_unsupported_credential_type: {
    reason:
      "An authorization entry uses an unsupported credential type. Only address-based credentials are accepted.",
    retryable: false,
    surface: "facilitator",
    provenance: "library",
  },
  invalid_exact_stellar_payload_missing_payer_signature: {
    reason: "The payer has not signed their authorization entry.",
    retryable: false,
    surface: "facilitator",
    provenance: "library",
  },
  invalid_exact_stellar_payload_unexpected_pending_signatures: {
    reason: "One or more authorization entries are still awaiting a signature.",
    retryable: false,
    surface: "facilitator",
    provenance: "library",
  },
  invalid_exact_stellar_signature_expiration_too_far: {
    reason:
      "The authorization entry expiration ledger is further in the future than maxTimeoutSeconds allows.",
    retryable: false,
    surface: "facilitator",
    provenance: "library",
    remediation:
      "Sign with signatureExpirationLedger = currentLedger + ceil(maxTimeoutSeconds / estimatedLedgerSeconds).",
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Settlement (@x402/stellar, verbatim)
  // ───────────────────────────────────────────────────────────────────────────
  settle_exact_stellar_signer_selection_failed: {
    reason: "The facilitator could not select a signing account to submit the settlement.",
    retryable: true,
    surface: "settlement",
    provenance: "library",
  },
  settle_exact_stellar_transaction_signing_failed: {
    reason: "The facilitator failed to sign the settlement transaction.",
    retryable: true,
    surface: "settlement",
    provenance: "library",
  },
  settle_exact_stellar_fee_bump_signing_failed: {
    reason: "The facilitator failed to sign the fee-bump wrapper for the settlement transaction.",
    retryable: true,
    surface: "settlement",
    provenance: "library",
  },
  settle_exact_stellar_transaction_submission_failed: {
    reason: "The Stellar network did not accept the settlement transaction for inclusion.",
    retryable: true,
    surface: "settlement",
    provenance: "library",
  },
  settle_exact_stellar_transaction_failed: {
    reason: "The settlement transaction was submitted but did not succeed on-ledger.",
    retryable: false,
    surface: "settlement",
    provenance: "library",
  },

  // ───────────────────────────────────────────────────────────────────────────
  // LOCAL refinements — split the library's catch-alls into actionable causes.
  // Each is a candidate upstream contribution.
  // ───────────────────────────────────────────────────────────────────────────
  invalid_exact_stellar_payload_missing_trustline_payer: {
    reason: "The payer has no trustline to the payment asset and cannot hold or send it.",
    retryable: false,
    surface: "facilitator",
    provenance: "local",
    refines: "invalid_exact_stellar_payload_simulation_failed",
    remediation: "Establish a trustline from the payer account to the asset, then retry.",
  },
  invalid_exact_stellar_payload_missing_trustline_recipient: {
    reason: "The payTo account has no trustline to the payment asset and cannot receive it.",
    retryable: false,
    surface: "facilitator",
    provenance: "local",
    refines: "invalid_exact_stellar_payload_simulation_failed",
    remediation:
      "Seller: establish a trustline from the payTo account to the asset. This is a seller misconfiguration, not a buyer error.",
  },
  invalid_exact_stellar_payload_insufficient_balance: {
    reason: "The payer's balance of the payment asset is lower than the required amount.",
    retryable: false,
    surface: "facilitator",
    provenance: "local",
    refines: "invalid_exact_stellar_payload_simulation_failed",
  },
  invalid_exact_stellar_payload_authorization_replayed: {
    reason:
      "This authorization has already been used. Soroban consumed its nonce, so it cannot be settled again.",
    retryable: false,
    surface: "facilitator",
    provenance: "local",
    refines: "invalid_exact_stellar_payload_simulation_failed",
    remediation: "Sign a fresh authorization entry with a new nonce.",
  },
  invalid_exact_stellar_ledger_entry_restore_required: {
    reason:
      "Ledger state required by this payment has been archived and must be restored before the payment can proceed.",
    retryable: true,
    surface: "facilitator",
    provenance: "local",
    refines: "invalid_exact_stellar_payload_simulation_failed",
  },
  settle_exact_stellar_authorization_expired: {
    reason:
      "The authorization entry expired between verification and settlement and is no longer valid.",
    retryable: false,
    surface: "settlement",
    provenance: "local",
    refines: "unexpected_settle_error",
    remediation:
      "Sign a fresh authorization. Consider a larger maxTimeoutSeconds if this recurs under load.",
  },

  // ───────────────────────────────────────────────────────────────────────────
  // `upto` on Stellar
  //
  // Naming follows the existing `invalid_exact_stellar_*` convention so each is directly
  // proposable upstream alongside `specs/scheme_upto_stellar.md`. The generic spec defines only
  // `invalid_upto_evm_payload_settlement_exceeds_amount`; the Stellar profile needs its own family.
  // ───────────────────────────────────────────────────────────────────────────
  invalid_upto_stellar_payload_malformed: {
    reason: "The upto payload is malformed, or does not invoke settle() with the expected arguments.",
    retryable: false,
    surface: "facilitator",
    provenance: "local",
  },
  invalid_upto_stellar_payload_wrong_contract: {
    reason:
      "The transaction invokes a contract other than the canonical upto settlement contract for this network.",
    retryable: false,
    surface: "facilitator",
    provenance: "local",
    remediation:
      "Clients must verify extra.uptoContract against the canonical deployment. A server naming its own contract would be naming its own settlement rules.",
  },
  invalid_upto_stellar_payload_wrong_max_amount: {
    reason:
      "The client-signed ceiling does not match the amount being authorized at verification time.",
    retryable: false,
    surface: "facilitator",
    provenance: "local",
  },
  invalid_upto_stellar_payload_settlement_exceeds_amount: {
    reason: "The settlement amount exceeds the ceiling the client authorized.",
    retryable: false,
    surface: "settlement",
    provenance: "local",
    remediation:
      "The contract enforces this on-ledger too, so a compromised facilitator still cannot overcharge.",
  },
  invalid_upto_stellar_payload_authorization_used: {
    reason: "This upto authorization has already been settled. Each one is single-use.",
    retryable: false,
    surface: "facilitator",
    provenance: "local",
    remediation: "Sign a fresh authorization with a new nonce.",
  },
  invalid_upto_stellar_payload_expired: {
    reason: "The upto authorization is past its expiration ledger and can no longer be settled.",
    retryable: false,
    surface: "facilitator",
    provenance: "local",
  },
  invalid_upto_stellar_payload_simulation_failed: {
    reason: "Simulating the upto settlement against current ledger state failed.",
    retryable: false,
    surface: "facilitator",
    provenance: "local",
  },
  invalid_upto_stellar_payload_fee_exceeds_maximum: {
    reason:
      "The simulation-derived upto settlement fee exceeds this facilitator's configured maximum transaction fee.",
    retryable: false,
    surface: "facilitator",
    provenance: "local",
    remediation:
      "Operator: raise MAX_TRANSACTION_FEE_STROOPS. A smart-account upto settlement cross-calls a verifier and a spending policy, so it costs several times a keypair payment.",
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Bazaar discovery — cataloging and integrity
  // ───────────────────────────────────────────────────────────────────────────
  bazaar_info_schema_validation_failed: {
    reason: "The bazaar extension's info object failed validation against its own declared schema.",
    retryable: false,
    surface: "bazaar",
    provenance: "local",
  },
  bazaar_missing_resource_url: {
    reason: "The payment payload carries a bazaar extension but no resource.url to catalog it under.",
    retryable: false,
    surface: "bazaar",
    provenance: "local",
  },
  bazaar_invalid_resource_url: {
    reason: "The resource.url is not a parseable absolute URL and cannot be used as a catalog key.",
    retryable: false,
    surface: "bazaar",
    provenance: "local",
  },
  bazaar_invalid_route_template: {
    reason:
      "The routeTemplate failed validation and was discarded; the concrete URL path was used instead.",
    retryable: false,
    surface: "bazaar",
    provenance: "local",
  },
  bazaar_unsupported_input_type: {
    reason: "The discovery info input.type must be either \"http\" or \"mcp\".",
    retryable: false,
    surface: "bazaar",
    provenance: "local",
  },
  bazaar_federation_source_refused: {
    reason:
      "A configured federation source was refused: it does not declare a licence, the attribution that licence requires, an explicit acknowledgement that a human has read its terms, or an https URL.",
    retryable: false,
    surface: "bazaar",
    provenance: "local",
    remediation:
      "Mirroring a catalog republishes somebody else's data. Fail closed: a reachable endpoint is not permission, and `termsAcknowledged` is deliberately not inferrable from anything code can observe.",
  },
  bazaar_federation_source_unavailable: {
    reason:
      "A federation source could not be refreshed. The previous mirror is still being served, so results are stale rather than missing.",
    retryable: true,
    surface: "bazaar",
    provenance: "local",
    remediation:
      "Degrading freshness beats deleting listings an agent found minutes ago. Alert if it persists across several refresh intervals.",
  },
  bazaar_mcp_resource_url_not_addressable: {
    reason:
      "The resource.url names an MCP tool with a scheme that has no origin, so it cannot be a catalog key and an agent could not connect to it.",
    retryable: false,
    surface: "bazaar",
    provenance: "local",
    remediation:
      "Set resource.url to the http(s) URL of the MCP ENDPOINT — the address an agent connects to — and let input.toolName carry the tool. `mcp://tool/<name>` (the @x402/mcp default) has no origin under WHATWG URL parsing, so the spec's origin+path key collapses to a literal \"null\" origin that every seller would share.",
  },
  bazaar_mcp_missing_tool_name: {
    reason:
      "An MCP discovery entry must carry input.toolName; MCP resources are keyed on (resource.url, toolName).",
    retryable: false,
    surface: "bazaar",
    provenance: "local",
  },
  bazaar_network_not_caip2: {
    reason: "The payment network is not a valid CAIP-2 identifier and will not be cataloged.",
    retryable: false,
    surface: "bazaar",
    provenance: "local",
  },
  bazaar_listing_ownership_conflict: {
    reason:
      "This resource is already cataloged under a different payTo address and cannot be overwritten.",
    retryable: false,
    surface: "bazaar",
    provenance: "local",
    remediation:
      "Anti-spoofing: a listing belongs to the payTo that settled it. Nobody may overwrite another seller's entry or pricing.",
  },
  bazaar_not_settled: {
    reason: "Cataloging occurs only after a payment settles successfully; this payment has not settled.",
    retryable: true,
    surface: "bazaar",
    provenance: "local",
  },
  bazaar_stellar_fees_not_sponsored: {
    reason:
      "A Stellar exact listing must declare extra.areFeesSponsored === true; the stock @x402/stellar client cannot pay a listing whose extra is missing, null, or not truthfully sponsored, so it is not cataloged.",
    retryable: false,
    surface: "bazaar",
    provenance: "local",
    remediation:
      "The facilitator sponsors Stellar fees by default — advertise areFeesSponsored: true in the payment requirements' extra, then settle again.",
  },

  // ───────────────────────────────────────────────────────────────────────────
  // MCP discovery server
  // ───────────────────────────────────────────────────────────────────────────
  mcp_budget_required: {
    reason: "A maximum spend must be supplied before this tool will make a paid call.",
    retryable: false,
    surface: "mcp",
    provenance: "local",
    remediation: "Supply maxAmount. The proxy never pays an unbounded amount.",
  },
  mcp_budget_exceeded: {
    reason: "The resource's price exceeds the maximum spend supplied for this call. No payment was made.",
    retryable: false,
    surface: "mcp",
    provenance: "local",
  },
  mcp_resource_not_found: {
    reason: "No cataloged Stellar resource matches the requested URL or tool name.",
    retryable: false,
    surface: "mcp",
    provenance: "local",
  },
  mcp_resource_not_payable: {
    reason: "The resource did not return usable x402 payment requirements for a supported Stellar network.",
    retryable: false,
    surface: "mcp",
    provenance: "local",
  },
  mcp_paid_but_resource_failed: {
    reason:
      "The payment settled on-ledger but the resource then failed. The money has moved; retrying buys it a second time.",
    retryable: false,
    surface: "mcp",
    provenance: "local",
    remediation:
      "Deliberately NOT mcp_upstream_error, which is retryable. An agent that acts on retryable advice here pays twice — the settlement hash in `details.transaction` is the receipt to take to the seller instead. Gotcha #12 (a retryable code on a non-retryable condition) recurring where the advice costs money rather than a round trip.",
  },
  mcp_upstream_error: {
    reason: "The paid resource returned an error after payment was settled.",
    retryable: true,
    surface: "mcp",
    provenance: "local",
  },
  invalid_exact_stellar_payload_account_policy_refused: {
    reason:
      "The payer is a smart contract account and its own `__check_auth` policy refused this authorization. Nothing is wrong with the payment, the asset or the seller — the payer's wallet declined to authorize it, typically because the amount breaches a spending limit the wallet's owner configured.",
    // Not retryable as-is: the same authorization will be refused identically. The remedy is a
    // smaller amount or a different account, which is a decision only the buyer can make.
    retryable: false,
    surface: "facilitator",
    provenance: "local",
  },
  invalid_upto_stellar_payload_expiration_too_far: {
    reason:
      "The authorization is valid for longer than the payment terms allow. `signatureExpirationLedger` must fall inside the window implied by `maxTimeoutSeconds`, so an authorization cannot stand as an open claim on the payer's balance.",
    // The client must re-sign with a correct window; retrying the same payload cannot help.
    retryable: false,
    surface: "facilitator",
    provenance: "local",
  },
  mcp_resource_host_refused: {
    reason:
      "The resource URL points at a host this MCP server will not fetch — a loopback, link-local, private, or IP-literal address. Paid resources must be reachable at a public hostname.",
    // Not retryable: the same URL will be refused every time. Retrying is the wrong instinct here,
    // and an agent that retries an SSRF probe just makes more noise.
    retryable: false,
    surface: "mcp",
    provenance: "local",
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Caller access control
  //
  // The spec's §9 table has no code for "you need a key" or "you are going too fast", so these are
  // `local` and follow the existing naming convention. Both were previously reported as
  // `unexpected_verify_error`, which is wrong in the one way this codebase cares most about:
  // that code is marked RETRYABLE, so an agent missing an API key would retry a request that can
  // never succeed. Found by running the rejection audit against a deployed facilitator with auth
  // enabled — a configuration no local run had exercised.
  // ───────────────────────────────────────────────────────────────────────────
  facilitator_authentication_required: {
    reason:
      "This facilitator requires caller authentication for the requested network, and no valid API key was supplied.",
    retryable: false,
    surface: "facilitator",
    provenance: "local",
    remediation:
      "Supply `Authorization: Bearer <key>`. Retrying without one fails identically every time, which is why this is not retryable.",
  },
  facilitator_rate_limited: {
    reason: "Too many requests from this caller. The request was refused without being processed.",
    retryable: true,
    surface: "facilitator",
    provenance: "local",
    remediation:
      "Back off and retry after the interval in the `Retry-After` header. Retryable, unlike an auth failure — waiting genuinely helps.",
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Canaries — how a monitoring check reports its own failure
  //
  // These never travel on the wire. They exist so a red nightly run says which property broke
  // rather than dumping a stack trace, and so the published status JSON is branchable by machines
  // instead of grep-able by humans.
  // ───────────────────────────────────────────────────────────────────────────
  canary_setup_failed: {
    reason:
      "The canary could not prepare its testnet fixtures (funding, asset contract, or trustlines), so the property under test was never exercised.",
    retryable: true,
    surface: "canary",
    provenance: "local",
    remediation:
      "Almost always friendbot or Soroban RPC being unavailable rather than a defect in the facilitator. Check the step detail before treating it as a regression.",
  },
  canary_settlement_failed: {
    reason: "The canary's payment did not settle, so the discovery loop could not be exercised.",
    retryable: true,
    surface: "canary",
    provenance: "local",
  },
  canary_extension_response_missing: {
    reason:
      "Settlement succeeded but the facilitator did not report a successful cataloging outcome in the EXTENSION-RESPONSES header.",
    retryable: false,
    surface: "canary",
    provenance: "local",
    remediation:
      "A seller learns whether their listing landed only from this header. Silence here is indistinguishable from success to the seller, which is the failure mode this header exists to prevent.",
  },
  canary_resource_not_indexed: {
    reason:
      "A payment settled carrying the discovery extension, but the resource never appeared in GET /discovery/resources within the deadline.",
    retryable: false,
    surface: "canary",
    provenance: "local",
    remediation:
      "Cataloging is settlement-gated and in-process, so any measurable lag here means the ingest path broke or moved behind a queue.",
  },
  canary_resource_not_ranked: {
    reason:
      "The resource is in the catalog but does not appear in the ranked results for a natural-language query that describes it.",
    retryable: false,
    surface: "canary",
    provenance: "local",
    remediation:
      "Retrieval silently returning nothing is worse than returning the wrong thing: browse still works, so unit tests stay green while search is dead.",
  },
  canary_supported_contract_incomplete: {
    reason:
      "/supported is missing part of the contract a stock client reads before it will attempt a payment.",
    retryable: false,
    surface: "canary",
    provenance: "local",
    remediation:
      "A client that cannot find its scheme in `kinds`, or a Stellar kind without extra.areFeesSponsored, fails at signing time in a way that reads as a client bug. Two live facilitators in the field already have this gap.",
  },
  canary_supported_untruthful: {
    reason:
      "/supported advertises a capability the facilitator does not actually provide at runtime.",
    retryable: false,
    surface: "canary",
    provenance: "local",
    remediation:
      "Advertised and reachable must agree. Never advertise fee sponsorship without a funded signer, or the bazaar extension without serving /discovery/*.",
  },
  canary_rejection_uncoded: {
    reason:
      "A rejection came back without a machine-readable code, or with a reason an agent cannot act on.",
    retryable: false,
    surface: "canary",
    provenance: "local",
    remediation:
      "Every rejection must carry a non-null reason. A reason that merely restates the code is not a reason.",
  },
  canary_rejection_wrong_code: {
    reason: "A rejection was correctly refused but reported under the wrong machine-readable code.",
    retryable: false,
    surface: "canary",
    provenance: "local",
    remediation:
      "Misreporting is worse than a vague message: an agent branches on the code, so the wrong one sends it down the wrong remediation path — or into a retry loop if retryability is wrong too.",
  },
  canary_rejection_accepted: {
    reason: "Something that must have been rejected was accepted.",
    retryable: false,
    surface: "canary",
    provenance: "local",
    remediation:
      "The most serious canary failure there is. A tampered, replayed or expired payment that verifies is a loss of funds, not a monitoring blip.",
  },
  canary_dx_regression: {
    reason:
      "The time from a standing start to a paid, discoverable endpoint exceeded the threshold this project holds itself to.",
    retryable: true,
    surface: "canary",
    provenance: "local",
    remediation:
      "Onboarding time is a measured deliverable; regressions are treated as bugs. Read the per-phase timings before assuming the network was slow — retryable is set because testnet latency genuinely varies.",
  },
  canary_stellar_metadata_missing: {
    reason:
      "A settled Stellar listing reached an agent without the facilitator-derived metadata it should carry — the proven asset identity, or the payee's trustline pre-flight.",
    retryable: false,
    surface: "canary",
    provenance: "local",
    remediation:
      "This is the enrichment no EVM or SVM catalog can offer, and it is only worth anything if it survives every hop: ingest attaches it, the catalog serves it, and the MCP projection must pass it through rather than dropping `extra` wholesale — which is exactly how fee sponsorship was lost once already.",
  },
  canary_parameter_descriptions_lost: {
    reason:
      "The seller's per-parameter descriptions did not survive cataloging, so the endpoint is no longer legible to an agent.",
    retryable: false,
    surface: "canary",
    provenance: "local",
    remediation:
      "HTTP per-parameter descriptions live in bazaar.schema.properties.input.properties.queryParams.properties, not in info.input. Indexing only info.input drops every description.",
  },

  // ───────────────────────────────────────────────────────────────────────────
  // Configuration — fail fast at startup, never at first request
  // ───────────────────────────────────────────────────────────────────────────
  config_network_rpc_missing: {
    reason: "No Soroban RPC URL is configured for an enabled network.",
    retryable: false,
    surface: "config",
    provenance: "local",
    remediation:
      "stellar:pubnet has no default RPC in @x402/stellar and throws without one. Set the RPC URL for every enabled network.",
  },
  config_bazaar_ephemeral_storage: {
    reason:
      "Discovery is unavailable because this deployment cannot hold catalog state between requests.",
    retryable: false,
    surface: "config",
    provenance: "local",
    remediation:
      "The catalog is in-memory and Cloudflare Worker isolates are ephemeral, so listings would vanish unpredictably. Run the Bazaar on a stateful host, or set BAZAAR_EPHEMERAL_ACK=1 to accept lossy discovery for a throwaway demo.",
  },
  config_federation_sources_invalid: {
    reason:
      "FEDERATION_SOURCES is not a valid array of federation sources, or a source omits its id, url, licence or attribution.",
    retryable: false,
    surface: "config",
    provenance: "local",
    remediation:
      "Rejected at startup rather than at first refresh: a typo that silently federates nothing looks exactly like a source being down, and nobody notices for weeks. Every source must record what it is, where it is, the licence it is mirrored under, and the credit that licence requires.",
  },
  config_no_signer: {
    reason: "No Stellar signing account is configured, so the facilitator cannot settle payments.",
    retryable: false,
    surface: "config",
    provenance: "local",
  },
  config_fee_sponsorship_mismatch: {
    reason:
      "Fee sponsorship is advertised as enabled but the facilitator is not configured to sponsor fees.",
    retryable: false,
    surface: "config",
    provenance: "local",
    remediation:
      "areFeesSponsored must reflect actual runtime behaviour. Never advertise sponsorship falsely.",
  },
} as const satisfies Record<string, ErrorDefinition>;

/** Every registered error code, as a union type. */
export type ErrorCode = keyof typeof ERROR_REGISTRY;

/** All codes, sorted — useful for docs generation and exhaustiveness tests. */
export const ALL_ERROR_CODES = Object.keys(ERROR_REGISTRY).sort() as readonly ErrorCode[];
