import { entryKey } from "../catalog/types.js";
import type { CatalogEntry } from "../catalog/types.js";
import type { Judgment } from "./metrics.js";

/**
 * Evaluation corpus and judgment set, version 1.
 *
 * The corpus is representative rather than large: entries are shaped exactly like real cataloged
 * resources (including the `extensions.bazaar` block with its input schema), because the ranker
 * draws most of its signal from per-parameter descriptions and tool names. A corpus of bare titles
 * would flatter the ranker and measure nothing useful.
 *
 * Judgments are written as an agent would phrase a request, not as keyword queries — the endpoint
 * takes natural language, so evaluating it on keywords would measure the wrong thing.
 *
 * Grow this from: the example integrations, real catalog entries, zero-result queries observed in
 * production, and searches that never convert to a paid call.
 */

const iso = (d: string) => new Date(d).toISOString();

function http(
  resource: string,
  opts: {
    description?: string;
    serviceName?: string;
    tags?: string[];
    params?: Record<string, string>;
    settlements?: number;
    payers?: number;
    network?: string;
    payTo?: string;
    scheme?: string;
  } = {},
): CatalogEntry {
  const properties: Record<string, unknown> = {};
  for (const [name, description] of Object.entries(opts.params ?? {})) {
    properties[name] = { type: "string", description };
  }
  return {
    resource,
    type: "http",
    x402Version: 2,
    accepts: [
      {
        scheme: opts.scheme ?? "exact",
        network: opts.network ?? "stellar:testnet",
        amount: "1000000",
        asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        payTo: opts.payTo ?? "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO",
        maxTimeoutSeconds: 60,
        extra: { areFeesSponsored: true },
      },
    ],
    lastUpdated: iso("2026-07-01"),
    ...(opts.description === undefined ? {} : { description: opts.description }),
    ...(opts.serviceName === undefined ? {} : { serviceName: opts.serviceName }),
    ...(opts.tags === undefined ? {} : { tags: opts.tags }),
    extensions: {
      bazaar: {
        info: {
          input: { type: "http", method: "GET", inputSchema: { type: "object", properties } },
        },
      },
    },
    quality: {
      totalSettlements: opts.settlements ?? 1,
      uniquePayers: opts.payers ?? 1,
      firstSeenAt: iso("2026-06-01"),
    },
    ownerPayTo: opts.payTo ?? "GBHEGW3KWOY2OFH767EDALFGCUTBOEVBDQMCKU4APMDLQNBW5QV3W3KO",
  };
}

function mcp(
  resource: string,
  toolName: string,
  opts: { description?: string; serviceName?: string; tags?: string[]; params?: Record<string, string> } = {},
): CatalogEntry {
  const properties: Record<string, unknown> = {};
  for (const [name, description] of Object.entries(opts.params ?? {})) {
    properties[name] = { type: "string", description };
  }
  const base = http(resource, opts);
  return {
    ...base,
    type: "mcp",
    toolName,
    extensions: {
      bazaar: {
        info: {
          input: {
            type: "mcp",
            toolName,
            description: opts.description,
            inputSchema: { type: "object", properties },
          },
        },
      },
    },
  };
}

