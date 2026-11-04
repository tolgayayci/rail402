import type { RegistrySnapshot } from "@rail402.dev/x402-index";
import type { DailyFacilitator } from "../../api/queries-b.ts";
import type { ReportDocument } from "../../api/report.ts";
import { h, type Child, type LayoutOptions, type Node } from "../components.ts";
import { assetName, decimalAmount, displayContract, groupThousands, percent } from "../format.ts";
import {
  bdg,
  card,
  facTone,
  iconBox,
  kv,
  miniCard,
  page,
  pageHead,
  seg,
  stackChart,
  svgIcon,
  type StackDay,
  type StackSeries,
} from "../ui.ts";
import { facilitatorShort } from "./payments.ts";

type Totals = ReportDocument["aggregates"]["headline"];

export interface EcosystemContext {
  readonly layout: Omit<LayoutOptions, "title" | "path" | "section">;
  readonly registry: RegistrySnapshot;
  /** Where service availability is reported. */
  readonly statusUrl: string | undefined;
  /** The base for links to the report's files and other pages (empty on the site itself). */
  readonly apiOrigin: string;
}

/** The ranges of the per-day chart. */
export type ChartRange = "7d" | "30d" | "all";
export const CHART_RANGES: readonly (readonly [ChartRange, string])[] = [
  ["7d", "7 days"],
  ["30d", "30 days"],
  ["all", "All"],
];

export interface EcosystemExtras {
  readonly range?: ChartRange;
  /** Registered payments per day and facilitator from the index; the report's daily totals otherwise. */
  readonly daily?: readonly DailyFacilitator[] | undefined;
  /** The time the chart's last day is taken from (the report's time when absent). */
  readonly now?: number;
}

const DAY_MS = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const monthDay = (key: string) =>
  `${MONTHS[Number(key.slice(5, 7)) - 1] ?? ""} ${String(Number(key.slice(8, 10)))}`;

/** The chart's colour of a facilitator: its tone as an SVG fill class. */
const chartTone = (id: string) => {
  const tone = facTone(id);
  return tone === "x4" ? "c-reg" : `c-${tone}`;
};

/** The first day of a range ending on `today`: undefined for all days. */
export function rangeStart(range: ChartRange, today: number): string | undefined {
  return range === "all" ? undefined : dayKey(today - ((range === "7d" ? 7 : 30) - 1) * DAY_MS);
}

/**
 * The chart's columns: one per day of the range (weeks when "all" spans more than 60 days), each with
 * one value per series. Days without payments are zero.
 */
function chartDays(
  range: ChartRange,
  todayMs: number,
  firstKey: string | undefined,
  value: (key: string) => readonly number[],
  seriesCount: number,
  current = true,
): StackDay[] {
  const today = Date.parse(`${dayKey(todayMs)}T00:00:00Z`);
  const start =
    range === "all"
      ? Math.min(today, Date.parse(`${firstKey ?? dayKey(today)}T00:00:00Z`))
      : today - ((range === "7d" ? 7 : 30) - 1) * DAY_MS;
  const count = Math.round((today - start) / DAY_MS) + 1;
  const step = count > 60 ? 7 : 1;
  const columns: StackDay[] = [];
  // Columns end on today; a week column sums its seven days.
  for (let end = today; end >= start; end -= step * DAY_MS) {
    const values = new Array<number>(seriesCount).fill(0);
    for (let d = 0; d < step; d++) {
      const at = end - d * DAY_MS;
      if (at < start) break;
      value(dayKey(at)).forEach((v, i) => (values[i] = (values[i] ?? 0) + v));
    }
    const key = dayKey(step === 1 ? end : Math.max(start, end - (step - 1) * DAY_MS));
    columns.unshift({
      label:
        step === 1
          ? `${monthDay(key)}${end === today && current ? " · so far" : ""}`
          : `Week of ${monthDay(key)}`,
      short: "",
      values,
    });
  }
  const every = columns.length <= 10 ? 1 : columns.length <= 31 ? 5 : Math.ceil(columns.length / 8);
  return columns.map((column, i) => ({
    ...column,
    short:
      i === columns.length - 1 || (columns.length - 1 - i) % every === 0
        ? step === 1
          ? column.label.slice(4).replace(" · so far", "")
          : column.label.slice(8)
        : "",
  }));
}

