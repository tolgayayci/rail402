import { afterAll, describe, expect, it } from "vitest";
import {
  Catalog,
  MemoryCatalogStore,
  SchemaSandbox,
  paymentRequiredFor,
  randomAddress,
  settledPayment,
} from "@rail402.dev/bazaar";
import type { PaymentRequired } from "@x402/core/types";
import { AssetRegistry, SearchService } from "@rail402.dev/search";
import { discoveryRoutes } from "@rail402.dev/service";

const USDC_TESTNET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

const sandbox = new SchemaSandbox();
afterAll(async () => {
  await sandbox.close();
});

/** Discovery routes over a memory catalog of `count` published weather listings, lexical search only. */
async function discovery(count: number) {
  const store = new MemoryCatalogStore();
  const origins = new Map<string, PaymentRequired>();
  const catalog = new Catalog({
    store,
    sandbox,
    fetchOrigin: (url) => {
      const paymentRequired = origins.get(url);
      return Promise.resolve(
        paymentRequired === undefined
          ? { kind: "unreachable", reason: "offline" }
          : { kind: "payment_required", paymentRequired },
      );
    },
  });
  for (let i = 0; i < count; i++) {
    // One seller each: a single payTo may only create 20 listings an hour.
    const fixture = {
      url: `https://api${String(i)}.example.com/weather`,
      payTo: randomAddress(),
      description: "City weather",
    };
    origins.set(fixture.url, paymentRequiredFor(fixture));
    await catalog.record(settledPayment(fixture));
  }
  // Each listing is published once its origin's 402 confirms it.
  while ((await store.dueOriginChecks(1)).length > 0) await catalog.checkOrigins(50);
  const search = new SearchService({
    store,
    assets: new AssetRegistry([
      { network: "stellar:testnet", contract: USDC_TESTNET, symbol: "USDC", decimals: 7, usd: true },
    ]),
    cursorSecret: Buffer.alloc(32, 1),
  });
  return discoveryRoutes(store, search);
}

async function errorCode(response: Response): Promise<string | undefined> {
  return ((await response.json()) as { error?: { code?: string } }).error?.code;
}

const keys = (count: number) => Array.from({ length: count }, (_, i) => `ext${String(i)}`).join(",");

describe("GET /discovery/resources parameters", () => {
  it("accepts an offset up to 1,000,000", async () => {
    const app = await discovery(1);
    const response = await app.request("/resources?offset=1000000");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [], pagination: { offset: 1_000_000, total: 1 } });

    const beyond = await app.request("/resources?offset=1000001");
    expect(beyond.status).toBe(400);
    expect(await errorCode(beyond)).toBe("discovery_invalid_parameter");
  });

  it("refuses a payTo that is not a valid Stellar address, such as a secret seed", async () => {
    const app = await discovery(1);
    const account = randomAddress();
    const corrupted = `${account.slice(0, 55)}${account.endsWith("A") ? "B" : "A"}`;
    for (const payTo of [corrupted, `S${account.slice(1)}`]) {
      const response = await app.request(`/resources?payTo=${payTo}`);
      expect(response.status, payTo).toBe(400);
      expect(await errorCode(response)).toBe("discovery_invalid_parameter");
    }
    expect((await app.request(`/resources?payTo=${account}`)).status).toBe(200);
  });

  it("reports the asOf that pins a pagination and accepts it back", async () => {
    const app = await discovery(3);
    const first = (await (await app.request("/resources?limit=1")).json()) as {
      pagination: { asOf: string; total: number };
    };
    expect(Date.parse(first.pagination.asOf)).not.toBeNaN();
    const next = await app.request(
      `/resources?limit=1&offset=1&asOf=${encodeURIComponent(first.pagination.asOf)}`,
    );
    expect(((await next.json()) as { pagination: { asOf: string } }).pagination.asOf).toBe(
      first.pagination.asOf,
    );
    const past = (await (await app.request("/resources?asOf=2000-01-01T00:00:00Z")).json()) as {
      pagination: { total: number };
    };
    expect(past.pagination.total).toBe(0);
    const bad = await app.request("/resources?asOf=yesterday");
    expect(bad.status).toBe(400);
    expect(await errorCode(bad)).toBe("discovery_invalid_parameter");
  });

  it("accepts at most 10 extension keys", async () => {
    const app = await discovery(1);
    expect((await app.request(`/resources?extensions=${keys(10)}`)).status).toBe(200);
    const beyond = await app.request(`/resources?extensions=${keys(11)}`);
    expect(beyond.status).toBe(400);
    expect(await errorCode(beyond)).toBe("discovery_invalid_parameter");
  });
});

