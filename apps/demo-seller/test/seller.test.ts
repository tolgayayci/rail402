import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FacilitatorClient } from "@x402/core/server";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import { accountsOf } from "@rail402.dev/bazaar";
import { validateListing } from "@rail402.dev/sdk/seller";
import {
  MAX_CLIENTS,
  PaidRequestLimits,
  createSeller,
  declareHistoryRoute,
  declareHourlyForecast,
  declareTools,
  exactOption,
  meteredOption,
  baseUnits,
  METERED_PRICES,
  NETWORK,
  sellerConfig,
} from "@rail402.dev/demo-seller";

/** Circle's USDC on the Stellar testnet: the seller's default price asset. */
const TESTNET_USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

/** The settlement authority the test facilitator advertises for upto. */
const AUTHORITY = "GCQUNBNRBOHSD2BQRX6NUDJEQXUCNLYGJKPYB5TDKTL2QGTZDRS3OJMS";

/**
 * A facilitator that supports Stellar testnet `exact` (and `upto` unless `withUpto` is false) and
 * never settles: only unpaid requests are made.
 */
function testFacilitator(withUpto = true): FacilitatorClient {
  return {
    getSupported: () =>
      Promise.resolve({
        kinds: [
          { x402Version: 2, scheme: "exact", network: NETWORK, extra: { areFeesSponsored: true } },
          ...(withUpto
            ? [
                {
                  x402Version: 2,
                  scheme: "upto",
                  network: NETWORK,
                  extra: { areFeesSponsored: true, facilitatorAddress: AUTHORITY },
                },
              ]
            : []),
        ],
        extensions: ["bazaar"],
        signers: {},
      }),
    verify: () => Promise.reject(new Error("not used")),
    settle: () => Promise.reject(new Error("not used")),
  };
}
const facilitator = testFacilitator();

