import { afterAll, describe, expect, it } from "vitest";
import {
  Catalog,
  DEFAULT_MAX_LISTING_BYTES,
  MemoryCatalogStore,
  listingBytes,
  SchemaSandbox,
  paymentRequiredFor,
  randomAddress,
  settledPayment,
} from "@rail402.dev/bazaar";
import type { PaymentRequired } from "@x402/core/types";
import { AssetRegistry, SearchService, type Embedder } from "@rail402.dev/search";
import type { Listing, ListingContent } from "@rail402.dev/bazaar";
import { discoveryRoutes, type DiscoveryLimits } from "@rail402.dev/service";

const USDC_TESTNET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

const sandbox = new SchemaSandbox();
afterAll(async () => {
  await sandbox.close();
});

/** Discovery routes over a memory catalog of `count` published weather listings, lexical search only. */
async function discovery(
  count: number,
  options: { embedder?: Embedder; limits?: Omit<DiscoveryLimits, "clientKey"> } = {},
) {
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
    ...(options.embedder === undefined ? {} : { embedder: options.embedder }),
  });
  const limits =
    options.limits === undefined ? undefined : { ...options.limits, clientKey: () => "one client" };
  return Object.assign(discoveryRoutes(store, search, limits), { catalog, store });
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

describe("discovery cost limits", () => {
  /** A stand-in embedder: one fixed vector, so every query is "similar". */
  const constant: Embedder = {
    id: "constant",
    dimensions: 2,
    embed: () => Promise.resolve(Float32Array.from([1, 0])),
  };

  it("limits uncached searches more tightly than cached ones", async () => {
    const limits = { perMinute: 10, uncachedSearchCost: 5 };
    const uncached = await discovery(1, { embedder: constant, limits });
    const statuses = [];
    for (const query of ["weather one", "weather two", "weather three"]) {
      statuses.push((await uncached.request(`/search?query=${encodeURIComponent(query)}`)).status);
    }
    expect(statuses).toEqual([200, 200, 429]);

    const cached = await discovery(1, { embedder: constant, limits });
    const repeated = [];
    for (let i = 0; i < 7; i++) {
      const response = await cached.request("/search?query=weather");
      repeated.push(response.status);
      if (response.status === 429) {
        expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
        expect(await errorCode(response)).toBe("rate_limited");
      } else {
        expect(
          ((await response.json()) as { rail402: { queryEmbedding: string } }).rail402.queryEmbedding,
        ).toBe(i === 0 ? "computed" : "cached");
      }
    }
    // One uncached search (5) and five cached ones (1 each) fit; the seventh does not.
    expect(repeated).toEqual([200, 200, 200, 200, 200, 200, 429]);
  });

  it("charges deep offsets against the cost bucket", async () => {
    const app = await discovery(1, { limits: { perMinute: 10, uncachedSearchCost: 5 } });
    expect((await app.request("/resources?offset=9000")).status).toBe(200);
    const next = await app.request("/resources");
    expect(next.status).toBe(429);
    expect(await errorCode(next)).toBe("rate_limited");
  });

  it("charges a listing and its version history, and reports every refusal by route", async () => {
    const refused: string[] = [];
    const app = await discovery(1, {
      limits: { perMinute: 6, uncachedSearchCost: 5, onLimited: (route) => refused.push(route) },
    });
    const { items } = (await (await app.request("/resources")).json()) as {
      items: { rail402: { listings: { id: string }[] } }[];
    };
    const id = items[0]?.rail402.listings[0]?.id ?? "";
    expect((await app.request(`/resources/${id}`)).status).toBe(200);
    // Four units left: a full page of history costs 5, a page of ten costs 1.
    const full = await app.request(`/resources/${id}/versions`);
    expect(full.status).toBe(429);
    expect(await errorCode(full)).toBe("rate_limited");
    expect((await app.request(`/resources/${id}/versions?limit=10`)).status).toBe(200);
    for (let i = 0; i < 3; i++) expect((await app.request(`/resources/${id}`)).status).toBe(200);
    expect((await app.request(`/resources/${id}`)).status).toBe(429);
    expect((await app.request("/resources")).status).toBe(429);
    expect(refused).toEqual([
      "/discovery/resources/:id/versions",
      "/discovery/resources/:id",
      "/discovery/resources",
    ]);
  });

  it("applies no cost limit with a limit of 0", async () => {
    const app = await discovery(1, { limits: { perMinute: 0, uncachedSearchCost: 5 } });
    for (let i = 0; i < 20; i++) expect((await app.request("/resources?offset=9000")).status).toBe(200);
  });
});

