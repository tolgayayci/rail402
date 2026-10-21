/**
 * Formatting for the page: amounts in base units and whole units, short account ids, URLs. Pure and
 * exact: amounts are bigints, never floating point.
 */

/** `GBSV…ELYP`: the first and last four characters of an account, contract or hash. */
export function short(value: string, keep = 4): string {
  return value.length <= keep * 2 + 1 ? value : `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

const ATOMIC = /^-?\d+$/;
const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/;

/** Base units to whole units: `toDecimal("10000", 7)` is `"0.001"`. Undefined for malformed input. */
export function toDecimal(atomic: string, decimals: number): string | undefined {
  if (!ATOMIC.test(atomic) || !Number.isInteger(decimals) || decimals < 0) return undefined;
  const negative = atomic.startsWith("-");
  const digits = (negative ? atomic.slice(1) : atomic).replace(/^0+(?=\d)/, "");
  if (decimals === 0) return `${negative && digits !== "0" ? "-" : ""}${digits}`;
  const padded = digits.padStart(decimals + 1, "0");
  const whole = padded.slice(0, -decimals);
  const fraction = padded.slice(-decimals).replace(/0+$/, "");
  const text = fraction === "" ? whole : `${whole}.${fraction}`;
  return negative && text !== "0" ? `-${text}` : text;
}

/** Whole units to base units: `toAtomic("0.001", 7)` is `10000n`. Undefined for malformed input or too many decimals. */
export function toAtomic(decimal: string, decimals: number): bigint | undefined {
  const match = DECIMAL.exec(decimal.trim());
  if (match === null) return undefined;
  const [, sign = "", whole = "0", fraction = ""] = match;
  if (fraction.length > decimals) return undefined;
  const value = BigInt(whole + fraction.padEnd(decimals, "0"));
  return sign === "-" ? -value : value;
}

/** `after − before` of two decimal balances, in whole units; undefined when either is unknown. */
export function decimalDelta(
  before: string | null,
  after: string | null,
  decimals: number,
): string | undefined {
  if (before === null || after === null) return undefined;
  const a = toAtomic(before, decimals);
  const b = toAtomic(after, decimals);
  if (a === undefined || b === undefined) return undefined;
  return toDecimal((b - a).toString(), decimals);
}

/** `− 0.001 USDC`, `+ 0.001 USDC` or `0 USDC` for a signed decimal amount. */
export function signedAmount(decimal: string, symbol: string): string {
  if (decimal.startsWith("-")) return `− ${decimal.slice(1)} ${symbol}`;
  if (/^0(\.0*)?$/.test(decimal)) return `0 ${symbol}`;
  return `+ ${decimal} ${symbol}`;
}

/** Base units with their whole-unit reading: `10000 = 0.001 USDC`. */
export function atomicWithDecimal(atomic: string, decimals: number | null, symbol: string | null): string {
  const decimal = decimals === null ? undefined : toDecimal(atomic, decimals);
  if (decimal === undefined) return `${atomic} base units`;
  return `${atomic} = ${decimal} ${symbol ?? ""}`.trimEnd();
}

/** Compares two decimal amounts; undefined when either is malformed. */
export function compareDecimal(a: string, b: string, decimals: number): -1 | 0 | 1 | undefined {
  const x = toAtomic(a, decimals);
  const y = toAtomic(b, decimals);
  if (x === undefined || y === undefined) return undefined;
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * `demo.rail402.dev/weather?city=Ankara`: an http(s) URL without its scheme, for display. Any other
 * scheme (`mcp://tool/…`) is shown in full, since it says what the address is.
 */
export function displayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return url;
    const port = parsed.port === "" ? "" : `:${parsed.port}`;
    return `${parsed.hostname}${port}${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

/** `/weather?city=Ankara`: the path and query of a URL. */
export function pathAndQuery(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

/** The host of a URL, or the input when it does not parse. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** An https URL that parses, for links built from untrusted data; undefined otherwise. */
export function safeHttpsUrl(url: string | null | undefined): string | undefined {
  if (url === null || url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === ""
      ? parsed.href
      : undefined;
  } catch {
    return undefined;
  }
}

/** `6 s`, `1.2 s` or `850 ms`. */
export function duration(ms: number): string {
  if (ms < 1_000) return `${String(Math.round(ms))} ms`;
  const seconds = ms / 1_000;
  return `${seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds))} s`;
}

/** A decimal amount with thousands separators and at most `digits` decimals: `9,999.99`. */
export function groupedAmount(decimal: string, digits = 2): string {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(decimal);
  if (match === null) return decimal;
  const whole = (match[1] ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = (match[2] ?? "").slice(0, digits).replace(/0+$/, "");
  return fraction === "" ? whole : `${whole}.${fraction}`;
}
