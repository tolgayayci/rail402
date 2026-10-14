import { describe, expect, it } from "vitest";
import {
  EgressError,
  finalRequestOf,
  markFinalRequest,
  resolvePolicy,
  type SafeFetch,
  type SafeRequestInit,
} from "@rail402.dev/safe-fetch/shared";
import { encodeTrace } from "../../../src/shared/trace.ts";
import type { LabEventBody } from "../../src/engine/events.ts";
import { Observer } from "../../src/transport/observe.ts";
import { relayRefusal } from "../../src/transport/relay-fetch.ts";
import { USDC_CONTRACT, exactRequired, header } from "../engine/helpers.ts";

type Answer = (url: string, init: SafeRequestInit) => Response | Promise<Response>;

function seller(answer: Answer): SafeFetch & { calls: { url: string; init: SafeRequestInit }[] } {
  const calls: { url: string; init: SafeRequestInit }[] = [];
  const fetch = async (input: string | URL, init: SafeRequestInit = {}) => {
    const url = typeof input === "string" ? input : input.href;
    calls.push({ url, init });
    const response = await answer(url, init);
    markFinalRequest(response, { method: init.method ?? "GET", bodyDropped: false });
    return response;
  };
  return Object.assign(fetch, { policy: resolvePolicy(), close: () => undefined, calls });
}

function observer() {
  const events: LabEventBody[] = [];
  const observing = new Observer({
    assetFacts: (contract) => (contract === USDC_CONTRACT ? { symbol: "USDC", decimals: 7 } : undefined),
    now: (() => {
      let tick = 0;
      return () => (tick += 5);
    })(),
  });
  observing.attach({
    emit: (event) => events.push(event),
    judge: () => [{ acceptable: false, code: "payment_per_call_cap_exceeded", reason: "too much" }],
    advertised: () => true,
  });
  return { observing, events };
}

/** Lets the observer's background body reads finish. */
const settle = () => new Promise((done) => setTimeout(done, 0));

