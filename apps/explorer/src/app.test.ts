import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { createExplorerApp, toDecimal, assetCode } from "./app.js";
import { loadConfig } from "./config.js";
import { ExplorerStore } from "./db.js";
import { FacilitatorRegistry } from "./registry.js";
import type { Hono } from "hono";
import type { PaymentRow } from "./types.js";
import type { FetchLike } from "./rpc.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const RAIL402_SUPPORTED = readFileSync(join(FIXTURES, "supported-rail402.json"), "utf8");

const logger = pino({ level: "silent" });

function payment(overrides: Partial<PaymentRow> = {}): PaymentRow {
  return {
    network: "stellar:testnet",
    epoch: "E1",
    ledger: 4124904,
    txHash: "0207d143713d28c5c0bbb1db2ac49b3ad06157510121eb5cd36dbc16dbfbfc80",
    opIndex: 0,
    scheme: "exact",
    buyer: "GA5ENMD2YIO5EPPB44OUH2ICEQBZCLW5SXNIFZHIP6763KYPW5MR6POE",
    seller: "GBQXGC5CDGYITXTJ5ZKH66WMAMBMGL345WYV4EKPUH23NTRZVUKK6747",
    amount: "10000",
    assetContract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    asset: "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    txSource: "GAAREO2YVOE3AQ72QYDWU252YVCDXJ236G5JUGPPT7UI3T5YHWT6P4F6",
    confidence: "x402-shaped",
    closedAt: "2026-08-13T18:31:11Z",
    rawEnvelope: '{"status":"SUCCESS"}',
    ingestedAt: "2026-08-13T18:31:15Z",
    serviceName: "Weather API",
    ...overrides,
  };
}

function build(fetchImpl?: FetchLike): { app: Hono; store: ExplorerStore } {
  const store = new ExplorerStore();
  const config = loadConfig({} as NodeJS.ProcessEnv);
  const registry = new FacilitatorRegistry({
    store,
    seeds: [],
    pollIntervalMs: 60_000,
    logger,
    fetchImpl: fetchImpl ?? (() => Promise.reject(new Error("no outbound in this test"))),
  });
  const app = createExplorerApp({ store, config, registry, logger });
  return { app, store };
}

describe("GET /feed", () => {
  it("serves projected rows with decimal amounts and WITHOUT the raw envelope", async () => {
    const { app, store } = build();
    store.insertPayment(payment());
    const res = await app.request("/feed");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Record<string, unknown>[] };
    expect(body.items).toHaveLength(1);
    const item = body.items[0]!;
    expect(item["amountDecimal"]).toBe("0.001");
    expect(item["assetCode"]).toBe("USDC");
    expect(item["serviceName"]).toBe("Weather API");
    expect(item["facilitator"]).toBeNull();
    expect(item["rawEnvelope"]).toBeUndefined();
    expect(item["raw"]).toBeUndefined();
  });

  it("filters by scheme and refuses an unknown scheme with a coded 400", async () => {
    const { app, store } = build();
    store.insertPayment(payment());
    store.insertPayment(
      payment({ txHash: "b".repeat(64), scheme: "upto", ceiling: "10000000", amount: "3500000" }),
    );
    const upto = (await (await app.request("/feed?scheme=upto")).json()) as {
      items: Record<string, unknown>[];
    };
    expect(upto.items).toHaveLength(1);
    expect(upto.items[0]!["ceilingDecimal"]).toBe("1");
    expect(upto.items[0]!["amountDecimal"]).toBe("0.35");

    const bad = await app.request("/feed?scheme=bogus");
    expect(bad.status).toBe(400);
    const err = (await bad.json()) as { code: string; reason: string };
    expect(err.code).toBe("explorer_invalid_query");
    expect(err.reason.length).toBeGreaterThan(10);
  });

  it("refuses a malformed cursor with a coded 400 instead of a 500", async () => {
    const { app, store } = build();
    store.insertPayment(payment());
    const res = await app.request("/feed?cursor=garbage");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("explorer_invalid_query");
  });
});

