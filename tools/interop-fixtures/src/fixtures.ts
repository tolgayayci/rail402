/**
 * Bazaar interoperability fixtures. Every fixture is generated, not written by hand: its bazaar
 * extension comes from upstream `@x402/extensions` (`declareDiscoveryExtension`, then
 * `bazaarResourceServerExtension.enrichDeclaration` with the request context a seller's server
 * would see), fed with the examples of the x402 Bazaar specification (`specs/extensions/bazaar.md`,
 * Apache-2.0). Hosts are `*.example` names; accounts are derived from fixed labels, so the output
 * is the same on every run.
 */
import { createHash } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";

/** Circle USDC on each network (Stellar Asset Contracts). */
export const USDC = {
  "stellar:testnet": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  "stellar:pubnet": "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
} as const;

export type FixtureNetwork = keyof typeof USDC;

export interface InteropFixture {
  readonly id: string;
  readonly title: string;
  /** Where in the Bazaar specification the example comes from. */
  readonly source: string;
  /** The seller's 402 response, as its server would send it for the paid URL. */
  readonly paymentRequired: PaymentRequired;
  /** The concrete URL the buyer paid (for a dynamic route, one path of the route). */
  readonly paidUrl: string;
  /** The amount the settlement moved: the option's amount, or less for an `upto` payment. */
  readonly settledAmount: string;
  /** The account that paid. */
  readonly payer: string;
  /** What discovery publishes for the fixture's resource. */
  readonly expected: {
    readonly resource: string;
    readonly type: "http" | "mcp";
    readonly method?: string;
    readonly toolName?: string;
  };
}

/** A Stellar account derived from a label, the same on every run. */
export function accountFor(label: string): string {
  return Keypair.fromRawEd25519Seed(
    createHash("sha256").update(`rail402-interop:${label}`).digest(),
  ).publicKey();
}

/** The extension as the upstream server extension enriches it for an HTTP request. */
function enriched(declaration: Record<string, unknown>, method: string, path: string, routePattern?: string) {
  const extension = declaration["bazaar"];
  const enrich = bazaarResourceServerExtension.enrichDeclaration;
  if (enrich === undefined) throw new Error("the upstream bazaar server extension has no enrichDeclaration");
  return enrich(extension, {
    method,
    adapter: { getPath: () => path },
    ...(routePattern === undefined ? {} : { routePattern }),
  }) as Record<string, unknown>;
}

function option(
  network: FixtureNetwork,
  payTo: string,
  amount: string,
  scheme: "exact" | "upto" = "exact",
): PaymentRequirements {
  return {
    scheme,
    network,
    asset: USDC[network],
    payTo,
    amount,
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: true },
  };
}

