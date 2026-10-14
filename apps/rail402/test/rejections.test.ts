/**
 * Every way a request to the service can be refused, on every route, answered in process against a
 * stub facilitator and memory stores. Each refusal must use one of the three wire shapes, carry a
 * registered code and a non-empty reason, and every non-2xx response must be a refusal.
 */
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import type { SettleResponse, VerifyResponse } from "@x402/core/types";
import { MemoryCatalogStore, type Catalog, type CatalogStore } from "@rail402.dev/bazaar";
import { silentLogger, type StellarFacilitator } from "@rail402.dev/facilitator";
import { AssetRegistry, SearchService } from "@rail402.dev/search";
import { Metrics, createApp, isRail402Code, loadConfig } from "@rail402.dev/service";

const API_KEY = "rejections-test-key";
const MAX_REASON = 300;

interface Stubs {
  readonly env?: Record<string, string>;
  readonly verify?: () => Promise<VerifyResponse>;
  readonly settle?: () => Promise<SettleResponse>;
  readonly store?: CatalogStore;
}

function service(stubs: Stubs = {}) {
  const config = loadConfig({
    STORE: "memory",
    TESTNET_RPC_URL: "http://localhost:8000/rpc",
    TESTNET_SPONSOR_SECRET: Keypair.random().secret(),
    API_KEY_SHA256: createHash("sha256").update(API_KEY).digest("hex"),
    RATE_LIMIT_PER_MINUTE: "0",
    ...stubs.env,
  });
  const facilitator = {
    core: {
      getSupported: () => ({
        kinds: [{ x402Version: 2, scheme: "exact", network: "stellar:testnet", extra: {} }],
        extensions: [],
        signers: {},
      }),
      verify: stubs.verify ?? (() => Promise.resolve({ isValid: true, payer: "GPAYER" })),
      settle:
        stubs.settle ??
        (() =>
          Promise.resolve({
            success: true,
            transaction: "a".repeat(64),
            network: "stellar:testnet",
            payer: "GPAYER",
          })),
    },
    networks: new Map(),
    reconcile: () => Promise.resolve(0),
  } as unknown as StellarFacilitator;
  const store = stubs.store ?? new MemoryCatalogStore();
  const search = new SearchService({ store, assets: new AssetRegistry([]), cursorSecret: randomBytes(32) });
  const catalog = {
    preview: () => Promise.resolve(undefined),
    recordDurably: () => Promise.resolve(undefined),
  } as unknown as Catalog;
  return createApp({
    config,
    facilitator,
    metrics: new Metrics(),
    log: silentLogger,
    readiness: () => Promise.resolve({ ready: true, checks: {} }),
    version: "test",
    bazaar: { catalog, store, search },
  });
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

function body(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    x402Version: 2,
    paymentPayload: { x402Version: 2, accepted: requirements, payload: { transaction: "AAAA" } },
    paymentRequirements: requirements,
    ...overrides,
  });
}

const json = (payload: string, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: payload,
});

interface Refusal {
  readonly codes: string[];
  readonly reasons: string[];
}

/**
 * The refusal a response carries, checked against the three wire shapes:
 * `{isValid:false, invalidReason, invalidMessage}`, `{success:false, errorReason, errorMessage}` and
 * `{error:{code, reason, retryable}}`. A body may carry both an x402 shape and `error`.
 */
function refusalOf(value: unknown): Refusal | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const codes: string[] = [];
  const reasons: string[] = [];
  if (record["isValid"] === false) {
    codes.push(text(record["invalidReason"]));
    reasons.push(text(record["invalidMessage"]));
  }
  if (record["success"] === false) {
    codes.push(text(record["errorReason"]));
    reasons.push(text(record["errorMessage"]));
  }
  const error = record["error"];
  if (error !== null && typeof error === "object") {
    const coded = error as Record<string, unknown>;
    expect(typeof coded["retryable"], "error.retryable").toBe("boolean");
    codes.push(text(coded["code"]));
    reasons.push(text(coded["reason"]));
  }
  return codes.length === 0 ? undefined : { codes, reasons };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Sends a request that must be refused, checks the refusal, and returns its codes. */
