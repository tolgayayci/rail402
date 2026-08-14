/**
 * Stroop-precision amount helpers shared by the server and the browser library.
 *
 * SEP-41 amounts are 7-decimal integers end to end: every conversion here is
 * bigint arithmetic on strings, and nothing in this file — or anything that imports it — may put
 * an amount through a float.
 */

export const STROOPS_PER_UNIT = 10_000_000n;

/** "0.5" | "0.5000000" | "12" → 5_000_000n | 5_000_000n | 120_000_000n. Throws on malformed input. */
export function decimalToStroops(decimal: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,7}))?$/.exec(decimal.trim());
  if (!match) {
    throw new Error(
      `Not a 7-decimal amount: ${JSON.stringify(decimal)}. Expected digits with at most 7 decimal places.`,
    );
  }
  const whole = match[1] ?? "0";
  const frac = (match[2] ?? "").padEnd(7, "0");
  return BigInt(whole) * STROOPS_PER_UNIT + BigInt(frac);
}

/** 5_000_000n → "0.5000000". Horizon's classic-payment amount format (always 7 decimals). */
export function stroopsToDecimal(stroops: bigint): string {
  if (stroops < 0n) throw new Error(`Negative amount: ${stroops}`);
  const whole = stroops / STROOPS_PER_UNIT;
  const frac = stroops % STROOPS_PER_UNIT;
  return `${whole}.${frac.toString().padStart(7, "0")}`;
}

/** 5_000_000n → "0.5" — the human-facing form, trailing zeros trimmed but never scientific. */
export function stroopsToDisplay(stroops: bigint): string {
  const fixed = stroopsToDecimal(stroops);
  return fixed.replace(/\.?0+$/, "") || "0";
}
