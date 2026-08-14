import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { Keypair } from "@stellar/stellar-sdk";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { loadConfig, type PlaygroundConfig } from "./config.js";
import { createApp } from "./app.js";
import type { BalanceLine, HorizonGateway } from "./dispenser.js";

/**
 * Wire-level tests: the app is exercised through `app.request()` exactly as a browser would hit
 * it. The one piece of real network the stock payment middleware needs — the facilitator's
 * `/supported` — is served by an in-process stub whose body is a verbatim capture from the live
 * deployment (2026-08-13), so the middleware is configured by the same JSON a production seller
 * sees.
 */

const SECRET = Keypair.random().secret();

const SUPPORTED = {
  kinds: [
    { x402Version: 2, scheme: "exact", network: "stellar:testnet", extra: { areFeesSponsored: true } },
    {
      x402Version: 2,
      scheme: "upto",
      network: "stellar:testnet",
      extra: {
        uptoContract: "CCMM3FMGEH7FHRYXZ3WQDQCTIWDXGZBGW7D4UT7NKH34SUQACYC3U54X",
        areFeesSponsored: true,
      },
    },
  ],
  extensions: ["bazaar"],
  signers: { "stellar:*": ["GBRVXNCL55KOEB7WU3BPSEL34PSUH63UCIFPZDUBIVJBRRG5ZB7V4YR7"] },
};

let stub: ServerType;
let facilitatorUrl: string;

beforeAll(async () => {
  const facilitator = new Hono();
  facilitator.get("/supported", c => c.json(SUPPORTED));
  await new Promise<void>(resolve => {
    stub = serve({ fetch: facilitator.fetch, port: 0 }, info => {
      facilitatorUrl = `http://127.0.0.1:${info.port}`;
      resolve();
    });
  });
});

afterAll(() => stub.close());

function makeApp(deps: { horizon?: HorizonGateway } = {}) {
  const config: PlaygroundConfig = loadConfig({
    PLAYGROUND_DISPENSER_SECRET: SECRET,
    PLAYGROUND_FACILITATOR_URL: facilitatorUrl,
  } as NodeJS.ProcessEnv);
  return { config, ...createApp({ config, ...deps }) };
}

