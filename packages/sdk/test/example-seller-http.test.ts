/**
 * examples/seller-http, as published: its 402 asks for USDC on the configured network, and its
 * declaration is one the Rail402 catalog lists as is.
 */
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import type { FacilitatorClient } from "@x402/core/server";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { PUBNET, TESTNET, USDC } from "@rail402.dev/stellar";
import { validateListing } from "@rail402.dev/sdk/seller";
import { createApp, quoteRoute, type Network } from "../../../examples/seller-http/src/app.ts";

function facilitatorFor(network: Network): FacilitatorClient {
  return {
    getSupported: () =>
      Promise.resolve({
        kinds: [{ x402Version: 2, scheme: "exact", network, extra: { areFeesSponsored: true } }],
        extensions: ["bazaar"],
        signers: {},
      }),
    verify: () => Promise.reject(new Error("not used")),
    settle: () => Promise.reject(new Error("not used")),
  };
}

for (const network of [TESTNET, PUBNET] as const) {
  describe(`examples/seller-http on ${network}`, () => {
    const payTo = Keypair.random().publicKey();
    let server: Server;
    let base: string;

    beforeAll(async () => {
      server = createApp({ payTo, network, price: "0.001", facilitator: facilitatorFor(network) }).listen(
        0,
        "127.0.0.1",
      );
      await new Promise((resolve) => server.once("listening", resolve));
      base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    });
    afterAll(async () => {
      await new Promise((resolve) => server.close(resolve));
    });

    it("asks for USDC on its network to its payTo, with Bazaar metadata", async () => {
      const response = await fetch(`${base}/quote?topic=craft`);
      expect(response.status).toBe(402);
      const required = decodePaymentRequiredHeader(response.headers.get("payment-required") ?? "");
      expect(required.accepts).toEqual([
        expect.objectContaining({
          scheme: "exact",
          network,
          payTo,
          asset: USDC[network].contract,
          amount: "10000",
          extra: expect.objectContaining({ areFeesSponsored: true }) as unknown,
        }),
      ]);
      expect(required.extensions?.["bazaar"]).toMatchObject({
        info: { input: { type: "http", method: "GET" } },
      });
      expect((await fetch(`${base}/health`)).status).toBe(200);
    });

    it("declares a route the catalog lists as is", async () => {
      const report = await validateListing(quoteRoute({ payTo, network, price: "0.001" }), {
        network,
        concreteUrl: "https://seller.example/quote?topic=craft",
      });
      expect(report).toMatchObject({ catalogable: true, dropped: [] });
    });
  });
}

describe("examples/seller-http paid through an idempotent facilitator", () => {
  it("serves concurrent copies of one payment once", async () => {
    // Every copy verifies before the first settles, and every settle answers the same success.
    const facilitator: FacilitatorClient = {
      ...facilitatorFor(TESTNET),
      verify: () => Promise.resolve({ isValid: true }),
      settle: (_payload, requirements) =>
        Promise.resolve({ success: true, transaction: "b".repeat(64), network: requirements.network }),
    };
    const server = createApp({
      payTo: Keypair.random().publicKey(),
      network: TESTNET,
      price: "0.001",
      facilitator,
    }).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/quote?topic=craft`;
      const required = decodePaymentRequiredHeader((await fetch(url)).headers.get("payment-required") ?? "");
      const [accepted] = required.accepts;
      if (accepted === undefined) throw new Error("no payment option");
      const header = encodePaymentSignatureHeader({
        x402Version: 2,
        resource: required.resource,
        accepted,
        payload: { transaction: "AAAA" },
      });
      const answers = await Promise.all(
        [0, 1, 2].map(() => fetch(url, { headers: { "payment-signature": header } })),
      );
      await Promise.all(answers.map((answer) => answer.text()));
      expect(answers.map((answer) => answer.status).sort()).toEqual([200, 402, 402]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("the examples", () => {
  const root = new URL("../../../", import.meta.url);
  const read = (path: string) => readFileSync(new URL(path, root), "utf8");
  const catalog = read("pnpm-workspace.yaml");

  it("install from the npm registry: exact versions, no workspace or catalog references", () => {
    for (const example of ["seller-http", "sdk-buyer", "mcp-agent"]) {
      const manifest = JSON.parse(read(`examples/${example}/package.json`)) as {
        dependencies: Record<string, string>;
      };
      for (const [name, version] of Object.entries(manifest.dependencies)) {
        expect(version, `${example}: ${name}`).toMatch(/^\d+\.\d+\.\d+$/);
        // The x402 family and the Stellar SDK stay on the versions the workspace pins.
        const pinned = new RegExp(`"${name.replace(/[/.]/g, "\\$&")}": (\\S+)`).exec(catalog)?.[1];
        if (pinned !== undefined) expect(version, `${example}: ${name}`).toBe(pinned);
      }
    }
    expect(catalog).not.toMatch(/^\s+- examples/m);
  });
});
