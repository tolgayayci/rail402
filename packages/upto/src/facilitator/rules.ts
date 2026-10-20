import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { xdr } from "@stellar/stellar-sdk";
import {
  inspectSignerAuthorizations,
  inspectUptoAuthorization,
  type UptoAuthorization,
} from "../authorization.ts";
import {
  EXPIRATION_LEDGER_TOLERANCE,
  NOMINAL_LEDGER_SECONDS,
  UPTO_SCHEME,
  UPTO_X402_VERSION,
} from "../constants.ts";
import { reject, type UptoRejection } from "../errors.ts";
import {
  isAccountOrContract,
  isContractAddress,
  isMuxedAddress,
  isRecord,
  isSubsetOf,
  ledgersFor,
  minTimeoutSecondsFor,
  parseAtomicAmount,
} from "../shared.ts";
import type { UptoStellarPayload } from "../types.ts";

/** `verify` checks the payment for its cap; `settle` for the amount being settled. */
export type UptoPhase = "verify" | "settle";

/** What the static rules need to know about the facilitator and the ledger. */
export interface UptoRuleContext {
  readonly phase: UptoPhase;
  /** The network's settlement contract. */
  readonly contract: string;
  /** The settlement authority (`extra.facilitatorAddress`). */
  readonly authority: string;
  /** Every facilitator-controlled address: authority, transaction sources, fee payer. */
  readonly facilitatorAddresses: ReadonlySet<string>;
  readonly currentLedger: number;
  readonly ledgerSeconds: number;
  readonly maxTimeoutSeconds: number;
  /** Smallest `maxTimeoutSeconds` accepted (default: one ledger more than the margin, see `minTimeoutSecondsFor`). */
  readonly minTimeoutSeconds?: number | undefined;
  readonly expirationMarginLedgers: number;
  /** Asset allow-list; every asset is accepted when absent. */
  readonly isAssetAccepted?: ((asset: string, network: string) => boolean) | undefined;
}

/** A payment that passed every static rule. */
export interface CheckedUptoPayment {
  readonly authorization: UptoAuthorization;
  readonly signerAuthorizations: readonly xdr.SorobanAuthorizationEntry[];
  readonly payer: string;
  /** The payer's cap (`accepted.amount`). */
  readonly maxAmount: bigint;
  /** The amount this phase simulates and settles: the cap at `verify`, the settle amount at `settle`. */
  readonly amount: bigint;
}

export type RuleResult =
  | { readonly ok: true; readonly payment: CheckedUptoPayment }
  | { readonly ok: false; readonly rejection: UptoRejection; readonly payer?: string | undefined };

const fail = (rejection: UptoRejection, payer?: string): RuleResult => ({ ok: false, rejection, payer });

/**
 * The static rules of the `upto` scheme on Stellar, in order. They need no RPC call beyond the
 * current ledger and never write anything. Network checks (version, scheme, served network) are
 * rule 1; the requirements are rule 2; the entry, its root and terms rules 3–5; the tree rule 6;
 * the expiration window rule 7; the payer rule 8; signer authorizations rule 9.
 *
 * @param payload - The payment payload
 * @param requirements - The payment requirements
 * @param context - The facilitator's policy and the current ledger
 * @returns The checked payment, or the first violated rule's refusal
 */
