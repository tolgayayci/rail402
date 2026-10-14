import { describe, expect, it } from "vitest";
import {
  RELAY_LIMITS,
  RELAY_REQUEST_HEADERS,
  RELAY_RESPONSE_HEADERS,
  encodeRelayRequest,
  encodeRelayResponseMeta,
  formatTimeouts,
  isRelayErrorBody,
  parseRelayRequest,
  parseRelayResponseMeta,
  parseTimeouts,
  relayUserAgent,
  type RelayResponseMeta,
} from "../src/shared/relay-protocol.ts";

describe("relay request", () => {
  it("round-trips a paid request", () => {
    const headers = encodeRelayRequest({
      target: "https://demo.rail402.dev/weather?city=Ankara",
      method: "GET",
      redirect: "error",
      timeouts: { headersMs: 90_000, totalMs: 150_000 },
      headers: { accept: "application/json", "payment-signature": "eyJ4" },
    });
    expect(headers).toEqual({
      "x-relay-target": "https://demo.rail402.dev/weather?city=Ankara",
      "x-relay-method": "GET",
      "x-relay-redirect": "error",
      "x-relay-timeouts": "headers=90000,total=150000",
      "x-relay-h-accept": "application/json",
      "x-relay-h-payment-signature": "eyJ4",
    });
    expect(parseRelayRequest(headers)).toEqual({
      ok: true,
      value: {
        target: "https://demo.rail402.dev/weather?city=Ankara",
        method: "GET",
        redirect: "error",
        timeouts: { headersMs: 90_000, totalMs: 150_000 },
        headers: { accept: "application/json", "payment-signature": "eyJ4" },
      },
    });
  });

  it("defaults the redirect mode, accepts a lower-case method and omits empty timeouts", () => {
    expect(parseRelayRequest({ "x-relay-target": "https://example.com/", "x-relay-method": "post" })).toEqual(
      {
        ok: true,
        value: { target: "https://example.com/", method: "POST", redirect: "error", headers: {} },
      },
    );
  });

  it("refuses a missing, relative or oversized target", () => {
    const code = (target: string | undefined) => {
      const parsed = parseRelayRequest({ "x-relay-target": target, "x-relay-method": "GET" });
      return parsed.ok ? "ok" : parsed.code;
    };
    expect(code(undefined)).toBe("playground_relay_target_invalid");
    expect(code("/weather")).toBe("playground_relay_target_invalid");
    expect(code(`https://example.com/${"a".repeat(RELAY_LIMITS.targetBytes)}`)).toBe(
      "playground_relay_target_invalid",
    );
    expect(code("https://example.com/")).toBe("ok");
  });

  it("refuses unknown methods, redirect modes and forwarded headers", () => {
    const base = { "x-relay-target": "https://example.com/", "x-relay-method": "GET" };
    const refused = (extra: Record<string, string>) => {
      const parsed = parseRelayRequest({ ...base, ...extra });
      return parsed.ok ? undefined : { code: parsed.code, reason: parsed.reason };
    };
    expect(refused({ "x-relay-method": "CONNECT" })?.code).toBe("playground_relay_method_not_allowed");
    expect(refused({ "x-relay-redirect": "follow" })?.code).toBe("playground_request_invalid");
    for (const name of ["cookie", "authorization", "x-forwarded-for", "host"]) {
      const refusal = refused({ [`x-relay-h-${name}`]: "x" });
      expect(refusal?.code, name).toBe("playground_relay_header_not_allowed");
      expect(refusal?.reason).toContain(name);
    }
    for (const name of RELAY_REQUEST_HEADERS)
      expect(refused({ [`x-relay-h-${name}`]: "x" }), name).toBeUndefined();
  });

  it("forwards the headers the MCP client sends with every request", () => {
    for (const name of ["mcp-protocol-version", "mcp-method", "mcp-name", "mcp-session-id", "accept"]) {
      expect(RELAY_REQUEST_HEADERS, name).toContain(name);
    }
  });

  it("clamps timeouts to the paid maxima and refuses malformed ones", () => {
    expect(parseTimeouts("headers=999999,idle=5000,total=999999")).toEqual({
      ok: true,
      value: { headersMs: 120_000, idleMs: 5_000, totalMs: 150_000 },
    });
    for (const bad of ["headers=0", "headers=1.5", "connect=10", "headers=1,headers=2", "headers"]) {
      expect(parseTimeouts(bad).ok, bad).toBe(false);
    }
    expect(formatTimeouts({ idleMs: 3 })).toBe("idle=3");
  });

  it("names its user agent after the public URL", () => {
    expect(relayUserAgent("0.3.0", "https://playground.rail402.dev/")).toBe(
      "rail402-playground/0.3.0 (+https://playground.rail402.dev)",
    );
  });
});

describe("relay response", () => {
  const meta: RelayResponseMeta = {
    status: 402,
    statusText: "Payment Required",
    url: "https://demo.rail402.dev/weather?city=Ankara",
    method: "GET",
    redirected: false,
    bodyDropped: false,
    ttfbMs: 41.6,
    headers: { "content-type": "application/json", "payment-required": "eyJ4", "set-cookie": "a=1" },
  };

  it("round-trips the seller's answer and drops headers off the allowlist", () => {
    const headers = new Headers(encodeRelayResponseMeta(meta));
    expect(headers.get("x-relay-h-set-cookie")).toBeNull();
    expect(parseRelayResponseMeta((name) => headers.get(name))).toEqual({
      kind: "upstream",
      meta: {
        ...meta,
        ttfbMs: 42,
        headers: { "content-type": "application/json", "payment-required": "eyJ4" },
      },
    });
    expect(RELAY_RESPONSE_HEADERS).not.toContain("location");
  });

  it("keeps status text header-safe", () => {
    const headers = encodeRelayResponseMeta({ ...meta, statusText: "Pay\r\nX-Evil: 1 ü" });
    expect(headers["x-relay-status-text"]).toBe("PayX-Evil: 1 ");
  });

  it("recognises error replies and ignores non-relay responses", () => {
    expect(parseRelayResponseMeta((name) => (name === "x-relay" ? "error" : null))).toEqual({
      kind: "error",
    });
    expect(parseRelayResponseMeta(() => null)).toBeUndefined();
    const bad = new Headers({ "x-relay": "upstream", "x-relay-status": "99", "x-relay-url": "https://a.b/" });
    expect(parseRelayResponseMeta((name) => bad.get(name))).toBeUndefined();
  });

  it("checks the error body shape", () => {
    expect(
      isRelayErrorBody({ error: { code: "playground_relay_loop", reason: "no", retryable: false } }),
    ).toBe(true);
    expect(isRelayErrorBody({ error: { code: "x", reason: "", retryable: false } })).toBe(false);
    expect(isRelayErrorBody({ code: "x" })).toBe(false);
    expect(isRelayErrorBody(null)).toBe(false);
  });
});
