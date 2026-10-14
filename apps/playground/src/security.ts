import type { MiddlewareHandler } from "hono";

/**
 * The page's Content-Security-Policy. Scripts, styles, fonts and images come only from the
 * Playground's own origin; the page may connect to it and to the Stellar endpoints it calls directly
 * (RPC, Horizon, Friendbot). There is no inline script and no third-party code.
 */
export function contentSecurityPolicy(connectOrigins: readonly string[]): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    `connect-src ${["'self'", ...connectOrigins].join(" ")}`,
    "img-src 'self' data:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Headers sent with every response. HSTS only when the public origin is https. */
export function securityHeaders(options: {
  readonly connectOrigins: readonly string[];
  readonly https: boolean;
}): MiddlewareHandler {
  const headers: [string, string][] = [
    ["Content-Security-Policy", contentSecurityPolicy(options.connectOrigins)],
    ["X-Content-Type-Options", "nosniff"],
    ["Referrer-Policy", "no-referrer"],
    ["Cross-Origin-Opener-Policy", "same-origin"],
    ["Cross-Origin-Resource-Policy", "same-origin"],
    ["X-Frame-Options", "DENY"],
    ["Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()"],
  ];
  if (options.https) headers.push(["Strict-Transport-Security", "max-age=31536000; includeSubDomains"]);
  return async (c, next) => {
    await next();
    for (const [name, value] of headers) {
      if (!c.res.headers.has(name)) c.res.headers.set(name, value);
    }
  };
}

/**
 * Whether a state-changing API request comes from the Playground page itself. The custom request
 * headers these endpoints require already rule out a cross-site form; in addition `Sec-Fetch-Site`,
 * when the browser sends it, must be `same-origin`, and `Origin`, when sent, must be the Playground's
 * public origin. No CORS headers are ever answered, so another site cannot read a reply either.
 * Clients that are not browsers send neither header and pass: this stops other sites from using
 * their visitors' browsers, not scripts, which only the limits bound.
 */
export function sameOrigin(
  headers: { readonly get: (name: string) => string | null | undefined },
  publicOrigin: string,
): boolean {
  const site = headers.get("sec-fetch-site");
  if (site !== null && site !== undefined && site !== "same-origin") return false;
  const origin = headers.get("origin");
  if (origin !== null && origin !== undefined && origin !== publicOrigin) return false;
  return true;
}