export const CORPUS: CatalogEntry[] = [
  http("https://api.weathervane.io/forecast", {
    serviceName: "Weathervane",
    description: "Sixteen-day weather forecast and current conditions for any coordinate.",
    tags: ["weather", "forecast", "climate"],
    params: { latitude: "Decimal latitude", longitude: "Decimal longitude", units: "metric or imperial" },
    settlements: 400, payers: 120,
  }),
  http("https://api.weathervane.io/airquality", {
    serviceName: "Weathervane",
    description: "Air quality index including PM2.5, ozone and pollen counts.",
    tags: ["air-quality", "pollution", "health"],
    params: { latitude: "Decimal latitude", longitude: "Decimal longitude" },
    settlements: 60, payers: 25,
  }),
  http("https://quotes.ledgerworks.dev/equity", {
    serviceName: "Ledgerworks", description: "Real-time equity price quotes for listed US stocks.",
    tags: ["stocks", "equities", "market-data"],
    params: { ticker: "Stock ticker symbol such as AAPL" },
    settlements: 900, payers: 300,
  }),
  http("https://quotes.ledgerworks.dev/fx", {
    serviceName: "Ledgerworks", description: "Foreign exchange rates between any two currencies.",
    tags: ["forex", "currency", "exchange-rate"],
    params: { base: "Base currency code", quote: "Quote currency code" },
    settlements: 200, payers: 80,
  }),
  http("https://api.transcribe.audio/v1/transcribe", {
    serviceName: "Transcribe", description: "Convert a recorded audio file into a text transcript with speaker labels.",
    tags: ["speech-to-text", "audio", "transcription"],
    params: { audioUrl: "Public URL of the audio file", language: "BCP-47 language tag" },
    settlements: 150, payers: 70,
  }),
  http("https://api.lingua.dev/translate", {
    serviceName: "Lingua", description: "Translate text between one hundred languages.",
    tags: ["translation", "language", "nlp"],
    params: { text: "Source text", targetLanguage: "Target language code" },
    settlements: 300, payers: 140,
  }),
  http("https://geo.atlas.tools/geocode", {
    serviceName: "Atlas Geo", description: "Convert a street address into latitude and longitude coordinates.",
    tags: ["geocoding", "maps", "address"],
    params: { address: "Free-form postal address" },
    settlements: 80, payers: 40,
  }),
  http("https://geo.atlas.tools/reverse", {
    serviceName: "Atlas Geo", description: "Convert latitude and longitude into the nearest street address.",
    tags: ["geocoding", "maps", "reverse"],
    params: { latitude: "Decimal latitude", longitude: "Decimal longitude" },
    settlements: 30, payers: 15,
  }),
  http("https://api.chainscope.xyz/stellar/account", {
    serviceName: "Chainscope", description: "Stellar account balances, trustlines and recent payment history.",
    tags: ["stellar", "blockchain", "explorer"],
    params: { accountId: "Stellar account address starting with G" },
    settlements: 500, payers: 210, network: "stellar:pubnet",
  }),
  http("https://api.sentimentlab.ai/score", {
    serviceName: "SentimentLab", description: "Sentiment and emotion scoring for a block of text.",
    tags: ["sentiment", "nlp", "analysis"],
    params: { text: "Text to analyze" },
    settlements: 45, payers: 20,
  }),
  mcp("https://mcp.finlytics.io/mcp", "financial_analysis", {
    serviceName: "Finlytics", description: "Deep fundamental analysis of a public company with a scored summary.",
    tags: ["finance", "analysis", "equities"],
    params: { ticker: "Company ticker symbol", analysisType: "quick or deep" },
  }),
  mcp("https://mcp.finlytics.io/mcp", "portfolio_risk", {
    serviceName: "Finlytics", description: "Value-at-risk and volatility metrics for a portfolio of holdings.",
    tags: ["finance", "risk", "portfolio"],
    params: { holdings: "JSON array of ticker and weight pairs" },
  }),
  mcp("https://mcp.scribe.tools/mcp", "summarize_document", {
    serviceName: "Scribe", description: "Summarize a long document into key points.",
    tags: ["summarization", "documents", "nlp"],
    params: { documentUrl: "URL of the document", maxPoints: "Maximum number of bullet points" },
  }),
  http("https://api.imagecraft.dev/generate", {
    serviceName: "ImageCraft", description: "Generate an image from a text prompt.",
    tags: ["image-generation", "ai", "art"],
    params: { prompt: "Text description of the desired image", style: "Artistic style" },
    settlements: 220, payers: 95,
  }),
  http("https://api.parcelwatch.com/track", {
    serviceName: "ParcelWatch", description: "Track a shipment across major couriers and get delivery estimates.",
    tags: ["shipping", "logistics", "tracking"],
    params: { trackingNumber: "Courier tracking number", carrier: "Carrier code" },
    settlements: 110, payers: 55,
  }),
];

export const JUDGMENTS: Judgment[] = [
  {
    query: "what is the weather going to be tomorrow",
    relevant: ["https://api.weathervane.io/forecast"],
    note: "Natural phrasing with no literal 'forecast' keyword overlap beyond 'weather'.",
  },
  {
    query: "air pollution and pollen levels",
    relevant: ["https://api.weathervane.io/airquality"],
    note: "Should not be outranked by the more popular sibling forecast endpoint.",
  },
  {
    query: "current stock price for a company",
    relevant: ["https://quotes.ledgerworks.dev/equity", entryKey("https://mcp.finlytics.io/mcp", "financial_analysis")],
  },
  {
    query: "convert dollars to euros exchange rate",
    relevant: ["https://quotes.ledgerworks.dev/fx"],
  },
  {
    query: "turn a recording into text",
    relevant: ["https://api.transcribe.audio/v1/transcribe"],
    note: "No shared keywords with the description at all — tests parameter and tag signal.",
  },
  {
    query: "translate a sentence into spanish",
    relevant: ["https://api.lingua.dev/translate"],
  },
  {
    query: "find coordinates for a street address",
    relevant: ["https://geo.atlas.tools/geocode", "https://geo.atlas.tools/reverse"],
    note: "Both geocoding endpoints are relevant; the forward one should rank first.",
  },
  {
    query: "look up a stellar wallet balance",
    relevant: ["https://api.chainscope.xyz/stellar/account"],
  },
  {
    query: "analyze how positive some text is",
    relevant: ["https://api.sentimentlab.ai/score"],
  },
  {
    query: "risk metrics for my investment portfolio",
    relevant: [entryKey("https://mcp.finlytics.io/mcp", "portfolio_risk")],
    note: "MCP tool keyed on (url, toolName); the sibling tool on the same URL must not win.",
  },
  {
    query: "summarize a long report",
    relevant: [entryKey("https://mcp.scribe.tools/mcp", "summarize_document")],
  },
  {
    query: "make a picture from a description",
    relevant: ["https://api.imagecraft.dev/generate"],
  },
  {
    query: "where is my package",
    relevant: ["https://api.parcelwatch.com/track"],
    note: "Colloquial phrasing; relies on tags and parameter names rather than the description.",
  },
  {
    query: "stellar blockchain data",
    relevant: ["https://api.chainscope.xyz/stellar/account"],
    filters: { network: "stellar:pubnet" },
    note: "Exercises a structured filter combined with a natural-language query.",
  },
];

/**
 * Regression floors. CI fails below these, which is what makes ranking quality a build gate rather
 * than an aspiration. Raise them as the ranker improves; never lower one to make a build pass
 * without recording why.
 */
export const THRESHOLDS = {
  precisionAt1: 0.75,
  recallAt5: 0.8,
  mrr: 0.8,
  ndcgAt10: 0.8,
  zeroResultRate: 0.0,
} as const;
