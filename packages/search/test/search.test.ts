import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  MemoryCatalogStore,
  contentHash,
  randomAddress,
  type Listing,
  type ListingContent,
} from "@rail402.dev/bazaar";
import {
  AssetRegistry,
  Bm25Index,
  CursorCodec,
  SearchService,
  optionSatisfies,
  parseQuery,
  reciprocalRankFusion,
  satisfies,
  toBaseUnits,
  toDocument,
  tokenize,
  type Embedder,
  type SearchFilter,
} from "@rail402.dev/search";

const USDC_TESTNET = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const USDC_PUBNET = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const EURC_TESTNET = "CAEJNTK5HM6MMFXDBZEAO6T27L7JN4ZPYU6YBBSKCGVJTNOSHY5X5TNU";
const UNKNOWN_ASSET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

const assets = new AssetRegistry([
  { network: "stellar:testnet", contract: USDC_TESTNET, symbol: "USDC", decimals: 7, usd: true },
  { network: "stellar:pubnet", contract: USDC_PUBNET, symbol: "USDC", decimals: 7, usd: true },
  { network: "stellar:testnet", contract: EURC_TESTNET, symbol: "EURC", decimals: 7, usd: false },
]);

let sequence = 0;
function listing(
  content: Partial<ListingContent> & { payTo?: string; amount?: string; network?: string; asset?: string },
): Listing {
  const network = content.network ?? "stellar:testnet";
  const full: ListingContent = {
    resource: content.resource ?? `https://api${String(++sequence)}.example.com/x`,
    kind: content.kind ?? "http",
    method: "GET",
    ...(content.description === undefined ? {} : { description: content.description }),
    ...(content.serviceName === undefined ? {} : { serviceName: content.serviceName }),
    ...(content.tags === undefined ? {} : { tags: content.tags }),
    bazaar: content.bazaar ?? {
      info: { input: { type: "http", method: "GET" } },
      schema: { type: "object" },
    },
    accepts: content.accepts ?? [
      {
        scheme: "exact",
        network,
        asset: content.asset ?? (network === "stellar:pubnet" ? USDC_PUBNET : USDC_TESTNET),
        payTo: content.payTo ?? randomAddress(),
        amount: content.amount ?? "100000",
        maxTimeoutSeconds: 60,
        extra: {},
      },
    ],
  };
  const now = new Date();
  return {
    id: randomUUID(),
    sequence: 0,
    identity: { network, kind: full.kind, resource: full.resource, method: "GET", toolName: "", scope: "" },
    owner: full.accepts[0]?.payTo ?? "",
    trust: "settled",
    state: "published",
    version: 1,
    content: full,
    contentHash: contentHash(full),
    firstCatalogedAt: now,
    lastUpdated: now,
    lastSettledAt: now,
    settlements: 1,
  };
}

async function storeWith(listings: Listing[]): Promise<MemoryCatalogStore> {
  const store = new MemoryCatalogStore();
  for (const item of listings) {
    await store.transaction(item.identity, (tx) =>
      tx.insert(item, {
        listingId: item.id,
        version: 1,
        createdAt: new Date(),
        cause: "settlement",
        owner: item.owner,
        trust: item.trust,
        state: item.state,
        content: item.content,
      }),
    );
  }
  return store;
}

/** Deterministic stand-in for a sentence encoder: hashed bag of stemmed words. */
const hashEmbedder: Embedder = {
  id: "hash",
  dimensions: 4096,
  embed: (text) => {
    const vector = new Float32Array(4096);
    for (const token of tokenize(text)) {
      const bucket = createHash("sha256").update(token).digest().readUInt16BE(0) % 4096;
      vector[bucket] = (vector[bucket] ?? 0) + 1;
    }
    let norm = 0;
    for (const value of vector) norm += value * value;
    return Promise.resolve(vector.map((value) => value / (Math.sqrt(norm) || 1)));
  },
};

const secret = Buffer.alloc(32, 7);

