import { describe, expect, it } from "vitest";
import {
  MemoryCatalogStore,
  randomAddress,
  settledPayment,
  Catalog,
  SchemaSandbox,
} from "@rail402.dev/bazaar";
import { corpusUuid, httpGate, loadDataset, searchPath, seedCatalog, type HttpReport } from "../src/index.ts";

const dataset = await loadDataset(new URL("../data/", import.meta.url));

describe("the HTTP evaluation", () => {
  it("stores corpus listings under stable UUIDs", () => {
    expect(corpusUuid("P001")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(corpusUuid("P001")).toBe(corpusUuid("P001"));
    expect(corpusUuid("P001")).not.toBe(corpusUuid("P002"));
  });

  it("seeds an empty catalog once, and refuses one that holds other listings", async () => {
    const store = new MemoryCatalogStore();
    expect(await seedCatalog(store, dataset)).toBe(dataset.corpus.length);
    expect((await store.stats()).listings.published).toBe(dataset.corpus.length);
    expect(await seedCatalog(store, dataset)).toBe(0);

    const live = new MemoryCatalogStore();
    const sandbox = new SchemaSandbox();
    try {
      await new Catalog({ store: live, sandbox }).record(
        settledPayment({ url: "mcp://tool/forecast", kind: "mcp", payTo: randomAddress() }),
      );
    } finally {
      await sandbox.close();
    }
    await expect(seedCatalog(live, dataset)).rejects.toThrow(/refusing to seed/);
    expect((await live.stats()).listings.published).toBe(1);
  });

  it("sends a query's explicit filters as parameters", () => {
    const path = searchPath("weather", { type: "http", network: "stellar:pubnet", asset: "USDC" });
    const params = new URL(`http://x${path}`).searchParams;
    expect(Object.fromEntries(params)).toEqual({
      query: "weather",
      limit: "20",
      type: "http",
      network: "stellar:pubnet",
      asset: "USDC",
    });
  });

  it("fails parity on lexical fallback, filter violations, errors or another model", () => {
    const baseline = {
      tag: "search-eval-v1.1.0",
      datasetHash: dataset.hash,
      model: "all-minilm-l6-v2@rev",
      test: { lexical: { ndcgAt10: 0.6, recallAt20: 0.8 }, hybrid: { ndcgAt10: 0.74, recallAt20: 0.9 } },
    };
    const passing: HttpReport = {
      datasetHash: dataset.hash,
      ranker: {
        model: "all-minilm-l6-v2",
        revision: "rev",
        files: { model: "a", tokenizer: "b" },
        similarityFloor: 0.3,
        depth: 100,
        embeddings: true,
        searchPackage: "0.4.2",
        evalBaseline: "search-eval-v1.1.0",
      },
      version: "test",
      test: { queries: 81, ndcgAt10: 0.73, recallAt20: 0.89, mrr: 0.88 },
      all: { queries: 168, ndcgAt10: 0.73, recallAt20: 0.87 },
      methods: { hybrid: 190, filter: 12 },
      partial: 0,
      violations: { network: 0, type: 0, asset: 0, price: 0, scheme: 0, payTo: 0 },
      checkedResults: 100,
      errors: [],
      latencyMs: { p50: 6, p95: 9, p99: 12 },
    };
    expect(httpGate(passing, baseline)).toEqual([]);
    expect(httpGate({ ...passing, methods: { hybrid: 180, lexical: 10 } }, baseline)).toHaveLength(1);
    expect(
      httpGate({ ...passing, violations: { ...passing.violations, network: 1 } }, baseline),
    ).toHaveLength(1);
    expect(httpGate({ ...passing, errors: [{ query: "Q1", status: 429 }] }, baseline)).toHaveLength(1);
    expect(httpGate({ ...passing, ranker: null }, baseline)).toHaveLength(1);
    expect(httpGate({ ...passing, test: { ...passing.test, ndcgAt10: 0.71 } }, baseline)).toHaveLength(1);
  });
});
