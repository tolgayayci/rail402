import { afterEach, describe, expect, it } from "vitest";
import { testApp, testConfig, type TestApp } from "./support.ts";

type Answer = () => Response | Promise<Response>;

/** A fetch standing in for Rail402: records each URL and answers from `answer`. */
function upstream(answer: Answer = () => Response.json({ items: [] })) {
  const calls: string[] = [];
  let next = answer;
  const fetch = (input: string | URL | Request) => {
    calls.push(input instanceof Request ? input.url : input.toString());
    return Promise.resolve(next());
  };
  return {
    calls,
    fetch: fetch,
    answer(value: Answer) {
      next = value;
    },
  };
}

describe("Bazaar and facilitator proxies", () => {
  let app: TestApp | undefined;
  afterEach(() => {
    app?.close();
    app = undefined;
  });

  it("passes the query to the fixed Bazaar untouched and the answer back", async () => {
    const bazaar = upstream(() => Response.json({ x402Version: 2, items: [{ id: "a" }] }));
    app = testApp(testConfig({ BAZAAR_URL: "https://bazaar.example/" }), { fetch: bazaar.fetch });
    const response = await app.request("/api/bazaar/discovery/search?q=hourly%20forecast&type=mcp&limit=5");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ x402Version: 2, items: [{ id: "a" }] });
    await app.request("/api/bazaar/discovery/resources?payTo=G123&offset=0");
    await app.request("/api/bazaar/discovery/resources/lst_123");
    await app.request("/api/bazaar/discovery/resources/lst_123/versions");
    expect(bazaar.calls).toEqual([
      "https://bazaar.example/discovery/search?q=hourly%20forecast&type=mcp&limit=5",
      "https://bazaar.example/discovery/resources?payTo=G123&offset=0",
      "https://bazaar.example/discovery/resources/lst_123",
      "https://bazaar.example/discovery/resources/lst_123/versions",
    ]);
  });

  it("refuses requests another site's page makes, before any upstream fetch", async () => {
    const bazaar = upstream();
    app = testApp(testConfig(), { fetch: bazaar.fetch });
    for (const path of ["/api/bazaar/discovery/search?q=x", "/api/facilitator/supported"]) {
      for (const headers of [{ "sec-fetch-site": "cross-site" }, { origin: "https://elsewhere.example" }]) {
        const refused = await app.request(path, { headers });
        expect(refused.status).toBe(403);
        expect(await refused.json()).toMatchObject({ error: { code: "playground_origin_not_allowed" } });
      }
      const page = await app.request(path, { headers: { "sec-fetch-site": "same-origin" } });
      expect(page.status).toBe(200);
    }
    expect(bazaar.calls).toHaveLength(2);
  });

  it("passes the Bazaar's coded errors through", async () => {
    const body = {
      error: { code: "discovery_query_invalid", reason: "limit must be at most 100", retryable: false },
    };
    const bazaar = upstream(() => Response.json(body, { status: 400 }));
    app = testApp(testConfig(), { fetch: bazaar.fetch });
    const response = await app.request("/api/bazaar/discovery/resources?limit=1000");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual(body);
  });

  it("keeps a listing id one path segment", async () => {
    const bazaar = upstream();
    app = testApp(testConfig(), { fetch: bazaar.fetch });
    await app.request("/api/bazaar/discovery/resources/a%2F..%2F..%2Fsettle");
    expect(bazaar.calls).toEqual(["https://testnet.rail402.dev/discovery/resources/a%2F..%2F..%2Fsettle"]);
    // Dot segments never reach the Bazaar: the URL parser resolves them away, and the handler refuses them.
    for (const path of [
      "/api/bazaar/discovery/resources/%2E%2E",
      "/api/bazaar/discovery/resources/../../../supported",
    ]) {
      expect((await app.request(path)).status).toBe(404);
    }
    expect(bazaar.calls).toHaveLength(1);
  });

  it("caches successful answers briefly: search 5 s, listings 2 s", async () => {
    let now = 1_000_000;
    const bazaar = upstream();
    app = testApp(testConfig(), { fetch: bazaar.fetch, now: () => now });
    await app.request("/api/bazaar/discovery/search?q=a");
    await app.request("/api/bazaar/discovery/search?q=a");
    await app.request("/api/bazaar/discovery/resources/x");
    await app.request("/api/bazaar/discovery/resources/x");
    expect(bazaar.calls).toHaveLength(2);
    now += 2_500;
    await app.request("/api/bazaar/discovery/search?q=a");
    await app.request("/api/bazaar/discovery/resources/x");
    expect(bazaar.calls).toHaveLength(3);
    now += 3_000;
    await app.request("/api/bazaar/discovery/search?q=a");
    expect(bazaar.calls).toHaveLength(4);
    bazaar.answer(() =>
      Response.json({ error: { code: "x", reason: "y", retryable: false } }, { status: 404 }),
    );
    await app.request("/api/bazaar/discovery/resources/missing");
    await app.request("/api/bazaar/discovery/resources/missing");
    expect(bazaar.calls).toHaveLength(6);
  });

  it("shares one upstream fetch between concurrent identical requests", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bazaar = upstream(async () => {
      await gate;
      return Response.json({ items: [] });
    });
    app = testApp(testConfig(), { fetch: bazaar.fetch });
    const pending = [
      app.request("/api/bazaar/discovery/search?q=a"),
      app.request("/api/bazaar/discovery/search?q=a"),
    ];
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    const responses = await Promise.all(pending);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(bazaar.calls).toHaveLength(1);
  });

  it("answers playground_upstream_unavailable for unreachable, non-JSON, invalid or oversized answers", async () => {
    const bazaar = upstream();
    app = testApp(testConfig(), { fetch: bazaar.fetch });
    const answers: Answer[] = [
      () => Promise.reject(new TypeError("fetch failed")),
      () =>
        new Response("<html>bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } }),
      () => new Response("{not json", { headers: { "content-type": "application/json" } }),
      () =>
        new Response(`"${"a".repeat(2 * 1_048_576)}"`, { headers: { "content-type": "application/json" } }),
    ];
    for (const [index, answer] of answers.entries()) {
      bazaar.answer(answer);
      const response = await app.request(`/api/bazaar/discovery/search?q=${String(index)}`);
      expect(response.status).toBe(502);
      const body = (await response.json()) as { error: { code: string; reason: string; retryable: boolean } };
      expect(body.error).toMatchObject({ code: "playground_upstream_unavailable", retryable: true });
      expect(body.error.reason).toMatch(/^Bazaar: /);
    }
  });

  it("limits each client, and upstream fetches across clients", async () => {
    const bazaar = upstream();
    app = testApp(
      testConfig({ PROXY_PER_MINUTE: "2", PROXY_GLOBAL_PER_MINUTE: "3", TRUSTED_PROXY_HOPS: "1" }),
      {
        fetch: bazaar.fetch,
      },
    );
    const from = (ip: string, query: string) =>
      app?.request(`/api/bazaar/discovery/search?q=${query}`, { headers: { "x-forwarded-for": ip } });
    expect((await from("198.51.100.1", "a"))?.status).toBe(200);
    expect((await from("198.51.100.1", "b"))?.status).toBe(200);
    const limited = await from("198.51.100.1", "c");
    expect(limited?.status).toBe(429);
    expect(limited?.headers.get("retry-after")).toBe("30");
    expect((await from("198.51.100.2", "c"))?.status).toBe(200);
    // The global budget counts upstream fetches only: a cached answer still flows.
    expect((await from("198.51.100.3", "a"))?.status).toBe(200);
    const busy = await from("198.51.100.3", "d");
    expect(busy?.status).toBe(429);
    expect(((await busy?.json()) as { error: { code: string } }).error.code).toBe("playground_rate_limited");
  });

  it("proxies the facilitator's /supported, cached for a minute", async () => {
    let now = 1_000_000;
    const supported = {
      kinds: [{ x402Version: 2, scheme: "exact", network: "stellar:testnet" }],
      extensions: [],
    };
    const facilitator = upstream(() => Response.json(supported));
    app = testApp(testConfig({ FACILITATOR_URL: "https://facilitator.example" }), {
      fetch: facilitator.fetch,
      now: () => now,
    });
    const response = await app.request("/api/facilitator/supported");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(supported);
    await app.request("/api/facilitator/supported");
    await app.request("/ready");
    expect(facilitator.calls).toEqual(["https://facilitator.example/supported"]);
    now += 60_001;
    facilitator.answer(() => Promise.reject(new Error("down")));
    const down = await app.request("/api/facilitator/supported");
    expect(down.status).toBe(502);
    expect(((await down.json()) as { error: { reason: string } }).error.reason).toMatch(/^Facilitator: /);
  });
});
