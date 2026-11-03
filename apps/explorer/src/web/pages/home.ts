import type { SettlementRow } from "@rail402.dev/x402-index";
import type { ReportDocument } from "../../api/report.ts";
import type { Answer, PaidFor } from "../bazaar.ts";
import {
  aside,
  bazaarDown,
  body,
  externalLink,
  facilitatorName,
  h,
  layout,
  note,
  panel,
  paymentFeed,
  shareBar,
  stat,
  swatch,
  table,
  type Child,
} from "../components.ts";
import { dayLabel, decimalAmount, groupThousands, percent, type NetworkView } from "../format.ts";
import { displayText } from "../text.ts";
import { usdcContract, type PageContext } from "./context.ts";
import { serviceItem, type Service } from "./services.ts";

export type SearchScope = "all" | "payments" | "accounts" | "endpoints" | "tools";

export const SEARCH_SCOPES: readonly (readonly [SearchScope, string])[] = [
  ["all", "All"],
  ["payments", "Payments"],
  ["accounts", "Accounts"],
  ["endpoints", "Endpoints"],
  ["tools", "MCP tools"],
];

/** The big search of the home page, with a scope selector. */
export function bigSearch(view: NetworkView, value = "", scope: SearchScope = "all"): Child {
  return h(
    "form",
    { class: "big", action: `${view.prefix}/search`, method: "get", role: "search" },
    h("label", { for: "scope", class: "sr" }, "Search in"),
    h(
      "select",
      { id: "scope", name: "scope" },
      SEARCH_SCOPES.map(([id, label]) =>
        h("option", { value: id, selected: id === scope }, label.toUpperCase()),
      ),
    ),
    h("label", { for: "q-big", class: "sr" }, `Search ${view.label}`),
    h("input", {
      id: "q-big",
      name: "q",
      type: "search",
      value: value === "" ? undefined : value,
      placeholder: "Tx hash, G… / C… address, endpoint URL or MCP tool",
      autocomplete: "off",
      spellcheck: "false",
      maxlength: 300,
    }),
    h("button", { type: "submit" }, "SEARCH"),
  );
}

/** The last `days` UTC days up to the report's last day, with zero for days without payments. */
export function dailySeries(report: ReportDocument, days = 30): { day: string; count: number }[] {
  const keys = Object.keys(report.aggregates.daily).sort();
  const last = keys.at(-1) ?? report.generatedAt.slice(0, 10);
  const end = Date.parse(`${last}T00:00:00Z`);
  const series: { day: string; count: number }[] = [];
  for (let index = days - 1; index >= 0; index--) {
    const key = new Date(end - index * 86_400_000).toISOString().slice(0, 10);
    series.push({ day: key, count: report.aggregates.daily[key]?.headline ?? 0 });
  }
  return series;
}

/** Payments per day as SVG columns on a square-root scale, the last day in the accent colour. */
export function dailyChart(series: readonly { day: string; count: number }[]): Child {
  const max = Math.max(1, ...series.map((entry) => entry.count));
  const width = 300;
  const height = 120;
  const slot = width / Math.max(1, series.length);
  const first = series[0];
  const last = series.at(-1);
  return h(
    "svg",
    {
      class: "chart",
      viewBox: `0 0 ${String(width)} ${String(height)}`,
      preserveAspectRatio: "none",
      role: "img",
      "aria-label": `Attributed x402 payments per day, ${first === undefined ? "" : dayLabel(first.day)} to ${last === undefined ? "" : dayLabel(last.day)}; at most ${groupThousands(max)} in a day.`,
    },
    series.map((entry, index) => {
      const barHeight = entry.count === 0 ? 2 : Math.max(3, Math.sqrt(entry.count / max) * height);
      return h(
        "rect",
        {
          class: entry.count === 0 ? "none" : index === series.length - 1 ? "today" : undefined,
          x: (index * slot + slot * 0.08).toFixed(2),
          y: (height - barHeight).toFixed(2),
          width: (slot * 0.84).toFixed(2),
          height: barHeight.toFixed(2),
        },
        h("title", null, `${dayLabel(entry.day)}: ${groupThousands(entry.count)} payments`),
      );
    }),
  );
}

