import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { Keypair } from "@stellar/stellar-sdk";
import { loadConfig, type PlaygroundConfig } from "./config.js";
import { createApp } from "./app.js";
import type { InteropCheckResult } from "./interop.js";

/**
 * P5 — the trustline pre-flight and the interop indicator, exercised over the wire.
 *
 * The stub upstream plays BOTH roles the injected fetch reaches: the facilitator's discovery
 * endpoints (stock envelope shapes, deliberately breakable per-test) and Horizon's /accounts (the
 * three trustline outcomes). The playground app is pointed at it for everything, so what is
 * asserted is the full route behavior, not the helpers in isolation.
 */

const SECRET = Keypair.random().secret();
const LISTED_URL = "https://seller.example/api/lookup";

const GOOD_ENTRY = {
  type: "http",
  resource: LISTED_URL,
  x402Version: 2,
  lastUpdated: "2026-08-15T00:00:00.000Z",
  accepts: [
    {
      scheme: "exact",
      network: "stellar:testnet",
      amount: "500000",
      payTo: Keypair.random().publicKey(),
      maxTimeoutSeconds: 60,
      asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      extra: { areFeesSponsored: true },
    },
  ],
};

// Mutable per-test switches for how the stub misbehaves.
let searchEnvelopeKey: "resources" | "items" = "resources";
let entryLastUpdated: unknown = GOOD_ENTRY.lastUpdated;

// Horizon fixtures keyed by account.
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const ACCOUNT_OK = Keypair.random().publicKey();
const ACCOUNT_MISSING_LINE = Keypair.random().publicKey();
const ACCOUNT_UNAUTHORIZED = Keypair.random().publicKey();
const ACCOUNT_ABSENT = Keypair.random().publicKey();

let stub: ServerType;
let stubUrl: string;

