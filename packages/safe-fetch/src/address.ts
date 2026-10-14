import { BlockList, isIP } from "node:net";

/**
 * Addresses that must never be fetched: loopback, private, carrier-grade NAT (which also holds some
 * cloud metadata services), link-local (the usual metadata address 169.254.169.254), shared,
 * documentation, benchmarking, multicast and reserved ranges, for IPv4 and IPv6. IPv4-mapped IPv6
 * addresses (::ffff:a.b.c.d) are checked against the IPv4 rules; NAT64 and 6to4 prefixes, which can
 * translate to any IPv4 address, are refused whole.
 */
const UNSAFE = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  UNSAFE.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  // IPv4-compatible addresses (::a.b.c.d, deprecated) and site-local fec0::/10 (deprecated, private).
  ["::", 96],
  ["fec0::", 10],
  // IPv4-mapped addresses (::ffff:a.b.c.d) need no rule: BlockList checks them against the IPv4 rules.
  // IPv4-translated addresses (::ffff:0:a.b.c.d, RFC 2765/6052) reach the embedded IPv4 address
  // through a SIIT translator: refused whole, like NAT64.
  ["::ffff:0:0:0", 96],
  // NAT64 (well-known and local-use prefixes).
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  // Discard-only.
  ["100::", 64],
  // IETF protocol assignments, including Teredo (2001::/32).
  ["2001::", 23],
  // Documentation.
  ["2001:db8::", 32],
  ["3fff::", 20],
  // 6to4.
  ["2002::", 16],
  // Unique local (fd00:ec2::254 is a metadata address), link-local, multicast.
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  UNSAFE.addSubnet(network, prefix, "ipv6");
}

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK.addAddress("::1", "ipv6");

const LOCAL_NAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"]);
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan"];

/** The address family of a bare IP literal (no brackets, no zone id), or 0. */
function familyOf(address: string): 0 | 4 | 6 {
  // Zone ids (fe80::1%eth0) are never valid destinations, and BlockList does not match them.
  if (address.includes("%")) return 0;
  return isIP(address) as 0 | 4 | 6;
}

/** Whether an IP address (v4 or v6) is outside every private and reserved range. */
export function isPublicAddress(address: string): boolean {
  const family = familyOf(address);
  if (family === 0) return false;
  return !UNSAFE.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** Whether an IP address is a loopback address (127.0.0.0/8, ::1, or 127.x mapped into IPv6). */
export function isLoopbackAddress(address: string): boolean {
  const family = familyOf(address);
  if (family === 0) return false;
  return LOOPBACK.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** Whether a URL hostname (name or IP literal, brackets allowed) names this machine. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.$/, "");
  if (LOCAL_NAMES.has(host) || host.endsWith(".localhost")) return true;
  const family = familyOf(host);
  if (family === 4) return host.startsWith("127.");
  if (family === 6) return host === "::1";
  return false;
}

/**
 * Whether a URL hostname may be fetched on the public internet. IP literals must be public; names must
 * not be local-only (`localhost`, `.local`, `.internal`, `.home.arpa`, `.lan`, single labels). DNS
 * answers are checked separately, when the connection is made.
 */
export function isPublicHostname(hostname: string): boolean {
  const host = hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.$/, "");
  if (host === "" || LOCAL_NAMES.has(host)) return false;
  if (host.includes("%")) return false;
  if (isIP(host) !== 0) return isPublicAddress(host);
  if (LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
  // A single label ("intranet") only resolves on private networks.
  return host.includes(".");
}

/** The IP address a URL hostname spells, without brackets, or undefined for a name. */
export function ipLiteral(hostname: string): string | undefined {
  const host = hostname.replace(/^\[|\]$/g, "");
  return isIP(host) === 0 ? undefined : host;
}
