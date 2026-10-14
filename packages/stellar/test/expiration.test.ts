import { describe, expect, it } from "vitest";
import {
  EXPIRATION_TOLERANCE_LEDGERS,
  MIN_LEDGER_SECONDS,
  expirationLedgerFor,
  isExpired,
  maxAcceptableExpiration,
} from "@rail402.dev/stellar";

describe("authorization expiry", () => {
  it("derives the expiration ledger the way x402 clients do", () => {
    expect(expirationLedgerFor(60, 1_000, 5)).toBe(1_012);
    expect(expirationLedgerFor(300, 1_000, 5)).toBe(1_060);
    expect(expirationLedgerFor(61, 1_000, 5)).toBe(1_013);
    expect(expirationLedgerFor(60, 1_000, 5.5)).toBe(1_011);
  });

  it("bounds the expiry from above with the fastest assumed close time", () => {
    expect(MIN_LEDGER_SECONDS).toBe(2);
    expect(maxAcceptableExpiration(1_000, 60)).toBe(1_000 + 30 + EXPIRATION_TOLERANCE_LEDGERS);
    expect(maxAcceptableExpiration(1_000, 61)).toBe(1_000 + 31 + EXPIRATION_TOLERANCE_LEDGERS);
    // A client estimating 5 s ledgers always lands inside the bound, with or without a ledger closing in between.
    for (const timeout of [10, 60, 299, 300]) {
      expect(expirationLedgerFor(timeout, 1_001, 5)).toBeLessThanOrEqual(
        maxAcceptableExpiration(1_000, timeout),
      );
    }
  });

  it("treats the expiration ledger itself as still valid", () => {
    expect(isExpired(1_000, 999)).toBe(false);
    expect(isExpired(1_000, 1_000)).toBe(false);
    expect(isExpired(1_000, 1_001)).toBe(true);
  });

  it("refuses nonsensical inputs", () => {
    expect(() => expirationLedgerFor(60, 1_000, 0)).toThrow(RangeError);
    expect(() => expirationLedgerFor(-1, 1_000, 5)).toThrow(RangeError);
    expect(() => expirationLedgerFor(60, 1.5, 5)).toThrow(RangeError);
    expect(() => maxAcceptableExpiration(Number.NaN, 60)).toThrow(RangeError);
    expect(() => maxAcceptableExpiration(1_000, Infinity)).toThrow(RangeError);
  });
});