export function checkUptoPayment(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  context: UptoRuleContext,
): RuleResult {
  // Rule 1 (the served-network check happens before, when the contract is resolved).
  if (payload.x402Version !== UPTO_X402_VERSION) return fail(reject("invalid_x402_version"));
  if (!isRecord(payload.accepted)) return fail(reject("invalid_upto_stellar_payload_accepted_mismatch"));
  if (payload.accepted.scheme !== UPTO_SCHEME || requirements.scheme !== UPTO_SCHEME) {
    return fail(reject("unsupported_scheme", `Only the ${UPTO_SCHEME} scheme is handled here.`));
  }
  if (payload.accepted.network !== requirements.network) return fail(reject("network_mismatch"));

  // Rule 2: requirements, and agreement with what the payer accepted.
  const requirementsRejection = checkRequirements(payload.accepted, requirements, context);
  if (requirementsRejection !== undefined) return fail(requirementsRejection);
  const maxAmount = parseAtomicAmount(payload.accepted.amount) ?? 0n;
  const amount = parseAtomicAmount(requirements.amount) ?? 0n;

  // Rule 3–4: the entry, its credentials, root call and terms.
  const body = payload.payload as Partial<UptoStellarPayload> | null | undefined;
  if (typeof body !== "object" || body === null)
    return fail(reject("invalid_upto_stellar_payload_malformed"));
  const inspected = inspectUptoAuthorization(body.authorization, context.contract);
  if (!inspected.ok) return fail(inspected.rejection, inspected.payer);
  const { authorization } = inspected;
  const { payer, terms } = authorization;

  // Rule 5: the terms bind exactly these requirements.
  if (terms.recipient !== requirements.payTo) {
    return fail(
      reject(
        "invalid_upto_stellar_payload_wrong_recipient",
        `The authorization pays ${terms.recipient}; payTo is ${requirements.payTo}.`,
      ),
      payer,
    );
  }
  if (terms.token !== requirements.asset) {
    return fail(
      reject(
        "invalid_upto_stellar_payload_wrong_asset",
        `The authorization is for token ${terms.token}; the asset is ${requirements.asset}.`,
      ),
      payer,
    );
  }
  if (terms.facilitator !== context.authority) {
    return fail(
      reject(
        "invalid_upto_stellar_payload_facilitator_mismatch",
        `The authorization names ${terms.facilitator} as settlement authority; this facilitator's is ${context.authority}.`,
      ),
      payer,
    );
  }
  if (terms.maxAmount !== maxAmount) {
    return fail(
      reject(
        "invalid_upto_stellar_payload_wrong_amount",
        `The authorized cap is ${terms.maxAmount}; the accepted amount is ${maxAmount}.`,
      ),
      payer,
    );
  }
  if (terms.expirationLedger !== authorization.signatureExpirationLedger) {
    return fail(
      reject(
        "invalid_upto_stellar_payload_expiration_mismatch",
        `expiration_ledger ${terms.expirationLedger} differs from signatureExpirationLedger ${authorization.signatureExpirationLedger}.`,
      ),
      payer,
    );
  }
  if (terms.validAfterLedger > context.currentLedger + 1) {
    return fail(
      reject(
        "invalid_upto_stellar_payload_not_yet_valid",
        `The terms are valid from ledger ${terms.validAfterLedger}; the current ledger is ${context.currentLedger}.`,
      ),
      payer,
    );
  }

  // Rule 6: the tree is exactly settle(terms) → approve(payer, contract, cap, expiration).
  if (!authorization.treeValid)
    return fail(reject("invalid_upto_stellar_payload_invalid_authorization_tree"), payer);

  // Rule 7: the expiration window.
  const expiration = terms.expirationLedger;
  if (expiration < context.currentLedger) {
    return fail(
      reject(
        "invalid_upto_stellar_signature_expired",
        `The authorization expired at ledger ${expiration}; the current ledger is ${context.currentLedger}.`,
      ),
      payer,
    );
  }
  if (expiration < context.currentLedger + context.expirationMarginLedgers) {
    return fail(
      reject(
        "invalid_upto_stellar_signature_expiration_too_soon",
        `The authorization expires at ledger ${expiration}, fewer than ${context.expirationMarginLedgers} ledgers after the current ledger ${context.currentLedger}.`,
      ),
      payer,
    );
  }
  // The client may have estimated a shorter ledger time than this facilitator (the estimate is rounded
  // up to whole seconds, so 5 against 6 on a network closing at about 5 s), and so reached further.
  const latestAllowed =
    context.currentLedger +
    ledgersFor(requirements.maxTimeoutSeconds, Math.min(context.ledgerSeconds, NOMINAL_LEDGER_SECONDS)) +
    EXPIRATION_LEDGER_TOLERANCE;
  if (expiration > latestAllowed) {
    return fail(
      reject(
        "invalid_upto_stellar_signature_expiration_too_far",
        `The authorization expires at ledger ${expiration}; maxTimeoutSeconds allows at most ledger ${latestAllowed}.`,
      ),
      payer,
    );
  }

  // Rule 8: the payer.
  if (context.facilitatorAddresses.has(payer)) {
    return fail(reject("invalid_upto_stellar_payload_facilitator_is_payer"), payer);
  }
  if (payer === context.contract) {
    return fail(
      reject("invalid_upto_stellar_payload_facilitator_is_payer", "The payer is the settlement contract."),
      payer,
    );
  }
  if (payer === requirements.payTo) return fail(reject("invalid_upto_stellar_payload_self_payment"), payer);

  // Rule 9: delegated signer entries of a smart-account payer.
  const signers = inspectSignerAuthorizations(body.signerAuthorizations, payer, context.facilitatorAddresses);
  if (!signers.ok) return fail(signers.rejection, payer);

  return {
    ok: true,
    payment: {
      authorization,
      signerAuthorizations: signers.entries,
      payer,
      maxAmount,
      amount: context.phase === "verify" ? maxAmount : amount,
    },
  };
}

