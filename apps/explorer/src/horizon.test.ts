import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { loadConfig } from "./config.js";
import { ExplorerStore } from "./db.js";
import { HorizonBackfill } from "./horizon.js";
import { IngestWorker } from "./ingest.js";
import type { Enricher } from "./enrich.js";
import type { FetchLike } from "./rpc.js";

/** Pages are built from REAL single-tx Horizon captures (fixtures/README.md). */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const record = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as Record<string, unknown>;

const RAIL402_TX = record("horizon-tx-rail402-exact.json");
const CANDIDATE_TX = record("horizon-tx-exact-candidate.json");
const RAIL402_SIGNER = "GBRVXNCL55KOEB7WU3BPSEL34PSUH63UCIFPZDUBIVJBRRG5ZB7V4YR7";

const logger = pino({ level: "silent" });
const config = loadConfig({} as NodeJS.ProcessEnv);
const stubEnricher: Enricher = { lookup: () => Promise.resolve(undefined) };

function setup(pageFetch: FetchLike): { store: ExplorerStore; backfill: HorizonBackfill; requests: string[] } {
  const store = new ExplorerStore();
  store.upsertFacilitator({
    id: "rail402",
    baseUrl: "https://facilitator.rail402.dev",
    verified: true,
    signers: [RAIL402_SIGNER],
    uptoContracts: [],
    networks: ["stellar:testnet"],
    source: "seed",
    createdAt: "2026-08-14T00:00:00Z",
  });
  const requests: string[] = [];
  const worker = new IngestWorker({
    store,
    config,
    enricher: stubEnricher,
    logger,
    fetchImpl: () => Promise.reject(new Error("worker must not fetch in this test")),
    now: () => new Date("2026-08-14T13:00:00.000Z"),
  });
  const backfill = new HorizonBackfill({
    store,
    config,
    worker,
    logger,
    fetchImpl: (url, init) => {
      requests.push(url);
      return pageFetch(url, init);
    },
    now: () => new Date("2026-08-14T13:00:00.000Z"),
  });
  return { store, backfill, requests };
}

const page = (records: unknown[]): Response =>
  new Response(JSON.stringify({ _embedded: { records } }), { status: 200 });

describe("HorizonBackfill", () => {
  it("recovers epoch history from a signer walk, attributed, with Horizon's fee", async () => {
    const { store, backfill, requests } = setup(() =>
      Promise.resolve(page([RAIL402_TX, CANDIDATE_TX])),
    );
    const inserted = await backfill.walkOnce();
    expect(inserted).toBe(2);

    const ours = store.getPaymentByHash(RAIL402_TX["hash"] as string)!;
    expect(ours.scheme).toBe("exact");
    expect(ours.confidence).toBe("rail402");
    expect(ours.feeCharged).toBe("23086");
    expect(ours.closedAt).toBe("2026-08-11T20:32:10.000Z");

    // The second record was settled by an UNRELATED facilitator but appeared in the walk —
    // it still classifies, honestly, as x402-shaped.
    const theirs = store.getPaymentByHash(CANDIDATE_TX["hash"] as string)!;
    expect(theirs.confidence).toBe("x402-shaped");

    // Walk queried the signer's history oldest-first with fee-bump participants included.
    expect(requests[0]).toContain(`/accounts/${RAIL402_SIGNER}/transactions`);
    expect(requests[0]).toContain("order=asc");
    expect(requests[0]).toContain("include_failed=false");
  });

  it("persists the paging cursor and resumes from it, never re-inserting", async () => {
    const { store, backfill, requests } = setup(() =>
      Promise.resolve(page([RAIL402_TX])),
    );
    await backfill.walkOnce();
    const cursor = store.getHorizonCursor("stellar:testnet", RAIL402_SIGNER);
    expect(cursor).toBe(RAIL402_TX["paging_token"]);

    const before = store.stats().totalPayments;
    await backfill.walkOnce();
    expect(store.stats().totalPayments).toBe(before);
    expect(requests[requests.length - 1]).toContain(`cursor=${cursor}`);
  });

  it("treats a 404 (never-funded signer) as a quiet skip and a network error as resumable", async () => {
    const notFound = setup(() => Promise.resolve(new Response("{}", { status: 404 })));
    await expect(notFound.backfill.walkOnce()).resolves.toBe(0);

    const failing = setup(() => Promise.reject(new Error("ETIMEDOUT")));
    await expect(failing.backfill.walkOnce()).resolves.toBe(0);
  });
});