describe("playground app", () => {
  it("serves health and the full bootstrap config", async () => {
    const { app } = makeApp();
    expect((await app.request("/health")).status).toBe(200);

    const config = (await (await app.request("/session/config")).json()) as Record<string, unknown>;
    expect(config["network"]).toBe("stellar:testnet");
    expect(config["friendbotUrl"]).toContain("friendbot");
    expect((config["usdc"] as { sac: string }).sac).toMatch(/^C/);
    expect(config["uptoContract"]).toMatch(/^C/);
  });

  it("exposes payment headers through CORS so a browser can inspect them", async () => {
    const { app } = makeApp();
    const res = await app.request("/health", { headers: { Origin: "https://play.example" } });
    // With the default wildcard origin the exposeHeaders list must still be present.
    expect(res.headers.get("access-control-expose-headers") ?? "").toContain("PAYMENT-REQUIRED");
  });

  it("refuses an unpaid GET /demo/convert with a 402 carrying the exact-scheme challenge", async () => {
    const { app, config } = makeApp();
    const res = await app.request("/demo/convert?amount=0.5");
    expect(res.status).toBe(402);
    const header = res.headers.get("PAYMENT-REQUIRED");
    expect(header).toBeTruthy();
    const challenge = decodePaymentRequiredHeader(header!) as PaymentRequired;
    const accepts = challenge.accepts[0]!;
    expect(accepts.scheme).toBe("exact");
    expect(accepts.amount).toBe(config.exactPriceStroops.toString());
    expect(accepts.payTo).toBe(config.payTo);
    // The stock client hard-requires this or it throws before paying (finding B2).
    expect(accepts.extra["areFeesSponsored"]).toBe(true);
  });

  it("refuses malformed convert params free of charge — 400 before any 402", async () => {
    const { app } = makeApp();
    const res = await app.request("/demo/convert?amount=1e9");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string; reason: string };
    expect(body.code).toBe("playground_invalid_request");
    expect(body.reason).toContain("Nothing was charged");
  });

  it("serves the meter 402 challenge on open without a payment header", async () => {
    const { app } = makeApp();
    const res = await app.request("/demo/meter/open", { method: "POST" });
    expect(res.status).toBe(402);
    const challenge = (await res.json()) as PaymentRequired;
    expect(challenge.accepts[0]!.scheme).toBe("upto");
    expect(res.headers.get("PAYMENT-REQUIRED")).toBeTruthy();
  });

  it("funds a session through the dispenser route", async () => {
    const target = Keypair.random().publicKey();
    const usdc = (c: PlaygroundConfig, balance: string): BalanceLine => ({
      assetCode: c.usdc.code,
      assetIssuer: c.usdc.issuer,
      balance,
      native: false,
    });
    const ref: { config?: PlaygroundConfig } = {};
    const horizon: HorizonGateway = {
      async getBalances(id) {
        const c = ref.config!;
        if (id === c.dispenser.publicKey()) return [usdc(c, "100.0000000")];
        if (id === target) return [usdc(c, "0.0000000")];
        return null;
      },
      async submitPayment() {
        return { hash: "drip-hash" };
      },
    };
    const { app, config } = makeApp({ horizon });
    ref.config = config;

    const ok = await app.request("/session/fund", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account: target }),
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { hash: string }).hash).toBe("drip-hash");

    const missing = await app.request("/session/fund", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account: Keypair.random().publicKey() }),
    });
    expect(missing.status).toBe(409);
    expect(((await missing.json()) as { code: string }).code).toBe(
      "playground_dispenser_account_not_found",
    );
  });

  it("stores and replays a shared session, and 404s an unknown id", async () => {
    const { app } = makeApp();
    const events = [{ kind: "settled", hash: "abc" }];
    const put = await app.request("/share", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events }),
    });
    expect(put.status).toBe(200);
    const { id } = (await put.json()) as { id: string };

    const got = await app.request(`/share/${id}`);
    expect(((await got.json()) as { events: unknown }).events).toEqual(events);

    const gone = await app.request("/share/nope");
    expect(gone.status).toBe(404);
    expect(((await gone.json()) as { code: string }).code).toBe("playground_share_not_found");
  });

  it("forwards attack /verify to the facilitator and passes its refusal through untouched", async () => {
    // A fetchImpl standing in for the facilitator: it records the forwarded body and returns a
    // coded verify refusal with the facilitator's own status.
    let forwarded: unknown;
    const fetchImpl = (async (url: unknown, init?: { body?: string }) => {
      if (String(url).endsWith("/verify")) {
        forwarded = JSON.parse(init!.body!);
        return new Response(
          JSON.stringify({
            isValid: false,
            invalidReason: "invalid_exact_stellar_payload_wrong_amount",
            invalidMessage: "The amount does not match the signed transfer.",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const config = loadConfig({
      PLAYGROUND_DISPENSER_SECRET: SECRET,
      PLAYGROUND_FACILITATOR_URL: facilitatorUrl,
    } as NodeJS.ProcessEnv);
    const { app } = createApp({ config, fetchImpl });

    const res = await app.request("/attack/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x402Version: 2, paymentPayload: { a: 1 }, paymentRequirements: { b: 2 } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { isValid: boolean; invalidReason: string };
    expect(body.isValid).toBe(false);
    expect(body.invalidReason).toBe("invalid_exact_stellar_payload_wrong_amount");
    // The proxy forwarded the exact envelope, adding nothing.
    expect(forwarded).toEqual({ x402Version: 2, paymentPayload: { a: 1 }, paymentRequirements: { b: 2 } });
  });

  it("reports an unreachable facilitator through the proxy as a coded 502", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const config = loadConfig({
      PLAYGROUND_DISPENSER_SECRET: SECRET,
      PLAYGROUND_FACILITATOR_URL: facilitatorUrl,
    } as NodeJS.ProcessEnv);
    const { app } = createApp({ config, fetchImpl });

    const res = await app.request("/bazaar/search?query=weather");
    expect(res.status).toBe(502);
    expect(((await res.json()) as { code: string }).code).toBe("playground_facilitator_unreachable");
  });

  it("serves a runnable publish snippet and checks an endpoint", async () => {
    const { app } = makeApp();
    const snippet = (await (await app.request("/publish/snippet?framework=hono&path=/weather&price=0.05")).json()) as {
      code: string;
      priceStroops: string;
    };
    expect(snippet.priceStroops).toBe("500000");
    expect(snippet.code).toContain('"GET /weather"');
    expect(snippet.code).toContain("describeEndpoint");

    // /publish/check proxies a GET at the URL via the injected fetch.
    const checkFetch = (async () =>
      new Response(JSON.stringify({ accepts: [{ scheme: "exact", network: "stellar:testnet", amount: "500000" }], extensions: { bazaar: {} } }), {
        status: 402,
      })) as typeof fetch;
    const config = loadConfig({
      PLAYGROUND_DISPENSER_SECRET: SECRET,
      PLAYGROUND_FACILITATOR_URL: facilitatorUrl,
    } as NodeJS.ProcessEnv);
    const { app: app2 } = createApp({ config, fetchImpl: checkFetch });
    const check = await app2.request("/publish/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://seller.example/weather" }),
    });
    expect(((await check.json()) as { ok: boolean }).ok).toBe(true);
  });

  it("validates the agent-run budget and emits the mcp config with the right env vars", async () => {
    const { app } = makeApp();
    const tooSmall = await app.request("/agent/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ budget: "0.01" }),
    });
    expect(tooSmall.status).toBe(400);
    expect(((await tooSmall.json()) as { code: string }).code).toBe("playground_invalid_request");

    const mcp = await app.request("/agent/mcp-config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionSecret: SECRET, budget: "0.5" }),
    });
    const body = (await mcp.json()) as { json: string };
    const env = (JSON.parse(body.json) as { mcpServers: { "rail402-stellar": { env: Record<string, string> } } })
      .mcpServers["rail402-stellar"].env;
    expect(Object.keys(env).sort()).toEqual(["BAZAAR_URL", "CLIENT_STELLAR_PRIVATE_KEY", "MAX_AMOUNT_CEILING", "STELLAR_NETWORK"]);
  });

  it("answers unknown endpoints with a coded 404, never a bare status", async () => {
    const { app } = makeApp();
    const res = await app.request("/definitely/not/here");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string; reason: string };
    expect(body.code).toBe("playground_invalid_request");
    expect(body.reason.length).toBeGreaterThan(20);
  });
});
