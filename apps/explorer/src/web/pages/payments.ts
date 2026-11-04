import type { RegistrySnapshot, SettlementRow } from "@rail402.dev/x402-index";
import { COUNT_CAP } from "../../api/queries-b.ts";
import type { PaidFor } from "../bazaar.ts";
import { h, listingTitle, paidForRow, rowAsset, type Node } from "../components.ts";
import { ago, decimalAmount, groupThousands, shortKey } from "../format.ts";
import { displayText } from "../text.ts";
import {
  actionLink,
  bdg,
  card,
  empty,
  facPill,
  page,
  pageHead,
  pager,
  payRow,
  schemePill,
  seg,
  svgIcon,
} from "../ui.ts";
import type { PageContext } from "./context.ts";

/** A time window of the payments list. */
export type TimeWindow = "24h" | "7d" | "30d";
export const TIME_WINDOWS: Readonly<Record<TimeWindow, { readonly label: string; readonly ms: number }>> = {
  "24h": { label: "24 hours", ms: 86_400_000 },
  "7d": { label: "7 days", ms: 7 * 86_400_000 },
  "30d": { label: "30 days", ms: 30 * 86_400_000 },
};

/** The payments list's filters as the page and the API take them (GET parameters). */
export interface PaymentQuery {
  /** A registry facilitator id, or `shaped` for unattributed x402-shaped payments. */
  readonly facilitator?: string;
  readonly scheme?: "exact" | "upto";
  readonly asset?: string;
  readonly time?: TimeWindow;
  /** A G…, C… or M… address that paid or was paid (the page and the CSV only). */
  readonly account?: string;
}

/** Rows a page of the list shows. */
export const PER_PAGE = 10;

export function queryString(query: PaymentQuery, extra: Readonly<Record<string, string>> = {}): string {
  const params = new URLSearchParams();
  if (query.facilitator !== undefined) params.set("facilitator", query.facilitator);
  if (query.scheme !== undefined) params.set("scheme", query.scheme);
  if (query.asset !== undefined) params.set("asset", query.asset);
  if (query.time !== undefined) params.set("time", query.time);
  if (query.account !== undefined) params.set("account", query.account);
  for (const [name, value] of Object.entries(extra)) params.set(name, value);
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

// --- shared by the payment pages -----------------------------------------------------------------

/** A hash as its first eight and last four characters, as the payment rows show it. */
export const rowHash = (hash: string) => (hash.length <= 14 ? hash : `${hash.slice(0, 8)}…${hash.slice(-4)}`);

/** A facilitator's short name: "Rail402", "x402.org", "Built on Stellar", "AlgoVoi". */
export function facilitatorShort(entry: { readonly id: string; readonly name: string }): string {
  if (entry.id === "rail402") return "Rail402";
  const full = displayText(entry.name, 100);
  const name = full.replace(/\s*\([^)]*\)\s*$/, "").replace(/\s+(facilitator|hosted service)$/i, "");
  return name === "" ? full : name;
}

/** The facilitator pill of a row: its registry facilitator (linked when `link`), or "not registered". */
export function rowFacilitator(
  prefix: string,
  registry: RegistrySnapshot,
  row: Pick<SettlementRow, "attribution">,
  link = true,
): Node {
  const id = row.attribution.facilitatorId;
  const entry = id === null ? undefined : registry.facilitator(id);
  if (entry === undefined) return facPill("not registered", null);
  return facPill(facilitatorShort(entry), entry.id, link ? `${prefix}/facilitator/${entry.id}` : undefined);
}

/** A row's amount as short text: "0.001 USDC", or atomic units of an unverified token. */
export const rowAmount = (row: Pick<SettlementRow, "asset" | "amount" | "network">, atomic = row.amount) =>
  row.asset.verified && row.asset.code !== null
    ? `${decimalAmount(atomic)} ${rowAsset(row)}`
    : `${atomic} units`;

/** One payment as a list row: hash, when, buyer → seller, amount, scheme and facilitator. */
export function paymentRow(context: PageContext, row: SettlementRow, sub?: string): Node {
  const p = context.layout.view.prefix;
  return payRow({
    href: `${p}/tx/${row.txHash}`,
    hash: rowHash(row.txHash),
    sub: sub ?? `${ago(row.closedAt, context.now)} · ledger ${groupThousands(row.ledger)}`,
    middle: { title: `${shortKey(row.payer)} → ${shortKey(row.payTo)}`, sub: "buyer → seller" },
    amount: rowAmount(row),
    badges: [schemePill(row.scheme), rowFacilitator(p, context.registry, row, false)],
  });
}

// --- the list ------------------------------------------------------------------------------------

export interface PaymentsModel {
  readonly query: PaymentQuery;
  readonly items: readonly SettlementRow[];
  /** The page shown, from 1. */
  readonly page: number;
  /** Payments the filters list, counted up to `COUNT_CAP` + 1; undefined when not counted. */
  readonly total: number | undefined;
}

