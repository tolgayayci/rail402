import { describe, it, expect } from "vitest";
import { txUrl, explorerTxUrl, accountUrl, contractUrl, truncate } from "./format.js";
import { createSession } from "./session.js";

describe("explorer links", () => {
  it("build testnet stellar.expert URLs", () => {
    expect(txUrl("abc123")).toBe("https://stellar.expert/explorer/testnet/tx/abc123");
    expect(accountUrl("GABC")).toContain("/account/GABC");
    expect(contractUrl("CDEF")).toContain("/contract/CDEF");
  });

  it("builds the Rail402 explorer receipt URL, configurable per deployment", () => {
    expect(explorerTxUrl("abc123")).toBe("https://explorer.rail402.dev/tx/abc123");
    expect(explorerTxUrl("abc123", "https://explorer.example/")).toBe("https://explorer.example/tx/abc123");
  });
});

describe("truncate", () => {
  it("shortens long identifiers and leaves short ones alone", () => {
    expect(truncate("GBRVXNCL55KOEB7WU3BPSEL34PSUH63UCIFPZDUBIVJBRRG5ZB7V4YR7")).toBe("GBRV…4YR7");
    expect(truncate("short")).toBe("short");
  });
});

describe("createSession", () => {
  it("generates a valid, unique keypair with no network access", () => {
    const a = createSession();
    const b = createSession();
    expect(a.address).toMatch(/^G/);
    expect(a.secret).toMatch(/^S/);
    expect(a.address).not.toBe(b.address);
  });
});
