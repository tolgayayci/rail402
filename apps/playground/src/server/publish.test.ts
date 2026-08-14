import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { X402Error } from "@rail402/errors";
import { loadConfig, type PlaygroundConfig } from "./config.js";
import { buildSnippet, checkEndpoint } from "./publish.js";

const SECRET = Keypair.random().secret();
const config = (): PlaygroundConfig => loadConfig({ PLAYGROUND_DISPENSER_SECRET: SECRET } as NodeJS.ProcessEnv);

describe("buildSnippet", () => {
  it("generates runnable hono seller code with the facilitator, price, and discovery metadata", () => {
    const s = buildSnippet(config(), {
      framework: "hono",
      path: "/weather",
      priceDecimal: "0.05",
      description: "Current weather by city.",
    });
    expect(s.framework).toBe("hono");
    expect(s.priceStroops).toBe("500000");
    expect(s.code).toContain('paymentMiddleware');
    expect(s.code).toContain('"GET /weather"');
    expect(s.code).toContain('"500000"'); // price in stroops
    expect(s.code).toContain("describeEndpoint"); // discovery metadata
    expect(s.code).toContain("Current weather by city.");
    expect(s.env).toContain(config().usdc.sac); // real testnet USDC SAC
    expect(s.env).toContain(config().facilitatorUrl);
  });

  it("generates express code when asked", () => {
    const s = buildSnippet(config(), { framework: "express", path: "/x", priceDecimal: "0.01", description: "" });
    expect(s.code).toContain("express");
    expect(s.code).toContain("@x402/express");
  });

  it("normalizes a path without a leading slash and rejects a bad one", () => {
    expect(buildSnippet(config(), { framework: "hono", path: "premium", priceDecimal: "0.01", description: "" }).code).toContain('"GET /premium"');
    expect(() => buildSnippet(config(), { framework: "hono", path: "/bad path!", priceDecimal: "0.01", description: "" })).toThrow(X402Error);
  });

  it("rejects a non-positive or malformed price with a coded error", () => {
    expect(() => buildSnippet(config(), { framework: "hono", path: "/x", priceDecimal: "0", description: "" })).toThrow(X402Error);
    expect(() => buildSnippet(config(), { framework: "hono", path: "/x", priceDecimal: "abc", description: "" })).toThrow(X402Error);
  });
});

describe("checkEndpoint", () => {
  const fetchReturning = (status: number, body: unknown): typeof fetch =>
    (async () => new Response(status === 402 ? JSON.stringify(body) : "nope", { status })) as typeof fetch;

  it("accepts a well-formed Stellar exact 402 with discovery metadata", async () => {
    const result = await checkEndpoint(
      "https://seller.example/premium",
      fetchReturning(402, {
        accepts: [{ scheme: "exact", network: "stellar:testnet", amount: "500000" }],
        extensions: { bazaar: {} },
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.is402).toBe(true);
    expect(result.hasStellarExact).toBe(true);
    expect(result.hasDiscovery).toBe(true);
    expect(result.priceDecimal).toBe("0.05");
  });

  it("flags a valid payment endpoint that lacks discovery metadata", async () => {
    const result = await checkEndpoint(
      "https://seller.example/premium",
      fetchReturning(402, { accepts: [{ scheme: "exact", network: "stellar:testnet", amount: "500000" }] }),
    );
    expect(result.ok).toBe(true);
    expect(result.hasDiscovery).toBe(false);
    expect(result.reason).toContain("describeEndpoint");
  });

  it("rejects a non-402 response", async () => {
    const result = await checkEndpoint("https://seller.example/x", fetchReturning(200, {}));
    expect(result.ok).toBe(false);
    expect(result.is402).toBe(false);
    expect(result.reason).toContain("402");
  });

  it("rejects a 402 that offers no Stellar exact option", async () => {
    const result = await checkEndpoint(
      "https://seller.example/x",
      fetchReturning(402, { accepts: [{ scheme: "exact", network: "eip155:8453", amount: "1" }] }),
    );
    expect(result.ok).toBe(false);
    expect(result.hasStellarExact).toBe(false);
  });

  it("reports an unreachable endpoint without throwing", async () => {
    const result = await checkEndpoint("https://nope.example", (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("Could not reach");
  });

  it("throws a coded error for a non-http URL", async () => {
    await expect(checkEndpoint("ftp://x.example")).rejects.toBeInstanceOf(X402Error);
  });
});
