import { describe, expect, it } from "vitest";
import { ExplorerStore } from "./db.js";
import { createBazaarEnricher } from "./enrich.js";
import type { FetchLike } from "./rpc.js";

const SELLER = "GBQXGC5CDGYITXTJ5ZKH66WMAMBMGL345WYV4EKPUH23NTRZVUKK6747";

function bazaarResponding(items: unknown[], calls: string[]): FetchLike {
  return url => {
    calls.push(url);
    return Promise.resolve(
      new Response(JSON.stringify({ x402Version: 2, items }), { status: 200 }),
    );
  };
}

describe("createBazaarEnricher", () => {
  it("resolves a payTo through /discovery/resources and caches the hit", async () => {
    const store = new ExplorerStore();
    const calls: string[] = [];
    const enricher = createBazaarEnricher(
      store,
      "https://facilitator.rail402.dev",
      bazaarResponding(
        [{ resource: "https://api.acme.dev/forecast", serviceName: "Weather API" }],
        calls,
      ),
      () => Date.parse("2026-08-13T19:00:00Z"),
    );
    const meta = await enricher.lookup("stellar:testnet", SELLER);
    expect(meta?.serviceName).toBe("Weather API");
    expect(meta?.resource).toBe("https://api.acme.dev/forecast");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(`payTo=${SELLER}`);

    // Second lookup: served from the store, no second request.
    const again = await enricher.lookup("stellar:testnet", SELLER);
    expect(again?.serviceName).toBe("Weather API");
    expect(calls).toHaveLength(1);
  });

  it("caches a miss so an unlisted seller is not re-queried every poll", async () => {
    const store = new ExplorerStore();
    const calls: string[] = [];
    const enricher = createBazaarEnricher(
      store,
      "https://facilitator.rail402.dev",
      bazaarResponding([], calls),
      () => Date.parse("2026-08-13T19:00:00Z"),
    );
    expect(await enricher.lookup("stellar:testnet", SELLER)).toBeUndefined();
    expect(await enricher.lookup("stellar:testnet", SELLER)).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("re-queries a cached miss after its TTL expires", async () => {
    const store = new ExplorerStore();
    const calls: string[] = [];
    let clock = Date.parse("2026-08-13T19:00:00Z");
    const enricher = createBazaarEnricher(
      store,
      "https://facilitator.rail402.dev",
      bazaarResponding([], calls),
      () => clock,
    );
    await enricher.lookup("stellar:testnet", SELLER);
    clock += 11 * 60 * 1000; // past the 10-minute miss TTL
    await enricher.lookup("stellar:testnet", SELLER);
    expect(calls).toHaveLength(2);
  });

  it("treats an unreachable Bazaar as a miss, never as a failure", async () => {
    const store = new ExplorerStore();
    const enricher = createBazaarEnricher(
      store,
      "https://facilitator.rail402.dev",
      () => Promise.reject(new Error("ECONNREFUSED")),
      () => Date.parse("2026-08-13T19:00:00Z"),
    );
    await expect(enricher.lookup("stellar:testnet", SELLER)).resolves.toBeUndefined();
  });
});
