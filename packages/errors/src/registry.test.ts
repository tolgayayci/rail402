import { describe, it, expect } from "vitest";
import { ERROR_REGISTRY, ALL_ERROR_CODES, type ErrorCode } from "./registry.js";
import { createError, X402Error, isErrorCode, enrichUpstreamCode } from "./x402Error.js";

const entries = Object.entries(ERROR_REGISTRY) as [ErrorCode, (typeof ERROR_REGISTRY)[ErrorCode]][];

describe("the hard acceptance criterion: non-null reason on every rejection", () => {
  // This is the single most important test in the package.
  it("gives every registered code a non-empty, human-legible reason", () => {
    for (const [code, def] of entries) {
      expect(def.reason, `${code} has no reason`).toBeTruthy();
      expect(def.reason.trim().length, `${code} reason is blank`).toBeGreaterThan(0);
      // A "reason" that is just the code repeated back is not human-legible.
      expect(def.reason, `${code} reason merely restates the code`).not.toBe(code);
      expect(def.reason.length, `${code} reason is too terse to be useful`).toBeGreaterThan(20);
    }
  });

  it("never produces an empty reason through createError, even with a blank override", () => {
    for (const code of ALL_ERROR_CODES) {
      expect(createError(code).reason.trim()).not.toBe("");
      expect(createError(code, { reason: "   " }).reason.trim()).not.toBe("");
      expect(createError(code, { reason: "" }).reason.trim()).not.toBe("");
    }
  });

  it("falls back to a non-null reason for an unrecognized upstream code", () => {
    const enriched = enrichUpstreamCode("some_code_we_have_never_seen", "unexpected_verify_error");
    expect(enriched.reason.trim()).not.toBe("");
    expect(enriched.reason).toContain("some_code_we_have_never_seen");
    expect(enriched.code).toBe("unexpected_verify_error");
  });

  it("falls back to a non-null reason when upstream supplies no code at all", () => {
    const enriched = enrichUpstreamCode(undefined, "unexpected_settle_error");
    expect(enriched.reason.trim()).not.toBe("");
    expect(enriched.code).toBe("unexpected_settle_error");
  });
});