describe("observer", () => {
  it("reports a 402 with decoded requirements and no header values", async () => {
    const { observing, events } = observer();
    const trace = encodeTrace({ v: 1, verify: { isValid: false, code: "invalid_payload", ms: 3 } });
    const fetch = observing.wrap(
      seller(
        () =>
          new Response("{}", {
            status: 402,
            headers: {
              "payment-required": header(exactRequired({ bazaar: true })),
              "rail402-trace": trace,
              "server-timing": "x402-verify;dur=3",
            },
          }),
      ),
      "direct",
    );
    const response = await fetch("https://playground.example/lab/sell/forecast/Ankara", {
      headers: { Accept: "application/json", "X-Request-Id": "abc" },
    });
    expect(response.status).toBe(402);
    expect(finalRequestOf(response)).toBeDefined();
    const [request, answer] = events;
    expect(request).toEqual({
      kind: "http",
      phase: "request",
      id: "direct-1",
      via: "direct",
      method: "GET",
      url: "https://playground.example/lab/sell/forecast/Ankara",
      paid: false,
      headerNames: ["accept", "x-request-id"],
      bodyBytes: 0,
    });
    expect(answer).toMatchObject({ kind: "http", phase: "response", id: "direct-1", status: 402, ms: 5 });
    if (answer?.kind !== "http" || answer.phase !== "response") throw new Error("no response event");
    expect(answer.required?.options[0]).toMatchObject({
      scheme: "exact",
      amount: "10000",
      decimal: "0.001",
      symbol: "USDC",
      feesSponsored: true,
      verdict: { acceptable: false, code: "payment_per_call_cap_exceeded" },
    });
    expect(answer.required?.bazaar).toEqual({ declared: true, type: "http", method: "GET", toolName: null });
    expect(answer.trace?.verify?.code).toBe("invalid_payload");
    expect(answer.timing).toEqual({ "x402-verify": 3 });
    expect(JSON.stringify(events)).not.toContain("abc");
  });

  it("marks a paid request and decodes the settlement, never recording the payment header", async () => {
    const { observing, events } = observer();
    const settlement = { success: true, transaction: "a".repeat(64), network: "stellar:testnet", payer: "x" };
    const fetch = observing.wrap(
      seller(() => new Response("ok", { headers: { "payment-response": header(settlement) } })),
      "relay",
    );
    await fetch("https://seller.example/weather", { headers: { "payment-signature": "SECRET-PAYMENT" } });
    expect(events[0]).toMatchObject({ paid: true, headerNames: ["payment-signature"] });
    expect(events[1]).toMatchObject({ settle: { success: true, transaction: "a".repeat(64), payer: null } });
    expect(JSON.stringify(events)).not.toContain("SECRET-PAYMENT");
  });

  it("reports a failure with the relay's code and the stage", async () => {
    const { observing, events } = observer();
    const fetch = observing.wrap(
      seller(() => {
        throw relayRefusal("playground_rate_limited", "slow down");
      }),
      "relay",
    );
    await expect(fetch("https://seller.example/")).rejects.toBeInstanceOf(EgressError);
    expect(events[1]).toEqual({
      kind: "http",
      phase: "failed",
      id: "relay-1",
      code: "playground_rate_limited",
      reason: "slow down",
      stage: "connect",
    });
  });

  it("reads an MCP answer from a server-sent event stream and leaves the stream to the client", async () => {
    const { observing, events } = observer();
    const required = exactRequired();
    const sse = [
      `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress" })}\n\n`,
      `event: message\ndata: ${JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        error: { code: -32042, message: "Payment required", data: required },
      })}\n\n`,
    ].join("");
    const fetch = observing.wrap(
      seller(() => new Response(sse, { headers: { "content-type": "text/event-stream" } })),
      "relay",
    );
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "hourly_forecast",
        arguments: { city: "Izmir" },
        _meta: { "x402/payment": { secret: 1 } },
      },
    });
    const response = await fetch("https://seller.example/mcp", { method: "POST", body });
    expect(await response.text()).toBe(sse);
    await settle();
    expect(events[0]).toMatchObject({
      paid: true,
      rpc: { method: "tools/call", toolName: "hourly_forecast", hasPayment: true },
    });
    const answer = events[1];
    if (answer?.kind !== "http" || answer.phase !== "response") throw new Error("no response event");
    expect(answer.rpc).toMatchObject({ isError: true, errorCode: -32042, settle: null });
    expect(answer.rpc?.required?.options[0]?.amount).toBe("10000");
    expect(JSON.stringify(events)).not.toContain('"secret"');
  });

  it("decodes the settlement an MCP tool result carries", async () => {
    const { observing, events } = observer();
    const result = {
      jsonrpc: "2.0",
      id: "a",
      result: {
        content: [{ type: "text", text: "{}" }],
        _meta: { "x402/payment-response": { success: true, transaction: "b".repeat(64) } },
      },
    };
    const fetch = observing.wrap(
      seller(() => new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } })),
      "relay",
    );
    await (
      await fetch("https://seller.example/mcp", {
        method: "POST",
        body: JSON.stringify({ jsonrpc: "2.0", id: "a", method: "tools/call", params: { name: "x" } }),
      })
    ).text();
    await settle();
    expect(events[1]).toMatchObject({
      rpc: { isError: false, settle: { from: "mcp-meta", success: true, transaction: "b".repeat(64) } },
    });
  });

  it("holds the next paid request for one unchanged resend, then drops it", async () => {
    const { observing, events } = observer();
    const inner = seller(() => new Response("ok"));
    const fetch = observing.wrap(inner, "relay");
    const handle = observing.armReplay();
    await fetch("https://seller.example/free");
    expect(handle.held).toBe(false);
    await fetch("https://seller.example/weather", { headers: { "payment-signature": "P" } });
    expect(handle.held).toBe(true);
    await handle.resend();
    expect(handle.held).toBe(false);
    expect(inner.calls.map((call) => new Headers(call.init.headers).get("payment-signature"))).toEqual([
      null,
      "P",
      "P",
    ]);
    expect(events.filter((event) => event.kind === "http" && event.phase === "request")).toHaveLength(3);
    await expect(handle.resend()).rejects.toThrow();
  });

  it("drops a held request when the run ends", async () => {
    const { observing } = observer();
    const fetch = observing.wrap(
      seller(() => new Response("ok")),
      "relay",
    );
    const handle = observing.armReplay();
    await fetch("https://seller.example/weather", { headers: { "payment-signature": "P" } });
    observing.detach();
    expect(handle.held).toBe(false);
  });
});
