import { afterAll, describe, expect, it } from "vitest";
import { Account, Keypair, MuxedAccount } from "@stellar/stellar-sdk";
import type { FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { z } from "zod";
import { mergeCodes } from "@rail402.dev/errors";
import { SchemaSandbox, bazaarCodes } from "@rail402.dev/bazaar";
import { PUBNET, TESTNET, USDC, type StellarNetwork } from "@rail402.dev/stellar";
import { randomContractId } from "@rail402.dev/testkit";
import { agentCodes } from "@rail402.dev/sdk";
import {
  MemorySettlementMemory,
  exact,
  httpRoute,
  isSellerError,
  mcpPaymentConfig,
  mcpTool,
  param,
  repeatMarker,
  resolvePrice,
  sellerCodes,
  upto,
  validateListing,
  withSettleDedupe,
  type SellerError,
  type ValidateListingOptions,
} from "@rail402.dev/sdk/seller";

const payTo = Keypair.random().publicKey();
const usdc = USDC[TESTNET].contract;
const price = exact({ network: TESTNET, payTo, price: "$0.01" });
const sandbox = new SchemaSandbox();

afterAll(async () => {
  await sandbox.close();
});

function thrown(fn: () => unknown): SellerError {
  try {
    fn();
  } catch (error) {
    if (isSellerError(error)) return error;
    throw error;
  }
  throw new Error("expected a SellerError");
}

const forecast = () =>
  httpRoute({
    method: "GET",
    path: "/forecast/:city",
    description: "Seven-day weather forecast for a city",
    payment: price,
    pathParams: {
      city: param.string({ description: "City name", example: "Ankara", minLength: 1, maxLength: 64 }),
    },
    query: {
      days: param.integer({ description: "Number of days", minimum: 1, maximum: 7, example: 3 }),
      units: param.enum(["metric", "imperial"], {
        description: "Unit system",
        required: true,
        example: "metric",
      }),
    },
    output: {
      example: { city: "Ankara", days: [{ high: 21, low: 9 }] },
      schema: { properties: { city: { type: "string" } }, required: ["city"] },
    },
    serviceName: "Weather API",
    tags: ["weather", "forecast"],
  });

const translate = () =>
  httpRoute({
    method: "POST",
    path: "/translate",
    description: "Translate text between languages",
    payment: [
      price,
      exact({ network: TESTNET, payTo, price: { amount: "0.5", asset: randomContractId(), decimals: 6 } }),
    ],
    body: {
      type: "json",
      params: {
        text: param.string({ description: "Text to translate", required: true, example: "merhaba" }),
        target: param.string({
          description: "Target language code",
          required: true,
          example: "en",
          pattern: "^[a-z]{2}$",
        }),
        options: param.object(
          {
            formal: param.boolean({ description: "Use a formal register", example: true }),
            glossary: param.array(param.string({ description: "A term kept untranslated" }), {
              description: "Terms kept as they are",
              maxItems: 20,
            }),
          },
          { description: "Translation options" },
        ),
      },
    },
    output: { example: { text: "hello" } },
  });

const tool = () =>
  mcpTool({
    endpoint: "https://tools.example.com/mcp",
    toolName: "air_quality",
    description: "Air quality index for a city",
    payment: price,
    arguments: {
      city: param.string({ description: "City name", required: true, example: "Izmir" }),
      pollutants: param.array(param.enum(["pm25", "pm10", "o3"], { description: "A pollutant" }), {
        description: "Pollutants to report",
        maxItems: 3,
      }),
      location: param.object(
        {
          lat: param.number({ description: "Latitude", minimum: -90, maximum: 90, required: true }),
          lon: param.number({ description: "Longitude", minimum: -180, maximum: 180, required: true }),
        },
        { description: "Coordinates instead of a city" },
      ),
    },
    output: { example: { aqi: 42 } },
    transport: "streamable-http",
  });

describe("prices", () => {
  it("converts dollar and USDC prices to base units on each network", () => {
    expect(price.price).toEqual({ amount: "100000", asset: usdc });
    expect(resolvePrice({ amount: "1.5", asset: "USDC" }, PUBNET)).toEqual({
      asset: USDC[PUBNET].contract,
      amount: "15000000",
      decimals: 7,
    });
    const token = randomContractId();
    expect(resolvePrice({ amount: "0.000001", asset: token, decimals: 18 }, TESTNET).amount).toBe(
      "1000000000000",
    );
    expect(resolvePrice({ amount: "2", asset: token, decimals: 0 }, TESTNET).amount).toBe("2");
  });

  it.each([
    ["no dollar sign", "0.01"],
    ["zero", "$0"],
    ["too many decimals", "$0.00000001"],
    ["negative", "$-1"],
    ["exponent", "$1e3"],
  ])("refuses a malformed price (%s)", (_label, value) => {
    expect(thrown(() => exact({ network: TESTNET, payTo, price: value as `$${string}` })).code).toBe(
      "seller_price_invalid",
    );
  });

  it("needs a custom asset's decimals and refuses a wrong USDC decimals", () => {
    const token = randomContractId();
    expect(thrown(() => resolvePrice({ amount: "1", asset: token }, TESTNET)).reason).toMatch(
      /assetDecimals/,
    );
    expect(thrown(() => resolvePrice({ amount: "1", asset: "USDC", decimals: 6 }, TESTNET)).code).toBe(
      "seller_price_invalid",
    );
    expect(thrown(() => resolvePrice({ amount: "1", asset: "EURC" }, TESTNET)).code).toBe(
      "seller_price_invalid",
    );
    expect(thrown(() => resolvePrice({ amount: "1.1234567", asset: token, decimals: 6 }, TESTNET)).code).toBe(
      "seller_price_invalid",
    );
  });

  it("checks the network, payTo and authorization lifetime", () => {
    expect(
      thrown(() => exact({ network: "stellar:futurenet" as typeof TESTNET, payTo, price: "$1" })).code,
    ).toBe("seller_network_unsupported");
    expect(thrown(() => exact({ network: TESTNET, payTo: "GABC", price: "$1" })).code).toBe(
      "seller_declaration_invalid",
    );
    expect(thrown(() => exact({ network: TESTNET, payTo, price: "$1", maxTimeoutSeconds: 5 })).code).toBe(
      "seller_declaration_invalid",
    );
    expect(exact({ network: TESTNET, payTo, price: "$1", maxTimeoutSeconds: 60 }).maxTimeoutSeconds).toBe(60);
  });

  it("sets the payment flow in the option's extra", () => {
    expect(exact({ network: TESTNET, payTo, price: "$1", paymentFlow: "upfront" }).extra).toEqual({
      paymentFlow: "upfront",
    });
    expect(price.extra).toBeUndefined();
    expect(
      thrown(() => exact({ network: TESTNET, payTo, price: "$1", paymentFlow: "escrow" as "upfront" })).code,
    ).toBe("seller_declaration_invalid");
  });

  it("declares upto with the cap as its price", () => {
    expect(upto({ network: TESTNET, payTo, maxPrice: "$0.10", maxTimeoutSeconds: 120 })).toEqual({
      scheme: "upto",
      network: TESTNET,
      payTo,
      price: { amount: "1000000", asset: usdc },
      maxTimeoutSeconds: 120,
    });
    expect(thrown(() => upto({ network: TESTNET, payTo, maxPrice: "$0" })).code).toBe("seller_price_invalid");
    const muxed = new MuxedAccount(new Account(payTo, "0"), "7").accountId();
    expect(thrown(() => upto({ network: TESTNET, payTo: muxed, maxPrice: "$0.10" })).code).toBe(
      "seller_declaration_invalid",
    );
  });

  it("refuses a muxed payTo for exact too: the exact verifier cannot match its transfer event", () => {
    const muxed = new MuxedAccount(new Account(payTo, "0"), "7").accountId();
    const error = thrown(() => exact({ network: TESTNET, payTo: muxed, price: "$0.01" }));
    expect(error.code).toBe("seller_declaration_invalid");
    expect(error.reason).toContain("muxed");
  });
});

describe("declarations", () => {
  it("builds a route config for the stock middleware", () => {
    const route = forecast();
    expect(route.key).toBe("GET /forecast/:city");
    expect(route.examplePath).toBe("/forecast/Ankara");
    expect(route.config).toMatchObject({
      accepts: [{ scheme: "exact", network: TESTNET, payTo, price: { amount: "100000", asset: usdc } }],
      description: "Seven-day weather forecast for a city",
      mimeType: "application/json",
      serviceName: "Weather API",
      tags: ["weather", "forecast"],
    });
    const bazaar = route.config.extensions?.["bazaar"] as { info: unknown; schema: unknown };
    expect(bazaar.info).toEqual({
      input: { type: "http", queryParams: { days: 3, units: "metric" } },
      output: { type: "json", example: { city: "Ankara", days: [{ high: 21, low: 9 }] } },
    });
    expect(JSON.stringify(bazaar.schema)).not.toMatch(/\$ref|\$id/);
  });

  it("requires a description on every parameter at any depth, naming its path", () => {
    const cases: [() => unknown, string][] = [
      [
        () =>
          httpRoute({
            method: "GET",
            path: "/a",
            description: "A resource",
            payment: price,
            query: { q: param.string({ description: "" }) },
          }),
        "query.q",
      ],
      [
        () =>
          httpRoute({
            method: "POST",
            path: "/a",
            description: "A resource",
            payment: price,
            body: {
              type: "json",
              params: {
                address: param.object(
                  { street: param.string({ description: "   " }) },
                  { description: "Address" },
                ),
              },
            },
          }),
        "body.address.street",
      ],
      [
        () =>
          mcpTool({
            endpoint: "https://tools.example.com/mcp",
            toolName: "t",
            description: "A tool",
            payment: price,
            arguments: {
              tags: param.array(param.string({ description: undefined as unknown as string }), {
                description: "Tags",
              }),
            },
          }),
        "arguments.tags[]",
      ],
      [
        () => httpRoute({ method: "GET", path: "/users/:id", description: "A user", payment: price }),
        "pathParams.id",
      ],
    ];
    for (const [declare, path] of cases) {
      const error = thrown(declare);
      expect(error.code).toBe("seller_param_description_required");
      expect(error.details).toEqual({ path });
      expect(error.reason).toContain(path);
    }
  });

  it.each<[string, () => unknown, RegExp]>([
    [
      "a required query parameter without an example",
      () =>
        httpRoute({
          method: "GET",
          path: "/a",
          description: "A resource",
          payment: price,
          query: { q: param.string({ description: "Query", required: true }) },
        }),
      /query\.q is required and needs an example/,
    ],
    [
      "an example that breaks its pattern",
      () =>
        httpRoute({
          method: "GET",
          path: "/a",
          description: "A resource",
          payment: price,
          query: { q: param.string({ description: "Query", pattern: "^[0-9]+$", example: "abc" }) },
        }),
      /query\.q the example does not satisfy/,
    ],
    [
      "an output example that is not an object",
      () =>
        httpRoute({
          method: "GET",
          path: "/a",
          description: "A resource",
          payment: price,
          output: { example: [1, 2] as unknown as Record<string, unknown> },
        }),
      /output\.example must be a JSON object/,
    ],
    [
      "an output schema with a reference",
      () =>
        httpRoute({
          method: "GET",
          path: "/a",
          description: "A resource",
          payment: price,
          output: { example: {}, schema: { $ref: "https://evil.example/schema.json" } },
        }),
      /self-contained/,
    ],
    [
      "a body on GET",
      () =>
        httpRoute({
          method: "GET",
          path: "/a",
          description: "A resource",
          payment: price,
          body: { type: "json", params: {} },
        }),
      /carry no body/,
    ],
    [
      "a path parameter that is not a string",
      () =>
        httpRoute({
          method: "GET",
          path: "/users/:id",
          description: "A user",
          payment: price,
          pathParams: { id: param.integer({ description: "User id" }) },
        }),
      /param\.string or param\.enum/,
    ],
    [
      "a path parameter the path does not have",
      () =>
        httpRoute({
          method: "GET",
          path: "/users",
          description: "Users",
          payment: price,
          pathParams: { id: param.string({ description: "User id" }) },
        }),
      /not a :name segment/,
    ],
    [
      "a wildcard path",
      () => httpRoute({ method: "GET", path: "/files/*", description: "Files", payment: price }),
      /unsupported segment/,
    ],
    [
      "tags the catalog would drop",
      () =>
        httpRoute({
          method: "GET",
          path: "/a",
          description: "A resource",
          payment: price,
          tags: ["ok", "ok"],
        }),
      /tags must be/,
    ],
    [
      "a raw JSON Schema instead of param.*",
      () =>
        httpRoute({
          method: "GET",
          path: "/a",
          description: "A resource",
          payment: price,
          query: { q: { type: "string" } as never },
        }),
      /must be declared with param/,
    ],
    [
      "a minimum above the maximum",
      () =>
        httpRoute({
          method: "GET",
          path: "/a",
          description: "A resource",
          payment: price,
          query: { n: param.number({ description: "N", minimum: 5, maximum: 1 }) },
        }),
      /minimum is greater than maximum/,
    ],
  ])("refuses %s", (_label, declare, reason) => {
    const error = thrown(declare);
    expect(error.code).toBe("seller_declaration_invalid");
    expect(error.reason).toMatch(reason);
  });

  it("refuses MCP endpoints the catalog cannot key", () => {
    const declare = (endpoint: string, network: StellarNetwork = TESTNET) =>
      thrown(() =>
        mcpTool({
          endpoint,
          toolName: "t",
          description: "A tool",
          payment: exact({ network, payTo, price: "$0.01" }),
          arguments: {},
        }),
      ).code;
    expect(declare("mcp://tool/t")).toBe("seller_endpoint_invalid");
    expect(declare("https://user:pass@tools.example.com/mcp")).toBe("seller_endpoint_invalid");
    expect(declare("http://tools.example.com/mcp", PUBNET)).toBe("seller_endpoint_invalid");
    expect(declare("not a url")).toBe("seller_endpoint_invalid");
  });

  it("gives an MCP tool a zod shape equivalent to its JSON Schema", () => {
    const declared = tool();
    const fromZod = normalize(z.toJSONSchema(z.object(declared.zodShape)));
    expect(fromZod).toEqual(normalize(declared.inputSchema));
    expect(declared.inputSchema).toMatchObject({ required: ["city"], additionalProperties: false });
    const bazaar = declared.payment.extensions["bazaar"] as { info: { input: Record<string, unknown> } };
    expect(bazaar.info.input).toEqual({
      type: "mcp",
      toolName: "air_quality",
      description: "Air quality index for a city",
      transport: "streamable-http",
      inputSchema: declared.inputSchema,
      example: { city: "Izmir" },
    });
    // The zod shape enforces what the schema says.
    const schema = z.object(declared.zodShape);
    const parse = (value: unknown) => schema.safeParse(value);
    expect(parse({ city: "Izmir", pollutants: ["pm25"] }).success).toBe(true);
    expect(parse({ city: "Izmir", pollutants: ["so2"] }).success).toBe(false);
    expect(parse({ location: { lat: 1, lon: 2 } }).success).toBe(false);
    expect(parse({ city: "Izmir", location: { lat: 91, lon: 2 } }).success).toBe(false);
  });

  it("turns tool options into payment requirements for createPaymentWrapper", async () => {
    const built: unknown[] = [];
    const config = await mcpPaymentConfig(
      {
        buildPaymentRequirements: (option) => {
          built.push(option);
          return Promise.resolve([
            {
              scheme: option.scheme,
              network: option.network,
              asset: option.price.asset,
              amount: option.price.amount,
              payTo: option.payTo,
              maxTimeoutSeconds: 300,
              extra: { areFeesSponsored: true },
            },
          ]);
        },
      },
      tool(),
    );
    expect(built).toHaveLength(1);
    expect(config.accepts).toMatchObject([{ amount: "100000", asset: usdc, payTo }]);
    expect(config.resource).toMatchObject({
      url: "https://tools.example.com/mcp",
      mimeType: "application/json",
    });
    expect(Object.keys(config.extensions)).toEqual(["bazaar"]);
  });
});

describe("validateListing uses the catalog's own rules", () => {
  it.each([
    ["an HTTP GET route with path and query parameters", forecast],
    ["an HTTP POST route with a nested JSON body", translate],
    ["an MCP tool", tool],
    [
      "a route without parameters",
      () =>
        httpRoute({
          method: "DELETE",
          path: "/cache",
          description: "Clear the cache",
          payment: price,
          output: { example: { ok: true } },
        }),
    ],
  ])("catalogs %s with nothing dropped and no lint", async (_label, declare) => {
    const report = await validateListing(declare(), { network: TESTNET, sandbox });
    expect(report).toMatchObject({ catalogable: true, dropped: [], lint: [] });
  });

  it("catalogs an upto route at its cap", async () => {
    const metered = httpRoute({
      method: "GET",
      path: "/report",
      description: "Metered report, charged by the rows returned",
      payment: upto({ network: TESTNET, payTo, maxPrice: "$0.05", maxTimeoutSeconds: 120 }),
      output: { example: { rows: 3 } },
    });
    const report = await validateListing(metered, { network: TESTNET, sandbox });
    expect(report).toMatchObject({ catalogable: true, dropped: [], lint: [] });
    expect(report.preview).toMatchObject({ amount: "500000", asset: usdc, payTo });
  });

  it("previews the listing identity the catalog would use", async () => {
    const report = await validateListing(forecast(), {
      network: TESTNET,
      concreteUrl: "https://api.example.com/forecast/Izmir",
      sandbox,
    });
    expect(report.preview).toEqual({
      resource: "https://api.example.com/forecast/:city",
      type: "http",
      method: "GET",
      routeTemplate: "/forecast/:city",
      payTo,
      asset: usdc,
      amount: "100000",
    });
    const mcp = await validateListing(tool(), { network: TESTNET, sandbox });
    expect(mcp.preview).toMatchObject({
      resource: "https://tools.example.com/mcp",
      type: "mcp",
      toolName: "air_quality",
    });
  });

  it("reports the network a declaration does not sell on", async () => {
    expect(await validateListing(forecast(), { network: PUBNET, sandbox })).toMatchObject({
      catalogable: false,
      code: "seller_network_unsupported",
    });
  });

  it("refuses loopback URLs unless allowed, as the catalog does", async () => {
    const options: ValidateListingOptions = {
      network: TESTNET,
      concreteUrl: "http://127.0.0.1:8080/forecast/Ankara",
      sandbox,
    };
    expect(await validateListing(forecast(), options)).toMatchObject({ catalogable: false });
    expect(await validateListing(forecast(), { ...options, allowLoopback: true })).toMatchObject({
      catalogable: true,
    });
  });

  const live = (bazaar: unknown): PaymentRequired => ({
    x402Version: 2,
    resource: { url: "https://api.example.com/search", description: "Search", mimeType: "application/json" },
    accepts: [
      {
        scheme: "exact",
        network: TESTNET,
        asset: usdc,
        amount: "1000",
        payTo,
        maxTimeoutSeconds: 60,
        extra: { areFeesSponsored: true },
      },
    ],
    ...(bazaar === undefined ? {} : { extensions: { bazaar } }),
  });

  it("lints a stock declaration without parameter descriptions or output example", async () => {
    const report = await validateListing(
      live(
        declareDiscoveryExtension({
          input: { q: "x" },
          inputSchema: { properties: { q: { type: "string" } } },
        })["bazaar"],
      ),
      { network: TESTNET, method: "GET", sandbox },
    );
    expect(report.catalogable).toBe(true);
    expect(report.preview).toMatchObject({ method: "GET" });
    expect(report.lint.map((finding) => [finding.code, finding.path])).toEqual([
      ["seller_param_description_missing", "input.queryParams.q"],
      ["seller_output_example_missing", "output.example"],
    ]);
  });

  it("reports a PaymentRequired without discovery metadata, and the catalog's own rejections", async () => {
    expect(await validateListing(live(undefined), { network: TESTNET, sandbox })).toMatchObject({
      catalogable: false,
      code: "seller_discovery_missing",
    });
    const external = declareDiscoveryExtension({
      input: {},
      inputSchema: { properties: { q: { $ref: "https://evil.example/q.json" } } },
    })["bazaar"];
    expect(await validateListing(live(external), { network: TESTNET, sandbox })).toMatchObject({
      catalogable: false,
      code: "bazaar_schema_external_reference",
    });
    const invalid = declareDiscoveryExtension({
      input: { q: 5 },
      inputSchema: { properties: { q: { type: "string", description: "Query" } } },
    })["bazaar"];
    const report = await validateListing(live(invalid), { network: TESTNET, sandbox });
    expect(report).toMatchObject({ catalogable: false, code: "bazaar_info_invalid" });
    expect(report.reason).not.toBe("");
  });
});

describe("settle dedupe", () => {
  const payload = {} as PaymentPayload;
  const requirements = {} as PaymentRequirements;
  const facilitator = (responses: SettleResponse[]): FacilitatorClient => ({
    verify: () => Promise.resolve({ isValid: true }),
    getSupported: () => Promise.resolve({ kinds: [], extensions: [], signers: {} }),
    settle: () => Promise.resolve(responses.shift() as SettleResponse),
  });
  const success = (transaction: string, extensionResponses?: Record<string, unknown>): SettleResponse => ({
    success: true,
    transaction,
    network: TESTNET,
    payer: "GPAYER",
    ...(extensionResponses === undefined ? {} : { extensionResponses }),
  });

  it("serves a settlement once and refuses its repeat", async () => {
    const repeats: unknown[] = [];
    const client = withSettleDedupe(facilitator([success("aa"), success("aa"), success("bb")]), {
      onRepeat: (event) => repeats.push(event),
    });
    expect(await client.settle(payload, requirements)).toMatchObject({ success: true, transaction: "aa" });
    const repeat = await client.settle(payload, requirements);
    expect(repeat).toMatchObject({
      success: false,
      errorReason: "seller_settlement_repeat",
      transaction: "aa",
      payer: "GPAYER",
    });
    expect(repeat.errorMessage).not.toBe("");
    expect(await client.settle(payload, requirements)).toMatchObject({ success: true, transaction: "bb" });
    expect(repeats).toEqual([{ network: TESTNET, transaction: "aa", detectedBy: "memory" }]);
  });

  it("trusts Rail402's repeat marker, even for a settlement it never saw", async () => {
    const marked = success("cc", {
      rail402: { settlement: { repeat: true, settledBy: "rail402" } },
      bazaar: {},
    });
    const client = withSettleDedupe(facilitator([marked, success("cc")]));
    expect(await client.settle(payload, requirements)).toMatchObject({
      success: false,
      errorReason: "seller_settlement_repeat",
    });
    // Remembered, so a later unmarked repeat is refused too.
    expect(await client.settle(payload, requirements)).toMatchObject({ success: false });
  });

  it("passes failures and marker-less facilitators through", async () => {
    const failed: SettleResponse = { success: false, errorReason: "x", transaction: "", network: TESTNET };
    const client = withSettleDedupe(facilitator([failed, success("dd", { bazaar: { status: "success" } })]));
    expect(await client.settle(payload, requirements)).toBe(failed);
    expect(await client.settle(payload, requirements)).toMatchObject({ success: true });
    expect(await client.getSupported()).toEqual({ kinds: [], extensions: [], signers: {} });
  });

  it("reads the marker defensively and forgets the oldest settlement first", () => {
    expect(repeatMarker(undefined)).toBe(false);
    expect(repeatMarker({ rail402: { settlement: { repeat: "yes" } } })).toBe(false);
    expect(repeatMarker({ rail402: [] })).toBe(false);
    const memory = new MemorySettlementMemory(2);
    expect([
      memory.claim("a"),
      memory.claim("b"),
      memory.claim("a"),
      memory.claim("c"),
      memory.claim("a"),
    ]).toEqual([true, true, false, true, true]);
    expect(() => new MemorySettlementMemory(0)).toThrow(RangeError);
  });
});

describe("seller codes", () => {
  it("never clash with the buyer's or the catalog's codes and all have reasons", () => {
    expect(() => mergeCodes(agentCodes, sellerCodes, bazaarCodes)).not.toThrow();
    for (const spec of Object.values(sellerCodes)) expect(spec.reason.trim()).not.toBe("");
  });
});

/** zod adds safe-integer bounds and `$schema`; neither changes what the schema accepts here. */
function normalize(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(normalize);
  if (schema === null || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$schema") continue;
    if ((key === "minimum" || key === "maximum") && Math.abs(value as number) === Number.MAX_SAFE_INTEGER)
      continue;
    out[key] = normalize(value);
  }
  return out;
}