beforeAll(async () => {
  const upstream = new Hono();
  upstream.get("/supported", c =>
    c.json({ kinds: [{ x402Version: 2, scheme: "exact", network: "stellar:testnet", extra: { areFeesSponsored: true } }] }),
  );
  upstream.get("/discovery/resources", c => {
    const offset = Number(c.req.query("offset") ?? "0");
    const items = offset === 0 ? [{ ...GOOD_ENTRY, lastUpdated: entryLastUpdated }] : [];
    return c.json({ x402Version: 2, items, pagination: { limit: Number(c.req.query("limit") ?? 100), offset, total: 1 } });
  });
  upstream.get("/discovery/search", c =>
    c.json({ x402Version: 2, [searchEnvelopeKey]: [], pagination: null }),
  );
  // Horizon: the injected fetch reaches the real horizon URL; the test fetch routes it here.
  upstream.get("/accounts/:id", c => {
    const id = c.req.param("id");
    if (id === ACCOUNT_ABSENT) return c.json({ status: 404 }, 404);
    if (id === ACCOUNT_MISSING_LINE) return c.json({ balances: [{ asset_type: "native", balance: "100.0" }] });
    if (id === ACCOUNT_UNAUTHORIZED)
      return c.json({
        balances: [
          { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: USDC_ISSUER, is_authorized: false, limit: "1000", balance: "0" },
        ],
      });
    return c.json({
      balances: [
        { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: USDC_ISSUER, is_authorized: true, limit: "1000", balance: "5.0" },
      ],
    });
  });
  await new Promise<void>(resolve => {
    stub = serve({ fetch: upstream.fetch, port: 0 }, info => {
      stubUrl = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });
});

afterAll(() => stub.close());

function makeApp() {
  const config: PlaygroundConfig = loadConfig({
    PLAYGROUND_DISPENSER_SECRET: SECRET,
    PLAYGROUND_FACILITATOR_URL: stubUrl,
  } as NodeJS.ProcessEnv);
  // Route EVERYTHING (facilitator + Horizon) into the stub: Horizon URLs are rewritten by host.
  const fetchImpl: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const rerouted = url.replace("https://horizon-testnet.stellar.org", stubUrl);
    return fetch(rerouted, init);
  };
  return { config, ...createApp({ config, fetchImpl }) };
}

describe("GET /session/trustline", () => {
  it("reports the four states with reasons on every non-ok", async () => {
    const { app } = makeApp();
    const get = async (account: string) =>
      (await (await app.request(`/session/trustline?account=${account}`)).json()) as {
        state: string;
        reason?: string;
        asset: { code: string };
      };

    const ok = await get(ACCOUNT_OK);
    expect(ok.state).toBe("ok");
    expect(ok.asset.code).toBe("USDC");

    const missing = await get(ACCOUNT_MISSING_LINE);
    expect(missing.state).toBe("missing");
    expect(missing.reason).toContain("trustline");

    const unauthorized = await get(ACCOUNT_UNAUTHORIZED);
    expect(unauthorized.state).toBe("unauthorized");
    expect(unauthorized.reason).toContain("issuer");

    const absent = await get(ACCOUNT_ABSENT);
    expect(absent.state).toBe("missing");
    expect(absent.reason).toContain("does not exist");
  });

  it("teaches rather than guesses on invalid inputs", async () => {
    const { app } = makeApp();
    const contract = await app.request(
      "/session/trustline?account=CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    );
    expect(contract.status).toBe(400);
    expect(((await contract.json()) as { reason: string }).reason).toContain("contract storage");

    const mangled = await app.request("/session/trustline?account=GABCNOTREAL");
    expect(mangled.status).toBe(400);
    expect(((await mangled.json()) as { reason: string }).reason).toContain("checksum");

    const missing = await app.request("/session/trustline");
    expect(missing.status).toBe(400);
  });
});

describe("GET /bazaar/interop-check", () => {
  it("passes a well-shaped listing end to end", async () => {
    searchEnvelopeKey = "resources";
    entryLastUpdated = GOOD_ENTRY.lastUpdated;
    const { app } = makeApp();
    const res = await app.request(`/bazaar/interop-check?url=${encodeURIComponent(LISTED_URL)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as InteropCheckResult;
    expect(body.ok).toBe(true);
    expect(body.listed).toBe(true);
    expect(body.checks.map(c => c.name).sort()).toEqual(["entry-shape", "list-envelope", "search-envelope"]);
    expect(body.checks.every(c => c.ok)).toBe(true);
  });

  it("reports an unlisted URL honestly, with the envelope checks still run", async () => {
    const { app } = makeApp();
    const res = await app.request("/bazaar/interop-check?url=https://never-paid.example/api");
    const body = (await res.json()) as InteropCheckResult;
    expect(body.ok).toBe(false);
    expect(body.listed).toBe(false);
    expect(body.reason).toContain("first settled payment");
    expect(body.checks.find(c => c.name === "list-envelope")?.ok).toBe(true);
  });

  it("catches the list/search asymmetry being violated — the silent stock-client breaker", async () => {
    searchEnvelopeKey = "items";
    const { app } = makeApp();
    const body = (await (
      await app.request(`/bazaar/interop-check?url=${encodeURIComponent(LISTED_URL)}`)
    ).json()) as InteropCheckResult;
    searchEnvelopeKey = "resources";
    expect(body.ok).toBe(false);
    const search = body.checks.find(c => c.name === "search-envelope")!;
    expect(search.ok).toBe(false);
    expect(search.detail).toContain("resources");
  });

  it("catches a non-ISO lastUpdated — the spec-vs-SDK divergence stock types standardized on", async () => {
    entryLastUpdated = 1755216000;
    const { app } = makeApp();
    const body = (await (
      await app.request(`/bazaar/interop-check?url=${encodeURIComponent(LISTED_URL)}`)
    ).json()) as InteropCheckResult;
    entryLastUpdated = GOOD_ENTRY.lastUpdated;
    expect(body.ok).toBe(false);
    expect(body.checks.find(c => c.name === "entry-shape")?.ok).toBe(false);
  });

  it("refuses garbage input with a coded 400", async () => {
    const { app } = makeApp();
    const res = await app.request("/bazaar/interop-check?url=not-a-url");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("playground_invalid_request");
  });

  it("announces both P5 endpoints in /session/config", async () => {
    const { app } = makeApp();
    const config = (await (await app.request("/session/config")).json()) as {
      demo: { trustline: { path: string }; interop: { path: string } };
    };
    expect(config.demo.trustline.path).toBe("/session/trustline");
    expect(config.demo.interop.path).toBe("/bazaar/interop-check");
  });
});
