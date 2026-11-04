import { jsx } from "hono/jsx";
import type { SettlementRow } from "@rail402.dev/x402-index";
import type { ListingRef, PaidFor } from "./bazaar.ts";
import { NETWORK_VIEWS, assetName, decimalAmount, type NetworkView } from "./format.ts";
import { displayText } from "./text.ts";
import type { Section } from "./ui.ts";

/**
 * Pages are Hono JSX nodes built with `h`: every string child and attribute value is escaped when the
 * node renders. No module of the web role writes unescaped markup; pages.test.ts refuses the
 * helpers that would allow it anywhere in these sources.
 */
export type Node = ReturnType<typeof jsx>;
export type Child = Parameters<typeof jsx>[2];
type Props = Record<string, string | number | boolean | undefined | null>;

export function h(tag: string, props?: Props | null, ...children: Child[]): Node {
  const clean: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value !== undefined && value !== null && value !== false) clean[key] = value;
  }
  return jsx(tag, clean, ...children);
}

export function badge(text: Child, kind?: string, title?: string): Node {
  return h("span", { class: kind === undefined ? "badge" : `badge ${kind}`, title }, text);
}

export function schemeBadge(scheme: string): Node {
  const clean = displayText(scheme, 16);
  return badge(clean, clean === "upto" ? "upto" : "exact");
}

/** The name of a row's verified asset: allow-listed codes alone, any other with a short issuer. */
export const rowAsset = (row: Pick<SettlementRow, "asset" | "network">): string =>
  assetName(row.network, row.asset.contract, row.asset.code ?? "", row.asset.issuer);

/** An amount as short text: "0.001 USDC" for a verified asset, atomic units for a custom token. */
export function amountText(
  row: Pick<SettlementRow, "asset" | "amount" | "network">,
  atomic = row.amount,
): string {
  return row.asset.verified ? `${decimalAmount(atomic)} ${rowAsset(row)}` : `${atomic} units (custom token)`;
}

/** What a listing sells, as one short line: "GET demo.rail402.dev/weather" or "MCP air_quality". */
export function listingTitle(listing: Pick<ListingRef, "type" | "resource" | "method" | "toolName">): string {
  if (listing.type === "mcp") return `MCP ${displayText(listing.toolName ?? listing.resource, 128)}`;
  let where = listing.resource;
  try {
    const url = new URL(listing.resource);
    where = `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    // Not a URL: shown as it is.
  }
  return `${displayText(listing.method ?? "", 8)} ${displayText(where, 300)}`.trim();
}

/** The Bazaar listing of a row, by its outer or inner hash. */
export function paidForRow(
  paid: ReadonlyMap<string, PaidFor> | undefined,
  row: Pick<SettlementRow, "txHash" | "innerHash">,
): PaidFor | undefined {
  if (paid === undefined) return undefined;
  return paid.get(row.txHash) ?? (row.innerHash === null ? undefined : paid.get(row.innerHash));
}

/** Two letters for a service's tile: "demo.rail402.dev" gives "DE". */
export function monogram(name: string): string {
  const letters = name.replace(/^[a-z]+:\/\//, "").replace(/[^A-Za-z0-9]/g, "");
  return (letters.slice(0, 2) || "--").toUpperCase();
}

/** What every page of a network passes to the page shell (`ui.ts` `page`). */
export interface LayoutOptions {
  readonly title: string;
  readonly view: NetworkView;
  /** The networks this Explorer serves, for the network switch. */
  readonly networks: readonly NetworkView[];
  /** This page's path without the network prefix, so the switch opens the same page on the other network. */
  readonly path: string;
  readonly section?: Section;
  readonly versions: { readonly rules: string; readonly registry: string };
  readonly description?: string;
  /** Where service availability is reported. */
  readonly statusUrl?: string | undefined;
  /** Inline the stylesheet: a standalone snapshot file. */
  readonly standalone?: { readonly origin: string };
}

export const ALL_VIEWS = Object.values(NETWORK_VIEWS);
