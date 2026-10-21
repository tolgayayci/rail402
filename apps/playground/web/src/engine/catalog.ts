/**
 * Bazaar reads for the page: search, the listing list, one listing and its version history, through
 * the Playground's Bazaar proxy. Results are judged like the buyer judges them (callable under the
 * transport's policy, priced within the spending policy), with or without a wallet.
 */
import {
  DiscoveryClient,
  checkUrlSyntax,
  toHit,
  type DiscoveryItem,
  type HitContext,
  type ListFilters,
  type SearchFilters,
  type SearchHit,
  type SearchPage as BuyerSearchPage,
} from "@rail402.dev/sdk/browser";
import type { StellarNetwork } from "@rail402.dev/stellar";
import { listingView, pathExampleOf, versionView } from "./decode.ts";
import type { ListingView, VersionView } from "./events.ts";

/** Discovery and search show published listings only; one listing's own read says its state. */
const LISTED = "published";

export interface CatalogOptions {
  readonly network: StellarNetwork;
  /** The Bazaar base URL (the proxy); the client appends `/discovery/…`. */
  readonly bazaarUrl: string;
  readonly operator: typeof fetch;
  /** Policy, adapters and egress policy results are judged against. */
  readonly hitContext: () => Omit<HitContext, "checkUrl">;
}

export interface CatalogSearch {
  /** The page as the buyer's `search` returns it (for the MCP tools). */
  readonly page: BuyerSearchPage;
  readonly views: readonly ListingView[];
}

export class Catalog {
  readonly #discovery: DiscoveryClient;
  readonly #options: CatalogOptions;

  constructor(options: CatalogOptions) {
    this.#options = options;
    this.#discovery = new DiscoveryClient({
      baseUrl: options.bazaarUrl,
      network: options.network,
      fetch: options.operator,
    });
  }

  #context(): HitContext {
    return { ...this.#options.hitContext(), checkUrl: checkUrlSyntax };
  }

  #view(item: DiscoveryItem, hit: SearchHit, state: ListingView["state"], rank: number | null): ListingView {
    const version = item.rail402.listings.find((listing) => listing.id === hit.listingId)?.version ?? 0;
    const { policy, adapters } = this.#options.hitContext();
    return listingView(hit, {
      network: this.#options.network,
      version,
      state,
      rank,
      pathExample: pathExampleOf(item),
      judge: { policy, adapters },
    });
  }

  async search(query: string, filters: SearchFilters = {}, signal?: AbortSignal): Promise<CatalogSearch> {
    const raw = await this.#discovery.search(query, filters, signal);
    const context = this.#context();
    const hits = raw.items.map((item) => toHit(item, context));
    const views: ListingView[] = [];
    raw.items.forEach((item, index) => {
      const hit = hits[index];
      if (hit?.listingId !== null && hit !== undefined) views.push(this.#view(item, hit, LISTED, index + 1));
    });
    return {
      page: { hits, nextCursor: raw.nextCursor, partialResults: raw.partialResults, method: raw.method },
      views,
    };
  }

  async list(
    filters: ListFilters = {},
    signal?: AbortSignal,
  ): Promise<{
    readonly views: readonly ListingView[];
    readonly total: number;
    readonly offset: number;
    readonly limit: number;
  }> {
    const raw = await this.#discovery.list(filters, signal);
    const context = this.#context();
    const views: ListingView[] = [];
    for (const item of raw.items) {
      const hit = toHit(item, context);
      if (hit.listingId !== null) views.push(this.#view(item, hit, LISTED, null));
    }
    return { views, ...raw.pagination };
  }

  async listing(
    id: string,
    signal?: AbortSignal,
  ): Promise<{ readonly hit: SearchHit; readonly view: ListingView }> {
    const item = await this.#discovery.listing(id, signal);
    const hit = toHit(item, this.#context());
    return { hit, view: this.#view(item, hit, item.state, null) };
  }

  async versions(id: string, signal?: AbortSignal): Promise<readonly VersionView[]> {
    return (await this.#discovery.versions(id, signal)).map(versionView);
  }
}