describe("text and ranking primitives", () => {
  it("drops every inflection of a stopword, and keeps payment words", () => {
    expect(tokenize("Stellar payment API")).toEqual(["stellar", "payment"]);
    expect(tokenize("payments requests requested")).toEqual(["payment"]);
    expect(tokenize("how much does it cost")).toEqual(["cost"]);
  });

  it("indexes parameter prose from the bazaar schema", () => {
    const described = listing({ serviceName: "Lookup" });
    const withSchema = {
      ...described,
      content: {
        ...described.content,
        bazaar: {
          ...described.content.bazaar,
          schema: {
            properties: {
              input: {
                properties: { queryParams: { properties: { iata: { description: "Airport code" } } } },
              },
            },
          },
        },
      },
    };
    const document = toDocument(withSchema);
    expect(document.fields.schema).toEqual(expect.arrayContaining(["airport", "code"]));
    expect(document.embeddingText).toContain("Airport code");
  });

  it("tokenises identifiers, drops stopwords and stems", () => {
    expect(tokenize("getWeatherForecast for the city_name API")).toEqual([
      "weather",
      "forecast",
      "citi",
      "name",
    ]);
  });

  it("BM25F ranks a name match above a description match", () => {
    const named = listing({ serviceName: "Weather", description: "Data service" });
    const described = listing({ serviceName: "Data", description: "Includes weather data" });
    const index = new Bm25Index([toDocument(named), toDocument(described)]);
    expect(index.search(tokenize("weather")).map((r) => r.id)).toEqual([named.id, described.id]);
  });

  it("RRF rewards agreement between rankings", () => {
    const fused = reciprocalRankFusion([
      [
        { id: "a", score: 9 },
        { id: "b", score: 8 },
      ],
      [
        { id: "b", score: 0.9 },
        { id: "c", score: 0.8 },
      ],
    ]);
    expect(fused[0]?.id).toBe("b");
  });
});

