import {
  ipLiteral,
  isLoopbackAddress,
  isLoopbackHost,
  isPublicAddress,
  isPublicHostname,
} from "./address.ts";
import { EgressError } from "./codes.ts";
import type { EgressPolicy } from "./limits.ts";
import { effectivePort } from "./shared.ts";

/** The address classifier a policy implies: public addresses, plus loopback when it is allowed. */
export function addressClassifier(policy: EgressPolicy): (address: string) => boolean {
  if (policy.isAllowedAddress !== undefined) return policy.isAllowedAddress;
  if (policy.allowPrivateNetwork === "loopback") {
    return (address) => isPublicAddress(address) || isLoopbackAddress(address);
  }
  return isPublicAddress;
}

/**
 * Checks a URL against the policy before any DNS lookup or connection, and returns a parsed copy.
 * IP literals are classified here because Node does not call a custom `lookup` for them: this check
 * is the only thing standing between an IP-literal URL and a private address.
 */
export function checkUrl(input: string | URL, policy: EgressPolicy): URL {
  const raw = typeof input === "string" ? input : input.href;
  if (typeof raw !== "string" || raw === "") throw invalid("The URL is empty.");
  if (Buffer.byteLength(raw, "utf8") > policy.limits.urlBytes) {
    throw invalid(`The URL exceeds ${String(policy.limits.urlBytes)} bytes.`);
  }
  // The URL parser silently drops tabs and newlines; refuse them instead of fetching something else.
  if (hasControlCharacter(raw)) throw invalid("The URL contains control characters.");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid("The URL is not an absolute URL.");
  }
  if (Buffer.byteLength(url.href, "utf8") > policy.limits.urlBytes) {
    throw invalid(`The URL exceeds ${String(policy.limits.urlBytes)} bytes.`);
  }
  if (url.username !== "" || url.password !== "") throw invalid("The URL must not contain credentials.");
  if (!(policy.schemes as readonly string[]).includes(url.protocol)) {
    throw new EgressError("egress_scheme_not_allowed", "url", {
      reason: `The scheme ${url.protocol.replace(":", "")} is not allowed; allowed: ${policy.schemes
        .map((scheme) => scheme.replace(":", ""))
        .join(", ")}.`,
    });
  }
  const port = effectivePort(url);
  if (!policy.ports.includes(port)) {
    throw new EgressError("egress_port_not_allowed", "url", {
      reason: `Port ${String(port)} is not allowed; allowed: ${policy.ports.join(", ")}.`,
    });
  }
  if (!hostAllowed(url.hostname, policy)) {
    throw new EgressError("egress_destination_not_allowed", "url", {
      reason: `The host ${url.hostname} is a private, local or reserved destination.`,
    });
  }
  return url;
}

function hostAllowed(hostname: string, policy: EgressPolicy): boolean {
  const literal = ipLiteral(hostname);
  if (literal !== undefined) return addressClassifier(policy)(literal);
  if (isLoopbackHost(hostname)) return policy.allowPrivateNetwork === "loopback";
  return isPublicHostname(hostname);
}

function invalid(reason: string): EgressError {
  return new EgressError("egress_url_invalid", "url", { reason });
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
