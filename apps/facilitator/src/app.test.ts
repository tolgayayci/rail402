import { describe, it, expect, beforeAll } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { createApp } from "./app.js";
import { loadConfig, type FacilitatorConfig } from "./config/env.js";
import { previewCataloging } from "@rail402/bazaar";

/**
 * HTTP-surface tests. These never touch the network: every assertion here is about wire shape,
 * error legibility, and access control — the things reviewers point stock clients at.
 */

const SECRET = Keypair.random().secret();
const SECRET_2 = Keypair.random().secret();

const baseEnv = {
  FACILITATOR_STELLAR_SECRET: SECRET,
  STELLAR_NETWORKS: "stellar:testnet",
} as unknown as NodeJS.ProcessEnv;

const build = (env: Partial<Record<string, string>> = {}) => {
  const config: FacilitatorConfig = loadConfig({ ...baseEnv, ...env } as NodeJS.ProcessEnv);
  return createApp({ config, startedAt: Date.now() });
};

let app: ReturnType<typeof build>["app"];
beforeAll(() => {
  app = build().app;
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("GET /supported", () => {
  it("returns the spec's kinds / extensions / signers envelope", async () => {
    const res = await app.request("/supported");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Object.keys(body).sort()).toEqual(["extensions", "kinds", "signers"]);
  });

  it("advertises exact on stellar:testnet with a truthful areFeesSponsored", async () => {
    // This is the shape the conformance baseline emits, verified against the live x402.org facilitator.
    const body = (await (await app.request("/supported")).json()) as any;
    const kind = body.kinds.find(
      (k: any) => k.network === "stellar:testnet" && k.scheme === "exact",
    );
    expect(kind).toBeDefined();
    expect(kind.x402Version).toBe(2);
    expect(kind.extra).toMatchObject({ areFeesSponsored: true });
  });

  it("keys signers by the CAIP-2 family pattern, not the concrete network", async () => {
    const body = (await (await app.request("/supported")).json()) as any;
    expect(body.signers).toHaveProperty("stellar:*");
    expect(Array.isArray(body.signers["stellar:*"])).toBe(true);
    expect(body.signers["stellar:*"][0]).toMatch(/^G[A-Z2-7]{55}$/);
  });

  it("lists every configured signer, so channel accounts are discoverable", async () => {
    const multi = build({ FACILITATOR_STELLAR_CHANNEL_SECRETS: SECRET_2 });
    const body = (await (await multi.app.request("/supported")).json()) as any;
    expect(body.signers["stellar:*"]).toHaveLength(2);
  });

  it("includes stellar:pubnet when configured", async () => {
    const both = build({
      STELLAR_NETWORKS: "stellar:testnet,stellar:pubnet",
      STELLAR_PUBNET_RPC_URL: "https://mainnet.sorobanrpc.com",
    });
    const body = (await (await both.app.request("/supported")).json()) as any;
    const networks = body.kinds.map((k: any) => k.network);
    expect(networks).toContain("stellar:testnet");
    expect(networks).toContain("stellar:pubnet");
  });
});

describe("every rejection carries a code and a non-null reason", () => {
  // The hard acceptance criterion. Asserted at the HTTP boundary, not just in the
  // registry, because that is where a reviewer's stock client actually observes it.
  const expectCoded = async (res: Response) => {
    const body = (await res.json()) as any;
    expect(body.code, "missing machine-readable code").toBeTruthy();
    expect(body.reason, "missing human-readable reason").toBeTruthy();
    expect(String(body.reason).trim().length).toBeGreaterThan(10);
    expect(typeof body.retryable).toBe("boolean");
    return body;
  };

  it("rejects malformed JSON with a coded reason", async () => {
    const res = await post("/verify", "{not json");
    expect(res.status).toBe(400);
    const body = await expectCoded(res);
    expect(body.code).toBe("invalid_payload");
    expect(body.reason).toMatch(/JSON/i);
  });

  it("rejects a body missing paymentPayload/paymentRequirements", async () => {
    const res = await post("/verify", { nope: true });
    expect(res.status).toBe(400);
    const body = await expectCoded(res);
    expect(body.code).toBe("invalid_payload");
    expect(body.details.fields).toEqual(
      expect.arrayContaining(["paymentPayload", "paymentRequirements"]),
    );
  });

  it("rejects settle with the same discipline as verify", async () => {
    const res = await post("/settle", { paymentPayload: {} });
    expect(res.status).toBe(400);
    await expectCoded(res);
  });

  it("returns a coded reason for an unknown route rather than a bare 404", async () => {
    const res = await app.request("/nope");
    expect(res.status).toBe(404);
    const body = await expectCoded(res);
    expect(body.reason).toMatch(/\/verify/);
  });

  it("names the offending fields so a caller can fix the request", async () => {
    const body = (await (await post("/verify", {})).json()) as any;
    expect(body.reason).toMatch(/paymentPayload/);
    expect(body.reason).toMatch(/paymentRequirements/);
  });

  it("rejects a non-integer requirements.amount as non-retryable, not a retry loop", async () => {
    // A decimal amount can never settle: BigInt("10.5") throws deep in the scheme and surfaces as a
    // RETRYABLE unexpected error, so an agent loops on a seller misconfiguration. Caught here as a
    // non-retryable requirements error. (O5)
    const res = await post("/verify", {
      paymentPayload: { x402Version: 2, accepted: { scheme: "exact", network: "stellar:testnet" } },
      paymentRequirements: {
        scheme: "exact",
        network: "stellar:testnet",
        amount: "10.5",
        asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        payTo: "GBHJJL6UGTEF2KF5AUDXI6E635FMWPE4WZAHIY47WGSNCRFDVJZPO7E4",
      },
    });
    const body = (await res.json()) as any;
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(body.code).toBe("invalid_payment_requirements");
    expect(body.retryable).toBe(false);
    expect(body.reason).toMatch(/integer/i);
  });
});

describe("caller authentication", () => {
  it("is open by default, so testnet is free and frictionless", async () => {
    // Testnet must be usable without friction. A fresh deployment requires no key.
    const res = await post("/verify", { paymentPayload: {}, paymentRequirements: {} });
    expect(res.status).not.toBe(401);
  });

  it("rejects an unauthenticated call with a coded reason when keys are configured", async () => {
    const secured = build({
      FACILITATOR_API_KEYS: "topsecret",
      AUTH_EXEMPT_NETWORKS: "",
    });
    const res = await secured.app.request("/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentPayload: {}, paymentRequirements: { network: "eip155:8453" } }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.reason).toMatch(/Bearer/);

    /**
     * The code and its retryability, not just the status.
     *
     * This previously returned `unexpected_verify_error`, which is marked RETRYABLE — so an agent
     * without an API key would retry forever a request that cannot succeed. The test passed anyway,
     * because it only checked the status and the prose. It took running the rejection audit against
     * a *deployed* facilitator with auth enabled to surface it, since no local run had that config.
     *
     * `app.ts` warns in its own comments that misreporting retryability "turns one bad request into
     * a retry loop". That is exactly what this was.
     */
    expect(body.code).toBe("facilitator_authentication_required");
    expect(body.retryable, "retrying without a key can never succeed").toBe(false);
  });

  it("reports rate limiting as its own retryable code, distinct from an auth failure", async () => {
    // The two are opposite advice: waiting fixes one and never fixes the other. Collapsing both
    // into `unexpected_verify_error` told an agent nothing it could act on.
    const limited = build({ RATE_LIMIT_ENABLED: "true", RATE_LIMIT_MAX_REQUESTS: "1" });
    const send = () =>
      limited.app.request("/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentPayload: {}, paymentRequirements: { network: "stellar:testnet" } }),
      });
    await send();
    const res = await send();

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    const body = (await res.json()) as any;
    expect(body.code).toBe("facilitator_rate_limited");
    expect(body.retryable, "backing off genuinely helps here").toBe(true);
  });

  it("accepts a valid bearer key", async () => {
    const secured = build({ FACILITATOR_API_KEYS: "topsecret", AUTH_EXEMPT_NETWORKS: "" });
    const res = await secured.app.request("/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer topsecret" },
      body: JSON.stringify({ paymentPayload: {}, paymentRequirements: { network: "stellar:pubnet" } }),
    });
    expect(res.status).not.toBe(401);
  });

  it("keeps exempt networks open even when keys are configured", async () => {
    // Lets an operator charge for pubnet while leaving the public testnet endpoint free.
    const secured = build({
      FACILITATOR_API_KEYS: "topsecret",
      AUTH_EXEMPT_NETWORKS: "stellar:testnet",
    });
    const res = await secured.app.request("/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paymentPayload: {},
        paymentRequirements: { network: "stellar:testnet" },
      }),
    });
    expect(res.status).not.toBe(401);
  });
});

