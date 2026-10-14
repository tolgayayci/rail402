/**
 * The per-call cap a visitor types. It is required before anything can be paid: a decimal amount
 * above zero with at most the asset's decimals. Above the operator's ceiling it is clamped to the
 * ceiling, as the buyer's policy does, and the page says so.
 */
import { compareDecimal, toAtomic, toDecimal } from "./format.ts";

export type CapState =
  | { readonly valid: false; readonly message: string }
  | {
      readonly valid: true;
      /** The cap as typed, normalized (`0.010` → `0.01`). */
      readonly value: string;
      /** The cap the buyer will apply: the typed cap or the ceiling, whichever is lower. */
      readonly effective: string;
      readonly clamped: boolean;
    };

export function capState(input: string, ceiling: string, decimals: number): CapState {
  const text = input.trim();
  if (text === "") return { valid: false, message: "Enter a spending cap: it is required." };
  if (!/^\d+(\.\d+)?$/.test(text)) return { valid: false, message: "Enter an amount such as 0.01." };
  const atomic = toAtomic(text, decimals);
  if (atomic === undefined)
    return { valid: false, message: `Use at most ${String(decimals)} decimal places.` };
  if (atomic <= 0n) return { valid: false, message: "The cap must be above zero." };
  const value = toDecimal(atomic.toString(), decimals) ?? text;
  const clamped = compareDecimal(value, ceiling, decimals) === 1;
  return { valid: true, value, effective: clamped ? ceiling : value, clamped };
}
