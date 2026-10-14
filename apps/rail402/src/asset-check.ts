import type { AssetDirectory, AssetKind } from "@rail402.dev/stellar";
import { ConfigError, type NetworkConfig } from "./config.ts";
import { publicReason } from "./public-reason.ts";

/**
 * The accepted assets of one network compared with the chain. Decimals decide every conversion
 * between a price in whole units and the base units a payment carries, so a configured value the
 * token contradicts is a configuration error, not a warning.
 */
export type AssetCheck =
  | {
      readonly ok: true;
      readonly detail: string;
      /** Stellar Asset Contract or other SEP-41 token, per contract. */
      readonly kinds: ReadonlyMap<string, AssetKind>;
    }
  | {
      readonly ok: false;
      readonly detail: string;
      /** Set when the chain contradicts the configuration; retrying cannot fix it. */
      readonly error?: ConfigError;
    };

/** Codes of the startup errors an asset check raises. */
export const ASSET_CHECK_CODES = {
  decimalsMismatch: "asset_decimals_mismatch",
  notAToken: "asset_not_a_token",
} as const;

/**
 * Reads each accepted asset's contract: that it is deployed, whether it is a Stellar Asset Contract,
 * and that its `decimals()` equals the configured decimals. An RPC or simulation failure, or a contract
 * that is not (yet) deployed, leaves the check failed but retryable; a contract without a `decimals()`
 * function (definitive host error, see `AssetDirectory.inspect`) or whose decimals differ fails it for
 * good with a coded `ConfigError` naming the variable.
 */
export async function checkAssets(
  network: NetworkConfig,
  directory: Pick<AssetDirectory, "inspect">,
): Promise<AssetCheck> {
  const kinds = new Map<string, AssetKind>();
  const pending: string[] = [];
  for (const asset of network.assets) {
    const name = `${asset.symbol} (${asset.contract})`;
    let found;
    try {
      found = await directory.inspect(asset.contract);
    } catch (error) {
      return {
        ok: false,
        detail: `could not read ${name}: ${publicReason(error)}`,
      };
    }
    if (!found.found) {
      pending.push(`${name} is not deployed on ${network.network}`);
      continue;
    }
    if (found.decimals === undefined) {
      const message = `${network.assetsVariable}: ${name} on ${network.network} is not a SEP-41 token (it has no decimals() returning a u32)`;
      return {
        ok: false,
        detail: message,
        error: new ConfigError(message, ASSET_CHECK_CODES.notAToken),
      };
    }
    if (found.decimals !== asset.decimals) {
      const message = `${network.assetsVariable}: ${name} has ${String(found.decimals)} decimals on ${network.network}, but ${String(asset.decimals)} are configured`;
      return {
        ok: false,
        detail: message,
        error: new ConfigError(message, ASSET_CHECK_CODES.decimalsMismatch),
      };
    }
    kinds.set(asset.contract, found.kind);
  }
  if (pending.length > 0) return { ok: false, detail: pending.join("; ") };
  return {
    ok: true,
    detail: network.assets.map((asset) => `${asset.symbol}:${String(asset.decimals)}`).join(", "),
    kinds,
  };
}