function dailyChart(context: EcosystemContext, report: ReportDocument, extras: EcosystemExtras): Node {
  const range = extras.range ?? "30d";
  const today = extras.now ?? Date.parse(report.generatedAt);
  const facilitators = context.registry.document.facilitators.filter(
    (entry) => entry.tier !== "rail402-beta",
  );
  let series: StackSeries[];
  let value: (key: string) => readonly number[];
  let first: string | undefined;
  if (extras.daily !== undefined) {
    const byDay = new Map<string, Map<string, number>>();
    for (const row of extras.daily) {
      const day = byDay.get(row.day) ?? new Map<string, number>();
      day.set(row.facilitatorId, (day.get(row.facilitatorId) ?? 0) + row.payments);
      byDay.set(row.day, day);
    }
    series = facilitators.map((entry) => ({ name: facilitatorShort(entry), tone: chartTone(entry.id) }));
    value = (key) => facilitators.map((entry) => byDay.get(key)?.get(entry.id) ?? 0);
    first = extras.daily[0]?.day;
  } else {
    series = [{ name: "Registered", tone: "c-reg" }];
    value = (key) => [report.aggregates.daily[key]?.headline ?? 0];
    first = Object.keys(report.aggregates.daily)[0];
  }
  // A range with no payment at all (a network still indexing older ledgers) ends on the newest day
  // that has some, so the chart shows real days instead of an empty run.
  const keys =
    extras.daily !== undefined ? extras.daily.map((row) => row.day) : Object.keys(report.aggregates.daily);
  const newest = keys.reduce<string | undefined>(
    (max, key) => (max === undefined || key > max ? key : max),
    undefined,
  );
  const start = rangeStart(range, today);
  const end =
    newest !== undefined && start !== undefined && newest < start ? Date.parse(`${newest}T00:00:00Z`) : today;
  const days = chartDays(range, end, first, value, series.length, dayKey(end) === dayKey(today));
  const base = `${context.apiOrigin}${context.layout.view.prefix}/ecosystem`;
  return card(
    {
      title: "Registered payments per day",
      icon: "report",
      cls: "chartcard",
      end: seg(
        "Range",
        CHART_RANGES.map(([id, label]) => ({
          label,
          href: id === "30d" ? `${base}#chart` : `${base}?range=${id}#chart`,
          on: range === id,
        })),
      ),
      id: "chart",
    },
    ...stackChart(days, series),
  );
}

/** A scope tile: the coloured scope chip, the number, and its badges. */
function scopeTile(options: {
  readonly scope: string;
  readonly label: string;
  readonly value: string;
  readonly valueCls?: string;
  readonly badges: readonly Child[];
  readonly href?: string;
  readonly dashed?: boolean;
}): Node {
  const inner = [
    h(
      "span",
      { class: "t" },
      h("span", { class: `scope ${options.scope}`.trim() }, h("i", null), options.label),
    ),
    h("span", { class: options.valueCls === undefined ? "n" : `n ${options.valueCls}` }, options.value),
    h("span", { class: "bl2" }, ...options.badges),
  ];
  const cls = options.dashed === true ? "st dashed" : "st";
  return options.href === undefined
    ? h("div", { class: cls }, ...inner)
    : h("a", { class: cls, href: options.href }, ...inner);
}

/** A verified asset's name; the native asset's contract is shown as XLM. */
const tokenName = (network: string, contract: string, code: string, issuer: string | null) =>
  code === "native" ? "XLM" : assetName(network, contract, code, issuer);

const people = (totals: Totals) =>
  `${groupThousands(totals.payers)} buyer${totals.payers === 1 ? "" : "s"} · ${groupThousands(totals.sellers)} seller${totals.sellers === 1 ? "" : "s"}`;

/** The headline volume of totals: USDC (or the first verified asset), and how many other tokens. */
function volume(report: ReportDocument, totals: Totals): Child[] {
  const entries = Object.entries(totals.volume);
  if (entries.length === 0) return [h("span", { class: "muted" }, "none")];
  const usdc = displayContract(report.network, "USDC");
  const verified = entries.filter(([contract]) => report.assets[contract]?.verified === true);
  const main = verified.find(([contract]) => contract === usdc) ?? verified[0];
  if (main === undefined)
    return [bdg(`${String(entries.length)} unverified token${entries.length === 1 ? "" : "s"}`, "warn")];
  const asset = report.assets[main[0]];
  const others = entries.length - 1;
  return [
    `${decimalAmount(main[1])} ${tokenName(report.network, main[0], asset?.code ?? "", asset?.issuer ?? null)}`,
    others === 0 ? bdg("verified", "ok") : bdg(`+ ${String(others)} token${others === 1 ? "" : "s"}`, "mut"),
  ];
}

