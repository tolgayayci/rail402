import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { loadConfig } from "./config.js";
import { ExplorerStore } from "./db.js";
import { IngestWorker } from "./ingest.js";
import type { Enricher } from "./enrich.js";
import type { FetchLike } from "./rpc.js";

/** Canned RPC built from the REAL captures in fixtures/ — the worker sees exactly the bytes the
 * live RPC served on 2026-08-13. */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const EXACT_HASH = "0207d143713d28c5c0bbb1db2ac49b3ad06157510121eb5cd36dbc16dbfbfc80";
const CLAIM_YIELD_HASH = "3efaed0096dbc561b8d34d383764a2e176723141e639318a31a08637bdd529b3";

const TX_FIXTURES: Record<string, string> = {
  [EXACT_HASH]: fixture("gettx-exact-candidate.json"),
  [CLAIM_YIELD_HASH]: fixture("gettx-caddr-sender.json"),
};

interface Recorded {
  method: string;
  params: Record<string, unknown> | undefined;
}

function cannedRpc(overrides: {
  getEvents?: (params: Record<string, unknown> | undefined, call: number) => string;
  getHealth?: () => string;
  record?: Recorded[];
}): FetchLike {
  let eventCalls = 0;
  return (_url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      method: string;
      params?: Record<string, unknown>;
    };
    overrides.record?.push({ method: body.method, params: body.params });
    let payload: string;
    if (body.method === "getEvents") {
      eventCalls += 1;
      payload = overrides.getEvents
        ? overrides.getEvents(body.params, eventCalls)
        : fixture("getevents-raw.json");
    } else if (body.method === "getHealth") {
      payload = overrides.getHealth
        ? overrides.getHealth()
        : JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { status: "healthy", latestLedger: 4125114, oldestLedger: 4004150 },
          });
    } else if (body.method === "getTransaction") {
      const hash = String(body.params?.["hash"]);
      payload =
        TX_FIXTURES[hash] ??
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { status: "NOT_FOUND", latestLedger: 4125114 },
        });
    } else {
      payload = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32601, message: `unexpected method ${body.method}` },
      });
    }
    return Promise.resolve(new Response(payload, { status: 200 }));
  };
}

const stubEnricher: Enricher = {
  lookup: (network, payTo) =>
    Promise.resolve({
      network,
      payTo,
      serviceName: "Test Service",
      resource: "https://api.test/thing",
      fetchedAt: "2026-08-13T18:00:00.000Z",
    }),
};

function worker(store: ExplorerStore, fetchImpl: FetchLike): IngestWorker {
  return new IngestWorker({
    store,
    config: loadConfig({} as NodeJS.ProcessEnv),
    enricher: stubEnricher,
    logger: pino({ level: "silent" }),
    fetchImpl,
    now: () => new Date("2026-08-13T19:00:00.000Z"),
  });
}

const testnet = loadConfig({} as NodeJS.ProcessEnv).networks[0]!;