describe("GET /discovery/search parameters", () => {
  it("clamps the page size to 50 and defaults it to 10", async () => {
    const app = await discovery(60);
    const clamped = (await (await app.request("/search?query=weather&limit=500")).json()) as {
      resources: unknown[];
      pagination: { limit: number; cursor: string | null };
    };
    expect(clamped.pagination.limit).toBe(50);
    expect(clamped.resources).toHaveLength(50);
    expect(clamped.pagination.cursor).not.toBeNull();

    const standard = (await (await app.request("/search?query=weather")).json()) as {
      pagination: { limit: number };
    };
    expect(standard.pagination.limit).toBe(10);
  });

  it("accepts at most 10 extension keys", async () => {
    const app = await discovery(1);
    expect((await app.request(`/search?query=weather&extensions=${keys(10)}`)).status).toBe(200);
    const beyond = await app.request(`/search?query=weather&extensions=${keys(11)}`);
    expect(await errorCode(beyond)).toBe("discovery_invalid_parameter");
  });

  it.each([
    ["500 characters", "w".repeat(500), 200, undefined],
    ["500 characters after trimming", `   ${"w".repeat(500)}   `, 200, undefined],
    ["501 characters", "w".repeat(501), 400, "search_query_too_long"],
    ["2,000 characters", "w".repeat(2_000), 400, "search_query_too_long"],
    ["2,001 characters", "w".repeat(2_001), 400, "discovery_invalid_parameter"],
    ["a blank query", "   ", 400, "search_query_required"],
  ])("answers a query of %s with %i", async (_label, query, status, code) => {
    const app = await discovery(1);
    const response = await app.request(`/search?query=${encodeURIComponent(query)}`);
    expect(response.status).toBe(status);
    if (code !== undefined) expect(await errorCode(response)).toBe(code);
  });

  it("refuses a missing query as a malformed parameter", async () => {
    const app = await discovery(1);
    const response = await app.request("/search");
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("discovery_invalid_parameter");
  });
});

describe("a resource sold on two networks", () => {
  /** One weather resource whose 402 offers testnet and pubnet, settled on both, plus its detail routes. */
  async function twoNetworks() {
    const store = new MemoryCatalogStore();
    const url = "https://api.example.com/weather";
    const testnet = settledPayment({ url, payTo: randomAddress(), description: "City weather" });
    const pubnet = settledPayment({
      url,
      payTo: randomAddress(),
      network: "stellar:pubnet",
      description: "City weather",
    });
    const paymentRequired = {
      ...paymentRequiredFor({ url, description: "City weather", extensions: { "payment-identifier": {} } }),
      accepts: [testnet.requirements, pubnet.requirements],
    };
    const catalog = new Catalog({
      store,
      sandbox,
      fetchOrigin: () => Promise.resolve({ kind: "payment_required", paymentRequired }),
    });
    const ids = [(await catalog.record(testnet))?.listingId, (await catalog.record(pubnet))?.listingId];
    await catalog.checkOrigins();
    const search = new SearchService({
      store,
      assets: new AssetRegistry([]),
      cursorSecret: Buffer.alloc(32, 1),
    });
    return { app: discoveryRoutes(store, search), ids, testnet, pubnet };
  }

  interface Item {
    resource: string;
    accepts: { network: string; payTo: string }[];
    extensions: Record<string, unknown>;
    rail402: {
      trust: string;
      listings: { id: string; network: string; owner: string }[];
      options: { listing: string }[];
    };
  }

  it("is one discovery item whose accepts offer both networks, each backed by its own listing", async () => {
    const { app, ids, testnet, pubnet } = await twoNetworks();
    const body = (await (await app.request("/resources")).json()) as {
      items: Item[];
      pagination: { total: number };
    };
    expect(body.pagination.total).toBe(1);
    const [item] = body.items;
    expect(item?.accepts.map((option) => [option.network, option.payTo])).toEqual([
      ["stellar:testnet", testnet.requirements.payTo],
      ["stellar:pubnet", pubnet.requirements.payTo],
    ]);
    expect(item?.rail402.listings.map((listing) => [listing.id, listing.network, listing.owner])).toEqual([
      [ids[0], "stellar:testnet", testnet.requirements.payTo],
      [ids[1], "stellar:pubnet", pubnet.requirements.payTo],
    ]);
    expect(item?.rail402.options.map((option) => option.listing)).toEqual(ids);
    expect(item?.rail402.trust).toBe("origin_verified");
    expect(Object.keys(item?.extensions ?? {})).toEqual(["bazaar", "payment-identifier"]);
  });

  it("shows only the matching network's options when filtered by network", async () => {
    const { app, ids } = await twoNetworks();
    for (const path of [
      "/resources?network=stellar:pubnet",
      "/search?query=weather&network=stellar:pubnet",
    ]) {
      const body = (await (await app.request(path)).json()) as { items?: Item[]; resources?: Item[] };
      const items = body.items ?? body.resources ?? [];
      expect(items, path).toHaveLength(1);
      expect(
        items[0]?.accepts.map((option) => option.network),
        path,
      ).toEqual(["stellar:pubnet"]);
      expect(
        items[0]?.rail402.listings.map((listing) => listing.id),
        path,
      ).toEqual([ids[1]]);
    }
  });

  it("is one search result, and each listing keeps its own detail and history", async () => {
    const { app, ids } = await twoNetworks();
    const body = (await (await app.request("/search?query=weather")).json()) as { resources: Item[] };
    expect(body.resources).toHaveLength(1);
    expect(body.resources[0]?.accepts).toHaveLength(2);
    const detail = (await (await app.request(`/resources/${ids[1] ?? ""}`)).json()) as Item & {
      state: string;
    };
    expect(detail.state).toBe("published");
    expect(detail.accepts.map((option) => option.network)).toEqual(["stellar:pubnet"]);
    const versions = (await (await app.request(`/resources/${ids[1] ?? ""}/versions`)).json()) as {
      versions: unknown[];
    };
    expect(versions.versions).toHaveLength(2);
  });
});