/** A fixed payTo, so the recorded 402 responses do not change between runs. */
const FIXED_PAY_TO = "GAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A";

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

  it("keeps its 402 responses: the stock price and metadata, plus described and closed parameter schemas", async () => {
    const fixed = createSeller({ payTo: FIXED_PAY_TO, facilitator }).listen(0, "127.0.0.1");
    await new Promise((resolve) => fixed.once("listening", resolve));
    try {
      const origin = `http://127.0.0.1:${String((fixed.address() as AddressInfo).port)}`;
      const recorded: Record<string, PaymentRequired> = {};
      for (const [path, init] of [
        ["/weather?city=Ankara", undefined],
        ["/users/42", undefined],
        ["/translate", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }],
      ] as const) {
        const response = await fetch(`${origin}${path}`, init);
        const paymentRequired = decodePaymentRequiredHeader(response.headers.get("payment-required") ?? "");
        paymentRequired.resource.url = paymentRequired.resource.url.replace(origin, "http://seller");
        recorded[path] = paymentRequired;
        expect(paymentRequired.accepts[0]).toMatchObject({ asset: TESTNET_USDC, payTo: FIXED_PAY_TO });
      }
      await expect(`${JSON.stringify(recorded, null, 2)}\n`).toMatchFileSnapshot(
        "__snapshots__/payment-required.json.snap",
      );
    } finally {
      await new Promise((resolve) => fixed.close(resolve));
    }
  });

  describe("MCP endpoint", () => {
    const connect = async (url = `${base}/mcp`) => {
      const client = new Client({ name: "demo-seller-test", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(url)));
      return client;
    };

    it("lists two paid tools and a metered one with described arguments, and a free ping", async () => {
      const client = await connect();
      try {
        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name).sort()).toEqual([
          "air_quality",
          "forecast",
          "hourly_forecast",
          "ping",
        ]);
        expect(tools.find((tool) => tool.name === "hourly_forecast")?.inputSchema).toMatchObject({
          properties: {
            city: { type: "string", description: "City name" },
            hours: { type: "integer", minimum: 1, maximum: 48, description: expect.any(String) as string },
          },
          required: ["city", "hours"],
        });
        const airQuality = tools.find((tool) => tool.name === "air_quality");
        expect(airQuality?.inputSchema).toMatchObject({
          properties: {
            city: { type: "string", description: "City name" },
            pollutant: { enum: ["pm25", "pm10", "o3", "no2"], description: expect.any(String) as string },
          },
          required: ["city"],
        });
        expect(await client.callTool({ name: "ping", arguments: {} })).toMatchObject({
          content: [{ type: "text", text: "pong" }],
        });
      } finally {
        await client.close();
      }
    });

    it("asks for payment with the tool's Bazaar metadata, keyed by this endpoint and the tool name", async () => {
      const client = await connect();
      try {
        for (const toolName of ["forecast", "air_quality"]) {
          const result = await client.callTool({ name: toolName, arguments: { city: "Izmir" } });
          expect(result.isError, toolName).toBe(true);
          const required = result.structuredContent as PaymentRequired;
          expect(required.accepts).toEqual([
            expect.objectContaining({
              scheme: "exact",
              network: NETWORK,
              payTo,
              amount: "10000",
              asset: TESTNET_USDC,
            }),
          ]);
          expect(required.resource.url).toBe(`${base}/mcp`);
          expect(required.extensions?.["bazaar"]).toMatchObject({
            info: { input: { type: "mcp", toolName } },
          });
        }
      } finally {
        await client.close();
      }
    });

    it("declares the tools at PUBLIC_URL when it is set", async () => {
      const app = createSeller({ payTo, facilitator, publicUrl: "https://demo.example.com" }).listen(
        0,
        "127.0.0.1",
      );
      await new Promise((resolve) => app.once("listening", resolve));
      const client = await connect(`http://127.0.0.1:${String((app.address() as AddressInfo).port)}/mcp`);
      try {
        const result = await client.callTool({ name: "forecast", arguments: { city: "Izmir" } });
        expect((result.structuredContent as PaymentRequired).resource.url).toBe(
          "https://demo.example.com/mcp",
        );
      } finally {
        await client.close();
        await new Promise((resolve) => app.close(resolve));
      }
    });

    it("refuses methods other than POST: the server is stateless", async () => {
      for (const method of ["GET", "DELETE"]) {
        const response = await fetch(`${base}/mcp`, { method });
        expect(response.status, method).toBe(405);
        expect(response.headers.get("allow")).toBe("POST");
      }
    });

    it("declares tools the Rail402 catalog accepts without dropping anything", async () => {
      const tools = declareTools("https://demo.example.com/mcp", (amount) => exactOption(payTo, amount));
      for (const tool of [tools.forecast, tools.airQuality]) {
        const report = await validateListing(tool, { network: NETWORK });
        expect(report, tool.toolName).toMatchObject({ catalogable: true, dropped: [], lint: [] });
        expect(report.preview).toMatchObject({ type: "mcp", toolName: tool.toolName, amount: "10000" });
      }
    });
  });
  describe("metered upto resources", () => {
    const listen = async (options: Parameters<typeof createSeller>[0]) => {
      const app = createSeller(options).listen(0, "127.0.0.1");
      await new Promise((resolve) => app.once("listening", resolve));
      return { app, origin: `http://127.0.0.1:${String((app.address() as AddressInfo).port)}` };
    };
    const tools = async (origin: string) => {
      const client = new Client({ name: "demo-seller-test", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)));
      try {
        return { names: (await client.listTools()).tools.map((tool) => tool.name).sort(), client };
      } catch (error) {
        await client.close();
        throw error;
      }
    };

    it("asks for an upto authorization capped at 0.01 USDC on GET /history", async () => {
      const paymentRequired = await required("/history?city=Ankara&days=3");
      expect(paymentRequired.accepts).toEqual([
        expect.objectContaining({
          scheme: "upto",
          network: NETWORK,
          payTo,
          amount: "100000",
          asset: TESTNET_USDC,
          maxTimeoutSeconds: 120,
          extra: expect.objectContaining({
            areFeesSponsored: true,
            facilitatorAddress: AUTHORITY,
          }) as unknown,
        }),
      ]);
      expect(paymentRequired.extensions?.["bazaar"]).toMatchObject({
        info: { input: { type: "http", method: "GET", queryParams: { city: "Istanbul", days: "7" } } },
      });
    });

    it("asks for an upto authorization on the metered tool, keyed by this endpoint", async () => {
      const { client } = await tools(base);
      try {
        const result = await client.callTool({
          name: "hourly_forecast",
          arguments: { city: "Izmir", hours: 6 },
        });
        expect(result.isError).toBe(true);
        const paymentRequired = result.structuredContent as PaymentRequired;
        expect(paymentRequired.accepts).toEqual([
          expect.objectContaining({ scheme: "upto", payTo, amount: "100000", asset: TESTNET_USDC }),
        ]);
        expect(paymentRequired.resource.url).toBe(`${base}/mcp`);
        expect(paymentRequired.extensions?.["bazaar"]).toMatchObject({
          info: { input: { type: "mcp", toolName: "hourly_forecast" } },
        });
      } finally {
        await client.close();
      }
    });

    it("never charges more than the cap: 30 days or 48 hours fit, in USDC and in a 6-decimal token", () => {
      for (const asset of [undefined, { contract: TESTNET_USDC, decimals: 6 }]) {
        const cap = baseUnits(METERED_PRICES.cap, asset);
        expect(baseUnits(METERED_PRICES.perDay, asset) * 30n).toBeLessThanOrEqual(cap);
        expect(baseUnits(METERED_PRICES.perHour, asset) * 48n).toBeLessThanOrEqual(cap);
      }
    });

    it("declares metered resources the Rail402 catalog accepts without dropping anything", async () => {
      const option = meteredOption(payTo, undefined);
      for (const declaration of [
        declareHistoryRoute(option),
        declareHourlyForecast("https://demo.example.com/mcp", option),
      ]) {
        const report = await validateListing(declaration, { network: NETWORK });
        expect(report).toMatchObject({ catalogable: true, dropped: [], lint: [] });
        expect(report.preview).toMatchObject({ amount: "100000" });
      }
    });

    it("keeps the exact routes and tools working when the facilitator does not serve upto", async () => {
      const { app, origin } = await listen({ payTo, facilitator: testFacilitator(false) });
      try {
        const weather = await fetch(`${origin}/weather?city=Ankara`);
        expect(weather.status).toBe(402);
        const history = await fetch(`${origin}/history?city=Ankara&days=3`);
        expect(history.status).toBe(503);
        const { names, client } = await tools(origin);
        await client.close();
        expect(names).toEqual(["air_quality", "forecast", "ping"]);
      } finally {
        await new Promise((resolve) => app.close(resolve));
      }
    });

    it("refuses a muxed payTo, which x402 payments on Stellar cannot pay", () => {
      const muxed = "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUAAAAAAAAAAAACJUQ";
      expect(() => createSeller({ payTo: muxed, facilitator })).toThrow(/muxed/);
    });

    it("leaves the metered resources out when asked to", async () => {
      const { app, origin } = await listen({ payTo, facilitator, metered: false });
      try {
        expect((await fetch(`${origin}/history?city=Ankara&days=3`)).status).toBe(404);
        const { names, client } = await tools(origin);
        await client.close();
        expect(names).toEqual(["air_quality", "forecast", "ping"]);
      } finally {
        await new Promise((resolve) => app.close(resolve));
      }
    });
  });
});

