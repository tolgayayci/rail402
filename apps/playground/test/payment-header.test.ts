import { describe, expect, it } from "vitest";
import { PAYMENT_HEADER_MAX_LENGTH, isPaymentHeader, mcpPaymentOf } from "../src/payment-header.ts";

const encode = (value: unknown, alphabet: "base64" | "base64url" = "base64") =>
  Buffer.from(JSON.stringify(value)).toString(alphabet);

describe("payment header", () => {
  const exact = { x402Version: 2, accepted: { scheme: "exact" }, payload: { transaction: "AAAA" } };
  const upto = { x402Version: 2, accepted: { scheme: "upto" }, payload: { authorization: "AAAA" } };

  it("accepts an x402 v2 exact or upto payload, in either base64 alphabet", () => {
    expect(isPaymentHeader(encode(exact))).toBe(true);
    expect(isPaymentHeader(encode(upto, "base64url"))).toBe(true);
  });

  it("refuses anything that is not a payment payload", () => {
    for (const value of [
      "",
      "junk",
      "e30",
      "not base64!",
      encode({ x402Version: 2 }),
      encode({ ...exact, x402Version: 1 }),
      encode({ ...exact, accepted: null }),
      encode({ ...exact, payload: { transaction: "" } }),
      encode({ ...exact, payload: { transaction: 7 } }),
      encode({ ...exact, payload: { transaction: "A".repeat(20_000) } }),
      encode([exact]),
      "A".repeat(PAYMENT_HEADER_MAX_LENGTH + 4),
    ]) {
      expect(isPaymentHeader(value)).toBe(false);
    }
  });

  it("accepts a v1 payload only where v1 is allowed", () => {
    const v1 = {
      x402Version: 1,
      scheme: "exact",
      network: "stellar-testnet",
      payload: { transaction: "AAAA" },
    };
    expect(isPaymentHeader(encode(v1))).toBe(false);
    expect(isPaymentHeader(encode(v1), [1, 2])).toBe(true);
  });

  it("finds an MCP payment in a JSON-RPC body", () => {
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
    const call = (meta: Record<string, unknown> | undefined) => ({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "hourly_forecast", ...(meta === undefined ? {} : { _meta: meta }) },
    });
    expect(mcpPaymentOf(undefined)).toBe("none");
    expect(mcpPaymentOf(new TextEncoder().encode("not json"))).toBe("none");
    expect(mcpPaymentOf(bytes(call(undefined)))).toBe("none");
    expect(mcpPaymentOf(bytes({ ...call({ "x402/payment": exact }), jsonrpc: "1.0" }))).toBe("none");
    expect(mcpPaymentOf(bytes(call({ "x402/payment": exact })))).toBe("payment");
    expect(mcpPaymentOf(bytes([call(undefined), call({ "x402/payment": upto })]))).toBe("payment");
    expect(mcpPaymentOf(bytes(call({ "x402/payment": "junk" })))).toBe("invalid");
    expect(mcpPaymentOf(bytes(call({ "x402/payment": { x402Version: 2 } })))).toBe("invalid");
  });
});
