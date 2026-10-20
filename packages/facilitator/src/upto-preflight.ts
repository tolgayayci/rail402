import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { UptoResponseCode } from "@rail402.dev/stellar";
import { parseAtomicAmount } from "@rail402.dev/upto";
import { checkUptoPayment, type CheckedUptoPayment, type UptoPhase } from "@rail402.dev/upto/facilitator";
import { uptoTimeoutSeconds, type NetworkPolicy, type UptoPolicy } from "./policy.ts";

export interface UptoPreflightContext {
  /** `verify` checks the payment for its cap; `settle` for the amount being settled. */
  readonly phase: UptoPhase;
  readonly policy: NetworkPolicy;
  readonly upto: UptoPolicy;
  /** The settlement authority, `extra.facilitatorAddress`. */
  readonly authority: string;
  /** Every account the facilitator signs or pays with: sponsor, channels and the authority. */
  readonly facilitatorAddresses: ReadonlySet<string>;
  /** Latest closed ledger, for the expiration window and `valid_after_ledger`. */
  readonly currentLedger: number;
  /** Seconds per ledger, for the upper bound of the expiration window. */
  readonly ledgerSeconds: number;
}

export type UptoPreflight =
  | { readonly ok: true; readonly payment: CheckedUptoPayment }
  | {
      readonly ok: false;
      readonly code: UptoResponseCode;
      readonly reason: string;
      readonly payer?: string | undefined;
    };

/**
 * Checks everything about an `upto` payment that can be decided without simulating: every static
 * rule of the scheme (the envelope, the requirements and what the payer accepted, the entry, its root
 * and terms, the authorization tree, the expiration window, the payer and any delegated signers), then
 * the operator's policy: the accepted assets, the `maxTimeoutSeconds` range and each asset's bounds on
 * the cap. It runs on every verify and settle before the mechanism simulates, so a payment that cannot
 * settle is refused before any RPC work and with a specific code.
 */
export function uptoPreflight(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  context: UptoPreflightContext,
): UptoPreflight {
  const { policy } = context;
  const policyViolation = checkPolicy(payload, requirements, policy);
  if (policyViolation !== undefined) return policyViolation;

  const timeoutSeconds = uptoTimeoutSeconds(policy);
  const checked = checkUptoPayment(payload, requirements, {
    phase: context.phase,
    contract: context.upto.contract,
    authority: context.authority,
    facilitatorAddresses: context.facilitatorAddresses,
    currentLedger: context.currentLedger,
    ledgerSeconds: context.ledgerSeconds,
    maxTimeoutSeconds: timeoutSeconds.max,
    minTimeoutSeconds: timeoutSeconds.min,
    expirationMarginLedgers: policy.expirationMarginLedgers,
    isAssetAccepted: (asset) => policy.assets.has(asset),
  });
  if (!checked.ok) return reject(checked.rejection.code, checked.rejection.reason, checked.payer);
  return { ok: true, payment: checked.payment };
}

/**
 * The operator's limits beyond the scheme's rules, checked with the requirements (rule 2) once the
 * request is an x402 v2 `upto` request: the served network and the accepted asset's bounds on the cap.
 * The `maxTimeoutSeconds` range is the scheme's rule 2, given the policy's bounds. Anything malformed
 * is left to the scheme's rules.
 */
function checkPolicy(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  policy: NetworkPolicy,
): UptoPreflight | undefined {
  // A malformed `accepted` block is the scheme's rules' to name.
  const accepted = payload.accepted as Partial<PaymentRequirements> | null;
  if (payload.x402Version !== 2 || requirements.scheme !== "upto" || accepted?.scheme !== "upto") {
    return undefined;
  }
  if (requirements.network !== policy.network) {
    return reject("invalid_network", `This facilitator settles upto payments on ${policy.network} here.`);
  }
  const asset = policy.assets.get(requirements.asset);
  const cap = parseAtomicAmount(payload.accepted.amount);
  if (
    asset !== undefined &&
    cap !== undefined &&
    cap > 0n &&
    (cap < asset.minAmount || cap > asset.maxAmount)
  ) {
    return reject(
      "invalid_upto_stellar_requirements_amount_out_of_range",
      `The cap must be between ${asset.minAmount} and ${asset.maxAmount} base units of ${asset.symbol}.`,
    );
  }
  return undefined;
}

function reject(code: UptoResponseCode, reason: string, payer?: string): UptoPreflight {
  return { ok: false, code, reason, ...(payer === undefined ? {} : { payer }) };
}
