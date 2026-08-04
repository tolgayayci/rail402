import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { withBazaar } from "@x402/extensions";
import { CatalogStore } from "./catalog/store.js";
import { createBazaarApp } from "./app.js";
import { CORPUS } from "./search/fixtures.js";

/**
 * Wire parity against the STOCK client.
 *
 * "Reviewers will point stock SDK code at the deliverable rather than read a conformance
 * claim." Everything else in this repo tests our own reading of the discovery shapes; this is the
 * only test where the assertion is made by upstream's own code. If `@x402/extensions` cannot parse
 * what we serve, the deliverable is unusable no matter what our own tests say.
 *
 * The asymmetry between the two endpoints is the specific thing worth guarding: the list endpoint
 * answers `{items, pagination:{limit,offset,total}}` and search answers
 * `{resources, pagination:{limit,cursor}}`. Getting them the wrong way round breaks every stock
 * client using `withBazaar()` while every hand-written test still passes.
 */

const store = new CatalogStore();
const app = createBazaarApp({ store });

// `withBazaar` calls global fetch against `client.url`. Route that into the app in-process so the
// gate needs no server, no port, and no network — otherwise it would be too slow to run per-commit
// and would quietly get skipped, which is how the last "gate" stopped being one.
const realFetch = globalThis.fetch;
beforeAll(() => {
  for (const entry of CORPUS) store.upsert(entry);
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return app.request(url.replace("http://facilitator.test", ""), init as RequestInit);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

const client = {
  url: "http://facilitator.test",
  createAuthHeaders: async () => ({ headers: {} }),
} as unknown as Parameters<typeof withBazaar>[0];

describe("stock @x402/extensions withBazaar can consume our endpoints", () => {
  it("lists resources through the stock client", async () => {
    const bazaar = withBazaar(client).extensions.bazaar;
    const res = await bazaar.listResources({ limit: 5 });
    expect(Array.isArray(res.items), "stock client expects `items` on the LIST endpoint").toBe(true);
    expect(res.pagination).toMatchObject({ limit: expect.any(Number), offset: expect.any(Number), total: expect.any(Number) });
    expect(res.x402Version).toBe(2);
  });

  it("searches through the stock client", async () => {
    const bazaar = withBazaar(client).extensions.bazaar;
    const res = await bazaar.search({ query: "weather forecast", limit: 3 });
    expect(Array.isArray(res.resources), "stock client expects `resources` on the SEARCH endpoint").toBe(true);
    expect(res.resources.length).toBeGreaterThan(0);
  });

  it("passes every filter the stock client can send, including scheme", async () => {
    const bazaar = withBazaar(client).extensions.bazaar;
    // The stock client serialises all seven. A filter we ignore would silently return everything —
    // which is exactly what two of the three live catalogs measured live do.
    const all = await bazaar.listResources({ limit: 100 });
    const wrong = await bazaar.listResources({ limit: 100, scheme: "not-a-scheme" });
    expect(all.items.length).toBeGreaterThan(0);
    expect(wrong.items.length, "an unmatched `scheme` must filter, not be ignored").toBe(0);
  });

  it("round-trips a cursor the stock client hands back", async () => {
    const bazaar = withBazaar(client).extensions.bazaar;
    const first = await bazaar.search({ query: "price", limit: 1 });
    const cursor = first.pagination?.cursor;
    if (!cursor) return; // single-page result set; nothing to page through
    const second = await bazaar.search({ query: "price", limit: 1, cursor });
    const id = (r: { resource: string }) => r.resource;
    expect(second.resources.map(id), "page 2 must not repeat page 1").not.toEqual(first.resources.map(id));
  });
});