/** Rail402's mark on a /settle answer that repeats an earlier settlement of the same payment. */
const REPEAT_MARKER = { rail402: { settlement: { repeat: true } } };

/**
 * A facilitator that settles like an idempotent one, Rail402 included: copies of one payment sent
 * together all pass /verify, since none of them has settled yet, and every /settle after the first
 * answers the first one's success again, with Rail402's repeat marker unless `marked` is false.
 */
function idempotentFacilitator(marked = true) {
  const payer = Keypair.random().publicKey();
  const settled = new Map<string, string>();
  const client: FacilitatorClient = {
    getSupported: () => facilitator.getSupported(),
    verify: () => Promise.resolve({ isValid: true, payer }),
    settle: (payload, requirements) => {
      const key = JSON.stringify(payload.payload);
      const earlier = settled.get(key);
      const transaction = earlier ?? createHash("sha256").update(key).digest("hex");
      settled.set(key, transaction);
      return Promise.resolve({
        success: true,
        transaction,
        network: requirements.network,
        payer,
        ...(earlier !== undefined && marked ? { extensionResponses: REPEAT_MARKER } : {}),
      });
    },
  };
  return { client, settlements: () => settled.size };
}

/** A payment for the first option of a 402; the facilitator decides whether it is any good. */
function paymentFor(required: PaymentRequired, payload: Record<string, unknown>): PaymentPayload {
  const [accepted] = required.accepts;
  if (accepted === undefined) throw new Error("the 402 offers no payment option");
  return { x402Version: 2, resource: required.resource, accepted, payload };
}