describe("response size", () => {
  /**
   * A catalog of `count` resources, each sold on testnet and pubnet with content at the per-listing
   * size limit: the worst case a page can hold.
   */
  async function worstCase(count: number, listingSize = DEFAULT_MAX_LISTING_BYTES) {
    const store = new MemoryCatalogStore();
    for (let i = 0; i < count; i++) {
      for (const network of ["stellar:testnet", "stellar:pubnet"]) {
        const payTo = randomAddress();
        const resource = `https://api${String(i)}.example.com/weather`;
        const base: ListingContent = {
          resource,
          kind: "http",
          method: "GET",
          description: "Weather",
          bazaar: { info: { input: { type: "http", method: "GET" }, note: "" }, schema: { type: "object" } },
          accepts: Array.from({ length: 8 }, (_, option) => ({
            scheme: "exact",
            network,
            asset: USDC_TESTNET,
            payTo,
            amount: String(10_000 + option),
            maxTimeoutSeconds: 60,
            extra: { areFeesSponsored: true },
          })),
        };
        const padding = listingSize - listingBytes(base);
        const content: ListingContent = {
          ...base,
          bazaar: { ...base.bazaar, info: { ...base.bazaar.info, note: "w".repeat(padding) } },
        };
        expect(listingBytes(content)).toBe(listingSize);
        const now = new Date();
        const listing: Listing = {
          id: crypto.randomUUID(),
          sequence: 0,
          identity: { network, kind: "http", resource, method: "GET", toolName: "", scope: "" },
          owner: payTo,
          trust: "origin_verified",
          state: "published",
          version: 1,
          content,
          contentHash: `${String(i)}${network}`,
          firstCatalogedAt: now,
          listedAt: new Date(now.getTime() - 1_000 + i),
          lastUpdated: now,
          lastSettledAt: now,
          settlements: 1,
        };
        await store.transaction(listing.identity, (tx) =>
          tx.insert(listing, {
            listingId: listing.id,
            version: 1,
            createdAt: now,
            cause: "settlement",
            owner: payTo,
            trust: "origin_verified",
            state: "published",
            content,
          }),
        );
      }
    }
    const search = new SearchService({
      store,
      assets: new AssetRegistry([]),
      cursorSecret: Buffer.alloc(32, 1),
    });
    return discoveryRoutes(store, search);
  }

  /** Upstream's withBazaar client refuses larger discovery responses. */
  const CLIENT_LIMIT = 4 * 1024 * 1024;

  it("ends a page before it exceeds the byte budget and continues on the next", async () => {
    const app = await worstCase(100);
    const seen: string[] = [];
    let offset = 0;
    let pages = 0;
    while (offset < 100) {
      const response = await app.request(`/resources?limit=100&offset=${String(offset)}`);
      const text = await response.text();
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(3.75 * 1024 * 1024);
      const body = JSON.parse(text) as {
        items: { resource: string }[];
        pagination: { limit: number; total: number };
      };
      expect(body.pagination.total).toBe(100);
      expect(body.items.length).toBe(Math.min(body.pagination.limit, 100 - offset));
      seen.push(...body.items.map((item) => item.resource));
      offset += body.pagination.limit;
      pages++;
    }
    expect(pages).toBeGreaterThan(1);
    expect(new Set(seen).size).toBe(100);
    expect(seen).toHaveLength(100);
  });

  it("ends a search page within the byte budget, and its cursor continues after it", async () => {
    // At the default limit 50 results always fit; an operator may raise BAZAAR_MAX_LISTING_BYTES.
    const app = await worstCase(60, 128 * 1024);
    const seen: string[] = [];
    let cursor: string | null = "";
    let pages = 0;
    while (cursor !== null) {
      const response: Response = await app.request(
        `/search?query=weather&limit=50${cursor === "" ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
      );
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(Buffer.byteLength(text)).toBeLessThan(CLIENT_LIMIT);
      const body = JSON.parse(text) as {
        resources: { resource: string }[];
        pagination: { cursor: string | null };
      };
      if (pages === 0) expect(body.resources.length).toBeLessThan(50);
      seen.push(...body.resources.map((item) => item.resource));
      cursor = body.pagination.cursor;
      pages++;
    }
    expect(pages).toBeGreaterThan(1);
    expect(new Set(seen).size).toBe(60);
    expect(seen).toHaveLength(60);
  });
});

describe("version history", () => {
  /** A listing with `count` versions, each `size` bytes of content. */
  async function history(count: number, size = 1_000) {
    const store = new MemoryCatalogStore();
    const payTo = randomAddress();
    const resource = "https://api.example.com/history";
    const base: ListingContent = {
      resource,
      kind: "http",
      method: "GET",
      bazaar: { info: { input: { type: "http", method: "GET" }, note: "" }, schema: { type: "object" } },
      accepts: [
        {
          scheme: "exact",
          network: "stellar:testnet",
          asset: USDC_TESTNET,
          payTo,
          amount: "10000",
          maxTimeoutSeconds: 60,
          extra: { areFeesSponsored: true },
        },
      ],
    };
    const content: ListingContent = {
      ...base,
      bazaar: { ...base.bazaar, info: { ...base.bazaar.info, note: "v".repeat(size - listingBytes(base)) } },
    };
    const now = new Date();
    const listing: Listing = {
      id: crypto.randomUUID(),
      sequence: 0,
      identity: {
        network: "stellar:testnet",
        kind: "http",
        resource,
        method: "GET",
        toolName: "",
        scope: "",
      },
      owner: payTo,
      trust: "origin_verified",
      state: "published",
      version: 1,
      content,
      contentHash: "h",
      firstCatalogedAt: now,
      listedAt: now,
      lastUpdated: now,
      lastSettledAt: now,
      settlements: 1,
    };
    const versionOf = (version: number) => ({
      listingId: listing.id,
      version,
      createdAt: now,
      cause: "origin_verification" as const,
      owner: payTo,
      trust: "origin_verified" as const,
      state: "published" as const,
      content,
    });
    await store.transaction(listing.identity, async (tx) => {
      await tx.insert(listing, versionOf(1));
      for (let version = 2; version <= count; version++) {
        await tx.update({ ...listing, version, contentHash: String(version) }, versionOf(version));
      }
    });
    return { app: discoveryRoutes(store), id: listing.id };
  }

  interface HistoryPage {
    versions: { version: number }[];
    pagination: { limit: number; after: number; latest: number; next?: number };
  }

  it("pages a listing's history oldest first, 100 versions at most, continuing after the last read", async () => {
    const { app, id } = await history(250);
    const first = (await (await app.request(`/resources/${id}/versions`)).json()) as HistoryPage;
    expect(first.versions.map((v) => v.version)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(first.pagination).toEqual({ limit: 100, after: 0, latest: 250, next: 100 });
    // Larger pages are clamped.
    const second = (await (
      await app.request(`/resources/${id}/versions?after=100&limit=500`)
    ).json()) as HistoryPage;
    expect(second.versions.map((v) => v.version)).toEqual(Array.from({ length: 100 }, (_, i) => i + 101));
    const last = (await (await app.request(`/resources/${id}/versions?after=200`)).json()) as HistoryPage;
    expect(last.versions).toHaveLength(50);
    expect(last.pagination).toEqual({ limit: 100, after: 200, latest: 250 });
  });

  it("refuses unknown or malformed history parameters with a coded reason", async () => {
    const { app, id } = await history(2);
    for (const query of ["page=2", "after=-1", "limit=0", "after=x"]) {
      const response = await app.request(`/resources/${id}/versions?${query}`);
      expect(response.status, query).toBe(400);
      expect(await errorCode(response)).toBe("discovery_invalid_parameter");
    }
  });

  it("ends a page of history before it exceeds the byte budget, and next continues after it", async () => {
    const { app, id } = await history(120, DEFAULT_MAX_LISTING_BYTES);
    const response = await app.request(`/resources/${id}/versions`);
    const text = await response.text();
    expect(Buffer.byteLength(text)).toBeLessThan(4 * 1024 * 1024);
    const page = JSON.parse(text) as HistoryPage;
    expect(page.versions.length).toBeLessThan(100);
    const last = page.versions.at(-1)?.version;
    expect(page.pagination.next).toBe(last);
    const rest = (await (
      await app.request(`/resources/${id}/versions?after=${String(last)}`)
    ).json()) as HistoryPage;
    expect(rest.versions[0]?.version).toBe((last ?? 0) + 1);
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
    // Each network's origin check runs in its own lane, so either listing may be published first; the
    // options follow publication order, and accepts, listings and options stay aligned.
    const listings = item?.rail402.listings ?? [];
    const order = listings[0]?.network === "stellar:testnet" ? [0, 1] : [1, 0];
    const expected = [
      { id: ids[0], network: "stellar:testnet", payTo: testnet.requirements.payTo },
      { id: ids[1], network: "stellar:pubnet", payTo: pubnet.requirements.payTo },
    ];
    const inOrder = order.map((index) => expected[index]);
    expect(item?.accepts.map((option) => [option.network, option.payTo])).toEqual(
      inOrder.map((entry) => [entry?.network, entry?.payTo]),
    );
    expect(listings.map((listing) => [listing.id, listing.network, listing.owner])).toEqual(
      inOrder.map((entry) => [entry?.id, entry?.network, entry?.payTo]),
    );
    expect(item?.rail402.options.map((option) => option.listing)).toEqual(inOrder.map((entry) => entry?.id));
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

describe("settlement activity", () => {
  it("is the same in search results and the catalog listing after a repeat settlement", async () => {
    interface Item {
      rail402: { settlements: number; listings: { settlements: number; lastSettled: string }[] };
    }
    const app = await discovery(1);
    const found = async () =>
      ((await (await app.request("/search?query=weather")).json()) as { resources: Item[] }).resources[0];
    const listed = async () =>
      ((await (await app.request("/resources")).json()) as { items: Item[] }).items[0];
    expect((await found())?.rail402.settlements).toBe(1);

    const [listing] = (await app.store.published()).listings;
    await app.catalog.record(
      settledPayment({
        url: listing?.identity.resource ?? "",
        payTo: listing?.owner ?? "",
        description: "City weather",
      }),
    );
    const now = await listed();
    expect(now?.rail402.settlements).toBe(2);
    expect((await found())?.rail402).toEqual(now?.rail402);
  });
});

describe("listings no origin confirmed", () => {
  it("show their state and settled payment, never the metadata a payer echoed", async () => {
    const app = await discovery(0);
    const planted = await app.catalog.record(
      settledPayment({
        url: "https://victim.example.com/api",
        payTo: randomAddress(),
        description: "Send your seed phrase to support@attacker.example",
        serviceName: "Victim Pro",
      }),
    );
    const id = planted?.listingId ?? "";
    const detail = (await (await app.request(`/resources/${id}`)).json()) as Record<string, unknown> & {
      extensions: { bazaar: Record<string, unknown> };
      accepts: unknown[];
    };
    expect(detail).toMatchObject({
      state: "pending",
      contentWithheld: true,
      resource: "https://victim.example.com/api",
    });
    expect(detail["description"]).toBeUndefined();
    expect(detail["serviceName"]).toBeUndefined();
    expect(detail.extensions.bazaar).toEqual({ info: {}, schema: {} });
    expect(detail.accepts).toHaveLength(1);
    const history = (await (await app.request(`/resources/${id}/versions`)).json()) as {
      versions: { state: string; contentWithheld?: boolean; content: Record<string, unknown> }[];
    };
    expect(history.versions[0]).toMatchObject({ state: "pending", contentWithheld: true });
    expect(history.versions[0]?.content["description"]).toBeUndefined();
  });
});
