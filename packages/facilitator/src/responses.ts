import type { SettleResponse, VerifyResponse } from "@x402/core/types";
import { reportCode } from "@rail402.dev/errors";
import {
  exactStellarCodes,
  isExactStellarCode,
  isUptoStellarCode,
  uptoStellarCodes,
  type ExactStellarCode,
  type UptoResponseCode,
} from "@rail402.dev/stellar";
import type { SettledBy } from "./ledger.ts";

/**
 * Wire builders. Every rejection carries a registered code in `invalidReason` / `errorReason` and a
 * non-empty human-readable reason in `invalidMessage` / `errorMessage`.
 */

/** Every code a verification or settlement answers with, whatever the scheme. */
export type FacilitatorCode = ExactStellarCode | UptoResponseCode;

/** Whether `code` is registered for verification and settlement responses. */
export function isFacilitatorCode(code: unknown): code is FacilitatorCode {
  return isExactStellarCode(code) || isUptoStellarCode(code);
}

export function reasonFor(code: string, reason?: string): string {
  if (reason !== undefined && reason.trim() !== "") return reason;
  if (isExactStellarCode(code)) return exactStellarCodes[code].reason;
  if (isUptoStellarCode(code)) return uptoStellarCodes[code].reason;
  return `Rejected with reason code ${code}.`;
}

export function verifyRejected(code: FacilitatorCode, reason?: string, payer?: string): VerifyResponse {
  reportCode(code);
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
  readonly code: FacilitatorCode;
  readonly reason?: string | undefined;
  readonly network: string;
  readonly payer?: string | undefined;
  /** The broadcast transaction hash, when one exists. Required for `settlement_pending`. */
  readonly transaction?: string | undefined;
  /** The amount the request asked to settle, in base units. Always present on `upto` responses. */
  readonly amount?: string | undefined;
}

export function settleFailed(failure: SettleFailure): SettleResponse {
  reportCode(failure.code);
  return {
    success: false,
    errorReason: failure.code,
    errorMessage: reasonFor(failure.code, failure.reason),
    transaction: failure.transaction ?? "",
    network: failure.network as SettleResponse["network"],
    ...(failure.payer === undefined ? {} : { payer: failure.payer }),
    ...(failure.amount === undefined ? {} : { amount: failure.amount }),
  };
}

export function settleSucceeded(
  network: string,
  transaction: string,
  payer: string,
  amount?: string,
): SettleResponse {
  return {
    success: true,
    transaction,
    network: network as SettleResponse["network"],
    payer,
    ...(amount === undefined ? {} : { amount }),
  };
}

/** Ensures a response from upstream code carries a registered code and a non-empty reason. */
export function normalizeVerify(response: VerifyResponse): VerifyResponse {
  if (response.isValid) return response;
  const code = response.invalidReason ?? "verification_failed";
  reportCode(code);
  return { ...response, invalidReason: code, invalidMessage: reasonFor(code, response.invalidMessage) };
}

/** The key under which Rail402 reports on a settlement in the response's `extensionResponses`. */
export const RAIL402_EXTENSION = "rail402";

/** Marks a settle response that was answered from an existing settlement instead of starting one. */
export interface SettlementRepeat {
  readonly repeat: true;
  readonly settledBy: SettledBy;
}

/**
 * The recorded response with the repeat marker in its server-internal `extensionResponses`. The
 * HTTP service moves `extensionResponses` into the `EXTENSION-RESPONSES` header, so the marker reaches
 * the resource server and never the buyer, and the body stays the recorded response.
 */
export function markRepeat(response: SettleResponse, settledBy: SettledBy): SettleResponse {
  const settlement: SettlementRepeat = { repeat: true, settledBy };
  return {
    ...response,
    extensionResponses: { ...response.extensionResponses, [RAIL402_EXTENSION]: { settlement } },
  };
}

/** The repeat marker of a settle response, if it has one. */
export function repeatOf(response: SettleResponse): SettlementRepeat | undefined {
  const rail402 = response.extensionResponses?.[RAIL402_EXTENSION] as
    { settlement?: Partial<SettlementRepeat> } | undefined;
  const settlement = rail402?.settlement;
  if (settlement?.repeat !== true) return undefined;
  return { repeat: true, settledBy: settlement.settledBy === "third_party" ? "third_party" : "rail402" };
}