/** Every fixture, in a fixed order. */
export function buildFixtures(): InteropFixture[] {
  const fixtures: InteropFixture[] = [];

  // Specification, "Example: GET Endpoint", with the service metadata it shows on `resource`.
  const weather = declareDiscoveryExtension({
    input: { city: "San Francisco" },
    inputSchema: { properties: { city: { type: "string" } }, required: ["city"] },
    output: { example: { city: "San Francisco", weather: "foggy", temperature: 60 } },
  });
  fixtures.push({
    id: "http-get",
    title: "GET endpoint with service metadata",
    source: "specs/extensions/bazaar.md, Example: GET Endpoint",
    paymentRequired: {
      x402Version: 2,
      error: "Payment required",
      resource: {
        url: "https://weather.example/weather",
        description: "Weather data endpoint",
        mimeType: "application/json",
        serviceName: "Example Weather",
        tags: ["weather", "forecast"],
        iconUrl: "https://weather.example/icon.png",
      },
      accepts: [option("stellar:testnet", accountFor("weather"), "10000")],
      extensions: { bazaar: enriched(weather, "GET", "/weather") },
    },
    paidUrl: "https://weather.example/weather",
    settledAmount: "10000",
    payer: accountFor("buyer-weather"),
    expected: { resource: "https://weather.example/weather", type: "http", method: "GET" },
  });

  // Specification, "Example: POST Endpoint", sold on pubnet (https only there).
  const search = declareDiscoveryExtension({
    bodyType: "json",
    input: { query: "example" },
    inputSchema: { properties: { query: { type: "string" } }, required: ["query"] },
    output: { example: { results: [] } },
  });
  fixtures.push({
    id: "http-post",
    title: "POST endpoint on pubnet",
    source: "specs/extensions/bazaar.md, Example: POST Endpoint",
    paymentRequired: {
      x402Version: 2,
      error: "Payment required",
      resource: {
        url: "https://search.example/search",
        description: "Search endpoint",
        mimeType: "application/json",
      },
      accepts: [option("stellar:pubnet", accountFor("search"), "20000")],
      extensions: { bazaar: enriched(search, "POST", "/search") },
    },
    paidUrl: "https://search.example/search",
    settledAmount: "20000",
    payer: accountFor("buyer-search"),
    expected: { resource: "https://search.example/search", type: "http", method: "POST" },
  });

  // Specification, "Example: MCP Tool", at an https endpoint.
  const tool = declareDiscoveryExtension({
    toolName: "financial_analysis",
    description: "Advanced AI-powered financial analysis",
    inputSchema: {
      type: "object",
      properties: {
        ticker: { type: "string" },
        analysis_type: { type: "string", enum: ["quick", "deep"] },
      },
      required: ["ticker"],
    },
    example: { ticker: "AAPL", analysis_type: "deep" },
    output: { example: { summary: "Strong fundamentals...", score: 8.5 } },
  });
  fixtures.push({
    id: "mcp-tool",
    title: "MCP tool at an https endpoint",
    source: "specs/extensions/bazaar.md, Example: MCP Tool",
    paymentRequired: {
      x402Version: 2,
      error: "Payment required",
      resource: {
        url: "https://tools.example/mcp",
        description: "Advanced AI-powered financial tools",
        mimeType: "application/json",
      },
      accepts: [option("stellar:testnet", accountFor("tools"), "50000")],
      extensions: { bazaar: tool["bazaar"] as unknown as Record<string, unknown> },
    },
    paidUrl: "https://tools.example/mcp",
    settledAmount: "50000",
    payer: accountFor("buyer-tools"),
    expected: { resource: "https://tools.example/mcp", type: "mcp", toolName: "financial_analysis" },
  });

  // Specification, "Dynamic Routes and routeTemplate": one listing for every path of the route.
  const user = declareDiscoveryExtension({
    input: {},
    inputSchema: { properties: {} },
    pathParamsSchema: { properties: { userId: { type: "string" } }, required: ["userId"] },
    output: { example: { id: "42", name: "Ada" } },
  });
  fixtures.push({
    id: "http-dynamic-route",
    title: "Dynamic route",
    source: "specs/extensions/bazaar.md, Dynamic Routes and routeTemplate",
    paymentRequired: {
      x402Version: 2,
      error: "Payment required",
      resource: {
        url: "https://users.example/users/42",
        description: "User profile",
        mimeType: "application/json",
      },
      accepts: [option("stellar:testnet", accountFor("users"), "1000")],
      extensions: { bazaar: enriched(user, "GET", "/users/42", "/users/:userId") },
    },
    paidUrl: "https://users.example/users/42",
    settledAmount: "1000",
    payer: accountFor("buyer-users"),
    expected: { resource: "https://users.example/users/:userId", type: "http", method: "GET" },
  });

  // Specification, "Service Metadata on resource", with another extension declared next to bazaar.
  const quotes = declareDiscoveryExtension({
    input: { symbol: "XLM" },
    inputSchema: { properties: { symbol: { type: "string" } }, required: ["symbol"] },
    output: { example: { symbol: "XLM", price: "0.12" } },
  });
  fixtures.push({
    id: "http-other-extension",
    title: "Service metadata and another declared extension",
    source: "specs/extensions/bazaar.md, Service Metadata on resource",
    paymentRequired: {
      x402Version: 2,
      error: "Payment required",
      resource: {
        url: "https://quotes.example/price",
        description: "Asset price quotes",
        mimeType: "application/json",
        serviceName: "Example Quotes",
        tags: ["prices", "markets"],
      },
      accepts: [option("stellar:pubnet", accountFor("quotes"), "5000")],
      extensions: {
        bazaar: enriched(quotes, "GET", "/price"),
        "payment-identifier": { info: { required: false }, schema: { type: "object" } },
      },
    },
    paidUrl: "https://quotes.example/price",
    settledAmount: "5000",
    payer: accountFor("buyer-quotes"),
    expected: { resource: "https://quotes.example/price", type: "http", method: "GET" },
  });

  // An upto offer: the listing shows the cap the seller offers, whatever a settlement moved.
  const history = declareDiscoveryExtension({
    input: { days: "2" },
    inputSchema: { properties: { days: { type: "string" } }, required: ["days"] },
    output: { example: { days: [] } },
  });
  fixtures.push({
    id: "http-upto",
    title: "upto offer settled below its cap",
    source: "specs/extensions/bazaar.md, Example: GET Endpoint (with an upto payment option)",
    paymentRequired: {
      x402Version: 2,
      error: "Payment required",
      resource: {
        url: "https://history.example/history",
        description: "Weather history",
        mimeType: "application/json",
      },
      accepts: [option("stellar:testnet", accountFor("history"), "100000", "upto")],
      extensions: { bazaar: enriched(history, "GET", "/history") },
    },
    paidUrl: "https://history.example/history",
    settledAmount: "6000",
    payer: accountFor("buyer-history"),
    expected: { resource: "https://history.example/history", type: "http", method: "GET" },
  });

  return fixtures;
}

/** The bytes a fixture is stored as: sorted keys, two-space indentation, a final newline. */
export function serialize(fixture: InteropFixture): string {
  return `${JSON.stringify(sortKeys(fixture), null, 2)}\n`;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sortKeys(item)]),
    );
  }
  return value;
}
