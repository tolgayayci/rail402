import { afterEach, describe, expect, it, vi } from "vitest";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { PaymentRequiredV2Schema } from "@x402/core/schemas";
import { SETTLEMENT_OVERRIDES_HEADER } from "@x402/core/server";
import { SettleError } from "@x402/core/types";
import { USDC } from "@rail402.dev/stellar";
import { validateListing } from "@rail402.dev/sdk/seller";
import { TEST6_TESTNET } from "../src/lab/offers.ts";
import { forecastFor } from "../src/lab/sell.ts";
import { LAB_PATHS, LAB_PRICES, sellPath } from "../src/shared/lab.ts";
import { TRACE_HEADER, decodeTrace, parseServerTiming } from "../src/shared/trace.ts";
import {
  AUTHORITY,
  NETWORK,
  TRANSACTION,
  fakeFacilitator,
  paymentFor,
  requiredOf,
  type FakeFacilitator,
} from "./fake-facilitator.ts";
import { PAY_TO, testApp, testConfig, type TestApp } from "./support.ts";

const PUBLIC = "https://playground.example";
/** Behind a TLS proxy the server sees its internal address; resource URLs must still be public. */
const INTERNAL = "http://10.0.0.5:8080";

describe("lab sellers", () => {
  let app: TestApp | undefined;
  afterEach(() => {
    app?.close();
    app = undefined;
    vi.restoreAllMocks();
  });

  function labApp(facilitator: FakeFacilitator, env: Record<string, string> = {}): TestApp {
    app = testApp(testConfig({ TRUSTED_PROXY_HOPS: "1", ...env }), { labFacilitator: facilitator });
    return app;
  }

  function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
    if (app === undefined) throw new Error("no app");
    return app.request(`${INTERNAL}${path}`, { headers: { "x-forwarded-for": "198.51.100.7", ...headers } });
  }

  function traceOf(response: Response) {
    const trace = decodeTrace(response.headers.get(TRACE_HEADER));
    expect(trace, "Rail402-Trace").toBeDefined();
    return trace;
  }

  describe("the sandbox seller", () => {
    it("asks 0.01 USDC to the Playground's account on its public URL, with valid discovery metadata", async () => {
      labApp(fakeFacilitator());
      const response = await get(sellPath("Ankara"));
      expect(response.status).toBe(402);
      const required = requiredOf(response);
      expect(required.resource.url).toBe(`${PUBLIC}/lab/sell/forecast/Ankara`);
      expect(required.accepts).toEqual([
        expect.objectContaining({
          scheme: "exact",
          network: NETWORK,
          amount: LAB_PRICES.sell.atomic,
          asset: USDC[NETWORK].contract,
          payTo: PAY_TO,
        }),
      ]);
      expect(required.extensions?.["bazaar"]).toMatchObject({ routeTemplate: LAB_PATHS.sell });
      const validation = await validateListing(required, {
        network: NETWORK,
        concreteUrl: `${PUBLIC}${sellPath("Ankara")}`,
        method: "GET",
      });
      expect(validation.catalogable, JSON.stringify(validation)).toBe(true);
      expect(traceOf(response)).toEqual({ v: 1 });
      expect(response.headers.get("server-timing")).toBeNull();
    });

    it("keeps the declared example in every 402, whatever city the request names", async () => {
      labApp(fakeFacilitator());
      const required = requiredOf(await get(sellPath("İzmir")));
      const bazaar = required.extensions?.["bazaar"] as { info: { input: { pathParams?: unknown } } };
      expect(bazaar.info.input.pathParams).toEqual({ city: "Ankara" });
    });

    it("answers anything but a city name with a coded 404, before any 402", async () => {
      labApp(fakeFacilitator());
      for (const city of [
        "FREE-USDC-claim-at-evil.example-send-your-seed",
        "a/b",
        "x".repeat(41),
        "<b>",
        "%E0%A4%A",
      ]) {
        const response = await get(
          `/lab/sell/forecast/${city.includes("%") ? city : encodeURIComponent(city)}`,
        );
        expect(response.status, city).toBe(404);
        expect(await response.json()).toMatchObject({ error: { code: "playground_not_found" } });
        expect(response.headers.get("payment-required")).toBeNull();
      }
      expect((await get(sellPath("St. John's"))).status).toBe(402);
    });

    it("answers the same 402 every time, for any city, so the origin check always agrees", async () => {
      labApp(fakeFacilitator());
      const first = requiredOf(await get(sellPath("Ankara")));
      const second = requiredOf(await get(sellPath("Ankara")));
      expect(second).toEqual(first);
      const other = requiredOf(await get(sellPath("São Paulo")));
      expect(other.accepts).toEqual(first.accepts);
      expect(other.resource.url).toBe(`${PUBLIC}/lab/sell/forecast/S%C3%A3o%20Paulo`);
    });

    it("serves the forecast after verify and settle, and traces both and the catalog outcome", async () => {
      const facilitator = fakeFacilitator({
        settle: (requirements) =>
          Promise.resolve({
            success: true,
            transaction: TRANSACTION,
            network: NETWORK,
            amount: requirements.amount,
            extensionResponses: {
              bazaar: {
                status: "processing",
                code: "awaiting_origin_verification",
                listingId: "lst_1",
                version: 1,
              },
            },
          }),
      });
      labApp(facilitator);
      const required = requiredOf(await get(sellPath("Ankara")));
      const response = await get(sellPath("Ankara"), { "payment-signature": paymentFor(required) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(forecastFor("Ankara"));
      expect(decodePaymentResponseHeader(response.headers.get("payment-response") ?? "")).toMatchObject({
        success: true,
        transaction: TRANSACTION,
      });
      expect(facilitator.calls.map((call) => call.operation)).toEqual(["verify", "settle"]);
      expect(facilitator.calls[1]?.requirements.amount).toBe(LAB_PRICES.sell.atomic);
      const trace = traceOf(response);
      expect(trace).toMatchObject({
        v: 1,
        verify: { isValid: true },
        settle: { success: true, transaction: TRANSACTION, amount: LAB_PRICES.sell.atomic },
        bazaar: {
          status: "processing",
          code: "awaiting_origin_verification",
          listingId: "lst_1",
          version: 1,
        },
      });
      expect(trace?.settle).not.toHaveProperty("requested");
      const timing = parseServerTiming(response.headers.get("server-timing"));
      expect(Object.keys(timing).sort()).toEqual(["x402-settle", "x402-verify"]);
    });

    it("traces a refused verification and never settles", async () => {
      const facilitator = fakeFacilitator({
        verify: () =>
          Promise.resolve({
            isValid: false,
            invalidReason: "invalid_exact_stellar_payload_nonce_already_used",
            invalidMessage: "The authorization was already settled in transaction " + TRANSACTION,
          }),
      });
      labApp(facilitator);
      const required = requiredOf(await get(sellPath("Ankara")));
      const response = await get(sellPath("Ankara"), { "payment-signature": paymentFor(required) });
      expect(response.status).toBe(402);
      expect(facilitator.calls.map((call) => call.operation)).toEqual(["verify"]);
      expect(traceOf(response)).toMatchObject({
        verify: {
          isValid: false,
          code: "invalid_exact_stellar_payload_nonce_already_used",
          reason: expect.stringContaining("already settled") as unknown,
        },
      });
      expect(traceOf(response)?.settle).toBeUndefined();
      expect(parseServerTiming(response.headers.get("server-timing"))).toHaveProperty("x402-verify");
    });

    it("traces a failed settlement, which reaches the buyer as a 402 with a failed PAYMENT-RESPONSE", async () => {
      const facilitator = fakeFacilitator({
        settle: () =>
          Promise.reject(
            new SettleError(400, {
              success: false,
              errorReason: "invalid_exact_stellar_payload_signature_expired",
              errorMessage: "The authorization expired before settlement.",
              transaction: "",
              network: NETWORK,
            }),
          ),
      });
      labApp(facilitator);
      const required = requiredOf(await get(sellPath("Ankara")));
      const response = await get(sellPath("Ankara"), { "payment-signature": paymentFor(required) });
      expect(response.status).toBe(402);
      expect(traceOf(response)).toMatchObject({
        verify: { isValid: true },
        settle: { success: false, code: "invalid_exact_stellar_payload_signature_expired" },
      });
      expect(decodePaymentResponseHeader(response.headers.get("payment-response") ?? "")).toMatchObject({
        success: false,
      });
    });

    it("refuses with a code while the facilitator cannot be read, and retries a few seconds later", async () => {
      let now = 1_000_000;
      let down = true;
      const facilitator = fakeFacilitator({
        supported: () =>
          down ? Promise.reject(new Error("connect ECONNREFUSED")) : fakeFacilitator().getSupported(),
      });
      app = testApp(testConfig(), { labFacilitator: facilitator, now: () => now });
      const refused = await get(sellPath("Ankara"));
      expect(refused.status).toBe(503);
      expect(refused.headers.get("retry-after")).toBe("5");
      expect(await refused.json()).toMatchObject({ error: { code: "playground_lab_unavailable" } });
      expect(refused.headers.get(TRACE_HEADER)).not.toBeNull();
      down = false;
      expect((await get(sellPath("Ankara"))).status).toBe(503);
      expect(facilitator.supportedCalls).toBe(1);
      now += 5_001;
      expect((await get(sellPath("Ankara"))).status).toBe(402);
    });

    it("hides an unexpected facilitator failure behind a code: nothing it said reaches the buyer or a log", async () => {
      const echo = "facilitator-echo-canary";
      const facilitator = fakeFacilitator({ verify: () => Promise.reject(new Error(echo)) });
      const consoleLines: string[] = [];
      for (const method of ["log", "warn", "error"] as const) {
        vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
          consoleLines.push(args.map(String).join(" "));
        });
      }
      labApp(facilitator);
      const required = requiredOf(await get(sellPath("Ankara")));
      const response = await get(sellPath("Ankara"), { "payment-signature": paymentFor(required) });
      expect(response.status).toBe(503);
      const body = await response.text();
      expect(JSON.parse(body)).toMatchObject({ error: { code: "playground_lab_unavailable" } });
      expect(traceOf(response)).toMatchObject({
        verify: { isValid: false, code: "playground_upstream_unavailable" },
      });
      for (const channel of [
        body,
        JSON.stringify([...response.headers]),
        app?.logs.text() ?? "",
        ...consoleLines,
      ])
        expect(channel).not.toContain(echo);
    });
  });

  describe("the overcharging seller", () => {
    it("quotes an upto cap of 0.01 with a one-minute authorization and no discovery metadata", async () => {
      labApp(fakeFacilitator());
      const response = await get(`${LAB_PATHS.greedy}?city=Berlin&days=7`);
      expect(response.status).toBe(402);
      const required = requiredOf(response);
      expect(required.resource.url).toBe(`${PUBLIC}${LAB_PATHS.greedy}?city=Berlin&days=7`);
      expect(required.accepts).toEqual([
        expect.objectContaining({
          scheme: "upto",
          network: NETWORK,
          amount: LAB_PRICES.greedyCap.atomic,
          payTo: PAY_TO,
          maxTimeoutSeconds: 60,
          extra: expect.objectContaining({ facilitatorAddress: AUTHORITY }) as unknown,
        }),
      ]);
      expect(required.extensions?.["bazaar"]).toBeUndefined();
    });

    it("asks the facilitator to settle twice the cap and reports the refusal", async () => {
      const facilitator = fakeFacilitator({
        settle: () =>
          Promise.resolve({
            success: false,
            errorReason: "invalid_upto_stellar_payload_settlement_exceeds_amount",
            errorMessage: "The settlement amount exceeds the authorized maximum.",
            transaction: "",
            network: NETWORK,
          }),
      });
      labApp(facilitator);
      const path = `${LAB_PATHS.greedy}?city=Berlin&days=7`;
      const required = requiredOf(await get(path));
      const response = await get(path, { "payment-signature": paymentFor(required) });
      expect(response.status).toBe(402);
      expect(facilitator.calls.find((call) => call.operation === "settle")?.requirements.amount).toBe(
        LAB_PRICES.greedyCharge.atomic,
      );
      expect(traceOf(response)).toMatchObject({
        verify: { isValid: true },
        settle: {
          success: false,
          code: "invalid_upto_stellar_payload_settlement_exceeds_amount",
          requested: LAB_PRICES.greedyCharge.atomic,
        },
      });
      expect(response.headers.get(SETTLEMENT_OVERRIDES_HEADER)).toBeNull();
      expect(decodePaymentResponseHeader(response.headers.get("payment-response") ?? "")).toMatchObject({
        success: false,
        errorReason: "invalid_upto_stellar_payload_settlement_exceeds_amount",
      });
    });

    it("is refused with a code when the facilitator does not serve upto, while the sandbox still works", async () => {
      labApp(fakeFacilitator({ upto: false }));
      const response = await get(LAB_PATHS.greedy);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "playground_lab_unavailable" } });
      expect((await get(sellPath("Ankara"))).status).toBe(402);
    });
  });

  describe("the refusal offers", () => {
    const expected = {
      pubnet: { network: "stellar:pubnet", asset: USDC["stellar:pubnet"].contract, amount: "100000" },
      asset: { network: NETWORK, asset: TEST6_TESTNET, amount: "10000" },
      zero: { network: NETWORK, asset: USDC[NETWORK].contract, amount: "0" },
    } as const;

    it("answer a valid x402 version 2 402 only, never contacting the facilitator", async () => {
      const facilitator = fakeFacilitator();
      labApp(facilitator);
      for (const [id, path] of Object.entries(LAB_PATHS.offers)) {
        const response = await get(path);
        expect(response.status, id).toBe(402);
        const required = requiredOf(response);
        expect(PaymentRequiredV2Schema.safeParse(required).success, id).toBe(true);
        expect(required.resource.url).toBe(`${PUBLIC}${path}`);
        expect(required.accepts).toEqual([
          expect.objectContaining({
            scheme: "exact",
            payTo: PAY_TO,
            ...expected[id as keyof typeof expected],
          }),
        ]);
        expect(traceOf(response)).toEqual({ v: 1 });
        const paid = await get(path, { "payment-signature": paymentFor(required) });
        expect(paid.status, `${id} paid`).toBe(402);
      }
      expect(facilitator.calls).toEqual([]);
      expect(facilitator.supportedCalls).toBe(0);
    });

    it("name the TEST6 deployment the repository records", async () => {
      const { readFile } = await import("node:fs/promises");
      const record = JSON.parse(
        await readFile(
          new URL("../../../contracts/testing/deployments/test6-testnet.json", import.meta.url),
          "utf8",
        ),
      ) as { contract_id: string; constructor: { decimals: number } };
      expect(record.contract_id).toBe(TEST6_TESTNET);
      expect(record.constructor.decimals).toBe(6);
    });
  });

  describe("around the sellers", () => {
    it("publishes stellar.toml naming the Playground's account, readable from any origin", async () => {
      labApp(fakeFacilitator());
      const response = await get("/.well-known/stellar.toml");
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(response.headers.get("content-type")).toMatch(/^text\/plain/);
      const text = await response.text();
      expect(text).toContain(`ACCOUNTS = ["${PAY_TO}"]`);
      expect(text).toContain('NETWORK_PASSPHRASE = "Test SDF Network ; September 2015"');
    });

    it("is switched off with a code, and then publishes no stellar.toml", async () => {
      app = testApp(testConfig({ LAB_ENABLED: "false", PLAYGROUND_PAY_TO: undefined }), {
        labFacilitator: fakeFacilitator(),
      });
      const response = await get(sellPath("Ankara"));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: { code: "playground_feature_disabled" } });
      expect((await get("/.well-known/stellar.toml")).status).toBe(404);
    });

    it("answers unknown lab paths and other methods with a coded 404", async () => {
      labApp(fakeFacilitator());
      for (const response of [
        await get("/lab/unknown"),
        await get("/lab/sell/forecast/a/b"),
        await (app as TestApp).request(`${INTERNAL}${sellPath("Ankara")}`, { method: "POST" }),
      ]) {
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ error: { code: "playground_not_found" } });
      }
    });

    it("answers HEAD with the 402 but takes payments on GET only", async () => {
      const facilitator = fakeFacilitator();
      labApp(facilitator);
      const head = await (app as TestApp).request(`${INTERNAL}${sellPath("Ankara")}`, { method: "HEAD" });
      expect(head.status).toBe(402);
      const required = requiredOf(head);
      const paid = await (app as TestApp).request(`${INTERNAL}${sellPath("Ankara")}`, {
        method: "HEAD",
        headers: { "payment-signature": paymentFor(required) },
      });
      expect(paid.status).toBe(400);
      expect(facilitator.calls).toEqual([]);
    });

    it("limits unpaid and paid lab calls per client, and paid calls across clients", async () => {
      labApp(fakeFacilitator(), {
        LAB_UNPAID_PER_MINUTE: "2",
        LAB_PAID_PER_MINUTE: "1",
        LAB_PAID_GLOBAL_PER_MINUTE: "2",
      });
      expect((await get(LAB_PATHS.offers.zero)).status).toBe(402);
      expect((await get(LAB_PATHS.offers.zero)).status).toBe(402);
      const limited = await get(LAB_PATHS.offers.zero);
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(await limited.json()).toMatchObject({ error: { code: "playground_rate_limited" } });

      const payment = Buffer.from(
        JSON.stringify({ x402Version: 2, accepted: {}, payload: { transaction: "AAAA" } }),
      ).toString("base64");
      const junk = await get(LAB_PATHS.offers.zero, {
        "x-forwarded-for": "198.51.100.20",
        "payment-signature": "e30",
      });
      expect(junk.status).toBe(400);
      expect(await junk.json()).toMatchObject({ error: { code: "playground_request_invalid" } });
      const paid = (client: string) =>
        get(LAB_PATHS.offers.zero, { "x-forwarded-for": client, "payment-signature": payment });
      expect((await paid("198.51.100.20")).status).toBe(402);
      expect((await paid("198.51.100.20")).status).toBe(429);
      // A payment refused without a facilitator call leaves the shared pool alone: minted payloads
      // from many clients cannot use it up.
      for (const client of ["198.51.100.21", "198.51.100.22", "198.51.100.23"]) {
        expect((await paid(client)).status).toBe(402);
      }
      // Payments the facilitator verifies draw on it.
      const required = requiredOf(await get(sellPath("Ankara"), { "x-forwarded-for": "198.51.100.30" }));
      const real = (client: string) =>
        get(sellPath("Ankara"), { "x-forwarded-for": client, "payment-signature": paymentFor(required) });
      expect((await real("198.51.100.31")).status).toBe(200);
      expect((await real("198.51.100.32")).status).toBe(200);
      expect((await real("198.51.100.33")).status).toBe(429);
    });

    it("logs the route template and outcome, never the city, query or payment", async () => {
      const facilitator = fakeFacilitator();
      labApp(facilitator);
      const required = requiredOf(await get(sellPath("Secretville")));
      const payment = paymentFor(required);
      await get(`${sellPath("Secretville")}?q=query-canary`, { "payment-signature": payment });
      const lines = app?.logs.lines.filter((line) => line["msg"] === "request") ?? [];
      expect(lines.map((line) => line["route"])).toEqual([LAB_PATHS.sell, LAB_PATHS.sell]);
      expect(lines[1]).toMatchObject({ paid: true });
      const text = app?.logs.text() ?? "";
      for (const canary of ["Secretville", "query-canary", payment]) expect(text).not.toContain(canary);
    });
  });
});
