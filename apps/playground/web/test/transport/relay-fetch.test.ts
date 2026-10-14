import { describe, expect, it } from "vitest";
import {
  type EgressError,
  finalRequestOf,
  isEgressError,
  resolvePolicy,
} from "@rail402.dev/safe-fetch/shared";
import {
  RELAY_TIMEOUT_MAXIMA,
  encodeRelayResponseMeta,
  forwardedName,
} from "../../../src/shared/relay-protocol.ts";
import { createRelayFetch, relayCodeOf } from "../../src/transport/relay-fetch.ts";

const RELAY = "https://playground.example/api/relay";
const policy = resolvePolicy({ schemes: ["https:"], ports: [443] });

interface Sent {
  readonly url: string;
  readonly init: RequestInit;
  readonly headers: Headers;
}

function relay(answer: (sent: Sent) => Response | Promise<Response>, options: { checkPorts?: boolean } = {}) {
  const sent: Sent[] = [];
  const fetch = ((url: string, init: RequestInit) => {
    const entry = { url, init, headers: new Headers(init.headers) };
    sent.push(entry);
    return Promise.resolve(answer(entry));
  }) as typeof globalThis.fetch;
  return { sent, fetch: createRelayFetch({ relayUrl: RELAY, policy, fetch, ...options }) };
}

function upstream(
  meta: Partial<Parameters<typeof encodeRelayResponseMeta>[0]> = {},
  body: BodyInit | null = "ok",
) {
  return new Response(body, {
    status: 200,
    headers: encodeRelayResponseMeta({
      status: 402,
      statusText: "Payment Required",
      url: "https://seller.example/weather",
      method: "GET",
      redirected: false,
      bodyDropped: false,
      ttfbMs: 12,
      headers: { "payment-required": "abc", "content-type": "application/json" },
      ...meta,
    }),
  });
}

function relayError(status: number, error: Record<string, unknown>) {
  return new Response(JSON.stringify({ error }), { status, headers: { "x-relay": "error" } });
}

async function rejection(promise: Promise<unknown>): Promise<EgressError> {
  try {
    await promise;
  } catch (error) {
    if (isEgressError(error)) return error;
    throw error;
  }
  throw new Error("expected a rejection");
}