async function refused(
  app: ReturnType<typeof service>,
  path: string,
  init: RequestInit = {},
  status?: number,
): Promise<string[]> {
  const response = await app.request(path, init);
  if (status !== undefined) expect(response.status, `${path} status`).toBe(status);
  const refusal = refusalOf(await response.json());
  expect(refusal, `${path} must answer with a coded refusal`).toBeDefined();
  for (const code of refusal?.codes ?? []) expect(isRail402Code(code), `${code} is registered`).toBe(true);
  for (const reason of refusal?.reasons ?? []) {
    expect(reason.trim(), "reason").not.toBe("");
    expect(reason.length, "reason length").toBeLessThanOrEqual(MAX_REASON);
  }
  return refusal?.codes ?? [];
}

const OPERATIONS = ["/verify", "/settle"] as const;

describe("refusals on /verify and /settle", () => {
  const app = service({ env: { BODY_LIMIT_BYTES: "4096" } });

  it.each(OPERATIONS)("%s: body limit, content type, JSON and shape", async (path) => {
    expect(await refused(app, path, json(body({ padding: "x".repeat(8_192) })), 413)).toContain(
      "payload_too_large",
    );
    expect(
      await refused(
        app,
        path,
        { method: "POST", headers: { "content-type": "text/plain" }, body: body() },
        415,
      ),
    ).toContain("unsupported_media_type");
    expect(await refused(app, path, json("{not json"), 400)).toEqual(["invalid_payload", "bad_request"]);
    for (const shape of [
      "[]",
      "null",
      JSON.stringify({ x402Version: 2 }),
      JSON.stringify({ x402Version: "2", paymentPayload: {}, paymentRequirements: {} }),
      body({ paymentRequirements: { scheme: 1, network: "stellar:testnet" } }),
      body({ x402Version: 1 }),
      body({ paymentPayload: { x402Version: 1, accepted: requirements, payload: { transaction: "AAAA" } } }),
    ]) {
      expect(await refused(app, path, json(shape), 400)).toContain("invalid_payload");
    }
  });

  it.each(OPERATIONS)("%s: network and scheme", async (path) => {
    for (const network of ["stellar:pubnet", "eip155:8453", "", "stellar:testnet "]) {
      const refusal = await refused(
        app,
        path,
        json(body({ paymentRequirements: { ...requirements, network } })),
        200,
      );
      expect(refusal).toEqual(["invalid_network"]);
    }
    for (const scheme of ["upto", "EXACT", ""]) {
      const refusal = await refused(
        app,
        path,
        json(body({ paymentRequirements: { ...requirements, scheme } })),
        200,
      );
      expect(refusal).toEqual(["unsupported_scheme"]);
    }
  });

  it.each(OPERATIONS)("%s: API key and rate limit", async (path) => {
    const keyed = service({ env: { TESTNET_REQUIRE_API_KEY: "true" } });
    expect(await refused(keyed, path, json(body()), 401)).toContain("unauthorized");
    expect(await refused(keyed, path, json(body(), { authorization: "Bearer wrong" }), 401)).toContain(
      "unauthorized",
    );
    const limited = service({ env: { RATE_LIMIT_PER_MINUTE: "1" } });
    expect((await limited.request(path, json(body()))).status).toBe(200);
    expect(await refused(limited, path, json(body()), 429)).toContain("rate_limited");
  });

  it.each(OPERATIONS)("%s: a facilitator that throws", async (path) => {
    const failing = service({
      verify: () => Promise.reject(new Error("rpc down")),
      settle: () => Promise.reject(new Error("rpc down")),
    });
    expect(await refused(failing, path, json(body()), 500)).toEqual([
      path === "/verify" ? "unexpected_verify_error" : "unexpected_settle_error",
    ]);
  });

  it("passes the facilitator's own refusals through with their codes", async () => {
    const rejecting = service({
      verify: () =>
        Promise.resolve({
          isValid: false,
          invalidReason: "invalid_exact_stellar_signature_expired",
          invalidMessage: "The payer's authorization has expired; sign a new payment.",
        }),
      settle: () =>
        Promise.resolve({
          success: false,
          errorReason: "settle_exact_stellar_idempotency_conflict",
          errorMessage: "Already settled in another envelope.",
          transaction: "",
          network: "stellar:testnet",
        }),
    });
    expect(await refused(rejecting, "/verify", json(body()), 200)).toEqual([
      "invalid_exact_stellar_signature_expired",
    ]);
    expect(await refused(rejecting, "/settle", json(body()), 200)).toEqual([
      "settle_exact_stellar_idempotency_conflict",
    ]);
  });
});

