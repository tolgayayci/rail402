import { jsx } from "hono/jsx";
import type { RegistrySnapshot, SettlementRow } from "@rail402.dev/x402-index";
import { SCRIPT, STYLESHEET } from "./assets.ts";
import type { ListingRef, PaidFor } from "./bazaar.ts";
import {
  NETWORK_VIEWS,
  ago,
  assetName,
  decimalAmount,
  shortHash,
  shortKey,
  type NetworkView,
} from "./format.ts";
import { inlineStylesheet } from "./inline-style.ts";
import { displayText, safeHttpsUrl } from "./text.ts";

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

/** A link to an https URL; anything else renders as plain text. */
export function externalLink(url: string | null | undefined, label: Child, cls?: string): Child {
  const safe = safeHttpsUrl(url);
  if (safe === undefined) return label;
  return h("a", { href: safe, rel: "noopener noreferrer nofollow", class: cls }, label);
}

/** A small line icon, drawn with SVG attributes only. */
export function icon(name: "copy" | "search" | "menu"): Node {
  const shapes: Record<typeof name, Child> = {
    copy: [h("rect", { x: 9, y: 9, width: 13, height: 13 }), h("path", { d: "M5 15H3V3h12v2" })],
    search: [h("circle", { cx: 11, cy: 11, r: 8 }), h("path", { d: "m21 21-4.3-4.3" })],
    menu: h("path", { d: "M4 7h16M4 12h16M4 17h16" }),
  };
  return h("svg", { class: "icon", viewBox: "0 0 24 24", "aria-hidden": "true" }, shapes[name]);
}

/** A copy button for a full value; hidden until the page's script enables it. */
export const copyButton = (value: string, what: string) =>
  h(
    "button",
    { type: "button", class: "copy", "data-copy": value, hidden: true, "aria-label": `Copy ${what}` },
    icon("copy"),
  );

/** A full strkey, linked to its account page, with a copy button. Never truncated. */
export function fullAddress(view: NetworkView, address: string): Node {
  const clean = displayText(address, 69);
  return h(
    "span",
    null,
    h("a", { href: `${view.prefix}/account/${clean}`, class: "mono full" }, clean),
    " ",
    copyButton(clean, "address"),
  );
}

/** A shortened strkey for tables and feeds: the full value is in its title and label. */
export function shortAddress(view: NetworkView, address: string): Node {
  const clean = displayText(address, 69);
  return h(
    "a",
    { href: `${view.prefix}/account/${clean}`, class: "mono", title: clean, "aria-label": clean },
    shortKey(clean),
  );
}

/** A shortened hash linked to its payment page, with the full hash in its title. */
export function txLink(view: NetworkView, hash: string): Node {
  return h(
    "a",
    { href: `${view.prefix}/tx/${hash}`, class: "mono", title: hash, "aria-label": `Payment ${hash}` },
    shortHash(hash),
  );
}

export const fullHash = (hash: string) =>
  h("span", null, h("span", { class: "mono full" }, hash), " ", copyButton(hash, "hash"));

export function badge(text: Child, kind?: string, title?: string): Node {
  return h("span", { class: kind === undefined ? "badge" : `badge ${kind}`, title }, text);
}

export function schemeBadge(scheme: string): Node {
  const clean = displayText(scheme, 16);
  return badge(clean, clean === "upto" ? "upto" : "exact");
}

const TIER_LABELS: Readonly<Record<string, string>> = {
  rail402: "Rail402 hosted",
  "rail402-beta": "Rail402 beta (concluded)",
  facilitator: "Registered facilitator",
  shaped: "Unattributed x402-shaped",
};

export const tierLabel = (tier: string) => TIER_LABELS[tier] ?? displayText(tier, 40);

const TIER_KINDS: Readonly<Record<string, string>> = {
  rail402: "accent",
  "rail402-beta": "stripes",
  facilitator: "grey",
  shaped: "warn",
};

export const tierBadge = (tier: string) => badge(tierLabel(tier), TIER_KINDS[tier] ?? "grey");

/** The name of a row's verified asset: allow-listed codes alone, any other with a short issuer. */
export const rowAsset = (row: Pick<SettlementRow, "asset" | "network">): string =>
  assetName(row.network, row.asset.contract, row.asset.code ?? "", row.asset.issuer);