describe("relay transport", () => {
  it("returns the seller's answer as a native response with its final request", async () => {
    const { fetch } = relay(() =>
      upstream({ url: "https://seller.example/final", method: "GET", redirected: true, bodyDropped: true }),
    );
    const response = await fetch("https://seller.example/weather", { method: "POST", body: "x" });
    expect(response.status).toBe(402);
    expect(response.statusText).toBe("Payment Required");
    expect(response.headers.get("payment-required")).toBe("abc");
    expect(response.headers.get("x-relay")).toBeNull();
    expect(response.url).toBe("https://seller.example/final");
    expect(response.redirected).toBe(true);
    expect(finalRequestOf(response)).toEqual({ method: "GET", bodyDropped: true });
    expect(await response.text()).toBe("ok");
    expect(fetch.policy).toBe(policy);
  });

  it("describes the seller request in relay headers and forwards the raw body", async () => {
    const { fetch, sent } = relay(() => upstream());
    await fetch("https://seller.example/weather?city=Ankara", {
      method: "post",
      headers: { Accept: "application/json", "payment-signature": "SIG" },
      body: new Uint8Array([1, 2, 3]),
      redirect: "same-origin",
      timeouts: { headersMs: 500_000, totalMs: 1_000 },
    });
    const [request] = sent;
    expect(request?.url).toBe(RELAY);
    expect(request?.init.method).toBe("POST");
    expect(request?.init.credentials).toBe("same-origin");
    expect(request?.headers.get("x-relay-target")).toBe("https://seller.example/weather?city=Ankara");
    expect(request?.headers.get("x-relay-method")).toBe("POST");
    // A paid request is never redirected.
    expect(request?.headers.get("x-relay-redirect")).toBe("error");
    expect(request?.headers.get("x-relay-timeouts")).toBe(
      `headers=${String(RELAY_TIMEOUT_MAXIMA.headersMs)},total=1000`,
    );
    expect(request?.headers.get(forwardedName("accept"))).toBe("application/json");
    expect(request?.headers.get(forwardedName("payment-signature"))).toBe("SIG");
    expect(new Uint8Array(request?.init.body as Uint8Array)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("asks for same-origin redirects only on unpaid requests that want them", async () => {
    const { fetch, sent } = relay(() => upstream());
    await fetch("https://seller.example/a", { redirect: "same-origin" });
    await fetch("https://seller.example/b");
    expect(sent.map((request) => request.headers.get("x-relay-redirect"))).toEqual(["same-origin", "error"]);
  });

  it("refuses what the relay would refuse before sending anything", async () => {
    const { fetch, sent } = relay(() => upstream());
    const header = await rejection(fetch("https://seller.example/", { headers: { cookie: "a=b" } }));
    expect(header.code).toBe("egress_connection_failed");
    expect(header.stage).toBe("connect");
    expect(relayCodeOf(header)).toBe("playground_relay_header_not_allowed");
    const method = await rejection(fetch("https://seller.example/", { method: "TRACE" }));
    expect(relayCodeOf(method)).toBe("playground_relay_method_not_allowed");
    expect((await rejection(fetch("http://seller.example/"))).code).toBe("egress_scheme_not_allowed");
    expect((await rejection(fetch("https://seller.example:8443/"))).code).toBe("egress_port_not_allowed");
    expect((await rejection(fetch("https://u:p@seller.example/"))).code).toBe("egress_url_invalid");
    expect((await rejection(fetch("not a url"))).code).toBe("egress_url_invalid");
    const large = await rejection(
      fetch("https://seller.example/", { method: "POST", body: "x".repeat(70_000) }),
    );
    expect(large.code).toBe("egress_request_too_large");
    expect(large.stage).toBe("request");
    expect(sent).toHaveLength(0);
  });

  it("leaves port checks to the relay in local mode", async () => {
    const { fetch } = relay(() => upstream(), { checkPorts: false });
    expect((await fetch("https://127.0.0.1:4021/weather")).status).toBe(402);
  });

  it("maps the relay's egress refusals to the same error at the same stage", async () => {
    const { fetch } = relay(() =>
      relayError(403, {
        code: "egress_destination_not_allowed",
        reason: "private",
        retryable: false,
        details: { stage: "dns" },
      }),
    );
    const error = await rejection(fetch("https://seller.example/"));
    expect(error.code).toBe("egress_destination_not_allowed");
    expect(error.stage).toBe("dns");
    expect(error.reason).toBe("private");
  });

  it("reads the relay's own refusals as not delivered, with its code", async () => {
    const { fetch } = relay(() =>
      relayError(429, { code: "playground_rate_limited", reason: "slow down", retryable: true }),
    );
    const error = await rejection(
      fetch("https://seller.example/", { headers: { "payment-signature": "S" } }),
    );
    expect(error.code).toBe("egress_connection_failed");
    expect(error.stage).toBe("connect");
    expect(relayCodeOf(error)).toBe("playground_rate_limited");
    expect(error.reason).toBe("slow down");
  });

  it("treats a lost relay as not delivered, unless the request was paid", async () => {
    const failing = createRelayFetch({
      relayUrl: RELAY,
      policy,
      fetch: () => Promise.reject(new TypeError("network")),
    });
    expect((await rejection(failing("https://seller.example/"))).stage).toBe("connect");
    const paid = await rejection(
      failing("https://seller.example/", { headers: { "payment-signature": "S" } }),
    );
    expect(paid.code).toBe("egress_connection_failed");
    expect(paid.stage).toBe("response");
  });

  it("treats an MCP tool call carrying its payment in the body as paid", async () => {
    const failing = createRelayFetch({
      relayUrl: RELAY,
      policy,
      fetch: () => Promise.reject(new TypeError("network")),
    });
    const call = (meta: Record<string, unknown>) =>
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "hourly_forecast", arguments: {}, _meta: meta },
      });
    const init = (body: string) => ({
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const paid = await rejection(failing("https://seller.example/mcp", init(call({ "x402/payment": {} }))));
    expect(paid.stage).toBe("response");
    const unpaid = await rejection(failing("https://seller.example/mcp", init(call({}))));
    expect(unpaid.stage).toBe("connect");
    // A reply that is not the relay's (an edge error page during a restart) is unknown too.
    const { fetch } = relay(() => new Response("<html>", { status: 502 }));
    const foreign = await rejection(fetch("https://seller.example/mcp", init(call({ "x402/payment": {} }))));
    expect(foreign.stage).toBe("response");
    // A paid tool call is never redirected.
    const { sent, fetch: recording } = relay(() => upstream());
    await recording("https://seller.example/mcp", {
      ...init(call({ "x402/payment": {} })),
      redirect: "same-origin",
    });
    expect(sent[0]?.headers.get("x-relay-redirect")).toBe("error");
  });

  it("refuses an answer that is not a relay reply", async () => {
    const { fetch } = relay(() => new Response("<html>", { status: 502 }));
    const error = await rejection(
      fetch("https://seller.example/", { headers: { "payment-signature": "S" } }),
    );
    expect(error.code).toBe("egress_connection_failed");
    expect(error.stage).toBe("response");
  });

  it("passes the caller's abort through", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("stop", "AbortError"));
    const { fetch } = relay(() => upstream());
    await expect(fetch("https://seller.example/", { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("gives a bodiless status no body", async () => {
    const { fetch } = relay(() => upstream({ status: 204, statusText: "No Content" }, null));
    const response = await fetch("https://seller.example/");
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });
});
