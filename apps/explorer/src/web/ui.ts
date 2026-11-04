import { SCRIPT, STYLESHEET } from "./assets.ts";
import { h, type Child, type Node } from "./components.ts";
import { groupThousands, type NetworkView } from "./format.ts";
import { inlineStylesheet } from "./inline-style.ts";
import { safeHttpsUrl } from "./text.ts";

/**
 * The Explorer's page kit, after the approved Ledger desk design: header with the icon menu and the
 * phone menu, footer, badges, tiles with daily bars, cards, tables, pager and charts. Every bar and
 * chart is SVG drawn with attributes (the CSP forbids inline style), and every control is a link or a
 * form, so pages work without the script.
 */

// --- icons -------------------------------------------------------------------------------------------

const ICONS = {
  overview: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  payments: "M4 8h13l-3-3M20 16H7l3 3",
  bazaar: "M4 10h16v10H4zM2 10l3-6h14l3 6",
  facilitators: "M2 15h7M15 15h7M9 6h6v6H9z",
  report: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5v.01",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0",
  contract: "M8 8l-4 4 4 4M16 8l4 4-4 4",
  tag: "M3 12V4h8l10 10-8 8z",
  shield: "M12 3 20 7v6c0 4-3 7-8 8-5-1-8-4-8-8V7z",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
  list: "M4 7h16M4 12h16M4 17h10",
  coin: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9 12h6M12 9v6",
  ledger: "M12 3 20 7.5v9L12 21l-8-4.5v-9z",
  alert: "M12 8v5M12 16h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
  layers: "M12 3 21 8l-9 5-9-5zM3 13l9 5 9-5",
  star: "M12 3l2.6 5.6 6 .7-4.5 4.1 1.2 6L12 16.4 6.7 19.4l1.2-6L3.4 9.3l6-.7z",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  external: "M8 5h11v11M19 5 5 19",
  arrow: "M5 12h14M13 6l6 6-6 6",
  left: "M15 6l-6 6 6 6",
  right: "M9 6l6 6-6 6",
  check: "M5 12l5 5L19 7",
  cross: "M7 7l10 10M17 7 7 17",
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  link: "M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1",
  filter: "M4 6h16M7 12h10M10 18h4",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18",
  cloud: "M7 18h10a4 4 0 0 0 0-8 6 6 0 0 0-11.5 1.5A3.5 3.5 0 0 0 7 18z",
  tool: "M14 7l3 3M4 20l8-8M13 4l7 7-3 3-7-7z",
} as const;

export type IconName = keyof typeof ICONS;

/** A line icon. */
export const svgIcon = (name: IconName, cls?: string): Node =>
  h("svg", { viewBox: "0 0 24 24", "aria-hidden": "true", class: cls }, h("path", { d: ICONS[name] }));

/** The rounded icon box in front of a card title or a row. */
export const iconBox = (name: IconName, tone?: "or"): Node =>
  h("span", { class: tone === undefined ? "ic" : `ic ${tone}` }, svgIcon(name));

/** The Rail402 mark: an orange square, the rail, and the lifted section. */
export const MARK = (): Node =>
  h(
    "svg",
    { viewBox: "0 0 64 64", "aria-hidden": "true" },
    h("rect", { width: 64, height: 64, fill: "#FF4D00" }),
    h("rect", { x: 0, y: 38, width: 24, height: 8, fill: "#111111" }),
    h("rect", { x: 40, y: 38, width: 24, height: 8, fill: "#111111" }),
    h("rect", { x: 24, y: 18, width: 16, height: 16, fill: "#111111" }),
  );

// --- badges ------------------------------------------------------------------------------------------

export type BadgeKind = "ok" | "warn" | "info" | "mut" | "dash";

/** A status or fact pill: always a word, never colour alone. */
export const bdg = (text: Child, kind?: BadgeKind, title?: string): Node =>
  h("span", { class: kind === undefined ? "bdg" : `bdg ${kind}`, title }, text);

/** A scheme pill: exact orange, upto blue. */
export const schemePill = (scheme: string): Node =>
  h("span", { class: "r4-badge", "data-scheme": scheme === "upto" ? "upto" : "exact" }, scheme);

/** API or agent-tool pill. */
export const typePill = (type: string): Node =>
  type === "mcp"
    ? h("span", { class: "r4-badge", "data-scheme": "agent" }, "tool")
    : h("span", { class: "r4-badge", "data-scheme": "api" }, "API");