describe("IngestWorker.pollOnce", () => {
  it("ingests exactly the x402-shaped payment from a real 30-event window, enriched", async () => {
    const store = new ExplorerStore();
    const w = worker(store, cannedRpc({}));
    const { inserted, events } = await w.pollOnce(testnet);
    expect(events).toBe(30);
    // The window holds 30 transfer events; only tx 0207d143… is x402-shaped (the claim_yield tx
    // and the anchor/native traffic must all be refused).
    expect(inserted).toBe(1);
    const row = store.getPaymentByHash(EXACT_HASH)!;
    expect(row.scheme).toBe("exact");
    expect(row.confidence).toBe("x402-shaped");
    expect(row.serviceName).toBe("Test Service");
    expect(row.resource).toBe("https://api.test/thing");
    expect(row.epoch).toBe("2026-08-13T19:00:00.000Z");
  });

  it("persists the getEvents cursor and head ledger for resume", async () => {
    const store = new ExplorerStore();
    const w = worker(store, cannedRpc({}));
    await w.pollOnce(testnet);
    const cursor = store.getCursor("stellar:testnet")!;
    expect(cursor.cursor).toBe("0017716332074131456-0000000000");
    expect(cursor.lastLedger).toBe(4125114);
  });

  it("does not re-insert or re-fetch on a second poll over the same window", async () => {
    const store = new ExplorerStore();
    const record: Recorded[] = [];
    const w = worker(store, cannedRpc({ record }));
    await w.pollOnce(testnet);
    const fetchesAfterFirst = record.filter(r => r.method === "getTransaction").length;
    const { inserted } = await w.pollOnce(testnet);
    expect(inserted).toBe(0);
    // The seen-cache must prevent every one of those envelope fetches from repeating.
    expect(record.filter(r => r.method === "getTransaction").length).toBe(fetchesAfterFirst);
  });

  it("resumes FROM the stored cursor instead of re-anchoring", async () => {
    const store = new ExplorerStore();
    store.setCursor({
      network: "stellar:testnet",
      epoch: "E1",
      cursor: "stored-cursor",
      lastLedger: 4125000,
      updatedAt: "2026-08-13T18:00:00.000Z",
    });
    const record: Recorded[] = [];
    const w = worker(store, cannedRpc({ record }));
    await w.pollOnce(testnet);
    const eventsCall = record.find(r => r.method === "getEvents")!;
    expect((eventsCall.params?.["pagination"] as Record<string, unknown>)["cursor"]).toBe(
      "stored-cursor",
    );
    expect(eventsCall.params?.["startLedger"]).toBeUndefined();
    // Health never needed when the cursor works.
    expect(record.some(r => r.method === "getHealth")).toBe(false);
    expect(store.getCursor("stellar:testnet")!.epoch).toBe("E1");
  });

  it("detects a network reset (head far below high-water mark) and starts a NEW epoch", async () => {
    const store = new ExplorerStore();
    store.setCursor({
      network: "stellar:testnet",
      epoch: "OLD-EPOCH",
      cursor: "stale-cursor",
      lastLedger: 9_999_999,
      updatedAt: "2026-08-13T18:00:00.000Z",
    });
    const fetchImpl = cannedRpc({
      getEvents: (params, call) =>
        call === 1 && params?.["pagination"] !== undefined && params?.["startLedger"] === undefined
          ? JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              error: {
                code: -32600,
                message: "startLedger must be within the ledger range: 100 - 300",
              },
            })
          : JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: { events: [], latestLedger: 300, cursor: "fresh-cursor" },
            }),
      getHealth: () =>
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { status: "healthy", latestLedger: 300, oldestLedger: 100 },
        }),
    });
    const w = worker(store, fetchImpl);
    await w.pollOnce(testnet);
    const cursor = store.getCursor("stellar:testnet")!;
    expect(cursor.epoch).toBe("2026-08-13T19:00:00.000Z");
    expect(cursor.epoch).not.toBe("OLD-EPOCH");
    expect(cursor.lastLedger).toBe(300);
    expect(cursor.cursor).toBe("fresh-cursor");
  });

  it("HOLDS the cursor when a getTransaction fails, so the payment is not lost (review M2)", async () => {
    const store = new ExplorerStore();
    let txFails = true;
    // getEvents/getHealth succeed; getTransaction fails on the first poll, succeeds on the second.
    const fetchImpl: FetchLike = (url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { method: string };
      if (body.method === "getTransaction" && txFails) return Promise.reject(new Error("timeout"));
      return cannedRpc({})(url, init);
    };
    const w = worker(store, fetchImpl);
    const first = await w.pollOnce(testnet);
    expect(first.inserted).toBe(0);
    // Cursor must NOT have advanced — nothing persisted while a hash was unfetched.
    expect(store.getCursor("stellar:testnet")).toBeUndefined();

    txFails = false;
    const second = await w.pollOnce(testnet);
    expect(second.inserted).toBe(1);
    expect(store.getPaymentByHash(EXACT_HASH)).toBeDefined();
    expect(store.getCursor("stellar:testnet")!.cursor).toBe("0017716332074131456-0000000000");
  });

  it("survives an unreachable RPC with a recorded failure and retries cleanly", async () => {
    const store = new ExplorerStore();
    let fail = true;
    const flaky: FetchLike = (url, init) => {
      if (fail) return Promise.reject(new Error("ECONNREFUSED"));
      return cannedRpc({})(url, init);
    };
    const w = worker(store, flaky);
    await expect(w.pollOnce(testnet)).rejects.toThrow();
    expect(w.healthReport()[0]!.consecutiveFailures).toBe(1);
    fail = false;
    const { inserted } = await w.pollOnce(testnet);
    expect(inserted).toBe(1);
    expect(w.healthReport()[0]!.consecutiveFailures).toBe(0);
  });

  it("deep-backfills the whole retention window from the oldest ledger, then marks done", async () => {
    const store = new ExplorerStore();
    const record: Recorded[] = [];
    const fetchImpl = cannedRpc({
      record,
      getEvents: (params, call) =>
        call === 1
          ? fixture("getevents-raw.json")
          : JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: { events: [], latestLedger: 4125114, cursor: "bf-final" },
            }),
    });
    const w = worker(store, fetchImpl);

    const EPOCH = "2026-08-13T19:00:00.000Z";
    const first = await w.backfillTick(testnet);
    // Page 1: anchored at getHealth's oldestLedger, real 30-event window, 1 x402 payment.
    expect(first.done).toBe(false);
    expect(first.inserted).toBe(1);
    const firstEvents = record.find(r => r.method === "getEvents")!;
    expect(firstEvents.params?.["startLedger"]).toBe(4004150);
    expect(store.getPaymentByHash(EXACT_HASH)).toBeDefined();
    expect(store.getBackfill("stellar:testnet", EPOCH)!.done).toBe(false);

    const second = await w.backfillTick(testnet);
    expect(second.done).toBe(true);
    expect(store.getBackfill("stellar:testnet", EPOCH)!.done).toBe(true);
    // A completed backfill never re-walks.
    const callsAfter = record.filter(r => r.method === "getEvents").length;
    await w.backfillTick(testnet);
    expect(record.filter(r => r.method === "getEvents").length).toBe(callsAfter);
    expect(w.counters.backfillPages).toBe(2);
  });

  it("resumes the backfill from its persisted cursor after a restart", async () => {
    const store = new ExplorerStore();
    store.setBackfill({
      network: "stellar:testnet",
      epoch: "2026-08-13T19:00:00.000Z",
      cursor: "bf-resume",
      targetLedger: 4125114,
      done: false,
      updatedAt: "2026-08-14T00:00:00Z",
    });
    const record: Recorded[] = [];
    const w = worker(store, cannedRpc({ record }));
    await w.backfillTick(testnet);
    const eventsCall = record.find(r => r.method === "getEvents")!;
    expect((eventsCall.params?.["pagination"] as Record<string, unknown>)["cursor"]).toBe(
      "bf-resume",
    );
    expect(eventsCall.params?.["startLedger"]).toBeUndefined();
  });

  it("trusts ONLY configured upto contracts, never registry-advertised ones (review C2)", () => {
    const store = new ExplorerStore();
    // A verified facilitator advertising an attacker-deployed no-op contract must NOT get it into
    // the classifier's trusted marker set — otherwise fabricated upto rows could be minted.
    store.upsertFacilitator({
      id: "attacker",
      baseUrl: "https://attacker.example",
      verified: true,
      signers: [],
      uptoContracts: ["CADQOBYHA4DQ5NTFXPBXTII2Y7GHUHW4KEBIYMFDQZBSPZCERHXPQ5U4"],
      networks: ["stellar:testnet"],
      source: "announce",
      createdAt: "2026-08-14T00:00:00Z",
    });
    const w = worker(store, cannedRpc({}));
    const ctx = w.classifyCtx(testnet, "E1");
    expect(ctx.uptoContracts.has("CCMM3FMGEH7FHRYXZ3WQDQCTIWDXGZBGW7D4UT7NKH34SUQACYC3U54X")).toBe(true);
    expect(ctx.uptoContracts.has("CADQOBYHA4DQ5NTFXPBXTII2Y7GHUHW4KEBIYMFDQZBSPZCERHXPQ5U4")).toBe(false);
  });

  it("attributes to a registered facilitator when the fee source is in the signer index", async () => {
    const store = new ExplorerStore();
    store.upsertFacilitator({
      id: "mystery-fac",
      baseUrl: "https://facilitator.example.org",
      verified: true,
      signers: ["GA6THKUY2XJZOBRFMEQMMEADSCQLCZ2QMQWAWMMDXBTE7SARKAXVH7TL"],
      uptoContracts: [],
      networks: ["stellar:testnet"],
      source: "seed",
      createdAt: "2026-08-13T00:00:00Z",
    });
    const w = worker(store, cannedRpc({}));
    await w.pollOnce(testnet);
    const row = store.getPaymentByHash(EXACT_HASH)!;
    expect(row.facilitatorId).toBe("mystery-fac");
    expect(row.confidence).toBe("verified-facilitator");
  });
});
