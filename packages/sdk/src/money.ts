import { I128_MAX } from "@rail402.dev/stellar";

/**
 * Amounts without floating point. A decimal amount is a string in whole units of an asset ("0.05");
 * base units are a bigint (stroops for a 7-decimal asset). Conversion refuses more fraction digits
 * than the asset has instead of rounding, so a cap is never silently raised or lowered.
 */

/** A decimal amount in whole units of an asset, and the asset: a policy symbol ("USDC") or a C… contract. */
export interface Money {
  readonly amount: string;
  readonly asset?: string;
}

/** Largest number of decimals a SEP-41 token can declare that is still handled. */
export const MAX_DECIMALS = 38;

const DECIMAL = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;
const INTEGER = /^(0|[1-9][0-9]*)$/;

export function isValidDecimals(decimals: number): boolean {
  return Number.isInteger(decimals) && decimals >= 0 && decimals <= MAX_DECIMALS;
}

/**
 * Parses a decimal amount into base units. Undefined for a malformed amount, for more fraction digits
 * than `decimals`, and for a result above the i128 maximum.
 */
export function toAtomic(amount: string, decimals: number): bigint | undefined {
  if (typeof amount !== "string" || !isValidDecimals(decimals) || amount.length > 80) return undefined;
  const match = DECIMAL.exec(amount);
  if (match === null) return undefined;
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) return undefined;
  const atomic = BigInt(whole + fraction.padEnd(decimals, "0"));
  return atomic > I128_MAX ? undefined : atomic;
}

/** Formats base units as a decimal amount without trailing zeros ("0.05", "12"). */
export function toDecimal(atomic: bigint, decimals: number): string {
  if (!isValidDecimals(decimals)) throw new RangeError("decimals must be an integer from 0 to 38");
  const negative = atomic < 0n;
  const digits = (negative ? -atomic : atomic).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction === "" ? "" : `.${fraction}`}`;
}

/**
 * Parses an integer amount in base units, as x402 carries it. Undefined for anything but a canonical
 * non-negative integer string within the i128 range.
 */
export function parseAtomic(amount: unknown): bigint | undefined {
  if (typeof amount !== "string" || amount.length > 40 || !INTEGER.test(amount)) return undefined;
  const value = BigInt(amount);
  return value > I128_MAX ? undefined : value;
}

/** Parses "0.10 USDC", "0.10" or "5 C…" into a Money value; the asset is optional. */
export function parseMoney(text: string): Money | undefined {
  const parts = text.trim().split(/\s+/);
  if (parts.length === 0 || parts.length > 2) return undefined;
  const [amount, asset] = parts as [string, string | undefined];
  if (!DECIMAL.test(amount)) return undefined;
  return asset === undefined ? { amount } : { amount, asset };
}

export function minBigInt(first: bigint, ...rest: bigint[]): bigint {
  let least = first;
  for (const value of rest) if (value < least) least = value;
  return least;
}