export const networkPill = (view: NetworkView): Node =>
  h("span", { class: "r4-badge", "data-network": view.network }, view.network);

const FAC_TONES: Readonly<Record<string, string>> = {
  rail402: "r4",
  "rail402-beta": "r4",
  "x402-org": "x4",
  "built-on-stellar": "bs",
  algovoi: "av",
};

/** A facilitator's colour class; unregistered payments are dashed. */
export const facTone = (id: string | null | undefined): string =>
  id === null || id === undefined ? "sh" : (FAC_TONES[id] ?? "gen");

/** A facilitator pill, linked to its page when `href` is given. */
export function facPill(name: string, id: string | null | undefined, href?: string): Node {
  const cls = `fac ${facTone(id)}`;
  return href === undefined
    ? h("span", { class: cls }, h("i", null), name)
    : h("a", { class: cls, href }, h("i", null), name);
}

// --- layout ------------------------------------------------------------------------------------------

export type Section = "home" | "payments" | "bazaar" | "facilitators" | "report" | "search" | "account";

export interface PageShell {
  readonly title: string;
  readonly view: NetworkView;
  /** The networks this Explorer serves, for the network switch. */
  readonly networks: readonly NetworkView[];
  /** This page's path without the network prefix, so the switch opens the same page on the other network. */
  readonly path: string;
  readonly section?: Section;
  readonly description?: string;
  readonly statusUrl?: string | undefined;
  /** Inline the stylesheet: a standalone snapshot file with no server behind it. */
  readonly standalone?: { readonly origin: string };
}

export const DOCS_URL = "https://docs.rail402.dev/explorer";
const LUMEUS_URL = "https://lumeus.dev/";

/** The menu links: the six pages of the design, "How it works" opens the docs. */
function menuLinks(shell: PageShell, origin: string): Node[] {
  const p = shell.view.prefix;
  const items: readonly (readonly [string, string, IconName, Section | undefined, boolean])[] = [
    [p === "" ? "/" : p, "Overview", "overview", "home", false],
    [`${p}/payments`, "Payments", "payments", "payments", false],
    [`${p}/services`, "Bazaar", "bazaar", "bazaar", false],
    [`${p}/facilitators`, "Facilitators", "facilitators", "facilitators", false],
    [`${p}/ecosystem`, "Report", "report", "report", false],
    [DOCS_URL, "How it works", "info", undefined, true],
  ];
  return items.map(([href, label, icon, section, external]) =>
    h(
      "a",
      {
        href: external ? href : `${origin}${href}`,
        "aria-current": section !== undefined && shell.section === section ? "page" : undefined,
        target: external ? "_blank" : undefined,
        rel: external ? "noopener" : undefined,
      },
      svgIcon(icon),
      label,
    ),
  );
}

function networkSwitch(shell: PageShell, origin: string): Node {
  return h(
    "nav",
    { class: "net", "aria-label": "Network" },
    shell.networks.map((other) =>
      h(
        "a",
        {
          href: `${origin}${other.prefix}${shell.path}` || "/",
          "aria-current": other.network === shell.view.network ? "true" : undefined,
          hreflang: "en",
        },
        other.network === shell.view.network ? h("span", { class: "dot" }) : null,
        other.label,
      ),
    ),
  );
}

