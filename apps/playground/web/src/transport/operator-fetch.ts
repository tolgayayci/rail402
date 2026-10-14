/**
 * The fetch for operator endpoints: the Bazaar and the facilitator's `/supported`. Hosted Rail402
 * sends no CORS headers, so the page reaches both through the Playground's fixed same-origin proxies
 * (`/api/bazaar/…`, `/api/facilitator/…`). This fetch refuses anything else, so a seller URL can never
 * travel through it.
 */

/** Path prefixes of the Playground's operator proxies. */
export const OPERATOR_PREFIXES = Object.freeze(["/api/bazaar/", "/api/facilitator/"]);

/** The Bazaar base URL the SDK's discovery client uses: it appends `/discovery/…`. */
export function bazaarProxyUrl(origin: string): string {
  return new URL("/api/bazaar", origin).href;
}

/** The facilitator base URL the SDK's transaction inspector uses: it appends `/supported`. */
export function facilitatorProxyUrl(origin: string): string {
  return new URL("/api/facilitator", origin).href;
}

export function createOperatorFetch(options: {
  readonly origin: string;
  readonly fetch?: typeof fetch;
}): typeof fetch {
  const origin = new URL(options.origin).origin;
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);
  return (input, init) => {
    let url: URL;
    try {
      url = new URL(input instanceof Request ? input.url : String(input), origin);
    } catch {
      return Promise.reject(new TypeError("operator requests need a valid URL"));
    }
    if (url.origin !== origin || !OPERATOR_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) {
      return Promise.reject(
        new TypeError("operator requests go only to the Playground's Bazaar and facilitator proxies"),
      );
    }
    return send(url.href, { ...init, credentials: "same-origin", redirect: "error" });
  };
}
