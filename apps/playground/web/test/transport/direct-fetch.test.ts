import { describe, expect, it } from "vitest";
import { finalRequestOf, isEgressError, resolvePolicy } from "@rail402.dev/safe-fetch/shared";
import { createDirectFetch, isLabUrl } from "../../src/transport/direct-fetch.ts";
import { createOperatorFetch, OPERATOR_PREFIXES } from "../../src/transport/operator-fetch.ts";

const ORIGIN = "https://playground.example";
const policy = resolvePolicy({ limits: { responseBodyBytes: 8 } });

function direct(answer: (url: string, init: RequestInit) => Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return answer(url, init);
  }) as typeof globalThis.fetch;
  return { calls, fetch: createDirectFetch({ origin: ORIGIN, policy, fetch }) };
}

describe("direct transport for lab sellers", () => {
  it("knows lab URLs on the page's own origin only", () => {
    expect(isLabUrl(`${ORIGIN}/lab/greedy/history`, ORIGIN)).toBe(true);
    expect(isLabUrl(`${ORIGIN}/api/relay`, ORIGIN)).toBe(false);
    expect(isLabUrl("https://other.example/lab/x", ORIGIN)).toBe(false);
    expect(isLabUrl("not a url", ORIGIN)).toBe(false);
  });

  it("calls a lab seller without redirects and records the final request", async () => {
    const { fetch, calls } = direct(() =>
      Promise.resolve(new Response("tiny", { status: 402, headers: { "payment-required": "x" } })),
    );
    const response = await fetch(`${ORIGIN}/lab/offers/zero`, { method: "get" });
    expect(response.status).toBe(402);
    expect(response.headers.get("payment-required")).toBe("x");
    expect(response.url).toBe(`${ORIGIN}/lab/offers/zero`);
    expect(finalRequestOf(response)).toEqual({ method: "GET", bodyDropped: false });
    expect(calls[0]?.init.redirect).toBe("error");
    expect(await response.text()).toBe("tiny");
  });

  it("refuses any URL that is not a lab seller", async () => {
    const { fetch, calls } = direct(() => Promise.resolve(new Response("x")));
    await expect(fetch("https://seller.example/lab/x")).rejects.toMatchObject({
      code: "egress_destination_not_allowed",
      stage: "url",
    });
    expect(calls).toHaveLength(0);
  });

  it("cuts a body past the response limit", async () => {
    const { fetch } = direct(() => Promise.resolve(new Response("0123456789")));
    const response = await fetch(`${ORIGIN}/lab/sell/forecast/Ankara`);
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    let error: unknown;
    try {
      for (;;) if ((await reader.read()).done) break;
    } catch (reason) {
      error = reason;
    }
    expect(isEgressError(error) ? error.code : error).toBe("egress_response_too_large");
  });

  it("maps a failed connection to the stage the payment state needs", async () => {
    const { fetch } = direct(() => Promise.reject(new TypeError("redirect")));
    await expect(fetch(`${ORIGIN}/lab/x`)).rejects.toMatchObject({
      code: "egress_connection_failed",
      stage: "connect",
    });
    await expect(fetch(`${ORIGIN}/lab/x`, { headers: { "payment-signature": "S" } })).rejects.toMatchObject({
      stage: "response",
    });
  });
});

describe("operator fetch", () => {
  it("reaches only the Bazaar and facilitator proxies of the page's origin", async () => {
    const seen: string[] = [];
    const fetch = createOperatorFetch({
      origin: ORIGIN,
      fetch: ((url: string) => {
        seen.push(url);
        return Promise.resolve(new Response("{}"));
      }) as typeof globalThis.fetch,
    });
    expect(OPERATOR_PREFIXES).toEqual(["/api/bazaar/", "/api/facilitator/"]);
    await fetch(`${ORIGIN}/api/bazaar/discovery/search?query=x`);
    await fetch(`${ORIGIN}/api/facilitator/supported`);
    await expect(fetch(`${ORIGIN}/api/relay`)).rejects.toThrow(TypeError);
    await expect(fetch("https://seller.example/api/bazaar/x")).rejects.toThrow(TypeError);
    expect(seen).toEqual([
      `${ORIGIN}/api/bazaar/discovery/search?query=x`,
      `${ORIGIN}/api/facilitator/supported`,
    ]);
  });
});
