import { describe, expect, it } from "vitest";
import { capState } from "../../src/projection/cap.ts";
import {
  atomicWithDecimal,
  compareDecimal,
  decimalDelta,
  displayUrl,
  groupedAmount,
  safeHttpsUrl,
  short,
  signedAmount,
  toAtomic,
  toDecimal,
} from "../../src/projection/format.ts";

describe("amounts", () => {
  it("converts base units and whole units exactly", () => {
    expect(toDecimal("10000", 7)).toBe("0.001");
    expect(toDecimal("100000000", 7)).toBe("10");
    expect(toDecimal("-21000", 7)).toBe("-0.0021");
    expect(toDecimal("0", 7)).toBe("0");
    expect(toDecimal("1.5", 7)).toBeUndefined();
    expect(toAtomic("0.001", 7)).toBe(10000n);
    expect(toAtomic("0.00000001", 7)).toBeUndefined();
    expect(toAtomic("abc", 7)).toBeUndefined();
  });

  it("computes deltas, signs and comparisons", () => {
    expect(decimalDelta("1", "0.999", 7)).toBe("-0.001");
    expect(decimalDelta(null, "1", 7)).toBeUndefined();
    expect(signedAmount("-0.001", "USDC")).toBe("− 0.001 USDC");
    expect(signedAmount("0.001", "USDC")).toBe("+ 0.001 USDC");
    expect(signedAmount("0", "USDC")).toBe("0 USDC");
    expect(compareDecimal("0.001", "0.01", 7)).toBe(-1);
    expect(atomicWithDecimal("10000", 7, "USDC")).toBe("10000 = 0.001 USDC");
    expect(atomicWithDecimal("10000", null, null)).toBe("10000 base units");
  });

  it("groups thousands and trims decimals for display", () => {
    expect(groupedAmount("9999.9900000")).toBe("9,999.99");
    expect(groupedAmount("1234567")).toBe("1,234,567");
    expect(groupedAmount("0.5", 4)).toBe("0.5");
    expect(groupedAmount("0.99749", 4)).toBe("0.9974");
    expect(groupedAmount("junk")).toBe("junk");
  });

  it("shortens ids and shows URLs", () => {
    expect(short("GBSVAAAAAAAAAAAAELYP")).toBe("GBSV…ELYP");
    expect(displayUrl("https://demo.rail402.dev/weather?city=Ankara")).toBe(
      "demo.rail402.dev/weather?city=Ankara",
    );
    expect(displayUrl("mcp://tool/exact_stellar")).toBe("mcp://tool/exact_stellar");
  });

  it("links only https URLs without credentials", () => {
    expect(safeHttpsUrl("https://stellar.expert/x")).toBe("https://stellar.expert/x");
    expect(safeHttpsUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeHttpsUrl("http://example.com")).toBeUndefined();
    expect(safeHttpsUrl("https://user:pw@example.com")).toBeUndefined();
    expect(safeHttpsUrl(null)).toBeUndefined();
  });
});

describe("spending cap input", () => {
  it("is required and must be a positive amount within the asset's decimals", () => {
    expect(capState("", "0.1", 7)).toMatchObject({ valid: false });
    expect(capState("abc", "0.1", 7)).toMatchObject({ valid: false });
    expect(capState("0", "0.1", 7)).toMatchObject({ valid: false });
    expect(capState("0.00000001", "0.1", 7)).toMatchObject({ valid: false });
    expect(capState(" 0.010 ", "0.1", 7)).toEqual({
      valid: true,
      value: "0.01",
      effective: "0.01",
      clamped: false,
    });
  });

  it("is clamped to the operator's ceiling", () => {
    expect(capState("5", "0.1", 7)).toEqual({ valid: true, value: "5", effective: "0.1", clamped: true });
  });
});
