import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import type { SettleResponse, VerifyResponse } from "@x402/core/types";
import { MemoryCatalogStore, type Catalog, type CatalogOutcome } from "@rail402.dev/bazaar";
import { silentLogger, type StellarFacilitator } from "@rail402.dev/facilitator";
import {
  MemoryUsageMeter,
  Metrics,
  accruedFee,
  createApp,
  loadConfig,
  type AppDependencies,
  type UsageEvent,
  type UsageMeter,
} from "@rail402.dev/service";

const SECRET = Keypair.random().secret();
const API_KEY = "test-key";

function makeApp(
  options: {
    verify?: () => Promise<VerifyResponse>;
    settle?: () => Promise<SettleResponse>;
    env?: Record<string, string>;
    meter?: UsageMeter;
    catalog?: Pick<Catalog, "recordDurably" | "preview">;
  } = {},
) {
  const config = loadConfig({
    STORE: "memory",
    TESTNET_RPC_URL: "http://localhost:8000/rpc",
    TESTNET_SPONSOR_SECRET: SECRET,
    API_KEY_SHA256: createHash("sha256").update(API_KEY).digest("hex"),
    ...options.env,
  });
  const calls: string[] = [];
  const facilitator = {
    core: {
      getSupported: () => ({
        kinds: [
          { x402Version: 2, scheme: "exact", network: "stellar:testnet", extra: { areFeesSponsored: true } },
        ],
        extensions: [],
        signers: { "stellar:*": ["GSPONSOR"] },
      }),
      verify: async () => {
        calls.push("verify");
        return options.verify ? options.verify() : { isValid: true, payer: "GPAYER" };
      },
      settle: async () => {
        calls.push("settle");
        return options.settle
          ? options.settle()
          : { success: true, transaction: "a".repeat(64), network: "stellar:testnet", payer: "GPAYER" };
      },
    },
    networks: new Map(),
    reconcile: () => Promise.resolve(0),
  } as unknown as StellarFacilitator;
  const deps: AppDependencies = {
    config,
    facilitator,
    metrics: new Metrics(),
    log: silentLogger,
    readiness: () => Promise.resolve({ ready: true, checks: { database: { ok: true } } }),
    version: "test",
    ...(options.catalog === undefined
      ? {}
      : { bazaar: { catalog: options.catalog as Catalog, store: new MemoryCatalogStore() } }),
  };
  const meter = options.meter ?? new MemoryUsageMeter();
  return { app: createApp({ ...deps, meter }), calls, metrics: deps.metrics, meter };
}

/** A meter that keeps every usage event, whatever its subject. */
function recordingMeter() {
  const events: UsageEvent[] = [];
  const meter: UsageMeter = {
    record: (event) => {
      events.push(event);
      return Promise.resolve();
    },
    usage: () => Promise.resolve([]),
  };
  return { meter, events };
}

/** The bazaar outcome carried by an EXTENSION-RESPONSES header. */
function extensionResponse(response: Response): unknown {
  const header = response.headers.get("extension-responses");
  if (header === null) return undefined;
  return (JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { bazaar: unknown }).bazaar;
}

const requirements = {
  scheme: "exact",
  network: "stellar:testnet",
  asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  payTo: "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO",
  amount: "10000",
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: true },
};
const body = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    x402Version: 2,
    paymentPayload: { x402Version: 2, accepted: requirements, payload: { transaction: "AAAA" } },
    paymentRequirements: requirements,
    ...overrides,
  });
const post = (path: string, payload: string, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: payload,
});

