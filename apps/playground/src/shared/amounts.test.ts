import { describe, it, expect } from "vitest";
import { decimalToStroops, stroopsToDecimal, stroopsToDisplay } from "./amounts.js";

describe("decimalToStroops", () => {
  it("converts whole, fractional, and full-precision amounts", () => {
    expect(decimalToStroops("1")).toBe(10_000_000n);
    expect(decimalToStroops("0.5")).toBe(5_000_000n);
    expect(decimalToStroops("0.0000001")).toBe(1n);
    expect(decimalToStroops("12.3456789")).toBe(123_456_789n);
  });

  it("round-trips with stroopsToDecimal", () => {
    for (const s of [0n, 1n, 5_000_000n, 123_456_789n, 10_000_000_000n]) {
      expect(decimalToStroops(stroopsToDecimal(s))).toBe(s);
    }
  });

  it("refuses malformed and float-hazard inputs", () => {
    for (const bad of ["", "1.12345678", "-1", "1e7", "NaN", "0x10", "1,5", "1.2.3"]) {
      expect(() => decimalToStroops(bad), bad).toThrow();
    }
  });
});

describe("stroopsToDisplay", () => {
  it("trims trailing zeros without ever going scientific", () => {
    expect(stroopsToDisplay(5_000_000n)).toBe("0.5");
    expect(stroopsToDisplay(10_000_000n)).toBe("1");
    expect(stroopsToDisplay(1n)).toBe("0.0000001");
    expect(stroopsToDisplay(0n)).toBe("0");
  });

  it("refuses negative amounts", () => {
    expect(() => stroopsToDecimal(-1n)).toThrow();
  });
});
