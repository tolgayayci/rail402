import { exactStellarCodes, uptoStellarCodes } from "@rail402.dev/stellar";
import { uptoCodes } from "@rail402.dev/upto";
import type { Paid } from "./codes.ts";

/**
 * What a refused payment means for the caller, from the facilitator's code the seller passed on. The
 * SDK's `PaymentError`, the rail402-mcp tools and the rail402 command line all read this one table.
 *
 * `retryable` answers whether making the same call again can succeed. A paying call signs a new
 * payment every time it runs, so a refusal after which the refused payment may still settle, or may
 * already have moved funds, is never retryable and reports `paid: "unknown"`: a new payment could
 * pay twice. Every other code keeps the facilitator's own verdict (a busy channel or a rate limit is
 * retryable, a bad signature or a missing trustline is not). The code is the seller's text, so it is
 * never read as more retryable than the facilitator's table makes it.
 *
 * The buyer only ever sees a refusal as the seller relays it, never the facilitator's own answer, so
 * nothing here can prove that a submission was not accepted.
 */
export interface RefusalOutcome {
  readonly retryable: boolean;
  /** Money may have moved: the error reports `paid: "unknown"` instead of `not_settled`. */
  readonly mayHavePaid: boolean;
}

/** Every code a Stellar facilitator answers a settlement with, for `exact` and `upto`. */
const FACILITATOR_CODES: Readonly<Record<string, { readonly retryable: boolean }>> = {
  ...exactStellarCodes,
  ...uptoCodes,
  ...uptoStellarCodes,
};

/**
 * Codes after which the refused payment may still settle or may already have moved funds:
 * - `settlement_pending`, and an `exact` transaction a facilitator could not confirm in time
 *   (upstream @x402/stellar answers a confirmation timeout with `…_transaction_failed`);
 * - `…_transaction_submission_failed`, which upstream @x402/stellar answers for any send that was not
 *   `PENDING`, `DUPLICATE` included: the same bytes may already be queued, and a seller-relayed code
 *   cannot prove otherwise;
 * - another request is settling the same authorization, it was already submitted with other terms,
 *   or another transaction settled it first;
 * - an `exact` transaction that failed on chain for a cause that does not end the payer's
 *   authorization (a balance spent, a trustline removed or deauthorized, an account or a smart
 *   account that refused it for now, a token error, a failure without diagnostics): the network rolls
 *   the failure back, nonce included, so anyone who holds the payment can still land it until the
 *   authorization expires. A consumed nonce or an expired authorization ends it.
 */
const MAY_HAVE_PAID: ReadonlySet<string> = new Set([
  "settlement_pending",
  "settle_exact_stellar_transaction_failed",
  "settle_exact_stellar_transaction_submission_failed",
  "settle_upto_stellar_transaction_submission_failed",
  "settle_exact_stellar_settlement_in_progress",
  "settle_upto_stellar_settlement_in_progress",
  "settle_exact_stellar_idempotency_conflict",
  "settle_upto_stellar_idempotency_conflict",
  "settle_upto_stellar_settled_elsewhere",
  "insufficient_funds",
  "invalid_transaction_state",
  "invalid_exact_stellar_payload_invalid_signature",
  "invalid_exact_stellar_payload_smart_account_rejected",
  "invalid_exact_stellar_payload_account_missing",
  "invalid_exact_stellar_payload_payer_trustline_missing",
  "invalid_exact_stellar_payload_recipient_trustline_missing",
  "invalid_exact_stellar_payload_trustline_not_authorized",
  "invalid_exact_stellar_payload_token_rejected",
  "invalid_exact_stellar_payload_unauthorized_invocation",
]);

/** The outcome of every facilitator code the SDK knows, in one frozen table. */
export const refusalOutcomes: Readonly<Record<string, RefusalOutcome>> = Object.freeze(
  Object.fromEntries(
    Object.entries(FACILITATOR_CODES).map(([code, spec]) => {
      const mayHavePaid = MAY_HAVE_PAID.has(code);
      return [code, Object.freeze({ retryable: !mayHavePaid && spec.retryable, mayHavePaid })];
    }),
  ),
);

/** The facilitator's code a seller passed on with its refusal (`details.upstream.code`), when it named one. */
export function upstreamCodeOf(details: Readonly<Record<string, unknown>> | undefined): string | undefined {
  const upstream = details?.["upstream"];
  if (upstream === null || typeof upstream !== "object") return undefined;
  const code = (upstream as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * `retryable` and `paid` of a refused payment with the facilitator's `code`. A code the table does
 * not know, or none, keeps `fallback`.
 */
export function refusalOutcome(
  code: string | undefined,
  fallback: { readonly retryable: boolean; readonly paid: Paid },
): { readonly retryable: boolean; readonly paid: Paid } {
  if (code === undefined || !Object.hasOwn(refusalOutcomes, code)) return fallback;
  const outcome = refusalOutcomes[code] as RefusalOutcome;
  if (outcome.mayHavePaid) return { retryable: false, paid: "unknown" };
  return { retryable: outcome.retryable, paid: fallback.paid };
}