describe("constraints", () => {
  const symbols = assets.symbols();

  it.each<[string, Partial<SearchFilter>, string]>([
    ["weather api on testnet", { network: "stellar:testnet" }, "weather api"],
    ["weather on the stellar mainnet", { network: "stellar:pubnet" }, "weather"],
    ["mcp tools for translation", { type: "mcp" }, "for translation"],
    ["weather under 1 cent", { maxPrice: { value: "0.01", unit: "usd" } }, "weather"],
    ["weather below $0.05", { maxPrice: { value: "0.05", unit: "usd" } }, "weather"],
    [
      "weather under 2 USDC",
      { maxPrice: { value: "2", unit: "asset", symbol: "USDC" }, asset: "USDC" },
      "weather",
    ],
    ["weather paid in eurc", { asset: "EURC" }, "weather"],
    [
      "cheap weather under 0.5 cents on testnet",
      { network: "stellar:testnet", maxPrice: { value: "0.005", unit: "usd" } },
      "cheap weather",
    ],
    ["weather under 1¢", { maxPrice: { value: "0.01", unit: "usd" } }, "weather"],
    ["weather under 1 ¢", { maxPrice: { value: "0.01", unit: "usd" } }, "weather"],
    ["weather under .5 cents", { maxPrice: { value: "0.005", unit: "usd" } }, "weather"],
    ["under $5 weather", { maxPrice: { value: "5", unit: "usd" } }, "weather"],
    [
      "swaps under 1,000 usdc",
      { maxPrice: { value: "1000", unit: "asset", symbol: "USDC" }, asset: "USDC" },
      "swaps",
    ],
    ["weather, testnet", { network: "stellar:testnet" }, "weather"],
    ["weather api mainnet only", { network: "stellar:pubnet" }, "weather api"],
    ["pool reserves, real network not testnet", { network: "stellar:pubnet" }, "pool reserves"],
    ["iban check on the test network", { network: "stellar:testnet" }, "iban check"],
    ["precios del oro, solo en mainnet", { network: "stellar:pubnet" }, "precios del oro"],
    ["geocoding over plain http", { type: "http" }, "geocoding"],
    ["phishing checker, as an mcp tool", { type: "mcp" }, "phishing checker"],
    [
      "phone lookup, $0.002 or less, usdc",
      { maxPrice: { value: "0.002", unit: "usd" }, asset: "USDC" },
      "phone lookup",
    ],
    [
      "iban validator under a tenth of a cent",
      { maxPrice: { value: "0.001", unit: "usd" } },
      "iban validator",
    ],
    ["python sandbox that takes EURC", { asset: "EURC" }, "python sandbox that"],
    // A negated network is the other one: Stellar has two.
    ["weather api not on testnet", { network: "stellar:pubnet" }, "weather api"],
    ["weather excluding mainnet", { network: "stellar:testnet" }, "weather"],
    ["weather, not on the stellar public network", { network: "stellar:testnet" }, "weather"],
    // A negated asset or price cannot be a filter, and is not ranked either.
    ["weather not paid in USDC", {}, "weather"],
    ["weather not under $0.01", {}, "weather"],
    ["not under $5 weather", {}, "weather"],
  ])("parses %j", (query, filter, text) => {
    const parsed = parseQuery(query, symbols);
    expect(parsed.filter).toEqual(filter);
    expect(parsed.text).toBe(text);
  });

  it.each([
    "up to 100 requests per second",
    "max 3 retries webhook",
    "below 5 translation",
    "a test for mainnet readiness",
    "public network data",
    "convert openapi spec to mcp server",
    "USDC price oracle",
    "swap usdc to eurc",
    "testnet faucet status",
    "http status codes explained",
    "mcp server hosting",
    "take a screenshot of a page",
    // Transfer limits, conversions and capabilities are not the price or asset of the call.
    "send up to 100 USDC to a phone number",
    "remittance api, max 500 usdc per transfer",
    "price of XLM in USDC",
    "checkout that accepts XLM payments",
    // Both networks named together is a comparison.
    "compare fees on testnet vs mainnet",
  ])("applies no constraint to %j and ranks all of it", (query) => {
    const parsed = parseQuery(query, symbols);
    expect(parsed.filter).toEqual({});
    expect(parsed.recognised).toEqual([]);
    expect(parsed.text).toBe(query);
  });

  it("gives the same answer on every call", () => {
    for (let i = 0; i < 3; i++) {
      expect(parseQuery("weather on testnet", symbols).filter).toEqual({ network: "stellar:testnet" });
    }
  });

  it("converts decimal prices to base units exactly", () => {
    expect(toBaseUnits("0.01", 7)).toBe(100_000n);
    expect(toBaseUnits("1", 6)).toBe(1_000_000n);
    expect(toBaseUnits("0.00000001", 7)).toBe(0n);
    expect(toBaseUnits("1e3", 7)).toBeUndefined();
  });

  it("fails closed on assets it cannot price", () => {
    const option = {
      scheme: "exact",
      network: "stellar:testnet",
      asset: UNKNOWN_ASSET,
      payTo: randomAddress(),
      amount: "1",
      maxTimeoutSeconds: 60,
      extra: {},
    };
    expect(optionSatisfies(option, { maxPrice: { value: "1000", unit: "usd" } }, assets)).toBe(false);
    expect(optionSatisfies(option, { asset: "USDC" }, assets)).toBe(false);
    expect(optionSatisfies(option, { asset: UNKNOWN_ASSET }, assets)).toBe(true);
    const eurc = { ...option, asset: EURC_TESTNET };
    expect(optionSatisfies(eurc, { maxPrice: { value: "1000", unit: "usd" } }, assets)).toBe(false);
  });

  it("requires every constraint to hold for one payment option", () => {
    const payTo = randomAddress();
    const mixed = listing({
      accepts: [
        {
          scheme: "exact",
          network: "stellar:testnet",
          asset: USDC_TESTNET,
          payTo,
          amount: "900000000",
          maxTimeoutSeconds: 60,
          extra: {},
        },
        {
          scheme: "exact",
          network: "stellar:pubnet",
          asset: USDC_PUBNET,
          payTo: randomAddress(),
          amount: "1",
          maxTimeoutSeconds: 60,
          extra: {},
        },
      ],
    });
    // Cheap on pubnet, and paid to payTo on testnet — but never both in one option.
    expect(satisfies(mixed, { payTo, maxPrice: { value: "0.01", unit: "usd" } }, assets)).toBe(false);
    expect(
      satisfies(mixed, { network: "stellar:pubnet", maxPrice: { value: "0.01", unit: "usd" } }, assets),
    ).toBe(true);
  });
});