describe("GET /tx/:hash", () => {
  it("serves the full row including the parsed raw envelope", async () => {
    const { app, store } = build();
    store.insertPayment(payment());
    const res = await app.request(`/tx/${payment().txHash}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["scheme"]).toBe("exact");
    expect(body["raw"]).toEqual({ status: "SUCCESS" });
  });

  it("404s an unknown hash with a coded, retryable reason", async () => {
    const { app } = build();
    const res = await app.request(`/tx/${"c".repeat(64)}`);
    expect(res.status).toBe(404);
    const err = (await res.json()) as { code: string; retryable: boolean };
    expect(err.code).toBe("explorer_tx_not_found");
    expect(err.retryable).toBe(true);
  });

  it("400s a non-hash with a coded reason", async () => {
    const { app } = build();
    const res = await app.request("/tx/not-a-hash");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("explorer_invalid_query");
  });

  it("returns a CODED envelope for an unknown route, not plain-text 404 (review S4)", async () => {
    const { app } = build();
    const res = await app.request("/no-such-endpoint");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    const err = (await res.json()) as { code: string; reason: string };
    expect(err.code).toBe("explorer_invalid_query");
    expect(err.reason.length).toBeGreaterThan(0);
  });

  it("returns EVERY op of a multi-payment transaction (review M5)", async () => {
    const { app, store } = build();
    const hash = "d".repeat(64);
    store.insertPayment(payment({ txHash: hash, opIndex: 0, amount: "10000" }));
    store.insertPayment(payment({ txHash: hash, opIndex: 1, amount: "20000", seller: "GOTHERSELLER" }));
    const res = await app.request(`/tx/${hash}`);
    const body = (await res.json()) as { payments: Record<string, unknown>[]; raw: unknown };
    expect(body.payments).toHaveLength(2);
    expect(body.payments.map(p => p["amountDecimal"])).toEqual(["0.001", "0.002"]);
    expect(body.raw).toBeTruthy();
  });
});

describe("seller / facilitator / stats surfaces", () => {
  it("GET /seller/:payTo bundles meta, stats and payments", async () => {
    const { app, store } = build();
    store.insertPayment(payment());
    store.setSellerMeta({
      network: "stellar:testnet",
      payTo: payment().seller,
      serviceName: "Weather API",
      resource: "https://api.acme.dev/forecast",
      fetchedAt: "2026-08-13T18:00:00Z",
    });
    const res = await app.request(`/seller/${payment().seller}`);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["serviceName"]).toBe("Weather API");
    expect((body["stats"] as { totalPayments: number }).totalPayments).toBe(1);
    expect(body["payments"]).toHaveLength(1);
  });

  it("GET /facilitators lists registry rows with per-facilitator stats", async () => {
    const { app, store } = build();
    store.upsertFacilitator({
      id: "rail402",
      baseUrl: "https://facilitator.rail402.dev",
      displayName: "Rail402",
      verified: true,
      signers: ["GBRVXNCL55KOEB7WU3BPSEL34PSUH63UCIFPZDUBIVJBRRG5ZB7V4YR7"],
      uptoContracts: [],
      networks: ["stellar:testnet"],
      source: "seed",
      createdAt: "2026-08-13T00:00:00Z",
    });
    store.insertPayment(payment({ facilitatorId: "rail402", confidence: "rail402" }));
    const body = (await (await app.request("/facilitators")).json()) as {
      facilitators: Record<string, unknown>[];
    };
    expect(body.facilitators).toHaveLength(1);
    expect((body.facilitators[0]!["stats"] as { totalPayments: number }).totalPayments).toBe(1);

    const one = await app.request("/facilitator/rail402");
    expect(one.status).toBe(200);
    const missing = await app.request("/facilitator/nope");
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { code: string }).code).toBe(
      "explorer_facilitator_not_found",
    );
  });

  it("GET /stats and /health and /metrics serve without ingest (API-only mode)", async () => {
    const { app, store } = build();
    store.insertPayment(payment());
    const stats = (await (await app.request("/stats")).json()) as Record<string, unknown>;
    expect(stats["totalPayments"]).toBe(1);
    expect(stats["networks"]).toEqual(["stellar:testnet"]);

    const health = (await (await app.request("/health")).json()) as Record<string, unknown>;
    expect(health["status"]).toBe("ok");
    expect(health["storage"]).toBe("memory");
    expect(health["ingest"]).toBe("disabled");

    const metrics = await app.request("/metrics");
    const text = await metrics.text();
    expect(metrics.headers.get("Content-Type")).toContain("text/plain");
    expect(text).toContain("x402_explorer_payments_total 1");
    expect(text).toContain('x402_explorer_payments_by_scheme{scheme="exact"} 1');
  });
});

describe("POST /announce", () => {
  it("registers a facilitator it can verify and refuses what it cannot", async () => {
    const serving: FetchLike = url =>
      Promise.resolve(
        new URL(url).hostname === "facilitator.rail402.dev"
          ? new Response(RAIL402_SUPPORTED, { status: 200 })
          : new Response("nope", { status: 404 }),
      );
    const { app } = build(serving);

    const ok = await app.request("/announce", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: "https://facilitator.rail402.dev" }),
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { facilitator: { id: string; verified: boolean } };
    expect(body.facilitator.id).toBe("rail402");
    expect(body.facilitator.verified).toBe(true);

    const badUrl = await app.request("/announce", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: "https://127.0.0.1" }),
    });
    expect(badUrl.status).toBe(400);
    expect(((await badUrl.json()) as { code: string }).code).toBe(
      "explorer_announce_invalid_url",
    );

    const unreachable = await app.request("/announce", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseUrl: "https://other.example.org" }),
    });
    expect(unreachable.status).toBe(502);
    expect(((await unreachable.json()) as { code: string }).code).toBe(
      "explorer_announce_unreachable",
    );

    const notJson = await app.request("/announce", { method: "POST", body: "junk" });
    expect(notJson.status).toBe(400);
  });
});

describe("display helpers", () => {
  it("converts stroops to decimals in pure string arithmetic", () => {
    expect(toDecimal("10000")).toBe("0.001");
    expect(toDecimal("10000000")).toBe("1");
    expect(toDecimal("35000000")).toBe("3.5");
    expect(toDecimal("0")).toBe("0");
    expect(toDecimal("-10000")).toBe("-0.001");
    // Larger than Number.MAX_SAFE_INTEGER — float math would corrupt it.
    expect(toDecimal("92233720368547758080000000")).toBe("9223372036854775808");
  });

  it("maps SEP-11 asset strings to display codes", () => {
    expect(assetCode("native")).toBe("XLM");
    expect(assetCode("USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5")).toBe(
      "USDC",
    );
    expect(assetCode(undefined)).toBeUndefined();
  });
});
