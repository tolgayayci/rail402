import {
  createSafeFetch,
  effectivePort,
  type EgressPolicyInput,
  type SafeFetch,
} from "@rail402.dev/safe-fetch";
import { isLoopbackHost, normalizeHost, type PlaygroundConfig } from "../config.ts";
import type { PlaygroundServerCode } from "../shared/codes.ts";
import { RELAY_LIMITS, RELAY_MAX_REDIRECTS, relayUserAgent } from "../shared/relay-protocol.ts";

/** Test seams of the egress policy: a resolver and an address classifier. */
export type EgressSeams = Pick<EgressPolicyInput, "resolve" | "isAllowedAddress">;

export type TargetVerdict =
  | { readonly ok: true; readonly url: URL; readonly host: string; readonly trusted: boolean }
  | { readonly ok: false; readonly code: PlaygroundServerCode; readonly reason: string };

/**
 * Where the relay may send requests, and the SSRF-safe fetch it sends them with.
 *
 * Hosted: https on port 443 to public addresses only, through safe-fetch (DNS answers checked and
 * pinned, the connected address checked again, redirects refused unless asked for, size and time
 * limits). Connections to the trusted hosts (the demo seller) are kept for reuse; a connection to any
 * other host is closed after its answer, so requests to many distinct hosts leave no idle sockets.
 * Local (loopback PUBLIC_URL only): http too, loopback addresses, and the target's own port, through
 * one safe-fetch per port.
 *
 * The relay never contacts the Playground itself (its own host and the platform's generated domain;
 * its lab sellers are called directly by the page), the facilitator or the Bazaar (the page reads
 * those through the fixed proxies), or a configured deny-listed host. These are matched by host name;
 * in local mode by host and port, since every local service shares the loopback address. Another
 * name for one of these hosts is not caught unless the operator lists it in RELAY_DENY_HOSTS; the
 * per-host, per-client and per-network limits still bound what such a request can do.
 */
export class RelayEgress {
  private readonly local: boolean;
  private readonly base: EgressPolicyInput;
  private readonly hosted: { readonly trusted: SafeFetch; readonly other: SafeFetch } | undefined;
  private readonly perPort = new Map<number, SafeFetch>();
  private readonly ownHosts: ReadonlySet<string>;
  private readonly operatorHosts: ReadonlySet<string>;
  private readonly denyHosts: ReadonlySet<string>;
  private readonly trustedHosts: ReadonlySet<string>;

  constructor(config: PlaygroundConfig, seams: EgressSeams = {}) {
    this.local = config.mode === "local";
    this.base = {
      schemes: this.local ? ["https:", "http:"] : ["https:"],
      allowPrivateNetwork: this.local ? "loopback" : false,
      redirects: { mode: "error", max: RELAY_MAX_REDIRECTS },
      limits: {
        urlBytes: RELAY_LIMITS.targetBytes,
        requestBodyBytes: RELAY_LIMITS.requestBodyBytes,
        responseBodyBytes: RELAY_LIMITS.responseBodyBytes,
      },
      maxSocketsPerHost: 32,
      userAgent: relayUserAgent(config.version, config.publicUrl),
      ...seams,
    };
    this.hosted = this.local
      ? undefined
      : {
          trusted: createSafeFetch({ ...this.base, ports: [443] }),
          other: createSafeFetch({
            ...this.base,
            ports: [443],
            keepAlive: false,
            maxTotalSockets: config.limits.relayInFlightGlobal,
          }),
        };
    this.ownHosts = new Set([
      this.hostKey(new URL(config.publicUrl)),
      ...config.relayLoopHosts.map((host) => this.hostKey(new URL(`https://${host}`))),
    ]);
    this.operatorHosts = new Set(
      [config.urls.facilitator, config.urls.bazaar].map((url) => this.hostKey(new URL(url))),
    );
    this.denyHosts = new Set(config.relayDenyHosts);
    this.trustedHosts = new Set(config.relayTrustedHosts);
  }

  /** Refuses targets the relay never contacts; scheme, port and address are judged by safe-fetch. */
  judge(target: string): TargetVerdict {
    const url = new URL(target);
    const key = this.hostKey(url);
    const host = normalizeHost(url.hostname);
    if (this.ownHosts.has(key)) {
      return {
        ok: false,
        code: "playground_relay_loop",
        reason: "The relay does not call the Playground itself; lab sellers are called directly.",
      };
    }
    if (this.operatorHosts.has(key)) {
      return {
        ok: false,
        code: "playground_relay_target_denied",
        reason:
          "The facilitator and the Bazaar are read through the Playground's own proxies, not the relay.",
      };
    }
    if (this.denyHosts.has(host)) {
      return {
        ok: false,
        code: "playground_relay_target_denied",
        reason: "The operator does not allow relaying to this host.",
      };
    }
    return { ok: true, url, host, trusted: this.trustedHosts.has(host) };
  }

  /** The safe-fetch a target is sent with; `trusted` from the target's verdict. */
  fetchFor(url: URL, trusted = false): SafeFetch {
    if (this.hosted !== undefined) return trusted ? this.hosted.trusted : this.hosted.other;
    const port = effectivePort(url);
    let fetch = this.perPort.get(port);
    if (fetch === undefined) {
      fetch = createSafeFetch({ ...this.base, ports: [...new Set([443, 80, port])] });
      this.perPort.set(port, fetch);
    }
    return fetch;
  }

  close(): void {
    this.hosted?.trusted.close();
    this.hosted?.other.close();
    for (const fetch of this.perPort.values()) fetch.close();
  }

  private hostKey(url: URL): string {
    const host = normalizeHost(url.hostname);
    if (!this.local) return host;
    return `${isLoopbackHost(host) ? "loopback" : host}:${String(effectivePort(url))}`;
  }
}