export function paymentsPage(context: PageContext, model: PaymentsModel): string {
  const view = context.layout.view;
  const base = `${view.prefix}/payments`;
  const query = model.query;
  const link = (change: Partial<Record<keyof PaymentQuery, string | undefined>>, pageNumber?: number) =>
    `${base}${queryString({ ...query, ...change } as PaymentQuery, pageNumber === undefined || pageNumber === 1 ? {} : { page: String(pageNumber) })}`;
  const facilitators = context.registry.document.facilitators.filter(
    (entry) => entry.tier !== "rail402-beta",
  );
  const capped = model.total !== undefined && model.total > COUNT_CAP;
  const total = model.total === undefined ? undefined : Math.min(model.total, COUNT_CAP);
  const pages = total === undefined ? 1 : Math.max(1, Math.ceil(total / PER_PAGE));
  const apart = query.facilitator === "shaped";
  const hidden = (name: keyof PaymentQuery) =>
    query[name] === undefined ? null : h("input", { type: "hidden", name, value: query[name] });
  return page(
    {
      ...context.layout,
      section: "payments",
      title: `Payments (${view.label})`,
      path: `/payments${queryString(query)}`,
      description: "x402 payments on Stellar, newest first, by facilitator, scheme, time and account.",
    },
    pageHead({
      title: "Payments",
      badges: [
        total === undefined
          ? null
          : bdg(`${groupThousands(total)}${capped ? "+" : ""} payment${total === 1 ? "" : "s"}`),
        apart ? bdg("not registered · never in totals", "warn") : null,
        query.account === undefined
          ? null
          : h(
              "a",
              {
                class: "bdg info oa-b-clear",
                href: link({ account: undefined }),
                title: "Show every account",
              },
              shortKey(displayText(query.account, 69)),
              svgIcon("cross"),
            ),
      ],
      actions: [actionLink(`${view.prefix}/payments.csv${queryString(query)}`, "Download", "download")],
    }),
    h(
      "div",
      { class: "fbar", role: "group", "aria-label": "Filters" },
      seg("Facilitator", [
        {
          label: "All registered",
          href: link({ facilitator: undefined }),
          on: query.facilitator === undefined,
        },
        ...facilitators.map((entry) => ({
          label: facilitatorShort(entry),
          href: link({ facilitator: entry.id }),
          on: query.facilitator === entry.id,
        })),
        { label: "Not registered", href: link({ facilitator: "shaped" }), on: apart },
      ]),
      seg("Scheme", [
        { label: "Any", href: link({ scheme: undefined }), on: query.scheme === undefined },
        { label: "exact", href: link({ scheme: "exact" }), on: query.scheme === "exact" },
        { label: "upto", href: link({ scheme: "upto" }), on: query.scheme === "upto" },
      ]),
      seg("Time", [
        ...(Object.keys(TIME_WINDOWS) as TimeWindow[]).map((id) => ({
          label: id,
          href: link({ time: id }),
          on: query.time === id,
        })),
        { label: "All", href: link({ time: undefined }), on: query.time === undefined },
      ]),
      h(
        "form",
        { class: "tin", method: "get", action: base, role: "search" },
        svgIcon("search"),
        hidden("facilitator"),
        hidden("scheme"),
        hidden("asset"),
        hidden("time"),
        h("input", {
          type: "search",
          name: "account",
          value: query.account,
          placeholder: "G… or C… account",
          "aria-label": "Filter by account",
          autocomplete: "off",
          spellcheck: "false",
          maxlength: 69,
        }),
      ),
    ),
    card(
      { title: "Newest first", icon: "list", cls: "oa-b-list" },
      model.items.length === 0
        ? empty(
            "No payments",
            model.page > 1 ? "This page is past the last payment." : "No payment matches these filters.",
          )
        : h(
            "div",
            { class: "feed2" },
            model.items.map((row) => paymentRow(context, row)),
          ),
      total === undefined
        ? null
        : pager({
            page: Math.min(model.page, pages),
            pages,
            total,
            perPage: PER_PAGE,
            href: (n) => link({}, n),
          }),
    ),
  );
}

/** A CSV field: quoted when needed, and never read as a formula by a spreadsheet. */
function csvField(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export const CSV_COLUMNS = [
  "transaction",
  "inner_transaction",
  "ledger",
  "closed_at",
  "scheme",
  "asset_contract",
  "asset_code",
  "asset_verified",
  "amount_atomic",
  "amount",
  "max_amount_atomic",
  "payer",
  "pay_to",
  "pay_to_muxed_id",
  "tier",
  "facilitator",
  "fee_payer",
  "fee_charged_stroops",
  "paid_for_listing",
  "paid_for",
] as const;

/** The payments as CSV, one row each; `paid_for` is the Bazaar's listing (off chain) when known. */
export function paymentsCsv(
  rows: readonly SettlementRow[],
  paid: ReadonlyMap<string, PaidFor> | undefined,
): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of rows) {
    const found = paidForRow(paid, row);
    const values: string[] = [
      row.txHash,
      row.innerHash ?? "",
      String(row.ledger),
      row.closedAt,
      row.scheme,
      row.asset.contract,
      row.asset.verified ? (row.asset.code ?? "") : "",
      String(row.asset.verified),
      row.amount,
      row.asset.verified ? decimalAmount(row.amount).replaceAll(",", "") : "",
      row.maxAmount ?? "",
      row.payer,
      row.payTo,
      row.payToMuxedId ?? "",
      row.attribution.tier,
      row.attribution.facilitatorId ?? "",
      row.fee.payer,
      row.fee.chargedStroops,
      found?.listing.id ?? "",
      found === undefined ? "" : listingTitle(found.listing),
    ];
    lines.push(values.map((value) => csvField(displayText(value, 400))).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}
