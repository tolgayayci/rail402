import { describe, expect, it } from "vitest";
import { attribute, classifyTransaction, parseRegistry } from "../src/index.ts";
import { REGISTRIES } from "../src/registry-data.ts";
import { ADDRESSES, TRANSACTIONS, testnet, testnetDocument } from "./helpers.ts";

describe("shared relayers", () => {
  it("flag the rows of a facilitator marked sharedRelayer", () => {
    const pubnet = REGISTRIES["stellar:pubnet"];
    const relayer = "GA5SXMFJTUPTZRIEKM6XZLCYOZRMUEE6KGAHL3GXDBG64DYOUIWYIF3M";
    expect(attribute(pubnet, [relayer], "pubnet", 62_000_000)).toMatchObject({
      tier: "facilitator",
      facilitatorId: "built-on-stellar",
      sharedRelayer: true,
    });
    expect(
      attribute(pubnet, ["GAIWUSSOZMK4PNOUSHVTHEBND5LUSOFYLZDOIDVJBKLFEIND3M7G2ZSE"], "pubnet", 63_985_581)
        .sharedRelayer,
    ).toBe(false);
  });
});

describe("attribution", () => {
  it("attributes by ledger range, not by discovery time", () => {
    const registry = parseRegistry(testnetDocument());
    // The previous sponsor's range closed at 5,315,307; the current one opened at 5,327,208.
    expect(attribute(registry, [ADDRESSES.previousSponsor], "2025-12-17", 5_189_151).facilitatorId).toBe(
      "rail402",
    );
    expect(attribute(registry, [ADDRESSES.previousSponsor], "2025-12-17", 5_330_311).tier).toBe("shaped");
    expect(attribute(registry, [ADDRESSES.sponsor], "2025-12-17", 5_300_000).tier).toBe("shaped");
    expect(attribute(registry, [ADDRESSES.sponsor], "2025-12-17", 5_330_311).tier).toBe("rail402");
    // The same address in another epoch (a later testnet reset) is not the same account.
    expect(attribute(registry, [ADDRESSES.sponsor], "2026-06-01", 5_330_311).tier).toBe("shaped");

    // Adding a facilitator later re-attributes the same transaction the same way on every rebuild.
    const tx = TRANSACTIONS["x402org-exact-1"];
    const before = testnetDocument();
    const without = { ...before, facilitators: before.facilitators.slice(0, 1) };
    const first = classifyTransaction(tx, testnet(without));
    const after = classifyTransaction(tx, testnet(before));
    expect(first).toMatchObject({ row: { attribution: { tier: "shaped" } } });
    expect(after).toMatchObject({ row: { attribution: { tier: "facilitator", facilitatorId: "x402-org" } } });
    expect(classifyTransaction(tx, testnet(before))).toEqual(after);
  });

  it("checks the fee payer first, then the inner source, then the operation source", () => {
    const registry = parseRegistry(testnetDocument());
    expect(
      attribute(registry, [ADDRESSES.x402orgFeeBump, ADDRESSES.sponsor], "2025-12-17", 5_330_311)
        .facilitatorId,
    ).toBe("x402-org");
    expect(attribute(registry, ["GUNKNOWN", ADDRESSES.sponsor], "2025-12-17", 5_330_311).facilitatorId).toBe(
      "rail402",
    );
  });
});
