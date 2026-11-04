import type { SettlementRow } from "@rail402.dev/x402-index";
import type { AccountSample } from "../../api/queries-a.ts";
import type { AccountRole, AccountTotals, SellerSummary } from "../../api/queries.ts";
import type { Answer, Listing, SellerUsage } from "../bazaar.ts";
import type { Holdings } from "../holdings.ts";
import { h, type Child, type Node } from "../components.ts";
import { ago, assetName, groupThousands, shortKey, stellarExpertAccount } from "../format.ts";
import { displayText } from "../text.ts";
import {
  actionLink,
  barTile,
  bdg,
  card,
  cell,
  copyAction,
  dataTable,
  empty,
  facPill,
  facTone,
  kv,
  miniCard,
  page,
  pageHead,
  pager,
  schemePill,
  seg,
  shareBar,
  tableRow,
  type Bar,
} from "../ui.ts";
import { listingPrice, usdcContract, type PageContext } from "./context.ts";
import {
  dayKey,
  dayKeys,
  facBadge,
  facShort,
  hash8,
  listingName,
  monthDay,
  rowCode,
  rowValue,
  units,
} from "./home.ts";
import { ROLE_NAMES } from "./search.ts";
import { serviceName } from "./services.ts";

/** A registry entry of the account: which facilitator it belongs to, in which role. */
export interface Membership {
  readonly facilitatorId: string;
  readonly role: string;
  readonly validFromLedger: number;
  readonly validToLedger: number | null;
  readonly evidence: string | undefined;
}

export interface AccountPageModel {
  readonly address: string;
  readonly muxedId: string | undefined;
  readonly role: AccountRole;
  readonly page: number;
  readonly totals: AccountTotals;
  /** Distinct buyers of a seller, from the index; undefined when it did not answer. */
  readonly summary: SellerSummary | undefined;
  /** The newest payments: the table, the cards and the bars come from them. */
  readonly sample: AccountSample;
  readonly memberships: readonly Membership[];
  /** The account's listings in the Bazaar, as a seller (payTo); undefined without a Bazaar. */
  readonly listings: Answer<readonly Listing[]> | undefined;
  /** Payments the Bazaar linked to each listing. */
  readonly usage: Answer<SellerUsage> | undefined;
  /** Live holdings (Lumeus Assets): context only, never counted. */
  readonly holdings: Answer<Holdings> | undefined;
}

const PER_PAGE = 10;
const BAR_DAYS = 14;
/** Registry roles whose account pays the network fee of the payments it settles. */
export const FEE_ROLES = new Set(["sponsor", "fee-bump", "relayer"]);

/** The account's page in parts: who it is to the payments it took part in. */
interface View {
  readonly seller: boolean;
  readonly buyer: boolean;
  /** A registered fee payer that neither paid nor received. */
  readonly feeOnly: boolean;
  readonly received: number;
  readonly paid: number;
}

function viewOf(model: AccountPageModel): View {
  const sum = (role: "payer" | "payTo") =>
    model.totals.items.filter((total) => total.role === role).reduce((n, total) => n + total.payments, 0);
  const inSample = (pick: (row: SettlementRow) => boolean) => model.sample.rows.filter(pick).length;
  // The totals are read only under the current rules; the sample stands in while they are not.
  const received = Math.max(
    sum("payTo"),
    inSample((row) => row.payTo === model.address),
  );
  const paid = Math.max(
    sum("payer"),
    inSample((row) => row.payer === model.address),
  );
  const listed = model.listings?.status === "ok" && model.listings.value.length > 0;
  const feePayer = model.memberships.some((entry) => FEE_ROLES.has(entry.role));
  return {
    seller: received > 0 || listed,
    buyer: paid > 0,
    feeOnly: feePayer && received === 0 && paid === 0,
    received,
    paid,
  };
}

/** The rows the table lists: one side when the visitor picked it. */
function listed(model: AccountPageModel): readonly SettlementRow[] {
  if (model.role === "payer") return model.sample.rows.filter((row) => row.payer === model.address);
  if (model.role === "payTo") return model.sample.rows.filter((row) => row.payTo === model.address);
  return model.sample.rows;
}

/** A short address with the full strkey in its title and accessible label. */
const fullTitled = (address: string) =>
  h("span", { title: address, "aria-label": address }, shortKey(address));

