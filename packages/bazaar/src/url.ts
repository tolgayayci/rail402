import { BlockList, isIP } from "node:net";

/** Longest resource URL the catalog accepts. */
export const MAX_URL_LENGTH = 2048;

/**
 * Addresses that must never be cataloged or fetched: loopback, private, link-local, shared,
 * documentation, benchmarking, multicast and reserved ranges (IPv4 and IPv6, including IPv4-mapped).
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
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  UNSAFE.addSubnet(network, prefix, "ipv6");
}

const LOCAL_NAMES = new Set(["localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"]);
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan"];

/** Whether an IP address (v4 or v6) is outside every private and reserved range. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  return !UNSAFE.check(address, family === 4 ? "ipv4" : "ipv6");
}

export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (LOCAL_NAMES.has(host)) return true;
  const family = isIP(host);
  if (family === 4) return host.startsWith("127.");
  if (family === 6) return host === "::1";
  return false;
}

/**
 * Whether a URL hostname may appear in the public catalog. IP literals must be public; names must
 * not be local-only. DNS answers are checked separately, at fetch time.
 */
export function isPublicHostname(hostname: string): boolean {
  const host = hostname
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.$/, "");
  if (host === "" || LOCAL_NAMES.has(host)) return false;
  if (isIP(host) !== 0) return isPublicAddress(host);
  if (LOCAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
  // A single label ("intranet") only resolves on private networks.
  return host.includes(".");
}

export type CanonicalUrl =
  | { readonly ok: true; readonly url: URL }
  | {
      readonly ok: false;
      readonly code: "bazaar_resource_invalid" | "bazaar_resource_unsafe";
      readonly reason: string;
    };

export interface CanonicalizeOptions {
  /** URL schemes accepted for this resource type. */
  readonly protocols: readonly string[];
  /** Accept loopback hosts (conformance runs only). */
  readonly allowLoopback: boolean;
}

/**
 * Canonical form of a resource URL: lower-case scheme and host (IDN as punycode), default port
 * removed, percent-encoding normalized (RFC 3986 §6.2.2: unreserved characters decoded, other escapes
 * in upper case), dot segments resolved, no credentials, query or fragment. `http` and `https`, and a
 * path with and without a trailing slash, stay distinct: a server may answer them differently.
 */
export function canonicalizeUrl(raw: unknown, options: CanonicalizeOptions): CanonicalUrl {
  if (typeof raw !== "string" || raw === "") {
    return { ok: false, code: "bazaar_resource_invalid", reason: "resource.url is missing." };
  }
  if (raw.length > MAX_URL_LENGTH) {
    return {
      ok: false,
      code: "bazaar_resource_invalid",
      reason: `resource.url exceeds ${String(MAX_URL_LENGTH)} characters.`,
    };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, code: "bazaar_resource_invalid", reason: "resource.url is not an absolute URL." };
  }
  if (!options.protocols.includes(url.protocol)) {
    return {
      ok: false,
      code: "bazaar_resource_invalid",
      reason: `resource.url must use ${options.protocols.map((p) => p.replace(":", "")).join(" or ")}.`,
    };
  }
  if (url.username !== "" || url.password !== "") {
    return {
      ok: false,
      code: "bazaar_resource_invalid",
      reason: "resource.url must not contain credentials.",
    };
  }
  if (hasControlCharacter(raw)) {
    return {
      ok: false,
      code: "bazaar_resource_invalid",
      reason: "resource.url contains control characters.",
    };
  }
  url.search = "";
  url.hash = "";
  if (url.protocol === "http:" || url.protocol === "https:") {
    // Decoding unreserved escapes can expose dot segments (%2e%2e); parsing again resolves them.
    url = new URL(`${url.origin}${normalizePercentEncoding(url.pathname)}`);
  }

  if (url.protocol === "http:" || url.protocol === "https:") {
    const loopback = isLoopbackHost(url.hostname);
    if (loopback ? !options.allowLoopback : !isPublicHostname(url.hostname)) {
      return {
        ok: false,
        code: "bazaar_resource_unsafe",
        reason: `Host "${url.hostname}" is not a public host.`,
      };
    }
  }
  return { ok: true, url };
}

const UNRESERVED = /[A-Za-z0-9\-._~]/;

/**
 * RFC 3986 §6.2.2 percent-encoding normalization: escapes of unreserved characters are decoded and
 * every other escape is written in upper case, so equivalent spellings of one path compare equal.
 */
export function normalizePercentEncoding(path: string): string {
  return path.replace(/%([0-9A-Fa-f]{2})/g, (_escape, hex: string) => {
    const character = String.fromCharCode(Number.parseInt(hex, 16));
    return UNRESERVED.test(character) ? character : `%${hex.toUpperCase()}`;
  });
}

/**
 * Whether a route template stays safe once fully percent-decoded (up to five passes, as upstream's
 * traversal check does): no NUL, CR, LF or backslash, and no empty segment (`//`).
 */
export function isSafeTemplate(template: string): boolean {
  let decoded = template;
  for (let pass = 0; pass < 5; pass++) {
    const next = safeDecode(decoded);
    if (next === decoded) break;
    decoded = next;
  }
  return !decoded.includes("\u0000") && !/[\r\n\\]/.test(decoded) && !decoded.includes("//");
}

/**
 * Whether a validated route template (e.g. `/users/:id`) describes the concrete path that was paid
 * for (e.g. `/users/42`): same number of segments, static segments equal, parameters non-empty.
 */
export function templateMatchesPath(template: string, path: string): boolean {
  const templateSegments = template.split("/");
  const pathSegments = path.split("/");
  if (templateSegments.length !== pathSegments.length) return false;
  return templateSegments.every((segment, index) => {
    const concrete = pathSegments[index] ?? "";
    if (segment.startsWith(":")) return /^:[A-Za-z_][A-Za-z0-9_]*$/.test(segment) && concrete !== "";
    return safeDecode(segment) === safeDecode(concrete);
  });
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