/** The asset of a row: a verified Stellar asset only by the SAC contract-id rule, else a custom token. */
export function assetLabel(row: Pick<SettlementRow, "asset" | "network">): Node {
  if (row.asset.verified && row.asset.code !== null) {
    return h(
      "span",
      null,
      rowAsset(row),
      " ",
      badge("verified", "ok", "The token's contract id is this asset's Stellar Asset Contract."),
    );
  }
  return badge(
    "custom token",
    "custom",
    "Not a Stellar Asset Contract: its name and decimals are not verified.",
  );
}

/** An amount as short text: "0.001 USDC" for a verified asset, atomic units for a custom token. */
export function amountText(
  row: Pick<SettlementRow, "asset" | "amount" | "network">,
  atomic = row.amount,
): string {
  return row.asset.verified ? `${decimalAmount(atomic)} ${rowAsset(row)}` : `${atomic} units (custom token)`;
}

/** The amount of a row: decimal for a verified Stellar asset (7 decimals), atomic units always. */
export function amountLabel(
  row: Pick<SettlementRow, "asset" | "amount" | "network">,
  atomic = row.amount,
): Node {
  if (row.asset.verified) {
    return h(
      "span",
      null,
      h("strong", null, decimalAmount(atomic)),
      " ",
      rowAsset(row),
      " ",
      h("span", { class: "muted" }, `(${atomic} atomic units)`),
    );
  }
  return h(
    "span",
    null,
    h("strong", null, atomic),
    " ",
    h("span", { class: "muted" }, "atomic units, decimals not verified"),
  );
}

/** A facilitator's short name for tables: "Rail402" for the hosted service. */
export function facilitatorName(entry: { readonly id: string; readonly name: string }): string {
  return entry.id === "rail402" ? "Rail402" : displayText(entry.name, 100);
}

