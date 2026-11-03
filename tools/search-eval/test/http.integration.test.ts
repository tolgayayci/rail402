/**
 * The HTTP evaluation against a production-configured search over Postgres: the corpus seeded through
 * the store into its own schema, the service's discovery routes with the search settings the runtime
 * derives from its configuration (the defaults the hosted service runs with, plus the corpus's assets)
 * and the pinned model. Needs Postgres and the model files in .models (pnpm models:fetch).
 */
import { randomBytes } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { sql, type Kysely } from "kysely";
import {
  AssetRegistry,
  OnnxEmbedder,
  SearchService,
  ensureModel,
  loadManifest,
  type KnownAsset,
} from "@rail402.dev/search";
import { PostgresCatalogStore, createDatabase, migrate, type Database } from "@rail402.dev/store-postgres";
import { discoveryRoutes, loadConfig, searchSettings } from "@rail402.dev/service";
import { evaluateOverHttp, httpGate, loadDataset, seedCatalog, type Baseline } from "../src/index.ts";

const URL_ = process.env["RAIL402_TEST_DATABASE_URL"] ?? "postgres://rail402:rail402@localhost:5432/rail402";
const schema = `eval_${randomBytes(6).toString("hex")}`;
const models = ".models";
let db: Kysely<Database> | undefined;

afterAll(async () => {
  await db?.destroy();
  const admin = createDatabase({ connectionString: URL_, maxConnections: 1 });
  await sql`DROP SCHEMA IF EXISTS ${sql.id(schema)} CASCADE`.execute(admin);
  await admin.destroy();
});

describe("search parity over HTTP on Postgres", () => {
  it.skipIf(!existsSync(`${models}/all-minilm-l6-v2`))(
    "reproduces the tagged evaluation through the discovery routes",
    async () => {
      const data = new URL("../data/", import.meta.url);
      const dataset = await loadDataset(data);
      const assets = JSON.parse(await readFile(new URL("assets.json", data), "utf8")) as KnownAsset[];
      const baseline = JSON.parse(await readFile(new URL("baseline.json", data), "utf8")) as Baseline;

      const admin = createDatabase({ connectionString: URL_, maxConnections: 1 });
      await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
      await admin.destroy();
      db = createDatabase({ connectionString: URL_, schema, maxConnections: 5 });
      await migrate(db);
      const store = new PostgresCatalogStore(db);
      expect(await seedCatalog(store, dataset)).toBe(dataset.corpus.length);

      const manifest = await loadManifest();
      const embedder = await OnnxEmbedder.load(
        manifest,
        await ensureModel(manifest, models, { download: false }),
      );
      // The runtime's configuration with no search setting overridden, as the hosted testnet service
      // runs, and the corpus's assets (what `http-main.ts --print-env` gives a staging service).
      const config = loadConfig({
        STORE: "memory",
        TESTNET_RPC_URL: "https://soroban-testnet.stellar.org",
        TESTNET_SPONSOR_SECRET: Keypair.random().secret(),
        TESTNET_ASSETS: assets
          .filter((asset) => asset.network === "stellar:testnet")
          .map((asset) => `${asset.contract}:${asset.symbol}:${String(asset.decimals)}`)
          .join(","),
      });
      const search = new SearchService({
        store,
        assets: new AssetRegistry(assets),
        cursorSecret: randomBytes(32),
        ...searchSettings(config),
        embedder,
      });
      await search.refresh();
      const app = new Hono()
        .route("/discovery", discoveryRoutes(store, search))
        .get("/health", (c) => c.json({ version: "staging", search: { ranker: search.rankerIdentity() } }));

      const report = await evaluateOverHttp({
        get: (path) => Promise.resolve(app.request(path)),
        dataset,
        assets,
      });
      expect(httpGate(report, baseline)).toEqual([]);
      expect(report.test.queries).toBe(81);
    },
    300_000,
  );
});
