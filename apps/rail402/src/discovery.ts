import { Hono, type Context } from "hono";
import { z } from "zod";
import { isRail402Error, toErrorBody } from "@rail402.dev/errors";
import type { SearchService } from "@rail402.dev/search";
import {
  baseAccount,
  bazaarError,
  toDiscoveryItem,
  toVersionItem,
  type CatalogStore,
} from "@rail402.dev/bazaar";

/** Largest page the list endpoint returns (x402 v2 §8.1: 1-100). Larger requests are clamped. */
export const MAX_PAGE = 100;
export const DEFAULT_PAGE = 20;

const TOKEN = /^[a-z][a-z0-9_-]{0,31}$/;
const CAIP2 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,64}$/;
const ADDRESS = /^[A-Z2-7]{56}$|^M[A-Z2-7]{68}$/;
const EXTENSION_LIST = /^[a-zA-Z0-9_-]{1,64}(,[a-zA-Z0-9_-]{1,64}){0,9}$/;

const listQuery = z.strictObject({
  type: z.string().regex(TOKEN, "must be a resource type such as http or mcp").optional(),
  payTo: z
    .string()
    .regex(ADDRESS, "must be a Stellar G…, C… or M… address")
    .refine((value) => baseAccount(value) !== undefined, "must be a Stellar G…, C… or M… address")
    .optional(),
  scheme: z.string().regex(TOKEN, "must be a scheme name such as exact").optional(),
  network: z.string().regex(CAIP2, "must be a CAIP-2 network such as stellar:testnet").optional(),
  extensions: z.string().regex(EXTENSION_LIST, "must be a comma-separated list of extension keys").optional(),
  limit: z.coerce.number().int().min(1, "must be at least 1").optional(),
  asOf: z.iso.datetime({ offset: true, message: "must be an ISO 8601 date-time" }).optional(),
  offset: z.coerce
    .number()
    .int()
    .min(0, "must be 0 or more")
    .max(1_000_000, "must be at most 1000000")
    .optional(),
});

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Search pages are advisory (bazaar spec); larger requests are clamped. */
export const MAX_SEARCH_PAGE = 50;
export const DEFAULT_SEARCH_PAGE = 10;

const searchQuery = z.strictObject({
  query: z.string().max(2_000, "must be at most 2000 characters"),
  type: listQuery.shape.type,
  payTo: listQuery.shape.payTo,
  scheme: listQuery.shape.scheme,
  network: listQuery.shape.network,
  extensions: listQuery.shape.extensions,
  asset: z
    .string()
    .regex(/^C[A-Z2-7]{55}$|^[A-Za-z0-9]{1,12}$/, "must be a C… contract address or an asset symbol")
    .optional(),
  maxPrice: z
    .string()
    .regex(
      /^\d{1,15}(\.\d{1,18})?$/,
      "must be a decimal amount, in the asset's units if asset is set, else in US dollars",
    )
    .optional(),
  limit: listQuery.shape.limit,
  cursor: z.string().max(512, "is too long").optional(),
});

/**
 * GET /discovery/resources and listing detail routes. Every filter is applied or rejected with a
 * coded 400; an unsupported parameter is never silently ignored. Filters on payTo, scheme and
 * network must hold for one and the same payment option of a listing. A resource sold on several
 * networks is one item; filtered, it shows only the payment options that matched. The detail routes
 * address one listing: one resource on one network.
 */
export function discoveryRoutes(store: CatalogStore, search?: SearchService): Hono {
  const app = new Hono();

  if (search !== undefined) {
    app.get("/search", async (c) => {
      const parsed = searchQuery.safeParse(c.req.query());
      if (!parsed.success) return invalid(c, parsed.error);
      const query = parsed.data;
      const limit = Math.min(query.limit ?? DEFAULT_SEARCH_PAGE, MAX_SEARCH_PAGE);
      try {
        const result = await search.search({
          query: query.query,
          filter: {
            ...(query.type === undefined ? {} : { type: query.type }),
            ...(query.payTo === undefined ? {} : { payTo: query.payTo }),
            ...(query.scheme === undefined ? {} : { scheme: query.scheme }),
            ...(query.network === undefined ? {} : { network: query.network }),
            ...(query.extensions === undefined ? {} : { extensions: query.extensions.split(",") }),
            ...(query.asset === undefined ? {} : { asset: query.asset }),
            ...(query.maxPrice === undefined
              ? {}
              : { maxPrice: { value: query.maxPrice, unit: query.asset === undefined ? "usd" : "asset" } }),
          },
          limit,
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        });
        return c.json({
          x402Version: 2,
          resources: result.resources.map(toDiscoveryItem),
          partialResults: result.partialResults,
          pagination: { limit: result.limit, cursor: result.nextCursor },
          rail402: { method: result.method, recognised: result.recognised, revision: result.revision },
        });
      } catch (error) {
        if (isRail402Error(error)) return c.json(toErrorBody(error), error.status as 400);
        throw error;
      }
    });
  }

  app.get("/resources", async (c) => {
    const parsed = listQuery.safeParse(c.req.query());
    if (!parsed.success) return invalid(c, parsed.error);
    const query = parsed.data;
    const limit = Math.min(query.limit ?? DEFAULT_PAGE, MAX_PAGE);
    const offset = query.offset ?? 0;
    // Pages of one pagination share its asOf, so listings published meanwhile never shift them.
    const now = new Date();
    const requested = query.asOf === undefined ? now : new Date(query.asOf);
    const asOf = requested.getTime() > now.getTime() ? now : requested;
    const { items, total } = await store.list({
      asOf,
      ...(query.type === undefined ? {} : { type: query.type }),
      ...(query.payTo === undefined ? {} : { payTo: query.payTo }),
      ...(query.scheme === undefined ? {} : { scheme: query.scheme }),
      ...(query.network === undefined ? {} : { network: query.network }),
      ...(query.extensions === undefined ? {} : { extensions: query.extensions.split(",") }),
      limit,
      offset,
    });
    return c.json({
      x402Version: 2,
      items: items.map(toDiscoveryItem),
      pagination: { limit, offset, total, asOf: asOf.toISOString() },
    });
  });

  app.get("/resources/:id", async (c) => {
    const id = c.req.param("id");
    const listing = ID.test(id) ? await store.get(id) : undefined;
    if (listing === undefined) return c.json(toErrorBody(bazaarError("discovery_listing_not_found")), 404);
    return c.json({ ...toDiscoveryItem([listing]), state: listing.state });
  });

  app.get("/resources/:id/versions", async (c) => {
    const id = c.req.param("id");
    const listing = ID.test(id) ? await store.get(id) : undefined;
    if (listing === undefined) return c.json(toErrorBody(bazaarError("discovery_listing_not_found")), 404);
    const versions = await store.versions(id);
    return c.json({ x402Version: 2, id, versions: versions.map(toVersionItem) });
  });

  return app;
}

function invalid(c: Context, error: z.ZodError) {
  const [issue] = error.issues;
  const reason =
    issue === undefined
      ? "A discovery query parameter is malformed."
      : issue.code === "unrecognized_keys"
        ? `Unsupported parameter: ${issue.keys.join(", ")}.`
        : `Parameter ${issue.path.join(".")} ${issue.message}.`;
  return c.json(toErrorBody(bazaarError("discovery_invalid_parameter", { reason })), 400);
}
