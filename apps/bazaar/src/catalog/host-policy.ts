/**
 * Which resource-URL hosts the catalog will list — the ingest-side SSRF/reachability boundary.
 *
 * A settled payment hands the facilitator a `resource.url` echoed from the seller's 402 challenge,
 * and that URL becomes the catalog key an agent later fetches (directly, or through `pay_and_call`).
 * A listing whose host is loopback, a private range, or an internal-only name is worse than useless:
 * it is unreachable from anywhere but the machine that cataloged it, and — because the agent surfaces
 * fetch it — it is a stored SSRF target aimed at whatever the reader's network position can reach.
 * The live catalog was in exactly this state: every entry was `http://127.0.0.1:*` canary residue, so
 * the public Bazaar advertised nothing a stock client could pay (CURRENT_STATUS §1, §6 P9).
 *
 * ## Why this is a mirror of `@rail402/agent-helpers`'s `isPayableResourceUrl`, not an import
 *
 * That helper encodes the same policy for the buyer surfaces (`payAndFetch`, MCP `pay_and_call`),
 * and the house rule elsewhere in this repo is to share a security control rather than copy it —
 * duplicating one is how it comes to reject in one place and not another. The exception here is
 * deliberate: `@rail402/agent-helpers` is a *buyer-side* package, and the Bazaar is the server. Making
 * the catalog depend on the agent helper just to reach fifteen lines of host policy would invert the
 * dependency direction and pull the whole buyer stack (and its `@x402` deps) into the facilitator.
 * So the policy is restated here, kept byte-aligned with `outbound.ts`, and pinned by tests on both
 * sides. The two must stay in sync; the identical fixtures are the tripwire if they drift.
 *
 * ## The policy
 *
 * (Protocol is already checked in `ingest` — http(s) only, with `mcp://` given its own answer — so
 * this judges only the host.) No credentials in the URL · no IPv6 literal · no IPv4 literal in any
 * encoding (dotted, decimal, or hex) · no loopback name · no internal-resolution suffix · no known
 * metadata hostname. Rejecting every IP literal rather than enumerating private ranges is deliberate:
 * one rule covers 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, CGNAT and anything else, and a
 * public paid service advertises a hostname anyway.
 *
 * ## Residual, stated rather than papered over
 *
 * A public DNS name that resolves to a private address still passes; this runs at cataloging time,
 * long before any socket, so DNS rebinding is not closed here. Closing it needs resolve-then-pin at
 * the fetch layer on the agent surfaces.
 */

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
const LOOPBACK_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
]);

const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;
/** `http://2852039166/` and `http://0x7f000001/` are both 127.0.0.1 to a resolver. */
const ALL_DIGITS = /^\d+$/;
const HEX_LITERAL = /^0x[0-9a-f]+$/i;

export type HostPolicyVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Decide whether the catalog will list a resource served from this host.
 *
 * @param parsed - the resource URL, already parsed and confirmed http(s) by the caller
 * @param allowPrivateHosts - operator opt-in for local development, where the seller genuinely is on
 *   localhost. Off by default; a hosted deployment must never turn it on. Even under the opt-in the
 *   metadata and internal-suffix rules still apply — the escape hatch is for a local seller, not for
 *   cataloging a link to an instance-metadata service.
 * @returns `{ ok: true }`, or `{ ok: false, reason }` describing why the host was refused — a phrase
 *   that completes "the resource.url host …" so the caller can build a full, actionable message.
 */
export function checkResourceHost(parsed: URL, allowPrivateHosts = false): HostPolicyVerdict {
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, reason: "carries embedded credentials, which a catalog key must not" };
  }

  // A trailing dot makes an FQDN absolute — `localhost.` resolves to loopback exactly as `localhost`
  // does, and is a one-character bypass of a set-membership check that does not strip it.
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (hostname === "") return { ok: false, reason: "has no host" };
  if (REFUSED_HOSTNAMES.has(hostname)) {
    return { ok: false, reason: "is a reserved infrastructure/metadata hostname" };
  }
  if (REFUSED_SUFFIXES.some(suffix => hostname.endsWith(suffix))) {
    return { ok: false, reason: "uses an internal-resolution suffix that is not routable on the public internet" };
  }

  // These stay enforced even under the opt-in.
  if (allowPrivateHosts) return { ok: true };

  if (parsed.host.startsWith("[")) return { ok: false, reason: "is an IPv6 literal, not a public hostname" };
  if (IPV4_LITERAL.test(hostname)) return { ok: false, reason: "is an IP literal, not a public hostname" };
  if (ALL_DIGITS.test(hostname)) return { ok: false, reason: "is a decimal-encoded IP literal, not a public hostname" };
  if (HEX_LITERAL.test(hostname)) return { ok: false, reason: "is a hex-encoded IP literal, not a public hostname" };
  if (LOOPBACK_HOSTNAMES.has(hostname)) return { ok: false, reason: "is a loopback address" };

  return { ok: true };
}
