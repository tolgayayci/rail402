/**
 * The egress policy the page's seller transport carries. The relay on the server enforces the real
 * policy; this mirror bounds what the page sends and decides which Bazaar listings count as callable.
 */
import { resolvePolicy, type EgressPolicy } from "@rail402.dev/safe-fetch/shared";
import type { PublicConfig } from "../../../src/shared/public-config.ts";
import { relayUserAgent } from "../../../src/shared/relay-protocol.ts";

/** The port a URL connects to. */
function portOf(url: string): number {
  const parsed = new URL(url);
  if (parsed.port !== "") return Number(parsed.port);
  return parsed.protocol === "https:" ? 443 : 80;
}

/**
 * The seller transport's policy: the relay's schemes, ports, limits and timeout maxima, plus the
 * Playground's own origin (lab sellers are called directly) and, in local mode, the demo seller's
 * port, since the local relay reaches any loopback port.
 */
export function transportPolicy(config: PublicConfig): EgressPolicy {
  const relay = config.relay;
  const publicScheme = new URL(config.urls.public).protocol as "https:" | "http:";
  const schemes = [...new Set([...relay.policy.schemes, publicScheme])];
  const ports = new Set(relay.policy.ports);
  ports.add(portOf(config.urls.public));
  if (config.mode === "local") ports.add(portOf(config.urls.demoSeller));
  return resolvePolicy({
    schemes,
    ports: [...ports],
    allowPrivateNetwork: relay.policy.allowLoopback ? "loopback" : false,
    redirects: { mode: "error", max: relay.policy.maxRedirects },
    limits: {
      urlBytes: relay.limits.targetBytes,
      requestBodyBytes: relay.limits.requestBodyBytes,
      responseBodyBytes: relay.limits.responseBodyBytes,
    },
    timeouts: {
      headersMs: Math.min(15_000, relay.timeoutMaxima.headersMs),
      idleMs: Math.min(15_000, relay.timeoutMaxima.idleMs),
      totalMs: Math.min(60_000, relay.timeoutMaxima.totalMs),
    },
    userAgent: relayUserAgent(config.version, config.urls.public),
  });
}
