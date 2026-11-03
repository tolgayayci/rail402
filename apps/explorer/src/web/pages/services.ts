import type { SellerTotal } from "../../api/queries.ts";
import type { Answer, Listing } from "../bazaar.ts";
import {
  badge,
  bazaarDown,
  body,
  h,
  layout,
  listingTitle,
  monogram,
  note,
  pageHead,
  panel,
  schemeBadge,
  shortAddress,
  table,
  type Child,
} from "../components.ts";
import { ago, baseAccount, day, groupThousands } from "../format.ts";
import { displayText } from "../text.ts";
import { listingPrice, type PageContext } from "./context.ts";

/** A seller (payTo) and its listings: the unit the Explorer calls a service. */
export interface Service {
  readonly payTo: string;
  readonly name: string;
  readonly listings: readonly Listing[];
  /** Payments the seller received, from the ledger index; undefined when the index could not say. */
  readonly payments: number | undefined;
  readonly lastAt: string | undefined;
}

/** A service's name: a listing's serviceName, else the host its listings share, else its first resource. */
export function serviceName(listings: readonly Listing[]): string {
  const named = listings.find((listing) => listing.serviceName !== undefined)?.serviceName;
  if (named !== undefined) return displayText(named, 80);
  const hosts = new Set(
    listings.flatMap((listing) => {
      try {
        const url = new URL(listing.resource);
        return url.protocol === "https:" || url.protocol === "http:" ? [url.host] : [];
      } catch {
        return [];
      }
    }),
  );
  if (hosts.size === 1) return displayText([...hosts][0] ?? "", 80);
  const first = listings[0];
  return first === undefined ? "" : displayText(first.toolName ?? first.resource, 80);
}

/** Listings grouped by seller, the busiest on the ledger first. */
export function groupServices(
  listings: readonly Listing[],
  totals: ReadonlyMap<string, SellerTotal> | undefined,
): Service[] {
  const bySeller = new Map<string, Listing[]>();
  // A muxed payTo pays its base account: one seller.
  for (const listing of listings) {
    const seller = baseAccount(listing.payTo);
    const group = bySeller.get(seller) ?? [];
    group.push(listing);
    bySeller.set(seller, group);
  }
  return [...bySeller.entries()]
    .map(([payTo, group]) => {
      const total = totals?.get(payTo);
      return {
        payTo,
        name: serviceName(group),
        listings: group,
        payments: totals === undefined ? undefined : (total?.payments ?? 0),
        lastAt: total?.lastAt,
      };
    })
    .sort(
      (a, b) =>
        (b.payments ?? 0) - (a.payments ?? 0) ||
        b.listings.length - a.listings.length ||
        a.name.localeCompare(b.name),
    );
}

/** One line about a service's listings: "6 listings · HTTP and MCP · from 0.001 USDC". */
export function serviceDetail(context: PageContext, service: Service): string {
  const types = [...new Set(service.listings.map((listing) => listing.type.toUpperCase()))].sort();
  const [only] = service.listings;
  if (service.listings.length === 1 && only !== undefined) {
    const what = only.type === "mcp" ? "MCP tool" : listingTitle(only).replace(/^(\S+) [^/]+/, "$1 ");
    return `${what} · ${listingPrice(context, only)}`;
  }
  // A "from" price compares amounts of one asset only: atomic units of different tokens do not compare.
  const exact = service.listings.filter((listing) => listing.scheme === "exact");
  const oneAsset = new Set(exact.map((listing) => listing.asset)).size === 1;
  const cheapest = oneAsset
    ? [...exact].sort((a, b) =>
        BigInt(a.amount) < BigInt(b.amount) ? -1 : BigInt(a.amount) > BigInt(b.amount) ? 1 : 0,
      )[0]
    : undefined;
  return [
    `${String(service.listings.length)} listings`,
    types.join(" and "),
    cheapest === undefined ? "" : `from ${listingPrice(context, cheapest)}`,
  ]
    .filter((part) => part !== "")
    .join(" · ");
}

