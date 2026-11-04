import type { Kysely } from "kysely";
import type { IndexNetwork, SettlementRow } from "@rail402.dev/x402-index";
import {
  actors,
  dailyByFacilitator,
  fees,
  firstPaymentDay,
  indexState,
  topAccounts,
  type Actors,
  type DailyFacilitator,
  type Fees,
  type IndexState,
  type TopAccount,
} from "../../api/queries-a.ts";
import type { ExplorerDatabase } from "../../db.ts";
import type { Answer, ListingRef, PaidFor } from "../bazaar.ts";
import { h, listingTitle, paidForRow, type Child, type Node } from "../components.ts";
import { ago, groupThousands, shortKey, type NetworkView } from "../format.ts";
import { displayText } from "../text.ts";
import {
  bdg,
  barTile,
  card,
  empty,
  facPill,
  facTone,
  iconBox,
  page,
  payRow,
  schemePill,
  seg,
  shareBar,
  stackChart,
  type Bar,
  type StackDay,
} from "../ui.ts";
import { listingPrice, usdcContract, type PageContext } from "./context.ts";
import type { Service } from "./services.ts";

// --- shared by the overview, search and account pages ------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86_400_000;

/** A UTC day key "2026-10-26" as "Oct 26". */
export const monthDay = (key: string) =>
  `${MONTHS[Number(key.slice(5, 7)) - 1] ?? ""} ${String(Number(key.slice(8, 10)))}`;

/** The UTC day key of an ISO time or epoch milliseconds. */
export const dayKey = (time: string | number) => new Date(time).toISOString().slice(0, 10);

