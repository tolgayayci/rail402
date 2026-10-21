/** Bazaar listings, version histories and the agent's tools, as the engine returns them. */
import type { ListingView, VersionView } from "../../src/engine/events.ts";
import type { ToolDefinitionView } from "../../src/engine/types.ts";
import { IDS, URLS } from "./ids.ts";
import { field, listing } from "./views.ts";

export const LISTINGS = Object.freeze({
  weather: listing({
    id: IDS.listing.weather,
    resource: `${URLS.demoSeller}/weather`,
    description: "Current weather for a city",
    input: {
      fields: [
        field({ name: "city", in: "query", required: true, description: "City name", example: "Istanbul" }),
      ],
    },
  }),
  forecast: listing({
    id: IDS.listing.forecast,
    resource: `${URLS.demoSeller}/mcp`,
    type: "mcp",
    method: null,
    toolName: "hourly_forecast",
    description: "Hourly forecast for a city, billed per hour",
    price: { scheme: "upto", amount: "100000", decimal: "0.01", symbol: "USDC" },
    input: {
      fields: [
        field({
          name: "city",
          in: "argument",
          required: true,
          description: "City name",
          example: "Istanbul",
        }),
        field({
          name: "hours",
          in: "argument",
          kind: "integer",
          required: true,
          description: "Number of hours ahead to forecast, 1-48; each hour is charged",
          example: "12",
        }),
      ],
    },
  }),
  history: listing({
    id: IDS.listing.history,
    resource: `${URLS.demoSeller}/history`,
    description: "Daily weather history for a city, billed per day",
    price: { scheme: "upto", amount: "100000", decimal: "0.01", symbol: "USDC" },
    input: {
      fields: [
        field({ name: "city", in: "query", required: true, description: "City name", example: "Istanbul" }),
        field({
          name: "days",
          in: "query",
          required: true,
          description: "Number of past days",
          example: "7",
        }),
      ],
    },
  }),
  translate: listing({
    id: IDS.listing.translate,
    resource: `${URLS.demoSeller}/translate`,
    method: "POST",
    description: "Translate a short text into another language",
    price: { scheme: "exact", amount: "20000", decimal: "0.002", symbol: "USDC" },
    input: {
      fields: [
        field({ name: "to", in: "body", required: true, description: "Target language code", example: "tr" }),
        field({
          name: "text",
          in: "body",
          required: true,
          description: "Text to translate",
          example: "Hello",
        }),
      ],
    },
  }),
  airQuality: listing({
    id: IDS.listing.airQuality,
    resource: `${URLS.demoSeller}/mcp`,
    type: "mcp",
    method: null,
    toolName: "air_quality",
    description: "Current air quality index (AQI) for a city",
    input: {
      fields: [
        field({
          name: "city",
          in: "argument",
          required: true,
          description: "City name",
          example: "Istanbul",
        }),
        field({
          name: "pollutant",
          in: "argument",
          description: "Pollutant to report",
          options: ["pm25", "pm10", "o3", "no2"],
          example: "pm25",
        }),
      ],
    },
  }),
  sample: listing({
    id: IDS.listing.sample,
    resource: `${URLS.public}/lab/sell/forecast/:city`,
    description: "Playground sample: seven-day weather forecast for a city",
    serviceName: "Rail402 Playground",
    owner: IDS.playgroundPayTo,
    version: 2,
    settlements: 1,
    price: { scheme: "exact", amount: "100000", decimal: "0.01", symbol: "USDC" },
    input: { fields: [field({ name: "city", in: "path", required: true, example: "Ankara" })] },
  }),
} satisfies Record<string, ListingView>);

export const ALL_LISTINGS: readonly ListingView[] = Object.values(LISTINGS);

export const SAMPLE_VERSIONS: readonly VersionView[] = Object.freeze([
  {
    version: 1,
    createdAt: "2026-10-03T12:00:06Z",
    cause: "settlement",
    transaction: IDS.tx.sell,
    owner: IDS.playgroundPayTo,
    trust: "settled",
    state: "pending",
    reason: null,
  },
  {
    version: 2,
    createdAt: "2026-10-03T12:00:09Z",
    cause: "origin_verification",
    transaction: null,
    owner: IDS.playgroundPayTo,
    trust: "domain_verified",
    state: "published",
    reason: null,
  },
]);

export const TOOL_DEFINITIONS: readonly ToolDefinitionView[] = [
  {
    name: "search_stellar_resources",
    title: "Search paid Stellar resources",
    description: "Find paid APIs and tools by describing the task.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "pay_and_call",
    title: "Pay and call",
    description: "Pay within the limits, call the resource, and return the result and the receipt.",
    inputSchema: {
      type: "object",
      properties: { listingId: { type: "string" }, spendingCap: { type: "object" } },
      required: ["spendingCap"],
    },
  },
  {
    name: "get_budget",
    title: "Get budget",
    description: "See what has been spent and what is left.",
    inputSchema: { type: "object", properties: {} },
  },
];