const counterparty = (model: AccountPageModel, row: SettlementRow) =>
  row.payTo === model.address && row.payer !== model.address ? row.payer : row.payTo;

/** Daily bars of the sample: the last `BAR_DAYS` days up to the newest payment (or today). */
function bars(
  context: PageContext,
  model: AccountPageModel,
  rows: readonly SettlementRow[],
  value: (rows: readonly SettlementRow[]) => number,
  text: (value: number) => string,
): Bar[] {
  const today = dayKey(context.now);
  const newest = rows[0];
  if (newest === undefined) return [];
  const newestDay = dayKey(newest.closedAt);
  const recent =
    Date.parse(`${today}T00:00:00Z`) - Date.parse(`${newestDay}T00:00:00Z`) < BAR_DAYS * 86_400_000;
  const keys = dayKeys(recent ? today : newestDay, BAR_DAYS);
  // When the sample stops short of the window, the days before its oldest row are not counted.
  const oldest = model.sample.capped ? dayKey(rows.at(-1)?.closedAt ?? newest.closedAt) : undefined;
  return keys.map((day, index) => {
    const ofDay = rows.filter((row) => row.closedAt.startsWith(day));
    const counted = oldest === undefined || day >= oldest;
    return {
      tip: counted
        ? `${monthDay(day)} · ${text(value(ofDay))}`
        : `${monthDay(day)} · older than the payments read`,
      label: index % 2 === 0 || index === keys.length - 1 ? String(Number(day.slice(8, 10))) : "",
      value: counted ? value(ofDay) : 0,
      today: day === today,
    };
  });
}

const distinct = (values: readonly string[]) => new Set(values).size;
const plural = (n: number, word: string) => `${groupThousands(n)} ${word}${n === 1 ? "" : "s"}`;

function usdcVolume(context: PageContext, rows: readonly SettlementRow[]): bigint {
  const usdc = usdcContract(context.report);
  return rows.filter((row) => row.asset.contract === usdc).reduce((sum, row) => sum + BigInt(row.amount), 0n);
}

