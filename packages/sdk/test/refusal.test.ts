import { describe, expect, it } from "vitest";
import { exactStellarCodes, uptoStellarCodes } from "@rail402.dev/stellar";
import { uptoCodes } from "@rail402.dev/upto";
import {
  agentCodes,
  defaultPaid,
  paymentError,
  refusalOutcome,
  refusalOutcomes,
  upstreamCodeOf,
  type AgentCode,
} from "@rail402.dev/sdk";

/** A payment the seller refused, passing on the facilitator's `code`. */
const refused = (code?: unknown) =>
  paymentError("payment_rejected", {
    details: { upstream: { reason: "settlement failed", ...(code === undefined ? {} : { code }) } },
  });

/**
 * Money may have moved: a new payment could pay twice, so never retryable and the money is unknown.
 * Upstream facilitators answer any send that was not PENDING, DUPLICATE included, with
 * `…_transaction_submission_failed`, and a seller-relayed code cannot prove the bytes will not land.
 */
const MAY_HAVE_PAID = [
  "settlement_pending",
  "settle_exact_stellar_transaction_failed",
  "settle_exact_stellar_transaction_submission_failed",
  "settle_upto_stellar_transaction_submission_failed",
  "settle_exact_stellar_settlement_in_progress",
  "settle_upto_stellar_settlement_in_progress",
  "settle_exact_stellar_idempotency_conflict",
  "settle_upto_stellar_idempotency_conflict",
  "settle_upto_stellar_settled_elsewhere",
  // An exact transaction that failed on chain for a cause that does not end the authorization: the
  // failure rolls back, nonce included, and the same payment can still land until it expires.
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
];

describe("a refused payment's retryable and paid", () => {
  it.each(MAY_HAVE_PAID)("reports %s as paid unknown and not retryable", (code) => {
    expect(refused(code)).toMatchObject({ code: "payment_rejected", retryable: false, paid: "unknown" });
  });

  it.each([
    ["settle_exact_stellar_channel_unavailable", true],
    ["settle_upto_stellar_channel_unavailable", true],
    ["settle_exact_stellar_payer_rate_limited", true],
    ["settle_upto_stellar_caller_budget_exhausted", true],
    ["settle_upto_stellar_authority_unavailable", true],
    ["unexpected_settle_error", true],
    ["invalid_exact_stellar_payload_missing_payer_signature", false],
    ["invalid_exact_stellar_payload_wrong_amount", false],
    ["invalid_exact_stellar_payload_nonce_already_used", false],
    ["invalid_exact_stellar_signature_expired", false],
    ["invalid_exact_stellar_signature_expiration_too_far", false],
    ["settle_upto_stellar_transaction_failed", false],
    ["settle_exact_stellar_transaction_expired", false],
    ["settle_upto_stellar_transaction_expired", false],
    ["unsupported_scheme", false],
  ] as const)("keeps the facilitator's verdict on %s: retryable %s, not settled", (code, retryable) => {
    expect(refused(code)).toMatchObject({ retryable, paid: "not_settled" });
  });

  it.each([
    ["no code", undefined],
    ["a code no facilitator table has", "something_the_seller_made_up"],
    ["a service code that is not a settlement answer", "bad_request"],
    ["a code that is not a string", 42],
  ])("keeps the SDK's own verdict for %s", (_name, code) => {
    expect(refused(code)).toMatchObject({ retryable: false, paid: "not_settled" });
  });

  it("covers every facilitator code of exact and upto, and only those", () => {
    const codes = new Set([
      ...Object.keys(exactStellarCodes),
      ...Object.keys(uptoCodes),
      ...Object.keys(uptoStellarCodes),
    ]);
    expect(Object.keys(refusalOutcomes).sort()).toEqual([...codes].sort());
    for (const code of MAY_HAVE_PAID) expect(codes.has(code), code).toBe(true);
  });

  it("applies the table to every code it holds, and never invites a second payment", () => {
    for (const [code, outcome] of Object.entries(refusalOutcomes)) {
      const error = refused(code);
      expect({ retryable: error.retryable, paid: error.paid }, code).toEqual({
        retryable: outcome.retryable,
        paid: outcome.mayHavePaid ? "unknown" : "not_settled",
      });
      if (outcome.mayHavePaid) expect(error.retryable, code).toBe(false);
    }
    expect(
      Object.entries(refusalOutcomes)
        .filter(([, o]) => o.mayHavePaid)
        .map(([code]) => code)
        .sort(),
    ).toEqual([...MAY_HAVE_PAID].sort());
  });

  it("never reads the seller's code as more retryable than the facilitator's table", () => {
    const facilitator: Record<string, { retryable: boolean }> = {
      ...exactStellarCodes,
      ...uptoCodes,
      ...uptoStellarCodes,
    };
    for (const [code, spec] of Object.entries(facilitator)) {
      if (!spec.retryable) expect(refused(code).retryable, code).toBe(false);
    }
  });

  it("keeps an explicit paid unless money may have moved", () => {
    const explicit = (code: string) =>
      paymentError("payment_rejected", { paid: "unknown", details: { upstream: { code } } }).paid;
    expect(explicit("settle_exact_stellar_channel_unavailable")).toBe("unknown");
    expect(refusalOutcome("settlement_pending", { retryable: true, paid: "not_settled" })).toEqual({
      retryable: false,
      paid: "unknown",
    });
  });

  it("reads the facilitator's code only from details.upstream.code", () => {
    expect(upstreamCodeOf({ upstream: { code: "settlement_pending" } })).toBe("settlement_pending");
    expect(upstreamCodeOf({ code: "settlement_pending" })).toBeUndefined();
    expect(upstreamCodeOf({ upstream: "settlement_pending" })).toBeUndefined();
    expect(upstreamCodeOf({ upstream: null })).toBeUndefined();
    expect(upstreamCodeOf(undefined)).toBeUndefined();
  });

  it("leaves every other code at its registered retryable and default paid", () => {
    for (const [code, spec] of Object.entries(agentCodes)) {
      // An upstream code on another error never changes it: only a refused payment reads one.
      const error = paymentError(code as AgentCode, {
        details: { upstream: { code: "settlement_pending" } },
      });
      expect({ retryable: error.retryable, paid: error.paid }, code).toEqual(
        code === "payment_rejected"
          ? { retryable: false, paid: "unknown" }
          : { retryable: spec.retryable, paid: defaultPaid[code as AgentCode] },
      );
    }
  });
});
