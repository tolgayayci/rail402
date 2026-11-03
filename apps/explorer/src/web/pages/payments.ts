import type { SettlementRow } from "@rail402.dev/x402-index";
import type { PaymentFilter } from "../../api/queries.ts";
import type { Answer, PaidFor } from "../bazaar.ts";
import {
  body,
  facilitatorName,
  h,
  icon,
  layout,
  pageHead,
  panel,
  paidForRow,
  listingTitle,
  paymentTable,
} from "../components.ts";
import { assetName, decimalAmount, groupThousands } from "../format.ts";
import { displayText } from "../text.ts";
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
}

export function queryString(query: PaymentQuery, extra: Readonly<Record<string, string>> = {}): string {
  const params = new URLSearchParams();
  if (query.facilitator !== undefined) params.set("facilitator", query.facilitator);
  if (query.scheme !== undefined) params.set("scheme", query.scheme);
  if (query.asset !== undefined) params.set("asset", query.asset);
  if (query.time !== undefined) params.set("time", query.time);
  for (const [name, value] of Object.entries(extra)) params.set(name, value);
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

export interface PaymentsModel {
  readonly query: PaymentQuery;
  readonly filter: PaymentFilter;
  readonly items: readonly SettlementRow[];
  readonly nextCursor: string | null;
  readonly first: boolean;
  readonly limit: number;
  readonly paid: Answer<ReadonlyMap<string, PaidFor>>;
}

/** How many payments the report counts under these filters, when the report can say. */
function counted(context: PageContext, query: PaymentQuery): number | undefined {
  const agg = context.report?.aggregates;
  if (agg === undefined || query.asset !== undefined || query.time !== undefined) return undefined;
  if (query.facilitator === "shaped")
    return query.scheme === undefined ? agg.unattributedShaped.payments : undefined;
  if (query.facilitator !== undefined)
    return query.scheme === undefined ? (agg.byFacilitator[query.facilitator]?.payments ?? 0) : undefined;
  return query.scheme === undefined ? agg.headline.payments : (agg.byScheme[query.scheme]?.payments ?? 0);
}

export function paymentsPage(context: PageContext, model: PaymentsModel): string {
  const view = context.layout.view;
  const base = `${view.prefix}/payments`;
  const query = model.query;
  const total = counted(context, query);
  const facilitators = context.registry.document.facilitators;
  const selected =
    query.facilitator === undefined ? undefined : context.registry.facilitator(query.facilitator);
  const tab = (id: string | undefined, label: string) =>
    h(
      "a",
      {
        href: `${base}${queryString({ ...query, facilitator: id })}`,
        "aria-current": query.facilitator === id ? "true" : undefined,
      },
      label,
    );
  const assets = Object.entries(context.report?.assets ?? {}).filter(
    ([, asset]) => asset.verified && asset.code !== null,
  );
  const select = (
    name: string,
    label: string,
    value: string | undefined,
    options: readonly [string, string][],
  ) =>
    h(
      "label",
      { class: "field" },
      label,
      h(
        "select",
        { name },
        options.map(([optionValue, optionLabel]) =>
          h("option", { value: optionValue, selected: (value ?? "") === optionValue }, optionLabel),
        ),
      ),
    );
  const scope =
    query.facilitator === "shaped"
      ? "with the x402 shape but no registered facilitator, a lower bound"
      : selected === undefined
        ? "settled by registered facilitators"
        : `settled by ${displayText(selected.name, 100)}`;
  const shaped = context.report?.aggregates.unattributedShaped.payments ?? 0;
  const paid = model.paid.status === "ok" ? model.paid.value : undefined;
  const cataloged =
    paid === undefined ? 0 : model.items.filter((row) => paidForRow(paid, row) !== undefined).length;
  return layout(
    {
      ...context.layout,
      section: "payments",
      title: `Payments (${view.label})`,
      path: `/payments${queryString(query)}`,
      description:
        "x402 payments on Stellar settled by registered facilitators, newest first, by facilitator, scheme, asset and time.",
    },
    body(
      pageHead(
        {
          eyebrow:
            selected === undefined
              ? query.facilitator === "shaped"
                ? "Unattributed payments"
                : "All payments"
              : "Payments",
          split: true,
          end: h(
            "div",
            { class: "actions" },
            h(
              "a",
              {
                class: "btn accent",
                href: `${view.prefix}/payments.csv${queryString(query)}`,
                download: true,
              },
              "Download CSV",
            ),
            h("a", { class: "btn", href: `/api/v1/${view.slug}/settlements${queryString(query)}` }, "API"),
          ),
        },
        h("h1", null, total === undefined ? "x402 payments" : `${groupThousands(total)} x402 payments`),
        h("p", { class: "muted" }, `Payments ${scope} on Stellar ${view.label.toLowerCase()}.`),
      ),
      panel(
        { label: "Payments table" },
        h(
          "div",
          { class: "filters" },
          h(
            "nav",
            { class: "seg", "aria-label": "Facilitator" },
            tab(undefined, "All"),
            facilitators
              .filter((entry) => entry.tier !== "rail402-beta")
              .map((entry) => tab(entry.id, facilitatorName(entry))),
            tab("shaped", "Unattributed"),
          ),
          h(
            "form",
            { method: "get", action: base, class: "actions", "data-autosubmit": "true" },
            query.facilitator === undefined
              ? null
              : h("input", { type: "hidden", name: "facilitator", value: query.facilitator }),
            select("scheme", "Scheme", query.scheme, [
              ["", "Any"],
              ["exact", "exact"],
              ["upto", "upto"],
            ]),
            select("asset", "Asset", query.asset, [
              ["", "Any"],
              ...assets.map(([contract, asset]): [string, string] => [
                contract,
                assetName(context.layout.view.network, contract, asset.code ?? "", asset.issuer),
              ]),
            ]),
            select("time", "Time", query.time, [
              ["", "All time"],
              ...Object.entries(TIME_WINDOWS).map(([id, window]): [string, string] => [id, window.label]),
            ]),
            h("button", { type: "submit", class: "btn small" }, "Apply"),
          ),
          h(
            "form",
            { class: "quick", action: `${view.prefix}/search`, method: "get", role: "search" },
            h("label", { for: "q-list", class: "sr" }, "Find an account, hash or endpoint"),
            h("input", {
              id: "q-list",
              name: "q",
              type: "search",
              placeholder: "Find an account, hash or endpoint",
              autocomplete: "off",
              spellcheck: "false",
              maxlength: 300,
            }),
            h("button", { type: "submit", "aria-label": "Search" }, icon("search")),
          ),
        ),
        h(
          "div",
          { class: "strip" },
          `${model.first ? "Latest" : "Older"} ${groupThousands(model.items.length)}${total === undefined ? "" : ` of ${groupThousands(total)}`}. `,
          model.paid.status === "down"
            ? "The Bazaar did not answer, so what each payment paid for is not shown."
            : `“Paid for” shows when Rail402 settled the payment and cataloged its resource (${String(cataloged)} of these, from the Bazaar, off chain).`,
        ),
        paymentTable(view, context.registry, model.items, paid, context.now),
        h(
          "div",
          { class: "pager" },
          h("span", null, `${String(model.limit)} rows a page`),
          h(
            "div",
            { class: "actions" },
            h(
              "a",
              {
                class: "btn small",
                href: `${base}${queryString(query)}`,
                "aria-disabled": model.first ? "true" : undefined,
              },
              "Newest",
            ),
            model.nextCursor === null
              ? h("span", { class: "btn small", "aria-disabled": "true" }, "Older ›")
              : h(
                  "a",
                  {
                    class: "btn small",
                    rel: "next",
                    href: `${base}${queryString(query, { cursor: model.nextCursor })}`,
                  },
                  "Older ›",
                ),
          ),
        ),
      ),
      query.facilitator === undefined && shaped > 0
        ? h(
            "p",
            { class: "soft" },
            `Also on the ledger: ${groupThousands(shaped)} payments with the x402 shape whose fee payer is not a registered facilitator. `,
            h("a", { href: `${base}?facilitator=shaped` }, "Show them separately"),
            ".",
          )
        : null,
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