/** The page shell: header with the icon menu and network switch, the phone menu, content, footer. */
export function page(shell: PageShell, ...content: Child[]): string {
  const origin = shell.standalone?.origin ?? "";
  const interactive = shell.standalone === undefined;
  const home = shell.view.prefix === "" ? "/" : shell.view.prefix;
  const doc = h(
    "html",
    { lang: "en", "data-theme": "light" },
    h(
      "head",
      null,
      h("meta", { charset: "utf-8" }),
      h("meta", { name: "viewport", content: "width=device-width, initial-scale=1" }),
      h("title", null, `${shell.title} · Rail402 Explorer`),
      h("meta", {
        name: "description",
        content:
          shell.description ??
          "x402 payments on Stellar: who paid, for what, settled by which facilitator, read from public ledgers.",
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
      h(
        "div",
        { class: "x oa", "data-theme": "light" },
        h("a", { href: "#content", class: "skip" }, "Skip to content"),
        h(
          "header",
          { class: "nav" },
          h(
            "div",
            { class: "wrap" },
            h(
              "a",
              {
                class: "brand",
                href: `${origin}${home}`,
                "aria-label": `Rail402 Explorer, ${shell.view.label} overview`,
              },
              MARK(),
              "Rail402 ",
              h("em", null, "Explorer"),
            ),
            h("nav", { class: "menu", "aria-label": "Explorer" }, menuLinks(shell, origin)),
            h(
              "div",
              { class: "nav-r" },
              networkSwitch(shell, origin),
              h("span", { class: "netc" }, h("span", { class: "dot" }), shell.view.label),
              interactive
                ? h(
                    "details",
                    { class: "mnav" },
                    h(
                      "summary",
                      { "aria-label": "Menu" },
                      h(
                        "svg",
                        { viewBox: "0 0 24 24", "aria-hidden": "true" },
                        h("path", { class: "b1", d: "M4 7h16M4 12h16M4 17h16" }),
                        h("path", { class: "b2", d: "M6 6l12 12M18 6 6 18" }),
                      ),
                    ),
                    h(
                      "div",
                      { class: "mpanel" },
                      h("nav", { class: "mlinks", "aria-label": "Explorer menu" }, menuLinks(shell, origin)),
                      shell.networks.length > 1
                        ? h(
                            "div",
                            { class: "mnet" },
                            h("span", null, "Network"),
                            networkSwitch(shell, origin),
                          )
                        : null,
                      h(
                        "div",
                        { class: "mfoot" },
                        h("a", { href: DOCS_URL, target: "_blank", rel: "noopener" }, "Docs"),
                        shell.statusUrl === undefined
                          ? null
                          : h(
                              "a",
                              { href: safeHttpsUrl(shell.statusUrl), target: "_blank", rel: "noopener" },
                              "Status",
                            ),
                        h(
                          "a",
                          { href: "https://playground.rail402.dev", target: "_blank", rel: "noopener" },
                          "Playground",
                        ),
                      ),
                    ),
                  )
                : null,
            ),
          ),
        ),
        h(
          "main",
          { id: "content", tabindex: "-1" },
          h("div", { class: "wrap" }, ...content, footer(shell, origin)),
        ),
      ),
    ),
  );
  const html: unknown = doc.toString();
  if (typeof html !== "string" && !(html instanceof String))
    throw new TypeError("a page rendered asynchronously");
  return `<!doctype html>${html.toString()}`;
}

function footer(shell: PageShell, origin: string): Node {
  return h(
    "footer",
    { class: "foot" },
    h(
      "span",
      null,
      "Ledger data via ",
      h("a", { class: "lumeus", href: LUMEUS_URL, target: "_blank", rel: "noopener" }, "Lumeus"),
    ),
    h(
      "nav",
      { "aria-label": "Footer" },
      h("a", { href: DOCS_URL, target: "_blank", rel: "noopener" }, "How it works"),
      h("a", { href: `${origin}${shell.view.prefix}/ecosystem` }, "Report"),
      h("a", { href: "https://docs.rail402.dev", target: "_blank", rel: "noopener" }, "Docs"),
      shell.statusUrl === undefined
        ? null
        : h("a", { href: safeHttpsUrl(shell.statusUrl), target: "_blank", rel: "noopener" }, "Status"),
    ),
  );
}

// --- page head ---------------------------------------------------------------------------------------

export interface HeadOptions {
  readonly crumbs?: readonly (readonly [string, string | undefined])[];
  readonly title: Child;
  /** Mono title for a hash or address. */
  readonly mono?: boolean;
  /** A coloured square before the title (a facilitator). */
  readonly square?: string;
  readonly lede?: Child;
  readonly badges?: readonly Child[];
  readonly actions?: readonly Child[];
}

export function pageHead(options: HeadOptions): Node {
  return h(
    "section",
    { class: "ph2" },
    h(
      "div",
      { class: "phm" },
      options.crumbs === undefined
        ? null
        : h(
            "div",
            { class: "crumb2" },
            options.crumbs.flatMap(([label, href], i) => [
              i === 0 ? null : h("span", null, "/"),
              href === undefined ? h("span", null, label) : h("a", { href }, label),
            ]),
          ),
      h(
        "h1",
        { class: options.mono === true ? "mono addr" : options.square !== undefined ? "fh" : undefined },
        options.square === undefined ? null : h("span", { class: `fsq ${options.square}` }),
        options.title,
      ),
      options.lede === undefined ? null : h("p", { class: "lede" }, options.lede),
      options.badges === undefined ? null : h("div", { class: "bl" }, ...options.badges),
    ),
    options.actions === undefined || options.actions.length === 0
      ? null
      : h("div", { class: "acts2" }, ...options.actions),
  );
}

/** A secondary action button (a link). */
export const actionLink = (
  href: string,
  label: string,
  icon?: IconName,
  dark = false,
  external = false,
): Node =>
  h(
    "a",
    {
      class: dark ? "btn2 dark" : "btn2",
      href,
      target: external ? "_blank" : undefined,
      rel: external ? "noopener" : undefined,
    },
    icon === undefined || icon === "external" || icon === "arrow" ? null : svgIcon(icon),
    label,
    icon === "external" || icon === "arrow" ? svgIcon(icon) : null,
  );

/** A copy-to-clipboard button: hidden until the script enables it. */
export const copyAction = (value: string, label: string): Node =>
  h("button", { type: "button", class: "btn2", "data-copy": value, hidden: true }, svgIcon("link"), label);

/** The small square copy button next to a value. */
export const copyMini = (value: string, what: string): Node =>
  h(
    "button",
    { type: "button", class: "cpb", "data-copy": value, hidden: true, "aria-label": `Copy ${what}` },
    h(
      "svg",
      { viewBox: "0 0 14 14", "aria-hidden": "true" },
      h("rect", { x: 4.5, y: 4.5, width: 7.5, height: 7.5, rx: 1.5 }),
      h("path", { d: "M9.5 2H3.5A1.5 1.5 0 0 0 2 3.5v6" }),
    ),
  );

// --- cards, tiles, key-value -------------------------------------------------------------------------

export interface CardOptions {
  readonly title: Child;
  readonly icon?: IconName;
  readonly tone?: "or";
  /** A badge or link at the right of the title. */
  readonly end?: Child;
  readonly link?: { readonly href: string; readonly label: string };
  readonly cls?: string;
  readonly id?: string;
}

export function card(options: CardOptions, ...body: Child[]): Node {
  return h(
    "section",
    { class: options.cls === undefined ? "card" : `card ${options.cls}`, id: options.id },
    h(
      "h2",
      null,
      options.icon === undefined ? null : iconBox(options.icon, options.tone),
      options.title,
      options.end === undefined ? null : h("span", { class: "h2e" }, options.end),
      options.link === undefined ? null : h("a", { href: options.link.href }, options.link.label),
    ),
    ...body,
  );
}

export interface TileOptions {
  readonly label: string;
  readonly icon?: IconName;
  readonly value: Child;
  readonly unit?: string;
  readonly badges?: readonly Child[];
  readonly href?: string;
  readonly dashed?: boolean;
  readonly valueCls?: string;
}

/** A simple stat tile. */
export function tile(options: TileOptions): Node {
  const cls = options.dashed === true ? "st dashed" : "st";
  const inner = [
    h("span", { class: "t" }, options.icon === undefined ? null : svgIcon(options.icon), options.label),
    h(
      "span",
      { class: options.valueCls === undefined ? "n" : `n ${options.valueCls}` },
      options.value,
      options.unit === undefined ? null : h("small", null, options.unit),
    ),
    h("span", { class: "bl2" }, ...(options.badges ?? [])),
  ];
  return options.href === undefined
    ? h("div", { class: cls }, ...inner)
    : h("a", { class: cls, href: options.href }, ...inner);
}

export interface Bar {
  /** The tooltip and accessible label, e.g. "Oct 26 · 326". */
  readonly tip: string;
  /** The axis label under the bar ("" for none). */
  readonly label: string;
  readonly value: number;
  /** The newest bar, drawn in orange. */
  readonly today?: boolean;
}

/** Daily mini bars with hover tips; heights are SVG attributes. */
export function miniBars(bars: readonly Bar[], cls = "mb"): Node[] {
  const max = Math.max(1, ...bars.map((bar) => bar.value));
  return [
    h(
      "span",
      { class: cls, role: "group" },
      bars.map((bar) => {
        const height = bar.value === 0 ? 2 : Math.max(3, (bar.value / max) * 100);
        return h(
          "span",
          { class: "mcol", tabindex: 0, "aria-label": bar.tip },
          h("span", { class: "mtip" }, bar.tip),
          h(
            "svg",
            { viewBox: "0 0 10 100", preserveAspectRatio: "none", "aria-hidden": "true" },
            h("rect", {
              class: bar.today === true ? "today" : undefined,
              x: 0,
              y: 100 - height,
              width: 10,
              height,
            }),
          ),
        );
      }),
    ),
    h(
      "span",
      { class: "mx" },
      bars.map((bar) => h("span", null, bar.label)),
    ),
  ];
}

export interface BarTileOptions extends TileOptions {
  readonly bars: readonly Bar[];
}

/** A stat tile with daily bars under the number, as on the overview. */
export function barTile(options: BarTileOptions): Node {
  const inner = [
    h("span", { class: "t" }, options.icon === undefined ? null : svgIcon(options.icon), options.label),
    h(
      "span",
      { class: "nrow" },
      h(
        "span",
        { class: "n" },
        options.value,
        options.unit === undefined ? null : h("small", null, options.unit),
      ),
      ...(options.badges ?? []),
    ),
    ...miniBars(options.bars),
  ];
  return options.href === undefined
    ? h("div", { class: "tile5" }, ...inner)
    : h("a", { class: "tile5", href: options.href }, ...inner);
}

/** Key-value rows inside a card. */
export const kv = (rows: readonly (readonly [string, ...Child[]] | null)[], cls = "kv2"): Node =>
  h(
    "dl",
    { class: cls },
    rows.flatMap((row) => (row === null ? [] : [h("dt", null, row[0]), h("dd", null, ...row.slice(1))])),
  );

/** The check list ("Why it counts", trust): green ticks, red crosses for what fails. */
export const checks = (
  items: readonly { readonly label: string; readonly ok: boolean }[],
  cls = "why",
): Node =>
  h(
    "ul",
    { class: cls },
    items.map((item) =>
      h("li", { class: item.ok ? undefined : "no" }, svgIcon(item.ok ? "check" : "cross"), item.label),
    ),
  );

/** A horizontal share bar (SVG), segments in order. */
export function shareBar(
  parts: readonly { readonly value: number; readonly tone: string }[],
  cls = "sbar",
): Node {
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  let x = 0;
  return h(
    "svg",
    { class: cls, viewBox: "0 0 100 10", preserveAspectRatio: "none", role: "img", "aria-hidden": "true" },
    total === 0
      ? h("rect", { class: "empty", x: 0, y: 0, width: 100, height: 10 })
      : parts.map((part) => {
          const width = (part.value / total) * 100;
          const rect = h("rect", { class: part.tone, x, y: 0, width, height: 10 });
          x += width;
          return rect;
        }),
  );
}

// --- stacked daily chart -----------------------------------------------------------------------------

export interface StackDay {
  readonly label: string;
  readonly short: string;
  /** One value per series, bottom first. */
  readonly values: readonly number[];
}

export interface StackSeries {
  readonly name: string;
  readonly tone: string;
}

/** The big payments-per-day chart: stacked SVG columns with hover tips and a legend. */
export function stackChart(days: readonly StackDay[], series: readonly StackSeries[]): (Node | null)[] {
  const max = Math.max(1, ...days.map((day) => day.values.reduce((a, b) => a + b, 0)));
  return [
    h(
      "div",
      { class: "stack tips", role: "group", "aria-label": "Payments per day, focus a day for details" },
      days.map((day) => {
        const total = day.values.reduce((a, b) => a + b, 0);
        let y = 100;
        return h(
          "div",
          {
            class: "col",
            tabindex: 0,
            "aria-label": `${day.label}: ${total} payments, ${series.map((s, i) => `${s.name} ${day.values[i] ?? 0}`).join(", ")}`,
          },
          h(
            "div",
            { class: "tip" },
            h("b", null, day.label),
            series.map((s, i) =>
              h(
                "span",
                null,
                h("i", { class: s.tone }),
                s.name,
                h("em", null, groupThousands(day.values[i] ?? 0)),
              ),
            ),
            series.length > 1
              ? h("span", { class: "tot" }, "total", h("em", null, groupThousands(total)))
              : null,
          ),
          h(
            "svg",
            { viewBox: "0 0 10 100", preserveAspectRatio: "none", "aria-hidden": "true" },
            total === 0
              ? h("rect", { class: "zero", x: 0, y: 98, width: 10, height: 2 })
              : series.map((s, i) => {
                  const height = ((day.values[i] ?? 0) / max) * 100;
                  y -= height;
                  return h("rect", { class: s.tone, x: 0, y, width: 10, height });
                }),
          ),
        );
      }),
    ),
    h(
      "div",
      { class: "stack-x" },
      days.map((day) => h("span", null, day.short)),
    ),
    series.length > 0
      ? h(
          "div",
          { class: "legend below" },
          series.map((s) => h("span", null, h("i", { class: s.tone }), s.name)),
        )
      : null,
  ];
}

// --- segmented links, pager, tables, rows ------------------------------------------------------------

/** A segmented control of links (sort, range, tabs): works without script. */
export const seg = (
  label: string,
  items: readonly {
    readonly label: Child;
    readonly href: string;
    readonly on: boolean;
    readonly count?: number;
  }[],
): Node =>
  h(
    "nav",
    { class: "seg", "aria-label": label },
    items.map((item) =>
      h(
        "a",
        { href: item.href, "aria-current": item.on ? "true" : undefined },
        item.label,
        item.count === undefined ? null : h("em", { class: "tc" }, groupThousands(item.count)),
      ),
    ),
  );

/** "1–10 of 20" and numbered page links, at most 10 rows a page. */
export function pager(options: {
  readonly page: number;
  readonly pages: number;
  readonly total: number;
  readonly perPage: number;
  readonly href: (page: number) => string;
  readonly label?: string;
}): Node | null {
  const { page, pages, total, perPage } = options;
  if (total === 0) return null;
  const from = (page - 1) * perPage + 1;
  const to = Math.min(page * perPage, total);
  const numbers: number[] = [];
  for (let n = Math.max(1, page - 2); n <= Math.min(pages, page + 2); n++) numbers.push(n);
  const link = (n: number, content: Child, aria?: string, disabled = false) =>
    disabled
      ? h("span", { class: "pgb", "aria-disabled": "true", "aria-label": aria }, content)
      : h(
          "a",
          {
            class: "pgb",
            href: options.href(n),
            "aria-label": aria,
            "aria-current": n === page && aria === undefined ? "page" : undefined,
          },
          content,
        );
  return h(
    "div",
    { class: "pager3" },
    h(
      "span",
      null,
      `${options.label ?? ""}${groupThousands(from)}–${groupThousands(to)} of ${groupThousands(total)}`,
    ),
    pages <= 1
      ? null
      : h(
          "nav",
          { class: "pg", "aria-label": "Pages" },
          link(page - 1, svgIcon("left"), "Previous page", page === 1),
          numbers.map((n) => link(n, String(n))),
          link(page + 1, svgIcon("right"), "Next page", page === pages),
        ),
  );
}

/** A data table: header labels then rows; `cls` sets the column grid. */
export function dataTable(
  cls: string,
  label: string,
  headers: readonly (readonly [string, "num" | undefined])[],
  rows: readonly Node[],
): Node {
  return h(
    "div",
    { class: "tbl", role: "table", "aria-label": label },
    h(
      "div",
      { class: `tr ${cls} th`, role: "row" },
      headers.map(([text, num]) => h("span", { role: "columnheader", class: num }, text)),
    ),
    ...rows,
  );
}

/** One table row; a link when `href` is given. */
export const tableRow = (cls: string, href: string | undefined, ...cells: Child[]): Node =>
  href === undefined
    ? h("div", { class: `tr ${cls}`, role: "row" }, ...cells)
    : h("a", { class: `tr ${cls}`, role: "row", href }, ...cells);

export const cell = (content: Child, cls?: string): Node =>
  h("span", { role: "cell", class: cls }, ...[content].flat());

/** An empty-state block inside a card. */
export const empty = (title: string, text?: Child, action?: Child): Node =>
  h(
    "div",
    { class: "empty2" },
    h("b", null, title),
    text === undefined ? null : h("span", null, text),
    action ?? null,
  );

/** A compact payment row of the latest-payments lists. */
export function payRow(options: {
  readonly href: string;
  readonly hash: string;
  readonly sub: string;
  readonly middle?: { readonly title: string; readonly sub: string };
  readonly amount: string;
  readonly badges: readonly Child[];
}): Node {
  return h(
    "a",
    { class: "prow", href: options.href },
    h("span", { class: "pi" }, svgIcon("payments")),
    h("span", null, h("b", null, options.hash), h("small", null, options.sub)),
    options.middle === undefined
      ? h("span", null)
      : h("span", null, h("b", null, options.middle.title), h("small", null, options.middle.sub)),
    h(
      "span",
      { class: "r" },
      h("span", { class: "amt" }, options.amount),
      h("span", { class: "rb" }, ...options.badges),
    ),
  );
}

/** A small linked card ("More from", services of a seller). */
export const miniCard = (href: string, icon: IconName, title: string, sub: string): Node =>
  h("a", { class: "mnc", href }, iconBox(icon), h("span", null, h("b", null, title), h("small", null, sub)));
