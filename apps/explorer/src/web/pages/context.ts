import type { RegistrySnapshot } from "@rail402.dev/x402-index";
import type { ReportDocument } from "../../api/report.ts";
import type { ListingRef } from "../bazaar.ts";
import type { LayoutOptions } from "../components.ts";
import { assetName, decimalAmount, displayContract, shortKey } from "../format.ts";
import { displayText } from "../text.ts";

/** What every page of a network gets. */
export interface PageContext {
  readonly layout: Omit<LayoutOptions, "title" | "path" | "section">;
  readonly registry: RegistrySnapshot;
  readonly report: ReportDocument | undefined;
  /** The time pages count ages from. */
  readonly now: number;
  /** Whether this network has a Bazaar to read listings from. */
  readonly bazaar: boolean;
}

/**
 * The name of an asset contract, only when the index verified it as a Stellar Asset Contract: a
 * Bazaar listing or a token can call itself anything, so its own symbol is never shown as an asset.
 */
export function verifiedAsset(context: PageContext, contract: string): string | undefined {
  const asset = context.report?.assets[contract];
  return asset?.verified === true && asset.code !== null
    ? assetName(context.layout.view.network, contract, asset.code, asset.issuer)
    : undefined;
}

/** A listing's price: "0.001 USDC", "≤ 0.01 USDC" for upto, atomic units of an unverified token. */
export function listingPrice(
  context: PageContext,
  listing: Pick<ListingRef, "amount" | "asset" | "scheme">,
): string {
  const code = verifiedAsset(context, listing.asset);
  const amount =
    code === undefined
      ? `${listing.amount} units of ${shortKey(displayText(listing.asset, 56))}`
      : `${decimalAmount(listing.amount)} ${code}`;
  return listing.scheme === "upto" ? `≤ ${amount}` : amount;
}

/** The allow-listed USDC contract of the report's network, when the index has seen it verified. */
export function usdcContract(report: ReportDocument | undefined): string | undefined {
  if (report === undefined) return undefined;
  const contract = displayContract(report.network, "USDC");
  return contract !== undefined && report.assets[contract]?.verified === true ? contract : undefined;
}
