import { describe, it, expect } from "vitest";
import { CatalogStore } from "./store.js";
import type { CatalogEntry } from "./types.js";

/**
 * Listing-lifecycle hygiene (G1): a `/verify` flood must not grow the provisional population without
 * bound, while a confirmed entry — which cost a real settlement — is never evicted. (Provisionals
 * deliberately remain visible in browse, flagged, by design; that is covered in bazaar.test.ts.)
 */

const T0 = "2026-08-16T10:00:00.000Z";

function entry(resource: string, over: Partial<CatalogEntry> = {}): CatalogEntry {
  return {
    resource,
    type: "http",
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: "stellar:testnet",
        amount: "1000000",
        asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        payTo: "GBOQSB3FVG3HEJUGBDYMQXU7FGTZGYMCCY3PAS6R7BM53NHTZFKYRQR2",
        maxTimeoutSeconds: 60,
        extra: { areFeesSponsored: true },
      },
    ],
    lastUpdated: T0,
    quality: { totalSettlements: 1, uniquePayers: 1, firstSeenAt: T0 },
    ownerPayTo: "GBOQSB3FVG3HEJUGBDYMQXU7FGTZGYMCCY3PAS6R7BM53NHTZFKYRQR2",
    ...over,
  };
}

/** Fix the read clock so a provisional written at T0 is judged live (its TTL is an hour out). */
function freshStore(): CatalogStore {
  const store = new CatalogStore();
  store.now = () => T0;
  return store;
}

describe("provisional population backstop (G1)", () => {
  it("evicts the oldest provisionals down to the cap, keeping the newest", () => {
    const store = freshStore();
    store.maxProvisionalEntries = 3;
    // Five provisionals, each written a second later so their TTL deadlines strictly increase.
    const times = ["10:00:00", "10:00:01", "10:00:02", "10:00:03", "10:00:04"].map(
      t => `2026-08-16T${t}.000Z`,
    );
    times.forEach((t, i) => store.upsertProvisional(entry(`https://seller.example/p${i}`), t));

    // The two oldest are evicted; the three newest survive.
    expect(store.get("https://seller.example/p0")).toBeUndefined();
    expect(store.get("https://seller.example/p1")).toBeUndefined();
    expect(store.get("https://seller.example/p2")).toBeDefined();
    expect(store.get("https://seller.example/p3")).toBeDefined();
    expect(store.get("https://seller.example/p4")).toBeDefined();
  });

  it("never evicts a confirmed entry, even under a provisional flood", () => {
    const store = freshStore();
    store.maxProvisionalEntries = 2;
    store.upsert(entry("https://seller.example/paid")); // cost a real settlement
    ["10:00:00", "10:00:01", "10:00:02"].forEach((t, i) =>
      store.upsertProvisional(entry(`https://seller.example/f${i}`), `2026-08-16T${t}.000Z`),
    );

    // A provisional was evicted, but the settled listing is untouched.
    expect(store.get("https://seller.example/paid")).toBeDefined();
    expect(store.get("https://seller.example/f0")).toBeUndefined();
  });
});

describe("search index is robust to prototype-key terms", () => {
  // A listing whose text tokenizes to an inherited Object key (e.g. "constructor") used to crash the
  // WHOLE index build: the synonym lookup returned the prototype method instead of undefined, and
  // iterating it threw "not iterable" — one such term in any listing broke search for every query.
  // Found by scale-testing the ranker over a 16k-document corpus.
  it("indexes and searches a listing containing 'constructor' without throwing", () => {
    const store = freshStore();
    store.upsert(
      entry("https://seller.example/proto", {
        serviceName: "Widget constructor service",
        description: "A constructor endpoint for weather forecast data.",
      }),
    );
    expect(() => store.reindex()).not.toThrow();
    const res = store.search("weather forecast", {}, 10);
    expect(res.resources.some(r => r.resource === "https://seller.example/proto")).toBe(true);
  });
});