describe("demo seller serving each payment once", () => {
  const payTo = Keypair.random().publicKey();
  const listen = async (client: FacilitatorClient) => {
    const app = createSeller({ payTo, facilitator: client }).listen(0, "127.0.0.1");
    await new Promise((resolve) => app.once("listening", resolve));
    return { app, origin: `http://127.0.0.1:${String((app.address() as AddressInfo).port)}` };
  };
  const close = (app: Server) => new Promise((resolve) => app.close(resolve));

  /** Sends one payment for `path` three times at once; returns each answer's status and settlement. */
  const sendCopies = async (origin: string, path: string, payload: Record<string, unknown>) => {
    const unpaid = await fetch(`${origin}${path}`);
    expect(unpaid.status, path).toBe(402);
    const required = decodePaymentRequiredHeader(unpaid.headers.get("payment-required") ?? "");
    const headers = { "payment-signature": encodePaymentSignatureHeader(paymentFor(required, payload)) };
    const answers = await Promise.all([0, 1, 2].map(() => fetch(`${origin}${path}`, { headers })));
    return Promise.all(
      answers.map(async (answer) => {
        await answer.body?.cancel();
        const settlement = answer.headers.get("payment-response");
        return {
          status: answer.status,
          settlement: settlement === null ? undefined : decodePaymentResponseHeader(settlement),
        };
      }),
    );
  };

  it("serves concurrent copies of one payment once, whether or not the facilitator marks the repeats", async () => {
    for (const marked of [true, false]) {
      const paid = idempotentFacilitator(marked);
      const { app, origin } = await listen(paid.client);
      try {
        const answers = await sendCopies(origin, "/weather?city=Ankara", { transaction: "AAAA" });
        expect(answers.map((answer) => answer.status).sort(), `marked: ${String(marked)}`).toEqual([
          200, 402, 402,
        ]);
        const refused = answers.filter((answer) => answer.status === 402);
        for (const { settlement } of refused) {
          expect(settlement).toMatchObject({ success: false, errorReason: "seller_settlement_repeat" });
        }
        expect(paid.settlements()).toBe(1);
      } finally {
        await close(app);
      }
    }
  });

  it("serves concurrent copies of one metered payment once", async () => {
    const paid = idempotentFacilitator();
    const { app, origin } = await listen(paid.client);
    try {
      const answers = await sendCopies(origin, "/history?city=Ankara&days=3", { authorization: "AAAA" });
      expect(answers.map((answer) => answer.status).sort()).toEqual([200, 402, 402]);
      expect(paid.settlements()).toBe(1);
    } finally {
      await close(app);
    }
  });

  it("serves concurrent copies of one paid tool call once, metered or not", async () => {
    const paid = idempotentFacilitator();
    const { app, origin } = await listen(paid.client);
    const client = new Client({ name: "demo-seller-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)));
    try {
      for (const [name, args] of [
        ["forecast", { city: "Izmir" }],
        ["hourly_forecast", { city: "Izmir", hours: 6 }],
      ] as const) {
        const unpaid = await client.callTool({ name, arguments: args });
        const payment = paymentFor(unpaid.structuredContent as PaymentRequired, { transaction: name });
        const results = await Promise.all(
          [0, 1, 2].map(() => client.callTool({ name, arguments: args, _meta: { "x402/payment": payment } })),
        );
        const served = results.filter((result) => result.isError !== true);
        expect(served, name).toHaveLength(1);
        expect(served[0]?.structuredContent, name).toMatchObject({ city: "Izmir" });
      }
      expect(paid.settlements()).toBe(2);
    } finally {
      await client.close();
      await close(app);
    }
  });
});

/**
 * A facilitator that refuses every payment, as it does one that only has the right shape (anyone can
 * copy that from a 402), and counts the verifications that reached it.
 */
function refusingFacilitator() {
  const calls = { verify: 0 };
  const client: FacilitatorClient = {
    getSupported: () => facilitator.getSupported(),
    verify: () => {
      calls.verify += 1;
      return Promise.resolve({ isValid: false, invalidReason: "invalid_exact_stellar_payload_malformed" });
    },
    settle: () => Promise.reject(new Error("not used")),
  };
  return { client, calls };
}

describe("demo seller limits on paid requests", () => {
  const payTo = Keypair.random().publicKey();
  const listen = async (client: FacilitatorClient, paidLimits: { perClient: number; global: number }) => {
    // One proxy in front: each request names its client in X-Forwarded-For.
    const app = createSeller({ payTo, facilitator: client, trustProxy: 1, paidLimits }).listen(
      0,
      "127.0.0.1",
    );
    await new Promise((resolve) => app.once("listening", resolve));
    return { app, origin: `http://127.0.0.1:${String((app.address() as AddressInfo).port)}` };
  };
  const close = (app: Server) => new Promise((resolve) => app.close(resolve));

  /** A PAYMENT-SIGNATURE for GET /weather that only has the shape of a payment. */
  const shapedPayment = async (origin: string) => {
    const unpaid = await fetch(`${origin}/weather?city=Ankara`);
    const required = decodePaymentRequiredHeader(unpaid.headers.get("payment-required") ?? "");
    return encodePaymentSignatureHeader(paymentFor(required, { transaction: "AAAA" }));
  };
  /** The status of a request and the code its 402 carries. */
  const answer = async (response: Response) => {
    await response.body?.cancel();
    const required = response.headers.get("payment-required");
    return {
      status: response.status,
      code: required === null ? undefined : decodePaymentRequiredHeader(required).error,
      retryAfter: response.headers.get("retry-after"),
    };
  };
  const pay = async (origin: string, header: string, client: string) =>
    answer(
      await fetch(`${origin}/weather?city=Ankara`, {
        headers: { "payment-signature": header, "x-forwarded-for": client },
      }),
    );
  /** The code each client's payment is answered with: the facilitator's refusal, or the limit's. */
  const codesOf = async (origin: string, header: string, clients: readonly string[]) => {
    const codes: (string | undefined)[] = [];
    for (const client of clients) codes.push((await pay(origin, header, client)).code);
    return codes;
  };
  const REFUSED = "invalid_exact_stellar_payload_malformed";
  const LIMITED = "rate_limited";
  /** The `error` of each paid tool call's result in an MCP answer sent as server-sent events. */
  const errorsOf = (body: string) =>
    body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as { result?: { structuredContent?: unknown } })
      .map((message) => (message.result?.structuredContent as { error?: unknown } | undefined)?.error);

  it("limits each client's paid requests before they reach the facilitator", async () => {
    const paid = refusingFacilitator();
    const { app, origin } = await listen(paid.client, { perClient: 2, global: 10 });
    try {
      const header = await shapedPayment(origin);
      const client = "203.0.113.7";
      expect(await codesOf(origin, header, [client, client])).toEqual([REFUSED, REFUSED]);
      const limited = await pay(origin, header, client);
      expect(limited).toMatchObject({ status: 402, code: LIMITED });
      expect(Number(limited.retryAfter)).toBeGreaterThan(0);
      expect(paid.calls.verify).toBe(2);
      // Another client's payment, the same client's unpaid request and the free routes still pass.
      expect((await pay(origin, header, "203.0.113.8")).code).toBe(REFUSED);
      const unpaid = await fetch(`${origin}/weather?city=Ankara`, { headers: { "x-forwarded-for": client } });
      expect(await answer(unpaid)).toMatchObject({ status: 402, code: "Payment required" });
      expect((await fetch(`${origin}/health`, { headers: { "x-forwarded-for": client } })).status).toBe(200);
      expect(paid.calls.verify).toBe(3);
    } finally {
      await close(app);
    }
  });

  it("limits paid requests across all clients, however many addresses send them", async () => {
    const paid = refusingFacilitator();
    const { app, origin } = await listen(paid.client, { perClient: 2, global: 3 });
    try {
      const header = await shapedPayment(origin);
      const clients = ["198.51.100.1", "198.51.100.2", "198.51.100.3", "198.51.100.4", "198.51.100.5"];
      expect(await codesOf(origin, header, clients)).toEqual([REFUSED, REFUSED, REFUSED, LIMITED, LIMITED]);
      expect(paid.calls.verify).toBe(3);
      // The metered route draws on the same limits.
      const unpaid = await fetch(`${origin}/history?city=Ankara&days=3`);
      const required = decodePaymentRequiredHeader(unpaid.headers.get("payment-required") ?? "");
      const metered = await fetch(`${origin}/history?city=Ankara&days=3`, {
        headers: {
          "payment-signature": encodePaymentSignatureHeader(paymentFor(required, { authorization: "AAAA" })),
          "x-forwarded-for": "198.51.100.6",
        },
      });
      expect(await answer(metered)).toMatchObject({ status: 402, code: LIMITED });
      expect(paid.calls.verify).toBe(3);
    } finally {
      await close(app);
    }
  });

  it("counts only the payments it asks the facilitator about, never a request that carries none", async () => {
    const paid = refusingFacilitator();
    const { app, origin } = await listen(paid.client, { perClient: 60, global: 2 });
    try {
      const junkClients = ["192.0.2.10", "192.0.2.11", "192.0.2.12"];
      const junk = async (path: string, headers: Record<string, string>, body?: string) => {
        for (const client of junkClients) {
          const response = await fetch(`${origin}${path}`, {
            ...(body === undefined ? {} : { method: "POST", body }),
            headers: { ...headers, "x-forwarded-for": client },
          });
          await response.body?.cancel();
        }
      };
      const json = { "content-type": "application/json", accept: "application/json, text/event-stream" };
      const meta = { "x402/payment": { x402Version: 2, payload: { transaction: "AAAA" } } };
      // Payment headers on free and unknown routes, empty or undecodable ones on a paid route.
      await junk("/health", { "payment-signature": "x" });
      await junk("/nope", { "payment-signature": "x", "x-payment": "x" });
      await junk("/weather?city=Ankara", { "payment-signature": "" });
      await junk("/weather?city=Ankara", { "payment-signature": "x" });
      await junk("/weather?city=Ankara", { "x-payment": "x" });
      // A payment in a JSON body where no tool reads it, or on a free tool, or one that is not a payment.
      const call = (name: string, payment: unknown) =>
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: { city: "Izmir" }, _meta: { "x402/payment": payment } },
        });
      await junk("/translate", json, JSON.stringify({ params: { _meta: meta } }));
      await junk("/mcp", json, call("ping", meta["x402/payment"]));
      await junk("/mcp", json, call("forecast", "x"));
      expect(paid.calls.verify).toBe(0);

      // The pool every client shares is untouched: real attempts from new clients still reach it.
      const header = await shapedPayment(origin);
      const codes = await codesOf(origin, header, ["203.0.113.1", "203.0.113.2", "203.0.113.3"]);
      expect(paid.calls.verify).toBe(2);
      expect(codes).toEqual([REFUSED, REFUSED, LIMITED]);
      expect(paid.calls.verify).toBe(2);
    } finally {
      await close(app);
    }
  });

  it("counts the IPv6 addresses of one /56 as one client, and IPv4 written as IPv6 as that IPv4", async () => {
    const paid = refusingFacilitator();
    const { app, origin } = await listen(paid.client, { perClient: 1, global: 100 });
    try {
      const header = await shapedPayment(origin);
      // One IPv4 client, however its address is written: mapped, compatible or NAT64, hex or dotted.
      const ipv4 = ["::ffff:c000:201", "::ffff:192.0.2.1", "::192.0.2.1", "64:ff9b::c000:201"];
      const asIpv4 = await codesOf(origin, header, ["192.0.2.1", ...ipv4]);
      expect(paid.calls.verify).toBe(1);
      expect(asIpv4).toEqual([REFUSED, ...ipv4.map(() => LIMITED)]);
      expect(await codesOf(origin, header, ["::ffff:c000:202"])).toEqual([REFUSED]);
      // One IPv6 client per /56.
      expect(await codesOf(origin, header, ["2001:db8:1:100::1", "2001:db8:1:1ff:ffff::3"])).toEqual([
        REFUSED,
        LIMITED,
      ]);
      expect(await codesOf(origin, header, ["2001:db8:1:200::1"])).toEqual([REFUSED]);
      expect(paid.calls.verify).toBe(4);
    } finally {
      await close(app);
    }
  });

  it("counts every paid tool call an MCP request carries, and never a free call", async () => {
    const paid = refusingFacilitator();
    const { app, origin } = await listen(paid.client, { perClient: 2, global: 10 });
    const mcp = new Client({ name: "demo-seller-test", version: "1.0.0" });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)));
    try {
      const unpaid = await mcp.callTool({ name: "forecast", arguments: { city: "Izmir" } });
      const payment = paymentFor(unpaid.structuredContent as PaymentRequired, { transaction: "AAAA" });
      let id = 0;
      const call = (method: string, params: Record<string, unknown>) => ({
        jsonrpc: "2.0",
        id: (id += 1),
        method,
        params,
      });
      const paidCall = () =>
        call("tools/call", {
          name: "forecast",
          arguments: { city: "Izmir" },
          _meta: { "x402/payment": payment },
        });
      const post = async (body: unknown, client = "203.0.113.9") => {
        const response = await fetch(`${origin}/mcp`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "x-forwarded-for": client,
          },
          body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.text() };
      };

      // Three paid calls in one batch are three paid requests: one more than this client may make.
      const batch = await post([paidCall(), paidCall(), paidCall()]);
      expect(batch.status).toBe(200);
      expect(errorsOf(batch.body).sort()).toEqual([REFUSED, REFUSED, LIMITED].sort());
      expect(paid.calls.verify).toBe(2);
      expect(errorsOf((await post(paidCall())).body)).toEqual([LIMITED]);
      expect(paid.calls.verify).toBe(2);
      // Free calls are not counted; another client's paid call is its own.
      expect((await post(call("tools/list", {}))).status).toBe(200);
      expect(errorsOf((await post(paidCall(), "203.0.113.10")).body)).toEqual([REFUSED]);
      expect(paid.calls.verify).toBe(3);
    } finally {
      await mcp.close();
      await close(app);
    }
  });

  it("keeps a bounded number of clients in memory, forgetting the least recently seen", () => {
    const limits = new PaidRequestLimits({ perClient: 1, global: 1_000_000 }, () => 0);
    expect(limits.admit("192.0.2.1")).toBe(0);
    expect(limits.admit("192.0.2.1")).toBeGreaterThan(0);
    for (let client = 0; client < MAX_CLIENTS; client += 1) {
      expect(
        limits.admit(`10.${String(client >> 16)}.${String((client >> 8) & 255)}.${String(client & 255)}`),
      ).toBe(0);
    }
    expect(limits.clients).toBe(MAX_CLIENTS);
    // Forgotten, so it starts again with a full allowance; the total pool still bounds every client.
    expect(limits.admit("192.0.2.1")).toBe(0);
    expect(limits.clients).toBe(MAX_CLIENTS);
  });
});

