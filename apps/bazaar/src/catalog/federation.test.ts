import { describe, it, expect } from "vitest";
import { CatalogStore } from "./store.js";
import { FederatedCatalog, checkSource, type FederationSource } from "./federation.js";
import type { CatalogEntry } from "./types.js";

/**
 * Federation, tested on the distinction that carries all the risk: a mirrored listing must be
 * findable and must never be mistakable for one this facilitator saw settle.
 */

const SOURCE: FederationSource = {
  id: "example-list",
  url: "https://list.example.com/discovery/resources",
  license: "CC-BY-4.0",
  attribution: "Example List contributors",
  termsAcknowledged: true,
};

const remote = (over: Record<string, unknown> = {}) => ({
  resource: "https://remote.example.com/tides",
  type: "http",
  x402Version: 2,
  accepts: [
    {
      scheme: "exact",
      network: "stellar:testnet",
      amount: "1000000",
      asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      payTo: "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO",
      maxTimeoutSeconds: 60,
      extra: { areFeesSponsored: true },
    },
  ],
  lastUpdated: "2026-08-06T00:00:00.000Z",
  description: "Tide predictions and sea state for a named harbour.",
  // A remote catalog claiming huge usage. None of it may reach our ranking.
  quality: { totalSettlements: 99999, uniquePayers: 4242 },
  ...over,
});

const sourceServing = (items: unknown[], status = 200) =>
  (async () =>
    new Response(JSON.stringify({ x402Version: 2, items, pagination: { limit: 100, offset: 0, total: items.length } }), {
      status,
    })) as unknown as typeof fetch;

const owned = (over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  resource: "https://mine.example.com/tides",
  type: "http",
  x402Version: 2,
  accepts: [
    {
      scheme: "exact",
      network: "stellar:testnet",
      amount: "1000000",
      asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      payTo: "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO",
      maxTimeoutSeconds: 60,
      extra: { areFeesSponsored: true },
    },
  ],
  lastUpdated: "2026-08-06T00:00:00.000Z",
  description: "Tide predictions and sea state for a named harbour.",
  quality: { totalSettlements: 1, uniquePayers: 1, firstSeenAt: "2026-08-06T00:00:00.000Z" },
  ownerPayTo: "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO",
  ...over,
});

