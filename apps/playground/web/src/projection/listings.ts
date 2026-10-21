/**
 * The Bazaar page's view of listings: names, prices and filters for the list, and the call form a
 * listing's declared fields make (initial values, typed parameters, the URL a call reaches). Listing
 * text is the seller's: shown as text only.
 */
import type { JsonValue, ListingField, ListingView } from "../engine/events.ts";
import { displayUrl, toAtomic } from "./format.ts";

export type BazaarFilter = "all" | "http" | "mcp" | "exact" | "upto" | "verified";

export const BAZAAR_FILTERS: readonly { readonly id: BazaarFilter; readonly label: string }[] = [
  { id: "all", label: "All" },
  { id: "http", label: "HTTP" },
  { id: "mcp", label: "MCP tools" },
  { id: "exact", label: "Fixed price" },
  { id: "upto", label: "Pay per use" },
  { id: "verified", label: "Verified sellers" },
];

export function isBazaarFilter(value: string | null): value is BazaarFilter {
  return BAZAAR_FILTERS.some((filter) => filter.id === value);
}

export function matchesFilter(listing: ListingView, filter: BazaarFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "http":
    case "mcp":
      return listing.type === filter;
    case "exact":
    case "upto":
      return listing.price?.scheme === filter;
    case "verified":
      return listing.trust === "domain_verified";
  }
}

/** How many listings each filter keeps. */
export function filterCounts(listings: readonly ListingView[]): Readonly<Record<BazaarFilter, number>> {
  const counts = { all: 0, http: 0, mcp: 0, exact: 0, upto: 0, verified: 0 };
  for (const listing of listings) {
    for (const { id } of BAZAAR_FILTERS) if (matchesFilter(listing, id)) counts[id] += 1;
  }
  return counts;
}

/** The scheme a listing's badge shows; null for a scheme the page has no colour for. */
export function schemeOf(listing: ListingView): "exact" | "upto" | null {
  const scheme = listing.price?.scheme;
  return scheme === "exact" || scheme === "upto" ? scheme : null;
}

/** A listing's name in the list: an MCP tool by its tool name, an HTTP resource by its description. */
export function listingTitle(listing: ListingView): string {
  if (listing.type === "mcp" && listing.toolName !== null) return listing.toolName;
  return listing.description ?? displayUrl(listing.resource);
}

/** The detail panel's heading: the seller's description, else the list name. */
export function listingHeading(listing: ListingView): string {
  return listing.description ?? listingTitle(listing);
}

/** What a call reaches, in one line: `GET demo.example/weather`, `MCP tool air_quality · demo.example/mcp`. */
export function listingCall(listing: ListingView): string {
  if (listing.type === "mcp") {
    return `MCP tool ${listing.toolName ?? "?"} · ${displayUrl(listing.resource)}`;
  }
  return `${listing.method ?? "GET"} ${displayUrl(listing.resource)}`;
}

export interface ListingPrice {
  /** The decimal amount, or base units when the asset is outside the policy. */
  readonly amount: string;
  readonly symbol: string;
  /** Upto: the amount is the most a call can be charged. */
  readonly upto: boolean;
  /** Decimal, for comparing with a cap; null when unknown. */
  readonly decimal: string | null;
}

export function listingPrice(listing: ListingView, fallbackSymbol: string): ListingPrice | null {
  const price = listing.price;
  if (price === null) return null;
  return {
    amount: price.decimal ?? price.amount,
    symbol: price.decimal === null ? "base units" : (price.symbol ?? fallbackSymbol),
    upto: price.scheme === "upto",
    decimal: price.decimal,
  };
}

/** The price in words: `0.001 USDC per call`, `up to 0.01 USDC per call`. */
export function priceWords(price: ListingPrice | null): string {
  if (price === null) return "Unknown";
  return `${price.upto ? "up to " : ""}${price.amount} ${price.symbol} per call`;
}

/** Whether the price is above the cap, so the buyer would refuse it before signing. */
export function priceAboveCap(price: ListingPrice | null, cap: string, decimals: number): boolean {
  if (price?.decimal === null || price === null) return false;
  const amount = toAtomic(price.decimal, decimals);
  const limit = toAtomic(cap.trim(), decimals);
  return amount !== undefined && limit !== undefined && amount > limit;
}

/** The form's first values: the seller's example, else the first allowed value, else empty. */
export function initialValues(fields: readonly ListingField[]): Readonly<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const field of fields) {
    values[field.name] = field.example ?? (field.required ? (field.options?.[0] ?? "") : "");
  }
  return values;
}

