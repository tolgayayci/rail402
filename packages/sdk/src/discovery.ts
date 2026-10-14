import { z } from "zod";
import { baseAccount, type StellarNetwork } from "@rail402.dev/stellar";
import { concatBytes, utf8Decode } from "./bytes.ts";
import { paymentError, type PaymentError } from "./codes.ts";
import { redact, sanitizeText } from "./redact.ts";

/**
 * A client for a Rail402 Bazaar: GET /discovery/search, GET /discovery/resources and the listing
 * routes. The Bazaar URL is operator configuration, so requests use the platform `fetch`; answers are
 * validated, size-bounded and time-bounded, and every request is scoped to the buyer's network.
 */

/** Largest discovery answer read. */
export const MAX_DISCOVERY_RESPONSE_BYTES = 2 * 1_024 * 1_024;
export const DISCOVERY_TIMEOUT_MS = 10_000;
/** Most results one search page asks for, and most items one list page asks for. */
export const MAX_SEARCH_LIMIT = 50;
export const MAX_LIST_LIMIT = 100;

export interface SearchFilters {
  readonly type?: "http" | "mcp";
  /** Only resources paid to this G…, C… or M… address. */
  readonly payTo?: string;
  readonly scheme?: string;
  /** A C… token contract or a symbol; with `maxPrice`, the price is in this asset's units. */
  readonly asset?: string;
  /** A decimal amount: in `asset` units when set, otherwise in US dollars. */
  readonly maxPrice?: string;
  readonly extensions?: readonly string[];
  readonly limit?: number;
  /** `nextCursor` of the previous page. */
  readonly cursor?: string;
}

export interface ListFilters {
  readonly type?: string;
  readonly payTo?: string;
  readonly scheme?: string;
  readonly extensions?: readonly string[];
  readonly limit?: number;
  readonly offset?: number;
  /** ISO date-time; pages of one pagination share it, so new listings never shift them. */
  readonly asOf?: string;
}

const optionSchema = z.looseObject({
  scheme: z.string(),
  network: z.string(),
  asset: z.string(),
  payTo: z.string(),
  amount: z.string(),
  maxTimeoutSeconds: z.number().optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
});

const trustSchema = z.enum(["settled", "origin_verified", "domain_verified"]);

const itemSchema = z.looseObject({
  resource: z.string(),
  type: z.string(),
  x402Version: z.literal(2),
  accepts: z.array(optionSchema),
  lastUpdated: z.string(),
  description: z.string().optional(),
  mimeType: z.string().optional(),
  serviceName: z.string().optional(),
  tags: z.array(z.string()).optional(),
  extensions: z.record(z.string(), z.record(z.string(), z.unknown())),
  rail402: z.looseObject({
    method: z.string().optional(),
    toolName: z.string().optional(),
    trust: trustSchema,
    settlements: z.number(),
    listings: z.array(
      z.looseObject({
        id: z.string(),
        network: z.string(),
        version: z.number(),
        trust: trustSchema,
        owner: z.string(),
        settlements: z.number(),
      }),
    ),
    options: z.array(
      z.looseObject({
        listing: z.string(),
        symbol: z.string().optional(),
        decimals: z.number().int().optional(),
        receivable: z.boolean().optional(),
      }),
    ),
  }),
});

const searchSchema = z.looseObject({
  resources: z.array(itemSchema),
  partialResults: z.boolean(),
  pagination: z.looseObject({ limit: z.number(), cursor: z.string().nullable().optional() }),
  rail402: z
    .looseObject({ method: z.string().optional(), recognised: z.array(z.unknown()).optional() })
    .optional(),
});

const listSchema = z.looseObject({
  items: z.array(itemSchema),
  pagination: z.looseObject({
    limit: z.number(),
    offset: z.number(),
    total: z.number(),
    asOf: z.string().optional(),
  }),
});

const listingSchema = itemSchema.extend({ state: z.enum(["pending", "published", "quarantined"]) });

const versionsSchema = z.looseObject({
  id: z.string(),
  versions: z.array(
    z.looseObject({
      version: z.number().int(),
      createdAt: z.string(),
      cause: z.string(),
      transaction: z.string().optional(),
      owner: z.string(),
      trust: trustSchema,
      state: z.string(),
      content: z.unknown(),
    }),
  ),
});

/** One entry of a listing's public version history. `content` is the seller's metadata: untrusted. */
export type ListingVersion = z.infer<typeof versionsSchema>["versions"][number];

const errorSchema = z.looseObject({
  error: z.looseObject({ code: z.string(), reason: z.string() }),
});

/** A resource as the Bazaar publishes it (x402 v2 discovery item with Rail402's facts). */
export type DiscoveryItem = z.infer<typeof itemSchema>;
export type ListingState = "pending" | "published" | "quarantined";

export interface RawSearchPage {
  readonly items: readonly DiscoveryItem[];
  readonly nextCursor: string | null;
  readonly partialResults: boolean;
  readonly method: string | undefined;
}

export interface RawListPage {
  readonly items: readonly DiscoveryItem[];
  readonly pagination: {
    readonly limit: number;
    readonly offset: number;
    readonly total: number;
    readonly asOf: string | undefined;
  };
}

export interface DiscoveryClientOptions {
  /** The Bazaar's base URL, e.g. https://testnet.rail402.dev. */
  readonly baseUrl: string;
  readonly network: StellarNetwork;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export class DiscoveryClient {
  private readonly baseUrl: string;
  private readonly network: StellarNetwork;
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: DiscoveryClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.network = options.network;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DISCOVERY_TIMEOUT_MS;
  }

