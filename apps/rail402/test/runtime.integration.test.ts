/**
 * The service runtime against a local Stellar network: what /ready is composed of, background search
 * indexing, shutdown and the embedding-model startup check. Needs `docker compose --profile stellar up -d`.
 */
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { sql } from "kysely";
import { settledPayment } from "@rail402.dev/bazaar";
import { silentLogger } from "@rail402.dev/facilitator";
import { loadManifest } from "@rail402.dev/search";
import { Metrics, createRuntime, loadConfig, type Runtime } from "@rail402.dev/service";
import { createDatabase } from "@rail402.dev/store-postgres";
import { LocalNetwork, startRpcProxy } from "@rail402.dev/testkit";
import { DATABASE_URL } from "./service-harness.ts";

const net = new LocalNetwork();
const available = await net.available();

describe.skipIf(!available)("service runtime", () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  /** A runtime on the local network with the in-memory store, lexical search and a funded sponsor. */
  async function runtimeWith(env: Record<string, string> = {}, options: { fund?: boolean } = {}) {
    const sponsor = Keypair.random();
    if (options.fund !== false) await net.fund(sponsor);
    const metrics = new Metrics();
    const runtime = await createRuntime(
      loadConfig({
        STORE: "memory",
        TESTNET_RPC_URL: net.rpcUrl,
        TESTNET_SPONSOR_SECRET: sponsor.secret(),
        TESTNET_CHANNEL_COUNT: "2",
        TESTNET_MIN_SPONSOR_BALANCE_XLM: "1",
        SEARCH_EMBEDDINGS: "false",
        // Origin checks would fetch resources on the internet; none are due in these tests anyway.
        ORIGIN_CHECK_INTERVAL_MS: "3600000",
        ...env,
      }),
      metrics,
      silentLogger,
    );
    cleanups.push(() => runtime.stop());
    return { runtime, metrics };
  }

  const ready = (runtime: Runtime) =>
    expect.poll(async () => (await runtime.readiness()).ready, { timeout: 30_000 }).toBe(true);

  describe("readiness", () => {
    it("checks the database, each network's RPC, sponsor and channels, and the search index", async () => {
      const schema = `rt_${randomBytes(6).toString("hex")}`;
      const admin = createDatabase({ connectionString: DATABASE_URL, maxConnections: 1 });
      await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
      cleanups.push(async () => {
        await sql`DROP SCHEMA IF EXISTS ${sql.id(schema)} CASCADE`.execute(admin);
        await admin.destroy();
      });
      const { runtime } = await runtimeWith({
        STORE: "postgres",
        DATABASE_URL: `${DATABASE_URL}?options=-c%20search_path%3D${schema}`,
      });

      // Before start(): no balance reading yet and no search index.
      const cold = await runtime.readiness();
      expect(cold.ready).toBe(false);
      expect(cold.checks["stellar:testnet:sponsor"]).toEqual({
        ok: false,
        detail: "balance unknown below minimum",
      });
      expect(cold.checks["search"]).toEqual({ ok: false, detail: "building the search index" });

      runtime.start();
      await ready(runtime);
      const { checks } = await runtime.readiness();
      expect(Object.keys(checks).sort()).toEqual([
        "database",
        "search",
        "stellar:testnet:channels",
        "stellar:testnet:rpc",
        "stellar:testnet:sponsor",
      ]);
      expect(checks).toMatchObject({
        database: { ok: true },
        "stellar:testnet:rpc": { ok: true },
        "stellar:testnet:sponsor": { ok: true, detail: expect.stringMatching(/^\d+ stroops$/) as string },
        "stellar:testnet:channels": { ok: true, detail: "2 channels" },
        search: { ok: true },
      });
    });

    it("has no database check with STORE=memory and no search check without the Bazaar", async () => {
      const { runtime } = await runtimeWith({ BAZAAR_ENABLED: "false" });
      runtime.start();
      await ready(runtime);
      expect(Object.keys((await runtime.readiness()).checks).sort()).toEqual([
        "stellar:testnet:channels",
        "stellar:testnet:rpc",
        "stellar:testnet:sponsor",
      ]);
    });

    it("fails while the sponsor holds less than MIN_SPONSOR_BALANCE_XLM", async () => {
      // Friendbot funds 10,000 XLM.
      const { runtime } = await runtimeWith({ TESTNET_MIN_SPONSOR_BALANCE_XLM: "20000" });
      runtime.start();
      await expect
        .poll(async () => (await runtime.readiness()).checks["stellar:testnet:sponsor"]?.detail, {
          timeout: 30_000,
        })
        .toMatch(/^balance \d+ below minimum$/);
      const readiness = await runtime.readiness();
      expect(readiness.ready).toBe(false);
      expect(readiness.checks["stellar:testnet:sponsor"]?.ok).toBe(false);
      expect(readiness.checks["stellar:testnet:rpc"]).toEqual({ ok: true });
    });

    it("fails while channel accounts are missing", async () => {
      const { runtime } = await runtimeWith({ TESTNET_AUTO_PROVISION_CHANNELS: "false" });
      runtime.start();
      await expect.poll(async () => (await runtime.readiness()).checks["search"]?.ok).toBe(true);
      const readiness = await runtime.readiness();
      expect(readiness.ready).toBe(false);
      expect(readiness.checks["stellar:testnet:channels"]).toEqual({
        ok: false,
        detail: "channel accounts are not all provisioned",
      });
    });

    it("fails while the RPC is unreachable", async () => {
      const proxy = await startRpcProxy(net.rpcUrl);
      const { runtime } = await runtimeWith({ TESTNET_RPC_URL: proxy.url });
      await proxy.close();
      runtime.start();
      await expect
        .poll(async () => (await runtime.readiness()).checks["stellar:testnet:rpc"]?.ok)
        .toBe(false);
      const readiness = await runtime.readiness();
      expect(readiness.ready).toBe(false);
      expect(readiness.checks["stellar:testnet:rpc"]?.detail).not.toBe("");
    });

    it("publishes the sponsor balance and channel gauges", async () => {
      const { runtime, metrics } = await runtimeWith();
      runtime.start();
      await ready(runtime);
      const exposition = await metrics.registry.metrics();
      expect(exposition).toMatch(/^rail402_sponsor_balance_stroops\{network="stellar:testnet"\} \d+$/m);
      expect(exposition).toContain('rail402_channels_total{network="stellar:testnet"} 2');
      expect(exposition).toContain('rail402_channels_in_use{network="stellar:testnet"} 0');
    });
  });

  it("re-checks the search index every 5 seconds in the background", async () => {
    const { runtime } = await runtimeWith();
    const bazaar = runtime.bazaar;
    if (bazaar === undefined) throw new Error("the Bazaar is enabled by default");
    const refreshes: number[] = [];
    const built: number[] = [];
    const refresh = bazaar.search.refresh.bind(bazaar.search);
    vi.spyOn(bazaar.search, "refresh").mockImplementation(async () => {
      refreshes.push(performance.now());
      const snapshot = await refresh();
      built.push(snapshot.revision);
      return snapshot;
    });

    runtime.start();
    await expect.poll(() => refreshes.length, { timeout: 15_000, interval: 250 }).toBeGreaterThanOrEqual(2);
    const gap = (refreshes[1] ?? 0) - (refreshes[0] ?? 0);
    expect(gap).toBeGreaterThan(4_800);
    expect(gap).toBeLessThan(6_000);

    // A catalog change is indexed by the next background check, without any search.
    // An MCP tool is listed on settlement (HTTP resources wait for their origin's 402).
    const outcome = await bazaar.catalog.record(
      settledPayment({ url: "https://api.example.com/mcp", kind: "mcp", toolName: "forecast" }),
    );
    expect(outcome?.code).toBe("cataloged");
    const revision = await bazaar.store.revision();
    expect(built).not.toContain(revision);
    await expect.poll(() => built, { timeout: 7_000, interval: 250 }).toContain(revision);
  });

  it("reconciles once more when it stops", async () => {
    const { runtime } = await runtimeWith();
    runtime.start();
    const reconcile = vi.spyOn(runtime.facilitator, "reconcile");
    await runtime.stop();
    cleanups.pop();
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  describe("with embeddings on", () => {
    const directories: string[] = [];
    afterAll(async () => {
      await Promise.all(directories.map((path) => rm(path, { recursive: true, force: true })));
    });
    const modelDirectory = async () => {
      const path = await mkdtemp(join(tmpdir(), "rail402-model-"));
      directories.push(path);
      return path;
    };
    const embeddings = (directory: string) => ({
      SEARCH_EMBEDDINGS: "true",
      SEARCH_MODEL_DIR: directory,
      TESTNET_AUTO_PROVISION_CHANNELS: "false",
    });

    it("refuses to start when the model files are missing", async () => {
      const directory = await modelDirectory();
      await expect(runtimeWith(embeddings(directory), { fund: false })).rejects.toThrow(
        /embedding model file .* is missing/,
      );
    });

    it("refuses to start when a model file does not match the pinned manifest", async () => {
      const manifest = await loadManifest();
      const directory = await modelDirectory();
      await mkdir(join(directory, manifest.id));
      await writeFile(join(directory, manifest.id, "model.onnx"), "not the pinned model");
      await writeFile(join(directory, manifest.id, "tokenizer.json"), "{}");
      await expect(runtimeWith(embeddings(directory), { fund: false })).rejects.toThrow(
        `expected ${manifest.files.model.sha256}`,
      );
    });
  });
});
