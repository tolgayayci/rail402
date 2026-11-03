import { describe, expect, it } from "vitest";
import { MemoryCatalogStore } from "@rail402.dev/bazaar";
import { AssetRegistry, SearchService, loadManifest, type Embedder } from "@rail402.dev/search";
import { HealthMonitor, Metrics } from "@rail402.dev/service";

describe("search ranker identity in /health", () => {
  it("shows the model, its file hashes, the ranking settings and the eval baseline", async () => {
    const manifest = await loadManifest();
    const embedder: Embedder = {
      id: manifest.id,
      dimensions: manifest.dimensions,
      manifest,
      embed: () => Promise.resolve(new Float32Array(manifest.dimensions)),
    };
    const search = new SearchService({
      store: new MemoryCatalogStore(),
      assets: new AssetRegistry([]),
      cursorSecret: Buffer.alloc(32, 1),
      embedder,
      similarityFloor: 0.3,
    });
    const health = new HealthMonitor(new Metrics(), {
      version: "1.2.3",
      ttlWarnLedgers: 518_400,
      ttlCriticalLedgers: 120_960,
    });
    const snapshot = await health.refresh({
      networks: [],
      search: { indexRevision: 1, lastBuild: "ok", ranker: search.rankerIdentity() },
    });
    expect(snapshot.search?.ranker).toEqual({
      model: "all-minilm-l6-v2",
      revision: manifest.revision,
      files: { model: manifest.files.model.sha256, tokenizer: manifest.files.tokenizer.sha256 },
      similarityFloor: 0.3,
      depth: 100,
      embeddings: true,
      searchPackage: expect.stringMatching(/^\d+\.\d+\.\d+/) as string,
      evalBaseline: "search-eval-v1.1.0",
    });
  });

  it("says when search runs lexical-only", () => {
    const search = new SearchService({
      store: new MemoryCatalogStore(),
      assets: new AssetRegistry([]),
      cursorSecret: Buffer.alloc(32, 1),
    });
    expect(search.rankerIdentity()).toMatchObject({
      model: null,
      revision: null,
      files: null,
      embeddings: false,
    });
  });
});
