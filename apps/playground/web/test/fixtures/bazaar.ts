/** Bazaar listings, version histories, a seller check and the agent's tools, as the engine returns them. */
import type { ListingView, VersionView } from "../../src/engine/events.ts";
import type { SellerCheckView, ToolDefinitionView } from "../../src/engine/types.ts";
import { IDS, URLS } from "./ids.ts";
import { listing, option, required } from "./views.ts";

export const LISTINGS = Object.freeze({
  weather: listing({
    id: IDS.listing.weather,
    resource: `${URLS.demoSeller}/weather`,
    description: "Current weather for a city",
  }),
  forecast: listing({
    id: IDS.listing.forecast,
    resource: `${URLS.demoSeller}/mcp`,
    type: "mcp",
    method: null,
    toolName: "hourly_forecast",
    description: "Hourly forecast for a city, billed per hour",
    price: { scheme: "upto", amount: "100000", decimal: "0.01", symbol: "USDC" },
  }),
  history: listing({
    id: IDS.listing.history,
    resource: `${URLS.demoSeller}/history`,
    description: "Daily weather history for a city, billed per day",
    price: { scheme: "upto", amount: "100000", decimal: "0.01", symbol: "USDC" },
  }),
  translate: listing({
    id: IDS.listing.translate,
    resource: `${URLS.demoSeller}/translate`,
    method: "POST",
    description: "Translate a short text into another language",
    price: { scheme: "exact", amount: "20000", decimal: "0.002", symbol: "USDC" },
  }),
  airQuality: listing({
    id: IDS.listing.airQuality,
    resource: `${URLS.demoSeller}/mcp`,
    type: "mcp",
    method: null,
    toolName: "air_quality",
    description: "Current air quality index (AQI) for a city",
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

export const SELLER_CHECK: SellerCheckView = Object.freeze({
  url: `${URLS.demoSeller}/weather?city=Ankara`,
  type: "http",
  ok: true,
  status: 402,
  required: required(`${URLS.demoSeller}/weather`, [option({ verdict: null })], {
    bazaar: { declared: true, type: "http", method: "GET", toolName: null },
  }),
  validation: {
    catalogable: true,
    code: null,
    reason: null,
    dropped: [],
    lint: [],
    preview: { type: "http", method: "GET", resource: `${URLS.demoSeller}/weather` },
  },
  findings: [],
  receivable: [{ asset: IDS.usdc, payTo: IDS.demoPayTo, receivable: true }],
  domain: { host: "demo.rail402.dev", claimsOwner: true, homeDomainMatches: true },
});

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
