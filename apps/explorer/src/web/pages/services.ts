import type { SellerTotal } from "../../api/queries.ts";
import type { Answer, BazaarSession, Listing } from "../bazaar.ts";
import { h, listingTitle, monogram, type Child, type Node } from "../components.ts";
import { ago, baseAccount, decimalAmount, groupThousands, shortKey } from "../format.ts";
import { displayText } from "../text.ts";
import {
  bdg,
  card,
  cell,
  dataTable,
  empty,
  iconBox,
  networkPill,
  page,
  pageHead,
  pager,
  schemePill,
  seg,
  svgIcon,
  tableRow,
  tile,
  type BadgeKind,
  type IconName,
} from "../ui.ts";
import { listingPrice, verifiedAsset, type PageContext } from "./context.ts";
import { shortAgo } from "./facilitators.ts";

// --- sellers as the overview lists them ----------------------------------------------------------------

/** A seller (payTo) and its listings: the unit the overview calls a service. */
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
  const hosts = new Set(listings.flatMap((listing) => hostOf(listing.resource) ?? []));
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

/** A service as one row of the overview's list. */
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

// --- the Bazaar catalog ------------------------------------------------------------------------------

/** A listing with the settled payments the Bazaar links to it; undefined counts when it did not say. */
export interface Entry {
  readonly listing: Listing;
  /** The base account it pays: its seller. */
  readonly seller: string;
  readonly payments: number | undefined;
  readonly payers: number | undefined;
  readonly lastAt: string | null | undefined;
}

export interface SellerTotals {
  readonly payments: number;
  readonly payers: number;
}

export interface Catalog {
  readonly entries: readonly Entry[];
  /** Each seller's totals over all its listings, when the Bazaar gave them. */
  readonly sellers: ReadonlyMap<string, SellerTotals>;
}

/** Sellers whose usage one page asks for; beyond them listings show no counts. */
const MAX_SELLERS = 40;

/**
 * The Bazaar's listings of a network with each one's paid calls, buyers and last payment: one seller
 * usage call per seller (at most `MAX_SELLERS`, 8 at a time), each answer cached by the client.
 */
export async function loadCatalog(bazaar: BazaarSession): Promise<Answer<Catalog>> {
  const listings = await bazaar.listings();
  if (listings.status !== "ok") return listings;
  const sellers = [...new Set(listings.value.map((listing) => baseAccount(listing.payTo)))].slice(
    0,
    MAX_SELLERS,
  );
  const usage = new Map<string, { payments: number; payers: number; lastAt: string | null }>();
  const totals = new Map<string, SellerTotals>();
  for (let start = 0; start < sellers.length; start += 8) {
    const answers = await Promise.all(
      sellers.slice(start, start + 8).map((seller) => bazaar.sellerUsage(seller)),
    );
    for (const answer of answers) {
      if (answer.status !== "ok") continue;
      totals.set(answer.value.payTo, answer.value.totals);
      for (const item of answer.value.listings)
        usage.set(item.listing.id, {
          payments: item.payments,
          payers: item.payers,
          lastAt: item.lastObservedAt,
        });
    }
  }
  return {
    status: "ok",
    value: {
      entries: listings.value.map((listing): Entry => {
        const seller = baseAccount(listing.payTo);
        const found = usage.get(listing.id);
        // A seller that answered and left a listing out has no payments linked to it.
        const known = found !== undefined || totals.has(seller);
        return {
          listing,
          seller,
          payments: known ? (found?.payments ?? 0) : undefined,
          payers: known ? (found?.payers ?? 0) : undefined,
          lastAt: known ? (found?.lastAt ?? null) : undefined,
        };
      }),
      sellers: totals,
    },
  };
}

// --- how a listing is shown ----------------------------------------------------------------------------

/** The host of an http(s) URL, or undefined. */
export function hostOf(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.host : undefined;
  } catch {
    return undefined;
  }
}

/** A listing's name: the first clause of its description, else what it sells ("GET host/path"). */
export function listingName(listing: Listing): string {
  const description = listing.description === undefined ? "" : displayText(listing.description, 400).trim();
  const clause = description.split(/(?<=\S)(?:[.;:]\s|,\s)/)[0]?.trim() ?? "";
  if (clause.length >= 6) return clause.length > 64 ? `${clause.slice(0, 63).trimEnd()}…` : clause;
  return listing.type === "mcp"
    ? displayText(listing.toolName ?? listing.resource, 64)
    : listingTitle(listing);
}

