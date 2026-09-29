import { baseAccount } from "./extract.ts";
import { resourceKey } from "./store.ts";
import type { ListFilter, Listing, PaymentOption, ResourceListings } from "./types.ts";

/** The x402 extensions a listing's resource declares: `bazaar`, which every listing has, and any others. */
export function declaredExtensions(listing: Listing): readonly string[] {
  return ["bazaar", ...(listing.content.extensions ?? [])];
}

/**
 * Whether a listing satisfies a discovery filter. `payTo`, `scheme` and `network` must all hold for
 * one and the same payment option: a listing that accepts USDC on testnet at one address and
 * something else on pubnet at another never matches a mix of the two.
 */
export function matchesFilter(listing: Listing, filter: Omit<ListFilter, "limit" | "offset">): boolean {
  if (filter.type !== undefined && listing.identity.kind !== filter.type) return false;
  if (filter.extensions !== undefined) {
    const declared = declaredExtensions(listing);
    if (!filter.extensions.every((key) => declared.includes(key))) return false;
  }
  if (filter.payTo === undefined && filter.scheme === undefined && filter.network === undefined) return true;
  return listing.content.accepts.some((option) => optionMatches(option, filter));
}

export function optionMatches(
  option: PaymentOption,
  filter: Pick<ListFilter, "payTo" | "scheme" | "network">,
): boolean {
  if (filter.scheme !== undefined && option.scheme !== filter.scheme) return false;
  if (filter.network !== undefined && option.network !== filter.network) return false;
  if (
    filter.payTo !== undefined &&
    option.payTo !== filter.payTo &&
    baseAccount(option.payTo) !== filter.payTo
  ) {
    return false;
  }
  return true;
}

/**
 * The listing with only the payment options `keep` accepts, and their Stellar facts. Discovery shows a
 * filtered resource with the options that matched: asking for testnet never returns a pubnet price.
 */
export function narrowOptions(listing: Listing, keep: (option: PaymentOption) => boolean): Listing {
  const kept = listing.content.accepts.map(keep);
  if (kept.every(Boolean)) return listing;
  const { facts } = listing;
  return {
    ...listing,
    content: { ...listing.content, accepts: listing.content.accepts.filter((_, index) => kept[index]) },
    ...(facts === undefined
      ? {}
      : { facts: { ...facts, options: facts.options.filter((_, index) => kept[index] === true) } }),
  };
}

/** Groups listings by resource, keeping the order in which each resource first appears. */
export function groupByResource(listings: Iterable<Listing>): ResourceListings[] {
  const groups = new Map<string, [Listing, ...Listing[]]>();
  for (const listing of listings) {
    const key = resourceKey(listing.identity);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [listing]);
    else group.push(listing);
  }
  return [...groups.values()];
}

/**
 * Catalog order: when a listing was first published, then insertion order. A newly published listing
 * appends at the end, so offset paging pinned with `asOf` never shifts.
 */
export function catalogOrder(a: Listing, b: Listing): number {
  return (a.listedAt?.getTime() ?? 0) - (b.listedAt?.getTime() ?? 0) || a.sequence - b.sequence;
}
