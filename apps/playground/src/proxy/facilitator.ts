import type { Hono } from "hono";
import type { PlaygroundConfig } from "../config.ts";
import { refuse, type ServerEnv } from "../http.ts";
import type { Clock } from "../limits.ts";
import { relayUserAgent } from "../shared/relay-protocol.ts";
import { PROXY_TIMEOUT_MS, proxyOrigin, type ProxyOptions } from "./bazaar.ts";
import { UpstreamJson, jsonReply, type UpstreamResult } from "./upstream.ts";

/** The share of the upstream budget readiness checks draw from. */
export const READINESS = "readiness";

export const SUPPORTED_PROXY_PATH = "/api/facilitator/supported";
/** `/supported` changes only on a facilitator redeploy. */
export const SUPPORTED_CACHE_MS = 60_000;
const SUPPORTED_MAX_BYTES = 256 * 1_024;

/** The facilitator's `/supported`, cached; shared by the proxy route and readiness. */
export class FacilitatorSupported {
  private readonly upstream: UpstreamJson;
  private readonly url: string;

  constructor(options: {
    readonly config: PlaygroundConfig;
    readonly admit?: () => boolean;
    readonly fetch?: typeof fetch;
    readonly now?: Clock;
  }) {
    this.url = `${options.config.urls.facilitator}/supported`;
    this.upstream = new UpstreamJson({
      timeoutMs: PROXY_TIMEOUT_MS,
      maxBytes: SUPPORTED_MAX_BYTES,
      userAgent: relayUserAgent(options.config.version, options.config.publicUrl),
      ...(options.admit === undefined ? {} : { admit: options.admit }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  /** The cached answer; `admit` replaces the configured admission check for this read. */
  get(admit?: () => boolean): Promise<UpstreamResult> {
    return admit === undefined
      ? this.upstream.get(this.url, SUPPORTED_CACHE_MS)
      : this.upstream.get(this.url, SUPPORTED_CACHE_MS, admit);
  }

  /** Whether the facilitator answered `/supported` with 200 (cached for a minute). */
  async reachable(): Promise<boolean> {
    const result = await this.get();
    return result.ok && result.answer.status === 200;
  }
}

/**
 * `GET /api/facilitator/supported`: the configured facilitator's `/supported`, cached for 60 s, for
 * the Playground page only.
 */
export function mountFacilitatorProxy(
  app: Hono<ServerEnv>,
  options: ProxyOptions & { readonly supported?: FacilitatorSupported },
): FacilitatorSupported {
  const { metrics } = options;
  const supported =
    options.supported ??
    new FacilitatorSupported({
      config: options.config,
      admit: () => options.upstreamGlobal.take(READINESS) === 0,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  app.get(SUPPORTED_PROXY_PATH, async (c) => {
    const foreign = proxyOrigin(c, options.config);
    if (foreign !== undefined) return foreign;
    const retryAfter = options.perClient.take(c.get("clientKey"));
    if (retryAfter > 0) {
      metrics.rateLimited.inc({ limit: "proxy" });
      return refuse(c, "playground_rate_limited", { retryAfter });
    }
    const network = c.get("networkKey");
    const result = await supported.get(() => options.upstreamGlobal.take(network) === 0);
    if (!result.ok) {
      metrics.proxyRequests.inc({ target: "facilitator", outcome: result.busy === true ? "busy" : "failed" });
      if (result.busy === true)
        return refuse(c, "playground_rate_limited", { reason: result.reason, retryAfter: 1 });
      return refuse(c, "playground_upstream_unavailable", { reason: `Facilitator: ${result.reason}` });
    }
    metrics.proxyRequests.inc({ target: "facilitator", outcome: result.cached ? "hit" : "fetched" });
    return jsonReply(result.answer);
  });
  return supported;
}
