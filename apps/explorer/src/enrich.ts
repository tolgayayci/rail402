import type { FetchLike } from "./rpc.js";
import type { ExplorerStore } from "./db.js";
import type { SellerMeta } from "./types.js";

/**
 * Seller enrichment: payTo address → Bazaar listing (serviceName, resource, description).
 *
 * This is the join no address-allowlist explorer can make — the Bazaar knows WHAT was bought.
 * Strictly advisory: a failure or a miss never blocks a payment row, results are cached in the
 * store, and a negative result is cached too (shorter TTL) so an unlisted seller does not trigger
 * a Bazaar query on every poll.
 */

const HIT_TTL_MS = 60 * 60 * 1000;
const MISS_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5_000;

export interface Enricher {
  lookup(network: string, payTo: string): Promise<SellerMeta | undefined>;
}

export function createBazaarEnricher(
  store: ExplorerStore,
  bazaarUrl: string,
  fetchImpl: FetchLike = fetch,
  now: () => number = Date.now,
): Enricher {
  return {
    async lookup(network: string, payTo: string): Promise<SellerMeta | undefined> {
      const cached = store.getSellerMeta(network, payTo);
      if (cached) {
        const age = now() - Date.parse(cached.fetchedAt);
        const ttl = cached.serviceName !== undefined || cached.resource !== undefined
          ? HIT_TTL_MS
          : MISS_TTL_MS;
        if (age < ttl) return cached.serviceName !== undefined || cached.resource !== undefined
          ? cached
          : undefined;
      }

      let meta: SellerMeta = { network, payTo, fetchedAt: new Date(now()).toISOString() };
      try {
        const url = new URL("/discovery/resources", bazaarUrl);
        url.searchParams.set("payTo", payTo);
        url.searchParams.set("limit", "1");
        const response = await fetchImpl(url.toString(), {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (response.ok) {
          const body = (await response.json()) as {
            items?: { resource?: string; serviceName?: string; description?: string }[];
          };
          const item = body.items?.[0];
          if (item) {
            meta = {
              network,
              payTo,
              ...(typeof item.serviceName === "string" ? { serviceName: item.serviceName } : {}),
              ...(typeof item.resource === "string" ? { resource: item.resource } : {}),
              ...(typeof item.description === "string" ? { description: item.description } : {}),
              fetchedAt: new Date(now()).toISOString(),
            };
          }
        }
      } catch {
        // Advisory: an unreachable Bazaar costs enrichment, never a row. The miss is cached with
        // the shorter TTL so the next poll retries eventually rather than immediately.
      }
      store.setSellerMeta(meta);
      return meta.serviceName !== undefined || meta.resource !== undefined ? meta : undefined;
    },
  };
}
