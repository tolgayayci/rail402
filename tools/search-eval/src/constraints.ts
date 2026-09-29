/**
 * An independent check of hard constraints against a listing. It deliberately shares no code with
 * the search package's filters (its own asset table, decimal arithmetic and matching), so a bug in
 * the service cannot hide itself in the evaluation. Every constraint must hold for one and the same
 * payment option.
 */
import { MuxedAccount } from "@stellar/stellar-sdk";
import type { ListingContent } from "@rail402.dev/bazaar";
import type { ExpectedConstraints } from "./dataset.ts";

export interface EvalAsset {
  readonly network: string;
  readonly contract: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly usd: boolean;
}

export type ConstraintName = "network" | "type" | "asset" | "price" | "scheme" | "payTo";

/** Which constraints no single payment option satisfies together; empty when the listing complies. */
export function unmetConstraints(
  listing: ListingContent,
  expected: ExpectedConstraints,
  assets: readonly EvalAsset[],
): ConstraintName[] {
  if (expected.type !== undefined && listing.kind !== expected.type) return ["type"];
  let best: ConstraintName[] | undefined;
  for (const option of listing.accepts) {
    const known = assets.find((asset) => asset.network === option.network && asset.contract === option.asset);
    const unmet: ConstraintName[] = [];
    if (expected.network !== undefined && option.network !== expected.network) unmet.push("network");
    if (expected.scheme !== undefined && option.scheme !== expected.scheme) unmet.push("scheme");
    if (expected.payTo !== undefined && !paysTo(option.payTo, expected.payTo)) unmet.push("payTo");
    if (expected.asset !== undefined) {
      const wanted = expected.asset.toUpperCase();
      if (option.asset !== expected.asset && known?.symbol.toUpperCase() !== wanted) unmet.push("asset");
    }
    if (expected.maxPrice !== undefined && !withinPrice(option.amount, known, expected.maxPrice)) {
      unmet.push("price");
    }
    if (unmet.length === 0) return [];
    if (best === undefined || unmet.length < best.length) best = unmet;
  }
  return best ?? ["network"];
}

/**
 * Whether an option pays `wanted`: the same address, or, for a G… account, a muxed M… address on it.
 * An M… filter matches only itself.
 */
function paysTo(payTo: string, wanted: string): boolean {
  if (payTo === wanted) return true;
  if (!payTo.startsWith("M") || !wanted.startsWith("G")) return false;
  try {
    return MuxedAccount.fromAddress(payTo, "0").baseAccount().accountId() === wanted;
  } catch {
    return false;
  }
}

function withinPrice(
  amount: string,
  known: EvalAsset | undefined,
  ceiling: { readonly amount: string; readonly unit: string },
): boolean {
  // An asset the evaluation cannot price never satisfies a price ceiling.
  if (known === undefined || !/^\d+$/.test(amount)) return false;
  const unit = ceiling.unit.toUpperCase();
  if (unit === "USD" ? !known.usd : known.symbol.toUpperCase() !== unit) return false;
  const limit = scaled(ceiling.amount, known.decimals);
  return limit !== undefined && BigInt(amount) <= limit;
}

/** "0.015" at 7 decimals → 150000n. Digits beyond the asset's precision are cut, never rounded up. */
function scaled(decimal: string, decimals: number): bigint | undefined {
  const parts = decimal.split(".");
  if (parts.length > 2 || !parts.every((part) => /^\d*$/.test(part)) || decimal === "" || decimal === ".") {
    return undefined;
  }
  const whole = parts[0] === "" ? "0" : (parts[0] ?? "0");
  const fraction = (parts[1] ?? "").padEnd(decimals, "0").slice(0, decimals);
  let value = 0n;
  for (const digit of whole + fraction) value = value * 10n + BigInt(digit.charCodeAt(0) - 48);
  return value;
}
