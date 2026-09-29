import { describe, expect, it } from "vitest";
import {
  Rail402Error,
  defineCodes,
  errorFactory,
  httpCodes,
  httpError,
  isRail402Error,
  mergeCodes,
  toErrorBody,
} from "@rail402.dev/errors";

describe("defineCodes", () => {
  it("rejects codes that are not lower snake_case", () => {
    expect(() => defineCodes({ BadCode: { status: 400, retryable: false, reason: "x" } })).toThrow(
      /snake_case/,
    );
    expect(() => defineCodes({ double__underscore: { status: 400, retryable: false, reason: "x" } })).toThrow(
      /snake_case/,
    );
  });

  it("rejects blank default reasons", () => {
    expect(() => defineCodes({ blank: { status: 400, retryable: false, reason: "  " } })).toThrow(/empty/);
  });

  it("rejects statuses that are not HTTP errors", () => {
    expect(() => defineCodes({ ok: { status: 200, retryable: false, reason: "x" } })).toThrow(/status/);
  });
});

describe("mergeCodes", () => {
  it("refuses a code defined in two sets", () => {
    const a = defineCodes({ same: { status: 400, retryable: false, reason: "a" } });
    const b = defineCodes({ same: { status: 409, retryable: false, reason: "b" } });
    expect(() => mergeCodes(a, b)).toThrow(/more than once/);
  });

  it("keeps every code from disjoint sets", () => {
    const merged = mergeCodes(
      httpCodes,
      defineCodes({ extra: { status: 409, retryable: false, reason: "x" } }),
    );
    expect(Object.keys(merged)).toContain("extra");
    expect(Object.keys(merged)).toContain("rate_limited");
  });
});

describe("Rail402Error", () => {
  it("falls back to the default reason when an override is blank", () => {
    const error = httpError("rate_limited", { reason: "   " });
    expect(error.reason).toBe(httpCodes.rate_limited.reason);
    expect(error.status).toBe(429);
    expect(error.retryable).toBe(true);
  });

  it("keeps a specific reason and exposes a stable body", () => {
    const codes = defineCodes({ owner_conflict: { status: 409, retryable: false, reason: "default" } });
    const error = errorFactory(codes)("owner_conflict", {
      reason: "listing is owned by another payTo",
      details: { listingId: "l_1" },
    });
    expect(isRail402Error(error)).toBe(true);
    expect(error).toBeInstanceOf(Rail402Error);
    expect(toErrorBody(error)).toEqual({
      error: {
        code: "owner_conflict",
        reason: "listing is owned by another payTo",
        retryable: false,
        details: { listingId: "l_1" },
      },
    });
  });

  it("every shared HTTP code has a non-empty reason", () => {
    for (const [code, spec] of Object.entries(httpCodes)) {
      expect(spec.reason.trim(), code).not.toBe("");
    }
  });
});
