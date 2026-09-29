import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import type { FacilitatorClient } from "@x402/core/server";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { accountsOf } from "@rail402.dev/bazaar";
import { createSeller, NETWORK } from "@rail402.dev/demo-seller";

/** A facilitator that supports Stellar testnet `exact` and never settles: only unpaid requests are made. */
const facilitator: FacilitatorClient = {
  getSupported: () =>
    Promise.resolve({
      kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK, extra: { areFeesSponsored: true } }],
      extensions: ["bazaar"],
      signers: {},
    }),
  verify: () => Promise.reject(new Error("not used")),
  settle: () => Promise.reject(new Error("not used")),
};

describe("demo seller", () => {
  const payTo = Keypair.random().publicKey();
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createSeller({ payTo, facilitator }).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const required = async (path: string, init?: RequestInit) => {
    const response = await fetch(`${base}${path}`, init);
    expect(response.status, path).toBe(402);
    return decodePaymentRequiredHeader(response.headers.get("payment-required") ?? "");
  };

  it("charges for each paid route in testnet USDC to its payTo, with Bazaar metadata", async () => {
    for (const [path, init, method] of [
      ["/weather?city=Ankara", undefined, "GET"],
      ["/users/42", undefined, "GET"],
      ["/translate", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, "POST"],
    ] as const) {
      const paymentRequired = await required(path, init);
      expect(paymentRequired.accepts).toEqual([
        expect.objectContaining({ scheme: "exact", network: NETWORK, payTo }),
      ]);
      const bazaar = paymentRequired.extensions?.["bazaar"] as { info: { input: Record<string, unknown> } };
      expect(bazaar.info.input, path).toMatchObject({ type: "http", method });
    }
  });

  it("declares an optional payment identifier on the POST route only", async () => {
    const post = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };
    expect((await required("/translate", post)).extensions?.["payment-identifier"]).toMatchObject({
      info: { required: false },
    });
    expect((await required("/weather")).extensions?.["payment-identifier"]).toBeUndefined();
  });

  it("declares the route template of a path with parameters", async () => {
    const paymentRequired = await required("/users/42");
    expect(paymentRequired.extensions?.["bazaar"]).toMatchObject({ routeTemplate: "/users/:id" });
  });

  it("names its public https URL when a TLS proxy forwards the request", async () => {
    const proxied = createSeller({ payTo, facilitator, trustProxy: 1 }).listen(0, "127.0.0.1");
    await new Promise((resolve) => proxied.once("listening", resolve));
    try {
      const port = (proxied.address() as AddressInfo).port;
      const response = await fetch(`http://127.0.0.1:${String(port)}/weather?city=Ankara`, {
        headers: { "x-forwarded-proto": "https", "x-forwarded-host": "seller.example.com" },
      });
      const paymentRequired = decodePaymentRequiredHeader(response.headers.get("payment-required") ?? "");
      expect(paymentRequired.resource.url).toMatch(/^https:\/\//);
    } finally {
      await new Promise((resolve) => proxied.close(resolve));
    }
  });

  it("claims its payTo account in a SEP-1 stellar.toml", async () => {
    const response = await fetch(`${base}/.well-known/stellar.toml`);
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(accountsOf(await response.text())).toEqual({ ok: true, accounts: [payTo] });
  });

  it("answers its free health route without payment", async () => {
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});
