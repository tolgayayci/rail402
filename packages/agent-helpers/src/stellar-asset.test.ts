import { describe, it, expect } from "vitest";
import { readAssetIdentity, formatAtomicAmount } from "./stellar-asset.js";

/**
 * The reader is a trust boundary, not a convenience.
 *
 * What it returns is presented to an agent as "the catalog PROVED this token is USDC", and the agent
 * then spends money on the strength of it. The input is JSON from whatever Bazaar URL the operator
 * configured, so every one of these cases is a shape a hostile or merely broken catalog can send.
 */

const derived = {
  contract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  kind: "sac",
  code: "USDC",
  issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  decimals: 7,
  identity: "derived",
};

describe("readAssetIdentity", () => {
  it("reads the catalog's derived identity", () => {
    expect(readAssetIdentity({ stellar: { asset: derived } })).toEqual({
      code: "USDC",
      issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      decimals: 7,
      identity: "derived",
    });
  });

  it("accepts a null issuer, which is how native XLM is expressed", () => {
    const xlm = { ...derived, code: "XLM", issuer: null };
    expect(readAssetIdentity({ stellar: { asset: xlm } })?.issuer).toBeNull();
  });

  it("refuses any identity value other than `derived`", () => {
    // The whole assurance is the word "derived": the catalog computed the contract address from the
    // canonical (code, issuer) rather than copying a claim. A catalog that says "claimed", or that
    // says something a future build invented, has not proven anything to THIS build — and
    // unknown-means-unproven is the only safe direction, since the alternative is showing an agent
    // a proof badge for a value we cannot interpret.
    for (const identity of ["claimed", "onchain", "unverified", "", true, null, undefined]) {
      expect(readAssetIdentity({ stellar: { asset: { ...derived, identity } } })).toBeUndefined();
    }
  });

  it("returns undefined rather than a half-populated identity on a malformed shape", () => {
    const bad: unknown[] = [
      undefined,
      {},
      { stellar: null },
      { stellar: "USDC" },
      { stellar: {} },
      { stellar: { asset: "USDC" } },
      { stellar: { asset: { ...derived, code: 42 } } },
      { stellar: { asset: { ...derived, code: "" } } },
      { stellar: { asset: { ...derived, decimals: "7" } } },
      { stellar: { asset: { ...derived, decimals: 7.5 } } },
      { stellar: { asset: { ...derived, decimals: -1 } } },
      { stellar: { asset: { ...derived, issuer: 42 } } },
    ];
    for (const extra of bad) {
      expect(readAssetIdentity(extra as Record<string, unknown> | undefined)).toBeUndefined();
    }
  });
});

describe("formatAtomicAmount", () => {
  it("renders atomic units in whole units, keeping every decimal place", () => {
    expect(formatAtomicAmount("1000000", 7)).toBe("0.1000000");
    expect(formatAtomicAmount("10000000", 7)).toBe("1.0000000");
    expect(formatAtomicAmount("1", 7)).toBe("0.0000001");
    expect(formatAtomicAmount("0", 7)).toBe("0.0000000");
    expect(formatAtomicAmount("123", 0)).toBe("123");
  });

  it("does not lose precision at values a float would round", () => {
    // 9007199254740993 is Number.MAX_SAFE_INTEGER + 2: `Number(x) / 1e7` renders it wrong. This is
    // string arithmetic precisely so a price can never be displayed as a different price.
    expect(formatAtomicAmount("9007199254740993", 7)).toBe("900719925.4740993");
    expect(formatAtomicAmount("340282366920938463463374607431768211455", 18)).toBe(
      "340282366920938463463.374607431768211455",
    );
  });

  it("returns undefined for anything it cannot render exactly", () => {
    for (const [amount, decimals] of [
      ["1.5", 7],
      ["-1", 7],
      ["1e6", 7],
      ["", 7],
      ["abc", 7],
      ["100", -1],
      ["100", 7.5],
      ["100", 39],
    ] as [string, number][]) {
      expect(formatAtomicAmount(amount, decimals)).toBeUndefined();
    }
  });
});