/** Circle's USDC on the Stellar public network. */
const PUBNET_USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";

describe("demo seller on pubnet", () => {
  const payTo = Keypair.random().publicKey();
  const pubnetFacilitator: FacilitatorClient = {
    getSupported: () =>
      Promise.resolve({
        kinds: [
          { x402Version: 2, scheme: "exact", network: "stellar:pubnet", extra: { areFeesSponsored: true } },
        ],
        extensions: ["bazaar"],
        signers: {},
      }),
    verify: () => Promise.reject(new Error("not used")),
    settle: () => Promise.reject(new Error("not used")),
  };
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createSeller({
      payTo,
      network: "stellar:pubnet",
      facilitator: pubnetFacilitator,
      facilitatorUrl: "https://facilitator.example",
      metered: false,
    }).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("asks for pubnet USDC and names its facilitator", async () => {
    const response = await fetch(`${base}/weather?city=Ankara`);
    expect(response.status).toBe(402);
    const paymentRequired = decodePaymentRequiredHeader(response.headers.get("payment-required") ?? "");
    expect(paymentRequired.accepts).toEqual([
      expect.objectContaining({ scheme: "exact", network: "stellar:pubnet", asset: PUBNET_USDC, payTo }),
    ]);
    expect(await (await fetch(`${base}/`)).json()).toMatchObject({
      network: "stellar:pubnet",
      facilitator: "https://facilitator.example",
      metered: [],
    });
  });

  it("claims its payTo under the pubnet passphrase in stellar.toml", async () => {
    const text = await (await fetch(`${base}/.well-known/stellar.toml`)).text();
    expect(text).toContain('NETWORK_PASSPHRASE = "Public Global Stellar Network ; September 2015"');
    expect(accountsOf(text)).toEqual({ ok: true, accounts: [payTo] });
  });
});