  /** GET /discovery/search, always scoped to the buyer's network. */
  async search(query: string, filters: SearchFilters = {}, signal?: AbortSignal): Promise<RawSearchPage> {
    const params = new URLSearchParams({ query, network: this.network });
    setFilter(params, "type", filters.type);
    setFilter(params, "payTo", filters.payTo);
    setFilter(params, "scheme", filters.scheme);
    setFilter(params, "asset", filters.asset);
    setFilter(params, "maxPrice", filters.maxPrice);
    setFilter(params, "extensions", filters.extensions?.join(","));
    setFilter(params, "limit", clampLimit(filters.limit, MAX_SEARCH_LIMIT));
    setFilter(params, "cursor", filters.cursor);
    const body = shape(searchSchema, await this.get(`/discovery/search?${params.toString()}`, signal));
    return {
      items: body.resources,
      nextCursor: body.pagination.cursor ?? null,
      partialResults: body.partialResults,
      method: body.rail402?.method,
    };
  }

  /** GET /discovery/resources, always scoped to the buyer's network. */
  async list(filters: ListFilters = {}, signal?: AbortSignal): Promise<RawListPage> {
    const params = new URLSearchParams({ network: this.network });
    setFilter(params, "type", filters.type);
    setFilter(params, "payTo", filters.payTo);
    setFilter(params, "scheme", filters.scheme);
    setFilter(params, "extensions", filters.extensions?.join(","));
    setFilter(params, "limit", clampLimit(filters.limit, MAX_LIST_LIMIT));
    setFilter(params, "offset", filters.offset);
    setFilter(params, "asOf", filters.asOf);
    const body = shape(listSchema, await this.get(`/discovery/resources?${params.toString()}`, signal));
    return {
      items: body.items,
      pagination: { ...body.pagination, asOf: body.pagination.asOf },
    };
  }

  /** GET /discovery/resources/{id}: one listing, one resource on one network. */
  async listing(id: string, signal?: AbortSignal): Promise<DiscoveryItem & { readonly state: ListingState }> {
    if (!LISTING_ID.test(id)) {
      throw paymentError("listing_not_found", { reason: "A listing id is a lowercase UUID." });
    }
    return shape(listingSchema, await this.get(`/discovery/resources/${id}`, signal, true));
  }

  /** GET /discovery/resources/{id}/versions: the listing's public version history, oldest first. */
  async versions(id: string, signal?: AbortSignal): Promise<readonly ListingVersion[]> {
    if (!LISTING_ID.test(id)) {
      throw paymentError("listing_not_found", { reason: "A listing id is a lowercase UUID." });
    }
    return shape(versionsSchema, await this.get(`/discovery/resources/${id}/versions`, signal, true))
      .versions;
  }

  private async get(path: string, signal: AbortSignal | undefined, listing = false): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: combined,
      });
    } catch (error) {
      if (signal?.aborted === true) throw signal.reason;
      throw unavailable(error);
    }
    let body: unknown;
    try {
      body = JSON.parse(await readBounded(response, MAX_DISCOVERY_RESPONSE_BYTES));
    } catch (error) {
      if (signal?.aborted === true) throw signal.reason;
      if (response.status >= 500) throw unavailable(error);
      throw paymentError("discovery_rejected", {
        reason: "The Bazaar's answer is not valid JSON or is too large.",
      });
    }
    if (response.ok) return body;
    if (response.status >= 500 || response.status === 429) {
      throw paymentError("discovery_unavailable", { details: { status: response.status } });
    }
    const coded = errorSchema.safeParse(body);
    if (listing && response.status === 404) throw paymentError("listing_not_found");
    throw paymentError("discovery_rejected", {
      ...(coded.success
        ? {
            reason: `The Bazaar refused the request: ${sanitizeText(coded.data.error.reason, 300)}`,
            details: {
              upstream: { code: coded.data.error.code, reason: sanitizeText(coded.data.error.reason, 300) },
            },
          }
        : { details: { status: response.status } }),
    });
  }
}

/** Validates a Bazaar answer; an unexpected shape is `discovery_rejected`. */
function shape<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  throw paymentError("discovery_rejected", {
    reason: "The Bazaar's answer does not have the discovery shape this client understands.",
  });
}

const LISTING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function setFilter(params: URLSearchParams, name: string, value: string | number | undefined): void {
  if (value !== undefined) params.set(name, String(value));
}

function clampLimit(limit: number | undefined, max: number): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isInteger(limit) || limit < 1) {
    throw paymentError("discovery_rejected", { reason: `limit must be an integer from 1 to ${max}.` });
  }
  return Math.min(limit, max);
}

function unavailable(error: unknown): PaymentError {
  return paymentError("discovery_unavailable", {
    reason: `The Bazaar could not be reached: ${redact(error instanceof Error ? error.message : String(error)).slice(0, 200)}`,
  });
}

/** Reads a response body as text, refusing more than `max` bytes. */
export async function readBounded(response: Response, max: number): Promise<string> {
  if (response.body === null) return "";
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new RangeError("response too large");
    }
    chunks.push(value);
  }
  return utf8Decode(concatBytes(chunks));
}

/** The listing of an item on one network, with its owner as a base account. */
export function listingOn(
  item: DiscoveryItem,
  network: StellarNetwork,
):
  | { readonly id: string; readonly owner: string; readonly trust: DiscoveryItem["rail402"]["trust"] }
  | undefined {
  const listing = item.rail402.listings.find((candidate) => candidate.network === network);
  if (listing === undefined) return undefined;
  const owner = baseAccount(listing.owner);
  return owner === undefined ? undefined : { id: listing.id, owner, trust: listing.trust };
}
