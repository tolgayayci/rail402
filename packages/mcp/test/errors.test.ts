import { describe, expect, it } from "vitest";
import { EgressError, egressCodes, type EgressCode } from "@rail402.dev/safe-fetch";
import { agentCodes, defaultPaid, paymentError, refusalOutcomes, type AgentCode } from "@rail402.dev/sdk";
import {
  createTools,
  errorFrom,
  rpcCodes,
  rpcErrorData,
  toolCodes,
  type RpcErrorCode,
} from "@rail402.dev/mcp";
import { expectConforms, fakeBuyer } from "./helpers.ts";

/** A payment the seller refused, passing on the facilitator's `code`. */
const refused = (code: string) =>
  paymentError("payment_rejected", { details: { upstream: { reason: "settlement failed", code } } });

describe("a tool's error for a refused payment", () => {
  it.each([
    ["settlement_pending", false, "unknown"],
    ["settle_exact_stellar_transaction_failed", false, "unknown"],
    ["settle_exact_stellar_settlement_in_progress", false, "unknown"],
    ["settle_upto_stellar_settlement_in_progress", false, "unknown"],
    ["settle_exact_stellar_idempotency_conflict", false, "unknown"],
    ["settle_upto_stellar_idempotency_conflict", false, "unknown"],
    ["settle_upto_stellar_settled_elsewhere", false, "unknown"],
    ["settle_exact_stellar_transaction_submission_failed", false, "unknown"],
    ["settle_upto_stellar_transaction_submission_failed", false, "unknown"],
    ["settle_exact_stellar_transaction_expired", false, "not_settled"],
    ["settle_upto_stellar_transaction_expired", false, "not_settled"],
    ["settle_exact_stellar_channel_unavailable", true, "not_settled"],
    ["settle_upto_stellar_payer_rate_limited", true, "not_settled"],
    ["invalid_exact_stellar_payload_invalid_signature", false, "unknown"],
    ["insufficient_funds", false, "unknown"],
    ["invalid_exact_stellar_payload_wrong_amount", false, "not_settled"],
    ["settle_upto_stellar_transaction_failed", false, "not_settled"],
    ["something_the_seller_made_up", false, "not_settled"],
  ] as const)("reports %s as retryable %s, paid %s", async (code, retryable, paid) => {
    expect(errorFrom(refused(code), true)).toMatchObject({ code: "payment_rejected", retryable, paid });
    // The same through pay_and_call, as the agent sees it.
    const buyer = fakeBuyer({ pay: () => Promise.reject(refused(code)) });
    const tools = createTools({ buyer });
    const result = await tools.call("pay_and_call", {
      resource: "https://a.example",
      spendingCap: { amount: "0.05" },
    });
    expect(result.isError).toBe(true);
    expect(expectConforms(tools, "pay_and_call", result)).toMatchObject({
      ok: false,
      error: { code: "payment_rejected", retryable, paid, details: { upstream: { code } } },
    });
  });

  it("follows the SDK's table for every facilitator code", () => {
    for (const [code, outcome] of Object.entries(refusalOutcomes)) {
      expect(errorFrom(refused(code), true), code).toMatchObject({
        retryable: outcome.retryable,
        paid: outcome.mayHavePaid ? "unknown" : "not_settled",
      });
    }
  });
});

describe("a tool's error for every SDK and egress code", () => {
  it("carries the SDK error's retryable and paid", () => {
    for (const [code, spec] of Object.entries(agentCodes)) {
      const error = errorFrom(paymentError(code as AgentCode), false);
      expect({ code: error.code, retryable: error.retryable, paid: error.paid }, code).toEqual({
        code,
        retryable: spec.retryable,
        paid: defaultPaid[code as AgentCode],
      });
    }
  });

  it("carries an egress error's retryable, with nothing paid", () => {
    for (const [code, spec] of Object.entries(egressCodes)) {
      const error = errorFrom(new EgressError(code as EgressCode, "connect"), false);
      expect(error, code).toMatchObject({ code, retryable: spec.retryable, paid: "none" });
    }
  });
});

describe("a JSON-RPC error's data", () => {
  const codes: RpcErrorCode[] = [...(Object.keys(rpcCodes) as RpcErrorCode[]), "tool_unknown"];

  it.each(codes)("carries %s with its retryable and nothing paid", (code) => {
    const spec = code === "tool_unknown" ? toolCodes.tool_unknown : rpcCodes[code];
    expect(rpcErrorData(code, "why")).toEqual({
      code,
      reason: "why",
      retryable: spec.retryable,
      paid: "none",
    });
  });
});
