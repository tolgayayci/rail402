import type { RegistryFacilitator, SettlementRow } from "@rail402.dev/x402-index";
import type { DayCount, FacilitatorStats, FacilitatorSummary } from "../../api/queries-c.ts";
import type { Totals } from "../../rebuild/aggregates.ts";
import type { Answer } from "../bazaar.ts";
import { amountText, h, type Child, type Node } from "../components.ts";
import { ago, assetName, dayLabel, decimalAmount, groupThousands, shortHash, shortKey } from "../format.ts";
import type { Holdings } from "../holdings.ts";
import { displayText, safeHttpsUrl } from "../text.ts";
import {
  DOCS_URL,
  actionLink,
  bdg,
  card,
  cell,
  checks,
  dataTable,
  empty,
  facPill,
  facTone,
  kv,
  miniBars,
  networkPill,
  page,
  pageHead,
  payRow,
  schemePill,
  shareBar,
  stackChart,
  tableRow,
  tile,
  type Bar,
  type StackDay,
} from "../ui.ts";
import { usdcContract, type PageContext } from "./context.ts";

/** The id of the detail page of the payments no registered facilitator explains. */
export const UNREGISTERED = "unregistered";

/** Days the payments-per-day charts show. */
const CHART_DAYS = 30;

/** Registry roles as the pages group them, in this order. */
const ROLE_GROUPS: readonly {
  readonly label: string;
  readonly one: string;
  readonly what: string;
  readonly roles: readonly string[];
}[] = [
  {
    label: "Fee payers",
    one: "fee payer",
    what: "pay the network fee for the buyer",
    roles: ["sponsor", "fee-bump"],
  },
  { label: "Senders", one: "sender", what: "submit the payment to Stellar", roles: ["channel"] },
  { label: "Relayers", one: "relayer", what: "relay the payment and pay its fee", roles: ["relayer"] },
  {
    label: "upto authorities",
    one: "upto authority",
    what: "settle metered payments",
    roles: ["upto-authority"],
  },
];

/** Chart classes of the facilitator colours (`facTone`). */
const CHART_TONE: Readonly<Record<string, string>> = {
  r4: "c-r4",
  x4: "c-reg",
  bs: "c-bs",
  av: "c-av",
  gen: "c-gen",
  sh: "c-sh",
};

/** A facilitator's short name: "Rail402", "x402.org", "Built on Stellar", "AlgoVoi". */
export function shortName(entry: Pick<RegistryFacilitator, "id" | "name">): string {
  if (entry.id === "rail402") return "Rail402";
  const name = displayText(entry.name, 100)
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/\s+facilitator$/i, "")
    .trim();
  return name === "" ? displayText(entry.name, 100) : name;
}

/** Whether a facilitator's payments count in the totals (the concluded beta's never do). */
const counted = (entry: RegistryFacilitator) => entry.tier !== "rail402-beta";

const pct = (part: number, total: number) => (total <= 0 ? 0 : Math.round((part / total) * 100));

/** Stroops as XLM with at most `places` decimals (five below one XLM, so a small total is never 0). */
function xlm(stroops: bigint, wanted: number): string {
  const places = stroops < 10_000_000n ? Math.max(wanted, 5) : wanted;
  const scale = 10n ** BigInt(7 - places);
  return decimalAmount((((stroops + scale / 2n) / scale) * scale).toString());
}

/** Atomic USDC for a table: two decimals, "<0.01" for dust. */
export function usdcShort(atomic: string | undefined): string {
  if (atomic === undefined || !/^\d+$/.test(atomic)) return "0";
  const value = BigInt(atomic);
  if (value === 0n) return "0";
  if (value < 100_000n) return "<0.01";
  const text = ((value + 50_000n) / 100_000n).toString().padStart(3, "0");
  return `${groupThousands(text.slice(0, -2))}.${text.slice(-2)}`;
}

/** The last `CHART_DAYS` UTC day keys, ending at `end`. */
function dayKeys(end: string): string[] {
  const last = Date.parse(`${end}T00:00:00Z`);
  return Array.from({ length: CHART_DAYS }, (_, i) =>
    new Date(last - (CHART_DAYS - 1 - i) * 86_400_000).toISOString().slice(0, 10),
  );
}

