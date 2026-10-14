import { describe, expect, it } from "vitest";
import {
  TRACE_MAX_BYTES,
  TRACE_REASON_MAX,
  decodeTrace,
  encodeTrace,
  fromBase64Url,
  parseServerTiming,
  serverTimingOf,
  toBase64Url,
  type SellerTrace,
} from "../src/shared/trace.ts";

const settled: SellerTrace = {
  v: 1,
  verify: { isValid: true, ms: 120 },
  settle: { success: true, transaction: "a".repeat(64), amount: "100000", ms: 2_400 },
  bazaar: { status: "processing", code: "awaiting_origin_verification", listingId: "lst_1", version: 1 },
};

describe("Rail402-Trace", () => {
  it("round-trips a trace as unpadded base64url", () => {
    const encoded = encodeTrace(settled);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeTrace(encoded)).toEqual(settled);
  });

  it("cuts long reasons and drops them when the header would be too large", () => {
    const long = "é".repeat(TRACE_REASON_MAX * 2);
    const refused: SellerTrace = {
      v: 1,
      verify: { isValid: true, ms: 1 },
      settle: {
        success: false,
        code: "invalid_upto_stellar_payload_settlement_exceeds_amount",
        reason: long,
        requested: "200000",
        ms: 5,
      },
    };
    const decoded = decodeTrace(encodeTrace(refused));
    expect(decoded?.settle?.reason).toBe("é".repeat(TRACE_REASON_MAX));
    const crowded: SellerTrace = {
      ...refused,
      verify: { isValid: false, code: "invalid_payload", reason: long, ms: 1 },
      bazaar: { status: "rejected", code: "bazaar_metadata_invalid", reason: long },
    };
    const encoded = encodeTrace(crowded);
    expect(encoded.length).toBeLessThanOrEqual(TRACE_MAX_BYTES);
    expect(decodeTrace(encoded)).toEqual({
      v: 1,
      verify: { isValid: false, code: "invalid_payload", ms: 1 },
      settle: {
        success: false,
        code: "invalid_upto_stellar_payload_settlement_exceeds_amount",
        requested: "200000",
        ms: 5,
      },
      bazaar: { status: "rejected", code: "bazaar_metadata_invalid" },
    });
  });

  it("refuses anything that is not a valid version 1 trace", () => {
    for (const value of [
      null,
      undefined,
      "",
      "not base64!",
      toBase64Url("{"),
      toBase64Url(JSON.stringify({ v: 2 })),
      toBase64Url(JSON.stringify({ v: 1, payload: "x" })),
      toBase64Url(JSON.stringify({ v: 1, settle: { success: true, transaction: "XYZ", ms: 1 } })),
      "a".repeat(TRACE_MAX_BYTES + 1),
    ]) {
      expect(decodeTrace(value), String(value).slice(0, 20)).toBeUndefined();
    }
  });

  it("encodes like Node's base64url", () => {
    for (const text of ["", "f", "fo", "foo", "ü?>~", "x".repeat(1_000)]) {
      const encoded = toBase64Url(text);
      expect(encoded).toBe(Buffer.from(text, "utf8").toString("base64url"));
      expect(fromBase64Url(encoded)).toBe(text);
    }
    expect(() => fromBase64Url("a+b")).toThrow(TypeError);
  });
});

describe("Server-Timing", () => {
  it("names the facilitator calls and reads them back", () => {
    const value = serverTimingOf(settled);
    expect(value).toBe("x402-verify;dur=120, x402-settle;dur=2400");
    expect(parseServerTiming(value)).toEqual({ "x402-verify": 120, "x402-settle": 2400 });
    expect(serverTimingOf({ v: 1 })).toBe("");
  });

  it("skips malformed metrics", () => {
    expect(parseServerTiming('db;dur=1.5, cache;desc="x", bad name;dur=3, ;dur=4, x;dur=-1')).toEqual({
      db: 1.5,
    });
    expect(parseServerTiming(null)).toEqual({});
  });
});