function tiles(context: PageContext, model: AccountPageModel, view: View): Node {
  const rows = listed(model);
  const capped = model.sample.capped ? "+" : "";
  const usdc = usdcContract(context.report);
  if (view.feeOnly) {
    const fee = (list: readonly SettlementRow[]) =>
      list.reduce((sum, row) => sum + BigInt(row.fee.chargedStroops), 0n);
    return h(
      "div",
      { class: "tiles4" },
      barTile({
        label: "Payments it paid for",
        icon: "payments",
        value: `${groupThousands(rows.length)}${capped}`,
        badges: [bdg("fee paid", "mut")],
        bars: bars(
          context,
          model,
          rows,
          (list) => list.length,
          (n) => plural(n, "payment"),
        ),
      }),
      barTile({
        label: "Fees paid",
        icon: "shield",
        value: units(fee(rows), 2),
        unit: "XLM",
        badges: [bdg("for buyers", "mut")],
        bars: bars(
          context,
          model,
          rows,
          (list) => Number(fee(list)),
          (n) => `${units(BigInt(n), 4)} XLM`,
        ),
      }),
      barTile({
        label: "Sellers served",
        icon: "bazaar",
        value: `${groupThousands(distinct(rows.map((row) => row.payTo)))}${capped}`,
        badges: [bdg("distinct", "mut")],
        bars: bars(
          context,
          model,
          rows,
          (list) => distinct(list.map((row) => row.payTo)),
          (n) => plural(n, "seller"),
        ),
      }),
      barTile({
        label: "Fee per payment",
        icon: "tag",
        value: rows.length === 0 ? "0" : units(fee(rows) / BigInt(rows.length), 4),
        unit: "XLM",
        badges: [bdg("average", "mut")],
        bars: bars(
          context,
          model,
          rows,
          (list) => list.length,
          (n) => plural(n, "payment"),
        ),
      }),
    );
  }
  // The side with more payments leads; the other is counted in the first tile's badge.
  const side: "payer" | "payTo" = view.received > 0 && view.received >= view.paid ? "payTo" : "payer";
  const sideRows = rows.filter((row) =>
    side === "payTo" ? row.payTo === model.address : row.payer === model.address,
  );
  const total = (pick: "payments" | "volume") =>
    model.totals.items
      .filter((entry) => entry.role === side && entry.assetContract === usdc)
      .reduce((sum, entry) => sum + BigInt(pick === "payments" ? entry.payments : entry.volume), 0n);
  const usdcPayments = Number(total("payments"));
  const volume = model.totals.items.length > 0 ? total("volume") : usdcVolume(context, sideRows);
  const counterparties =
    side === "payTo" && model.summary !== undefined && model.summary.payers > 0
      ? groupThousands(model.summary.payers)
      : `${groupThousands(distinct(sideRows.map((row) => counterparty(model, row))))}${capped}`;
  const count = side === "payTo" ? view.received : view.paid;
  const perPayment = usdcPayments > 0 ? volume / BigInt(usdcPayments) : 0n;
  return h(
    "div",
    { class: "tiles4" },
    barTile({
      label: side === "payTo" ? "Payments received" : "Payments made",
      icon: "payments",
      value: groupThousands(count),
      badges: [
        bdg(
          view.seller && view.buyer
            ? side === "payTo"
              ? `+ ${groupThousands(view.paid)} paid`
              : `+ ${groupThousands(view.received)} received`
            : "in total",
          "mut",
        ),
      ],
      bars: bars(
        context,
        model,
        sideRows,
        (list) => list.length,
        (n) => plural(n, "payment"),
      ),
    }),
    barTile({
      label: side === "payTo" ? "Received" : "Paid",
      icon: "coin",
      value: units(volume, 2),
      unit: "USDC",
      badges: [bdg("verified", "mut")],
      bars: bars(
        context,
        model,
        sideRows,
        (list) => Number(usdcVolume(context, list)),
        (n) => `${units(BigInt(n), 4)} USDC`,
      ),
    }),
    barTile({
      label: side === "payTo" ? "Buyers" : "Sellers",
      icon: "user",
      value: counterparties,
      badges: [bdg("distinct", "mut")],
      bars: bars(
        context,
        model,
        sideRows,
        (list) => distinct(list.map((row) => counterparty(model, row))),
        (n) => plural(n, side === "payTo" ? "buyer" : "seller"),
      ),
    }),
    barTile({
      label: "Per payment",
      icon: "tag",
      value: units(perPayment, 4),
      unit: "USDC",
      badges: [bdg("average", "mut")],
      bars: bars(
        context,
        model,
        sideRows,
        (list) => list.length,
        (n) => plural(n, "payment"),
      ),
    }),
  );
}

function accountHref(
  context: PageContext,
  model: AccountPageModel,
  role: AccountRole,
  pageNumber = 1,
): string {
  const params = new URLSearchParams();
  if (role !== "any") params.set("role", role);
  if (model.muxedId !== undefined) params.set("muxed", model.muxedId);
  if (pageNumber > 1) params.set("page", String(pageNumber));
  const text = params.toString();
  return `${context.layout.view.prefix}/account/${model.address}${text === "" ? "" : `?${text}`}#payments`;
}

