/**
 * Outbound safety: where we are willing to send a request, and which amounts we will compare.
 *
 * Both agent-facing surfaces need both policies — `payAndFetch`/`discoverAndPay` here, and the MCP
 * server's `pay_and_call` — so they live in ONE place and the MCP package re-exports them. Two
 * copies of a security control is one copy that stops rejecting something, which is exactly how the
 * SSRF gate came to exist in the MCP server and not in this package (ported late), and
 * how the spend cap was fixed twice (§F3, then §F20).
 */

/** The shape of a payment option, as it appears in a 402 challenge and in the catalog. */
export interface PricedOption {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

/**
 * Amounts are bigint end to end. A budget check done in floating point is a bug
 * waiting to overspend: `Number("9007199254740993")` silently loses precision, and this is the
 * comparison that decides whether real money moves.
 */
export function withinBudget(price: string, maxAmount: string): boolean {
  const parsed = parseAmount(price);
  const ceiling = parseAmount(maxAmount);
  if (parsed === undefined || ceiling === undefined) return false;
  return parsed <= ceiling;
}

/**
 * Parse an atomic amount, or `undefined` if it is not one.
 *
 * Every amount reaching this server is attacker-influenceable: catalog entries come from whatever
 * Bazaar the operator pointed at (including federated mirrors of other people's catalogs), and 402
 * challenges come from the seller. `BigInt("NaN")` and `BigInt("1e9")` both THROW, so an unguarded
 * conversion anywhere in a sort comparator or a filter turns one malformed listing into an uncaught
 * `SyntaxError` — which escapes the tool as a bare V8 message with no code, no reason and no
 * envelope. That is precisely the failure structured MCP output exists to prevent, reached through the flagship
 * tool by a single bad row.
 *
 * So: one parser, used everywhere an amount is compared, and callers soft-drop what it rejects —
 * the same posture the catalog already takes with malformed seller metadata.
 */
export function parseAmount(amount: unknown): bigint | undefined {
  if (typeof amount !== "string" || !/^\d+$/.test(amount)) return undefined;
  try {
    return BigInt(amount);
  } catch {
    return undefined;
  }
}

/**
 * Sort by amount, cheapest first, having already dropped anything unpriceable.
 *
 * A comparator must never throw: `Array.prototype.sort` gives no way to recover, so one bad row
 * takes down the whole call rather than removing itself.
 */
export function byAmountAscending(a: PricedOption, b: PricedOption): number {
  const left = parseAmount(a.amount);
  const right = parseAmount(b.amount);
  if (left === undefined || right === undefined) return 0;
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Options this agent could actually price. Unparseable amounts are dropped, never guessed at. */
export function priceable(accepts: readonly PricedOption[]): PricedOption[] {
  return accepts.filter(a => parseAmount(a.amount) !== undefined);
}


/** Hostnames that name an infrastructure endpoint rather than a paid service. */
const REFUSED_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata",
  "instance-data",
  "kubernetes.default.svc",
]);
/** Suffixes reserved for internal resolution. Never a public paid API. */
const REFUSED_SUFFIXES = [
  ".internal",
  ".local",
  ".localdomain",
  ".cluster.local",
  // RFC 6761 reserves the entire `.localhost` tree for loopback, and resolvers honour it.
  ".localhost",
  // Consul service discovery — a mainstream internal-resolution suffix.
  ".consul",
];
const LOOPBACK_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"]);

const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;
/** `http://2852039166/` and `http://0x7f000001/` are both 127.0.0.1 to a resolver. */
const ALL_DIGITS = /^\d+$/;
const HEX_LITERAL = /^0x[0-9a-f]+$/i;

/**
 * Decide whether this server will fetch a caller-supplied resource URL.
 *
 * `pay_and_call` takes a URL from the agent, fetches it, and returns the body — which makes it a
 * read primitive pointed at whatever the MCP server's network position can reach. Before this check
 * it would fetch `http://169.254.169.254/latest/meta-data/…` and hand the response straight back
 * In an agent runtime "the caller" includes anything that can get a tool
 * call into the conversation, so this is not hypothetical.
 *
 * ## Why this is written out rather than reusing the SDK's `isValidIconUrl`
 *
 * That helper happens to encode nearly this policy, and reuse is the house rule everywhere else in
 * this codebase. Not here. It exists to decide whether a *decorative image link* is acceptable, and
 * upstream is free to relax it on those grounds — at which point our SSRF boundary would widen
 * silently, with no diff in this repository and no test failing. A security control should not be a
 * side effect of somebody else's product decision about favicons. It is fifteen lines; we own them.
 *
 * ## The policy
 *
 * http(s) only · no credentials in the URL · no IPv6 literal · no IPv4 literal in any encoding
 * (dotted, decimal or hex) · no loopback name · no internal-resolution suffix · no known metadata
 * hostname. Rejecting every IP literal rather than enumerating private ranges is deliberate: it
 * covers 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, CGNAT and anything else in one rule that
 * cannot be wrong, and a public paid service advertises a hostname anyway.
 *
 * ## Residual, stated rather than papered over
 *
 * A public DNS name that resolves to a private address still passes, and this runs before the
 * socket, so DNS rebinding is not closed. Closing it needs resolve-then-pin at the connection
 * layer.
 *
 * @param raw - the caller-supplied resource URL
 * @param allowPrivateHosts - operator opt-in for local development, where the seller genuinely is
 *   on localhost. Off by default; a hosted deployment must never turn it on. Even then the
 *   metadata and internal-suffix rules still apply — the escape hatch is for a local seller, not
 *   for reaching an instance metadata service.
 */
export function isPayableResourceUrl(raw: string, allowPrivateHosts = false): boolean {
  let parsed: URL;
  try {
    // WHATWG URL parsing normalises IDN to punycode and percent-decodes the host for us, so the
    // checks below see the same string a resolver would.
    parsed = new URL(raw);
  } catch {
    return false;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;

  // A trailing dot makes an FQDN absolute — `localhost.` resolves to loopback exactly as `localhost`
  // does, and is a one-character bypass of a set-membership check that does not strip it.
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname === "") return false;
  if (REFUSED_HOSTNAMES.has(hostname)) return false;
  if (REFUSED_SUFFIXES.some(suffix => hostname.endsWith(suffix))) return false;

  // These stay enforced even under the opt-in.
  if (allowPrivateHosts) return true;

  if (parsed.host.startsWith("[")) return false; // IPv6 literal
  if (IPV4_LITERAL.test(hostname)) return false;
  if (ALL_DIGITS.test(hostname)) return false;
  if (HEX_LITERAL.test(hostname)) return false;
  if (LOOPBACK_HOSTNAMES.has(hostname)) return false;

  return true;
}


/**
 * `fetch` options that stop a redirect walking us off the host we vetted.
 *
 * The host policy above runs once, against the URL we were given. `fetch` follows redirects by
 * default, so a public host that answers `302 -> http://169.254.169.254/…` would be followed and its
 * body returned — the gate never sees the second URL. `redirect: "manual"` makes the redirect
 * visible as a 3xx response instead of being taken, which is the same posture `DomainVerifier` uses
 * for SEP-1 fetches. A seller that redirects simply does not get paid; it should publish the URL it
 * actually serves.
 */
export const NO_REDIRECT: Pick<RequestInit, "redirect"> = { redirect: "manual" };

