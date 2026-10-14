import { defineCodes, errorFactory } from "@rail402.dev/errors";
import { uptoStellarCodes as mechanismCodes, type UptoStandardCode } from "@rail402.dev/upto";

/**
 * Every reason code specific to an x402 `upto` Stellar verification or settlement.
 *
 * The codes the `upto` mechanism (`@rail402.dev/upto`) returns keep their spelling and meaning; Rail402
 * adds the codes of its settlement engine. The x402 standard codes an `upto` payment can also return
 * (`invalid_network`, `insufficient_funds`, `settlement_pending`, …) are shared with `exact` and
 * registered once, in `exactStellarCodes`.
 *
 * `status` applies only when a code is returned as a transport error. Verification and settlement
 * outcomes are always HTTP 200 with `isValid: false` / `success: false`, as the specification requires.
 */
export const uptoStellarCodes = defineCodes({
  ...mechanismCodes,
  settle_upto_stellar_settled_elsewhere: {
    status: 409,
    retryable: false,
    reason:
      "Another transaction settled this authorization first, for a different amount; the returned transaction is the one that moved the funds.",
  },
});

export type UptoStellarCode = keyof typeof uptoStellarCodes;

/** Every code an `upto` response can carry: the shared x402 standard codes and the upto-specific ones. */
export type UptoResponseCode = UptoStandardCode | UptoStellarCode;

export const uptoStellarError = errorFactory(uptoStellarCodes);

export function isUptoStellarCode(value: unknown): value is UptoStellarCode {
  return typeof value === "string" && Object.hasOwn(uptoStellarCodes, value);
}