describe("demo seller configuration", () => {
  const payTo = Keypair.random().publicKey();

  it("defaults to testnet, the hosted facilitator and metered routes", () => {
    expect(sellerConfig({ PAY_TO: payTo })).toMatchObject({
      network: "stellar:testnet",
      facilitatorUrl: undefined,
      asset: undefined,
      metered: true,
      port: 8080,
    });
  });

  it("limits paid requests per client and in total, at most what the facilitator allows one address", () => {
    // Each paid request costs a verify and a settle; the facilitator's default is 600 per minute.
    const { paidLimits } = sellerConfig({ PAY_TO: payTo });
    expect(paidLimits).toEqual({ perClient: 60, global: 120 });
    expect(paidLimits.global * 2).toBeLessThan(600);
    expect(
      sellerConfig({ PAY_TO: payTo, PAID_PER_MINUTE: "10", PAID_GLOBAL_PER_MINUTE: "50" }).paidLimits,
    ).toEqual({ perClient: 10, global: 50 });
    for (const env of [{ PAID_PER_MINUTE: "0" }, { PAID_GLOBAL_PER_MINUTE: "0" }, { PAID_PER_MINUTE: "x" }]) {
      expect(() => sellerConfig({ PAY_TO: payTo, ...env }), JSON.stringify(env)).toThrow(/PAID_/);
    }
  });

  it("needs an https facilitator on pubnet, and turns metering off there by default", () => {
    expect(() => sellerConfig({ PAY_TO: payTo, NETWORK: "stellar:pubnet" })).toThrow(
      /FACILITATOR_URL is required/,
    );
    expect(() =>
      sellerConfig({
        PAY_TO: payTo,
        NETWORK: "stellar:pubnet",
        FACILITATOR_URL: "http://facilitator.example",
      }),
    ).toThrow(/https/);
    expect(
      sellerConfig({
        PAY_TO: payTo,
        NETWORK: "stellar:pubnet",
        FACILITATOR_URL: "https://facilitator.example",
      }),
    ).toMatchObject({ network: "stellar:pubnet", metered: false });
  });

  it("reads the asset and refuses invalid values", () => {
    expect(sellerConfig({ PAY_TO: payTo, ASSET: `${PUBNET_USDC}:7` }).asset).toEqual({
      contract: PUBNET_USDC,
      decimals: 7,
    });
    for (const env of [
      { PAY_TO: "nobody" },
      { PAY_TO: payTo, NETWORK: "stellar:mainnet" },
      { PAY_TO: payTo, ASSET: "USDC" },
      { PAY_TO: payTo, METERED: "maybe" },
      { PAY_TO: payTo, PUBLIC_URL: "https://x.example/path" },
    ]) {
      expect(() => sellerConfig(env), JSON.stringify(env)).toThrow();
    }
  });
});