describe("facilitator HTTP surface", () => {
  it("serves /supported from the core facilitator", async () => {
    const { app } = makeApp();
    const response = await app.request("/supported");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      kinds: [{ network: "stellar:testnet", extra: { areFeesSponsored: true } }],
    });
  });

  it("returns the facilitator's verify and settle results verbatim", async () => {
    const { app, calls } = makeApp();
    expect(await (await app.request("/verify", post("/verify", body()))).json()).toEqual({
      isValid: true,
      payer: "GPAYER",
    });
    expect(await (await app.request("/settle", post("/settle", body()))).json()).toMatchObject({
      success: true,
    });
    expect(calls).toEqual(["verify", "settle"]);
  });

  it.each([
    ["invalid JSON", "{not json", 400, "invalid_payload"],
    [
      "a body without paymentRequirements",
      JSON.stringify({ x402Version: 2, paymentPayload: {} }),
      400,
      "invalid_payload",
    ],
  ])("answers %s with a coded, spec-shaped body", async (_label, payload, status, code) => {
    const { app, calls } = makeApp();
    for (const path of ["/verify", "/settle"]) {
      const response = await app.request(path, post(path, payload));
      expect(response.status).toBe(status);
      const json = (await response.json()) as Record<string, unknown>;
      if (path === "/verify") {
        expect(json).toMatchObject({ isValid: false, invalidReason: code });
        expect(String(json["invalidMessage"]).trim()).not.toBe("");
      } else {
        expect(json).toMatchObject({ success: false, errorReason: code, transaction: "" });
        expect(String(json["errorMessage"]).trim()).not.toBe("");
      }
    }
    expect(calls).toEqual([]);
  });

  it("refuses a non-JSON content type", async () => {
    const { app } = makeApp();
    const response = await app.request("/verify", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: body(),
    });
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ isValid: false, invalidReason: "unsupported_media_type" });
  });

  it("refuses networks and schemes it does not serve without calling the core", async () => {
    const { app, calls } = makeApp();
    const pubnet = { ...requirements, network: "stellar:pubnet" };
    const unknown = await app.request("/verify", post("/verify", body({ paymentRequirements: pubnet })));
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toMatchObject({ isValid: false, invalidReason: "invalid_network" });

    const upto = { ...requirements, scheme: "upto" };
    const scheme = await app.request("/settle", post("/settle", body({ paymentRequirements: upto })));
    expect(await scheme.json()).toMatchObject({ success: false, errorReason: "unsupported_scheme" });
    expect(calls).toEqual([]);
  });

  it("enforces API keys when the network requires them", async () => {
    const { app, calls } = makeApp({ env: { TESTNET_REQUIRE_API_KEY: "true" } });
    const denied = await app.request("/verify", post("/verify", body()));
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ isValid: false, invalidReason: "unauthorized" });

    const wrong = await app.request("/verify", post("/verify", body(), { authorization: "Bearer nope" }));
    expect(wrong.status).toBe(401);

    const allowed = await app.request(
      "/verify",
      post("/verify", body(), { authorization: `Bearer ${API_KEY}` }),
    );
    expect(allowed.status).toBe(200);
    const header = await app.request("/settle", post("/settle", body(), { "x-api-key": API_KEY }));
    expect(header.status).toBe(200);
    expect(calls).toEqual(["verify", "settle"]);
  });

  it("rate-limits per client with Retry-After and a coded body", async () => {
    const { app, metrics } = makeApp({ env: { RATE_LIMIT_PER_MINUTE: "2", TRUSTED_PROXY_HOPS: "1" } });
    const from = (ip: string) => post("/verify", body(), { "x-forwarded-for": ip });
    expect((await app.request("/verify", from("10.0.0.1"))).status).toBe(200);
    expect((await app.request("/verify", from("10.0.0.1"))).status).toBe(200);
    const limited = await app.request("/verify", from("10.0.0.1"));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await limited.json()).toMatchObject({ isValid: false, invalidReason: "rate_limited" });
    expect((await app.request("/verify", from("10.0.0.2"))).status).toBe(200);
    expect(await metrics.registry.getSingleMetricAsString("rail402_rate_limited_total")).toContain(" 1");
  });

  it("rejects oversized bodies", async () => {
    const { app } = makeApp({ env: { BODY_LIMIT_BYTES: "2048" } });
    const response = await app.request("/settle", post("/settle", body({ padding: "x".repeat(4096) })));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ success: false, errorReason: "payload_too_large" });
  });

  it("turns a thrown facilitator error into a coded 500", async () => {
    const { app } = makeApp({ verify: () => Promise.reject(new Error("boom")) });
    const response = await app.request("/verify", post("/verify", body()));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ isValid: false, invalidReason: "unexpected_verify_error" });
  });

  it("answers unknown routes with a coded 404", async () => {
    const { app } = makeApp();
    const response = await app.request("/nope");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("exposes health, readiness and metrics", async () => {
    const { app } = makeApp();
    await app.request("/verify", post("/verify", body()));
    expect(await (await app.request("/health")).json()).toEqual({ status: "ok", version: "test" });
    expect((await app.request("/ready")).status).toBe(200);
    const metrics = await (await app.request("/metrics")).text();
    expect(metrics).toContain(
      'rail402_verifications_total{network="stellar:testnet",outcome="valid",reason=""} 1',
    );
  });
});