describe("CursorCodec", () => {
  const codec = new CursorCodec(secret);
  const state = { revision: 3, offset: 20, request: "abc", expiresAt: 10_000 };

  it("round-trips, and rejects tampering, expiry and foreign secrets", () => {
    const token = codec.encode(state);
    expect(codec.decode(token, 5_000)).toEqual(state);
    expect(codec.decode(token, 20_000)).toBe("expired");
    const [body = "", signature = ""] = token.split(".");
    const forged = Buffer.from(JSON.stringify([3, 0, "abc", 10_000])).toString("base64url");
    expect(codec.decode(`${forged}.${signature}`, 5_000)).toBe("invalid");
    expect(codec.decode(`${body}.${signature.slice(1)}x`, 5_000)).toBe("invalid");
    expect(new CursorCodec(Buffer.alloc(32, 8)).decode(token, 5_000)).toBe("invalid");
    expect(codec.decode("garbage", 5_000)).toBe("invalid");
  });

  it("refuses short secrets", () => {
    expect(() => new CursorCodec(Buffer.alloc(16))).toThrow();
  });
});

describe("SearchService", () => {
  it("finds relevant listings and reports the hybrid method", async () => {
    const weather = listing({
      serviceName: "Weatherly",
      description: "Weather forecasts for any city",
      tags: ["weather"],
    });
    const stocks = listing({
      serviceName: "Quotes",
      description: "Real-time stock prices",
      tags: ["finance"],
    });
    const service = new SearchService({
      store: await storeWith([weather, stocks]),
      assets,
      embedder: hashEmbedder,
      cursorSecret: secret,
    });
    const result = await service.search({ query: "city weather forecast", filter: {}, limit: 10 });
    expect(result.method).toBe("hybrid");
    expect(result.resources.flat()[0]?.id).toBe(weather.id);
    expect(result.resources.flat().map((l) => l.id)).not.toContain(stocks.id);
  });

  it("applies constraints from the query text as hard filters", async () => {
    const cheap = listing({ serviceName: "Weather", amount: "50000" });
    const pricey = listing({ serviceName: "Weather", amount: "5000000" });
    const mainnet = listing({ serviceName: "Weather", network: "stellar:pubnet", amount: "50000" });
    const service = new SearchService({
      store: await storeWith([cheap, pricey, mainnet]),
      assets,
      embedder: hashEmbedder,
      cursorSecret: secret,
    });
    const result = await service.search({ query: "weather under 1 cent on testnet", filter: {}, limit: 10 });
    expect(result.resources.flat().map((l) => l.id)).toEqual([cheap.id]);
    expect(result.recognised).toEqual(["network=stellar:testnet", "maxPrice=0.01 USD"]);
  });

  it("pages with a cursor pinned to its snapshot, even when the catalog changes", async () => {
    const listings = Array.from({ length: 7 }, (_, i) =>
      listing({ serviceName: `Weather ${String(i)}`, description: "weather data" }),
    );
    const store = await storeWith(listings);
    const service = new SearchService({ store, assets, cursorSecret: secret, embedder: hashEmbedder });
    const first = await service.search({ query: "weather", filter: {}, limit: 3 });
    expect(first.nextCursor).not.toBeNull();

    // A new listing arrives between pages; the cursor still continues the original result set.
    const late = listing({ serviceName: "Weather late", description: "weather weather weather" });
    await storeWith([late]).then(() => undefined);
    await store.transaction(late.identity, (tx) =>
      tx.insert(late, {
        listingId: late.id,
        version: 1,
        createdAt: new Date(),
        cause: "settlement",
        owner: late.owner,
        trust: "settled",
        state: "published",
        content: late.content,
      }),
    );

    const seen = [...first.resources.flat().map((l) => l.id)];
    let cursor = first.nextCursor;
    while (cursor !== null) {
      const page = await service.search({ query: "weather", filter: {}, limit: 3, cursor });
      seen.push(...page.resources.flat().map((l) => l.id));
      cursor = page.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(new Set(seen)).toEqual(new Set(listings.map((l) => l.id)));

    await expect(
      service.search({ query: "other query", filter: {}, limit: 3, cursor: first.nextCursor ?? "" }),
    ).rejects.toMatchObject({
      code: "search_invalid_cursor",
    });
  });

  it("continues a cursor on another replica, or after a restart, while the catalog is unchanged", async () => {
    const store = await storeWith(
      Array.from({ length: 5 }, (_, i) => listing({ serviceName: `Weather ${String(i)}` })),
    );
    const options = { store, assets, cursorSecret: secret, embedder: hashEmbedder };
    const first = new SearchService(options);
    const page1 = await first.search({ query: "weather", filter: {}, limit: 2 });
    const page2 = await first.search({
      query: "weather",
      filter: {},
      limit: 2,
      cursor: page1.nextCursor ?? "",
    });

    const other = new SearchService(options);
    const continued = await other.search({
      query: "weather",
      filter: {},
      limit: 2,
      cursor: page1.nextCursor ?? "",
    });
    expect(continued.resources.flat().map((l) => l.id)).toEqual(page2.resources.flat().map((l) => l.id));
  });

  it("never applies a price written in one asset to another asset", async () => {
    const service = new SearchService({
      store: await storeWith([
        listing({ serviceName: "Weather", asset: USDC_TESTNET, amount: "1000000" }),
        listing({ serviceName: "Weather", asset: EURC_TESTNET, amount: "1000000" }),
      ]),
      assets,
      cursorSecret: secret,
    });
    // An explicit USDC asset and a ceiling written in EURC: no single option can satisfy both.
    const result = await service.search({
      query: "weather under 1 EURC",
      filter: { asset: "USDC" },
      limit: 10,
    });
    expect(result.resources).toEqual([]);
    const eurc = await service.search({ query: "weather under 1 EURC", filter: {}, limit: 10 });
    expect(eurc.resources.flat().map((l) => l.content.accepts[0]?.asset)).toEqual([EURC_TESTNET]);
  });

  it("echoes only the constraints it applied", async () => {
    const service = new SearchService({
      store: await storeWith([listing({ serviceName: "Weather", network: "stellar:pubnet" })]),
      assets,
      embedder: hashEmbedder,
      cursorSecret: secret,
    });
    const result = await service.search({
      query: "weather on testnet",
      filter: { network: "stellar:pubnet" },
      limit: 10,
    });
    expect(result.recognised).toEqual([]);
    expect(result.resources.flat()).toHaveLength(1);
  });

  it("reports complete hybrid results as not partial", async () => {
    const service = new SearchService({
      store: await storeWith([listing({ serviceName: "Weather" }), listing({ serviceName: "Stocks" })]),
      assets,
      embedder: hashEmbedder,
      cursorSecret: secret,
    });
    const result = await service.search({ query: "weather", filter: {}, limit: 10 });
    expect(result).toMatchObject({ method: "hybrid", partialResults: false });
  });

  it("breaks exact ties by origin verification, then by listing age", async () => {
    const older = listing({ serviceName: "Weather" });
    const newer = listing({ serviceName: "Weather" });
    const verified = { ...listing({ serviceName: "Weather" }), trust: "origin_verified" as const };
    const service = new SearchService({
      store: await storeWith([older, newer, verified]),
      assets,
      cursorSecret: secret,
    });
    const result = await service.search({ query: "weather", filter: {}, limit: 10 });
    expect(result.resources.flat().map((l) => l.id)).toEqual([verified.id, older.id, newer.id]);
  });

  it("reports partialResults when running lexical-only", async () => {
    const service = new SearchService({
      store: await storeWith([listing({ serviceName: "Weather" })]),
      assets,
      cursorSecret: secret,
    });
    const result = await service.search({ query: "weather", filter: {}, limit: 10 });
    expect(result).toMatchObject({ method: "lexical", partialResults: true });
  });

  it("returns a resource sold on two networks once, with each network's listing", async () => {
    const resource = "https://api.forecast.example.com/weather";
    const testnet = listing({ resource, serviceName: "Forecast", description: "Weather forecasts" });
    const pubnet = listing({
      resource,
      network: "stellar:pubnet",
      serviceName: "Forecast",
      description: "Weather forecasts",
    });
    const other = listing({ serviceName: "Tides", description: "Weather at sea and tide tables" });
    const service = new SearchService({
      store: await storeWith([testnet, pubnet, other]),
      assets,
      embedder: hashEmbedder,
      cursorSecret: secret,
    });
    const result = await service.search({ query: "weather forecasts", filter: {}, limit: 10 });
    // The two listings are identical documents, so which one ranks first is not asserted.
    expect(result.resources.map((members) => members.map((l) => l.id).sort())).toEqual([
      [testnet.id, pubnet.id].sort(),
      [other.id],
    ]);
    const onPubnet = await service.search({
      query: "weather forecasts",
      filter: { network: "stellar:pubnet" },
      limit: 10,
    });
    expect(onPubnet.resources.map((members) => members.map((l) => l.id))).toEqual([[pubnet.id]]);
  });

  it("pages resources, never repeating one across pages", async () => {
    const listings = Array.from({ length: 3 }, (_, i) => {
      const resource = `https://api.weather${String(i)}.example.com/now`;
      return [
        listing({ resource, serviceName: `Weather ${String(i)}` }),
        listing({ resource, serviceName: `Weather ${String(i)}`, network: "stellar:pubnet" }),
      ];
    }).flat();
    const service = new SearchService({ store: await storeWith(listings), assets, cursorSecret: secret });
    const first = await service.search({ query: "weather", filter: {}, limit: 2 });
    const second = await service.search({
      query: "weather",
      filter: {},
      limit: 2,
      cursor: first.nextCursor ?? "",
    });
    expect(first.resources).toHaveLength(2);
    expect(second.resources).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    const seen = [...first.resources, ...second.resources].map(([primary]) => primary.content.resource);
    expect(new Set(seen).size).toBe(3);
    expect([...first.resources, ...second.resources].every((members) => members.length === 2)).toBe(true);
  });

  it("serves filter-only queries by trust, then listing age, never by settlements bought", async () => {
    const old = new Date("2026-01-01T00:00:00Z");
    const recent = new Date("2026-06-01T00:00:00Z");
    const busy = { ...listing({ network: "stellar:pubnet" }), settlements: 1_000, listedAt: old };
    const verified = {
      ...listing({ network: "stellar:pubnet" }),
      trust: "domain_verified" as const,
      listedAt: recent,
    };
    const older = {
      ...listing({ network: "stellar:pubnet" }),
      trust: "origin_verified" as const,
      listedAt: old,
    };
    const newer = {
      ...listing({ network: "stellar:pubnet" }),
      trust: "origin_verified" as const,
      listedAt: recent,
    };
    const service = new SearchService({
      store: await storeWith([busy, newer, older, verified, listing({})]),
      assets,
      cursorSecret: secret,
    });
    const result = await service.search({ query: "on mainnet", filter: {}, limit: 10 });
    expect(result.method).toBe("filter");
    expect(result.resources.flat().map((l) => l.id)).toEqual([verified.id, older.id, newer.id, busy.id]);
  });

  it("keeps a superseded snapshot for as long as a cursor issued on it is valid", async () => {
    let clock = 1_000_000;
    const store = await storeWith(
      Array.from({ length: 3 }, (_, i) => listing({ serviceName: `Weather ${String(i)}` })),
    );
    const service = new SearchService({ store, assets, cursorSecret: secret, now: () => clock });
    await service.refresh();
    // The snapshot was built long ago; its cursor was issued a second ago.
    clock += 60 * 60_000;
    const first = await service.search({ query: "weather", filter: {}, limit: 1 });
    clock += 1_000;
    const late = listing({ serviceName: "Weather later" });
    await store.transaction(late.identity, (tx) =>
      tx.insert(late, {
        listingId: late.id,
        version: 1,
        createdAt: new Date(),
        cause: "settlement",
        owner: late.owner,
        trust: "settled",
        state: "published",
        content: late.content,
      }),
    );
    await service.refresh();
    const second = await service.search({
      query: "weather",
      filter: {},
      limit: 1,
      cursor: first.nextCursor ?? "",
    });
    expect(second.revision).toBe(first.revision);
    expect(second.resources).toHaveLength(1);
  });

  it("answers lexical-only, as partial results, when the embedder fails or runs out of time", async () => {
    const weather = listing({ serviceName: "Weather", description: "Weather forecasts" });
    let mode: "ok" | "fail" | "slow" = "ok";
    const flaky: Embedder = {
      ...hashEmbedder,
      embed: (text) =>
        mode === "fail"
          ? Promise.reject(new Error("inference failed"))
          : mode === "slow"
            ? new Promise(() => undefined)
            : hashEmbedder.embed(text),
    };
    const service = new SearchService({
      store: await storeWith([weather]),
      assets,
      embedder: flaky,
      cursorSecret: secret,
      semanticBudgetMs: 20,
    });
    expect(await service.search({ query: "weather", filter: {}, limit: 10 })).toMatchObject({
      method: "hybrid",
      partialResults: false,
    });
    for (const failure of ["fail", "slow"] as const) {
      mode = failure;
      const result = await service.search({ query: "weather", filter: {}, limit: 10 });
      expect(result, failure).toMatchObject({ method: "lexical", partialResults: true });
      expect(result.resources.flat().map((l) => l.id)).toEqual([weather.id]);
    }
  });

  it("builds a lexical-only snapshot when listings cannot be embedded", async () => {
    const broken: Embedder = { ...hashEmbedder, embed: () => Promise.reject(new Error("no model")) };
    const service = new SearchService({
      store: await storeWith([listing({ serviceName: "Weather" })]),
      assets,
      embedder: broken,
      cursorSecret: secret,
    });
    expect(await service.search({ query: "weather", filter: {}, limit: 10 })).toMatchObject({
      method: "lexical",
      partialResults: true,
    });
  });

  it("reuses a revision read for revisionMaxAgeMs", async () => {
    let clock = 0;
    const store = await storeWith([listing({ serviceName: "Weather" })]);
    const revision = vi.spyOn(store, "revision");
    const service = new SearchService({
      store,
      assets,
      cursorSecret: secret,
      revisionMaxAgeMs: 1_000,
      now: () => clock,
    });
    await service.search({ query: "weather", filter: {}, limit: 10 });
    await service.search({ query: "weather", filter: {}, limit: 10 });
    expect(revision).toHaveBeenCalledTimes(1);
    clock += 1_000;
    await service.search({ query: "weather", filter: {}, limit: 10 });
    expect(revision).toHaveBeenCalledTimes(2);
  });

  it("expires cursors 15 minutes after the page was served", async () => {
    let clock = 1_000_000;
    const service = new SearchService({
      store: await storeWith(
        Array.from({ length: 3 }, (_, i) => listing({ serviceName: `Weather ${String(i)}` })),
      ),
      assets,
      cursorSecret: secret,
      now: () => clock,
    });
    const first = await service.search({ query: "weather", filter: {}, limit: 1 });
    const cursor = first.nextCursor ?? "";
    clock += 15 * 60_000;
    const second = await service.search({ query: "weather", filter: {}, limit: 1, cursor });
    expect(second.resources.flat()).toHaveLength(1);
    clock += 1;
    await expect(service.search({ query: "weather", filter: {}, limit: 1, cursor })).rejects.toMatchObject({
      code: "search_cursor_expired",
    });
  });

  it("builds the new index itself when a search arrives after a catalog change", async () => {
    const store = await storeWith([listing({ serviceName: "Weather now" })]);
    const service = new SearchService({ store, assets, cursorSecret: secret });
    const before = await service.refresh();

    const late = listing({ serviceName: "Weather later" });
    await store.transaction(late.identity, (tx) =>
      tx.insert(late, {
        listingId: late.id,
        version: 1,
        createdAt: new Date(),
        cause: "settlement",
        owner: late.owner,
        trust: "settled",
        state: "published",
        content: late.content,
      }),
    );
    const published = vi.spyOn(store, "published");
    // No background refresh has run: the search waits for one build, shared with a concurrent refresh.
    const [result] = await Promise.all([
      service.search({ query: "weather", filter: {}, limit: 10 }),
      service.refresh(),
    ]);
    expect(result.revision).toBe(await store.revision());
    expect(result.revision).not.toBe(before.revision);
    expect(result.resources.flat().map((l) => l.id)).toContain(late.id);
    expect(published).toHaveBeenCalledTimes(1);
  });

  it("rejects blank and oversized queries with codes", async () => {
    const service = new SearchService({ store: new MemoryCatalogStore(), assets, cursorSecret: secret });
    await expect(service.search({ query: "  ", filter: {}, limit: 10 })).rejects.toMatchObject({
      code: "search_query_required",
    });
    await expect(service.search({ query: "x".repeat(501), filter: {}, limit: 10 })).rejects.toMatchObject({
      code: "search_query_too_long",
    });
  });

  it("returns zero filter violations across random catalogs and constraints", async () => {
    const random = mulberry32(402);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
    const payTos = Array.from({ length: 4 }, () => randomAddress());
    const words = ["weather", "stocks", "translate", "image", "search", "maps", "news"];
    for (let round = 0; round < 40; round++) {
      const listings = Array.from({ length: 25 }, () => {
        const network = pick(["stellar:testnet", "stellar:pubnet"]);
        return listing({
          serviceName: `${pick(words)} ${pick(words)}`,
          description: `${pick(words)} data`,
          accepts: Array.from({ length: 1 + Math.floor(random() * 2) }, () => ({
            scheme: pick(["exact", "upto"]),
            network,
            asset: pick(
              network === "stellar:testnet"
                ? [USDC_TESTNET, EURC_TESTNET, UNKNOWN_ASSET]
                : [USDC_PUBNET, UNKNOWN_ASSET],
            ),
            payTo: pick(payTos),
            amount: String(Math.floor(random() * 2_000_000)),
            maxTimeoutSeconds: 60,
            extra: {},
          })),
        });
      });
      const service = new SearchService({
        store: await storeWith(listings),
        assets,
        embedder: hashEmbedder,
        cursorSecret: secret,
      });
      for (let query = 0; query < 10; query++) {
        const filter: SearchFilter = {
          ...(random() < 0.5 ? { network: pick(["stellar:testnet", "stellar:pubnet"]) } : {}),
          ...(random() < 0.4 ? { payTo: pick(payTos) } : {}),
          ...(random() < 0.4 ? { scheme: pick(["exact", "upto"]) } : {}),
          ...(random() < 0.4 ? { asset: pick(["USDC", "EURC", UNKNOWN_ASSET]) } : {}),
          ...(random() < 0.4
            ? { maxPrice: { value: pick(["0.01", "0.05", "0.1"]), unit: "usd" as const } }
            : {}),
        };
        const result = await service.search({ query: pick(words), filter, limit: 25 });
        for (const found of result.resources.flat()) {
          // Every option shown satisfies every filter: a resource is narrowed to the options that matched.
          expect(found.content.accepts.length).toBeGreaterThan(0);
          const ok = found.content.accepts.every((option) => optionSatisfies(option, filter, assets));
          expect(ok, JSON.stringify({ filter, accepts: found.content.accepts })).toBe(true);
        }
      }
    }
  });
});

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