/** The tokens of totals other than the headline one: verified codes, and the unverified count. */
function otherTokens(report: ReportDocument, totals: Totals): Child[] {
  const usdc = displayContract(report.network, "USDC");
  const entries = Object.keys(totals.volume).filter((contract) => contract !== usdc);
  if (entries.length === 0) return [bdg("none", "mut")];
  const verified = entries.filter((contract) => report.assets[contract]?.verified === true);
  const unverified = entries.length - verified.length;
  return [
    ...verified.slice(0, 3).map((contract) => {
      const asset = report.assets[contract];
      return bdg(tokenName(report.network, contract, asset?.code ?? "", asset?.issuer ?? null), "mut");
    }),
    verified.length > 3 ? bdg(`+ ${String(verified.length - 3)}`, "mut") : null,
    unverified === 0 ? null : bdg(`${String(unverified)} unverified`, "warn"),
  ];
}

const schemeCounts = (report: ReportDocument): Child[] =>
  Object.values(report.aggregates.byScheme).filter((totals) => totals.payments > 0).length < 2
    ? []
    : (["exact", "upto"] as const).flatMap((scheme) => {
        const count = report.aggregates.byScheme[scheme]?.payments ?? 0;
        return count === 0
          ? []
          : [h("span", { class: "r4-badge", "data-scheme": scheme }, groupThousands(count))];
      });

function reportBody(context: EcosystemContext, report: ReportDocument, extras: EcosystemExtras): Child[] {
  const view = context.layout.view;
  const agg = report.aggregates;
  const facilitators = context.registry.document.facilitators.filter(
    (entry) => entry.tier !== "rail402-beta",
  );
  const rail402 = facilitators.find((entry) => entry.id === "rail402");
  const window = report.networkWide ?? undefined;
  const windowTotal =
    window === undefined
      ? undefined
      : window.tiers.rail402.payments +
        window.tiers.otherRegistered.payments +
        window.tiers.unattributed.payments;
  const active = facilitators.filter((entry) => (agg.byFacilitator[entry.id]?.payments ?? 0) > 0).length;
  const facilitatorCards = facilitators.map((entry) => {
    const totals = agg.byFacilitator[entry.id] ?? { payments: 0, volume: {}, payers: 0, sellers: 0 };
    return card(
      {
        title: facilitatorShort(entry),
        icon: "facilitators",
        tone: entry.id === "rail402" ? "or" : undefined,
        id: `fac-${entry.id}`,
        link: { href: `${context.apiOrigin}${view.prefix}/facilitator/${entry.id}`, label: "Open →" },
      },
      kv([
        ["Payments", h("b", null, groupThousands(totals.payments))],
        ["Buyers · sellers", `${groupThousands(totals.payers)} · ${groupThousands(totals.sellers)}`],
        ["Volume", ...volume(report, totals)],
        ["Share", bdg(percent(totals.payments, agg.headline.payments), "mut"), "of registered"],
      ]),
    );
  });
  const cards = [
    card(
      { title: "Registered", icon: "layers", id: "reg" },
      kv([
        ["Payments", h("b", null, groupThousands(agg.headline.payments)), ...schemeCounts(report)],
        ["Volume", ...volume(report, agg.headline)],
        ["Other tokens", ...otherTokens(report, agg.headline)],
        [
          "Self-payments",
          bdg(groupThousands(agg.selfPayments.payments), agg.selfPayments.payments === 0 ? "ok" : "mut"),
          agg.selfPayments.payments === 0 ? null : "left out",
        ],
      ]),
    ),
    ...facilitatorCards,
    card(
      { title: "Not registered", icon: "alert", id: "apart", cls: "oa-b-apart", end: bdg("apart", "warn") },
      kv([
        ["Payments", h("b", null, groupThousands(agg.unattributedShaped.payments))],
        [
          "Buyers · sellers",
          `${groupThousands(agg.unattributedShaped.payers)} · ${groupThousands(agg.unattributedShaped.sellers)}`,
        ],
        ["Volume", ...volume(report, agg.unattributedShaped)],
        ["In totals", bdg("never", "warn")],
      ]),
    ),
  ];
  const grid = cards.length === 4 ? "g2" : "g3";
  const failed = report.failedLedgers.length;
  return [
    h(
      "div",
      { class: "g4 oa-b-tiles" },
      scopeTile({
        scope: "",
        label: "Registered",
        value: groupThousands(agg.headline.payments),
        badges: [bdg(people(agg.headline), "mut")],
        href: "#reg",
      }),
      rail402 !== undefined
        ? scopeTile({
            scope: "r4",
            label: "Rail402",
            value: groupThousands(agg.rail402.payments),
            valueCls: "accent",
            badges: [bdg(people(agg.rail402), "mut")],
            href: "#fac-rail402",
          })
        : scopeTile({
            scope: "r4",
            label: "Facilitators",
            value: groupThousands(facilitators.length),
            badges: [bdg(`${String(active)} with payments`, "mut")],
            href: facilitators[0] === undefined ? undefined : `#fac-${facilitators[0].id}`,
          }),
      windowTotal === undefined || window === undefined
        ? scopeTile({
            scope: "nw",
            label: "Network-wide",
            value: "soon",
            valueCls: "muted",
            badges: [bdg("every facilitator", "info")],
          })
        : scopeTile({
            scope: "nw",
            label: "Network-wide",
            value: groupThousands(windowTotal),
            badges: [bdg(`every facilitator · last ${String(window.window.hours)} h`, "info")],
          }),
      scopeTile({
        scope: "apart",
        label: "Apart",
        value: groupThousands(agg.unattributedShaped.payments),
        valueCls: "muted",
        badges: [bdg("never in totals", "warn")],
        href: "#apart",
        dashed: true,
      }),
    ),
    dailyChart(context, report, extras),
    h("div", { class: grid }, ...cards),
    card(
      {
        title: "Coverage",
        icon: "ledger",
        cls: "oa-b-cov",
        end:
          report.detachedFrom === null
            ? bdg("complete", "ok")
            : report.coverageStop === "failed"
              ? bdg(`stops before ledger ${groupThousands(report.detachedFrom)}`, "warn")
              : bdg(`catching up at ledger ${groupThousands(report.detachedFrom)}`, "info"),
      },
      h(
        "div",
        { class: "g4" },
        smallStat("Ledgers read", groupThousands(report.discovery.ledgersRead)),
        smallStat("Failed ledgers", groupThousands(failed), failed === 0 ? "ok" : undefined),
        smallStat("Accounts watched", groupThousands(report.discovery.routes)),
        smallStat(
          "Range",
          `${groupThousands(report.range.from)} – ${groupThousands(report.range.to)}`,
          "range",
        ),
      ),
    ),
  ];
}