describe("metering", () => {
  it("meters each caller separately and serves usage only to key holders", async () => {
    const { app } = makeApp({ env: { SERVICE_FEE_PER_SETTLEMENT_USD: "0.0005" } });
    await app.request("/settle", post("/settle", body(), { authorization: `Bearer ${API_KEY}` }));
    await app.request("/settle", post("/settle", body(), { "x-api-key": API_KEY }));
    await app.request("/verify", post("/verify", body(), { authorization: `Bearer ${API_KEY}` }));
    await app.request("/settle", post("/settle", body()));

    expect((await app.request("/usage")).status).toBe(401);
    expect((await app.request("/usage", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    const response = await app.request("/usage", { headers: { authorization: `Bearer ${API_KEY}` } });
    expect(response.status).toBe(200);
    const usage = (await response.json()) as {
      subject: string;
      serviceFee: { perSettlementUsd: string; accruedUsd: string };
      usage: { operation: string; outcome: string; requests: number; settledAmount: string }[];
    };
    expect(usage.subject).toMatch(/^key:[0-9a-f]{16}$/);
    expect(usage.serviceFee).toEqual({ perSettlementUsd: "0.0005", accruedUsd: "0.0010" });
    expect(usage.usage).toContainEqual(
      expect.objectContaining({
        operation: "settle",
        outcome: "success",
        requests: 2,
        settledAmount: "20000",
      }),
    );
    expect(usage.usage).toContainEqual(
      expect.objectContaining({ operation: "verify", outcome: "valid", requests: 1 }),
    );
  });

  it("computes accrued fees exactly", () => {
    expect(accruedFee("0", 10)).toBe("0");
    expect(accruedFee("0.001", 3)).toBe("0.003");
    expect(accruedFee("1.25", 4)).toBe("5.00");
    expect(accruedFee("0.0000001", 0)).toBe("0.0000000");
  });

  it("counts only the calls that reach the facilitator", async () => {
    const { meter, events } = recordingMeter();
    const { app, calls } = makeApp({
      meter,
      verify: () => Promise.reject(new Error("boom")),
      env: {
        RATE_LIMIT_PER_MINUTE: "1",
        TRUSTED_PROXY_HOPS: "1",
        BODY_LIMIT_BYTES: "2048",
        TESTNET_REQUIRE_API_KEY: "true",
      },
    });
    // One request per client address keeps every request but the rate-limited one within its limit.
    let client = 0;
    const send = (path: string, payload: string, headers: Record<string, string> = {}) =>
      app.request(
        path,
        post(path, payload, {
          authorization: `Bearer ${API_KEY}`,
          "x-forwarded-for": `10.0.0.${String(++client)}`,
          ...headers,
        }),
      );
    const statuses = [
      (await send("/verify", "{not json")).status,
      (await send("/settle", body({ padding: "x".repeat(4096) }))).status,
      (await send("/verify", body(), { "content-type": "text/plain" })).status,
      (await send("/verify", body(), { authorization: "" })).status,
    ];
    const pubnet = { ...requirements, network: "stellar:pubnet" };
    const refused = [
      await (await send("/settle", body({ paymentRequirements: pubnet }))).json(),
      await (
        await send("/settle", body({ paymentRequirements: { ...requirements, scheme: "upto" } }))
      ).json(),
    ];
    statuses.push((await send("/verify", body())).status);
    const limited = post("/settle", body(), {
      authorization: `Bearer ${API_KEY}`,
      "x-forwarded-for": "10.9.9.9",
    });
    await app.request("/settle", limited);
    statuses.push((await app.request("/settle", limited)).status);

    expect(statuses).toEqual([400, 413, 415, 401, 500, 429]);
    expect(refused).toMatchObject([
      { errorReason: "invalid_network" },
      { errorReason: "unsupported_scheme" },
    ]);
    expect(calls).toEqual(["verify", "settle"]);
    // Only the settlement from 10.9.9.9 that the limiter let through was counted.
    expect(events).toEqual([
      {
        subject: `key:${createHash("sha256").update(API_KEY).digest("hex").slice(0, 16)}`,
        network: "stellar:testnet",
        operation: "settle",
        outcome: "success",
        asset: requirements.asset,
        settledAmount: requirements.amount,
      },
    ]);
  });

  it("counts payment rejections from the facilitator", async () => {
    const { meter, events } = recordingMeter();
    const { app } = makeApp({
      meter,
      verify: () =>
        Promise.resolve({ isValid: false, invalidReason: "invalid_exact_stellar_payload_wrong_amount" }),
      settle: () =>
        Promise.resolve({
          success: false,
          errorReason: "settlement_pending",
          transaction: "a".repeat(64),
          network: "stellar:testnet",
        }),
    });
    await app.request("/verify", post("/verify", body()));
    await app.request("/settle", post("/settle", body()));
    expect(
      events.map((event) => [event.subject, event.operation, event.outcome, event.settledAmount]),
    ).toEqual([
      ["public", "verify", "invalid", "0"],
      ["public", "settle", "pending", "0"],
    ]);
  });
});

describe("operational endpoints", () => {
  it("are never rate-limited", async () => {
    const { app, metrics } = makeApp({ env: { RATE_LIMIT_PER_MINUTE: "1", TRUSTED_PROXY_HOPS: "1" } });
    const from = { headers: { "x-forwarded-for": "10.0.0.1" } };
    expect((await app.request("/supported", from)).status).toBe(200);
    expect((await app.request("/supported", from)).status).toBe(429);
    for (let round = 0; round < 3; round++) {
      for (const path of ["/health", "/ready", "/metrics"]) {
        expect((await app.request(path, from)).status, path).toBe(200);
      }
    }
    expect((await app.request("/usage", from)).status).toBe(429);
    expect(await metrics.registry.getSingleMetricAsString("rail402_rate_limited_total")).toContain(
      "rail402_rate_limited_total 2",
    );
  });

  it("answers /ready with 503 and the checks when a check fails", async () => {
    const { app } = makeApp();
    const failing = createApp({
      config: loadConfig({
        STORE: "memory",
        TESTNET_RPC_URL: "http://localhost:8000/rpc",
        TESTNET_SPONSOR_SECRET: SECRET,
      }),
      facilitator: {} as StellarFacilitator,
      metrics: new Metrics(),
      log: silentLogger,
      readiness: () =>
        Promise.resolve({
          ready: false,
          checks: { "stellar:testnet:rpc": { ok: false, detail: "unhealthy" } },
        }),
      version: "test",
    });
    expect((await app.request("/ready")).status).toBe(200);
    const response = await failing.request("/ready");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      ready: false,
      checks: { "stellar:testnet:rpc": { ok: false, detail: "unhealthy" } },
    });
  });
});

describe("request checks run in the documented order", () => {
  const oversized = body({ padding: "x".repeat(4096) });

  it("refuses a rate-limited request before reading its body", async () => {
    const { app } = makeApp({ env: { RATE_LIMIT_PER_MINUTE: "1", BODY_LIMIT_BYTES: "2048" } });
    await app.request("/supported");
    const response = await app.request("/verify", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: `${oversized}{not json`,
    });
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ invalidReason: "rate_limited" });
  });

  it("checks the body size before the content type", async () => {
    const { app } = makeApp({ env: { BODY_LIMIT_BYTES: "2048" } });
    const response = await app.request("/settle", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: oversized,
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ errorReason: "payload_too_large" });
  });

  it("checks the content type before parsing the body", async () => {
    const { app } = makeApp();
    const response = await app.request("/verify", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{not json",
    });
    expect(response.status).toBe(415);
    expect(await response.json()).toMatchObject({ invalidReason: "unsupported_media_type" });
  });

  it("checks the body shape before the network", async () => {
    const { app } = makeApp();
    const pubnet = { ...requirements, network: "stellar:pubnet" };
    const response = await app.request(
      "/verify",
      post("/verify", JSON.stringify({ paymentPayload: {}, paymentRequirements: pubnet })),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ invalidReason: "invalid_payload" });
  });

  it("checks the network before the scheme, and both before the API key", async () => {
    const { app, calls } = makeApp({ env: { TESTNET_REQUIRE_API_KEY: "true" } });
    const both = { ...requirements, network: "stellar:pubnet", scheme: "upto" };
    const network = await app.request("/verify", post("/verify", body({ paymentRequirements: both })));
    expect(network.status).toBe(200);
    expect(await network.json()).toMatchObject({ isValid: false, invalidReason: "invalid_network" });

    const upto = { ...requirements, scheme: "upto" };
    const scheme = await app.request("/settle", post("/settle", body({ paymentRequirements: upto })));
    expect(scheme.status).toBe(200);
    expect(await scheme.json()).toMatchObject({ success: false, errorReason: "unsupported_scheme" });

    const key = await app.request("/settle", post("/settle", body()));
    expect(key.status).toBe(401);
    expect(calls).toEqual([]);
  });
});

