import { describe, expect, it } from "vitest";
import pino from "pino";
import { ExplorerStore } from "./db.js";
import { CatalogSync } from "./catalog-sync.js";
import type { FetchLike } from "./rpc.js";

const logger = pino({ level: "silent" });
const now = (): Date => new Date("2026-08-14T19:00:00.000Z");

function catalog(items: unknown[]): FetchLike {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify({ items, pagination: { total: items.length } }), { status: 200 }),
    );
}

describe("CatalogSync", () => {
  it("marks every Bazaar-listed payTo as registered, even with no on-chain payments", async () => {
    const store = new ExplorerStore();
    const sync = new CatalogSync({
      store,
      bazaarUrl: "https://facilitator.rail402.dev",
      logger,
      now,
      fetchImpl: catalog([
        {
          serviceName: "Weather API",
          resource: "https://api.acme.dev/forecast",
          description: "forecasts",
          accepts: [{ network: "stellar:testnet", payTo: "GWEATHER" }],
        },
      ]),
    });
    const marked = await sync.syncOnce();
    expect(marked).toBe(1);

    // The seller now appears in the directory as registered, with zero on-chain activity.
    const { items } = store.sellersDirectory({});
    const w = items.find(s => s.payTo === "GWEATHER")!;
    expect(w.registered).toBe(true);
    expect(w.payments).toBe(0);
    expect(w.serviceName).toBe("Weather API");
  });

  it("does not touch a seller's on-chain stats when marking it registered", async () => {
    const store = new ExplorerStore();
    store.insertPayment({
      network: "stellar:testnet",
      epoch: "E1",
      ledger: 1,
      txHash: "a".repeat(64),
      opIndex: 0,
      scheme: "exact",
      buyer: "GBUYER",
      seller: "GSELLER",
      amount: "10000",
      assetContract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      txSource: "GSRC",
      confidence: "x402-shaped",
      closedAt: "2026-08-14T18:00:00Z",
      rawEnvelope: "{}",
      ingestedAt: "2026-08-14T18:00:01Z",
    });
    const sync = new CatalogSync({
      store,
      bazaarUrl: "https://facilitator.rail402.dev",
      logger,
      now,
      fetchImpl: catalog([
        { serviceName: "Named", accepts: [{ network: "stellar:testnet", payTo: "GSELLER" }] },
      ]),
    });
    await sync.syncOnce();
    const { items } = store.sellersDirectory({});
    const s = items.find(x => x.payTo === "GSELLER")!;
    expect(s.registered).toBe(true);
    expect(s.payments).toBe(1); // on-chain activity preserved
    expect(s.serviceName).toBe("Named"); // and enriched
  });

  it("treats an unreachable Bazaar as a no-op, never a throw", async () => {
    const store = new ExplorerStore();
    const sync = new CatalogSync({
      store,
      bazaarUrl: "https://facilitator.rail402.dev",
      logger,
      now,
      fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")),
    });
    await expect(sync.syncOnce()).resolves.toBe(0);
  });
});