/** The day the charts end at: the newest row's, else today. */
export const chartEnd = (newest: string | null, now: number) =>
  newest ?? new Date(now).toISOString().slice(0, 10);

/** The first day of the charts ending at `end`. */
export const chartStart = (end: string) => dayKeys(end)[0] ?? end;

/** Every seventh day is labelled, counted back from the newest. */
const axisLabel = (keys: readonly string[], i: number) =>
  (keys.length - 1 - i) % 7 === 0 ? dayLabel(keys[i] ?? "") : "";

/** A short age for table cells: "9 min ago", "3 h ago", "4 d ago". */
export function shortAgo(iso: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (Number.isNaN(minutes)) return "—";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${String(minutes)} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${String(hours)} h ago` : `${String(Math.floor(hours / 24))} d ago`;
}

/** A facilitator's registry accounts of `epoch`, per role group. */
function roleCounts(entry: RegistryFacilitator, epoch: string): number[] {
  return ROLE_GROUPS.map(
    (group) =>
      entry.accounts.filter((account) => account.epoch === epoch && group.roles.includes(account.role))
        .length,
  );
}

/** The registry evidence of a facilitator: the first https source of its accounts. */
function evidenceUrl(entry: RegistryFacilitator): string | undefined {
  for (const account of entry.accounts)
    for (const item of account.evidence) {
      const url = safeHttpsUrl(item.url);
      if (url !== undefined) return url;
    }
  return undefined;
}

// --- list --------------------------------------------------------------------------------------------

export interface FacilitatorsModel {
  /** Per facilitator from the index; undefined when the database did not answer. */
  readonly summaries: readonly FacilitatorSummary[] | undefined;
  readonly days: readonly DayCount[] | undefined;
  readonly chartEnd: string;
}

interface Row {
  readonly id: string;
  readonly entry: RegistryFacilitator | undefined;
  readonly name: string;
  readonly sub: string;
  readonly totals: Totals | undefined;
  readonly summary: FacilitatorSummary | undefined;
  readonly kind: "counted" | "concluded" | "apart";
}

export function facilitatorsPage(context: PageContext, model: FacilitatorsModel): string {
  const view = context.layout.view;
  const p = view.prefix;
  const report = context.report;
  const usdc = usdcContract(report);
  const epoch = context.registry.document.epochs.at(-1)?.id ?? "";
  const facilitators = context.registry.document.facilitators;
  const registered = facilitators.filter(counted);
  const summary = (id: string | null) => model.summaries?.find((entry) => entry.id === id);
  const headline = report?.aggregates.headline.payments ?? 0;
  const apart = report?.aggregates.unattributedShaped;
  const rows: Row[] = facilitators
    .map((entry): Row => ({
      id: entry.id,
      entry,
      name: shortName(entry),
      sub: counted(entry) ? displayText(entry.name, 100) : "Concluded, never in the totals",
      totals: report?.aggregates.byFacilitator[entry.id],
      summary: summary(entry.id),
      kind: counted(entry) ? "counted" : "concluded",
    }))
    .sort(
      (a, b) =>
        Number(a.kind === "concluded") - Number(b.kind === "concluded") ||
        (b.totals?.payments ?? 0) - (a.totals?.payments ?? 0) ||
        a.name.localeCompare(b.name),
    );
  rows.push({
    id: UNREGISTERED,
    entry: undefined,
    name: "Not registered",
    sub: "Looks like x402, no registered facilitator paid the fee",
    totals: apart,
    summary: summary(null),
    kind: "apart",
  });
  const counting = rows.filter((row) => row.kind === "counted");
  const fees = counting.reduce((sum, row) => sum + (row.summary?.feeStroops ?? 0n), 0n);
  const sponsoredAll = counting.every(
    (row) => (row.summary?.sponsored ?? 0) === (row.summary?.payments ?? 0),
  );

  // Payments per day, one series per counted facilitator with payments in the window.
  const keys = dayKeys(model.chartEnd);
  const perDay = new Map<string, number>();
  for (const day of model.days ?? []) perDay.set(`${day.day}|${day.id ?? ""}`, day.payments);
  const series = counting.filter((row) => keys.some((key) => (perDay.get(`${key}|${row.id}`) ?? 0) > 0));
  const days: StackDay[] = keys.map((key, i) => ({
    label: dayLabel(key),
    short: axisLabel(keys, i),
    values: series.map((row) => perDay.get(`${key}|${row.id}`) ?? 0),
  }));

  // The registry card: accounts per role (only roles some facilitator has), one column per facilitator.
  const shown = facilitators.slice(0, 4);
  const roles = ROLE_GROUPS.map((group, i) => ({ group, i })).filter(({ i }) =>
    shown.some((entry) => (roleCounts(entry, epoch)[i] ?? 0) > 0),
  );
  const raCls = `tr ra oc-ra${String(shown.length)}`;

  return page(
    {
      ...context.layout,
      title: "Facilitators",
      path: "/facilitators",
      section: "facilitators",
      description:
        "x402 facilitators on Stellar from the public registry: payments, buyers, sellers, fees and accounts.",
    },
    pageHead({
      title: "Facilitators",
      badges: [
        bdg(`${groupThousands(registered.length)} registered`),
        bdg(`${groupThousands(headline)} payments`, "mut"),
        bdg(`${groupThousands(apart?.payments ?? 0)} not registered`, "warn"),
        networkPill(view),
      ],
      actions: [actionLink(DOCS_URL, "How listing works", "arrow", false, true)],
    }),
    h(
      "div",
      { class: "g4" },
      tile({
        label: "Registered",
        icon: "facilitators",
        value: groupThousands(registered.length),
        badges: [bdg(`registry ${context.registry.registryVersion}`, "mut")],
      }),
      tile({
        label: "Payments",
        icon: "payments",
        value: groupThousands(headline),
        badges: counting
          .filter((row) => (row.totals?.payments ?? 0) > 0)
          .map((row) =>
            h(
              "span",
              { class: `fac ${facTone(row.id)}`, title: row.name },
              h("i", null),
              `${String(pct(row.totals?.payments ?? 0, headline))}%`,
            ),
          ),
      }),
      tile({
        label: "Fees sponsored",
        icon: "shield",
        value: model.summaries === undefined ? "—" : xlm(fees, 2),
        unit: "XLM",
        badges:
          model.summaries === undefined
            ? []
            : [sponsoredAll ? bdg("buyers paid 0", "ok") : bdg("some fees not sponsored", "warn")],
      }),
      tile({
        label: "Not registered",
        icon: "alert",
        value: groupThousands(apart?.payments ?? 0),
        valueCls: "oc-mut",
        dashed: true,
        href: `${p}/facilitator/${UNREGISTERED}`,
        badges: [bdg("never in totals", "warn")],
      }),
    ),
    report === undefined
      ? h("p", { class: "oc-note" }, "The report is not ready yet: payment totals show once it is.")
      : null,
    card(
      { title: "Compare", icon: "list", cls: "oc-gap" },
      dataTable(
        "fx",
        "Facilitators",
        [
          ["Facilitator", undefined],
          ["Schemes", undefined],
          ["Share", undefined],
          ["Payments", "num"],
          ["Buyers", "num"],
          ["Sellers", "num"],
          ["USDC", "num"],
          ["Last", "num"],
        ],
        rows.map((row) => {
          const n = row.totals?.payments ?? 0;
          const used = [
            (row.summary?.exact ?? 0) > 0 ? "exact" : null,
            (row.summary?.upto ?? 0) > 0 ? "upto" : null,
          ].filter((scheme): scheme is string => scheme !== null);
          return tableRow(
            row.kind === "apart" ? "fx apartrow" : "fx",
            `${p}/facilitator/${row.id}`,
            h(
              "span",
              { role: "cell", class: "svc" },
              facPill(row.name, row.entry === undefined ? null : row.id),
              h("small", null, row.sub),
            ),
            cell(used.length === 0 ? h("span", { class: "muted" }, "—") : used.map(schemePill), "bl2"),
            h(
              "span",
              { role: "cell", class: "shr" },
              shareBar(
                row.kind === "counted"
                  ? [
                      { value: n, tone: facTone(row.id) },
                      { value: Math.max(0, headline - n), tone: "rest" },
                    ]
                  : [{ value: 1, tone: "rest" }],
              ),
              h(
                "small",
                null,
                row.kind === "counted"
                  ? `${String(pct(n, headline))}%`
                  : row.kind === "apart"
                    ? "apart"
                    : "concluded",
              ),
            ),
            cell(h("b", null, groupThousands(n)), "num"),
            cell(groupThousands(row.totals?.payers ?? 0), "num"),
            cell(groupThousands(row.totals?.sellers ?? 0), "num"),
            cell(usdc === undefined ? "—" : usdcShort(row.totals?.volume[usdc]), "num"),
            cell(
              row.summary?.lastAt === undefined || row.summary.lastAt === null
                ? "—"
                : shortAgo(row.summary.lastAt, context.now),
              "num muted",
            ),
          );
        }),
      ),
    ),
    card(
      {
        title: "Payments per day",
        icon: "report",
        cls: "chartcard oc-chart",
        end: bdg(`${dayLabel(keys[0] ?? "")} – ${dayLabel(model.chartEnd)}`, "mut"),
      },
      model.days === undefined
        ? empty("Payments per day are not available", "The index did not answer; try again shortly.")
        : series.length === 0
          ? empty("No payments in these days")
          : stackChart(
              days,
              series.map((row) => ({ name: row.name, tone: CHART_TONE[facTone(row.id)] ?? "c-gen" })),
            ),
    ),
    card(
      {
        title: "Registry",
        icon: "shield",
        cls: "oc-gap",
        end: bdg(`version ${context.registry.registryVersion}`, "mut"),
      },
      h(
        "div",
        { class: "reg2" },
        h(
          "div",
          { class: "tbl", role: "table", "aria-label": "Registered accounts" },
          h(
            "div",
            { class: `${raCls} th`, role: "row" },
            h("span", { role: "columnheader" }, "Registered accounts"),
            shown.map((entry) => h("span", { role: "columnheader", class: "num" }, shortName(entry))),
          ),
          roles.map(({ group, i }) =>
            h(
              "div",
              { class: raCls, role: "row" },
              h(
                "span",
                { role: "cell", class: "rl" },
                h("b", null, group.label),
                h("small", null, group.what),
              ),
              shown.map((entry) => {
                const value = roleCounts(entry, epoch)[i] ?? 0;
                return h(
                  "span",
                  { role: "cell", class: "num" },
                  h("b", null, value === 0 ? "—" : groupThousands(value)),
                );
              }),
            ),
          ),
        ),
        h(
          "div",
          null,
          h("div", { class: "tr th rh" }, h("span", null, "A payment counts when")),
          checks(
            [
              { label: "A registered account paid the fee", ok: true },
              { label: "It came from that facilitator's account", ok: true },
              { label: "The account was registered at that ledger", ok: true },
            ],
            "why one tight",
          ),
        ),
      ),
    ),
  );
}

// --- detail ------------------------------------------------------------------------------------------

export interface FacilitatorModel {
  /** The registry entry; undefined for the payments no registered facilitator explains. */
  readonly facilitator: RegistryFacilitator | undefined;
  readonly stats: FacilitatorStats | undefined;
  readonly days: readonly DayCount[] | undefined;
  readonly chartEnd: string;
  readonly latest: readonly SettlementRow[];
  /** The current sponsor's live XLM (Lumeus): context only, never counted. */
  readonly sponsor?: string | undefined;
  readonly holdings?: Answer<Holdings> | undefined;
}

export function facilitatorPage(context: PageContext, model: FacilitatorModel): string {
  const view = context.layout.view;
  const p = view.prefix;
  const entry = model.facilitator;
  const id = entry?.id ?? UNREGISTERED;
  const report = context.report;
  const usdc = usdcContract(report);
  const epoch = context.registry.document.epochs.at(-1)?.id ?? "";
  const totals =
    entry === undefined ? report?.aggregates.unattributedShaped : report?.aggregates.byFacilitator[id];
  const stats = model.stats;
  const tone = facTone(entry === undefined ? null : id);
  const name = entry === undefined ? "Not registered" : shortName(entry);
  const payments = totals?.payments ?? stats?.payments ?? 0;
  const counted = stats?.payments ?? 0;
  const sponsored = stats === undefined || counted === 0 ? undefined : pct(stats.sponsored, counted);
  const schemes = (["exact", "upto"] as const)
    .map((scheme) => ({ scheme, count: stats === undefined ? 0 : stats[scheme] }))
    .filter((item) => item.count > 0);
  const allPayments = `${p}/payments?facilitator=${entry === undefined ? "shaped" : id}`;
  const evidence = entry === undefined ? undefined : evidenceUrl(entry);
  const otherTokens = (stats?.tokens ?? [])
    .filter((token) => token.contract !== usdc)
    .reduce((sum, token) => sum + token.payments, 0);
  const current = entry?.accounts.filter((account) => account.epoch === epoch) ?? [];
  const counts = entry === undefined ? [] : roleCounts(entry, epoch);
  const top = stats?.topSellers[0];

  // Payments per day of this facilitator.
  const keys = dayKeys(model.chartEnd);
  const perDay = new Map<string, number>();
  for (const day of model.days ?? []) if ((day.id ?? UNREGISTERED) === id) perDay.set(day.day, day.payments);
  const bars: Bar[] = keys.map((key, i) => ({
    tip: `${dayLabel(key)} · ${groupThousands(perDay.get(key) ?? 0)}`,
    label: axisLabel(keys, i),
    value: perDay.get(key) ?? 0,
    today: i === keys.length - 1,
  }));

  const account = (address: string) =>
    h("a", { class: "u", href: `${p}/account/${address}`, title: address }, shortKey(address));
  const counted1 = (items: readonly { readonly address: string; readonly payments: number }[]) =>
    items.flatMap((item) => [account(item.address), bdg(groupThousands(item.payments), "mut")]);
  const held =
    model.holdings?.status === "ok"
      ? model.holdings.value.items.find((item) => item.kind === "native")?.balance
      : undefined;
  const buyers =
    stats === undefined
      ? undefined
      : [
          stats.payers > stats.contractPayers
            ? `${groupThousands(stats.payers - stats.contractPayers)} accounts`
            : "",
          stats.contractPayers > 0 ? `${groupThousands(stats.contractPayers)} contracts` : "",
        ]
          .filter((part) => part !== "")
          .join(" · ");

  const left: Node[] = [
    card(
      {
        title: "Payments per day",
        icon: "report",
        end: bdg(
          stats?.lastAt === undefined || stats.lastAt === null
            ? "no payments yet"
            : `last ${ago(stats.lastAt, context.now)}`,
          "mut",
        ),
      },
      model.days === undefined
        ? empty("Payments per day are not available", "The index did not answer; try again shortly.")
        : miniBars(bars, `mb big2 oc-bars-${tone}`),
    ),
    card(
      { title: "Top sellers", icon: "bazaar" },
      stats === undefined || stats.topSellers.length === 0
        ? empty(stats === undefined ? "Not available right now" : "No sellers yet")
        : dataTable(
            "ts",
            "Top sellers",
            [
              ["Seller", undefined],
              ["Payments", "num"],
              ["Buyers", "num"],
              ["USDC", "num"],
            ],
            stats.topSellers
              .slice(0, 4)
              .map((seller, i) =>
                tableRow(
                  "ts",
                  `${p}/account/${seller.address}`,
                  h(
                    "span",
                    { role: "cell", class: "mono2", title: seller.address },
                    h("em", { class: "rk" }, String(i + 1)),
                    shortKey(seller.address),
                  ),
                  cell(h("b", null, groupThousands(seller.payments)), "num"),
                  cell(groupThousands(seller.payers), "num"),
                  cell(usdc === undefined ? "—" : usdcShort(seller.usdc), "num"),
                ),
              ),
          ),
    ),
    card(
      {
        title: "Latest payments",
        icon: "list",
        link: { href: allPayments, label: `All ${groupThousands(payments)} →` },
      },
      model.latest.length === 0
        ? empty("No payments yet")
        : h(
            "div",
            { class: "feed2" },
            model.latest.map((row) =>
              payRow({
                href: `${p}/tx/${row.txHash}`,
                hash: shortHash(row.txHash),
                sub: ago(row.closedAt, context.now),
                middle: { title: `${shortKey(row.payer)} → ${shortKey(row.payTo)}`, sub: "buyer → seller" },
                amount: amountText(row),
                badges: [schemePill(row.scheme), facPill(name, entry === undefined ? null : id)],
              }),
            ),
          ),
    ),
  ];

  const right: Node[] = [
    card(
      { title: "Schemes", icon: "tag" },
      schemes.length === 0
        ? empty(stats === undefined ? "Not available right now" : "No payments yet")
        : [
            shareBar(
              schemes.map((item) => ({ value: item.count, tone: item.scheme })),
              "sbar tall",
            ),
            h(
              "dl",
              { class: "kv2" },
              schemes.map((item) => [
                h("dt", null, schemePill(item.scheme)),
                h(
                  "dd",
                  null,
                  h("b", null, groupThousands(item.count)),
                  h("span", { class: "muted" }, `${String(pct(item.count, counted))}%`),
                ),
              ]),
              stats !== undefined && stats.upto > 0 && stats.uptoMax > 0n
                ? [
                    h("dt", null, "upto used"),
                    h(
                      "dd",
                      null,
                      bdg(
                        `${String(Number((stats.uptoAmount * 100n + stats.uptoMax / 2n) / stats.uptoMax))}% of the max`,
                        "info",
                      ),
                    ),
                  ]
                : null,
            ),
          ],
    ),
    card(
      { title: "Fees", icon: "shield" },
      kv([
        ["Network fees paid", h("b", null, stats === undefined ? "—" : `${xlm(stats.feeStroops, 2)} XLM`)],
        [
          "Per payment",
          stats === undefined || counted === 0 ? "—" : `${xlm(stats.feeStroops / BigInt(counted), 5)} XLM`,
        ],
        [
          "Paid by buyers",
          stats === undefined
            ? "—"
            : stats.sponsored === counted
              ? bdg("0 XLM", "ok")
              : bdg(`in ${groupThousands(counted - stats.sponsored)} payments`, "warn"),
        ],
        [
          "Sponsored",
          sponsored === undefined
            ? "—"
            : bdg(`${String(sponsored)}% of payments`, sponsored === 100 ? "ok" : "warn"),
        ],
        model.sponsor === undefined || held === undefined
          ? null
          : ["Sponsor holds", `${held} XLM`, bdg("live", "dash", "Read live from the ledger, never counted")],
      ]),
    ),
    card(
      {
        title: "Accounts",
        icon: "user",
        end:
          entry === undefined
            ? bdg("none registered", "warn")
            : bdg(`registry ${context.registry.registryVersion}`, "ok"),
      },
      kv([
        [
          "Pays the fee",
          ...(stats === undefined ? ["—"] : counted1(stats.feePayers.slice(0, entry === undefined ? 2 : 1))),
        ],
        ["Sends", ...(stats === undefined ? ["—"] : counted1(stats.senders.slice(0, 1)))],
        [
          "In use",
          h(
            "span",
            { class: "sans" },
            stats === undefined
              ? "—"
              : `${groupThousands(stats.feePayerCount)} ${stats.feePayerCount === 1 ? "fee payer" : "fee payers"}, ${groupThousands(stats.senderCount)} ${stats.senderCount === 1 ? "sender" : "senders"}`,
          ),
        ],
        entry === undefined
          ? null
          : [
              "Registered",
              ...ROLE_GROUPS.flatMap((group, i) => {
                const n = counts[i] ?? 0;
                return n === 0
                  ? []
                  : [bdg(`${groupThousands(n)} ${n === 1 ? group.one : group.label.toLowerCase()}`)];
              }),
            ],
        current.length === 0
          ? null
          : [
              "Valid from",
              `ledger ${groupThousands(Math.min(...current.map((item) => item.validFromLedger)))}`,
            ],
      ]),
    ),
    card(
      { title: "Tokens", icon: "coin" },
      stats === undefined || stats.tokens.length === 0
        ? empty(stats === undefined ? "Not available right now" : "No tokens yet")
        : kv(
            stats.tokens.map((token): [string, ...Child[]] => [
              token.verified && token.code === "native"
                ? "XLM"
                : token.verified && token.code !== null
                  ? assetName(view.network, token.contract, token.code, token.issuer)
                  : shortKey(token.contract),
              h("b", null, groupThousands(token.payments)),
              token.verified ? bdg("verified", "ok") : bdg("unverified", "warn"),
            ]),
          ),
    ),
  ];

  return page(
    {
      ...context.layout,
      title: entry === undefined ? "Not registered" : displayText(entry.name, 100),
      path: `/facilitator/${id}`,
      section: "facilitators",
      description:
        entry === undefined
          ? "x402-shaped payments on Stellar that no registered facilitator explains, kept apart from every total."
          : `${displayText(entry.name, 100)}: payments, buyers, sellers, fees and registry accounts.`,
    },
    pageHead({
      crumbs: [
        ["Facilitators", `${p}/facilitators`],
        [name, undefined],
      ],
      title: name,
      square: tone,
      lede:
        entry === undefined
          ? "Looks like x402, but no registered facilitator paid the fee"
          : displayText(entry.name, 100),
      badges: [
        entry === undefined
          ? bdg("not registered", "warn")
          : entry.tier === "rail402-beta"
            ? bdg("concluded", "dash")
            : bdg("registered", "ok"),
        ...schemes.map((item) => schemePill(item.scheme)),
        sponsored === undefined ? null : bdg(`fees sponsored ${String(sponsored)}%`, "ok"),
        entry?.sharedRelayer === true
          ? bdg("shared relayer", "info", "Its accounts also relay transactions that are not x402 payments")
          : null,
        networkPill(view),
      ],
      actions: [
        evidence === undefined ? null : actionLink(evidence, "Registry proof", "external", false, true),
        actionLink(allPayments, "All payments", "arrow", true),
      ].filter((action): action is Node => action !== null),
    }),
    h(
      "div",
      { class: "g4" },
      tile({
        label: "Payments",
        icon: "payments",
        value: groupThousands(payments),
        dashed: entry === undefined,
        badges: [
          bdg(
            stats?.firstAt === undefined || stats.firstAt === null
              ? "none yet"
              : `since ${dayLabel(stats.firstAt.slice(0, 10))}`,
            "mut",
          ),
        ],
      }),
      tile({
        label: "Buyers",
        icon: "user",
        value: groupThousands(totals?.payers ?? stats?.payers ?? 0),
        dashed: entry === undefined,
        badges: buyers === undefined || buyers === "" ? [] : [bdg(buyers, "mut")],
      }),
      tile({
        label: "Sellers",
        icon: "bazaar",
        value: groupThousands(totals?.sellers ?? stats?.sellers ?? 0),
        dashed: entry === undefined,
        badges: top === undefined ? [] : [bdg(`top: ${shortKey(top.address)}`, "mut")],
      }),
      tile({
        label: "Volume",
        icon: "coin",
        value: usdc === undefined ? "—" : usdcShort(totals?.volume[usdc]),
        unit: "USDC",
        dashed: entry === undefined,
        badges:
          stats === undefined
            ? []
            : [
                bdg(
                  otherTokens > 0 ? `+ ${groupThousands(otherTokens)} in other tokens` : "USDC only",
                  "mut",
                ),
              ],
      }),
    ),
    h(
      "div",
      { class: "g21" },
      h("div", { class: "oc-col" }, ...left),
      h("div", { class: "oc-col" }, ...right),
    ),
    entry === undefined
      ? card(
          { title: "Why these are apart", icon: "alert", cls: "dashed oc-gap" },
          checks(
            [
              { label: "Shaped like an x402 payment", ok: true },
              { label: "Fee paid by an account no facilitator registered", ok: false },
              { label: "Kept out of every total on this site", ok: true },
            ],
            "why one",
          ),
        )
      : null,
  );
}