/** The network's pulse: payments, distinct payers and sellers, USDC settled, and 30 days per day. */
function pulse(report: ReportDocument): Child {
  const agg = report.aggregates;
  const series = dailySeries(report);
  const today = series.at(-1);
  const peak = series.reduce(
    (best, entry) => (entry.count > best.count ? entry : best),
    series[0] ?? { day: "", count: 0 },
  );
  const usdc = usdcContract(report);
  const settled = usdc === undefined ? undefined : agg.headline.volume[usdc];
  const schemes = Object.entries(agg.byScheme)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([scheme, totals]) => `${displayText(scheme, 16)} ${groupThousands(totals.payments)}`)
    .join(" · ");
  return h(
    "section",
    { class: "panel pulse", "aria-label": "Registered facilitators (Rail402 included)" },
    h(
      "div",
      { class: "stats two" },
      stat(
        "Payments",
        groupThousands(agg.headline.payments),
        [today === undefined ? "" : `+${groupThousands(today.count)} on ${dayLabel(today.day)}`, schemes]
          .filter((part) => part !== "")
          .join(" · "),
      ),
      stat("Distinct payers", groupThousands(agg.headline.payers), "accounts that paid"),
      stat("Distinct sellers", groupThousands(agg.headline.sellers), "accounts that were paid"),
      stat(
        "USDC settled",
        settled === undefined ? "—" : decimalAmount(settled),
        "verified USDC, in the report's range",
      ),
    ),
    h(
      "div",
      { class: "chart-box" },
      h(
        "div",
        { class: "row" },
        h("span", { class: "label" }, "Registered facilitators · 30 days"),
        h("span", null, `Ledger ${groupThousands(report.range.to)}`),
      ),
      dailyChart(series),
      h(
        "div",
        { class: "row" },
        h("span", null, series[0] === undefined ? "" : dayLabel(series[0].day)),
        h("span", null, peak.count === 0 ? "" : `Peak ${groupThousands(peak.count)} · ${dayLabel(peak.day)}`),
        h("span", null, today === undefined ? "" : `Last ${groupThousands(today.count)}`),
      ),
    ),
  );
}

/** Facilitators with their share of attributed payments (the concluded beta apart). */
export function facilitatorTable(context: PageContext): Child {
  const view = context.layout.view;
  const report = context.report;
  if (report === undefined) return h("p", { class: "empty" }, "No ledgers are indexed yet.");
  const total = report.aggregates.headline.payments;
  const entries = Object.entries(report.aggregates.byFacilitator)
    .map(([id, totals]) => ({ id, totals, entry: context.registry.facilitator(id) }))
    .filter(({ entry }) => entry !== undefined && entry.tier !== "rail402-beta")
    .sort((a, b) => b.totals.payments - a.totals.payments);
  if (entries.length === 0)
    return h("p", { class: "empty" }, "No attributed payments in the report's range.");
  return table(
    "mid",
    [
      { label: "Facilitator" },
      { label: "Payments", num: true },
      { label: "Share" },
      { label: "Payers", num: true },
      { label: "Sellers", num: true },
      { label: "Schemes" },
      { label: "Evidence" },
    ],
    entries.map(({ id, totals, entry }) => {
      const fill = entry?.tier === "rail402" ? "accent" : "ink";
      const share = total === 0 ? 0 : totals.payments / total;
      const evidence = entry?.accounts.find((account) => account.validToLedger === null)?.evidence[0]?.url;
      const schemes = entry?.accounts.some((account) => account.role === "upto-authority")
        ? "exact · upto"
        : "exact";
      let evidenceLabel = "Registry entry";
      try {
        if (evidence !== undefined) {
          const url = new URL(evidence);
          evidenceLabel = `${url.host}${url.pathname.length > 24 ? "/…" : url.pathname}`;
        }
      } catch {
        // keeps the default label
      }
      return h(
        "tr",
        null,
        h(
          "td",
          { class: "strong nowrap" },
          swatch(fill),
          h(
            "a",
            { href: `${view.prefix}/facilitator/${id}` },
            entry === undefined ? id : facilitatorName(entry),
          ),
        ),
        h("td", { class: "num" }, groupThousands(totals.payments)),
        h(
          "td",
          null,
          h(
            "div",
            { class: "barline" },
            shareBar(share, fill, true),
            h("span", { class: "pct" }, percent(totals.payments, total)),
          ),
        ),
        h("td", { class: "num" }, groupThousands(totals.payers)),
        h("td", { class: "num" }, groupThousands(totals.sellers)),
        h("td", { class: "mono small" }, schemes),
        h("td", null, externalLink(evidence, evidenceLabel)),
      );
    }),
  );
}