/** A facilitator's name linked to its page, or the tier when no registry facilitator settled it. */
export function facilitatorLabel(
  view: NetworkView,
  registry: RegistrySnapshot,
  row: Pick<SettlementRow, "attribution">,
  withTier = true,
): Node {
  const id = row.attribution.facilitatorId;
  const entry = id === null ? undefined : registry.facilitator(id);
  if (id === null || entry === undefined) return tierBadge(row.attribution.tier);
  const link = h(
    "a",
    { href: `${view.prefix}/facilitator/${displayText(id, 63)}` },
    withTier ? displayText(entry.name, 100) : facilitatorName(entry),
  );
  return withTier ? h("span", null, link, " ", tierBadge(row.attribution.tier)) : link;
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

export const notCataloged = () =>
  badge(
    "Not cataloged",
    "stripes",
    "The Bazaar links no public listing to this payment (not cataloged, or its seller keeps usage private). The payment itself is on chain.",
  );

/** The cell that says what a payment bought: the listing (Bazaar, off chain), or "Not cataloged". */
export function paidForCell(view: NetworkView, found: PaidFor | undefined, ellipsis = true): Child {
  if (found === undefined) return notCataloged();
  const title = listingTitle(found.listing);
  return h(
    "a",
    {
      href: `${view.prefix}/resource/${found.listing.id}`,
      class: ellipsis ? "mono ellipsis" : "mono",
      title,
    },
    title,
  );
}

/** The Bazaar listing of a row, by its outer or inner hash. */
export function paidForRow(
  paid: ReadonlyMap<string, PaidFor> | undefined,
  row: Pick<SettlementRow, "txHash" | "innerHash">,
): PaidFor | undefined {
  if (paid === undefined) return undefined;
  return paid.get(row.txHash) ?? (row.innerHash === null ? undefined : paid.get(row.innerHash));
}

/** A framed panel with an optional head (title and a right-hand aside) and its content. */
export function panel(
  options: {
    readonly title?: string;
    readonly id?: string;
    readonly aside?: Child;
    readonly cls?: string;
    readonly label?: string;
  },
  ...content: Child[]
): Node {
  const id = options.id;
  return h(
    "section",
    {
      class: options.cls === undefined ? "panel" : `panel ${options.cls}`,
      id,
      "aria-labelledby": options.title !== undefined && id !== undefined ? `${id}-title` : undefined,
      "aria-label": options.title === undefined ? options.label : undefined,
    },
    options.title === undefined
      ? null
      : h(
          "div",
          { class: "panel-head" },
          h("h2", { id: id === undefined ? undefined : `${id}-title` }, options.title),
          options.aside ?? null,
        ),
    ...content,
  );
}

export const aside = (text: Child) => h("span", { class: "aside" }, text);
export const note = (...text: Child[]) => h("p", { class: "panel-note" }, ...text);

/** A stat: mono label, big value, a small line under it. */
export const stat = (label: string, value: Child, sub?: Child) =>
  h(
    "div",
    { class: "stat" },
    h("span", { class: "label" }, label),
    h("span", { class: "value" }, value),
    sub === undefined ? null : h("span", { class: "sub" }, sub),
  );

/** Facts as label and value rows. */
export function rows(cls: string | undefined, ...items: Child[]): Node {
  return h("dl", { class: cls === undefined ? "rows" : `rows ${cls}` }, ...items);
}

export const row = (term: string, ...value: Child[]) =>
  h("div", null, h("dt", null, term), h("dd", null, ...value));

export interface Column {
  readonly label: string;
  readonly num?: boolean;
  /** Read by screen readers only. */
  readonly sr?: boolean;
}

/** A scrollable table with mono uppercase headings. */
export function table(cls: string | undefined, columns: readonly Column[], items: readonly Child[]): Node {
  return h(
    "div",
    { class: "table-scroll" },
    h(
      "table",
      { class: cls },
      h(
        "thead",
        null,
        h(
          "tr",
          null,
          columns.map((column) =>
            h(
              "th",
              { scope: "col", class: column.num === true ? "num" : undefined },
              column.sr === true ? h("span", { class: "sr" }, column.label) : column.label,
            ),
          ),
        ),
      ),
      h("tbody", null, ...items),
    ),
  );
}

/** A horizontal bar for a share in [0, 1], drawn in SVG (the CSP allows no inline style). */
export function shareBar(share: number, fill: "ink" | "accent" | "upto", thin = false): Node {
  const width = Math.max(0, Math.min(100, share * 100));
  return h(
    "svg",
    {
      class: thin ? "bar thin" : "bar",
      viewBox: "0 0 100 10",
      preserveAspectRatio: "none",
      "aria-hidden": "true",
    },
    h("rect", { class: `fill-${fill}`, x: 0, y: 0, width: width.toFixed(2), height: 10 }),
  );
}

export const swatch = (fill: "ink" | "accent") =>
  h(
    "svg",
    { class: "swatch", viewBox: "0 0 10 10", "aria-hidden": "true" },
    h("rect", { class: `fill-${fill}`, x: 0, y: 0, width: 10, height: 10 }),
  );

/** Two letters for a service's tile: "demo.rail402.dev" gives "DE". */
export function monogram(name: string): string {
  const letters = name.replace(/^[a-z]+:\/\//, "").replace(/[^A-Za-z0-9]/g, "");
  return (letters.slice(0, 2) || "--").toUpperCase();
}

/** Payments as a feed (home, phones): hash and age, what it paid for, who paid whom, the amount. */
export function paymentFeed(
  view: NetworkView,
  registry: RegistrySnapshot,
  items: readonly SettlementRow[],
  paid: ReadonlyMap<string, PaidFor> | undefined,
  now: number,
): Child {
  if (items.length === 0) return h("p", { class: "empty" }, "No payments yet.");
  return items.map((row) => {
    const found = paidForRow(paid, row);
    const facilitator =
      row.attribution.facilitatorId === null
        ? undefined
        : registry.facilitator(row.attribution.facilitatorId);
    return h(
      "div",
      { class: "item" },
      h("span", { class: found === undefined ? "tile" : "tile accent", "aria-hidden": "true" }, "TX"),
      h(
        "div",
        { class: "hashcol" },
        txLink(view, row.txHash),
        h("span", { class: "small muted" }, ago(row.closedAt, now)),
      ),
      h(
        "div",
        { class: "main" },
        h(
          "div",
          { class: "forline" },
          found === undefined ? null : h("span", { class: "muted small" }, "For"),
          paidForCell(view, found),
        ),
        h(
          "span",
          { class: "small muted" },
          "From ",
          shortAddress(view, row.payer),
          " to ",
          shortAddress(view, row.payTo),
          facilitator === undefined ? "" : ` · ${facilitatorName(facilitator)}`,
        ),
      ),
      h("span", { class: "end" }, h("span", { class: "amount" }, amountText(row)), schemeBadge(row.scheme)),
    );
  });
}

/** The payments table of the list, facilitator and account pages. */
export function paymentTable(
  view: NetworkView,
  registry: RegistrySnapshot,
  items: readonly SettlementRow[],
  paid: ReadonlyMap<string, PaidFor> | undefined,
  now: number,
  options: { readonly facilitator?: boolean; readonly fee?: boolean } = {},
): Child {
  if (items.length === 0) return h("p", { class: "empty" }, "No payments match.");
  const columns: Column[] = [
    { label: "Payment" },
    { label: "Ledger" },
    { label: "Age" },
    { label: "Paid for" },
    { label: "From" },
    { label: "to", sr: true },
    { label: "To" },
    { label: "Amount", num: true },
    { label: "Scheme" },
    ...(options.facilitator === false ? [] : [{ label: "Facilitator" }]),
    ...(options.fee === true ? [{ label: "Fee paid", num: true }] : []),
  ];
  return table(
    "wide",
    columns,
    items.map((row) =>
      h(
        "tr",
        null,
        h("td", null, txLink(view, row.txHash)),
        h("td", { class: "mono" }, String(row.ledger)),
        h("td", { class: "muted nowrap", title: row.closedAt }, ago(row.closedAt, now)),
        h("td", { class: "paidfor" }, paidForCell(view, paidForRow(paid, row))),
        h("td", null, shortAddress(view, row.payer)),
        h("td", { class: "arrow", "aria-hidden": "true" }, "→"),
        h("td", null, shortAddress(view, row.payTo)),
        h("td", { class: "num" }, amountText(row)),
        h("td", null, schemeBadge(row.scheme)),
        options.facilitator === false
          ? null
          : h("td", { class: "nowrap" }, facilitatorLabel(view, registry, row, false)),
        options.fee === true
          ? h("td", { class: "num muted" }, `${decimalAmount(row.fee.chargedStroops)} XLM`)
          : null,
      ),
    ),
  );
}

/** Says that the Bazaar could not be read: the page shows ledger data only. */
export const bazaarDown = () =>
  h(
    "p",
    { class: "notice", role: "status" },
    "The Bazaar did not answer in time, so its listings are not shown. Everything else on this page is read from the ledger.",
  );

export type Section = "home" | "payments" | "services" | "facilitators" | "ecosystem" | "methodology";

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
  /** The home page has its own big search instead of the header's. */
  readonly hero?: boolean;
  /** Inline the stylesheet and drop the search form: a standalone snapshot file. */
  readonly standalone?: { readonly origin: string };
}

/** The search form of the header and the phone menu. */
function quickSearch(view: NetworkView, id: string): Node {
  return h(
    "form",
    { class: "quick", action: `${view.prefix}/search`, method: "get", role: "search" },
    h("label", { for: id, class: "sr" }, `Search ${view.label}`),
    h("input", {
      id,
      name: "q",
      type: "search",
      placeholder: "Hash, address, endpoint or tool",
      autocomplete: "off",
      spellcheck: "false",
      maxlength: 300,
    }),
    h("button", { type: "submit", "aria-label": "Search" }, icon("search")),
  );
}

/** The page shell: header with navigation, search and network switch, the content, the footer. */
export function layout(options: LayoutOptions, ...content: Child[]): string {
  const { view } = options;
  const origin = options.standalone?.origin ?? "";
  const home = view.prefix === "" ? "/" : view.prefix;
  const links: readonly (readonly [string, string, Section])[] = [
    [home, "Home", "home"],
    [`${view.prefix}/payments`, "Payments", "payments"],
    [`${view.prefix}/services`, "Services", "services"],
    [`${view.prefix}/facilitators`, "Facilitators", "facilitators"],
    [`${view.prefix}/ecosystem`, "Report", "ecosystem"],
    ["/methodology", "Methodology", "methodology"],
  ];
  const navLinks = () =>
    links.map(([href, label, section]) =>
      h(
        "a",
        { href: `${origin}${href}`, "aria-current": options.section === section ? "page" : undefined },
        label,
      ),
    );
  const switchLinks = () =>
    options.networks.map((other) =>
      h(
        "a",
        {
          href: `${origin}${other.prefix}${options.path}` || "/",
          "aria-current": other.network === view.network ? "true" : undefined,
          hreflang: "en",
        },
        other.label,
      ),
    );
  const interactive = options.standalone === undefined;
  const page = h(
    "html",
    { lang: "en" },
    h(
      "head",
      null,
      h("meta", { charset: "utf-8" }),
      h("meta", { name: "viewport", content: "width=device-width, initial-scale=1" }),
      h("title", null, `${options.title} · Rail402 Explorer`),
      h("meta", {
        name: "description",
        content:
          options.description ??
          "x402 payments on Stellar: who paid, what for, settled by which facilitator, with proof from public ledgers.",
      }),
      interactive
        ? [
            h("link", { rel: "stylesheet", href: STYLESHEET.path }),
            h("link", { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" }),
            h("script", { src: SCRIPT.path, defer: true }),
          ]
        : h("style", null, inlineStylesheet()),
    ),
    h(
      "body",
      null,
      h("a", { href: "#content", class: "skip" }, "Skip to content"),
      h(
        "header",
        { class: "site" },
        h(
          "div",
          { class: "wrap" },
          h(
            "a",
            { href: `${origin}${home}`, class: "logo", "aria-label": `Rail402 Explorer, ${view.label} home` },
            h("span", { class: "mark" }, "RAIL402"),
            h("span", { class: "word" }, "EXPLORER"),
          ),
          h("nav", { class: "main", "aria-label": "Main" }, navLinks()),
          interactive && options.hero !== true ? quickSearch(view, "q") : null,
          options.networks.length > 1
            ? h("nav", { class: "netswitch", "aria-label": "Network" }, switchLinks())
            : h("span", { class: "netbadge" }, view.label),
          interactive
            ? h(
                "details",
                { class: "menu" },
                h("summary", { "aria-label": "Menu" }, icon("menu")),
                h(
                  "div",
                  { class: "sheet" },
                  navLinks(),
                  options.networks.length > 1 ? switchLinks() : null,
                  quickSearch(view, "q-menu"),
                ),
              )
            : null,
        ),
      ),
      h("main", { id: "content", tabindex: "-1" }, ...content),
      h(
        "footer",
        { class: "site" },
        h(
          "div",
          { class: "wrap" },
          h(
            "span",
            null,
            `Audit aid — verify on chain. Every number is rebuilt from public Stellar ledger data under published rules (v${options.versions.rules}).`,
          ),
          h(
            "nav",
            { "aria-label": "Footer" },
            h("a", { href: `${origin}/methodology` }, "Methodology"),
            h("a", { href: `${origin}${view.prefix}/ecosystem` }, "Report"),
            h("a", { href: `${origin}/api/v1/${view.slug}/manifest` }, "Dataset"),
            h("a", { href: `${origin}/api/v1/openapi.json` }, "API"),
            options.statusUrl === undefined ? null : externalLink(options.statusUrl, "Status"),
            h("a", { href: "https://docs.rail402.dev/explorer" }, "Docs"),
          ),
          h(
            "span",
            { class: "versions" },
            `Indexing rules v${options.versions.rules} · registry ${options.versions.registry} (${view.label})`,
          ),
        ),
      ),
    ),
  );
  const html: unknown = page.toString();
  if (typeof html !== "string" && !(html instanceof String))
    throw new TypeError("a page rendered asynchronously");
  return `<!doctype html>${html.toString()}`;
}

/** The page's main column. */
export const body = (...content: Child[]) => h("div", { class: "wrap" }, ...content);

/** A page's heading block: eyebrow, title line, more lines under it. */
export function pageHead(
  options: {
    readonly eyebrow: string;
    readonly avatar?: Child;
    readonly split?: boolean;
    readonly end?: Child;
  },
  title: Child,
  ...more: Child[]
): Node {
  return h(
    "div",
    { class: options.split === true ? "page-head split" : "page-head" },
    options.avatar ?? null,
    h(
      "div",
      { class: "titles" },
      h("p", { class: "eyebrow" }, options.eyebrow),
      h("div", { class: "line" }, title),
      ...more,
    ),
    options.end ?? null,
  );
}

export const ALL_VIEWS = Object.values(NETWORK_VIEWS);
