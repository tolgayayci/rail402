/**
 * Runs interoperability fixtures through Rail402's own cataloging and discovery: each fixture's
 * payment is settled into the catalog, its origin check answers with the fixture's 402, and the
 * resource is read back over the discovery HTTP routes.
 */
import { createHash } from "node:crypto";
import { Hono } from "hono";
import {
  Catalog,
  canonicalJson,
  type CatalogOutcome,
  type CatalogStore,
  type SchemaSandbox,
  type SettledPayment,
} from "@rail402.dev/bazaar";
import { AssetRegistry, SearchService } from "@rail402.dev/search";
import { discoveryRoutes } from "@rail402.dev/service";
import { USDC, type InteropFixture } from "./fixtures.ts";

/** A discovery item as the routes publish it, with the fields the fixtures compare. */
export interface PublishedItem {
  readonly resource: string;
  readonly type: string;
  readonly x402Version: number;
  readonly accepts: readonly Record<string, unknown>[];
  readonly description?: string;
  readonly mimeType?: string;
  readonly serviceName?: string;
  readonly tags?: readonly string[];
  readonly iconUrl?: string;
  readonly extensions: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly rail402: { readonly method?: string; readonly toolName?: string };
}

/** The settled payment a buyer of the fixture's resource would produce. */
export function settlementOf(fixture: InteropFixture): SettledPayment {
  const [accepted] = fixture.paymentRequired.accepts;
  if (accepted === undefined) throw new Error(`${fixture.id}: the 402 offers no payment option`);
  return {
    payload: {
      x402Version: 2,
      resource: { ...fixture.paymentRequired.resource, url: fixture.paidUrl },
      accepted,
      payload: { transaction: "AAAA" },
      ...(fixture.paymentRequired.extensions === undefined
        ? {}
        : { extensions: fixture.paymentRequired.extensions }),
    },
    requirements: { ...accepted, amount: fixture.settledAmount },
    payer: fixture.payer,
    transaction: createHash("sha256").update(`settlement:${fixture.id}`).digest("hex"),
  };
}

export interface RoundTrip {
  /** The discovery routes, mounted at `/discovery` as the service mounts them. */
  readonly app: Hono;
  readonly catalog: Catalog;
  /** Each fixture's cataloging outcome at settlement, by fixture id. */
  readonly outcomes: ReadonlyMap<string, CatalogOutcome | undefined>;
}

/**
 * Catalogs every fixture into `store` as a settlement followed by its origin check, and returns the
 * discovery routes over the result. Search is lexical-only: the fixtures check what is published,
 * not how it ranks.
 */
export async function catalogFixtures(
  store: CatalogStore,
  sandbox: SchemaSandbox,
  fixtures: readonly InteropFixture[],
): Promise<RoundTrip> {
  const byUrl = new Map(fixtures.map((fixture) => [fixture.paidUrl, fixture]));
  const answer = (url: string) => {
    const fixture = byUrl.get(url);
    return Promise.resolve(
      fixture === undefined
        ? ({ kind: "unreachable", reason: "not a fixture" } as const)
        : ({ kind: "payment_required", paymentRequired: fixture.paymentRequired } as const),
    );
  };
  const catalog = new Catalog({ store, sandbox, fetchOrigin: answer, probeTool: answer });
  const outcomes = new Map<string, CatalogOutcome | undefined>();
  for (const fixture of fixtures)
    outcomes.set(fixture.id, await catalog.recordDurably(settlementOf(fixture)));
  while ((await store.dueOriginChecks(1)).length > 0) await catalog.checkOrigins(50);
  const search = new SearchService({
    store,
    assets: new AssetRegistry(
      Object.entries(USDC).map(([network, contract]) => ({
        network,
        contract,
        symbol: "USDC",
        decimals: 7,
        usd: true,
      })),
    ),
    cursorSecret: Buffer.alloc(32, 7),
  });
  return { app: new Hono().route("/discovery", discoveryRoutes(store, search)), catalog, outcomes };
}

/**
 * How a published item differs from its fixture in what the Bazaar specification defines: resource,
 * type, payment options, the bazaar extension, MCP tool name and service metadata. Empty when they
 * are equal, field by field, as canonical JSON. The declared differences are checked separately.
 */
export function differences(item: PublishedItem, fixture: InteropFixture): string[] {
  const found: string[] = [];
  const same = (field: string, actual: unknown, expected: unknown) => {
    if (canonicalJson(actual ?? null) !== canonicalJson(expected ?? null)) {
      found.push(`${field}: ${canonicalJson(actual ?? null)} != ${canonicalJson(expected ?? null)}`);
    }
  };
  same("resource", item.resource, fixture.expected.resource);
  same("type", item.type, fixture.expected.type);
  same("x402Version", item.x402Version, 2);
  same("accepts", item.accepts, fixture.paymentRequired.accepts);
  const declared = (fixture.paymentRequired.extensions?.["bazaar"] ?? {}) as Record<string, unknown>;
  const published = item.extensions["bazaar"] ?? {};
  for (const field of ["info", "schema", "routeTemplate"])
    same(`bazaar.${field}`, published[field], declared[field]);
  same("rail402.method", item.rail402.method, fixture.expected.method);
  same("rail402.toolName", item.rail402.toolName, fixture.expected.toolName);
  const resource = fixture.paymentRequired.resource as unknown as Record<string, unknown>;
  for (const field of ["description", "mimeType", "serviceName", "tags", "iconUrl"] as const) {
    same(field, item[field], resource[field]);
  }
  return found;
}
