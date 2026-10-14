/**
 * The seller's metered resources, paid with the `upto` scheme: the buyer authorizes a cap and the
 * seller settles what the call used. `GET /history` charges per day of weather history returned
 * (`setUptoCharge`), and the MCP tool `hourly_forecast` charges per forecast hour (`chargeUpto`,
 * settled through `meteredToolServer`). Both are declared with the Rail402 seller helpers, so their
 * first settlement through Rail402 catalogs them, listed at their cap.
 */
import type { x402ResourceServer } from "@x402/core/server";
import {
  httpRoute,
  mcpTool,
  param,
  resolvePrice,
  upto,
  type HttpRouteDeclaration,
  type McpToolDeclaration,
  type PaymentOption,
  type Price,
} from "@rail402.dev/sdk/seller";

export const NETWORK = "stellar:testnet" as const;

/** Prices of the metered resources in whole units of the payment asset (USDC). */
export const METERED_PRICES = {
  /** The most one call to either metered resource can be charged. */
  cap: "0.01",
  /** `GET /history`: per day returned. */
  perDay: "0.0003",
  /** `hourly_forecast`: per forecast hour. */
  perHour: "0.0002",
} as const;

export const MAX_HISTORY_DAYS = 30;
export const MAX_FORECAST_HOURS = 48;

/** The token prices are paid in; Circle's testnet USDC when undefined. */
export type PriceAsset = { readonly contract: string; readonly decimals: number } | undefined;

function priceOf(amount: string, asset: PriceAsset): Price {
  return asset === undefined ? `$${amount}` : { amount, asset: asset.contract, decimals: asset.decimals };
}

/** An amount in base units of the payment asset. */
export function baseUnits(amount: string, asset: PriceAsset): bigint {
  return BigInt(resolvePrice(priceOf(amount, asset), NETWORK).amount);
}

/** The upto payment option for the metered resources: capped at `METERED_PRICES.cap`. */
export function meteredOption(payTo: string, asset: PriceAsset): PaymentOption {
  return upto({
    network: NETWORK,
    payTo,
    maxPrice: priceOf(METERED_PRICES.cap, asset),
    // Covers the handler and the settlement with room to spare; the authorization is single-use.
    maxTimeoutSeconds: 120,
  });
}

/**
 * Reads the facilitator's /supported through `server` once and checks that it serves upto on the
 * testnet. A failure is retried on the next call, so the metered resources come online once the
 * facilitator does.
 */
export function uptoReadiness(server: x402ResourceServer): () => Promise<void> {
  let ready: Promise<void> | undefined;
  return () => {
    ready ??= server
      .initialize()
      .then(() => {
        if (server.getSupportedKind(2, NETWORK, "upto") === undefined) {
          throw new Error(`the facilitator does not serve upto on ${NETWORK}`);
        }
      })
      .catch((error: unknown) => {
        ready = undefined;
        throw error;
      });
    return ready;
  };
}

/** `GET /history`: daily weather history, charged per day returned. */
export function declareHistoryRoute(payment: PaymentOption): HttpRouteDeclaration {
  return httpRoute({
    method: "GET",
    path: "/history",
    description: `Daily weather history for a city, metered: ${METERED_PRICES.perDay} USDC per day returned, at most ${METERED_PRICES.cap} USDC per call`,
    payment,
    query: {
      city: param.string({ description: "City name", required: true, example: "Istanbul", maxLength: 80 }),
      days: param.string({
        description: `Number of past days to return, 1-${String(MAX_HISTORY_DAYS)}; each day is charged`,
        required: true,
        example: "7",
        pattern: "^(?:[1-9]|[12][0-9]|30)$",
      }),
    },
    output: {
      example: {
        city: "Istanbul",
        days: [{ daysAgo: 1, high: 21, low: 12, conditions: "sunny" }],
        charged: { units: 1, amount: "3000" },
      },
    },
  });
}

/** The MCP tool `hourly_forecast`, charged per forecast hour. */
export function declareHourlyForecast(endpoint: string, payment: PaymentOption): McpToolDeclaration {
  return mcpTool({
    endpoint,
    toolName: "hourly_forecast",
    description: `Hourly weather forecast for a city, metered: ${METERED_PRICES.perHour} USDC per forecast hour, at most ${METERED_PRICES.cap} USDC per call`,
    payment,
    arguments: {
      city: param.string({ description: "City name", required: true, example: "Istanbul", maxLength: 80 }),
      hours: param.integer({
        description: `Number of hours ahead to forecast, 1-${String(MAX_FORECAST_HOURS)}; each hour is charged`,
        required: true,
        example: 12,
        minimum: 1,
        maximum: MAX_FORECAST_HOURS,
      }),
    },
    output: {
      example: {
        city: "Istanbul",
        hours: [{ hour: 1, temperature: 18, conditions: "cloudy" }],
        charged: { units: 1, amount: "2000" },
      },
    },
    transport: "streamable-http",
  });
}

/** A small, stable number for a city, so repeated calls give the same demonstration data. */
function seed(text: string): number {
  let value = 11;
  for (const char of text.toLowerCase()) value = (value * 37 + char.charCodeAt(0)) % 7919;
  return value;
}

const CONDITIONS = ["sunny", "cloudy", "rain", "windy", "fog"] as const;

/** The number of days a `/history` request asks for, or undefined when it is not 1-30. */
export function historyDays(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^[0-9]{1,2}$/.test(value)) return undefined;
  const days = Number(value);
  return days >= 1 && days <= MAX_HISTORY_DAYS ? days : undefined;
}

export function historyFor(city: string, days: number, perDay: bigint): Record<string, unknown> {
  const base = seed(city);
  return {
    city,
    days: Array.from({ length: days }, (_, index) => ({
      daysAgo: index + 1,
      high: 12 + ((base + index * 5) % 18),
      low: 2 + ((base + index * 3) % 10),
      conditions: CONDITIONS[(base + index) % CONDITIONS.length],
    })),
    charged: { units: days, amount: (perDay * BigInt(days)).toString() },
  };
}

export function hourlyForecastFor(city: string, hours: number, perHour: bigint): Record<string, unknown> {
  const base = seed(city);
  return {
    city,
    hours: Array.from({ length: hours }, (_, index) => ({
      hour: index + 1,
      temperature: 8 + ((base + index * 2) % 17),
      conditions: CONDITIONS[(base + index * 7) % CONDITIONS.length],
    })),
    charged: { units: hours, amount: (perHour * BigInt(hours)).toString() },
  };
}
