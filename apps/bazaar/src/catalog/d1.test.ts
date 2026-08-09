import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { CatalogStore } from "./store.js";
import { D1CatalogPersistence, type D1Like, type D1StatementLike } from "./d1.js";
import type { CatalogEntry } from "./types.js";

/**
 * D1 durability, tested against a real SQL engine.
 *
 * D1 *is* SQLite behind an async API, so the fake below is `node:sqlite` wearing D1's four-method
 * shape rather than a hand-written mock returning canned rows. That matters: a mock that agrees with
 * the code it tests would not have caught the NUL-byte key collapse, and the whole point of this
 * backend is that the SQL it emits is correct.
 */
function fakeD1(): D1Like & { rows(): number } {
  const db = new DatabaseSync(":memory:");
  const stmt = (query: string, bound: unknown[] = []): D1StatementLike => ({
    bind: (...values: unknown[]) => stmt(query, values),
    all: async <T>() => ({ results: db.prepare(query).all(...(bound as never[])) as T[] }),
    run: async () => db.prepare(query).run(...(bound as never[])),
  });
  return {
    prepare: (query: string) => stmt(query),
    batch: async () => undefined,
    exec: async (query: string) => db.exec(query),
    rows: () => (db.prepare("SELECT COUNT(*) AS n FROM catalog").get() as { n: number }).n,
  };
}

const entry = (over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  resource: "https://api.example.com/weather",
  type: "http",
  x402Version: 2,
  accepts: [{
    scheme: "exact", network: "stellar:testnet", amount: "1000000",
    asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    payTo: "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO",
    maxTimeoutSeconds: 60, extra: { areFeesSponsored: true },
  }],
  lastUpdated: "2026-08-07T00:00:00.000Z",
  description: "Hourly weather observations and forecasts for a named city.",
  quality: { totalSettlements: 1, uniquePayers: 0, firstSeenAt: "2026-08-07T00:00:00.000Z" },
  ownerPayTo: "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO",
  ...over,
});

const settle = async (store: CatalogStore) => { await new Promise(r => setImmediate(r)); void store; };

describe("D1 catalog durability", () => {
  it("restores entries, ownership, payer set and search rank into a NEW store", async () => {
    const d1 = fakeD1();
    const first = new CatalogStore(undefined, undefined, new D1CatalogPersistence(d1));
    await first.ready();
    first.upsert(entry(), "GC6CSXBV4C6RL3HEDTW57KXYXSSXKAWKGYDEOSATXM3XNKXSR2VRYN3K");
    first.upsert(entry(), "GAWT6IWKJMIMD552OX2EZKBMWJ32JEWEKXG57IAVYWI4OZJWLLTS2VJF");
    await settle(first);
    expect(d1.rows()).toBe(1);

    // The restart. A second store over the same database, as a new isolate would be.
    const restored = new CatalogStore(undefined, undefined, new D1CatalogPersistence(d1));
    await restored.ready();
    const found = restored.get("https://api.example.com/weather");
    expect(found?.ownerPayTo).toBe("GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO");
    // The payer SET, not just its size — restoring only the count would let one payer be counted
    // twice across a restart, which is a forgeable ranking signal.
    restored.upsert(entry(), "GC6CSXBV4C6RL3HEDTW57KXYXSSXKAWKGYDEOSATXM3XNKXSR2VRYN3K");
    expect(restored.get("https://api.example.com/weather")?.quality.uniquePayers).toBe(2);
    // Restored but unsearchable is half-restored, and browse would hide it.
    expect(restored.search("weather forecast for a city", {}, 5).resources.map(r => r.resource))
      .toContain("https://api.example.com/weather");
  });

  it("keeps two MCP tools on one endpoint distinct across a restart", async () => {
    // The NUL-joined composite key cannot survive a bind to a text column — in node:sqlite it
    // truncates, and either way one tool would silently overwrite the other. The pair is stored as
    // two columns and the key rebuilt on load.
    const d1 = fakeD1();
    const first = new CatalogStore(undefined, undefined, new D1CatalogPersistence(d1));
    await first.ready();
    for (const toolName of ["harbour_tides", "harbour_wind"]) {
      first.upsert(entry({ resource: "https://api.example.com/mcp", type: "mcp", toolName }));
    }
    await settle(first);
    expect(d1.rows()).toBe(2);

    const restored = new CatalogStore(undefined, undefined, new D1CatalogPersistence(d1));
    await restored.ready();
    expect(restored.size).toBe(2);
    expect(restored.get("https://api.example.com/mcp", "harbour_wind")?.toolName).toBe("harbour_wind");
  });

  it("serves from memory and reports degraded when D1 rejects a write", async () => {
    // Memory first, durability second: a settled payment must never be reported as failed because
    // a storage backend was unavailable.
    const broken: D1Like = {
      prepare: () => ({
        bind: () => broken.prepare(""),
        all: async () => ({ results: [] }),
        run: async () => { throw new Error("D1_ERROR: network"); },
      }),
      batch: async () => undefined,
      exec: async () => undefined,
    };
    const store = new CatalogStore(undefined, undefined, new D1CatalogPersistence(broken));
    await store.ready();
    expect(() => store.upsert(entry())).not.toThrow();
    expect(store.get("https://api.example.com/weather")).toBeDefined();
    await new Promise(r => setTimeout(r, 10));
    expect(store.persistenceDegraded).toMatch(/D1_ERROR/);
  });

  it("hands every pending write to the host keep-alive so a Worker cannot cancel it", async () => {
    // On Workers, pending work is cancelled when the response returns unless it was passed to
    // `ctx.waitUntil`. Without this the D1 write for each settled payment was dropped in silence:
    // /health still said "durable" and the writing isolate still served the listing from its own
    // memory, so the only visible symptom was a permanently empty catalog on a fresh isolate.
    const d1 = fakeD1();
    const kept: Promise<unknown>[] = [];
    const store = new CatalogStore(undefined, undefined, new D1CatalogPersistence(d1));
    await store.ready();
    store.setKeepAlive(work => void kept.push(work));

    store.upsert(entry());
    expect(kept).toHaveLength(1);

    // Awaiting what the host was handed must be enough for the row to land. If the store passed on
    // some already-settled promise instead of the write itself, this would still be 0.
    await Promise.all(kept);
    expect(d1.rows()).toBe(1);
  });

  it("serves an empty catalog rather than crashing when hydration fails", async () => {
    const broken: D1Like = {
      prepare: () => { throw new Error("D1_ERROR: unavailable"); },
      batch: async () => undefined,
      exec: async () => { throw new Error("D1_ERROR: unavailable"); },
    };
    const store = new CatalogStore(undefined, undefined, new D1CatalogPersistence(broken));
    await expect(store.ready()).resolves.toBeUndefined();
    expect(store.size).toBe(0);
    expect(store.persistenceDegraded).toMatch(/D1_ERROR/);
  });
});
