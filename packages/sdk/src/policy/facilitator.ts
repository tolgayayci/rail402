import type { ResolvedPolicy } from "./policy.ts";

/**
 * Why a settlement authority is refused, or undefined when it may settle: it must be neither the
 * payer nor the recipient and, when the policy lists allowed authorities, it must be one of them.
 */
export function facilitatorRefusal(
  policy: ResolvedPolicy,
  facilitator: string,
  recipient: string,
  payer: string | undefined,
): string | undefined {
  if (facilitator === payer) return "The payer cannot be its own payment's settlement authority.";
  if (facilitator === recipient) {
    return "The recipient names itself as the settlement authority, so no facilitator would bound the charge.";
  }
  if (policy.uptoFacilitators !== undefined && !policy.uptoFacilitators.has(facilitator)) {
    return `The settlement authority ${facilitator} is not among the spending policy's allowed facilitators.`;
  }
  return undefined;
}