/** Where a listing is: "host/path" for an endpoint, "host · tool" for an agent tool. */
export function listingWhere(listing: Listing): string {
  let where = displayText(listing.resource, 300);
  try {
    const url = new URL(listing.resource);
    where = `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    // Not a URL: shown as it is.
  }
  return listing.type === "mcp"
    ? `${hostOf(listing.resource) ?? where} · ${displayText(listing.toolName ?? "", 64)}`
    : where;
}

/** A listing's line icon. */
export const listingIcon = (listing: Listing): IconName => (listing.type === "mcp" ? "tool" : "globe");

/** The price as a number of whole tokens, only for a verified asset (others do not compare). */
export function priceValue(context: PageContext, listing: Listing): number | undefined {
  return verifiedAsset(context, listing.asset) === undefined
    ? undefined
    : Number(decimalAmount(listing.amount).replaceAll(",", ""));
}

/** "0.001 USDC", "up to 0.01 USDC", or atomic units of an unverified token. */
export function priceText(context: PageContext, listing: Listing): string {
  const code = verifiedAsset(context, listing.asset);
  const amount = code === undefined ? `${listing.amount} units` : `${decimalAmount(listing.amount)} ${code}`;
  return listing.scheme === "upto" ? `up to ${amount}` : amount;
}

export const TRUST: Readonly<Record<string, readonly [string, BadgeKind]>> = {
  domain_verified: ["Domain verified", "ok"],
  origin_verified: ["Origin verified", "info"],
  settled: ["Listed after payment", "mut"],
};

export const trustBadge = (trust: string | undefined): Node => {
  const known = trust === undefined ? undefined : TRUST[trust];
  return known === undefined
    ? bdg(trust === undefined ? "Not checked" : displayText(trust, 32).replaceAll("_", " "), "mut")
    : bdg(known[0], known[1]);
};

/** An API or agent-tool pill with a count: "12 API", "8 tool". */
export const typeCount = (type: "http" | "mcp", count: number): Node =>
  h(
    "span",
    { class: "r4-badge", "data-scheme": type === "mcp" ? "agent" : "api" },
    `${groupThousands(count)} ${type === "mcp" ? "tool" : "API"}`,
  );

export const typeLabel = (type: string): Node =>
  h(
    "span",
    { class: "r4-badge", "data-scheme": type === "mcp" ? "agent" : "api" },
    type === "mcp" ? "tool" : "API",
  );

const count = (value: number | undefined) => (value === undefined ? "—" : groupThousands(value));
const lastPaid = (context: PageContext, entry: Entry) =>
  entry.lastAt === undefined ? "—" : entry.lastAt === null ? "never" : shortAgo(entry.lastAt, context.now);

/** The services table (Bazaar, seller page). */
export function serviceTable(context: PageContext, label: string, entries: readonly Entry[]): Node {
  const p = context.layout.view.prefix;
  return dataTable(
    "bz",
    label,
    [
      ["Service", undefined],
      ["Price", undefined],
      ["Trust", undefined],
      ["Paid", "num"],
      ["Buyers", "num"],
      ["Last paid", "num"],
    ],
    entries.map((entry) =>
      tableRow(
        "bz",
        `${p}/resource/${entry.listing.id}`,
        h(
          "span",
          { role: "cell", class: "svc" },
          iconBox(listingIcon(entry.listing)),
          h(
            "span",
            null,
            h("b", null, listingName(entry.listing)),
            h("small", null, listingWhere(entry.listing)),
          ),
        ),
        h(
          "span",
          { role: "cell", class: "pc" },
          h("b", null, priceText(context, entry.listing)),
          h("span", { class: "bl2" }, typeLabel(entry.listing.type), schemePill(entry.listing.scheme)),
        ),
        cell(trustBadge(entry.listing.trust)),
        cell(h("b", null, count(entry.payments)), "num"),
        cell(count(entry.payers), "num"),
        cell(lastPaid(context, entry), "num muted"),
      ),
    ),
  );
}

function serviceCards(context: PageContext, entries: readonly Entry[]): Node {
  const p = context.layout.view.prefix;
  return h(
    "div",
    { class: "g3 oc-cards" },
    entries.map((entry) => {
      const code = verifiedAsset(context, entry.listing.asset);
      return h(
        "a",
        { class: "lc", href: `${p}/resource/${entry.listing.id}` },
        h(
          "span",
          { class: "top2" },
          iconBox(listingIcon(entry.listing)),
          typeLabel(entry.listing.type),
          schemePill(entry.listing.scheme),
        ),
        h("h3", null, listingName(entry.listing)),
        h("span", { class: "dom" }, listingWhere(entry.listing)),
        h(
          "span",
          { class: "lcs" },
          h("span", null, h("b", null, count(entry.payments)), " paid"),
          h("span", null, h("b", null, count(entry.payers)), " buyers"),
          h("span", null, lastPaid(context, entry)),
        ),
        h(
          "span",
          { class: "pr" },
          h(
            "b",
            null,
            `${entry.listing.scheme === "upto" ? "≤ " : ""}${code === undefined ? entry.listing.amount : decimalAmount(entry.listing.amount)}`,
            h("small", null, ` ${code ?? "units"}`),
          ),
          trustBadge(entry.listing.trust),
        ),
      );
    }),
  );
}

// --- filters -----------------------------------------------------------------------------------------

/** The Bazaar page's query: every control is a link or a GET form. */
export interface BazaarQuery {
  readonly q: string;
  readonly filters: Readonly<Record<FilterKey, readonly string[]>>;
  readonly sort: SortKey;
  readonly view: "table" | "cards";
  readonly page: number;
}

type FilterKey = "type" | "scheme" | "price" | "trust" | "seller" | "paid";
type SortKey = "paid" | "recent" | "newest" | "cheap";

const SORTS: readonly (readonly [SortKey, string])[] = [
  ["paid", "Most paid"],
  ["recent", "Recently paid"],
  ["newest", "Newest"],
  ["cheap", "Cheapest"],
];

/** The query parameters the Bazaar page takes. */
export const BAZAAR_PARAMS = [
  "q",
  "type",
  "scheme",
  "price",
  "trust",
  "seller",
  "paid",
  "sort",
  "view",
  "page",
];

const PER_PAGE = 10;
const DAY = 86_400_000;

interface Group {
  readonly key: FilterKey;
  readonly label: string;
  readonly options: readonly { readonly value: string; readonly label: string; readonly sub?: string }[];
  readonly match: (entry: Entry, value: string) => boolean;
}

function groups(context: PageContext, entries: readonly Entry[]): Group[] {
  const band = (entry: Entry): string | undefined => {
    const value = priceValue(context, entry.listing);
    return value === undefined ? undefined : value < 0.01 ? "lo" : value <= 0.1 ? "mid" : "hi";
  };
  const age = (entry: Entry) =>
    entry.lastAt === undefined || entry.lastAt === null ? Infinity : context.now - Date.parse(entry.lastAt);
  const sellers = new Map<string, Listing[]>();
  for (const entry of entries)
    sellers.set(entry.seller, [...(sellers.get(entry.seller) ?? []), entry.listing]);
  return [
    {
      key: "type",
      label: "Type",
      options: [
        { value: "http", label: "APIs" },
        { value: "mcp", label: "Agent tools" },
      ],
      match: (entry, value) => entry.listing.type === value,
    },
    {
      key: "scheme",
      label: "Pricing",
      options: [
        { value: "exact", label: "Fixed price", sub: "exact" },
        { value: "upto", label: "Pay for use", sub: "upto" },
      ],
      match: (entry, value) => entry.listing.scheme === value,
    },
    {
      key: "price",
      label: "Price per call",
      options: [
        { value: "lo", label: "Under 0.01", sub: "USDC" },
        { value: "mid", label: "0.01 – 0.1", sub: "USDC" },
        { value: "hi", label: "Over 0.1", sub: "USDC" },
      ],
      match: (entry, value) => band(entry) === value,
    },
    {
      key: "trust",
      label: "Trust",
      options: [
        { value: "domain", label: "Domain verified" },
        { value: "origin", label: "Origin verified" },
      ],
      match: (entry, value) => entry.listing.trust === `${value}_verified`,
    },
    {
      key: "seller",
      label: "Seller",
      options: [...sellers.entries()]
        .slice(0, 20)
        .map(([seller, listings]) => ({ value: seller, label: serviceName(listings) || shortKey(seller) })),
      match: (entry, value) => entry.seller === value,
    },
    {
      key: "paid",
      label: "Last paid",
      options: [
        { value: "d1", label: "Last 24 hours" },
        { value: "d7", label: "Last 7 days" },
      ],
      match: (entry, value) => age(entry) <= (value === "d1" ? DAY : 7 * DAY),
    },
  ];
}

/** The Bazaar query from GET parameters; unknown values are dropped. */
export function bazaarQuery(read: (name: string) => readonly string[]): BazaarQuery {
  const one = (name: string) => read(name)[0] ?? "";
  const allowed: Record<FilterKey, RegExp> = {
    type: /^(http|mcp)$/,
    scheme: /^(exact|upto)$/,
    price: /^(lo|mid|hi)$/,
    trust: /^(domain|origin)$/,
    seller: /^[GC][A-Z2-7]{55}$/,
    paid: /^(d1|d7)$/,
  };
  const filters = Object.fromEntries(
    (Object.keys(allowed) as FilterKey[]).map((key) => [
      key,
      [...new Set(read(key).filter((value) => allowed[key].test(value)))].slice(0, 20),
    ]),
  ) as Record<FilterKey, string[]>;
  const sort = SORTS.find(([key]) => key === one("sort"))?.[0] ?? "paid";
  const page = /^\d{1,4}$/.test(one("page")) ? Math.max(1, Number(one("page"))) : 1;
  return {
    q: displayText(one("q"), 100).trim(),
    filters,
    sort,
    view: one("view") === "cards" ? "cards" : "table",
    page,
  };
}

/** The URL of the Bazaar page with `query`, defaults left out. */
function bazaarHref(prefix: string, query: BazaarQuery): string {
  const params = new URLSearchParams();
  if (query.q !== "") params.append("q", query.q);
  for (const [key, values] of Object.entries(query.filters))
    for (const value of values) params.append(key, value);
  if (query.sort !== "paid") params.set("sort", query.sort);
  if (query.view !== "table") params.set("view", query.view);
  if (query.page > 1) params.set("page", String(query.page));
  const text = params.toString();
  return `${prefix}/services${text === "" ? "" : `?${text}`}`;
}

const toggled = (query: BazaarQuery, key: FilterKey, value: string): BazaarQuery => {
  const current = query.filters[key];
  return {
    ...query,
    page: 1,
    filters: {
      ...query.filters,
      [key]: current.includes(value) ? current.filter((item) => item !== value) : [...current, value],
    },
  };
};

const NO_FILTERS: Record<FilterKey, string[]> = {
  type: [],
  scheme: [],
  price: [],
  trust: [],
  seller: [],
  paid: [],
};

function sorted(context: PageContext, entries: Entry[], sort: SortKey): Entry[] {
  const time = (value: string | null | undefined) =>
    value === undefined || value === null ? 0 : Date.parse(value);
  const by: Record<SortKey, (a: Entry, b: Entry) => number> = {
    paid: (a, b) => (b.payments ?? -1) - (a.payments ?? -1),
    recent: (a, b) => time(b.lastAt) - time(a.lastAt),
    newest: (a, b) =>
      time(b.listing.firstCataloged ?? b.listing.lastUpdated) -
      time(a.listing.firstCataloged ?? a.listing.lastUpdated),
    cheap: (a, b) =>
      (priceValue(context, a.listing) ?? Infinity) - (priceValue(context, b.listing) ?? Infinity),
  };
  return entries.sort(
    (a, b) =>
      by[sort](a, b) ||
      listingName(a.listing).localeCompare(listingName(b.listing)) ||
      a.listing.id.localeCompare(b.listing.id),
  );
}

// --- the page ----------------------------------------------------------------------------------------

export interface ServicesModel {
  readonly catalog: Answer<Catalog>;
  readonly query: BazaarQuery;
}

export function servicesPage(context: PageContext, model: ServicesModel): string {
  const view = context.layout.view;
  const p = view.prefix;
  const query = model.query;
  const entries = model.catalog.status === "ok" ? model.catalog.value.entries : [];
  const shell = {
    ...context.layout,
    title: "Bazaar",
    path: "/services",
    section: "bazaar" as const,
    description:
      "Paid APIs and agent tools in the Rail402 Bazaar, with the calls paid for each on the ledger.",
  };
  if (!context.bazaar || model.catalog.status !== "ok") {
    return page(
      shell,
      pageHead({ title: "Bazaar", badges: [bdg("off chain", "dash"), networkPill(view)] }),
      card(
        { title: "Services", icon: "bazaar" },
        !context.bazaar
          ? empty(
              `${view.label} has no Bazaar yet`,
              "Paid services are listed on testnet for now.",
              view.slug === "testnet"
                ? undefined
                : h("a", { class: "btn2", href: "/testnet/services" }, "Testnet Bazaar"),
            )
          : model.catalog.status === "down"
            ? empty("The Bazaar did not answer", "Try again shortly.")
            : empty("No services in the Bazaar yet"),
      ),
    );
  }

  const all = groups(context, entries);
  const words = query.q
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word !== "");
  const text = (entry: Entry) =>
    [
      listingName(entry.listing),
      entry.listing.description,
      entry.listing.resource,
      entry.listing.toolName,
      entry.listing.serviceName,
    ]
      .filter((part) => part !== undefined)
      .join(" ")
      .toLowerCase();
  const passes = (entry: Entry, skip?: FilterKey) =>
    all.every(
      (group) =>
        group.key === skip ||
        query.filters[group.key].length === 0 ||
        query.filters[group.key].some((value) => group.match(entry, value)),
    ) && words.every((word) => text(entry).includes(word));
  const found = sorted(
    context,
    entries.filter((entry) => passes(entry)),
    query.sort,
  );
  const pages = Math.max(1, Math.ceil(found.length / PER_PAGE));
  const at = Math.min(query.page, pages);
  const shown = found.slice((at - 1) * PER_PAGE, at * PER_PAGE);

  const active: { label: string; href: string }[] = [];
  for (const group of all)
    for (const value of query.filters[group.key]) {
      const option = group.options.find((item) => item.value === value);
      active.push({
        label: option?.label ?? shortKey(value),
        href: bazaarHref(p, toggled(query, group.key, value)),
      });
    }
  if (query.q !== "")
    active.push({ label: `“${query.q}”`, href: bazaarHref(p, { ...query, q: "", page: 1 }) });
  const cleared = bazaarHref(p, { ...query, q: "", filters: NO_FILTERS, page: 1 });

  const sellers = new Map<string, number>();
  for (const entry of entries)
    sellers.set(entry.seller, (sellers.get(entry.seller) ?? 0) + (entry.payments ?? 0));
  const topSeller = [...sellers.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const topName =
    topSeller === undefined
      ? undefined
      : serviceName(entries.filter((entry) => entry.seller === topSeller).map((entry) => entry.listing));
  const paid = entries.reduce((sum, entry) => sum + (entry.payments ?? 0), 0);
  const known = entries.some((entry) => entry.payments !== undefined);
  const thisWeek = entries.filter(
    (entry) => typeof entry.lastAt === "string" && context.now - Date.parse(entry.lastAt) <= 7 * DAY,
  ).length;
  const domain = entries.filter((entry) => entry.listing.trust === "domain_verified").length;
  const origin = entries.filter((entry) => entry.listing.trust === "origin_verified").length;

  // The search keeps the other filters, the sort and the view.
  const hidden: Node[] = [];
  for (const [key, values] of Object.entries(query.filters))
    for (const value of values) hidden.push(h("input", { type: "hidden", name: key, value }));
  if (query.sort !== "paid") hidden.push(h("input", { type: "hidden", name: "sort", value: query.sort }));
  if (query.view !== "table") hidden.push(h("input", { type: "hidden", name: "view", value: query.view }));

  const filterCount = active.length;
  const sidebar = h(
    "aside",
    { class: "card fside", "aria-label": "Filters" },
    h(
      "form",
      { method: "get", action: `${p}/services`, role: "search" },
      h(
        "label",
        { class: "tin big", for: "oc-bq" },
        svgIcon("search"),
        h("input", {
          id: "oc-bq",
          type: "search",
          name: "q",
          value: query.q,
          placeholder: "Search in plain words",
          "aria-label": "Search services",
          maxlength: 100,
          autocomplete: "off",
        }),
      ),
      ...hidden,
    ),
    // Phones fold the filters behind this toggle: a checkbox and its label, no script.
    h("input", { type: "checkbox", id: "oc-ftog", class: "oc-ftog", checked: filterCount > 0 }),
    h(
      "label",
      { class: "ftog", for: "oc-ftog" },
      svgIcon("filter"),
      "Filters",
      filterCount > 0 ? h("em", null, String(filterCount)) : null,
      h("span", { class: "chev", "aria-hidden": "true" }),
    ),
    h(
      "div",
      { class: "fbody oc-fbody" },
      all
        .filter((group) => group.options.length > 0)
        .map((group) =>
          h(
            "div",
            { class: "fg", role: "group", "aria-label": group.label },
            h("h4", null, group.label),
            group.options.map((option) => {
              const on = query.filters[group.key].includes(option.value);
              const n = entries.filter(
                (entry) => passes(entry, group.key) && group.match(entry, option.value),
              ).length;
              return h(
                "a",
                {
                  class: "opt",
                  href: bazaarHref(p, toggled(query, group.key, option.value)),
                  "aria-current": on ? "true" : undefined,
                  rel: "nofollow",
                },
                h("span", { class: "cbx" }, svgIcon("check")),
                h(
                  "span",
                  { class: "ol" },
                  option.label,
                  option.sub === undefined ? null : h("small", null, option.sub),
                ),
                h("span", { class: "oc" }, groupThousands(n)),
              );
            }),
          ),
        ),
      filterCount === 0
        ? h("span", { class: "clr oc-clr", "aria-disabled": "true" }, "Clear all filters")
        : h("a", { class: "clr oc-clr", href: cleared }, "Clear all filters"),
    ),
  );

  const results = h(
    "section",
    { class: "card res", "aria-label": "Services" },
    h(
      "div",
      { class: "rhead" },
      h(
        "h2",
        null,
        groupThousands(found.length),
        " ",
        h("span", { class: "muted oc-of" }, `of ${groupThousands(entries.length)} services`),
      ),
      seg(
        "Sort",
        SORTS.map(([key, label]) => ({
          label,
          href: bazaarHref(p, { ...query, sort: key, page: 1 }),
          on: query.sort === key,
        })),
      ),
    ),
    active.length === 0
      ? null
      : h(
          "div",
          { class: "achips" },
          active.map((chip) =>
            h(
              "a",
              { class: "ach", href: chip.href, "aria-label": `Remove filter ${chip.label}`, rel: "nofollow" },
              chip.label,
              svgIcon("cross"),
            ),
          ),
        ),
    found.length === 0
      ? empty(
          "No services match",
          "Try fewer filters or other words.",
          h("a", { class: "btn2", href: cleared }, "Clear all filters"),
        )
      : query.view === "cards"
        ? serviceCards(context, shown)
        : serviceTable(context, "Services", shown),
    pager({
      page: at,
      pages,
      total: found.length,
      perPage: PER_PAGE,
      href: (n) => bazaarHref(p, { ...query, page: n }),
    }),
  );

  return page(
    shell,
    pageHead({
      title: "Bazaar",
      badges: [
        bdg(`${groupThousands(entries.length)} ${entries.length === 1 ? "service" : "services"}`),
        bdg(`${groupThousands(sellers.size)} ${sellers.size === 1 ? "seller" : "sellers"}`, "mut"),
        known ? bdg(`${groupThousands(paid)} paid calls`, "mut") : null,
        bdg(
          "off chain",
          "dash",
          "Listings are the sellers' own words, kept by the Bazaar; payments are on chain",
        ),
        networkPill(view),
      ],
      actions: [
        seg("View", [
          { label: "Table", href: bazaarHref(p, { ...query, view: "table" }), on: query.view === "table" },
          { label: "Cards", href: bazaarHref(p, { ...query, view: "cards" }), on: query.view === "cards" },
        ]),
      ],
    }),
    h(
      "div",
      { class: "g4" },
      tile({
        label: "Services",
        icon: "bazaar",
        value: groupThousands(entries.length),
        badges: [
          typeCount("http", entries.filter((entry) => entry.listing.type === "http").length),
          typeCount("mcp", entries.filter((entry) => entry.listing.type === "mcp").length),
        ],
      }),
      tile({
        label: "Sellers",
        icon: "user",
        value: groupThousands(sellers.size),
        badges: topName === undefined || topName === "" ? [] : [bdg(`top: ${topName}`, "mut")],
      }),
      tile({
        label: "Paid calls",
        icon: "payments",
        value: known ? groupThousands(paid) : "—",
        badges: known ? [bdg(`${groupThousands(thisWeek)} paid this week`, thisWeek > 0 ? "ok" : "mut")] : [],
      }),
      tile({
        label: "Domain verified",
        icon: "shield",
        value: groupThousands(domain),
        unit: `of ${groupThousands(entries.length)}`,
        badges: [bdg(`${groupThousands(origin)} origin verified`, "info")],
      }),
    ),
    h("div", { class: "bzl" }, sidebar, results),
  );
}
