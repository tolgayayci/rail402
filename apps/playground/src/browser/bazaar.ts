import { stroopsToDisplay } from "../shared/amounts.js";

/**
 * Browser client for the Bazaar scene: natural-language search over the live catalog and paginated
 * browsing, both through the playground's same-origin proxy (so no facilitator CORS config is
 * needed). Results are shaped for direct rendering and for the "Try in Playground" deep link.
 *
 * The catalog is live and community-fed, so entries vary from richly described to bare. Fields are
 * read defensively and a sparse entry still yields a legible row.
 */

export interface BazaarResource {
  readonly url: string;
  readonly description: string | undefined;
  readonly serviceName: string | undefined;
  readonly scheme: string | undefined;
  readonly network: string | undefined;
  /** Price of the cheapest accepted option, in stroops, or undefined if unpriceable. */
  readonly priceStroops: string | undefined;
  /** Human display of the price, e.g. "0.05 USDC". */
  readonly priceDisplay: string | undefined;
  /** Deep-link query for the first-payment scene: `?try=<url>`. */
  readonly tryUrl: string;
  readonly raw: unknown;
}

export interface SearchResult {
  readonly resources: readonly BazaarResource[];
  readonly partialResults: boolean;
  readonly cursor: string | undefined;
}

export async function searchBazaar(
  playgroundUrl: string,
  query: string,
  options: { limit?: number; cursor?: string; fetchImpl?: typeof fetch } = {},
): Promise<SearchResult> {
  const { limit = 20, cursor, fetchImpl = fetch } = options;
  const params = new URLSearchParams({ query, limit: String(limit) });
  if (cursor) params.set("cursor", cursor);

  const res = await fetchImpl(`${playgroundUrl}/bazaar/search?${params.toString()}`);
  const body = (await res.json().catch(() => ({}))) as {
    resources?: unknown[];
    partialResults?: boolean;
    pagination?: { cursor?: string } | null;
    reason?: string;
  };
  if (!res.ok) throw new Error(body.reason ?? `Bazaar search failed (${res.status}).`);

  return {
    resources: (body.resources ?? []).map(toResource),
    partialResults: body.partialResults === true,
    cursor: body.pagination?.cursor,
  };
}

function toResource(entry: unknown): BazaarResource {
  const e = (entry ?? {}) as Record<string, unknown>;
  const resource = (e["resource"] ?? {}) as Record<string, unknown>;
  const accepts = Array.isArray(e["accepts"]) ? (e["accepts"] as Array<Record<string, unknown>>) : [];

  const url = str(resource["url"]) ?? str(e["url"]) ?? "";
  const priceStroops = cheapestPrice(accepts);

  return {
    url,
    description: str(resource["description"]) ?? str(e["description"]),
    serviceName: str(resource["serviceName"]),
    scheme: str(accepts[0]?.["scheme"]),
    network: str(accepts[0]?.["network"]),
    priceStroops,
    priceDisplay: priceStroops !== undefined ? `${stroopsToDisplay(BigInt(priceStroops))} USDC` : undefined,
    tryUrl: `?try=${encodeURIComponent(url)}`,
    raw: entry,
  };
}

function cheapestPrice(accepts: Array<Record<string, unknown>>): string | undefined {
  let min: bigint | undefined;
  for (const option of accepts) {
    const amount = str(option["amount"]);
    if (amount === undefined) continue;
    let value: bigint;
    try {
      value = BigInt(amount);
    } catch {
      continue;
    }
    if (min === undefined || value < min) min = value;
  }
  return min?.toString();
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
