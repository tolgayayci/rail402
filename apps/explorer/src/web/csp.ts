import type { MiddlewareHandler } from "hono";
import { TRACKER } from "./analytics.ts";

/**
 * The Explorer's Content-Security-Policy: its own stylesheet and script only, no plugins, no base
 * rewriting, no framing, forms only to itself. Pages contain no inline script or style, so nothing
 * on-chain text could carry ever runs.
 */
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

/**
 * The policy with the optional analytics tracker on (`EXPLORER_ANALYTICS_SITE_ID`): its gateway is the
 * one other origin, allowed to serve the pinned script and to receive its events. Nothing else changes.
 */
export const ANALYTICS_CONTENT_SECURITY_POLICY = `default-src 'self'; script-src 'self' ${TRACKER.origin}; connect-src 'self' ${TRACKER.origin}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`;

/**
 * Security headers on every response. `no-transform` keeps a proxy in front from rewriting pages or
 * injecting scripts the policy would block.
 */
export function securityHeaders(options: { readonly analytics?: boolean } = {}): MiddlewareHandler {
  const policy = options.analytics === true ? ANALYTICS_CONTENT_SECURITY_POLICY : CONTENT_SECURITY_POLICY;
  return async (c, next) => {
    await next();
    c.header("Content-Security-Policy", policy);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    c.header("Cross-Origin-Opener-Policy", "same-origin");
    c.header("Cross-Origin-Resource-Policy", "same-origin");
    c.header("X-Frame-Options", "DENY");
    c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    const cache = c.res.headers.get("Cache-Control");
    if (cache === null) c.header("Cache-Control", "no-store, no-transform");
    else if (!cache.includes("no-transform")) c.header("Cache-Control", `${cache}, no-transform`);
  };
}
