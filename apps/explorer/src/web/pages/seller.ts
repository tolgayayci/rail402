import { h } from "../components.ts";
import { dayLabel, groupThousands, shortKey } from "../format.ts";
import { actionLink, bdg, card, networkPill, page, pageHead, pager, tile } from "../ui.ts";
import { usdcContract, type PageContext } from "./context.ts";
import {
  priceValue,
  serviceName,
  serviceTable,
  trustBadge,
  type Entry,
  type SellerTotals,
} from "./services.ts";

export interface SellerModel {
  /** The seller's base account (G… or C…). */
  readonly payTo: string;
  /** Its listings, most paid first. */
  readonly entries: readonly Entry[];
  readonly totals: SellerTotals | undefined;
  readonly page: number;
}

const PER_PAGE = 10;

/** A Bazaar seller: the account its listings pay, its services and what buyers paid them. */
export function sellerPage(context: PageContext, model: SellerModel): string {
  const view = context.layout.view;
  const p = view.prefix;
  const listings = model.entries.map((entry) => entry.listing);
  const host = serviceName(listings) || shortKey(model.payTo);
  const apis = listings.filter((listing) => listing.type === "http").length;
  const tools = listings.length - apis;
  const usdc = usdcContract(context.report);
  const prices = listings
    .filter((listing) => listing.asset === usdc)
    .map((listing) => priceValue(context, listing))
    .filter((value): value is number => value !== undefined);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const since = listings.map((listing) => listing.firstCataloged ?? listing.lastUpdated).sort()[0];
  // The seller's trust is its weakest listing's.
  const trust = listings.every((listing) => listing.trust === "domain_verified")
    ? "domain_verified"
    : listings.every((listing) => listing.trust === "domain_verified" || listing.trust === "origin_verified")
      ? "origin_verified"
      : listings[0]?.trust;
  const pages = Math.max(1, Math.ceil(model.entries.length / PER_PAGE));
  const at = Math.min(model.page, pages);
  const href = (n: number) => `${p}/seller/${model.payTo}${n > 1 ? `?page=${String(n)}` : ""}`;
  const account = `${p}/account/${model.payTo}`;
  return page(
    {
      ...context.layout,
      title: host,
      path: `/seller/${model.payTo}`,
      section: "bazaar",
      description: "A seller in the Rail402 Bazaar: its paid services, calls and buyers.",
    },
    pageHead({
      crumbs: [
        ["Bazaar", `${p}/services`],
        ["Seller", undefined],
      ],
      title: host,
      badges: [
        h("a", { class: "bdg", href: account, title: model.payTo }, shortKey(model.payTo)),
        trustBadge(trust),
        since === undefined ? null : bdg(`listed since ${dayLabel(since.slice(0, 10))}`, "mut"),
        networkPill(view),
      ],
      actions: [actionLink(account, "Account page", "arrow")],
    }),
    h(
      "div",
      { class: "g4" },
      tile({
        label: "Services",
        icon: "bazaar",
        value: groupThousands(listings.length),
        badges: [
          bdg(
            [apis > 0 ? `${groupThousands(apis)} API` : "", tools > 0 ? `${groupThousands(tools)} tool` : ""]
              .filter((part) => part !== "")
              .join(" · "),
            "mut",
          ),
        ],
      }),
      tile({
        label: "Paid calls",
        icon: "payments",
        value: model.totals === undefined ? "—" : groupThousands(model.totals.payments),
        badges: [bdg("all services", "mut")],
      }),
      tile({
        label: "Buyers",
        icon: "user",
        value: model.totals === undefined ? "—" : groupThousands(model.totals.payers),
        badges: [bdg("unique", "mut")],
      }),
      tile({
        label: "Prices",
        icon: "tag",
        value: prices.length === 0 ? "—" : low === high ? String(low) : `${String(low)}–${String(high)}`,
        unit: prices.length === 0 ? undefined : "USDC",
        badges: [bdg("per call", "mut")],
      }),
    ),
    card(
      { title: "Services by this seller", icon: "list", cls: "oc-gap" },
      serviceTable(
        context,
        "Services by this seller",
        model.entries.slice((at - 1) * PER_PAGE, at * PER_PAGE),
      ),
      pager({ page: at, pages, total: model.entries.length, perPage: PER_PAGE, href }),
    ),
  );
}
