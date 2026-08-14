import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { x402ResourceServer } from "@x402/core/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import { buildFacilitator, createApp, loadConfig } from "./lib.js";

/**
 * Self-facilitation: a resource server embeds verify/settle in-process. This asserts the
 * library entry actually delivers that — the pieces are importable, usable, and answer requests
 * WITHOUT binding a port. Before the library entry existed, importing the package ran the server
 * bootstrap (`main()`), so the documented `import { buildFacilitator } from "@rail402/facilitator"`
 * could not be embedded at all. `app.request(...)` is Hono's in-memory dispatch — no socket, no
 * network — which is exactly the in-process shape a self-facilitating seller uses.
 */
const testConfig = () =>
  loadConfig({ FACILITATOR_STELLAR_SECRET: Keypair.random().secret() } as NodeJS.ProcessEnv);

describe("self-facilitation library entry", () => {
  it("exposes buildFacilitator for in-process verify/settle, no server", () => {
    const { facilitator, signerAddresses } = buildFacilitator(testConfig());
    expect(signerAddresses.length).toBeGreaterThan(0);
    const schemes = facilitator.getSupported().kinds.map(k => k.scheme);
    expect(schemes).toContain("exact");
    expect(schemes).toContain("upto");
  });

  it("embeds the facilitator as a FacilitatorClient in a resource server (the documented snippet)", async () => {
    // The exact self-facilitation shape operator.md documents: a seller's own x402ResourceServer
    // uses the in-process facilitator as its client, with no HTTP hop and no third party in the
    // payment path. The one adaptation the interface needs is getSupported — the embedded
    // facilitator answers synchronously, the FacilitatorClient interface is async. Passing the raw
    // facilitator (as the old doc snippet did) does NOT type-check for that reason; this adapter is
    // the fix, and if this test compiles, the documented snippet compiles.
    const { facilitator } = buildFacilitator(testConfig());
    const localFacilitator = {
      verify: facilitator.verify.bind(facilitator),
      settle: facilitator.settle.bind(facilitator),
      getSupported: async () => facilitator.getSupported(),
    };
    const server = new x402ResourceServer([localFacilitator]);
    server.register("stellar:*", new ExactStellarScheme());
    // The seller can consult its embedded facilitator with no network hop.
    const supported = await localFacilitator.getSupported();
    expect(supported.kinds.map(k => k.scheme)).toContain("exact");
    expect(server).toBeDefined();
  });

  it("exposes createApp to mount the routes in-process, answered without a port", async () => {
    const { app } = createApp({ config: testConfig(), startedAt: 0 });
    const res = await app.request("/supported");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kinds: Array<{ scheme: string; extra?: { areFeesSponsored?: boolean } }> };
    const exact = body.kinds.find(k => k.scheme === "exact");
    expect(exact).toBeDefined();
    // The Stellar extra contract is advertised in-process just as it is over HTTP.
    expect(exact!.extra?.areFeesSponsored).toBe(true);
  });

  it("a verify with a malformed payload is rejected in-process with a non-null reason", async () => {
    const { app } = createApp({ config: testConfig(), startedAt: 0 });
    const res = await app.request("/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ paymentPayload: { not: "valid" }, paymentRequirements: {} }),
    });
    const body = (await res.json()) as { code?: string; reason?: string; isValid?: boolean };
    expect(res.status).toBeGreaterThanOrEqual(400);
    // Every rejection carries a non-null, machine-readable reason.
    expect(body.code ?? "").not.toBe("");
    expect((body.reason ?? "").length).toBeGreaterThan(10);
  });
});