function paymentsCard(context: PageContext, model: AccountPageModel, view: View): Node {
  const prefix = context.layout.view.prefix;
  const rows = listed(model);
  const pages = Math.max(1, Math.ceil(rows.length / PER_PAGE));
  const current = Math.min(model.page, pages);
  const both = view.seller && view.buyer;
  const heading = view.feeOnly
    ? "Payments it paid the fee for"
    : both
      ? model.role === "payer"
        ? "Payments made"
        : model.role === "payTo"
          ? "Payments received"
          : "Payments in and out"
      : view.seller
        ? "Payments received"
        : "Payments made";
  const cpHead = view.feeOnly
    ? "Seller"
    : both && model.role === "any"
      ? "Counterparty"
      : view.seller && model.role !== "payer"
        ? "From"
        : "To";
  const total = view.feeOnly
    ? `${groupThousands(rows.length)}${model.sample.capped ? "+" : ""}`
    : groupThousands(
        model.role === "payer"
          ? view.paid
          : model.role === "payTo"
            ? view.received
            : view.paid + view.received,
      );
  return card(
    {
      title: heading,
      icon: "list",
      id: "payments",
      end: [
        both && model.muxedId === undefined
          ? seg("Side", [
              { label: "All", href: accountHref(context, model, "any"), on: model.role === "any" },
              { label: "Received", href: accountHref(context, model, "payTo"), on: model.role === "payTo" },
              { label: "Paid", href: accountHref(context, model, "payer"), on: model.role === "payer" },
            ])
          : null,
        bdg(`${total} total`, "mut"),
      ],
    },
    model.muxedId === undefined
      ? null
      : h("p", { class: "muted a-sub" }, `Payments to muxed id ${displayText(model.muxedId, 24)} only.`),
    rows.length === 0
      ? empty(
          "No payments",
          view.feeOnly || model.memberships.length > 0
            ? "This account settles payments for a facilitator; they are listed on the facilitator's page."
            : `No x402 payment of this account is indexed on ${context.layout.view.label.toLowerCase()}.`,
        )
      : dataTable(
          "ap",
          heading,
          [
            ["Payment", undefined],
            [cpHead, undefined],
            ["Amount", "num"],
            ["Via", undefined],
            ["When", "num"],
          ],
          rows.slice((current - 1) * PER_PAGE, current * PER_PAGE).map((row) => {
            const incoming = row.payTo === model.address;
            const outgoing = row.payer === model.address;
            const direction = view.feeOnly ? "" : incoming ? "in" : outgoing ? "out" : "";
            // An upto payment's cap goes in the amount's title: the column has no room for it.
            const cap =
              row.scheme === "upto" && row.maxAmount !== null
                ? `charged of ≤ ${rowValue(row, row.maxAmount)} ${rowCode(context, row)} authorized`
                : undefined;
            return tableRow(
              "ap",
              `${prefix}/tx/${row.txHash}`,
              cell(
                [
                  h(
                    "span",
                    { class: direction === "" ? "dir" : `dir ${direction}` },
                    direction === "in" ? "↓" : direction === "out" ? "↑" : "·",
                  ),
                  hash8(row.txHash),
                ],
                "mono2",
              ),
              cell(fullTitled(counterparty(model, row)), "mono2"),
              cell(
                [
                  h("b", { title: cap }, rowValue(row)),
                  " ",
                  h("span", { class: "muted" }, rowCode(context, row)),
                ],
                "num",
              ),
              cell([schemePill(row.scheme), facBadge(context, row.attribution.facilitatorId, false)], "bl2"),
              cell(ago(row.closedAt, context.now), "num muted"),
            );
          }),
        ),
    pager({
      page: current,
      pages,
      total: rows.length,
      perPage: PER_PAGE,
      label: "latest ",
      href: (n) => accountHref(context, model, model.role, n),
    }),
  );
}

function counterpartiesCard(context: PageContext, model: AccountPageModel, view: View): Node {
  const prefix = context.layout.view.prefix;
  const rows = listed(model);
  const by = new Map<string, { n: number; value: bigint }>();
  const usdc = usdcContract(context.report);
  for (const row of rows) {
    const other = counterparty(model, row);
    const entry = by.get(other) ?? { n: 0, value: 0n };
    entry.n++;
    if (view.feeOnly) entry.value += BigInt(row.fee.chargedStroops);
    else if (row.asset.contract === usdc) entry.value += BigInt(row.amount);
    by.set(other, entry);
  }
  const top = [...by.entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0])).slice(0, 5);
  const heading = view.feeOnly
    ? "Sellers it paid fees for"
    : view.seller && view.buyer
      ? "Top counterparties"
      : view.seller
        ? "Top buyers"
        : "Top sellers";
  return card(
    { title: heading, icon: "user" },
    top.length === 0
      ? empty("None yet")
      : h(
          "div",
          { class: "tbl" },
          top.map(([address, entry], index) =>
            tableRow(
              "ts2",
              `${prefix}/account/${address}`,
              cell([h("em", { class: "rk" }, String(index + 1)), fullTitled(address)], "mono2"),
              cell(
                entry.value === 0n ? "" : `${units(entry.value, 4)} ${view.feeOnly ? "XLM" : "USDC"}`,
                "num muted",
              ),
              cell(h("b", null, groupThousands(entry.n)), "num"),
            ),
          ),
        ),
    model.sample.capped
      ? h(
          "p",
          { class: "muted a-sub" },
          `From the latest ${groupThousands(model.sample.rows.length)} payments.`,
        )
      : null,
  );
}

