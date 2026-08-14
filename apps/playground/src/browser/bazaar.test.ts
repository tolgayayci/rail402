import { describe, it, expect } from "vitest";
import { searchBazaar } from "./bazaar.js";

const fetchReturning = (body: unknown, ok = true): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status: ok ? 200 : 500 })) as typeof fetch;

describe("searchBazaar", () => {
  it("parses a rich entry into a renderable resource with price and try-link", async () => {
    const result = await searchBazaar("http://pg.test", "weather", {
      fetchImpl: fetchReturning({
        resources: [
          {
            resource: {
              url: "https://weather.example/current",
              description: "Current weather by city.",
              serviceName: "WeatherAPI",
            },
            accepts: [
              { scheme: "exact", network: "stellar:testnet", amount: "500000" },
              { scheme: "exact", network: "stellar:testnet", amount: "300000" },
            ],
          },
        ],
        partialResults: false,
        pagination: { cursor: "next-page" },
      }),
    });

    expect(result.resources).toHaveLength(1);
    const r = result.resources[0]!;
    expect(r.url).toBe("https://weather.example/current");
    expect(r.serviceName).toBe("WeatherAPI");
    // Cheapest of the two accepts.
    expect(r.priceStroops).toBe("300000");
    expect(r.priceDisplay).toBe("0.03 USDC");
    expect(r.tryUrl).toContain(encodeURIComponent("https://weather.example/current"));
    expect(result.cursor).toBe("next-page");
  });

  it("keeps a sparse entry legible — missing fields become undefined, never a crash", async () => {
    const result = await searchBazaar("http://pg.test", "x", {
      fetchImpl: fetchReturning({ resources: [{ resource: { url: "https://bare.example/x" } }] }),
    });
    const r = result.resources[0]!;
    expect(r.url).toBe("https://bare.example/x");
    expect(r.description).toBeUndefined();
    expect(r.priceStroops).toBeUndefined();
    expect(r.priceDisplay).toBeUndefined();
  });

  it("ignores an un-parseable amount rather than throwing", async () => {
    const result = await searchBazaar("http://pg.test", "x", {
      fetchImpl: fetchReturning({
        resources: [{ resource: { url: "https://x.example" }, accepts: [{ amount: "not-a-number" }] }],
      }),
    });
    expect(result.resources[0]!.priceStroops).toBeUndefined();
  });

  it("throws with the coded reason on a proxy error", async () => {
    await expect(
      searchBazaar("http://pg.test", "x", {
        fetchImpl: fetchReturning({ reason: "The Bazaar could not be reached." }, false),
      }),
    ).rejects.toThrow(/could not be reached/);
  });
});
