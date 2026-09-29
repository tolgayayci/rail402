import { defineCodes, errorFactory } from "@rail402.dev/errors";

/**
 * Every reason code an x402 `exact` Stellar verification or settlement can return.
 *
 * Codes come from three sources and keep their original spelling so stock x402 clients recognise them:
 * the x402 v2 specification (§9), the upstream @x402/stellar scheme, and Rail402's own refinements.
 * Rail402's codes split upstream's catch-all `invalid_exact_stellar_payload_simulation_failed` into the
 * specific on-chain cause, and cover checks upstream does not make.
 *
 * `status` applies only when a code is returned as a transport error. Verification and settlement
 * outcomes are always HTTP 200 with `isValid: false` / `success: false`, as the specification requires.
 */
export const exactStellarCodes = defineCodes({
  // --- x402 v2 specification ---------------------------------------------------------------------
  insufficient_funds: {
    status: 400,
    retryable: true,
    reason: "The payer's token balance is lower than the payment amount.",
  },
  invalid_payload: { status: 400, retryable: false, reason: "The payment payload is malformed." },
  invalid_payment_requirements: {
    status: 400,
    retryable: false,
    reason: "The payment requirements are malformed.",
  },
  invalid_network: {
    status: 400,
    retryable: false,
    reason: "This facilitator does not serve the requested network.",
  },
  invalid_scheme: { status: 400, retryable: false, reason: "The payment scheme is not supported." },
  invalid_x402_version: { status: 400, retryable: false, reason: "Only x402 version 2 is supported." },
  invalid_transaction_state: {
    status: 400,
    retryable: false,
    reason: "The settlement transaction failed on-chain.",
  },
  unexpected_verify_error: {
    status: 500,
    retryable: true,
    reason: "Verification failed because of an unexpected internal error.",
  },
  unexpected_settle_error: {
    status: 500,
    retryable: true,
    reason: "Settlement failed because of an unexpected internal error.",
  },
  settlement_pending: {
    status: 503,
    retryable: true,
    reason:
      "The settlement transaction was submitted but is not yet confirmed; reconcile the returned transaction hash before retrying.",
  },

  // --- upstream @x402/stellar exact scheme -------------------------------------------------------
  unsupported_scheme: { status: 400, retryable: false, reason: "Only the exact scheme is supported." },
  network_mismatch: {
    status: 400,
    retryable: false,
    reason: "The payload's accepted network differs from the payment requirements.",
  },
  verification_failed: { status: 400, retryable: false, reason: "The payment failed verification." },
  invalid_exact_stellar_payload_malformed: {
    status: 400,
    retryable: false,
    reason: "The payload transaction is not a valid Stellar transaction envelope for this network.",
  },
  invalid_exact_stellar_payload_wrong_operation: {
    status: 400,
    retryable: false,
    reason: "The transaction must contain exactly one invokeHostFunction operation invoking a contract.",
  },
  invalid_exact_stellar_payload_unsafe_tx_or_op_source: {
    status: 400,
    retryable: false,
    reason: "The transaction or operation source is a facilitator account.",
  },
  invalid_exact_stellar_payload_wrong_asset: {
    status: 400,
    retryable: false,
    reason: "The invoked token contract differs from the required asset.",
  },
  invalid_exact_stellar_payload_wrong_function_name: {
    status: 400,
    retryable: false,
    reason: "The operation must call transfer(from, to, amount) with exactly three arguments.",
  },
  invalid_exact_stellar_payload_facilitator_is_payer: {
    status: 400,
    retryable: false,
    reason: "The transfer's from address is a facilitator account.",
  },
  invalid_exact_stellar_payload_wrong_recipient: {
    status: 400,
    retryable: false,
    reason: "The transfer recipient differs from the required payTo address.",
  },
  invalid_exact_stellar_payload_wrong_amount: {
    status: 400,
    retryable: false,
    reason: "The transfer amount differs from the required amount.",
  },
  invalid_exact_stellar_payload_simulation_failed: {
    status: 400,
    retryable: false,
    reason: "Simulating the payment against the current ledger failed.",
  },
  invalid_exact_stellar_payload_fee_exceeds_maximum: {
    status: 400,
    retryable: true,
    reason: "The network fee to settle this payment exceeds the facilitator's fee ceiling.",
  },
  invalid_exact_stellar_payload_event_not_transfer: {
    status: 400,
    retryable: false,
    reason: "Simulation emitted a contract event other than the expected transfer.",
  },
  invalid_exact_stellar_payload_event_missing_contract_id: {
    status: 400,
    retryable: false,
    reason: "Simulation emitted a contract event without a contract id.",
  },
  invalid_exact_stellar_payload_event_wrong_asset: {
    status: 400,
    retryable: false,
    reason: "Simulation emitted a transfer event from a contract other than the required asset.",
  },
  invalid_exact_stellar_payload_no_transfer_events: {
    status: 400,
    retryable: false,
    reason: "Simulation emitted no transfer event.",
  },
  invalid_exact_stellar_payload_multiple_transfers: {
    status: 400,
    retryable: false,
    reason: "Simulation emitted more than one transfer event.",
  },
  invalid_exact_stellar_payload_event_wrong_from: {
    status: 400,
    retryable: false,
    reason: "The simulated transfer is debited from an account other than the payer.",
  },
  invalid_exact_stellar_payload_event_wrong_to: {
    status: 400,
    retryable: false,
    reason: "The simulated transfer credits an account other than payTo.",
  },
  invalid_exact_stellar_payload_event_wrong_amount: {
    status: 400,
    retryable: false,
    reason: "The simulated transfer amount differs from the required amount.",
  },
  invalid_exact_stellar_payload_no_auth_entries: {
    status: 400,
    retryable: false,
    reason: "The transaction carries no authorization entries.",
  },
  invalid_exact_stellar_payload_unsupported_credential_type: {
    status: 400,
    retryable: false,
    reason: "Authorization entries must use address credentials (legacy or CAP-71 V2).",
  },
  invalid_exact_stellar_payload_facilitator_in_auth: {
    status: 400,
    retryable: false,
    reason: "A facilitator account appears in an authorization entry.",
  },
  invalid_exact_stellar_signature_expiration_too_far: {
    status: 400,
    retryable: false,
    reason: "The authorization expires later than maxTimeoutSeconds allows.",
  },
  invalid_exact_stellar_payload_has_subinvocations: {
    status: 400,
    retryable: false,
    reason: "The authorization entry authorizes sub-invocations beyond the transfer.",
  },
  invalid_exact_stellar_payload_missing_payer_signature: {
    status: 400,
    retryable: false,
    reason: "The payer has not signed an authorization entry for the transfer.",
  },
  invalid_exact_stellar_payload_unexpected_pending_signatures: {
    status: 400,
    retryable: false,
    reason: "The transaction requires signatures from accounts other than the payer.",
  },
  settle_exact_stellar_signer_selection_failed: {
    status: 503,
    retryable: true,
    reason: "No settlement account was available to submit the transaction.",
  },
  settle_exact_stellar_transaction_signing_failed: {
    status: 500,
    retryable: true,
    reason: "The facilitator could not sign the settlement transaction.",
  },
  settle_exact_stellar_fee_bump_signing_failed: {
    status: 500,
    retryable: true,
    reason: "The facilitator could not sign the fee-bump transaction.",
  },
  settle_exact_stellar_transaction_submission_failed: {
    status: 400,
    retryable: false,
    reason: "The network refused the settlement transaction, so no funds moved; sign a new payment.",
  },
  settle_exact_stellar_transaction_failed: {
    status: 400,
    retryable: false,
    reason: "The settlement transaction failed or could not be confirmed.",
  },

  // --- Rail402: requirements policy --------------------------------------------------------------
  invalid_exact_stellar_requirements_fees_not_sponsored: {
    status: 400,
    retryable: false,
    reason: "Stellar exact payments require extra.areFeesSponsored to be true.",
  },
  invalid_exact_stellar_requirements_asset_not_accepted: {
    status: 400,
    retryable: false,
    reason: "This facilitator does not settle payments in the requested asset.",
  },
  invalid_exact_stellar_requirements_invalid_pay_to: {
    status: 400,
    retryable: false,
    reason: "payTo must be a Stellar account (G…), contract (C…) or muxed account (M…) address.",
  },
  invalid_exact_stellar_requirements_invalid_amount: {
    status: 400,
    retryable: false,
    reason: "amount must be a positive integer string in the asset's smallest unit.",
  },
  invalid_exact_stellar_requirements_amount_out_of_range: {
    status: 400,
    retryable: false,
    reason: "The payment amount is outside the range this facilitator accepts.",
  },
  invalid_exact_stellar_requirements_timeout_out_of_range: {
    status: 400,
    retryable: false,
    reason: "maxTimeoutSeconds is outside the range this facilitator accepts.",
  },
  invalid_exact_stellar_payload_accepted_mismatch: {
    status: 400,
    retryable: false,
    reason: "The payload's accepted requirements differ from the payment requirements.",
  },

  // --- Rail402: transaction structure ------------------------------------------------------------
  invalid_exact_stellar_payload_too_large: {
    status: 413,
    retryable: false,
    reason: "The payload transaction exceeds the size limit.",
  },
  invalid_exact_stellar_payload_unsupported_preconditions: {
    status: 400,
    retryable: false,
    reason:
      "The transaction sets ledger bounds, sequence conditions or extra signers, which settlement cannot honour.",
  },
  invalid_exact_stellar_payload_self_payment: {
    status: 400,
    retryable: false,
    reason:
      "The payer and payTo are the same account; a payment to oneself moves no funds and is not settled.",
  },
  invalid_exact_stellar_payload_auth_invocation_mismatch: {
    status: 400,
    retryable: false,
    reason: "The payer's authorization entry does not authorize exactly the transfer the operation performs.",
  },
  invalid_exact_stellar_signature_expired: {
    status: 400,
    retryable: false,
    reason: "The payer's authorization has expired; sign a new payment.",
  },
  invalid_exact_stellar_signature_expiration_too_soon: {
    status: 400,
    retryable: false,
    reason:
      "The payer's authorization expires before settlement can safely land on-chain; sign a new payment.",
  },

  // --- Rail402: on-chain causes behind a failed simulation ---------------------------------------
  invalid_exact_stellar_payload_nonce_already_used: {
    status: 409,
    retryable: false,
    reason: "This authorization has already been used on-chain; each signed payment settles at most once.",
  },
  invalid_exact_stellar_payload_invalid_signature: {
    status: 400,
    retryable: false,
    reason: "The payer's authorization signature does not verify for this transfer.",
  },
  invalid_exact_stellar_payload_unauthorized_invocation: {
    status: 400,
    retryable: false,
    reason: "The transfer is not covered by the payer's authorization.",
  },
  invalid_exact_stellar_payload_smart_account_rejected: {
    status: 400,
    retryable: false,
    reason: "The payer's smart account (__check_auth) rejected the authorization.",
  },
  invalid_exact_stellar_payload_payer_trustline_missing: {
    status: 400,
    retryable: true,
    reason: "The payer has no trustline for this asset.",
  },
  invalid_exact_stellar_payload_recipient_trustline_missing: {
    status: 400,
    retryable: true,
    reason: "The payTo account has no trustline for this asset, so it cannot receive the payment.",
  },
  invalid_exact_stellar_payload_trustline_not_authorized: {
    status: 400,
    retryable: true,
    reason: "A trustline for this asset is not authorized by the issuer.",
  },
  invalid_exact_stellar_payload_account_missing: {
    status: 400,
    retryable: true,
    reason: "An account involved in the transfer does not exist on this network.",
  },
  invalid_exact_stellar_payload_archived_state: {
    status: 400,
    retryable: true,
    reason: "Ledger state needed by the transfer is archived and must be restored first.",
  },

  // --- Rail402: settlement engine ----------------------------------------------------------------
  settle_exact_stellar_idempotency_conflict: {
    status: 409,
    retryable: false,
    reason:
      "This authorization was already submitted for settlement inside a different transaction envelope.",
  },
  settle_exact_stellar_settlement_in_progress: {
    status: 409,
    retryable: true,
    reason: "Another request is settling this authorization right now; retry to receive its result.",
  },
  settle_exact_stellar_channel_unavailable: {
    status: 503,
    retryable: true,
    reason: "All settlement channels are busy; retry shortly.",
  },
  settle_exact_stellar_sponsor_unavailable: {
    status: 503,
    retryable: true,
    reason: "Fee sponsorship is temporarily unavailable on this network.",
  },
  settle_exact_stellar_transaction_expired: {
    status: 400,
    retryable: false,
    reason: "The settlement transaction expired without being included in a ledger; no funds moved.",
  },
});

export type ExactStellarCode = keyof typeof exactStellarCodes;

export const exactStellarError = errorFactory(exactStellarCodes);

export function isExactStellarCode(value: unknown): value is ExactStellarCode {
  return typeof value === "string" && Object.hasOwn(exactStellarCodes, value);
}
