import { describe, it, expect } from "vitest";
import type { PaymentPayload, PaymentRequirements, SettleResponse, VerifyResponse } from "@x402/core/types";
import { EnrichedExactStellarScheme } from "./scheme.js";

/**
 * Unit coverage for the enrichment wrapper — the code that implements the hardest acceptance criterion,
 * "a non-null reason on every rejection", in the field stock clients actually read. Before this file
 * the wrapper had no in-process test at all: `app.test.ts` rejects at body-parse/version-dispatch
 * before reaching it, and `classify.test.ts` covers only the classifier. So a regression that dropped
 * `errorMessage` — reverting every stock client to a bare code string — would have passed CI. That is
 * the "a function not asserted is not tested" trap, one layer up.
 *
 * The wrapper takes the upstream scheme by injection and, for a non-generic upstream code, enriches
 * purely from the registry with no network, so a controllable stand-in exercises it deterministically.
 */

type Upstream = ConstructorParameters<typeof EnrichedExactStellarScheme>[0];

function fakeUpstream(over: { verify?: VerifyResponse; settle?: SettleResponse } = {}): Upstream {
  return {
    scheme: "exact",
    caipFamily: "stellar:*",
    getExtra: () => ({ areFeesSponsored: true }),
    getSigners: () => ["GFACILITATOR"],
    verify: async () => over.verify ?? ({ isValid: true, payer: "GPAYER" } as VerifyResponse),
    settle: async () =>
      over.settle ??
      ({ success: true, transaction: "deadbeef", network: "stellar:testnet", payer: "GPAYER" } as SettleResponse),
  } as unknown as Upstream;
}

const options = { maxTransactionFeeStroops: 100_000, rpcUrlFor: () => undefined };
const payload = { x402Version: 2, accepted: { scheme: "exact", network: "stellar:testnet" } } as unknown as PaymentPayload;
const requirements = {
  scheme: "exact",
  network: "stellar:testnet",
  amount: "100",
  asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  payTo: "GBHJJL6UGTEF2KF5AUDXI6E635FMWPE4WZAHIY47WGSNCRFDVJZPO7E4",
} as unknown as PaymentRequirements;

const make = (over: Parameters<typeof fakeUpstream>[0] = {}) =>
  new EnrichedExactStellarScheme(fakeUpstream(over), options);

describe("EnrichedExactStellarScheme — non-null reason enrichment", () => {
  it("passes a successful verify through untouched", async () => {
    const r = await make().verify(payload, requirements);
    expect(r.isValid).toBe(true);
    expect(r.payer).toBe("GPAYER");
  });

  it("passes a successful settle through untouched — no enrichment on the happy path", async () => {
    const r = await make().settle(payload, requirements);
    expect(r.success).toBe(true);
    expect(r.transaction).toBe("deadbeef");
  });

  it("attaches a non-null, non-code-restating invalidMessage to a failed verify", async () => {
    const r = await make({
      verify: { isValid: false, invalidReason: "invalid_exact_stellar_payload_wrong_amount", payer: "GPAYER" },
    }).verify(payload, requirements);
    expect(r.isValid).toBe(false);
    expect(r.invalidReason).toBe("invalid_exact_stellar_payload_wrong_amount");
    expect(r.invalidMessage).toBeTruthy();
    // A reason that merely restates the code helps no one — assert it is prose, not the slug.
    expect(r.invalidMessage!.length).toBeGreaterThan(15);
    expect(r.invalidMessage).not.toBe(r.invalidReason);
  });

  it("puts the reason in errorMessage — the field stock clients read — on a failed settle", async () => {
    const r = await make({
      settle: {
        success: false,
        transaction: "",
        network: "stellar:testnet",
        errorReason: "settle_exact_stellar_transaction_submission_failed",
        payer: "GPAYER",
      },
    }).settle(payload, requirements);
    expect(r.success).toBe(false);
    expect(r.errorMessage).toBeTruthy();
    expect(r.errorMessage!.length).toBeGreaterThan(15);
    // The reason and a retryable flag also ride in `extra` for agents that read it.
    const extra = r.extra as { reason?: string; retryable?: unknown };
    expect(extra.reason).toBe(r.errorMessage);
    expect(typeof extra.retryable).toBe("boolean");
  });

  it("falls back to a SETTLE-labeled code for an unknown settle failure, never a verify code", async () => {
    // Regression guard for the fallback fix: resolveFailure() used a hard-wired unexpected_verify_error
    // for both surfaces, so an unrecognized settle code was reported as a verify error.
    const r = await make({
      settle: {
        success: false,
        transaction: "",
        network: "stellar:testnet",
        errorReason: "totally_unregistered_upstream_code",
        payer: "GPAYER",
      },
    }).settle(payload, requirements);
    expect(r.errorReason).toBe("unexpected_settle_error");
    expect(r.errorMessage).toBeTruthy();
  });

  it("falls back to a VERIFY-labeled code for an unknown verify failure", async () => {
    const r = await make({
      verify: { isValid: false, invalidReason: "totally_unregistered_upstream_code", payer: "GPAYER" },
    }).verify(payload, requirements);
    expect(r.invalidReason).toBe("unexpected_verify_error");
    expect(r.invalidMessage).toBeTruthy();
  });

  it("preserves upstream extra on a failed settle while adding reason/retryable", async () => {
    const r = await make({
      settle: {
        success: false,
        transaction: "",
        network: "stellar:testnet",
        errorReason: "settle_exact_stellar_transaction_submission_failed",
        payer: "GPAYER",
        extra: { keep: "me" },
      } as SettleResponse,
    }).settle(payload, requirements);
    const extra = r.extra as { keep?: string; reason?: string; retryable?: unknown };
    expect(extra.keep).toBe("me");
    expect(extra.reason).toBeTruthy();
  });
});
