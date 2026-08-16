/**
 * Money math. Amounts are integers in atomic units end to end (7 decimals is the Stellar SEP-41
 * default, which USDC uses). No floating point ever touches an amount — a CLI that quietly rounds a
 * price is a CLI that overpays.
 */

export const STELLAR_DECIMALS = 7;

/**
 * Parse a human decimal string (e.g. "0.10") into an atomic-unit integer string (e.g. "1000000").
 * Rejects anything that is not a plain non-negative decimal, and rejects more fractional digits
 * than the asset can represent rather than silently truncating them.
 */
export function toAtomic(decimal: string, decimals = STELLAR_DECIMALS): string {
  const trimmed = decimal.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`not a valid non-negative decimal amount: "${decimal}"`);
  }
  const parts = trimmed.split(".");
  const whole = parts[0] ?? "0";
  const frac = parts[1] ?? "";
  if (frac.length > decimals) {
    throw new Error(
      `amount "${decimal}" has ${frac.length} fractional digits but the asset supports only ${decimals}`,
    );
  }
  const padded = frac.padEnd(decimals, "0");
  // BigInt over the concatenated digits — no float, exact.
  const atomic = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || "0");
  return atomic.toString();
}

/**
 * Format an atomic-unit integer string (e.g. "1000000") as a human decimal (e.g. "0.1"), trimming
 * trailing zeros but keeping at least one digit after the point when there is a fraction.
 */
export function toDecimal(atomic: string, decimals = STELLAR_DECIMALS): string {
  if (!/^\d+$/.test(atomic.trim())) {
    throw new Error(`not a valid atomic amount: "${atomic}"`);
  }
  const value = BigInt(atomic.trim());
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = value % base;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${whole.toString()}.${fracStr}`;
}
