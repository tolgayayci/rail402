/**
 * A discovery-only staging service for load tests on a workstation: Rail402's discovery routes over a
 * Postgres catalog, with the search service built as the runtime builds it (the pinned model, the
 * discovery settings read from the environment, a one-second revision cache), and `/health` with the
 * ranker identity. It serves no payments and needs no Stellar network.
 *
 *   DATABASE_URL=postgres://…/rail402_loadtest PORT=8090 \
 *     node --conditions=@rail402/source tools/loadtest/src/staging.ts
 *
 * The database name must contain "loadtest", "staging" or "eval": never point it at a live catalog.
 */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import {
  AssetRegistry,
  OnnxEmbedder,
  SearchService,
  ensureModel,
  loadManifest,
  type KnownAsset,
} from "@rail402.dev/search";
import { PostgresCatalogStore, createDatabase, migrate } from "@rail402.dev/store-postgres";
import { discoveryRoutes, loadDiscoveryConfig, rateLimitKey } from "@rail402.dev/service";

const url = process.env["DATABASE_URL"];
if (url === undefined || !/(eval|staging|loadtest)/i.test(new URL(url).pathname)) {
  console.error('DATABASE_URL must name a staging database ("loadtest", "staging" or "eval" in its name)');
  process.exit(2);
}
const port = Number(process.env["PORT"] ?? "8090");
const discovery = loadDiscoveryConfig(process.env, ["stellar:testnet", "stellar:pubnet"]);
const db = createDatabase({ connectionString: url, maxConnections: 10 });
await migrate(db);
const store = new PostgresCatalogStore(db);
const assets = JSON.parse(
  await readFile(new URL("../../search-eval/data/assets.json", import.meta.url), "utf8"),
) as KnownAsset[];
const manifest = await loadManifest();
const embedder =
  process.env["SEARCH_EMBEDDINGS"] === "false"
    ? undefined
    : await OnnxEmbedder.load(
        manifest,
        await ensureModel(manifest, process.env["SEARCH_MODEL_DIR"] ?? ".models", { download: false }),
      );
const search = new SearchService({
  store,
  assets: new AssetRegistry(assets),
  cursorSecret: randomBytes(32),
  similarityFloor: Number(process.env["SEARCH_SIMILARITY_FLOOR"] ?? "0.3"),
  revisionMaxAgeMs: 1_000,
  ...discovery.search,
  ...(embedder === undefined ? {} : { embedder }),
});
await search.refresh();
// The runtime rebuilds the index in the background every 5 seconds; so does this service.
setInterval(() => {
  void search.refresh().catch(() => undefined);
}, 5_000).unref();

const app = new Hono()
  .route(
    "/discovery",
    discoveryRoutes(store, search, {
      ...discovery.limits,
      clientKey: (c) => rateLimitKey(c.req.header("x-forwarded-for") ?? "local"),
    }),
  )
  .get("/health", (c) =>
    c.json({ status: "ok", version: "loadtest-staging", search: { ranker: search.rankerIdentity() } }),
  );

serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
  console.log(`discovery staging service on http://127.0.0.1:${String(info.port)}`);
});
