import { describe, it, expect, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import type * as BazaarModule from "@rail402/bazaar";

/**
 * Regression guard for the highest-severity live-audit finding: a throw from the cataloging
 * side-effect, which runs AFTER a settlement has already moved money, must never be caught by the
 * handler's outer catch and returned as a retryable 500 — that would tell the buyer their completed
 * payment failed and invite a double-payment. The settlement stands regardless.
 *
 * This needs no network: `buildFacilitator` is mocked to a facilitator whose `settle` returns
 * success, and `catalogSettledPayment` is mocked to throw. If the isolation regresses, `/settle`
 * returns a 500 instead of the successful response, and this fails.
 */

const SETTLED_TX = "abc123def456";

vi.mock("./facilitator/build.js", () => ({
  buildFacilitator: () => ({
    facilitator: {
      verify: async () => ({ isValid: true, payer: "GPAYER" }),
      settle: async () => ({
        success: true,
        transaction: SETTLED_TX,
        network: "stellar:testnet",
        payer: "GPAYER",
      }),
      getSupported: () => ({ kinds: [], extensions: [], signers: {} }),
    },
    signerAddresses: ["GBHJJL6UGTEF2KF5AUDXI6E635FMWPE4WZAHIY47WGSNCRFDVJZPO7E4"],
    feeBumpAddress: undefined,
  }),
}));

vi.mock("@rail402/bazaar", async importOriginal => {
  const actual = await importOriginal<typeof BazaarModule>();
  return {
    ...actual,
    // The exact failure B1 guards against: the ingest path throws after settlement.
    catalogSettledPayment: () => {
      throw new Error("simulated cataloging failure");
    },
  };
});

// Imported AFTER the mocks so app.ts resolves the mocked buildFacilitator/catalogSettledPayment.
const { createApp } = await import("./app.js");
const { loadConfig } = await import("./config/env.js");

const app = createApp({
  config: loadConfig({ FACILITATOR_STELLAR_SECRET: Keypair.random().secret() } as NodeJS.ProcessEnv),
  startedAt: 0,
}).app;

const settleBody = {
  paymentPayload: { x402Version: 2, accepted: { scheme: "exact", network: "stellar:testnet" } },
  paymentRequirements: {
    scheme: "exact",
    network: "stellar:testnet",
    amount: "1000000",
    asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    payTo: "GBHJJL6UGTEF2KF5AUDXI6E635FMWPE4WZAHIY47WGSNCRFDVJZPO7E4",
  },
};

describe("settle isolates cataloging side-effects (B1)", () => {
  it("returns the successful settlement even when cataloging throws", async () => {
    const res = await app.request("/settle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settleBody),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success?: boolean; transaction?: string };
    expect(body.success).toBe(true);
    expect(body.transaction).toBe(SETTLED_TX);
    // The catalog threw, so no listing verdict header — but the payment is not affected.
    expect(res.headers.get("EXTENSION-RESPONSES")).toBeNull();
  });
});
