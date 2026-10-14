import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { egressCodes } from "@rail402.dev/safe-fetch/codes";
import { ConfigError, loadConfig } from "../src/config.ts";
import { Metrics } from "../src/metrics.ts";
import { SELLER_CHECK_PATH } from "../src/seller-check.ts";
import { playgroundServerCodes, type PlaygroundServerCode } from "../src/shared/codes.ts";
import { RELAY_PATH, encodeRelayRequest, type RelayRequest } from "../src/shared/relay-protocol.ts";
import { fakeFacilitator } from "./fake-facilitator.ts";
import { testApp, testConfig, type TestApp } from "./support.ts";

/**
 * Every refusal the Playground server can send, driven through its route: each answers its code's
 * HTTP status and `{ error: { code, reason, retryable } }` with a registered code and a non-empty
 * reason. The startup refusal, `playground_config_invalid`, is a process exit (main.test.ts); here
 * the configuration loader is shown to raise it with a reason.
 */
describe("every server refusal is coded", () => {
  let server: Server;
  let origin: string;
  const apps: TestApp[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url === "/hang") return; // never answers; the test aborts it
      response.writeHead(200, { "content-type": "text/plain" }).end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  afterEach(() => {
    for (const app of apps.splice(0)) app.close();
  });

  function make(env: Record<string, string | undefined> = {}, options: Parameters<typeof testApp>[1] = {}) {
    const app = testApp(testConfig({ TRUSTED_PROXY_HOPS: "1", ...env }), options);
    apps.push(app);
    return app;
  }
  const local = (env: Record<string, string> = {}, options: Parameters<typeof testApp>[1] = {}) =>
    make({ PLAYGROUND_MODE: "local", PUBLIC_URL: "http://127.0.0.1:1", ...env }, options);

  function relay(
    app: TestApp,
    request: Partial<RelayRequest> = {},
    init: { headers?: Record<string, string>; body?: string; signal?: AbortSignal; client?: string } = {},
  ): Promise<Response> {
    return app.request(RELAY_PATH, {
      method: "POST",
      headers: {
        "x-forwarded-for": init.client ?? "198.51.100.40",
        ...encodeRelayRequest({
          target: request.target ?? `${origin}/ok`,
          method: request.method ?? "GET",
          redirect: request.redirect ?? "error",
          headers: request.headers ?? {},
        }),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: init.body }),
      ...(init.signal === undefined ? {} : { signal: init.signal }),
    });
  }

  function sellerCheck(app: TestApp, body: string, headers: Record<string, string> = {}): Promise<Response> {
    return app.request(SELLER_CHECK_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
  }

  /** How to make each code happen; several routes per code where several can send it. */
  const scenarios: Record<
    Exclude<PlaygroundServerCode, "playground_config_invalid">,
    () => Promise<Response[]>
  > = {
    playground_origin_not_allowed: async () => {
      const app = make();
      return [
        await relay(app, {}, { headers: { origin: "https://evil.example" } }),
        await sellerCheck(app, '{"url":"https://seller.example/"}', { "sec-fetch-site": "cross-site" }),
      ];
    },
    playground_request_invalid: async () => {
      const app = make();
      return [
        await app.request(RELAY_PATH),
        await relay(local(), { method: "GET" }, { body: "body on a GET" }),
        await sellerCheck(app, "{"),
      ];
    },
    playground_request_too_large: async () => {
      const app = local();
      return [
        await relay(app, { method: "POST" }, { body: "x".repeat(70_000) }),
        await sellerCheck(
          make(),
          JSON.stringify({ url: "https://seller.example/", arguments: { x: "y".repeat(9_000) } }),
        ),
      ];
    },
    playground_rate_limited: async () => {
      const relayApp = local({ RELAY_UNPAID_PER_MINUTE: "1", RELAY_UNPAID_BURST: "1" });
      await (await relay(relayApp)).text();
      const proxyApp = make({ PROXY_PER_MINUTE: "1" }, { fetch: () => Promise.resolve(Response.json({})) });
      await proxyApp.request("/api/facilitator/supported", {
        headers: { "x-forwarded-for": "198.51.100.41" },
      });
      const labApp = make({ LAB_UNPAID_PER_MINUTE: "1" }, { labFacilitator: fakeFacilitator() });
      await labApp.request("/lab/offers/zero", { headers: { "x-forwarded-for": "198.51.100.42" } });
      return [
        await relay(relayApp),
        await proxyApp.request("/api/facilitator/supported", {
          headers: { "x-forwarded-for": "198.51.100.41" },
        }),
        await labApp.request("/lab/offers/zero", { headers: { "x-forwarded-for": "198.51.100.42" } }),
      ];
    },
    playground_feature_disabled: async () => {
      const app = make({
        RELAY_ENABLED: "false",
        SELLER_CHECK_ENABLED: "false",
        LAB_ENABLED: "false",
        PLAYGROUND_PAY_TO: undefined,
      });
      return [
        await relay(app),
        await sellerCheck(app, '{"url":"https://seller.example/"}'),
        await app.request("/lab/sell/forecast/Ankara"),
      ];
    },
    playground_relay_target_invalid: async () => [
      await make().request(RELAY_PATH, { method: "POST", headers: { "x-relay-method": "GET" } }),
    ],
    playground_relay_method_not_allowed: async () => [
      await relay(make(), { method: "TRACE" as RelayRequest["method"] }),
    ],
    playground_relay_header_not_allowed: async () => [
      await relay(make(), {}, { headers: { "x-relay-h-authorization": "Bearer x" } }),
    ],
    playground_relay_loop: async () => [await relay(make(), { target: "https://playground.example/lab/x" })],
    playground_relay_target_denied: async () => [
      await relay(make(), { target: "https://testnet.rail402.dev/settle" }),
    ],
    playground_relay_busy: async () => {
      const app = local({ RELAY_IN_FLIGHT_PER_IP: "1" });
      const controller = new AbortController();
      const hanging = relay(app, { target: `${origin}/hang` }, { signal: controller.signal });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const busy = await relay(app);
      controller.abort();
      await hanging.catch(() => undefined);
      return [busy];
    },
    playground_relay_host_busy: async () => {
      const app = local({ RELAY_HOST_PER_MINUTE: "1", RELAY_TRUSTED_HOSTS: "" });
      await (await relay(app, {}, { client: "198.51.100.43" })).text();
      return [await relay(app, {}, { client: "198.51.100.44" })];
    },
    playground_upstream_unavailable: async () => {
      const app = make({}, { fetch: () => Promise.reject(new TypeError("fetch failed")) });
      const check = make({}, { sellerCheck: () => Promise.reject(new Error("rpc down")) });
      return [
        await app.request("/api/facilitator/supported"),
        await app.request("/api/bazaar/discovery/search?q=weather"),
        await sellerCheck(check, '{"url":"https://seller.example/"}'),
      ];
    },
    playground_lab_unavailable: async () => {
      const app = make(
        {},
        { labFacilitator: fakeFacilitator({ supported: () => Promise.reject(new Error("down")) }) },
      );
      return [await app.request("/lab/sell/forecast/Ankara"), await app.request("/lab/greedy/history")];
    },
    playground_not_found: async () => {
      const app = make({}, { labFacilitator: fakeFacilitator() });
      return [
        await app.request("/nope"),
        await app.request("/lab/nope"),
        await app.request(SELLER_CHECK_PATH),
      ];
    },
    playground_internal_error: async () => {
      const metrics = new Metrics();
      metrics.registry.metrics = () => Promise.reject(new Error("registry failed"));
      return [await make({}, { metrics }).request("/metrics")];
    },
  };

  for (const [code, scenario] of Object.entries(scenarios)) {
    it(code, async () => {
      const spec = playgroundServerCodes[code as PlaygroundServerCode];
      const responses = await scenario();
      expect(responses.length).toBeGreaterThan(0);
      for (const response of responses) {
        expect(response.status).toBe(spec.status);
        expect(response.headers.get("content-type")).toMatch(/^application\/json/);
        const body = (await response.json()) as {
          error: { code: string; reason: string; retryable: boolean };
        };
        expect(body.error.code).toBe(code);
        expect(body.error.reason.trim()).not.toBe("");
        expect(body.error.retryable).toBe(spec.retryable);
        if (spec.retryable && [429].includes(spec.status)) {
          expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
        }
      }
    });
  }

  it("covers every server code", () => {
    expect([...Object.keys(scenarios), "playground_config_invalid"].sort()).toEqual(
      Object.keys(playgroundServerCodes).sort(),
    );
  });

  it("refuses an invalid configuration with a reason naming the variable", () => {
    expect(() => loadConfig({ PUBLIC_URL: "ftp://x" }, { version: "0" })).toThrow(ConfigError);
    expect(() => loadConfig({ PUBLIC_URL: "ftp://x" }, { version: "0" })).toThrow(/^PUBLIC_URL/);
  });

  it("passes the relay's egress refusals with their registered codes and stage", async () => {
    const response = await relay(make(), { target: "https://169.254.169.254/" });
    const body = (await response.json()) as {
      error: { code: string; reason: string; details: { stage: string } };
    };
    expect(Object.hasOwn(egressCodes, body.error.code)).toBe(true);
    expect(response.status).toBe(egressCodes[body.error.code as keyof typeof egressCodes].status);
    expect(body.error.reason).not.toBe("");
    expect(body.error.details.stage).toBe("url");
  });
});