const smallStat = (label: string, value: string, cls?: string) =>
  h(
    "div",
    { class: "st" },
    h("span", { class: "t" }, label),
    h("span", { class: cls === undefined ? "n" : `n ${cls}` }, value),
  );

/** "updated 15:14 UTC", with the day when it was not today. */
function updated(iso: string, now: number): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "updated";
  const time = `${date.toISOString().slice(11, 16)} UTC`;
  return dayKey(date.getTime()) === dayKey(now)
    ? `updated ${time}`
    : `updated ${monthDay(dayKey(date.getTime()))} · ${time}`;
}

export function ecosystemPage(
  context: EcosystemContext,
  report: ReportDocument | undefined,
  extras: EcosystemExtras = {},
): string {
  const view = context.layout.view;
  const origin = context.apiOrigin;
  const head = pageHead({
    title: "Ecosystem Report",
    badges:
      report === undefined
        ? [bdg(view.label.toLowerCase())]
        : [
            bdg(view.label.toLowerCase()),
            bdg(updated(report.generatedAt, extras.now ?? Date.parse(report.generatedAt)), "mut"),
            report.reproducible
              ? bdg("reproducible", "ok", "A rebuild from public ledgers gives these exact numbers.")
              : bdg(
                  "being re-read",
                  "warn",
                  report.failedLedgers.length > 0
                    ? "A ledger failed an integrity check; the totals cover the ledgers before it."
                    : "Some rows are being indexed again; a rebuild can differ until then.",
                ),
          ],
    actions:
      report === undefined
        ? []
        : [
            h(
              "a",
              {
                class: "btn2",
                href: `${origin}/api/v1/${view.slug}/manifest`,
                download: `rail402-${view.slug}-manifest.json`,
              },
              svgIcon("download"),
              "Download",
            ),
          ],
  });
  const content =
    report === undefined
      ? [
          h(
            "section",
            { class: "card nf" },
            h(
              "div",
              { class: "nfh" },
              iconBox("report"),
              h(
                "div",
                null,
                h("h2", null, "No report yet"),
                h("p", null, `No ${view.label.toLowerCase()} ledgers are indexed yet.`),
              ),
              h("span", { class: "bdg info oa-b-end" }, "indexing"),
            ),
            h(
              "div",
              { class: "g3 oa-b-links" },
              miniCard(`${origin}${view.prefix}/payments`, "payments", "Payments", "the newest settlements"),
              miniCard(
                `${origin}${view.prefix}/facilitators`,
                "facilitators",
                "Facilitators",
                "who settles payments",
              ),
              miniCard(
                "https://docs.rail402.dev/explorer",
                "info",
                "How it works",
                "how payments are counted",
              ),
            ),
          ),
        ]
      : reportBody(context, report, extras);
  return page(
    {
      ...context.layout,
      section: "report",
      title: `Ecosystem Report (${view.label})`,
      path: "/ecosystem",
      statusUrl: context.statusUrl,
      description:
        "x402 payments on Stellar by registered facilitator, with unregistered look-alikes kept apart, rebuildable from public ledgers.",
    },
    head,
    ...content,
  );
}