/** A service as one row of the home page's list. */
export function serviceItem(context: PageContext, service: Service): Child {
  const view = context.layout.view;
  return h(
    "div",
    { class: "item" },
    h("span", { class: "tile", "aria-hidden": "true" }, monogram(service.name)),
    h(
      "div",
      { class: "main" },
      h("a", { href: `${view.prefix}/account/${service.payTo}`, class: "strong" }, service.name),
      h("span", { class: "small muted" }, serviceDetail(context, service)),
    ),
    h(
      "div",
      { class: "end" },
      h("span", { class: "amount" }, service.payments === undefined ? "—" : groupThousands(service.payments)),
      h(
        "span",
        { class: "small muted" },
        service.lastAt === undefined ? "" : ago(service.lastAt, context.now),
      ),
    ),
  );
}

export interface ServicesModel {
  readonly services: Answer<readonly Service[]>;
}

export function servicesPage(context: PageContext, model: ServicesModel): string {
  const view = context.layout.view;
  const services = model.services.status === "ok" ? model.services.value : [];
  const listings = services.reduce((sum, service) => sum + service.listings.length, 0);
  return layout(
    {
      ...context.layout,
      section: "services",
      title: `Services (${view.label})`,
      path: "/services",
      description:
        "Paid HTTP endpoints and MCP tools in the Rail402 Bazaar, grouped by seller, with payments from the ledger.",
    },
    body(
      pageHead(
        { eyebrow: "Services in the Bazaar", split: true },
        h(
          "h1",
          null,
          `${groupThousands(services.length)} seller${services.length === 1 ? "" : "s"}, ${groupThousands(listings)} listing${listings === 1 ? "" : "s"}`,
        ),
        h(
          "p",
          { class: "muted" },
          "Paid HTTP endpoints and MCP tools listed in the Rail402 Bazaar after a settled payment, grouped by the account they pay. Payments come from the ledger; names and prices are the sellers' own listings (off chain).",
        ),
      ),
      !context.bazaar
        ? h(
            "p",
            { class: "notice", role: "status" },
            `No Bazaar is configured for ${view.label.toLowerCase()}.`,
          )
        : model.services.status === "down"
          ? bazaarDown()
          : null,
      services.map((service) =>
        panel(
          {
            title: service.name,
            id: `seller-${service.payTo.slice(0, 12).toLowerCase()}`,
            aside: h(
              "span",
              { class: "aside" },
              shortAddress(view, service.payTo),
              ` · ${service.payments === undefined ? "—" : groupThousands(service.payments)} payments on the ledger`,
              service.lastAt === undefined ? "" : ` · last ${ago(service.lastAt, context.now)}`,
            ),
          },
          table(
            "mid",
            [
              { label: "Resource" },
              { label: "Type" },
              { label: "Scheme" },
              { label: "Price", num: true },
              { label: "Updated", num: true },
            ],
            service.listings.map((listing) =>
              h(
                "tr",
                null,
                h(
                  "td",
                  null,
                  h(
                    "div",
                    { class: "cell" },
                    h(
                      "a",
                      { href: `${view.prefix}/resource/${listing.id}`, class: "mono" },
                      listingTitle(listing),
                    ),
                    listing.description === undefined
                      ? null
                      : h("span", { class: "small muted" }, displayText(listing.description, 160)),
                  ),
                ),
                h("td", null, badge(listing.type)),
                h("td", null, schemeBadge(listing.scheme)),
                h("td", { class: "num" }, listingPrice(context, listing)),
                h("td", { class: "num muted" }, day(listing.lastUpdated, false)),
              ),
            ),
          ),
          note(
            h("a", { href: `${view.prefix}/account/${service.payTo}` }, "Seller page"),
            ": every listing with the payments linked to it, and the payments not linked to any.",
          ),
        ),
      ),
      services.length === 0 && model.services.status !== "down" && context.bazaar
        ? panel({ label: "Services" }, h("p", { class: "empty" }, "No listings in the Bazaar yet."))
        : null,
    ),
  );
}
