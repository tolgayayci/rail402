import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { Asset, Networks } from "@stellar/stellar-sdk";

/**
 * The Bazaar's Stellar asset registry pins each asset's SAC address as pre-derived data, so the
 * Bazaar needs no Stellar SDK at runtime. This test re-derives every one from (code, issuer, network
 * passphrase) via @stellar/stellar-sdk (a repo-root devDependency) and fails the build on any drift —
 * so `stellar-assets.json` can never silently claim a wrong contract for USDC, which would let the
 * facilitator vouch for a scam token. The unspoofability is the whole point, so it is also asserted.
 */
const PASSPHRASE = { "stellar:testnet": Networks.TESTNET };

describe("Stellar asset registry — provable identity", () => {
  const registry = JSON.parse(
    readFileSync(new URL("../apps/bazaar/src/catalog/stellar-assets.json", import.meta.url), "utf8"),
  );

  it("re-derives every pinned SAC address from its canonical (code, issuer)", () => {
    expect(registry.assets.length).toBeGreaterThan(0);
    for (const a of registry.assets) {
      const passphrase = PASSPHRASE[a.network];
      expect(passphrase, `unknown network ${a.network}`).toBeTruthy();
      const asset = a.issuer === null ? Asset.native() : new Asset(a.code, a.issuer);
      expect(asset.contractId(passphrase), `${a.code} on ${a.network}`).toBe(a.sac);
    }
  });

  it("a look-alike issuer for the same code derives a DIFFERENT SAC (unspoofable)", () => {
    const real = registry.assets.find(a => a.code === "USDC" && a.issuer);
    expect(real).toBeTruthy();
    const lookalike = new Asset(
      "USDC",
      "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    ).contractId(Networks.TESTNET);
    expect(lookalike).not.toBe(real.sac);
  });
});