export type CallParams =
  | { readonly ok: true; readonly params: Readonly<Record<string, JsonValue>> }
  | { readonly ok: false; readonly field: string; readonly message: string };

/**
 * The call's parameters from the form, typed as the schema declares them. Empty optional fields are
 * left out; an empty required field, or a number that does not parse, names the field to fix.
 */
export function callParams(
  fields: readonly ListingField[],
  values: Readonly<Record<string, string>>,
): CallParams {
  const params: Record<string, JsonValue> = {};
  for (const field of fields) {
    const raw = (values[field.name] ?? "").trim();
    if (raw === "") {
      if (field.required) return { ok: false, field: field.name, message: `Fill in ${field.name}.` };
      continue;
    }
    switch (field.kind) {
      case "integer":
      case "number": {
        const number = Number(raw);
        const valid = Number.isFinite(number) && (field.kind === "number" || Number.isInteger(number));
        if (!valid) {
          return {
            ok: false,
            field: field.name,
            message: `${field.name} must be ${field.kind === "integer" ? "a whole number" : "a number"}.`,
          };
        }
        params[field.name] = number;
        break;
      }
      case "boolean":
        if (raw !== "true" && raw !== "false")
          return { ok: false, field: field.name, message: `${field.name} must be true or false.` };
        params[field.name] = raw === "true";
        break;
      case "string":
        params[field.name] = raw;
        break;
    }
  }
  return { ok: true, params };
}

/**
 * The URL an HTTP call reaches with these parameters: path segments filled, query fields added.
 * Undefined for an MCP tool, or when a path value is missing or could walk the path.
 */
export function callUrl(
  listing: ListingView,
  params: Readonly<Record<string, JsonValue>>,
): string | undefined {
  if (listing.type !== "http" || !URL.canParse(listing.resource)) return undefined;
  const url = new URL(listing.resource);
  const fields = listing.input?.fields ?? [];
  const segments = url.pathname.split("/").map((segment) => {
    const name = /^:([A-Za-z_][A-Za-z0-9_.-]*)$/.exec(segment)?.[1];
    if (name === undefined) return segment;
    const value = params[name];
    if (typeof value !== "string" && typeof value !== "number") return undefined;
    const text = String(value);
    if (text === "." || text === ".." || Array.from(text, (char) => char.charCodeAt(0)).some(isControl))
      return undefined;
    return encodeURIComponent(text);
  });
  if (segments.some((segment) => segment === undefined)) return undefined;
  url.pathname = segments.join("/");
  for (const field of fields) {
    const value = params[field.name];
    if (field.in !== "query" || value === undefined || value === null || typeof value === "object") continue;
    url.searchParams.set(field.name, String(value));
  }
  return url.href;
}

function isControl(code: number): boolean {
  return code < 0x20 || code === 0x7f;
}

/**
 * A result's headline, when its pairs are a reading of a well-known shape: a numeric `temperature`
 * (with `conditions` and `city`), or a numeric `aqi` (with `category`, `pollutant` and `city`). The
 * names are common ones, not one seller's: a result of any other shape, from any seller, simply has no
 * headline and shows all its pairs. Values stay the seller's text; only the shape is recognized.
 */
export interface ResultHeadline {
  readonly value: string;
  readonly caption: string;
  /** The weather words, for an icon: `sunny`, `cloudy`, `light rain`. */
  readonly conditions: string | null;
  /** The pairs the headline shows, which the result's list leaves out. */
  readonly used: readonly string[];
}

export function resultHeadline(
  pairs: readonly { readonly label: string; readonly value: string }[],
): ResultHeadline | null {
  const value = (label: string): string | undefined => pairs.find((pair) => pair.label === label)?.value;
  const present = (labels: readonly string[]): string[] =>
    labels.filter((label) => value(label) !== undefined);
  const city = value("city");
  const temperature = value("temperature");
  if (temperature !== undefined && /^-?\d+(\.\d+)?$/.test(temperature)) {
    const conditions = value("conditions") ?? null;
    return {
      value: `${temperature}°`,
      caption: [conditions, city].filter((part) => part !== undefined && part !== null).join(" · "),
      conditions,
      used: present(["temperature", "conditions", "city"]),
    };
  }
  const aqi = value("aqi");
  if (aqi !== undefined && /^\d+$/.test(aqi)) {
    return {
      value: `AQI ${aqi}`,
      caption: [value("category"), value("pollutant"), city].filter((part) => part !== undefined).join(" · "),
      conditions: null,
      used: present(["aqi", "category", "pollutant", "city"]),
    };
  }
  return null;
}
