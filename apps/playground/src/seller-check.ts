import type { Hono } from "hono";
import type { Logger } from "pino";
import { z } from "zod";
import { isRail402Error, toErrorBody } from "@rail402.dev/errors";
import type { EgressPolicyInput } from "@rail402.dev/safe-fetch";
import { checkSellerOrigin, type OriginReport } from "@rail402.dev/sdk/seller";
import type { PlaygroundConfig } from "./config.ts";
import { refuse, type ServerEnv } from "./http.ts";
import { RateLimiter, SharedRate, type Clock } from "./limits.ts";
import type { Metrics } from "./metrics.ts";
import type { EgressSeams } from "./relay/egress.ts";
import { readBody } from "./relay/wire.ts";
import { sameOrigin } from "./security.ts";
import { RELAY_LIMITS } from "./shared/relay-protocol.ts";

export const SELLER_CHECK_PATH = "/api/seller-check";
/** Largest request body the seller check reads. */
export const SELLER_CHECK_BODY_BYTES = 8 * 1_024;
/** Upper bound of one check's unpaid request, so a slow seller cannot hold a slot for minutes. */
const PROBE_TIMEOUTS = { connectMs: 5_000, headersMs: 10_000, idleMs: 10_000, totalMs: 15_000 } as const;

const methods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;

/** The request body: the seller URL to check, as the catalog would check it. */
export const sellerCheckRequestSchema = z.strictObject({
  url: z
    .string()
    .min(1)
    .max(RELAY_LIMITS.targetBytes)
    // The URL parser silently drops tabs and newlines: refuse them rather than check another URL.
    // eslint-disable-next-line no-control-regex
    .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), "must not contain control characters")
    .refine((value) => URL.canParse(value), "must be an absolute URL"),
  method: z.enum(methods).optional(),
  /** Checks the MCP tool of this name at `url` (the MCP endpoint) instead of an HTTP resource. */
  toolName: z.string().min(1).max(128).optional(),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

export type SellerCheckRequest = z.infer<typeof sellerCheckRequestSchema>;

export interface SellerCheckOptions {
  readonly config: PlaygroundConfig;
  readonly metrics: Metrics;
  readonly log: Logger;
  readonly now?: Clock;
  /** Test seams of the unpaid request's egress policy. */
  readonly egress?: EgressSeams;
  /** Replaces the check itself (tests). */
  readonly check?: typeof checkSellerOrigin;
}

export interface SellerCheck {
  sweep(): void;
}

/**
 * The unpaid request's egress policy. Hosted: https on port 443 to public addresses only. Local
 * (loopback PUBLIC_URL only): http too, loopback addresses, and the URL's own port.
 */
export function sellerCheckEgress(
  config: PlaygroundConfig,
  target: URL,
  seams: EgressSeams = {},
): EgressPolicyInput {
  const local = config.mode === "local";
  const port = target.port === "" ? (target.protocol === "http:" ? 80 : 443) : Number(target.port);
  return {
    schemes: local ? ["https:", "http:"] : ["https:"],
    ports: local ? [...new Set([443, 80, port])] : [443],
    allowPrivateNetwork: local ? "loopback" : false,
    redirects: { mode: "error" },
    timeouts: PROBE_TIMEOUTS,
    ...seams,
  };
}

/**
 * `POST /api/seller-check`: checks a paid resource the way the Rail402 catalog will, for a seller
 * about to list it. Makes the unpaid request or tool call under the egress policy above, validates
 * the 402 with the catalog's own code, and reports whether payTo can receive the asset, whether the
 * Playground's facilitator settles the scheme with sponsored fees and the bazaar extension, and
 * whether the domain's stellar.toml and payTo's home_domain verify the domain. The report holds only
 * what the seller published. The facilitator checked is always the Playground's own.
 */
export function mountSellerCheck(app: Hono<ServerEnv>, options: SellerCheckOptions): SellerCheck {
  const { config, metrics, log } = options;
  const now = options.now ?? Date.now;
  const perClient = new RateLimiter(
    config.limits.sellerCheckPerMinute,
    config.limits.sellerCheckPerMinute,
    now,
  );
  const global = new SharedRate(
    config.limits.sellerCheckGlobalPerMinute,
    config.limits.sellerCheckPerMinute,
    now,
  );
  const check = options.check ?? checkSellerOrigin;

  app.post(SELLER_CHECK_PATH, async (c) => {
    if (!config.features.sellerCheck) return refuse(c, "playground_feature_disabled");
    if (!sameOrigin(c.req.raw.headers, config.publicUrl)) return refuse(c, "playground_origin_not_allowed");
    if (!/^application\/json\b/i.test(c.req.header("content-type") ?? "")) {
      return refuse(c, "playground_request_invalid", { reason: "The body must be JSON (application/json)." });
    }
    const read = await readBody(c.req.raw, SELLER_CHECK_BODY_BYTES);
    if (!read.ok) {
      return refuse(c, "playground_request_too_large", {
        reason: `The seller check body exceeds ${String(SELLER_CHECK_BODY_BYTES)} bytes.`,
      });
    }
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read.body ?? new Uint8Array()));
    } catch {
      return refuse(c, "playground_request_invalid", { reason: "The body is not valid JSON." });
    }
    const parsed = sellerCheckRequestSchema.safeParse(json);
    if (!parsed.success) {
      const [issue] = parsed.error.issues;
      const path = issue?.path.join(".") ?? "";
      return refuse(c, "playground_request_invalid", {
        reason: `${path === "" ? "body" : path}: ${issue?.message ?? "invalid"}`,
      });
    }
    const body = parsed.data;
    const target = new URL(body.url);
    c.get("requestLog").fields["host"] = target.hostname.toLowerCase();

    const client = c.get("clientKey");
    const own = perClient.take(client);
    if (own > 0) {
      metrics.rateLimited.inc({ limit: "seller_check" });
      return refuse(c, "playground_rate_limited", { retryAfter: own });
    }
    const all = global.take(c.get("networkKey"));
    if (all > 0) {
      perClient.refund(client);
      metrics.rateLimited.inc({ limit: "seller_check_global" });
      return refuse(c, "playground_rate_limited", { retryAfter: all });
    }

    let report: OriginReport;
    try {
      report = await check(target.href, {
        network: config.network,
        rpcUrl: config.urls.rpc,
        facilitatorUrl: config.urls.facilitator,
        egress: sellerCheckEgress(config, target, options.egress),
        signal: c.req.raw.signal,
        ...(config.mode === "local" ? { allowLoopback: true } : {}),
        ...(body.method === undefined ? {} : { method: body.method }),
        ...(body.toolName === undefined ? {} : { toolName: body.toolName }),
        ...(body.arguments === undefined ? {} : { arguments: body.arguments }),
      });
    } catch (error) {
      if (c.req.raw.signal.aborted) {
        c.get("requestLog").fields["code"] = "client_closed";
        return new Response(null, { status: 499 });
      }
      if (isRail402Error(error)) {
        // The SDK's own refusals (seller_*) are public and coded.
        c.get("requestLog").fields["code"] = error.code;
        return new Response(JSON.stringify(toErrorBody(error)), {
          status: error.status,
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
      }
      log.error({ err: error, reqId: c.get("requestId") }, "seller check failed unexpectedly");
      return refuse(c, "playground_upstream_unavailable", {
        reason: "The check could not read the network or the facilitator; retry shortly.",
      });
    }
    c.get("requestLog").fields["ok"] = report.ok;
    return c.json(report, 200, { "cache-control": "no-store" });
  });

  return {
    sweep() {
      perClient.sweep();
      global.sweep();
    },
  };
}
