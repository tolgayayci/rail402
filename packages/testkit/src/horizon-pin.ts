/**
 * Pins the ledger-time estimate that @x402/stellar reads from public Horizon.
 *
 * The stock client and the upstream verifier both turn `maxTimeoutSeconds` into ledgers with
 * `ceil(maxTimeoutSeconds / est)`, where `est` is the average close time of the 20 latest ledgers on
 * `horizon-testnet.stellar.org` (or `horizon.stellar.org`), falling back to 5 s when Horizon fails.
 * That lookup is hard-wired to the public network even when the RPC is a private one, so tests that
 * assert exact expiration ledgers pin it here.
 *
 * The Stellar SDK's HTTP client calls the global `fetch` on every request, so replacing
 * `globalThis.fetch` covers the stock client, the upstream verifier and the SDK's Horizon server in
 * this process. Every other request goes to the real `fetch` unchanged.
 */

/** The public Horizon origins upstream reads its estimate from. */
export const HORIZON_ORIGINS = [
  "https://horizon-testnet.stellar.org",
  "https://horizon.stellar.org",
] as const;

export type HorizonPinMode =
  /** Serve 20 ledgers exactly `seconds` apart. */
  | { readonly seconds: number }
  /** Answer every Horizon request with HTTP `status`, so upstream falls back to its default. */
  | { readonly status: number };

export interface HorizonPin {
  /** Changes what the pinned Horizon answers. */
  set(mode: HorizonPinMode): void;
  /** How many Horizon requests the pin has answered. */
  readonly requests: number;
  /** Restores the `fetch` that was installed before the pin. */
  restore(): void;
}

const SAMPLE = 20;

/** Replaces `globalThis.fetch` so that public Horizon answers with evenly spaced ledgers. */
export function pinHorizon(mode: HorizonPinMode = { seconds: 5 }): HorizonPin {
  const original = globalThis.fetch;
  let current = mode;
  let requests = 0;

  const pinned: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (!HORIZON_ORIGINS.some((origin) => url.origin === origin)) return original(input, init);
    requests += 1;
    if ("status" in current) {
      return Promise.resolve(new Response("pinned Horizon failure", { status: current.status }));
    }
    if (url.pathname !== "/ledgers") {
      return Promise.resolve(new Response("not pinned", { status: 404 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify(ledgerPage(url, current.seconds)), {
        status: 200,
        headers: { "content-type": "application/hal+json" },
      }),
    );
  };
  globalThis.fetch = pinned;

  return {
    set(next) {
      current = next;
    },
    get requests() {
      return requests;
    },
    restore() {
      if (globalThis.fetch === pinned) globalThis.fetch = original;
    },
  };
}

/** A Horizon `/ledgers?order=desc` page whose records close exactly `seconds` apart. */
function ledgerPage(url: URL, seconds: number) {
  const now = Math.floor(Date.now() / 1_000);
  const newest = 1_000_000;
  const records = Array.from({ length: SAMPLE }, (_, index) => ({
    id: String(newest - index),
    paging_token: String((newest - index) * 4096),
    sequence: newest - index,
    closed_at: new Date((now - index * seconds) * 1_000).toISOString(),
  }));
  const self = url.toString();
  return {
    _links: { self: { href: self }, next: { href: self }, prev: { href: self } },
    _embedded: { records },
  };
}
