import { EgressError } from "./codes.ts";
import type { EgressPolicy } from "./limits.ts";
import { effectivePort } from "./shared.ts";
import { checkUrl } from "./url.ts";

/** Statuses that redirect. 300 and 304 do not: they are returned to the caller as they are. */
export const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

export interface Hop {
  readonly url: URL;
  readonly method: string;
  /** Whether the request body (and its content headers) is dropped for the next hop. */
  readonly dropBody: boolean;
}

/**
 * The next request of a `same-origin` redirect: the `Location` resolved against the current URL,
 * checked again against the policy, on the same host and port. The only scheme change allowed is an
 * upgrade from http to https on the same host; https never downgrades. Methods follow fetch: 303
 * (except for HEAD), and 301/302 after a POST, become a GET without a body.
 */
export function nextHop(
  current: URL,
  status: number,
  location: string,
  method: string,
  policy: EgressPolicy,
): Hop {
  let target: URL;
  try {
    target = new URL(location, current);
  } catch {
    throw new EgressError("egress_redirect_not_allowed", "redirect", {
      reason: "The redirect Location is not a valid URL.",
    });
  }
  const upgrade = current.protocol === "http:" && target.protocol === "https:";
  const sameOrigin =
    target.hostname === current.hostname &&
    (upgrade
      ? effectivePort(target) === 443
      : target.protocol === current.protocol && effectivePort(target) === effectivePort(current));
  if (!sameOrigin) {
    throw new EgressError("egress_redirect_not_allowed", "redirect", {
      reason: "The server redirected to another origin; only same-origin redirects are followed.",
    });
  }
  const url = checkUrl(target, policy);
  const toGet =
    (status === 303 && method !== "HEAD") || ((status === 301 || status === 302) && method === "POST");
  return { url, method: toGet ? "GET" : method, dropBody: toGet };
}
