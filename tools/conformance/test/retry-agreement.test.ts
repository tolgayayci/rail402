/**
 * The SDK's PaymentError, the rail402-mcp tool error and the rail402 command line's error object say
 * the same thing about every failure: whether to retry, and whether money may have moved. A refused
 * payment is checked with every code in the registry snapshot as the facilitator's code, so a code
 * added to the registry is classified before it ships.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EgressError, egressCodes, type EgressCode } from "@rail402.dev/safe-fetch";
import {
  agentCodes,
  paymentError,
  refusalOutcomes,
  type AgentCode,
  type PaymentError,
} from "@rail402.dev/sdk";
import { errorFrom } from "@rail402.dev/mcp";
import { EXIT, exitStatusFor, failureFrom } from "@rail402.dev/cli";
import { REPO_ROOT } from "../src/evidence.ts";

const snapshot = JSON.parse(
  readFileSync(join(REPO_ROOT, "apps/rail402/test/codes.snapshot.json"), "utf8"),
) as { codes: Record<string, unknown> };
const registry = Object.keys(snapshot.codes).sort();

/** What each surface reports for `error`. */
function surfaces(error: PaymentError | EgressError) {
  const mcp = errorFrom(error, true);
  const cli = failureFrom(error, true);
  return {
    sdk: error instanceof EgressError ? undefined : { retryable: error.retryable, paid: error.paid },
    mcp: { retryable: mcp.retryable, paid: mcp.paid },
    cli: { retryable: cli.retryable, paid: cli.paid },
    exit: exitStatusFor(cli),
  };
}

const refused = (code: string | undefined) =>
  paymentError("payment_rejected", {
    details: { upstream: { reason: "settlement failed", ...(code === undefined ? {} : { code }) } },
  });

describe("retryable and paid across the SDK, rail402-mcp and the CLI", () => {
  it("holds only registered codes in the refusal table", () => {
    expect(Object.keys(refusalOutcomes).filter((code) => !registry.includes(code))).toEqual([]);
  });

  it("agrees on a refused payment for every registered code, and none", () => {
    for (const code of [...registry, undefined]) {
      const seen = surfaces(refused(code));
      expect(seen.mcp, String(code)).toEqual(seen.sdk);
      expect(seen.cli, String(code)).toEqual(seen.sdk);
      // Money that may have moved exits 5 and is never retryable; a plain refusal exits 4.
      if (seen.sdk?.paid === "unknown") {
        expect(seen.sdk.retryable, String(code)).toBe(false);
        expect(seen.exit, String(code)).toBe(EXIT.paid);
      } else {
        expect(seen.sdk?.paid, String(code)).toBe("not_settled");
        expect(seen.exit, String(code)).toBe(EXIT.rejected);
      }
    }
  });

  it("classifies the registry's codes as recorded", () => {
    const outcomes = registry.map((code) => ({ code, ...surfaces(refused(code)).sdk }));
    expect({
      paidUnknown: outcomes.filter((o) => o.paid === "unknown").map((o) => o.code),
      retryable: outcomes.filter((o) => o.retryable === true).map((o) => o.code),
    }).toMatchInlineSnapshot(`
      {
        "paidUnknown": [
          "insufficient_funds",
          "invalid_exact_stellar_payload_account_missing",
          "invalid_exact_stellar_payload_invalid_signature",
          "invalid_exact_stellar_payload_payer_trustline_missing",
          "invalid_exact_stellar_payload_recipient_trustline_missing",
          "invalid_exact_stellar_payload_smart_account_rejected",
          "invalid_exact_stellar_payload_token_rejected",
          "invalid_exact_stellar_payload_trustline_not_authorized",
          "invalid_exact_stellar_payload_unauthorized_invocation",
          "invalid_transaction_state",
          "settle_exact_stellar_idempotency_conflict",
          "settle_exact_stellar_settlement_in_progress",
          "settle_exact_stellar_transaction_failed",
          "settle_exact_stellar_transaction_submission_failed",
          "settle_upto_stellar_idempotency_conflict",
          "settle_upto_stellar_settled_elsewhere",
          "settle_upto_stellar_settlement_in_progress",
          "settle_upto_stellar_transaction_submission_failed",
          "settlement_pending",
        ],
        "retryable": [
          "invalid_exact_stellar_payload_archived_state",
          "invalid_exact_stellar_payload_fee_exceeds_maximum",
          "invalid_upto_stellar_payload_account_missing",
          "invalid_upto_stellar_payload_archived_state",
          "invalid_upto_stellar_payload_fee_exceeds_maximum",
          "invalid_upto_stellar_payload_not_yet_valid",
          "invalid_upto_stellar_payload_payer_trustline_missing",
          "invalid_upto_stellar_payload_recipient_trustline_missing",
          "invalid_upto_stellar_payload_trustline_not_authorized",
          "invalid_upto_stellar_settlement_contract_archived",
          "settle_exact_stellar_caller_budget_exhausted",
          "settle_exact_stellar_channel_unavailable",
          "settle_exact_stellar_fee_bump_signing_failed",
          "settle_exact_stellar_payer_cooldown",
          "settle_exact_stellar_payer_rate_limited",
          "settle_exact_stellar_payto_rate_limited",
          "settle_exact_stellar_signer_selection_failed",
          "settle_exact_stellar_sponsor_unavailable",
          "settle_exact_stellar_transaction_signing_failed",
          "settle_upto_stellar_authority_unavailable",
          "settle_upto_stellar_caller_budget_exhausted",
          "settle_upto_stellar_channel_unavailable",
          "settle_upto_stellar_fee_bump_signing_failed",
          "settle_upto_stellar_payer_cooldown",
          "settle_upto_stellar_payer_rate_limited",
          "settle_upto_stellar_payto_rate_limited",
          "settle_upto_stellar_signer_selection_failed",
          "settle_upto_stellar_sponsor_unavailable",
          "settle_upto_stellar_transaction_signing_failed",
          "unexpected_settle_error",
          "unexpected_verify_error",
        ],
      }
    `);
  });

  it("agrees on every SDK code and every egress error", () => {
    for (const code of Object.keys(agentCodes)) {
      const seen = surfaces(paymentError(code as AgentCode));
      expect(seen.mcp, code).toEqual(seen.sdk);
      expect(seen.cli, code).toEqual(seen.sdk);
    }
    for (const [code, spec] of Object.entries(egressCodes)) {
      const seen = surfaces(new EgressError(code as EgressCode, "connect"));
      expect(seen.mcp, code).toEqual({ retryable: spec.retryable, paid: "none" });
      expect(seen.cli, code).toEqual(seen.mcp);
    }
  });
});
