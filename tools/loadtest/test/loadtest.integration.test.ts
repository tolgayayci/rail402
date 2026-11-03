/** The driver against a real HTTP server: discovery routes over the evaluation corpus. */
import type { AddressInfo } from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { MemoryCatalogStore } from "@rail402.dev/bazaar";
import { AssetRegistry, SearchService } from "@rail402.dev/search";
import { seedCatalog, type Dataset } from "@rail402.dev/search-eval";
import { discoveryRoutes } from "@rail402.dev/service";
import { catalogA, evalQueries } from "../src/datasets.ts";
import { runOpenLoop, type Sample } from "../src/driver.ts";
import { summarize } from "../src/summary.ts";

let server: ServerType | undefined;
afterAll(() => {
  server?.close();
});

describe("the load driver over HTTP", () => {
  it("drives searches and list pages at a constant rate and records every answer", async () => {
    const store = new MemoryCatalogStore();
    await seedCatalog(store, { corpus: await catalogA() } as unknown as Dataset);
    const search = new SearchService({
      store,
      assets: new AssetRegistry([]),
      cursorSecret: Buffer.alloc(32, 3),
    });
    await search.refresh();
    const app = new Hono().route("/discovery", discoveryRoutes(store, search));
    const port = await new Promise<number>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => {
        resolve(info.port);
      });
    });
    const queries = await evalQueries();
    const samples: Sample[] = [];
    const result = await runOpenLoop({
      base: `http://127.0.0.1:${String(port)}`,
      rate: 100,
      durationMs: 1_000,
      next: (index) =>
        index % 5 === 4
          ? { path: "/discovery/resources?limit=20", label: "list" }
          : {
              path: `/discovery/search?query=${encodeURIComponent(queries[index % queries.length] ?? "")}`,
              label: "warm",
            },
      onSample: (sample) => samples.push(sample),
    });
    expect(result).toEqual({ sent: 100, saturated: 0 });
    const summary = summarize(samples);
    expect(summary["warm"]).toMatchObject({ requests: 80, errors: 0 });
    expect(summary["list"]).toMatchObject({ requests: 20, errors: 0 });
    expect(summary["warm"]?.methods["lexical"] ?? 0).toBeGreaterThan(0);
  });
});
