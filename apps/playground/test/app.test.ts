import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { routeOf } from "../src/app.ts";
import { parsePublicConfig } from "../src/shared/public-config.ts";
import { testApp, testConfig, type TestApp } from "./support.ts";

const SUPPORTED = { kinds: [{ x402Version: 2, scheme: "exact", network: "stellar:testnet" }] };

/** A fetch answering the facilitator's /supported, counting calls. */
function facilitatorFetch(answer: () => Response = () => Response.json(SUPPORTED)) {
  const calls: string[] = [];
  const fetch = (input: string | URL | Request) => {
    calls.push(input instanceof Request ? input.url : input.toString());
    return Promise.resolve(answer());
  };
  return { fetch: fetch, calls };
}

describe("Playground server", () => {
  let app: TestApp | undefined;
  afterEach(() => {
    app?.close();
    app = undefined;
  });

  it("reports liveness with its version and commit", async () => {
    app = testApp(testConfig({ RAIL402_COMMIT: "abc1234" }));
    const response = await app.request("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", version: "0.3.0+abc1234", commit: "abc1234" });
  });

  it("answers unknown paths with a coded error", async () => {
    app = testApp(testConfig());
    for (const path of ["/nope", "/assets/missing.js", "/index.html", "/api/unknown", "/lab/unknown"]) {
      const response = await app.request(path);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: { code: "playground_not_found", reason: "No route matches this path.", retryable: false },
      });
    }
  });

  it("is ready once the page is built and the facilitator answers, caching /supported for a minute", async () => {
    let now = 1_000_000;
    const upstream = facilitatorFetch();
    app = testApp(testConfig(), { fetch: upstream.fetch, now: () => now });
    const first = await app.request("/ready");
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      ready: true,
      checks: { config: "ok", facilitator: "ok", web: "ok" },
    });
    await app.request("/ready");
    expect(upstream.calls).toEqual(["https://testnet.rail402.dev/supported"]);
    now += 61_000;
    await app.request("/ready");
    expect(upstream.calls).toHaveLength(2);
  });

  it("is not ready while the facilitator is unreachable or the page is missing", async () => {
    const down = facilitatorFetch(() => {
      throw new TypeError("fetch failed");
    });
    app = testApp(testConfig(), { fetch: down.fetch });
    const response = await app.request("/ready");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ready: false, checks: { facilitator: "unreachable" } });
    app.close();

    app = testApp(testConfig(), { fetch: facilitatorFetch().fetch, webRoot: "/nonexistent/web/dist" });
    const missing = await app.request("/ready");
    expect(missing.status).toBe(503);
    expect(await missing.json()).toMatchObject({
      ready: false,
      checks: { facilitator: "ok", web: "missing" },
    });
  });

  it("publishes its public configuration", async () => {
    app = testApp(testConfig());
    const response = await app.request("/api/config");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    const body: unknown = await response.json();
    expect(parsePublicConfig(body)).toBeDefined();
  });

  it("serves metrics, behind a bearer token when one is configured", async () => {
    app = testApp(testConfig());
    await app.request("/health");
    const open = await app.request("/metrics");
    expect(open.status).toBe(200);
    expect(await open.text()).toContain(
      'rail402_playground_http_request_duration_seconds_count{method="GET",route="/health",status="200"} 1',
    );
    app.close();

    const token = "metrics-token-for-tests";
    app = testApp(testConfig({ METRICS_TOKEN_SHA256: createHash("sha256").update(token).digest("hex") }));
    expect((await app.request("/metrics")).status).toBe(401);
    expect((await app.request("/metrics", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    const allowed = await app.request("/metrics", { headers: { authorization: `Bearer ${token}` } });
    expect(allowed.status).toBe(200);
  });

  it("serves the page: index.html for its routes (revalidated) and immutable hashed assets", async () => {
    app = testApp(testConfig());
    for (const path of ["/", "/sell/", "/agents", "/bazaar"]) {
      const response = await app.request(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("no-cache");
      expect(await response.text()).toContain("Rail402 Playground");
    }
    const asset = await app.request("/assets/index-abc123.js");
    expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const etag = asset.headers.get("etag") ?? "";
    const revalidated = await app.request("/assets/index-abc123.js", { headers: { "if-none-match": etag } });
    expect(revalidated.status).toBe(304);
    expect((await app.request("/favicon.svg")).headers.get("content-type")).toBe("image/svg+xml");
    // The Pay page moved into the Lab: a permanent redirect on this origin, query kept.
    const moved = await app.request("/pay?url=https%3A%2F%2Fdemo.example%2Fweather");
    expect(moved.status).toBe(301);
    expect(moved.headers.get("location")).toBe("/?url=https%3A%2F%2Fdemo.example%2Fweather");
    expect((await app.request("/pay/")).headers.get("location")).toBe("/");
    expect((await app.request("/assets/../index.html")).status).toBe(404);
    expect((await app.request("/assets/%2e%2e/%2e%2e/package.json")).status).toBe(404);
  });

  it("sends the security headers and a strict content security policy on every response", async () => {
    app = testApp(testConfig({ RPC_URL: "https://rpc.example/soroban" }));
    for (const path of ["/", "/api/config", "/nope"]) {
      const headers = (await app.request(path)).headers;
      expect(headers.get("content-security-policy")).toBe(
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' https://rpc.example " +
          "https://horizon-testnet.stellar.org https://friendbot.stellar.org; img-src 'self' data:; font-src 'self'; " +
          "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      );
      expect(headers.get("x-content-type-options")).toBe("nosniff");
      expect(headers.get("referrer-policy")).toBe("no-referrer");
      expect(headers.get("cross-origin-opener-policy")).toBe("same-origin");
      expect(headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect(headers.get("permissions-policy")).toBe("camera=(), microphone=(), geolocation=(), payment=()");
      expect(headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
      expect(headers.get("access-control-allow-origin")).toBeNull();
    }
    app.close();
    app = testApp(testConfig({ PUBLIC_URL: "http://127.0.0.1:8080" }));
    expect((await app.request("/")).headers.get("strict-transport-security")).toBeNull();
  });

  it("logs one line per request with a hashed address, never the query or headers", async () => {
    app = testApp(testConfig({ TRUSTED_PROXY_HOPS: "1" }));
    const response = await app.request("/sell?token=query-canary", {
      headers: { "x-forwarded-for": "203.0.113.9", "x-request-id": "req-1", cookie: "session=cookie-canary" },
    });
    expect(response.headers.get("x-request-id")).toBe("req-1");
    const [line] = app.logs.lines;
    expect(line).toMatchObject({ reqId: "req-1", route: "page", method: "GET", status: 200, msg: "request" });
    expect(line?.["ipHash"]).toMatch(/^[0-9a-f]{16}$/);
    const text = app.logs.text();
    for (const canary of ["query-canary", "cookie-canary", "203.0.113.9", "/sell"])
      expect(text).not.toContain(canary);
  });

  it("replaces an unusable request id", async () => {
    app = testApp(testConfig());
    const response = await app.request("/health", { headers: { "x-request-id": "bad id with spaces" } });
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("labels routes with bounded values", () => {
    expect(routeOf("/api/bazaar/discovery/resources/abc/versions")).toBe(
      "/api/bazaar/discovery/resources/:id/versions",
    );
    expect(routeOf("/api/bazaar/discovery/resources/abc")).toBe("/api/bazaar/discovery/resources/:id");
    expect(routeOf("/api/bazaar/discovery/other")).toBe("unmatched");
    expect(routeOf("/lab/sell/forecast/Ankara")).toBe("/lab/sell/forecast/:city");
    expect(routeOf("/lab/greedy/history")).toBe("/lab/greedy/history");
    expect(routeOf("/lab/offers/zero")).toBe("/lab/offers/zero");
    expect(routeOf("/lab/sell/forecast/a/b")).toBe("unmatched");
    expect(routeOf("/api/seller-check")).toBe("unmatched");
    expect(routeOf("/.well-known/stellar.toml")).toBe("/.well-known/stellar.toml");
    expect(routeOf("/whatever")).toBe("unmatched");
  });
});