/** The lower-bound sentence about unattributed x402-shaped payments. */
export function shapedNote(context: PageContext): Child {
  const shaped = context.report?.aggregates.unattributedShaped.payments ?? 0;
  if (shaped === 0) return null;
  const view = context.layout.view;
  return note(
    `Another ${groupThousands(shaped)} payments have the x402 shape but no registered facilitator. They are counted apart, as a lower bound: the index reads only the ledgers of registered facilitators. `,
    h("a", { href: `${view.prefix}/payments?facilitator=shaped` }, "Show them"),
    ".",
  );
}

export interface HomeModel {
  readonly latest: readonly SettlementRow[];
  readonly paid: Answer<ReadonlyMap<string, PaidFor>>;
  readonly scheme: "exact" | "upto" | undefined;
  readonly services: Answer<readonly Service[]>;
}

export function homePage(context: PageContext, model: HomeModel): string {
  const view = context.layout.view;
  const report = context.report;
  const services = model.services.status === "ok" ? model.services.value : [];
  const listings = services.reduce((sum, service) => sum + service.listings.length, 0);
  const homePath = view.prefix === "" ? "/" : view.prefix;
  const schemeLink = (scheme: "exact" | "upto" | undefined, label: string) =>
    h(
      "a",
      {
        href: scheme === undefined ? homePath : `${homePath}?scheme=${scheme}`,
        "aria-current": model.scheme === scheme ? "true" : undefined,
      },
      label,
    );
  return layout(
    { ...context.layout, section: "home", hero: true, title: `${view.label} x402 payments`, path: "" },
    h(
      "section",
      { class: "hero" },
      h(
        "div",
        { class: "wrap" },
        h(
          "div",
          { class: "titles" },
          h("p", { class: "eyebrow" }, `Stellar ${view.label} · x402 · verified from the ledger`),
          h("h1", null, "Who paid, what for, and the proof."),
        ),
        bigSearch(view),
      ),
    ),
    body(
      report === undefined
        ? h(
            "p",
            { class: "notice", role: "status" },
            `No ${view.label.toLowerCase()} ledgers are indexed yet.`,
          )
        : pulse(report),
      h(
        "div",
        { class: "grid-2" },
        panel(
          {
            title: "Latest payments",
            id: "latest",
            cls: "flex",
            aside: h(
              "nav",
              { class: "seg", "aria-label": "Scheme" },
              schemeLink(undefined, "All"),
              schemeLink("exact", "Exact"),
              schemeLink("upto", "Upto"),
            ),
          },
          model.paid.status === "down"
            ? h(
                "p",
                { class: "notice" },
                "The Bazaar did not answer: what each payment paid for is not shown.",
              )
            : null,
          paymentFeed(
            view,
            context.registry,
            model.latest,
            model.paid.status === "ok" ? model.paid.value : undefined,
            context.now,
          ),
          h(
            "a",
            {
              class: "panel-foot",
              href: `${view.prefix}/payments${model.scheme === undefined ? "" : `?scheme=${model.scheme}`}`,
            },
            "View all payments →",
          ),
        ),
        panel(
          {
            title: "Services in the Bazaar",
            id: "services",
            cls: "flex",
            aside: aside(`${groupThousands(listings)} listings · by payments`),
          },
          !context.bazaar
            ? h("p", { class: "empty" }, `No Bazaar is configured for ${view.label.toLowerCase()}.`)
            : model.services.status === "down"
              ? bazaarDown()
              : services.length === 0
                ? h("p", { class: "empty" }, "No listings yet.")
                : services.slice(0, 5).map((service) => serviceItem(context, service)),
          note("Payments are counted from the ledger. Listing names come from the Bazaar, off chain."),
          h("a", { class: "panel-foot", href: `${view.prefix}/services` }, "View all services →"),
        ),
      ),
      panel(
        {
          title: "Facilitators",
          id: "facilitators",
          aside: h("a", { href: "/methodology#tiers" }, "How attribution works"),
        },
        facilitatorTable(context),
        shapedNote(context),
      ),
    ),
  );
}