function facilitatorsCard(context: PageContext, model: AccountPageModel): Node {
  const by = new Map<string | null, number>();
  for (const row of listed(model))
    by.set(row.attribution.facilitatorId, (by.get(row.attribution.facilitatorId) ?? 0) + 1);
  const entries = [...by.entries()].sort((a, b) => b[1] - a[1]);
  return facilitatorsList(
    context,
    entries,
    entries.reduce((sum, [, n]) => sum + n, 0),
  );
}

/** The facilitators card: a share bar, then each facilitator's pill, count and share. */
function facilitatorsList(
  context: PageContext,
  entries: readonly (readonly [string | null, number])[],
  total: number,
): Node {
  return card(
    { title: "Facilitators", icon: "facilitators" },
    entries.length === 0
      ? empty("None yet")
      : [
          shareBar(
            entries.map(([id, n]) => ({ value: n, tone: facTone(id) })),
            "sbar tall",
          ),
          h(
            "dl",
            { class: "kv2" },
            entries.flatMap(([id, n]) => [
              h("dt", null, facBadge(context, id, false)),
              h(
                "dd",
                null,
                h("b", null, groupThousands(n)),
                " ",
                h("span", { class: "muted" }, `${String(Math.round((n / total) * 100))}%`),
              ),
            ]),
          ),
        ],
  );
}

function activityCard(context: PageContext, model: AccountPageModel): Node {
  const prefix = context.layout.view.prefix;
  const rows = model.sample.rows;
  const newest = rows[0];
  const first = model.sample.first;
  const days = distinct(rows.map((row) => row.closedAt.slice(0, 10)));
  const usdc = usdcContract(context.report);
  // Other assets than USDC: verified ones by name, any other token by its contract, never summed.
  const others = model.totals.items.filter((total) => total.assetContract !== usdc);
  return card(
    { title: "Activity", icon: "clock" },
    kv([
      [
        "First seen",
        first === undefined ? "—" : `${monthDay(dayKey(first.closedAt))} ${first.closedAt.slice(0, 4)}`,
      ],
      ["Last payment", newest === undefined ? "—" : ago(newest.closedAt, context.now)],
      ["Active days", rows.length === 0 ? "—" : `${groupThousands(days)}${model.sample.capped ? "+" : ""}`],
      [
        "Ledgers",
        newest === undefined
          ? "—"
          : `${groupThousands(first?.ledger ?? rows.at(-1)?.ledger ?? newest.ledger)} – ${groupThousands(newest.ledger)}`,
      ],
      ...model.memberships.map((entry): readonly [string, ...Child[]] => [
        "Registered",
        facPill(
          `${facShort(context, entry.facilitatorId)} ${ROLE_NAMES[entry.role] ?? displayText(entry.role, 20)}`,
          entry.facilitatorId,
          `${prefix}/facilitator/${entry.facilitatorId}`,
        ),
        " ",
        h(
          "span",
          { class: "muted" },
          `from ledger ${groupThousands(entry.validFromLedger)}${entry.validToLedger === null ? "" : ` to ${groupThousands(entry.validToLedger)}`}`,
        ),
      ]),
      ...others.map((total): readonly [string, ...Child[]] => [
        total.role === "payer" ? "Also paid" : "Also received",
        total.assetVerified && total.assetCode !== null
          ? `${units(BigInt(total.volume), 4)} ${assetName(context.layout.view.network, total.assetContract, total.assetCode, total.assetIssuer)}`
          : `${total.volume} units of ${shortKey(displayText(total.assetContract, 56))}`,
        " ",
        h("span", { class: "muted" }, `· ${plural(total.payments, "payment")}`),
      ]),
    ]),
    model.muxedId === undefined
      ? null
      : h("p", { class: "muted a-sub" }, "Totals cover every muxed id of the base account."),
  );
}

function holdingsCard(answer: Answer<Holdings> | undefined): Node | null {
  if (answer === undefined || answer.status === "none") return null;
  const items = answer.status === "ok" ? answer.value.items.slice(0, 6) : [];
  return card(
    {
      title: "Holdings",
      icon: "coin",
      end: bdg("live", "info", "Current balances from Lumeus; never counted in a total."),
    },
    answer.status === "down"
      ? empty("Not read just now")
      : items.length === 0
        ? empty("No balances")
        : kv(
            items.map((item) => [
              displayText(item.code, 12),
              h("span", { class: "mono" }, displayText(item.balance, 40)),
            ]),
          ),
  );
}

