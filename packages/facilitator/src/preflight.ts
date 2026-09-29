import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  DESTINATION_ADDRESS,
  baseAccount,
  inspectExactTransaction,
  payerAuthorization,
  type AuthorizationInfo,
  type ExactStellarCode,
  type ExactTransfer,
} from "@rail402.dev/stellar";
import type { NetworkPolicy } from "./policy.ts";

export interface PreflightContext {
  readonly policy: NetworkPolicy;
  readonly passphrase: string;
  /** Every account the facilitator signs or pays with: sponsor and channels. */
  readonly facilitatorAddresses: ReadonlySet<string>;
  /** Latest closed ledger, for the authorization expiry checks. */
  readonly currentLedger: number;
}

export type Preflight =
  | { readonly ok: true; readonly transfer: ExactTransfer; readonly authorization: AuthorizationInfo }
  | {
      readonly ok: false;
      readonly code: ExactStellarCode;
      readonly reason?: string;
      readonly payer?: string;
    };

const AMOUNT = /^[1-9][0-9]*$/;

/**
 * Checks everything that can be decided without simulating: the protocol envelope, the operator's
 * policy, the transaction structure, the authorization entries and their expiry. It runs before the
 * upstream verifier on every verify and settle, so a payment that cannot settle is rejected before
 * any RPC work and with a specific code.
 */
export function preflight(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  context: PreflightContext,
): Preflight {
  const { policy } = context;

  if (payload.x402Version !== 2) return reject("invalid_x402_version");
  if (requirements.scheme !== "exact" || payload.accepted.scheme !== "exact") {
    return reject("unsupported_scheme");
  }
  if (requirements.network !== policy.network) return reject("invalid_network");
  if (payload.accepted.network !== requirements.network) return reject("network_mismatch");

  const requirementsViolation = checkRequirements(requirements, policy);
  if (requirementsViolation !== undefined) return requirementsViolation;

  const accepted = payload.accepted;
  if (
    accepted.asset !== requirements.asset ||
    accepted.payTo !== requirements.payTo ||
    accepted.amount !== requirements.amount
  ) {
    return reject("invalid_exact_stellar_payload_accepted_mismatch");
  }

  const payloadBody = payload.payload as { transaction?: unknown } | undefined;
  const inspection = inspectExactTransaction(payloadBody?.transaction, context.passphrase);
  if (!inspection.ok) return inspection;
  const { transfer } = inspection;
  const payer = transfer.from;
  const facilitator = context.facilitatorAddresses;

  if (facilitator.has(transfer.sourceAccount) || facilitator.has(transfer.operationSource ?? "")) {
    return reject("invalid_exact_stellar_payload_unsafe_tx_or_op_source", undefined, payer);
  }
  if (facilitator.has(payer)) return reject("invalid_exact_stellar_payload_facilitator_is_payer");
  if (transfer.asset !== requirements.asset) {
    return reject("invalid_exact_stellar_payload_wrong_asset", undefined, payer);
  }
  if (transfer.to !== requirements.payTo) {
    return reject("invalid_exact_stellar_payload_wrong_recipient", undefined, payer);
  }
  // A payment to oneself moves nothing, yet the sponsor would pay its fee: never settle one.
  if (baseAccount(transfer.to) === baseAccount(payer)) {
    return reject("invalid_exact_stellar_payload_self_payment", undefined, payer);
  }
  if (transfer.amount !== BigInt(requirements.amount)) {
    return reject("invalid_exact_stellar_payload_wrong_amount", undefined, payer);
  }
  if (transfer.hasUnsupportedPreconditions) {
    return reject("invalid_exact_stellar_payload_unsupported_preconditions", undefined, payer);
  }

  if (transfer.otherCredentials > 0) {
    return reject("invalid_exact_stellar_payload_unsupported_credential_type", undefined, payer);
  }
  if (transfer.authorizations.length === 0) {
    return reject("invalid_exact_stellar_payload_no_auth_entries", undefined, payer);
  }
  if (transfer.authorizations.some((entry) => facilitator.has(entry.address))) {
    return reject("invalid_exact_stellar_payload_facilitator_in_auth", undefined, payer);
  }
  if (transfer.authorizations.some((entry) => entry.subInvocations > 0)) {
    return reject("invalid_exact_stellar_payload_has_subinvocations", undefined, payer);
  }
  const authorization = payerAuthorization(transfer);
  if (authorization === undefined || !authorization.signed) {
    return reject("invalid_exact_stellar_payload_missing_payer_signature", undefined, payer);
  }
  if (transfer.authorizations.some((entry) => !entry.signed)) {
    return reject("invalid_exact_stellar_payload_unexpected_pending_signatures", undefined, payer);
  }
  if (!authorization.matchesOperation) {
    return reject("invalid_exact_stellar_payload_auth_invocation_mismatch", undefined, payer);
  }

  // The host treats an authorization as valid through its expiration ledger, inclusive.
  const expiration = authorization.signatureExpirationLedger;
  if (expiration < context.currentLedger) {
    return reject(
      "invalid_exact_stellar_signature_expired",
      `The authorization expired at ledger ${expiration}; the network is at ledger ${context.currentLedger}.`,
      payer,
    );
  }
  if (expiration < context.currentLedger + policy.expirationMarginLedgers) {
    return reject(
      "invalid_exact_stellar_signature_expiration_too_soon",
      `The authorization expires at ledger ${expiration}, within ${policy.expirationMarginLedgers} ledger(s) of the current ledger ${context.currentLedger}.`,
      payer,
    );
  }

  return { ok: true, transfer, authorization };
}

/** Validates the payment requirements against the operator's policy. */
export function checkRequirements(
  requirements: PaymentRequirements,
  policy: NetworkPolicy,
): Preflight | undefined {
  const asset = policy.assets.get(requirements.asset);
  if (asset === undefined) return reject("invalid_exact_stellar_requirements_asset_not_accepted");
  if (typeof requirements.payTo !== "string" || !DESTINATION_ADDRESS.test(requirements.payTo)) {
    return reject("invalid_exact_stellar_requirements_invalid_pay_to");
  }
  if (typeof requirements.amount !== "string" || !AMOUNT.test(requirements.amount)) {
    return reject("invalid_exact_stellar_requirements_invalid_amount");
  }
  const amount = BigInt(requirements.amount);
  if (amount < asset.minAmount || amount > asset.maxAmount) {
    return reject(
      "invalid_exact_stellar_requirements_amount_out_of_range",
      `amount must be between ${asset.minAmount} and ${asset.maxAmount} base units of ${asset.symbol}.`,
    );
  }
  const timeout = requirements.maxTimeoutSeconds;
  if (
    !Number.isInteger(timeout) ||
    timeout < policy.timeoutSeconds.min ||
    timeout > policy.timeoutSeconds.max
  ) {
    return reject(
      "invalid_exact_stellar_requirements_timeout_out_of_range",
      `maxTimeoutSeconds must be an integer between ${policy.timeoutSeconds.min} and ${policy.timeoutSeconds.max}.`,
    );
  }
  if ((requirements.extra as { areFeesSponsored?: unknown } | undefined)?.areFeesSponsored !== true) {
    return reject("invalid_exact_stellar_requirements_fees_not_sponsored");
  }
  return undefined;
}

function reject(code: ExactStellarCode, reason?: string, payer?: string): Preflight {
  return {
    ok: false,
    code,
    ...(reason === undefined ? {} : { reason }),
    ...(payer === undefined ? {} : { payer }),
  };
}
