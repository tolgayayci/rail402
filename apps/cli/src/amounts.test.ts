import { describe, it, expect } from "vitest";
import { toAtomic, toDecimal } from "./amounts.js";

describe("toAtomic", () => {
  it("converts decimals at 7-decimal Stellar scale", () => {
    expect(toAtomic("0.10")).toBe("1000000");
    expect(toAtomic("1")).toBe("10000000");
    expect(toAtomic("0")).toBe("0");
    expect(toAtomic("0.0000001")).toBe("1");
    expect(toAtomic("123.4567891")).toBe("1234567891");
  });

  it("uses exact integer math, not float", () => {
    // 0.1 + 0.2 in float is 0.30000000000000004; here it is exact.
    expect(toAtomic("0.3")).toBe("3000000");
    expect(toAtomic("9007199.2549")).toBe("90071992549000");
  });

  it("rejects more fractional digits than the asset supports", () => {
    expect(() => toAtomic("0.00000001")).toThrow(/fractional digits/);
  });

  it("rejects non-decimal input", () => {
    expect(() => toAtomic("abc")).toThrow();
    expect(() => toAtomic("-1")).toThrow();
    expect(() => toAtomic("1.2.3")).toThrow();
    expect(() => toAtomic("")).toThrow();
  });
});

describe("toDecimal", () => {
  it("formats atomic units, trimming trailing zeros", () => {
    expect(toDecimal("1000000")).toBe("0.1");
    expect(toDecimal("10000000")).toBe("1");
    expect(toDecimal("1")).toBe("0.0000001");
    expect(toDecimal("0")).toBe("0");
    expect(toDecimal("75000")).toBe("0.0075");
  });

  it("round-trips with toAtomic for canonical decimals", () => {
    for (const d of ["0.075", "1", "0.1", "12.3456789", "0.0000001", "0"]) {
      expect(toDecimal(toAtomic(d))).toBe(d);
    }
  });

  it("rejects non-integer input", () => {
    expect(() => toDecimal("1.5")).toThrow();
    expect(() => toDecimal("abc")).toThrow();
  });
});