describe("wire-contract discipline", () => {
  /**
   * Codes emitted by @x402/stellar v2.20.0 src/exact/facilitator/scheme.ts, transcribed from the
   * source. Renaming any of these breaks stock clients and the upstream e2e suite, so the registry
   * must reproduce them verbatim.
   *
   * Transcribed deliberately rather than imported from the installed package: this list is a WIRE
   * contract, and its job is to fail loudly if our registry ever drops or renames one, independently
   * of what the package happens to export. An upstream rename is a separate signal, caught when the
   * suite is re-run against latest upstream.
   */
  const LIBRARY_CODES = [
    "invalid_x402_version",
    "unsupported_scheme",
    "network_mismatch",
    "invalid_network",
    "invalid_exact_stellar_payload_malformed",
    "invalid_exact_stellar_payload_wrong_operation",
    "invalid_exact_stellar_payload_unsafe_tx_or_op_source",
    "invalid_exact_stellar_payload_wrong_asset",
    "invalid_exact_stellar_payload_wrong_function_name",
    "invalid_exact_stellar_payload_facilitator_is_payer",
    "invalid_exact_stellar_payload_wrong_recipient",
    "invalid_exact_stellar_payload_wrong_amount",
    "invalid_exact_stellar_payload_simulation_failed",
    "invalid_exact_stellar_payload_fee_exceeds_maximum",
    "invalid_exact_stellar_payload_event_not_transfer",
    "invalid_exact_stellar_payload_event_missing_contract_id",
    "invalid_exact_stellar_payload_event_wrong_asset",
    "invalid_exact_stellar_payload_no_transfer_events",
    "invalid_exact_stellar_payload_multiple_transfers",
    "invalid_exact_stellar_payload_event_wrong_from",
    "invalid_exact_stellar_payload_event_wrong_to",
    "invalid_exact_stellar_payload_event_wrong_amount",
    "invalid_exact_stellar_payload_no_auth_entries",
    "invalid_exact_stellar_payload_unsupported_credential_type",
    "invalid_exact_stellar_payload_facilitator_in_auth",
    "invalid_exact_stellar_signature_expiration_too_far",
    "invalid_exact_stellar_payload_has_subinvocations",
    "invalid_exact_stellar_payload_missing_payer_signature",
    "invalid_exact_stellar_payload_unexpected_pending_signatures",
    "unexpected_verify_error",
    "unexpected_settle_error",
    "settle_exact_stellar_signer_selection_failed",
    "settle_exact_stellar_transaction_signing_failed",
    "settle_exact_stellar_fee_bump_signing_failed",
    "settle_exact_stellar_transaction_submission_failed",
    "settle_exact_stellar_transaction_failed",
  ] as const;

  it("registers every code @x402/stellar can emit, so nothing reaches a client unenriched", () => {
    for (const code of LIBRARY_CODES) {
      expect(isErrorCode(code), `library code ${code} is missing from the registry`).toBe(true);
    }
  });

  it("marks spec- and library-provenance codes so they are never renamed casually", () => {
    for (const code of LIBRARY_CODES) {
      const provenance = ERROR_REGISTRY[code as ErrorCode].provenance;
      expect(["spec", "library"], `${code} must not be marked local`).toContain(provenance);
    }
  });

  it("keeps local codes inside the upstream naming conventions so they are proposable upstream", () => {
    const localPrefixes = [
      "invalid_exact_stellar_",
      "invalid_upto_stellar_",
      "settle_exact_stellar_",
      "bazaar_",
      "mcp_",
      "config_",
      // Names the surface, like bazaar_/mcp_/config_ above. Covers access control the spec's §9
      // table has no code for — authentication and rate limiting.
      "facilitator_",
    ];
    for (const [code, def] of entries) {
      if (def.provenance !== "local") continue;
      // Canary codes are excluded on purpose: they never travel on the wire, so there is nothing to
      // propose upstream. The next test holds them to their own, stricter rule instead.
      if (def.surface === "canary") continue;
      expect(
        localPrefixes.some(p => code.startsWith(p)),
        `local code ${code} does not follow an accepted naming convention`,
      ).toBe(true);
    }
  });

  /**
   * Keep the inward-facing namespace sealed in both directions.
   *
   * A wire code that drifted onto the `canary` surface would stop being part of the contract
   * clients branch on; a `canary_`-prefixed code on a wire surface would leak a monitoring
   * detail into a protocol response. Either direction is a quiet mistake, so both are asserted.
   */
  it("keeps canary codes out of the wire namespace and wire codes out of the canary one", () => {
    for (const [code, def] of entries) {
      expect(
        def.surface === "canary",
        `${code}: surface "canary" and the canary_ prefix must agree`,
      ).toBe(code.startsWith("canary_"));
    }
  });
});

