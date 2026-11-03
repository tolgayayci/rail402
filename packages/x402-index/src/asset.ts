import { Asset } from "@stellar/stellar-sdk";

/** The asset of a row: verified only when the named asset's SAC contract id is the emitting contract. */
export interface VerifiedAsset {
  readonly contract: string;
  readonly code: string | null;
  readonly issuer: string | null;
  readonly verified: boolean;
}

/**
 * Verifies the asset a token's `transfer` event names in its fourth topic (`CODE:ISSUER` or
 * `native`). A token can name itself after any asset, so the name counts only when
 * `Asset(code, issuer).contractId(passphrase)` equals the contract that emitted the event. Anything
 * else is a custom SEP-41 token: no code, no issuer, not verified. Never throws.
 */
export function verifySacAsset(
  contract: string,
  assetTopic: string | null,
  passphrase: string,
): VerifiedAsset {
  const custom: VerifiedAsset = { contract, code: null, issuer: null, verified: false };
  if (assetTopic === null || assetTopic.length > 70) return custom;
  try {
    let asset: Asset;
    if (assetTopic === "native") asset = Asset.native();
    else {
      const parts = assetTopic.split(":");
      if (parts.length !== 2) return custom;
      const [code = "", issuer = ""] = parts;
      asset = new Asset(code, issuer);
    }
    if (asset.contractId(passphrase) !== contract) return custom;
    return asset.isNative()
      ? { contract, code: "native", issuer: null, verified: true }
      : { contract, code: asset.getCode(), issuer: asset.getIssuer() ?? null, verified: true };
  } catch {
    return custom;
  }
}
