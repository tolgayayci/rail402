import type { ResourceServerExtension } from "@x402/core/types";
import { bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { TESTNET } from "@rail402.dev/stellar";
import { exact, httpRoute, param, type HttpRouteDeclaration } from "@rail402.dev/sdk/seller";
import type { PlaygroundConfig } from "../config.ts";
import { LAB_PATHS, LAB_PRICES, SCENARIO_DEFAULTS } from "../shared/lab.ts";

/**
 * The sandbox seller: `GET /lab/sell/forecast/:city`, exact, 0.01 of the configured asset, paid to the
 * Playground's own testnet account, with Bazaar discovery metadata. Its route template makes one
 * listing for every city and every visitor. The 402 and the response are deterministic, so the
 * catalog's origin check confirms the listing whenever it runs.
 */

const CITY_MAX = 80;
const DAYS = 7;
const CONDITIONS = ["sunny", "partly cloudy", "cloudy", "light rain", "showers", "windy", "clear"] as const;

export interface Forecast {
  readonly city: string;
  readonly days: readonly {
    readonly day: number;
    readonly high: number;
    readonly low: number;
    readonly conditions: string;
  }[];
  readonly source: string;
}

/**
 * A city name the sandbox accepts: letters (any script), marks, spaces, dots, apostrophes and hyphens,
 * at most 40 characters. Anything else is not a city and gets no 402, so free text never reaches the
 * listing's metadata.
 */
const CITY = /^[\p{L}\p{M}][\p{L}\p{M} .'-]{0,39}$/u;

/** The decoded city of a sandbox path, or undefined when it is not one the sandbox accepts. */
export function cityOf(path: string): string | undefined {
  const match = /^\/lab\/sell\/forecast\/([^/]+)$/.exec(path);
  if (match?.[1] === undefined) return undefined;
  let city: string;
  try {
    city = decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
  return CITY.test(city) ? city : undefined;
}

/**
 * The stock Bazaar resource-server extension, except that the declared example path parameters stay
 * in every 402: the stock one copies the request's own path into `info.input.pathParams`, which would
 * let whoever pays first set the shared listing's example.
 */
export const sellBazaarExtension: ResourceServerExtension = {
  ...bazaarResourceServerExtension,
  enrichDeclaration(declaration, transportContext) {
    const enrich = bazaarResourceServerExtension.enrichDeclaration;
    const enriched: unknown = enrich === undefined ? declaration : enrich(declaration, transportContext);
    return withExamplePathParams(enriched, { city: SCENARIO_DEFAULTS.sell.city });
  },
};

function withExamplePathParams(declaration: unknown, example: Readonly<Record<string, string>>): unknown {
  if (typeof declaration !== "object" || declaration === null) return declaration;
  const record = declaration as { info?: { input?: Record<string, unknown> } };
  const input = record.info?.input;
  if (input === undefined || !("pathParams" in input)) return declaration;
  return { ...record, info: { ...record.info, input: { ...input, pathParams: { ...example } } } };
}

/** The route declaration, priced in the configured asset. */
export function declareSellRoute(config: PlaygroundConfig, payTo: string): HttpRouteDeclaration {
  const city = SCENARIO_DEFAULTS.sell.city;
  return httpRoute({
    method: "GET",
    path: LAB_PATHS.sell,
    description: "Playground sample: seven-day weather forecast for a city",
    serviceName: "Rail402 Playground sample",
    tags: ["weather", "forecast", "sample"],
    payment: exact({
      network: TESTNET,
      payTo,
      price: {
        amount: LAB_PRICES.sell.decimal,
        asset: config.asset.contract,
        decimals: config.asset.decimals,
      },
    }),
    pathParams: {
      city: param.string({ description: "City name", example: city, maxLength: CITY_MAX }),
    },
    output: { example: { ...forecastFor(city) } },
  });
}

/** A forecast that depends on the city name only, so every call and every origin check agree. */
export function forecastFor(city: string): Forecast {
  const name = city.slice(0, CITY_MAX);
  let seed = 2_166_136_261;
  for (const char of name.toLowerCase())
    seed = Math.imul(seed ^ (char.codePointAt(0) ?? 0), 16_777_619) >>> 0;
  return {
    city: name,
    days: Array.from({ length: DAYS }, (_, index) => {
      const value = (seed >>> (index % 24)) + index * 7;
      const high = 12 + (value % 17);
      return {
        day: index + 1,
        high,
        low: high - 4 - (value % 6),
        conditions: CONDITIONS[value % CONDITIONS.length] ?? "clear",
      };
    }),
    source: "Rail402 Playground sample data",
  };
}