/** The `count` UTC day keys ending with `last`, oldest first. */
export function dayKeys(last: string, count: number): string[] {
  const end = Date.parse(`${last}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) => dayKey(end - (count - 1 - index) * DAY_MS));
}

/** Atomic units of a 7-decimal asset with at most `places` decimals, rounded, trailing zeros cut. */
export function units(atomic: bigint, places = 2): string {
  const scale = 10n ** BigInt(7 - places);
  const rounded = (atomic + scale / 2n) / scale;
  const text = rounded.toString().padStart(places + 1, "0");
  const whole = text.slice(0, text.length - places);
  const fraction = text.slice(text.length - places).replace(/0+$/, "");
  return `${groupThousands(whole)}${fraction === "" ? "" : `.${fraction}`}`;
}

/** A facilitator's short name for pills: "Rail402", "x402.org", "Built on Stellar", "AlgoVoi". */
export function facShort(context: PageContext, id: string | null): string {
  if (id === null) return "not registered";
  if (id === "rail402") return "Rail402";
  const entry = context.registry.facilitator(id);
  if (entry === undefined) return displayText(id, 40);
  const short = displayText(entry.name, 60)
    .replace(/\s*\((stellar|concluded)\)\s*$/i, "")
    .replace(/\s+(hosted service|facilitator)$/i, "")
    .trim();
  return short === "" ? displayText(entry.name, 40) : short;
}

/** A facilitator's pill, linked to its page when `link`; unregistered payments are dashed. */
export function facBadge(context: PageContext, id: string | null, link = true): Node {
  const view = context.layout.view;
  return facPill(
    facShort(context, id),
    id,
    link && id !== null ? `${view.prefix}/facilitator/${id}` : undefined,
  );
}

/** The stacked chart's colour class of a facilitator. */
export const seriesTone = (id: string | null) => {
  const tone = facTone(id);
  return `c-${tone === "x4" ? "reg" : tone}`;
};

/** The short code of a row's asset: "USDC" for the allow-listed one, else the verified code. */
export function rowCode(context: PageContext, row: SettlementRow): string {
  if (!row.asset.verified || row.asset.code === null) return "units";
  return row.asset.contract === usdcContract(context.report) ? "USDC" : displayText(row.asset.code, 12);
}

/** A row's amount without its code: decimals of a verified asset, atomic units of any other token. */
export function rowValue(row: SettlementRow, atomic = row.amount, places = 4): string {
  return row.asset.verified && row.asset.code !== null ? units(BigInt(atomic), places) : atomic;
}

/** The amount of a row, short: "0.001 USDC", atomic units of an unverified token. */
export const rowAmount = (context: PageContext, row: SettlementRow, places = 4): string =>
  `${rowValue(row, row.amount, places)} ${rowCode(context, row)}`;

/** A hash as its first eight and last four characters. */
export const hash8 = (hash: string) => `${hash.slice(0, 8)}…${hash.slice(-4)}`;

/** What a listing sells, as a short name: a tool, its description's first clause, or its route. */
export function listingName(
  listing: Pick<ListingRef, "type" | "resource" | "method" | "toolName" | "description">,
): string {
  if (listing.type === "mcp" && listing.toolName !== undefined) return displayText(listing.toolName, 60);
  const described = listing.description?.split(/[.;:\n]/)[0]?.trim();
  if (described !== undefined && described !== "") return displayText(described, 60);
  return listingTitle(listing);
}

/** The host of a listing's resource, or an empty string. */
export function listingHost(listing: Pick<ListingRef, "resource">): string {
  try {
    return displayText(new URL(listing.resource).host, 80);
  } catch {
    return "";
  }
}

/** A read whose failure the page survives. */
export async function softly<T>(run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch {
    return undefined;
  }
}

// --- the overview ------------------------------------------------------------------------------------

export type Range = "7d" | "30d" | "all";
export type TopSide = "sellers" | "buyers";

/** What the overview reads beside the report; each part is undefined when its read failed. */
export interface Overview {
  readonly state?: IndexState | undefined;
  /** The last day the charts show: today, or the newest indexed ledger's day while catching up. */
  readonly endDay: string;
  /** The first day of the chart's range. */
  readonly fromDay: string;
  /** The first day with a payment; the chart marks earlier days "before indexing". */
  readonly firstDay?: string | null | undefined;
  readonly daily?: readonly DailyFacilitator[] | undefined;
  readonly actors?: Actors | undefined;
  readonly fees?: Fees | undefined;
  readonly top?: readonly TopAccount[] | undefined;
}

/** Days of the tiles' bars. */
const TILE_DAYS = 7;
/** Longest chart drawn by day; beyond it the chart draws weeks. */
const MAX_DAYS = 92;

/** The overview's reads, each bounded and each allowed to fail on its own. */
export async function loadOverview(
  db: Kysely<ExplorerDatabase> | undefined,
  context: PageContext,
  epoch: string,
  range: Range,
  side: TopSide,
): Promise<Overview> {
  const network: IndexNetwork = context.layout.view.network;
  const today = dayKey(context.now);
  if (db === undefined)
    return { endDay: today, fromDay: dayKeys(today, range === "7d" ? 7 : 30)[0] ?? today };
  const usdc = usdcContract(context.report);
  const [state, firstDay] = await Promise.all([
    softly(() => indexState(db, network, epoch)),
    softly(() => firstPaymentDay(db, network, epoch)),
  ]);
  // While ledgers wait to be read, the newest indexed ledger ends the charts, so they show the days the
  // index holds instead of days it has not reached.
  const endTime = Math.min(
    state?.pending === true && state.closedAt !== null ? Date.parse(state.closedAt) : context.now,
    context.now,
  );
  const endDay = dayKey(endTime);
  const days = range === "7d" ? 7 : range === "30d" ? 30 : undefined;
  const fromDay =
    days !== undefined
      ? (dayKeys(endDay, days)[0] ?? endDay)
      : firstDay !== undefined && firstDay !== null && firstDay < endDay
        ? firstDay
        : (dayKeys(endDay, 30)[0] ?? endDay);
  const tileFrom = dayKeys(endDay, TILE_DAYS)[0] ?? endDay;
  const readFrom = fromDay < tileFrom ? fromDay : tileFrom;
  const [daily, actorsRead, feesRead, top] = await Promise.all([
    softly(() => dailyByFacilitator(db, network, epoch, readFrom, endDay, usdc)),
    softly(() => actors(db, network, epoch, `${tileFrom}T00:00:00Z`, new Date(endTime).toISOString(), usdc)),
    softly(() => fees(db, network, epoch, context.now)),
    // Without a Bazaar list beside it, the top list is longer, so both columns end level.
    softly(() =>
      topAccounts(
        db,
        network,
        epoch,
        side === "sellers" ? "payTo" : "payer",
        usdc,
        context.now,
        context.bazaar ? 6 : 8,
      ),
    ),
  ]);
  return { state, endDay, fromDay, firstDay, daily, actors: actorsRead, fees: feesRead, top };
}

export interface HomeModel {
  readonly latest: readonly SettlementRow[];
  readonly paid: Answer<ReadonlyMap<string, PaidFor>>;
  readonly services: Answer<readonly Service[]>;
  readonly range: Range;
  readonly top: TopSide;
  readonly overview: Overview;
}

/** The facilitators the overview names: every registry facilitator and any other the report counts. */
export function facilitatorsOf(context: PageContext): { id: string; payments: number }[] {
  const by = context.report?.aggregates.byFacilitator ?? {};
  const ids = new Set([
    ...context.registry.document.facilitators.map((entry) => entry.id),
    ...Object.keys(by),
  ]);
  return [...ids]
    .map((id) => ({ id, payments: by[id]?.payments ?? 0 }))
    .sort((a, b) => b.payments - a.payments || a.id.localeCompare(b.id));
}

/** The schemes a facilitator settled in the days read, and what its registry accounts allow. */
function schemesOf(context: PageContext, id: string, daily: readonly DailyFacilitator[] | undefined): string {
  const seen = new Set((daily ?? []).filter((row) => row.facilitator === id).map((row) => row.scheme));
  const entry = context.registry.facilitator(id);
  if (entry?.accounts.some((account) => account.role === "upto-authority") === true) seen.add("upto");
  seen.add("exact");
  return [...seen].sort().join(" · ");
}

/** The overview's search box: a GET form to the search page; the script adds live results. */
function searchBox(view: NetworkView): Node {
  return h(
    "div",
    { class: "swrap" },
    h(
      "form",
      {
        role: "search",
        class: "sbox",
        action: `${view.prefix}/search`,
        method: "get",
        "data-suggest": `${view.prefix}/suggest`,
      },
      h(
        "svg",
        { viewBox: "0 0 24 24", "aria-hidden": "true" },
        h("circle", { cx: 11, cy: 11, r: 7 }),
        h("path", { d: "m20 20-4-4" }),
      ),
      h("label", { class: "sr", for: "oa-q" }, `Search ${view.label}`),
      h("input", {
        id: "oa-q",
        name: "q",
        type: "search",
        autocomplete: "off",
        spellcheck: "false",
        maxlength: 300,
        placeholder: "Transaction, account, service or tool",
      }),
      h("button", { type: "submit", class: "go" }, "Search"),
    ),
  );
}

function liveBox(context: PageContext, model: HomeModel): Node {
  const report = context.report;
  const state = model.overview.state;
  const latest = model.latest[0];
  const ledger = state?.ledger ?? report?.range.to;
  const failed = report?.failedLedgers.length ?? 0;
  return h(
    "div",
    { class: "live", "aria-label": "Network status" },
    h(
      "div",
      null,
      h("small", null, h("span", { class: "dot" }), "Latest indexed ledger"),
      h("b", null, ledger === undefined ? "none yet" : groupThousands(ledger)),
    ),
    h(
      "div",
      null,
      h("small", null, "Indexed"),
      state === undefined
        ? h("b", null, report === undefined ? "not yet" : `to ${groupThousands(report.range.to)}`)
        : state.pending
          ? h(
              "b",
              { class: "a-warn", title: "Catching up: ledgers still wait to be read." },
              state.closedAt === null ? "catching up" : `to ${monthDay(dayKey(state.closedAt))}`,
            )
          : h("b", { class: "ok" }, "up to date"),
    ),
    h(
      "div",
      null,
      h("small", null, "Ledgers checked"),
      h(
        "b",
        null,
        report === undefined ? "0" : groupThousands(report.discovery.ledgersRead),
        " ",
        report === undefined
          ? null
          : failed === 0
            ? h("span", { class: "ok a-small" }, "✓ all match")
            : h("span", { class: "a-warn a-small" }, `${groupThousands(failed)} failed`),
      ),
    ),
    h(
      "div",
      null,
      h("small", null, "Last payment"),
      h("b", null, latest === undefined ? "none yet" : ago(latest.closedAt, context.now)),
    ),
  );
}

/** Daily bars of the tiles: the last `TILE_DAYS` days up to the end day; today in orange. */
function tileBars(
  overview: Overview,
  value: (day: string) => number | undefined,
  text: (value: number) => string,
  today: string,
): Bar[] {
  return dayKeys(overview.endDay, TILE_DAYS).map((day) => {
    const amount = value(day);
    return {
      tip:
        amount === undefined
          ? `${monthDay(day)} · not read`
          : `${monthDay(day)}${day === today ? " (so far)" : ""} · ${text(amount)}`,
      label: String(Number(day.slice(8, 10))),
      value: amount ?? 0,
      today: day === today,
    };
  });
}

function tiles(context: PageContext, model: HomeModel): Node {
  const view = context.layout.view;
  const overview = model.overview;
  const headline = context.report?.aggregates.headline;
  const usdc = usdcContract(context.report);
  const today = dayKey(context.now);
  // The tiles count the headline, which leaves the concluded beta out.
  const sum = (day: string, pick: (row: DailyFacilitator) => number) =>
    overview.daily === undefined
      ? undefined
      : overview.daily
          .filter((row) => row.day === day && row.facilitator !== "rail402-beta")
          .reduce((total, row) => total + pick(row), 0);
  const last = overview.actors?.last24h;
  const delta = (text: string | undefined) =>
    text === undefined ? [] : [h("span", { class: "dl" }, h("b", null, text), " 24h")];
  const volume = usdc === undefined ? undefined : headline?.volume[usdc];
  const actorsOn = (day: string, key: "buyers" | "sellers") =>
    overview.actors === undefined ? undefined : (overview.actors.days.get(day)?.[key] ?? 0);
  return h(
    "div",
    { class: "tiles4" },
    barTile({
      label: "Payments",
      icon: "list",
      value: groupThousands(headline?.payments ?? 0),
      href: `${view.prefix}/payments`,
      badges: delta(last === undefined ? undefined : `+${groupThousands(last.payments)}`),
      bars: tileBars(
        overview,
        (day) => sum(day, (row) => row.payments),
        (n) => groupThousands(n),
        today,
      ),
    }),
    barTile({
      label: "Volume",
      icon: "coin",
      value: volume === undefined ? "0" : units(BigInt(volume)),
      unit: "USDC",
      href: `${view.prefix}/ecosystem`,
      badges: delta(last === undefined ? undefined : `+${units(last.volume)}`),
      bars: tileBars(
        overview,
        (day) => sum(day, (row) => Number(row.volume)),
        (n) => `${units(BigInt(n), 4)} USDC`,
        today,
      ),
    }),
    barTile({
      label: "Buyers",
      icon: "user",
      value: groupThousands(headline?.payers ?? 0),
      href: `${view.prefix}/payments`,
      badges: delta(last === undefined ? undefined : groupThousands(last.buyers)),
      bars: tileBars(
        overview,
        (day) => actorsOn(day, "buyers"),
        (n) => `${groupThousands(n)} active`,
        today,
      ),
    }),
    barTile({
      label: "Sellers",
      icon: "bazaar",
      value: groupThousands(headline?.sellers ?? 0),
      href: context.bazaar ? `${view.prefix}/services` : `${view.prefix}/payments`,
      badges: delta(last === undefined ? undefined : groupThousands(last.sellers)),
      bars: tileBars(
        overview,
        (day) => actorsOn(day, "sellers"),
        (n) => `${groupThousands(n)} paid`,
        today,
      ),
    }),
  );
}

/** Ledgers the report may trail the newest indexed ledger by (about an hour) before it is "catching up". */
const CATCH_UP_LEDGERS = 720;

/**
 * Whether the report's totals cover only part of the indexed history: it counts the stretch read without
 * gaps, so after a new registry account or a fresh index it stops well before the newest ledger.
 */
export function reportCatchingUp(context: PageContext, model: HomeModel): boolean {
  const report = context.report;
  const newest = model.overview.state?.ledger;
  if (report === undefined || report.detachedFrom === null) return false;
  return newest === undefined || newest === null || newest - report.range.to > CATCH_UP_LEDGERS;
}

function whoSettles(context: PageContext, model: HomeModel): Node {
  const view = context.layout.view;
  const entries = facilitatorsOf(context);
  const total = entries.reduce((sum, entry) => sum + entry.payments, 0);
  return card(
    {
      title: "Who settles",
      icon: "facilitators",
      end: reportCatchingUp(context, model)
        ? bdg(
            "catching up",
            "warn",
            "Older ledgers are still being read; these totals cover part of the history",
          )
        : bdg("all time", "mut", "Every registered payment since indexing began"),
      link: { href: `${view.prefix}/facilitators`, label: "Facilitators →" },
    },
    shareBar(
      entries.map((entry) => ({ value: entry.payments, tone: facTone(entry.id) })),
      "sbar tall",
    ),
    entries.map((entry) =>
      h(
        "div",
        { class: "frow" },
        facBadge(context, entry.id),
        h("span", { class: "muted" }, schemesOf(context, entry.id, model.overview.daily)),
        h("span", null, groupThousands(entry.payments)),
        h(
          "span",
          { class: "pc" },
          total === 0 ? "0%" : `${String(Math.round((entry.payments / total) * 100))}%`,
        ),
      ),
    ),
  );
}

function feesCard(context: PageContext, model: HomeModel): Node {
  const fee = model.overview.fees;
  const all = fee !== undefined && fee.sponsored === fee.payments;
  return card(
    { title: "Fees paid by buyers", icon: "shield" },
    h("span", { class: "big" }, fee === undefined ? "—" : `${units(fee.buyerStroops, 2)} XLM`),
    h(
      "span",
      { class: "muted a-sub" },
      fee === undefined
        ? "Not read just now."
        : fee.sponsored === 0
          ? "No facilitator has paid a network fee yet."
          : `Facilitators paid ${units(fee.sponsoredStroops, 2)} XLM of network fees for ${all ? "all " : ""}${groupThousands(fee.sponsored)}${all ? "" : ` of ${groupThousands(fee.payments)}`}.`,
    ),
  );
}

function keptApart(context: PageContext): Node {
  const view = context.layout.view;
  const shaped = context.report?.aggregates.unattributedShaped.payments ?? 0;
  return h(
    "a",
    { class: "card dashed a-cardlink", href: `${view.prefix}/payments?facilitator=shaped` },
    h("h2", null, iconBox("alert"), "Kept apart"),
    h("span", { class: "big a-muted" }, groupThousands(shaped)),
    h(
      "span",
      { class: "muted a-sub" },
      "Look like x402, but no registered facilitator paid the fee. Never in the totals.",
    ),
  );
}

/** The chart's columns: one a day, one a week beyond `MAX_DAYS`. */
function chartDays(context: PageContext, overview: Overview, series: readonly string[]): StackDay[] {
  const from = Date.parse(`${overview.fromDay}T00:00:00Z`);
  const count = Math.max(1, Math.round((Date.parse(`${overview.endDay}T00:00:00Z`) - from) / DAY_MS) + 1);
  const keys = dayKeys(overview.endDay, count);
  const today = dayKey(context.now);
  const value = (days: readonly string[], id: string) =>
    (overview.daily ?? [])
      .filter((row) => row.facilitator === id && days.includes(row.day))
      .reduce((sum, row) => sum + row.payments, 0);
  const before = (day: string) =>
    overview.firstDay !== undefined && (overview.firstDay === null || day < overview.firstDay);
  if (count <= MAX_DAYS) {
    return keys.map((day, index) => ({
      label: `${monthDay(day)}${day === today ? " · so far" : ""}${before(day) ? " · before indexing" : ""}`,
      short: count <= 10 || index % 5 === 4 || index === count - 1 ? String(Number(day.slice(8, 10))) : "",
      values: series.map((id) => value([day], id)),
    }));
  }
  const weeks: string[][] = [];
  for (let index = 0; index < keys.length; index += 7) weeks.push(keys.slice(index, index + 7));
  return weeks.map((week, index) => {
    const first = week[0] ?? "";
    const last = week.at(-1) ?? first;
    return {
      label: `${monthDay(first)} – ${monthDay(last)}${before(last) ? " · before indexing" : ""}`,
      short: index % 4 === 0 || index === weeks.length - 1 ? monthDay(first) : "",
      values: series.map((id) => value(week, id)),
    };
  });
}

/** The overview's own query string, so a range or top-list link keeps the other choice. */
function homeHref(context: PageContext, range: Range, top: TopSide, anchor: string): string {
  const prefix = context.layout.view.prefix;
  const params = new URLSearchParams();
  if (range !== "30d") params.set("range", range);
  if (top !== "sellers") params.set("top", top);
  const text = params.toString();
  return `${prefix === "" ? "/" : prefix}${text === "" ? "" : `?${text}`}#${anchor}`;
}

function chart(context: PageContext, model: HomeModel): Node {
  const ids = facilitatorsOf(context).map((entry) => entry.id);
  const daily = model.overview.daily ?? [];
  const series = ids.filter((id) => daily.some((row) => row.facilitator === id && row.payments > 0));
  const shown = series.length === 0 ? ids.slice(0, 1) : series;
  return card(
    {
      title: "Payments per day",
      icon: "report",
      cls: "chartcard",
      id: "per-day",
      end: seg(
        "Range",
        (
          [
            ["7d", "7 days"],
            ["30d", "30 days"],
            ["all", "All"],
          ] as const
        ).map(([range, label]) => ({
          label,
          href: homeHref(context, range, model.top, "per-day"),
          on: model.range === range,
        })),
      ),
    },
    model.overview.daily === undefined
      ? empty("No daily totals to show", "The index has not counted these days yet.")
      : stackChart(
          chartDays(context, model.overview, shown),
          shown.map((id) => ({ name: facShort(context, id), tone: seriesTone(id) })),
        ),
  );
}

function latestCard(context: PageContext, model: HomeModel, rows: number): Node {
  const view = context.layout.view;
  const paid = model.paid.status === "ok" ? model.paid.value : undefined;
  const total = context.report?.aggregates.headline.payments;
  return card(
    {
      title: "Latest payments",
      icon: "list",
      link: {
        href: `${view.prefix}/payments`,
        label: total === undefined || total === 0 ? "All →" : `All ${groupThousands(total)} →`,
      },
    },
    model.latest.length === 0
      ? empty("No payments yet", `No ${view.label.toLowerCase()} payment is indexed yet.`)
      : h(
          "div",
          { class: "feed2" },
          model.latest.slice(0, rows).map((row) => {
            const found = paidForRow(paid, row);
            // What it paid for, when the Bazaar knows; nothing when there is no Bazaar or it did not answer.
            const what =
              found !== undefined
                ? listingName(found.listing)
                : context.bazaar && model.paid.status === "ok"
                  ? "not in the Bazaar"
                  : undefined;
            return payRow({
              href: `${view.prefix}/tx/${row.txHash}`,
              hash: hash8(row.txHash),
              sub: [ago(row.closedAt, context.now), what].filter((part) => part !== undefined).join(" · "),
              middle: { title: `${shortKey(row.payer)} → ${shortKey(row.payTo)}`, sub: "buyer → seller" },
              amount: rowAmount(context, row),
              badges: [schemePill(row.scheme), facBadge(context, row.attribution.facilitatorId, false)],
            });
          }),
        ),
  );
}

function topCard(context: PageContext, model: HomeModel, bazaarRows: Child): Node {
  const view = context.layout.view;
  const top = model.overview.top;
  return card(
    {
      title: "Top",
      icon: "star",
      id: "top",
      end: seg("Top list", [
        {
          label: "Sellers",
          href: homeHref(context, model.range, "sellers", "top"),
          on: model.top === "sellers",
        },
        {
          label: "Buyers",
          href: homeHref(context, model.range, "buyers", "top"),
          on: model.top === "buyers",
        },
      ]),
    },
    top === undefined || top.length === 0
      ? empty(top === undefined ? "Not read just now" : "No accounts yet")
      : h(
          "div",
          { class: "rank" },
          top.map((entry, index) =>
            h(
              "a",
              { href: `${view.prefix}/account/${entry.address}` },
              h("em", null, String(index + 1)),
              h("span", { title: entry.address }, shortKey(entry.address)),
              h(
                "span",
                { class: "m" },
                entry.buyers === undefined
                  ? `${units(entry.volume, 4)} USDC`
                  : `${groupThousands(entry.buyers)} buyer${entry.buyers === 1 ? "" : "s"}`,
              ),
              h("span", { class: "v" }, groupThousands(entry.payments)),
            ),
          ),
        ),
    bazaarRows,
  );
}

/** Three of the Bazaar's busiest listings, under the top list (networks with a Bazaar only). */
function bazaarList(context: PageContext, model: HomeModel): Child {
  if (!context.bazaar) return null;
  const view = context.layout.view;
  const services = model.services.status === "ok" ? model.services.value : [];
  const listings = services.flatMap((service) => service.listings);
  return [
    h(
      "h2",
      { class: "a-h2gap" },
      iconBox("overview"),
      "In the Bazaar",
      h("a", { href: `${view.prefix}/services` }, `${groupThousands(listings.length)} →`),
    ),
    model.services.status === "down"
      ? empty("The Bazaar did not answer", "Try again shortly.")
      : listings.length === 0
        ? empty("No listings yet")
        : h(
            "div",
            { class: "rank" },
            listings
              .slice(0, 3)
              .map((listing) =>
                h(
                  "a",
                  { href: `${view.prefix}/resource/${listing.id}` },
                  h("em", null, "·"),
                  h("span", { class: "a-sans" }, listingName(listing)),
                  h("span", { class: "m" }, listingPrice(context, listing).replace(/ USDC$/, "")),
                  h("span", { class: "v" }, schemePill(listing.scheme)),
                ),
              ),
          ),
  ];
}

export function homePage(context: PageContext, model: HomeModel): string {
  const view = context.layout.view;
  return page(
    { ...context.layout, title: `${view.label} overview`, path: "", section: "home" },
    h(
      "section",
      { class: "top" },
      h(
        "div",
        { class: "hello" },
        h("h1", null, `x402 payments on Stellar ${view.label.toLowerCase()}`),
        h("p", null, "Every payment settled by a registered facilitator, read straight from the ledger."),
        searchBox(view),
      ),
      liveBox(context, model),
    ),
    context.report === undefined
      ? h("p", { class: "notice", role: "status" }, `No ${view.label.toLowerCase()} ledgers are indexed yet.`)
      : [
          tiles(context, model),
          h(
            "div",
            { class: "row3" },
            whoSettles(context, model),
            feesCard(context, model),
            keptApart(context),
          ),
          chart(context, model),
        ],
    h(
      "div",
      { class: "main" },
      // Without a Bazaar the side card holds a longer top list and the feed fewer rows: both end level.
      latestCard(context, model, context.bazaar ? 6 : 5),
      topCard(context, model, bazaarList(context, model)),
    ),
  );
}

// --- the old search form ---------------------------------------------------------------------------
// Kept for the old search page (misc.ts) and the listing matcher until that page is removed.

export type SearchScope = "all" | "payments" | "accounts" | "endpoints" | "tools";
