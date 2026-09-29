import type { SettleResponse, VerifyResponse } from "@x402/core/types";
import { exactStellarCodes, isExactStellarCode, type ExactStellarCode } from "@rail402.dev/stellar";

/**
 * Wire builders. Every rejection carries a registered code in `invalidReason` / `errorReason` and a
 * non-empty human-readable reason in `invalidMessage` / `errorMessage`.
 */

export function reasonFor(code: string, reason?: string): string {
  if (reason !== undefined && reason.trim() !== "") return reason;
  return isExactStellarCode(code) ? exactStellarCodes[code].reason : `Rejected with reason code ${code}.`;
}

export function verifyRejected(code: ExactStellarCode, reason?: string, payer?: string): VerifyResponse {
  return {
    isValid: false,
    invalidReason: code,
    invalidMessage: reasonFor(code, reason),
    ...(payer === undefined ? {} : { payer }),
  };
}

export function verifyAccepted(payer: string): VerifyResponse {
  return { isValid: true, payer };
}

export interface SettleFailure {
  readonly code: ExactStellarCode;
  readonly reason?: string | undefined;
  readonly network: string;
  readonly payer?: string | undefined;
  /** The broadcast transaction hash, when one exists. Required for `settlement_pending`. */
  readonly transaction?: string | undefined;
}

export function settleFailed(failure: SettleFailure): SettleResponse {
  return {
    success: false,
    errorReason: failure.code,
    errorMessage: reasonFor(failure.code, failure.reason),
    transaction: failure.transaction ?? "",
    network: failure.network as SettleResponse["network"],
    ...(failure.payer === undefined ? {} : { payer: failure.payer }),
  };
}

export function settleSucceeded(network: string, transaction: string, payer: string): SettleResponse {
  return { success: true, transaction, network: network as SettleResponse["network"], payer };
}

/** Ensures a response from upstream code carries a registered code and a non-empty reason. */
export function normalizeVerify(response: VerifyResponse): VerifyResponse {
  if (response.isValid) return response;
  const code = response.invalidReason ?? "verification_failed";
  return { ...response, invalidReason: code, invalidMessage: reasonFor(code, response.invalidMessage) };
}
