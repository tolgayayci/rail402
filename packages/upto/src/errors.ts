/**
 * Every reason code an x402 `upto` verification or settlement on Stellar can return.
 *
 * Each code has an HTTP `status` (used only when a code is returned as a transport error; `/verify`
 * and `/settle` outcomes are HTTP 200 with `isValid: false` / `success: false`), whether repeating the
 * same request can succeed later, and a non-empty default reason, so a facilitator can register
 * the sets in its own code registry as they are.
 */
export interface UptoCodeSpec {
  readonly status: number;
  readonly retryable: boolean;
  readonly reason: string;
}

/** Codes defined by the x402 v2 specification, shared with every other scheme. */
export const uptoStandardCodes = Object.freeze({
  invalid_x402_version: { status: 400, retryable: false, reason: "Only x402 version 2 is supported." },
  unsupported_scheme: {
    status: 400,
    retryable: false,
    reason: "The payment scheme is not supported by this facilitator.",
  },
  invalid_network: {
    status: 400,
    retryable: false,
    reason: "This facilitator does not serve the requested network.",
  },
  network_mismatch: {
    status: 400,
    retryable: false,
    reason: "The payload's accepted network differs from the payment requirements.",
  },
  invalid_payload: { status: 400, retryable: false, reason: "The payment payload is malformed." },
  invalid_payment_requirements: {
    status: 400,
    retryable: false,
    reason: "The payment requirements are malformed.",
  },
  insufficient_funds: {
    status: 400,
    retryable: true,
    reason: "The payer's token balance is lower than the payment amount.",
  },
  settlement_pending: {
    status: 503,
    retryable: true,
    reason:
      "The settlement transaction was submitted but is not yet confirmed; reconcile the returned transaction hash before retrying.",
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
} as const satisfies Record<string, UptoCodeSpec>);

/** Codes specific to the `upto` scheme on Stellar. */
export const uptoStellarCodes = Object.freeze({
  // --- requirements -------------------------------------------------------------------------------
  invalid_upto_stellar_requirements_fees_not_sponsored: {
    status: 400,
    retryable: false,
    reason: "Stellar upto payments require extra.areFeesSponsored to be true.",
  },
  invalid_upto_stellar_requirements_facilitator_mismatch: {
    status: 400,
    retryable: false,
    reason: "extra.facilitatorAddress is not this facilitator's settlement authority.",
  },
  invalid_upto_stellar_requirements_invalid_pay_to: {
    status: 400,
    retryable: false,
    reason:
      "payTo must be a Stellar account (G…) or contract (C…) that is neither a facilitator account, the settlement contract nor the asset.",
  },
  invalid_upto_stellar_requirements_invalid_amount: {
    status: 400,
    retryable: false,
    reason:
      "amount must be an integer string in the asset's smallest unit: positive for the cap, zero or more to settle.",
  },
  invalid_upto_stellar_requirements_asset_not_accepted: {
    status: 400,
    retryable: false,
    reason: "This facilitator does not settle payments in the requested asset.",
  },
  invalid_upto_stellar_requirements_amount_out_of_range: {
    status: 400,
    retryable: false,
    reason: "The payment amount is outside the range this facilitator accepts.",
  },
  invalid_upto_stellar_requirements_timeout_out_of_range: {
    status: 400,
    retryable: false,
    reason: "maxTimeoutSeconds is outside the range this facilitator accepts.",
  },

  // --- payload structure ----------------------------------------------------------------------
  invalid_upto_stellar_payload_accepted_mismatch: {
    status: 400,
    retryable: false,
    reason: "The payload's accepted requirements differ from the payment requirements.",
  },
  invalid_upto_stellar_payload_malformed: {
    status: 400,
    retryable: false,
    reason: "payload.authorization must be one base64 XDR SorobanAuthorizationEntry.",
  },
  invalid_upto_stellar_payload_too_large: {
    status: 413,
    retryable: false,
    reason: "An authorization entry in the payload exceeds the size limit.",
  },
  invalid_upto_stellar_payload_unsupported_credential_type: {
    status: 400,
    retryable: false,
    reason:
      "The payer's authorization must use address credentials (legacy or CAP-71 V2) of a G… or C… address.",
  },
  invalid_upto_stellar_payload_missing_payer_signature: {
    status: 400,
    retryable: false,
    reason: "The payer's authorization entry carries no signature.",
  },
  invalid_upto_stellar_payload_wrong_contract: {
    status: 400,
    retryable: false,
    reason: "The authorization is not for this network's upto settlement contract.",
  },
  invalid_upto_stellar_payload_wrong_function: {
    status: 400,
    retryable: false,
    reason: "The authorization must be for settle(terms) with exactly one argument.",
  },
  invalid_upto_stellar_payload_invalid_terms: {
    status: 400,
    retryable: false,
    reason: "The authorized settle argument is not a well-formed UptoTerms value.",
  },
  invalid_upto_stellar_payload_wrong_recipient: {
    status: 400,
    retryable: false,
    reason: "The authorized recipient differs from the required payTo address.",
  },
  invalid_upto_stellar_payload_wrong_asset: {
    status: 400,
    retryable: false,
    reason: "The authorized token differs from the required asset.",
  },
  invalid_upto_stellar_payload_wrong_amount: {
    status: 400,
    retryable: false,
    reason: "The authorized cap differs from the accepted amount.",
  },
  invalid_upto_stellar_payload_facilitator_mismatch: {
    status: 400,
    retryable: false,
    reason: "The authorized settlement authority is not this facilitator's.",
  },
  invalid_upto_stellar_payload_expiration_mismatch: {
    status: 400,
    retryable: false,
    reason: "The terms' expiration_ledger differs from the entry's signatureExpirationLedger.",
  },
  invalid_upto_stellar_payload_not_yet_valid: {
    status: 400,
    retryable: true,
    reason: "The terms are not valid yet (valid_after_ledger is in the future).",
  },
  invalid_upto_stellar_payload_invalid_authorization_tree: {
    status: 400,
    retryable: false,
    reason:
      "The authorization must contain exactly one child, token.approve(payer, settlement contract, cap, expiration), and nothing else.",
  },
  invalid_upto_stellar_payload_facilitator_is_payer: {
    status: 400,
    retryable: false,
    reason: "The payer is a facilitator account or the settlement contract.",
  },
  invalid_upto_stellar_payload_self_payment: {
    status: 400,
    retryable: false,
    reason: "The payer and payTo are the same address; a payment to oneself is not settled.",
  },
  invalid_upto_stellar_payload_unsupported_recipient: {
    status: 400,
    retryable: false,
    reason: "Muxed (M…) payTo addresses cannot receive upto payments; use a G… or C… address.",
  },
  invalid_upto_stellar_payload_invalid_signer_authorization: {
    status: 400,
    retryable: false,
    reason:
      "signerAuthorizations must be at most four signed __check_auth entries of a smart-account payer's delegated signers.",
  },
  invalid_upto_stellar_payload_settlement_exceeds_amount: {
    status: 400,
    retryable: false,
    reason: "The settlement amount exceeds the amount the payer authorized.",
  },

  // --- expiration ---------------------------------------------------------------------------------
  invalid_upto_stellar_signature_expired: {
    status: 400,
    retryable: false,
    reason: "The payer's authorization has expired; sign a new payment.",
  },
  invalid_upto_stellar_signature_expiration_too_far: {
    status: 400,
    retryable: false,
    reason: "The authorization expires later than maxTimeoutSeconds allows.",
  },
  invalid_upto_stellar_signature_expiration_too_soon: {
    status: 400,
    retryable: false,
    reason: "The authorization expires before settlement can safely land on-chain; sign a new payment.",
  },

  // --- simulation ---------------------------------------------------------------------------------
  invalid_upto_stellar_payload_simulation_failed: {
    status: 400,
    retryable: false,
    reason: "Simulating the settlement against the current ledger failed.",
  },
  invalid_upto_stellar_payload_nonce_already_used: {
    status: 409,
    retryable: false,
    reason: "This authorization has already been used on-chain; each signed payment settles at most once.",
  },
  invalid_upto_stellar_payload_invalid_signature: {
    status: 400,
    retryable: false,
    reason: "The payer's authorization signature does not verify.",
  },
  invalid_upto_stellar_payload_smart_account_rejected: {
    status: 400,
    retryable: false,
    reason: "The payer's smart account (__check_auth or one of its policies) rejected the authorization.",
  },
  invalid_upto_stellar_payload_payer_trustline_missing: {
    status: 400,
    retryable: true,
    reason: "The payer has no trustline for this asset.",
  },
  invalid_upto_stellar_payload_recipient_trustline_missing: {
    status: 400,
    retryable: true,
    reason: "The payTo account has no trustline for this asset, so it cannot receive the payment.",
  },
  invalid_upto_stellar_payload_trustline_not_authorized: {
    status: 400,
    retryable: true,
    reason: "A trustline for this asset is not authorized by the issuer.",
  },
  invalid_upto_stellar_payload_account_missing: {
    status: 400,
    retryable: true,
    reason: "An account involved in the settlement does not exist on this network.",
  },
  invalid_upto_stellar_payload_archived_state: {
    status: 400,
    retryable: true,
    reason: "Ledger state needed by the settlement is archived and must be restored first.",
  },
  invalid_upto_stellar_settlement_contract_archived: {
    status: 503,
    retryable: true,
    reason: "The upto settlement contract's instance or code is archived; the operator must restore it.",
  },
  invalid_upto_stellar_payload_fee_exceeds_maximum: {
    status: 400,
    retryable: true,
    reason: "The network fee to settle this payment exceeds the facilitator's fee ceiling.",
  },
  invalid_upto_stellar_payload_unexpected_balance_change: {
    status: 400,
    retryable: false,
    reason:
      "The simulated settlement must move exactly the settled amount from the payer to payTo in the required asset, and nothing else.",
  },
  invalid_upto_stellar_payload_settlement_event_mismatch: {
    status: 400,
    retryable: false,
    reason: "The simulated settlement did not emit exactly one matching upto_settled event.",
  },

  // --- settlement -------------------------------------------------------------------------------
  settle_upto_stellar_signer_selection_failed: {
    status: 503,
    retryable: true,
    reason: "No settlement account was available to submit the transaction.",
  },
  settle_upto_stellar_transaction_signing_failed: {
    status: 500,
    retryable: true,
    reason: "The facilitator could not sign the settlement transaction.",
  },
  settle_upto_stellar_fee_bump_signing_failed: {
    status: 500,
    retryable: true,
    reason: "The facilitator could not sign the fee-bump transaction.",
  },
  settle_upto_stellar_transaction_submission_failed: {
    status: 400,
    retryable: false,
    reason: "The network refused the settlement transaction, so no funds moved.",
  },
  settle_upto_stellar_transaction_failed: {
    status: 400,
    retryable: false,
    reason: "The settlement transaction failed on-chain; no funds moved.",
  },
  settle_upto_stellar_transaction_expired: {
    status: 400,
    retryable: false,
    reason: "The settlement transaction expired without being included in a ledger; no funds moved.",
  },
  settle_upto_stellar_idempotency_conflict: {
    status: 409,
    retryable: false,
    reason: "This authorization was already settled, or is being settled, for a different amount.",
  },
  settle_upto_stellar_settlement_in_progress: {
    status: 409,
    retryable: true,
    reason: "Another request is settling this authorization right now; retry to receive its result.",
  },
  settle_upto_stellar_channel_unavailable: {
    status: 503,
    retryable: true,
    reason: "All settlement channels are busy; retry shortly.",
  },
  settle_upto_stellar_sponsor_unavailable: {
    status: 503,
    retryable: true,
    reason: "Fee sponsorship is temporarily unavailable on this network.",
  },
  settle_upto_stellar_authority_unavailable: {
    status: 503,
    retryable: true,
    reason: "The settlement authority is not available on this network.",
  },
} as const satisfies Record<string, UptoCodeSpec>);

/** Every code this scheme returns. */
export const uptoCodes = Object.freeze({ ...uptoStandardCodes, ...uptoStellarCodes });

export type UptoStandardCode = keyof typeof uptoStandardCodes;
export type UptoStellarCode = keyof typeof uptoStellarCodes;
export type UptoCode = keyof typeof uptoCodes;

/**
 * Whether `value` is one of this scheme's codes.
 *
 * @param value - The value to check
 * @returns Whether it is a code
 */
export function isUptoCode(value: unknown): value is UptoCode {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(uptoCodes, value);
}

/**
 * The default reason of a code.
 *
 * @param code - The code
 * @returns Its default reason
 */
export function uptoReason(code: UptoCode): string {
  return uptoCodes[code].reason;
}

/** A refusal: a stable code and a non-empty, specific reason. */
export interface UptoRejection {
  readonly code: UptoCode;
  readonly reason: string;
}

/**
 * Builds a refusal, falling back to the code's default reason for a blank detail.
 *
 * @param code - The code
 * @param reason - A specific reason
 * @returns The refusal
 */
export function reject(code: UptoCode, reason?: string): UptoRejection {
  return { code, reason: reason !== undefined && reason.trim() !== "" ? reason : uptoReason(code) };
}