describe("registry integrity", () => {
  it("points every `refines` at a code that actually exists", () => {
    for (const [code, def] of entries) {
      if (!("refines" in def) || def.refines === undefined) continue;
      expect(isErrorCode(def.refines), `${code} refines unknown code ${def.refines}`).toBe(true);
    }
  });

  it("only lets local codes refine another code", () => {
    for (const [code, def] of entries) {
      if (!("refines" in def) || def.refines === undefined) continue;
      expect(def.provenance, `${code} refines but is not local`).toBe("local");
    }
  });

  it("uses lower_snake_case codes throughout, matching the spec's convention", () => {
    for (const code of ALL_ERROR_CODES) {
      expect(code, `${code} is not lower_snake_case`).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("has no duplicate reasons — each rejection must say something distinct", () => {
    const byReason = new Map<string, ErrorCode[]>();
    for (const [code, def] of entries) {
      byReason.set(def.reason, [...(byReason.get(def.reason) ?? []), code]);
    }
    const dupes = [...byReason.entries()].filter(([, codes]) => codes.length > 1);
    expect(dupes, `duplicate reasons: ${JSON.stringify(dupes)}`).toEqual([]);
  });

  it("splits the library's simulation catch-all into actionable causes", () => {
    // The gap that motivated this package: "no trustline", "insufficient balance", "replayed", and
    // "archived state" all collapse into one code upstream, which an agent cannot act on.
    const refinements = entries
      .filter(([, d]) => "refines" in d && d.refines === "invalid_exact_stellar_payload_simulation_failed")
      .map(([code]) => code);
    expect(refinements).toEqual(
      expect.arrayContaining([
        "invalid_exact_stellar_payload_missing_trustline_payer",
        "invalid_exact_stellar_payload_missing_trustline_recipient",
        "invalid_exact_stellar_payload_insufficient_balance",
        "invalid_exact_stellar_payload_authorization_replayed",
        "invalid_exact_stellar_ledger_entry_restore_required",
      ]),
    );
  });

  it("distinguishes buyer-fault from seller-fault for missing trustlines", () => {
    // Trustlines matter on Stellar. Telling a buyer "payment failed" when the SELLER has
    // no trustline is the specific unhelpful outcome we are trying to prevent.
    const seller = ERROR_REGISTRY.invalid_exact_stellar_payload_missing_trustline_recipient;
    expect(seller.remediation).toMatch(/seller/i);
    expect(seller.reason).toMatch(/payTo|receive/i);
  });
});

describe("createError / X402Error", () => {
  it("returns the frozen shape { code, reason, retryable } and omits details when unset", () => {
    const e = createError("invalid_network");
    expect(e).toEqual({
      code: "invalid_network",
      reason: ERROR_REGISTRY.invalid_network.reason,
      retryable: false,
    });
    expect("details" in e).toBe(false);
  });

  it("carries structured details when supplied", () => {
    const e = createError("invalid_network", { details: { network: "stellar:nope" } });
    expect(e.details).toEqual({ network: "stellar:nope" });
  });

  it("lets a caller supply a more specific reason", () => {
    const e = createError("invalid_exact_stellar_payload_wrong_amount", {
      reason: "Expected 10000000 stroops but the transfer authorizes 9999999.",
    });
    expect(e.reason).toContain("9999999");
  });

  it("propagates code, reason and retryable through the throwable form", () => {
    const err = new X402Error("settle_exact_stellar_transaction_submission_failed");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("settle_exact_stellar_transaction_submission_failed");
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("settle_exact_stellar_transaction_submission_failed");
    expect(err.reason.trim()).not.toBe("");
  });

  it("rejects unknown codes at the type guard boundary", () => {
    expect(isErrorCode("definitely_not_a_code")).toBe(false);
    expect(isErrorCode(undefined)).toBe(false);
    expect(isErrorCode(42)).toBe(false);
    // Must not be fooled by inherited Object properties.
    expect(isErrorCode("toString")).toBe(false);
    expect(isErrorCode("constructor")).toBe(false);
  });
});

describe("retryability is meaningful, not decorative", () => {
  it("marks deterministic validation failures as non-retryable", () => {
    for (const code of [
      "invalid_exact_stellar_payload_wrong_amount",
      "invalid_exact_stellar_payload_wrong_recipient",
      "invalid_exact_stellar_payload_authorization_replayed",
      "mcp_budget_exceeded",
    ] as const) {
      expect(ERROR_REGISTRY[code].retryable, `${code} should not be retryable`).toBe(false);
    }
  });

  it("marks transient infrastructure failures as retryable", () => {
    for (const code of [
      "settle_exact_stellar_transaction_submission_failed",
      "settle_exact_stellar_signer_selection_failed",
      "unexpected_verify_error",
    ] as const) {
      expect(ERROR_REGISTRY[code].retryable, `${code} should be retryable`).toBe(true);
    }
  });

  it("never marks a replayed authorization retryable — retrying can only fail again", () => {
    expect(ERROR_REGISTRY.invalid_exact_stellar_payload_authorization_replayed.retryable).toBe(false);
  });
});
