import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FacilitatorClient } from "@x402/core/server";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import { accountsOf } from "@rail402.dev/bazaar";
import { validateListing } from "@rail402.dev/sdk/seller";
import {
  createSeller,
  declareHistoryRoute,
  declareHourlyForecast,
  declareTools,
  exactOption,
  meteredOption,
  baseUnits,
  METERED_PRICES,
  NETWORK,
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