describe("rate limiting", () => {
  it("returns a coded 429 with Retry-After once the window is exhausted", async () => {
    const limited = build({ RATE_LIMIT_MAX_REQUESTS: "2", RATE_LIMIT_WINDOW_SECONDS: "60" });
    const body = { paymentPayload: {}, paymentRequirements: {} };
    const send = () =>
      limited.app.request("/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    await send();
    await send();
    const third = await send();

    expect(third.status).toBe(429);
    expect(third.headers.get("Retry-After")).toBeTruthy();
    const payload = (await third.json()) as any;
    expect(payload.reason).toMatch(/rate limit/i);
    expect(payload.details.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("can be disabled entirely", async () => {
    const open = build({ RATE_LIMIT_ENABLED: "false" });
    for (let i = 0; i < 5; i++) {
      const res = await open.app.request("/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentPayload: {}, paymentRequirements: {} }),
      });
      expect(res.status).not.toBe(429);
    }
  });
});

describe("operations endpoints", () => {
  it("reports health with the networks it is actually serving", async () => {
    const body = (await (await app.request("/health")).json()) as any;
    expect(body.status).toBe("ok");
    expect(body.networks).toEqual(["stellar:testnet"]);
    expect(body.signers).toBe(1);
  });

  it("exposes prometheus-formatted counters", async () => {
    const res = await app.request("/metrics");
    expect(res.headers.get("Content-Type")).toMatch(/text\/plain/);
    const text = await res.text();
    expect(text).toMatch(/x402_verify_total/);
    expect(text).toMatch(/x402_settle_total/);
    expect(text).toMatch(/x402_rejections_total/);
  });
});

describe("unsupported version and network are client errors, not server faults", () => {
  // Regression guard. These previously surfaced as HTTP 500 / unexpected_verify_error with
  // retryable:true — which tells an agent to retry a request that can never succeed, turning one
  // bad request into a retry loop. Misreporting retryability is worse than a vague message.
  it("maps an x402 v1 payload to invalid_x402_version / 400 / non-retryable", async () => {
    const res = await post("/verify", { paymentPayload: { x402Version: 1 }, paymentRequirements: {} });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.code).toBe("invalid_x402_version");
    expect(body.retryable).toBe(false);
  });

  it("maps an unserved network to invalid_network and lists what is supported", async () => {
    const res = await post("/verify", {
      paymentPayload: { x402Version: 2, accepted: { scheme: "exact", network: "eip155:8453" }, payload: {} },
      paymentRequirements: { scheme: "exact", network: "eip155:8453" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.code).toBe("invalid_network");
    expect(body.retryable).toBe(false);
    expect(body.details.supported).toEqual(["stellar:testnet"]);
  });

  it("applies the same mapping on /settle", async () => {
    const res = await post("/settle", { paymentPayload: { x402Version: 1 }, paymentRequirements: {} });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).code).toBe("invalid_x402_version");
  });
});

describe("cataloging feedback at verify", () => {
  // The design: sellers get fast feedback at verify and an authoritative verdict at
  // settle. Only the settle half was built, so a seller had to spend a real payment to learn their
  // metadata had a typo.
  it("reports `processing` for metadata that would catalog", async () => {
    const preview = previewCataloging(
      {
        x402Version: 2,
        resource: { url: "https://api.seller.example/quotes" },
        accepted: {},
        payload: { transaction: "AAAA" },
        extensions: {
          bazaar: {
            info: { input: { type: "http", method: "GET" } },
            schema: {
              $schema: "https://json-schema.org/draft/2020-12/schema",
              type: "object",
              properties: {
                input: {
                  type: "object",
                  properties: { type: { type: "string" }, method: { type: "string" } },
                  required: ["type", "method"],
                },
              },
              required: ["input"],
            },
          },
        },
      } as never,
      {
        scheme: "exact",
        network: "stellar:testnet",
        amount: "1",
        asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        payTo: "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO",
        maxTimeoutSeconds: 60,
        extra: { areFeesSponsored: true },
      } as never,
      ["stellar:testnet"],
    );
    expect(preview).toBeDefined();
    const decoded = JSON.parse(Buffer.from(preview!, "base64").toString("utf8"));
    expect(decoded.bazaar.status).toBe("processing");
  });

  it("reports `rejected` with the same code settle would give", async () => {
    const preview = previewCataloging(
      {
        x402Version: 2,
        // No resource.url — the case that used to crash the SDK helper.
        accepted: {},
        payload: { transaction: "AAAA" },
        extensions: { bazaar: { info: { input: { type: "http", method: "GET" } }, schema: {} } },
      } as never,
      { scheme: "exact", network: "stellar:testnet", amount: "1", asset: "C", payTo: "G", maxTimeoutSeconds: 60 } as never,
      ["stellar:testnet"],
    );
    const decoded = JSON.parse(Buffer.from(preview!, "base64").toString("utf8"));
    expect(decoded.bazaar.status).toBe("rejected");
    expect(decoded.bazaar.code).toBe("bazaar_missing_resource_url");
    expect(decoded.bazaar.rejectedReason.length).toBeGreaterThan(20);
  });

  it("says nothing at all when there is no discovery extension", () => {
    const preview = previewCataloging(
      { x402Version: 2, accepted: {}, payload: {} } as never,
      { scheme: "exact", network: "stellar:testnet", amount: "1", asset: "C", payTo: "G", maxTimeoutSeconds: 60 } as never,
    );
    expect(preview).toBeUndefined();
  });
});

describe("EXTENSION-RESPONSES is readable by a browser client", () => {
  /**
   * The seller's only feedback channel for cataloging. Emitting it is not enough: CORS hides every
   * non-simple response header from JavaScript unless it is named in `Access-Control-Expose-Headers`,
   * so an unlisted header arrives and is silently dropped by the browser. From the seller's side that
   * is indistinguishable from the header never being sent — which is exactly how the incumbent's
   * reported failure presents. Emission itself is asserted by the cataloging tests above; this one
   * guards the half that is invisible until someone tries it from a browser.
   */
  it("names the header in Access-Control-Expose-Headers when CORS is on", async () => {
    const cors = build({ CORS_ORIGINS: "https://buyer.example" }).app;
    const res = await cors.request("/supported", { headers: { Origin: "https://buyer.example" } });
    const exposed = res.headers.get("access-control-expose-headers") ?? "";
    expect(
      exposed.toLowerCase().split(/\s*,\s*/),
      `EXTENSION-RESPONSES not exposed; browser clients cannot read it (got "${exposed}")`,
    ).toContain("extension-responses");
  });

  it("does not require CORS to be configured at all", async () => {
    const res = await app.request("/supported");
    expect(res.status).toBe(200);
  });
});

describe("top-level x402Version is tolerated both ways", () => {
  /**
   * The spec omits a top-level `x402Version` on /verify and /settle bodies, but the Go facilitator
   * requires it, the Bazaar extension's discovery extraction depends on it, and the TS/Python
   * clients send it while their request types omit it (upstream #1176). A facilitator that rejects
   * either shape breaks stock clients silently, so both are asserted here rather than left to a
   * schema default nobody tested.
   */
  const body = (extra: Record<string, unknown>) => ({
    paymentPayload: { x402Version: 2, accepted: {}, payload: { transaction: "AAAA" } },
    paymentRequirements: {
      scheme: "exact", network: "stellar:testnet", amount: "1",
      asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      payTo: "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO", maxTimeoutSeconds: 60,
    },
    ...extra,
  });

  // Neither shape may be rejected *for the version field*. Both get past body validation and fail
  // later on the dummy transaction, which is the point: the discriminator is the error code.
  const rejectedForShape = (payload: { code?: string }) =>
    payload.code === "invalid_payload" || payload.code === "invalid_request";

  it("accepts a request carrying x402Version", async () => {
    const res = await post("/verify", body({ x402Version: 2 }));
    expect(rejectedForShape(await res.json()), "stock clients send this; it must not be refused").toBe(false);
  });

  it("accepts a request omitting x402Version", async () => {
    const res = await post("/verify", body({}));
    expect(rejectedForShape(await res.json()), "the spec omits it; it must not be required").toBe(false);
  });

  it("still rejects a wrong-typed x402Version rather than ignoring it", async () => {
    const res = await post("/verify", body({ x402Version: "two" }));
    expect((await res.json()).code).toBe("invalid_payload");
  });
});