describe("refusals on the other routes", () => {
  const app = service();

  it("unknown routes and methods", async () => {
    for (const [path, method] of [
      ["/nope", "GET"],
      ["/verify", "GET"],
      ["/supported", "POST"],
      ["/discovery", "GET"],
    ] as const) {
      expect(await refused(app, path, { method }, 404)).toEqual(["not_found"]);
    }
  });

  it("usage without an API key", async () => {
    expect(await refused(app, "/usage", {}, 401)).toEqual(["unauthorized"]);
    expect(await refused(app, "/usage", { headers: { "x-api-key": "wrong" } }, 401)).toEqual([
      "unauthorized",
    ]);
  });

  it("discovery parameters and unknown listings", async () => {
    for (const query of [
      "type=HTTP",
      "payTo=GNOTANADDRESS",
      "network=stellar",
      "extensions=a,,b",
      "limit=0",
      "limit=abc",
      "offset=-1",
      "offset=2000000",
      "asOf=yesterday",
      "unknown=1",
    ]) {
      expect(await refused(app, `/discovery/resources?${query}`, {}, 400), query).toEqual([
        "discovery_invalid_parameter",
      ]);
    }
    for (const path of [
      "/discovery/resources/not-an-id",
      "/discovery/resources/00000000-0000-4000-8000-000000000000",
      "/discovery/resources/00000000-0000-4000-8000-000000000000/versions",
    ]) {
      expect(await refused(app, path, {}, 404)).toEqual(["discovery_listing_not_found"]);
    }
  });

  it("search queries and cursors", async () => {
    expect(await refused(app, "/discovery/search", {}, 400)).toEqual(["discovery_invalid_parameter"]);
    expect(await refused(app, "/discovery/search?query=%20%20", {}, 400)).toEqual(["search_query_required"]);
    expect(await refused(app, `/discovery/search?query=${"a".repeat(501)}`, {}, 400)).toEqual([
      "search_query_too_long",
    ]);
    expect(await refused(app, `/discovery/search?query=${"a".repeat(2_001)}`, {}, 400)).toEqual([
      "discovery_invalid_parameter",
    ]);
    for (const cursor of ["abc", "x".repeat(200)]) {
      expect(await refused(app, `/discovery/search?query=weather&cursor=${cursor}`, {}, 400)).toEqual([
        "search_invalid_cursor",
      ]);
    }
    expect(await refused(app, `/discovery/search?query=weather&cursor=${"x".repeat(600)}`, {}, 400)).toEqual([
      "discovery_invalid_parameter",
    ]);
    for (const query of ["maxPrice=cheap", "asset=not-an-asset!", "limit=0", "sort=price"]) {
      expect(await refused(app, `/discovery/search?query=weather&${query}`, {}, 400), query).toEqual([
        "discovery_invalid_parameter",
      ]);
    }
  });

  it("a store that fails answers with an internal error", async () => {
    const store = new MemoryCatalogStore();
    const broken = new Proxy(store, {
      get(target, property, receiver) {
        if (property === "list" || property === "get" || property === "revision") {
          return () => Promise.reject(new Error("database unavailable"));
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
    const failing = service({ store: broken });
    expect(await refused(failing, "/discovery/resources", {}, 500)).toEqual(["internal_error"]);
    expect(
      await refused(failing, "/discovery/resources/00000000-0000-4000-8000-000000000000", {}, 500),
    ).toEqual(["internal_error"]);
    expect(await refused(failing, "/discovery/search?query=weather", {}, 500)).toEqual(["internal_error"]);
  });
});