describe("cataloging at /settle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports an outcome that arrives within the budget verbatim", async () => {
    const outcome: CatalogOutcome = { status: "success", code: "cataloged", listingId: "id", version: 1 };
    const { app } = makeApp({
      catalog: { recordDurably: () => Promise.resolve(outcome), preview: () => Promise.resolve(undefined) },
    });
    const response = await app.request("/settle", post("/settle", body()));
    expect(extensionResponse(response)).toEqual(outcome);
  });

  it("waits at most 2 seconds, then reports processing / cataloging_in_progress", async () => {
    let recorded = 0;
    const { app } = makeApp({
      catalog: {
        recordDurably: () => {
          recorded++;
          return new Promise(() => undefined);
        },
        preview: () => Promise.resolve(undefined),
      },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let answered = false;
    const pending = Promise.resolve(app.request("/settle", post("/settle", body()))).finally(() => {
      answered = true;
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, transaction: "a".repeat(64) });
    expect(extensionResponse(response)).toMatchObject({
      status: "processing",
      code: "cataloging_in_progress",
    });
    expect(recorded).toBe(1);
  });
});

describe("cataloging preview at /verify", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits at most 250 ms for the preview, then reports processing", async () => {
    const { app } = makeApp({
      catalog: {
        recordDurably: () => Promise.resolve(undefined),
        preview: () => new Promise(() => undefined),
      },
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let answered = false;
    const pending = Promise.resolve(app.request("/verify", post("/verify", body()))).finally(() => {
      answered = true;
    });
    await vi.advanceTimersByTimeAsync(249);
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const response = await pending;
    expect(await response.json()).toMatchObject({ isValid: true });
    expect(extensionResponse(response)).toMatchObject({ status: "processing", code: "awaiting_settlement" });
  });
});