function servicesCard(context: PageContext, model: AccountPageModel, listings: readonly Listing[]): Node {
  const prefix = context.layout.view.prefix;
  const usage = model.usage?.status === "ok" ? model.usage.value : undefined;
  const payments = new Map(usage?.listings.map((entry) => [entry.listing.id, entry.payments]) ?? []);
  const sorted = [...listings].sort((a, b) => (payments.get(b.id) ?? 0) - (payments.get(a.id) ?? 0));
  return card(
    {
      title: "Services in the Bazaar",
      icon: "bazaar",
      link: { href: `${prefix}/services`, label: `All ${groupThousands(listings.length)} →` },
    },
    h(
      "div",
      { class: "g4 a-g4" },
      sorted.slice(0, 4).map((listing) => {
        const paid = payments.get(listing.id);
        return miniCard(
          `${prefix}/resource/${listing.id}`,
          "bazaar",
          listingName(listing),
          `${listingPrice(context, listing)}${paid === undefined ? "" : ` · ${groupThousands(paid)} paid`}`,
        );
      }),
    ),
  );
}

export function accountPage(context: PageContext, model: AccountPageModel): string {
  const view = context.layout.view;
  const address = displayText(model.address, 56);
  const parts = viewOf(model);
  const listings = model.listings?.status === "ok" ? model.listings.value : [];
  const newest = model.sample.rows[0];
  const first = model.sample.first;
  const recent = newest !== undefined && context.now - Date.parse(newest.closedAt) < 86_400_000;
  const badges: Child[] = [
    parts.seller ? bdg("seller") : null,
    parts.buyer ? bdg("buyer") : null,
    ...model.memberships.map((entry) =>
      facPill(
        `${facShort(context, entry.facilitatorId)} ${ROLE_NAMES[entry.role] ?? displayText(entry.role, 20)}`,
        entry.facilitatorId,
        `${view.prefix}/facilitator/${entry.facilitatorId}`,
      ),
    ),
    bdg(address.startsWith("C") ? "contract account" : "G account", "mut"),
    model.muxedId === undefined ? null : bdg(`muxed id ${displayText(model.muxedId, 24)}`, "info"),
    listings.length > 0
      ? h("a", { class: "bdg info", href: `${view.prefix}/seller/${address}` }, serviceName(listings))
      : null,
    first === undefined ? null : bdg(`first seen ${monthDay(dayKey(first.closedAt))}`, "mut"),
    newest === undefined ? null : bdg(`active ${ago(newest.closedAt, context.now)}`, recent ? "ok" : "mut"),
  ];
  const sideCards = [
    counterpartiesCard(context, model, parts),
    facilitatorsCard(context, model),
    activityCard(context, model),
    holdingsCard(model.holdings),
  ];
  return page(
    {
      ...context.layout,
      title: `Account ${shortKey(address)}`,
      path: `/account/${address}`,
      section: "account",
      description: `x402 payments of ${address} on Stellar ${view.label.toLowerCase()}.`,
    },
    pageHead({
      crumbs: [
        ["Search", `${view.prefix}/search`],
        ["Account", undefined],
      ],
      title: address,
      mono: true,
      badges,
      actions: [
        copyAction(address, "Copy address"),
        actionLink(stellarExpertAccount(view, address), "stellar.expert", "external", true, true),
      ],
    }),
    model.listings?.status === "down"
      ? h("p", { class: "notice", role: "status" }, "The Bazaar did not answer: services are not shown.")
      : null,
    tiles(context, model, parts),
    h("div", { class: "g21" }, paymentsCard(context, model, parts), h("div", { class: "a-side" }, sideCards)),
    listings.length > 0 ? servicesCard(context, model, listings) : null,
    moreNotice(model.totals),
  );
}

/** Says how many assets each side of the totals left out, when they were cut. */
function moreNotice(totals: AccountTotals): Child {
  const parts = [
    totals.more.payer > 0 ? `${groupThousands(totals.more.payer)} more paid` : "",
    totals.more.payTo > 0 ? `${groupThousands(totals.more.payTo)} more received` : "",
  ].filter((part) => part !== "");
  if (parts.length === 0) return null;
  return h(
    "p",
    { class: "notice", role: "status" },
    `${parts.join(" and ")} ${totals.more.payer + totals.more.payTo === 1 ? "asset is" : "assets are"} not shown.`,
  );
}
