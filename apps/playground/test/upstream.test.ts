import { describe, expect, it } from "vitest";
import { UpstreamJson } from "../src/proxy/upstream.ts";

describe("upstream JSON cache", () => {
  let now = 0;
  let fetches = 0;
  /** Answers every URL with a JSON string of the length its `size` query names. */
  const fetch = ((url: string) => {
    fetches++;
    const size = Number(new URL(url).searchParams.get("size") ?? "10");
    return Promise.resolve(
      new Response(JSON.stringify("x".repeat(size)), { headers: { "content-type": "application/json" } }),
    );
  }) as typeof globalThis.fetch;
  const upstream = (options: { maxCacheBytes?: number; maxCachedAnswerBytes?: number } = {}) =>
    new UpstreamJson({
      fetch,
      now: () => now,
      timeoutMs: 1_000,
      maxBytes: 1_048_576,
      userAgent: "test",
      ...options,
    });

  it("holds at most its memory budget, dropping the oldest answers first", async () => {
    const cache = upstream({ maxCacheBytes: 10_000 });
    for (let index = 0; index < 10; index++)
      await cache.get(`https://bazaar.test/?size=1000&i=${String(index)}`, 60_000);
    expect(cache.size.bytes).toBeLessThanOrEqual(10_000);
    expect(cache.size.entries).toBeLessThan(10);
    fetches = 0;
    expect((await cache.get("https://bazaar.test/?size=1000&i=9", 60_000)).ok).toBe(true);
    expect(fetches).toBe(0);
    await cache.get("https://bazaar.test/?size=1000&i=0", 60_000);
    expect(fetches).toBe(1);
  });

  it("passes a large answer on without keeping it", async () => {
    const cache = upstream({ maxCachedAnswerBytes: 4_096 });
    const result = await cache.get("https://bazaar.test/?size=5000", 60_000);
    expect(result.ok && result.answer.body.length).toBe(5_002);
    expect(cache.size).toEqual({ entries: 0, bytes: 0 });
  });

  it("drops expired answers when swept", async () => {
    const cache = upstream();
    await cache.get("https://bazaar.test/?size=10&a", 1_000);
    await cache.get("https://bazaar.test/?size=10&b", 5_000);
    now += 2_000;
    cache.sweep();
    expect(cache.size.entries).toBe(1);
  });
});