describe("federation — a source must earn the right to be read", () => {
  it("refuses a source that does not declare a licence, attribution or acknowledged terms", () => {
    // Mirroring republishes somebody else's data. Fail closed on every one of these, because the
    // alternative is discovering the omission from a takedown request.
    expect(checkSource({ ...SOURCE, license: "" })?.code).toBe("bazaar_federation_source_refused");
    expect(checkSource({ ...SOURCE, attribution: "  " })?.code).toBe("bazaar_federation_source_refused");
    expect(checkSource({ ...SOURCE, termsAcknowledged: false })?.code).toBe(
      "bazaar_federation_source_refused",
    );
    // A reachable endpoint is not permission — the reason has to say so, since that is the whole
    // point of a field code cannot infer.
    expect(checkSource({ ...SOURCE, termsAcknowledged: false })?.reason).toMatch(/not permission/);
    expect(checkSource(SOURCE)).toBeUndefined();
  });

  it("requires https, because a mirrored listing becomes a result we serve", () => {
    expect(checkSource({ ...SOURCE, url: "http://list.example.com/x" })?.reason).toMatch(/https/);
  });

  it("never fetches a refused source", async () => {
    let fetched = 0;
    const spy = (async () => {
      fetched += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const catalog = new FederatedCatalog([{ ...SOURCE, termsAcknowledged: false }], spy);
    await catalog.refresh();
    expect(fetched).toBe(0);
    expect(catalog.refusals).toHaveLength(1);
  });
});

describe("federation — provenance and the ranking firewall", () => {
  it("labels every mirrored entry with its source, licence and attribution", async () => {
    const catalog = new FederatedCatalog([SOURCE], sourceServing([remote()]));
    await catalog.refresh("2026-08-06T12:00:00.000Z");

    const store = new CatalogStore(undefined, undefined, undefined, catalog);
    const listed = store.list({}, 10).items;
    expect(listed).toHaveLength(1);
    expect(listed[0]!.provenance).toEqual({
      source: "example-list",
      sourceUrl: SOURCE.url,
      license: "CC-BY-4.0",
      attribution: "Example List contributors",
      fetchedAt: "2026-08-06T12:00:00.000Z",
    });
  });

  it("discards the source's usage numbers instead of importing them", async () => {
    // The remote entry claims 4,242 unique payers. Importing that would let anyone who can get a
    // listing into that catalog move rank in ours, which is the abuse path §7.1 exists to close.
    const catalog = new FederatedCatalog([SOURCE], sourceServing([remote()]));
    await catalog.refresh();
    expect(catalog.all()[0]!.quality).toEqual({
      totalSettlements: 0,
      uniquePayers: 0,
      firstSeenAt: expect.any(String),
    });

    // And no `quality` block reaches the wire at all: zeroes would read as a claim about the
    // resource ("nobody has ever paid for this") rather than about what we know.
    const store = new CatalogStore(undefined, undefined, undefined, catalog);
    expect(store.list({}, 10).items[0]!.quality).toBeUndefined();
  });

  it("an owned listing always wins the same key", async () => {
    // A seller who settled here must never see their listing shadowed by somebody else's copy —
    // including a stale copy carrying an old price.
    const catalog = new FederatedCatalog(
      [SOURCE],
      sourceServing([remote({ resource: "https://mine.example.com/tides", description: "stale copy" })]),
    );
    await catalog.refresh();

    const store = new CatalogStore(undefined, undefined, undefined, catalog);
    store.upsert(owned());
    const items = store.list({}, 10).items;
    expect(items).toHaveLength(1);
    expect(items[0]!.description).toBe("Tide predictions and sea state for a named harbour.");
    expect(items[0]!.provenance).toBeUndefined();
  });

  it("keeps mirrored entries out of the ownership check entirely", async () => {
    // `get` is what `ingest` consults to decide whether a payTo may modify a listing. If a mirrored
    // entry answered it, a real seller settling their first payment would be told the listing
    // already belongs to someone — locked out of their own endpoint by a copy.
    const catalog = new FederatedCatalog([SOURCE], sourceServing([remote()]));
    await catalog.refresh();
    const store = new CatalogStore(undefined, undefined, undefined, catalog);
    expect(store.get("https://remote.example.com/tides")).toBeUndefined();
    expect(store.size).toBe(0); // `size` counts what we own
    expect(store.federatedSize).toBe(1);
  });

  it("lets an agent ask for only what this facilitator saw settle", async () => {
    const catalog = new FederatedCatalog([SOURCE], sourceServing([remote()]));
    await catalog.refresh();
    const store = new CatalogStore(undefined, undefined, undefined, catalog);
    store.upsert(owned());

    expect(store.list({}, 10).items).toHaveLength(2);
    expect(store.list({ source: "local" }, 10).items.map(r => r.resource)).toEqual([
      "https://mine.example.com/tides",
    ]);
    expect(store.list({ source: "example-list" }, 10).items.map(r => r.resource)).toEqual([
      "https://remote.example.com/tides",
    ]);
  });

  it("makes mirrored entries searchable — that is the point of federating at all", async () => {
    const catalog = new FederatedCatalog([SOURCE], sourceServing([remote()]));
    await catalog.refresh();
    const store = new CatalogStore(undefined, undefined, undefined, catalog);
    const results = store.search("tide predictions for a harbour", {}, 5);
    expect(results.resources.map(r => r.resource)).toContain("https://remote.example.com/tides");
    expect(results.resources[0]!.provenance?.source).toBe("example-list");
  });
});

describe("federation — what it refuses to import", () => {
  const importedFrom = async (items: unknown[]) => {
    const catalog = new FederatedCatalog([SOURCE], sourceServing(items));
    await catalog.refresh();
    return catalog.all();
  };

  it("drops Stellar exact listings the stock client cannot pay", async () => {
    // The live CDP catalog carries these: no `extra.areFeesSponsored`, which the stock
    // @x402/stellar client throws on. Mirroring them relocates somebody else's broken listings
    // into our results, which is worse than not federating.
    expect(await importedFrom([remote({ accepts: [{ ...remote().accepts[0], extra: {} }] })])).toHaveLength(0);
  });

  it("drops entries with no usable resource URL or payment option", async () => {
    expect(await importedFrom([remote({ resource: "mcp://tool/x" })])).toHaveLength(0);
    expect(await importedFrom([remote({ resource: 42 })])).toHaveLength(0);
    expect(await importedFrom([remote({ accepts: [] })])).toHaveLength(0);
    expect(await importedFrom([remote({ accepts: "nope" })])).toHaveLength(0);
  });

  it("drops an MCP listing that carries no tool name, since it has no identity", async () => {
    expect(await importedFrom([remote({ type: "mcp" })])).toHaveLength(0);
    const withTool = await importedFrom([
      remote({ type: "mcp", extensions: { bazaar: { info: { input: { toolName: "harbour_tides" } } } } }),
    ]);
    expect(withTool[0]?.toolName).toBe("harbour_tides");
  });

  it("republishes no `extra.stellar` from the source", async () => {
    // Asset identity is something WE derive. Passing a remote catalog's claim through under our name
    // would turn a proof into a rumour while keeping the label that says it is a proof.
    const imported = await importedFrom([
      remote({
        accepts: [{ ...remote().accepts[0], extra: { areFeesSponsored: true, stellar: { asset: { code: "USDC", identity: "derived" } } } }],
      }),
    ]);
    expect(imported[0]!.accepts[0]!.extra["stellar"]).toBeUndefined();
    expect(imported[0]!.accepts[0]!.extra["areFeesSponsored"]).toBe(true);
  });

  it("honours a source's network restriction", async () => {
    const catalog = new FederatedCatalog(
      [{ ...SOURCE, networks: ["stellar:testnet"] }],
      sourceServing([remote({ accepts: [{ ...remote().accepts[0], network: "eip155:8453" }] })]),
    );
    await catalog.refresh();
    expect(catalog.all()).toHaveLength(0);
  });
});

describe("federation — a source being down", () => {
  it("keeps serving the previous mirror and reports a retryable error", async () => {
    let ok = true;
    const flaky = (async () => {
      if (!ok) throw new Error("ECONNREFUSED");
      return new Response(JSON.stringify({ items: [remote()] }), { status: 200 });
    }) as unknown as typeof fetch;

    const catalog = new FederatedCatalog([SOURCE], flaky);
    expect((await catalog.refresh())[0]!.imported).toBe(1);

    ok = false;
    const second = await catalog.refresh();
    // Degrading freshness beats deleting listings an agent found five minutes ago.
    expect(second[0]!.error?.code).toBe("bazaar_federation_source_unavailable");
    expect(second[0]!.error?.retryable).toBe(true);
    expect(catalog.all()).toHaveLength(1);
  });

  it("treats a non-200 as unavailable rather than as an empty catalog", async () => {
    const catalog = new FederatedCatalog([SOURCE], sourceServing([remote()], 503));
    const results = await catalog.refresh();
    expect(results[0]!.error?.code).toBe("bazaar_federation_source_unavailable");
  });
});
