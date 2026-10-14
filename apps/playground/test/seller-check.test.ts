import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { encodePaymentRequiredHeader } from "@x402/core/http";
import {
  checkSellerOrigin,
  sellerError,
  type CheckSellerOriginOptions,
  type OriginReport,
} from "@rail402.dev/sdk/seller";
import { offerOf } from "../src/lab/offers.ts";
import { SELLER_CHECK_PATH } from "../src/seller-check.ts";
import { PAY_TO, testApp, testConfig, type TestApp } from "./support.ts";

/** Endpoints that refuse connections, so no check in this file reaches the network. */
const CLOSED = "http://127.0.0.1:9";

interface Seen {
  readonly url: string;
  readonly options: CheckSellerOriginOptions | undefined;
}

/** A check that records what it was asked and answers a fixed report. */
function recordingCheck(seen: Seen[], answer?: () => Promise<OriginReport>): typeof checkSellerOrigin {
  return (url, options) => {
    seen.push({ url, options });
    return answer?.() ?? Promise.resolve({ url, type: "http", ok: true, findings: [] });
  };
}

describe("seller check", () => {
  let app: TestApp | undefined;
  afterEach(() => {
    app?.close();
    app = undefined;
  });

  function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    if (app === undefined) throw new Error("no app");
    return app.request(SELLER_CHECK_PATH, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.30", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  async function errorOf(response: Response): Promise<{ code: string; reason: string }> {
    const body = (await response.json()) as { error: { code: string; reason: string } };
    expect(body.error.reason).not.toBe("");
    return body.error;
  }

  it("checks the URL with an https:443, public-only policy and the Playground's own facilitator", async () => {
    const seen: Seen[] = [];
    app = testApp(testConfig({ TRUSTED_PROXY_HOPS: "1" }), { sellerCheck: recordingCheck(seen) });
    const response = await post({ url: "https://seller.example/forecast/Ankara", method: "GET" });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      url: "https://seller.example/forecast/Ankara",
      type: "http",
      ok: true,
      findings: [],
    });
    expect(seen).toHaveLength(1);
    const [{ url, options = {} }] = seen as [Seen];
    expect(url).toBe("https://seller.example/forecast/Ankara");
    expect(options).toMatchObject({
      network: "stellar:testnet",
      method: "GET",
      rpcUrl: "https://soroban-testnet.stellar.org",
      facilitatorUrl: "https://testnet.rail402.dev",
      egress: { schemes: ["https:"], ports: [443], allowPrivateNetwork: false, redirects: { mode: "error" } },
    });
    expect(options.allowLoopback).toBeUndefined();
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("allows loopback sellers on their own port in local mode only", async () => {
    const seen: Seen[] = [];
    app = testApp(testConfig({ PLAYGROUND_MODE: "local", PUBLIC_URL: "http://127.0.0.1:1" }), {
      sellerCheck: recordingCheck(seen),
    });
    await post({ url: "http://127.0.0.1:4021/mcp", toolName: "forecast", arguments: { city: "Izmir" } });
    expect(seen[0]?.options).toMatchObject({
      allowLoopback: true,
      toolName: "forecast",
      arguments: { city: "Izmir" },
      egress: { schemes: ["https:", "http:"], ports: [443, 80, 4021], allowPrivateNetwork: "loopback" },
    });
  });

  it("refuses malformed, oversized and non-JSON requests with codes", async () => {
    const seen: Seen[] = [];
    app = testApp(testConfig(), { sellerCheck: recordingCheck(seen) });
    const cases: [unknown, Record<string, string>, number, string, RegExp?][] = [
      ["{not json", {}, 400, "playground_request_invalid", /not valid JSON/],
      [
        { url: "https://seller.example/" },
        { "content-type": "text/plain" },
        400,
        "playground_request_invalid",
      ],
      [{}, {}, 400, "playground_request_invalid", /^url:/],
      [{ url: "/relative" }, {}, 400, "playground_request_invalid", /absolute URL/],
      [
        { url: "https://seller.example/", method: "TRACE" },
        {},
        400,
        "playground_request_invalid",
        /^method:/,
      ],
      [{ url: "https://seller.example/", extra: 1 }, {}, 400, "playground_request_invalid"],
      [{ url: `https://seller.example/${"a".repeat(2_100)}` }, {}, 400, "playground_request_invalid"],
      [
        { url: "https://seller.example/", arguments: { blob: "x".repeat(9_000) } },
        {},
        413,
        "playground_request_too_large",
      ],
    ];
    for (const [body, headers, status, code, reason] of cases) {
      const response = await post(body, headers);
      expect(response.status, JSON.stringify(body).slice(0, 60)).toBe(status);
      const error = await errorOf(response);
      expect(error.code).toBe(code);
      if (reason !== undefined) expect(error.reason).toMatch(reason);
    }
    expect(seen).toEqual([]);
  });

  it("answers only same-origin requests from the page", async () => {
    app = testApp(testConfig(), { sellerCheck: recordingCheck([]) });
    const foreign: Record<string, string>[] = [
      { origin: "https://evil.example" },
      { "sec-fetch-site": "cross-site" },
    ];
    for (const headers of foreign) {
      const response = await post({ url: "https://seller.example/" }, headers);
      expect(response.status).toBe(403);
      expect((await errorOf(response)).code).toBe("playground_origin_not_allowed");
    }
    const same = await post(
      { url: "https://seller.example/" },
      { origin: "https://playground.example", "sec-fetch-site": "same-origin" },
    );
    expect(same.status).toBe(200);
  });

  it("limits checks per client and across clients", async () => {
    app = testApp(
      testConfig({
        TRUSTED_PROXY_HOPS: "1",
        SELLER_CHECK_PER_MINUTE: "1",
        SELLER_CHECK_GLOBAL_PER_MINUTE: "2",
      }),
      { sellerCheck: recordingCheck([]) },
    );
    const body = { url: "https://seller.example/" };
    expect((await post(body)).status).toBe(200);
    const own = await post(body);
    expect(own.status).toBe(429);
    expect(Number(own.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await errorOf(own)).code).toBe("playground_rate_limited");
    expect((await post(body, { "x-forwarded-for": "198.51.100.31" })).status).toBe(200);
    expect((await post(body, { "x-forwarded-for": "198.51.100.32" })).status).toBe(429);
  });

  it("is refused while switched off", async () => {
    app = testApp(testConfig({ SELLER_CHECK_ENABLED: "false" }), { sellerCheck: recordingCheck([]) });
    const response = await post({ url: "https://seller.example/" });
    expect(response.status).toBe(503);
    expect((await errorOf(response)).code).toBe("playground_feature_disabled");
  });

  it("passes the SDK's coded refusals through and hides unexpected failures behind a code", async () => {
    app = testApp(testConfig(), {
      sellerCheck: recordingCheck([], () => Promise.reject(sellerError("seller_network_unsupported"))),
    });
    const coded = await post({ url: "https://seller.example/" });
    expect(coded.status).toBe(400);
    expect((await errorOf(coded)).code).toBe("seller_network_unsupported");
    app.close();

    app = testApp(testConfig(), {
      sellerCheck: recordingCheck([], () => Promise.reject(new Error("internal-detail-canary"))),
    });
    const failed = await post({ url: "https://seller.example/path-canary?q=query-canary" });
    expect(failed.status).toBe(502);
    const text = await failed.text();
    expect(JSON.parse(text)).toMatchObject({ error: { code: "playground_upstream_unavailable" } });
    expect(text).not.toContain("internal-detail-canary");
    const logs = app.logs.text();
    expect(logs).toContain('"host":"seller.example"');
    for (const canary of ["path-canary", "query-canary"]) expect(logs).not.toContain(canary);
  });

  describe("against a real seller", () => {
    let server: Server;
    let origin: string;

    beforeAll(async () => {
      server = createServer((request, response) => {
        if (request.url?.startsWith("/forecast") === true) {
          const required = offerOf("zero", testConfig(), PAY_TO);
          response.writeHead(402, {
            "content-type": "application/json",
            "payment-required": encodePaymentRequiredHeader({
              ...required,
              resource: { ...required.resource, url: `${origin}/forecast/Ankara` },
              accepts: required.accepts.map((option) => ({ ...option, amount: "100000" })),
            }),
          });
          response.end("{}");
          return;
        }
        response.writeHead(404).end();
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    });
    afterAll(async () => {
      await new Promise((resolve) => server.close(resolve));
    });

    it("reports the seller's 402 and the catalog's validation in local mode", async () => {
      app = testApp(
        testConfig({
          PLAYGROUND_MODE: "local",
          PUBLIC_URL: "http://127.0.0.1:1",
          RPC_URL: CLOSED,
          FACILITATOR_URL: CLOSED,
        }),
        { sellerCheck: checkSellerOrigin },
      );
      const response = await post({ url: `${origin}/forecast/Ankara` });
      expect(response.status).toBe(200);
      const report = (await response.json()) as OriginReport;
      expect(report).toMatchObject({ url: `${origin}/forecast/Ankara`, type: "http", status: 402 });
      expect(report.paymentRequired?.accepts[0]).toMatchObject({ payTo: PAY_TO, amount: "100000" });
      expect(report.validation).toBeDefined();
      expect(report.findings.map((finding) => finding.code)).toContain("seller_facilitator_unsupported");
      expect(report.domain).toMatchObject({ claimsOwner: false });
    });

    it("refuses the same loopback seller in hosted mode before contacting it", async () => {
      app = testApp(testConfig({ RPC_URL: CLOSED, FACILITATOR_URL: CLOSED }), {
        sellerCheck: checkSellerOrigin,
      });
      const response = await post({ url: `${origin}/forecast/Ankara` });
      const report = (await response.json()) as OriginReport;
      expect(report.ok).toBe(false);
      expect(report.findings).toEqual([
        expect.objectContaining({
          code: "seller_origin_unreachable",
          details: { cause: "egress_scheme_not_allowed" },
        }),
      ]);
    });
  });
});