describe("metrics", () => {
  /** The metrics table in docs/operations.md: every name with its label set. */
  const DOCUMENTED: Record<string, readonly string[]> = {
    rail402_verifications_total: ["network", "outcome", "reason"],
    rail402_settlements_total: ["network", "outcome", "reason"],
    rail402_http_request_duration_seconds: ["method", "route", "status"],
    rail402_sponsor_balance_stroops: ["network"],
    rail402_channels_in_use: ["network"],
    rail402_channels_total: ["network"],
    rail402_settlements_reconciled_total: [],
    rail402_background_errors_total: ["task"],
    rail402_catalog_outcomes_total: ["phase", "status", "code"],
    rail402_rate_limited_total: [],
  };

  /** Label-name sets per metric in a Prometheus exposition, histogram series folded into their metric. */
  function labelSets(exposition: string): Map<string, Set<string>> {
    const found = new Map<string, Set<string>>();
    for (const line of exposition.split("\n")) {
      const match = /^([a-zA-Z_:][\w:]*)(?:\{(.*)\})? \S+$/.exec(line);
      if (match === null) continue;
      const name = (match[1] ?? "").replace(/_(bucket|sum|count)$/, "");
      const labels = [...(match[2] ?? "").matchAll(/(\w+)="/g)]
        .map((label) => label[1] ?? "")
        .filter((label) => label !== "le")
        .sort()
        .join(",");
      found.set(name, (found.get(name) ?? new Set()).add(labels));
    }
    return found;
  }

  it("exposes every documented metric with its documented labels", async () => {
    const { app, metrics } = makeApp({
      env: { RATE_LIMIT_PER_MINUTE: "3" },
      catalog: {
        recordDurably: () => Promise.resolve({ status: "success", code: "recorded" }),
        preview: () => Promise.resolve(undefined),
      },
    });
    await app.request("/verify", post("/verify", body()));
    await app.request("/settle", post("/settle", body()));
    await app.request("/supported");
    await app.request("/supported");
    // The runtime owns these: balance polling, channel leases, reconciliation and background work.
    metrics.sponsorBalance.set({ network: "stellar:testnet" }, 100_000_000);
    metrics.channelsInUse.set({ network: "stellar:testnet" }, 1);
    metrics.channelsTotal.set({ network: "stellar:testnet" }, 8);
    metrics.settlementsReconciled.inc();
    metrics.backgroundErrors.inc({ task: "poll" });

    const response = await app.request("/metrics");
    expect(response.headers.get("content-type")).toContain("text/plain");
    const exposition = await response.text();
    const found = labelSets(exposition);
    for (const [name, labels] of Object.entries(DOCUMENTED)) {
      expect(found.get(name), name).toEqual(new Set([[...labels].sort().join(",")]));
    }
    expect(exposition).toContain(
      'rail402_catalog_outcomes_total{phase="settle",status="success",code="recorded"} 1',
    );
    expect(exposition).toMatch(/^rail402_process_\w+/m);
  });
});