/**
 * Rule 2. Returns the first violated requirement, or `undefined`.
 *
 * @param accepted - The requirements the payer accepted
 * @param requirements - The requirements of this request
 * @param context - The facilitator's policy
 * @returns The refusal, or `undefined`
 */
function checkRequirements(
  accepted: PaymentRequirements,
  requirements: PaymentRequirements,
  context: UptoRuleContext,
): UptoRejection | undefined {
  const { asset, payTo, maxTimeoutSeconds, network } = requirements;
  const extra = (requirements.extra as Record<string, unknown> | undefined) ?? {};

  if (!isContractAddress(asset)) {
    return reject(
      "invalid_upto_stellar_requirements_asset_not_accepted",
      "asset must be the C… address of a SEP-41 token contract.",
    );
  }
  if (context.isAssetAccepted !== undefined && !context.isAssetAccepted(asset, network)) {
    return reject("invalid_upto_stellar_requirements_asset_not_accepted");
  }
  if (isMuxedAddress(payTo)) return reject("invalid_upto_stellar_payload_unsupported_recipient");
  if (!isAccountOrContract(payTo)) return reject("invalid_upto_stellar_requirements_invalid_pay_to");
  if (context.facilitatorAddresses.has(payTo) || payTo === context.contract || payTo === asset) {
    return reject(
      "invalid_upto_stellar_requirements_invalid_pay_to",
      "payTo is a facilitator account, the settlement contract or the asset itself.",
    );
  }
  const minTimeoutSeconds =
    context.minTimeoutSeconds ?? minTimeoutSecondsFor(context.expirationMarginLedgers);
  if (
    !Number.isInteger(maxTimeoutSeconds) ||
    maxTimeoutSeconds < minTimeoutSeconds ||
    maxTimeoutSeconds <= 0 ||
    maxTimeoutSeconds > context.maxTimeoutSeconds
  ) {
    return reject(
      "invalid_upto_stellar_requirements_timeout_out_of_range",
      `maxTimeoutSeconds must be an integer from ${minTimeoutSeconds} to ${context.maxTimeoutSeconds}.`,
    );
  }
  if (extra["areFeesSponsored"] !== true)
    return reject("invalid_upto_stellar_requirements_fees_not_sponsored");
  if (extra["facilitatorAddress"] !== context.authority) {
    return reject(
      "invalid_upto_stellar_requirements_facilitator_mismatch",
      `extra.facilitatorAddress must be ${context.authority}.`,
    );
  }

  if (
    accepted.network !== network ||
    accepted.asset !== asset ||
    accepted.payTo !== payTo ||
    accepted.maxTimeoutSeconds !== maxTimeoutSeconds ||
    !isRecord(accepted.extra) ||
    !isSubsetOf(extra, accepted.extra)
  ) {
    return reject("invalid_upto_stellar_payload_accepted_mismatch");
  }

  const cap = parseAtomicAmount(accepted.amount);
  if (cap === undefined || cap === 0n) {
    return reject(
      "invalid_upto_stellar_requirements_invalid_amount",
      "The accepted amount (the cap) must be a positive integer string within i128.",
    );
  }
  const amount = parseAtomicAmount(requirements.amount);
  if (amount === undefined) return reject("invalid_upto_stellar_requirements_invalid_amount");
  if (context.phase === "verify") {
    if (amount !== cap) {
      return reject(
        "invalid_upto_stellar_payload_accepted_mismatch",
        `At verification the required amount (${amount}) must equal the accepted cap (${cap}).`,
      );
    }
  } else if (amount > cap) {
    return reject(
      "invalid_upto_stellar_payload_settlement_exceeds_amount",
      `The settlement amount ${amount} exceeds the authorized cap ${cap}.`,
    );
  }
  return undefined;
}
