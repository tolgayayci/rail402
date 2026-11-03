import type { SettlementRow } from "@rail402.dev/x402-index";
import type { AccountRole, AccountTotals, SellerSummary } from "../../api/queries.ts";
import type { Answer, Listing, PaidFor, SellerUsage } from "../bazaar.ts";
import type { Holdings } from "../holdings.ts";
import {
  aside,
  badge,
  bazaarDown,
  body,
  copyButton,
  externalLink,
  facilitatorName,
  h,
  layout,
  listingTitle,
  monogram,
  note,
  pageHead,
  panel,
  paymentTable,
  rowAsset,
  rows,
  row,
  schemeBadge,
  shareBar,
  table,
  tierBadge,
  txLink,
  type Child,
} from "../components.ts";
import {
  assetName,
  day,
  decimalAmount,
  groupThousands,
  percent,
  stellarExpertAccount,
  utc,
} from "../format.ts";
import { displayText } from "../text.ts";
import { listingPrice, verifiedAsset, type PageContext } from "./context.ts";
import { serviceName } from "./services.ts";

export interface AccountPageModel {
  readonly address: string;
  readonly muxedId: string | undefined;
  readonly role: AccountRole;
  readonly totals: AccountTotals;
  readonly items: readonly SettlementRow[];
  readonly nextCursor: string | null;
  readonly epoch: string;
  readonly paid: Answer<ReadonlyMap<string, PaidFor>> | undefined;
  /** The account's listings in the Bazaar, as a seller (payTo). */
  readonly listings: Answer<readonly Listing[]> | undefined;
  /** Payments the Bazaar linked to each listing. */
  readonly usage: Answer<SellerUsage> | undefined;
  /** Received payments by scheme and distinct payers, from the index; undefined when it did not answer. */
  readonly summary: SellerSummary | undefined;
  readonly upto: readonly SettlementRow[];
  /** Live holdings (Lumeus Assets): context only, never counted. */
  readonly holdings: Answer<Holdings> | undefined;
}

const ROLE_LABELS: Readonly<Record<AccountRole, string>> = {
  any: "All",
  payer: "As payer",
  payTo: "As seller",
};

/** The live holdings card: dashed, labelled live and not audited. */
export function holdingsPanel(
  answer: Answer<Holdings> | undefined,
  options: { readonly xlmOnly?: boolean } = {},
): Child {
  if (answer === undefined) return null;
  const items =
    answer.status === "ok"
      ? answer.value.items.filter((item) => options.xlmOnly !== true || item.kind === "native")
      : [];
  return panel(
    { title: "Holdings", id: "holdings", cls: "live", aside: badge("Live · not audited", "live") },
    rows(
      undefined,
      answer.status === "down"
        ? row("Holdings", h("span", { class: "muted" }, "The live balance source did not answer."))
        : items.length === 0
          ? row("Holdings", h("span", { class: "muted" }, "No balances."))
          : items.map((item) =>
              row(
                displayText(item.code, 12),
                h("span", { class: "mono" }, item.balance),
                item.issuer === null
                  ? null
                  : h(
                      "span",
                      { class: "small muted mono", title: item.issuer },
                      `${item.issuer.slice(0, 4)}…${item.issuer.slice(-4)}`,
                    ),
              ),
            ),
      row(
        "Source",
        h(
          "span",
          { class: "soft" },
          "Current ledger state from Lumeus, refreshed every few minutes",
          answer.status === "ok" && answer.value.asOfLedger !== null
            ? ` (ledger ${groupThousands(answer.value.asOfLedger)})`
            : "",
          ". Never used in a count.",
        ),
      ),
    ),
  );
}

/** What the account received, from the index: by scheme, distinct payers, per verified asset. */
function receivedPanel(context: PageContext, model: AccountPageModel): Child {
  const received = model.totals.items.filter((total) => total.role === "payTo");
  const payments = received.reduce((sum, total) => sum + total.payments, 0);
  if (payments === 0) return null;
  const first = received.map((total) => total.firstAt).sort()[0];
  const last = received
    .map((total) => total.lastAt)
    .sort()
    .at(-1);
  return panel(
    { title: "Payments received", id: "received" },
    rows(
      undefined,
      row(
        "Payments",
        groupThousands(payments),
        model.summary === undefined
          ? null
          : h(
              "span",
              { class: "muted" },
              `exact ${groupThousands(model.summary.exact)}, upto ${groupThousands(model.summary.upto)}`,
            ),
      ),
      row("Payers", model.summary === undefined ? "—" : `${groupThousands(model.summary.payers)} distinct`),
      received.map((total) =>
        row(
          "Received",
          total.assetVerified
            ? `${decimalAmount(total.volume)} ${assetName(context.layout.view.network, total.assetContract, total.assetCode ?? "", total.assetIssuer)}`
            : `${total.volume} units of a custom token`,
        ),
      ),
      first === undefined ? null : row("First", day(first)),
      last === undefined ? null : row("Last", day(last)),
    ),
    note(`From the ledger index, epoch ${model.epoch}, every tier.`),
  );
}

/** The seller's listings with the payments linked to each, and the remainder linked to none. */
function listingsPanel(context: PageContext, model: AccountPageModel, listings: readonly Listing[]): Child {
  const view = context.layout.view;
  const usage = model.usage?.status === "ok" ? model.usage.value : undefined;
  const byListing = new Map(usage?.listings.map((entry) => [entry.listing.id, entry]) ?? []);
  const received = model.totals.items
    .filter((total) => total.role === "payTo")
    .reduce((sum, total) => sum + total.payments, 0);
  const linked = usage?.totals.payments;
  const remainder = linked === undefined ? undefined : Math.max(0, received - linked);
  const dash = h(
    "span",
    { class: "muted", title: "The Bazaar does not publish usage for this listing yet." },
    "—",
  );
  return h(
    "section",
    { class: "panel", id: "listings", "aria-label": "Listings" },
    table(
      "wide",
      [
        { label: "Resource" },
        { label: "Type" },
        { label: "Scheme" },
        { label: "Price", num: true },
        { label: "Payments", num: true },
        { label: "Payers", num: true },
        { label: "Updated", num: true },
      ],
      [
        ...listings.map((listing) => {
          const entry = byListing.get(listing.id);
          return h(
            "tr",
            null,
            h(
              "td",
              null,
              h(
                "div",
                { class: "cell" },
                h(
                  "a",
                  { href: `${view.prefix}/resource/${listing.id}`, class: "mono" },
                  listing.type === "mcp"
                    ? displayText(listing.toolName ?? listing.resource, 128)
                    : listingTitle(listing).replace(/^(\S+) [^/]+/, "$1 "),
                ),
                listing.description === undefined
                  ? null
                  : h("span", { class: "small muted" }, displayText(listing.description, 160)),
              ),
            ),
            h("td", null, badge(listing.type)),
            h("td", null, schemeBadge(listing.scheme)),
            h("td", { class: "num" }, listingPrice(context, listing)),
            h("td", { class: "num" }, entry === undefined ? dash : groupThousands(entry.payments)),
            h("td", { class: "num" }, entry === undefined ? dash : groupThousands(entry.payers)),
            h("td", { class: "num muted" }, day(listing.lastUpdated, false)),
          );
        }),
        h(
          "tr",
          { class: "remainder" },
          h(
            "td",
            null,
            h(
              "div",
              { class: "cell" },
              h("span", { class: "strong" }, "Not linked to a public listing"),
              h(
                "span",
                { class: "small soft" },
                "Paid on chain, but not linked by the Bazaar to a listing shown here: uncataloged, private, withdrawn or beyond the listings shown",
              ),
            ),
          ),
          h("td", null),
          h("td", null),
          h("td", null),
          h("td", { class: "num" }, remainder === undefined ? dash : groupThousands(remainder)),
          h(
            "td",
            { class: "num" },
            h("span", { class: "muted", title: "Distinct payers cannot be subtracted." }, "—"),
          ),
          h("td", null),
        ),
      ],
    ),
    note(
      "Listings and the payments linked to each come from the Bazaar (off chain); a listing whose seller keeps usage private shows none. ",
      usage?.truncated === true
        ? "The Bazaar lists usage for the 100 most recently paid listings; its total covers all. "
        : "",
      model.usage?.status === "down"
        ? "The Bazaar did not answer, so no payment is linked here; try again shortly."
        : linked === undefined
          ? "The Bazaar does not publish per-listing usage yet, so no payment is linked here."
          : `The remainder is the ledger's ${groupThousands(received)} received payments minus the ${groupThousands(linked)} the Bazaar linked to a public listing, at zero at least. The ledger count covers the current epoch (epoch ${model.epoch}); the Bazaar's covers all its history.`,
    ),
  );
}

/** Upto payments received: what the seller charged against what the payer authorized. */
function uptoPanel(context: PageContext, model: AccountPageModel): Child {
  if (model.upto.length === 0) return null;
  const view = context.layout.view;
  return panel(
    {
      title: "Latest upto payments · charged vs authorized",
      id: "upto",
      aside: aside(
        model.summary === undefined ? "" : `${groupThousands(model.summary.upto)} upto payments in all`,
      ),
    },
    table(
      "mid",
      [
        { label: "Payment" },
        { label: "Time" },
        { label: "Charged", num: true },
        { label: "Authorized up to", num: true },
        { label: "Used" },
      ],
      model.upto.map((settlement) => {
        const cap = settlement.maxAmount === null ? undefined : BigInt(settlement.maxAmount);
        const used =
          cap === undefined || cap === 0n ? undefined : Number(BigInt(settlement.amount)) / Number(cap);
        const code = settlement.asset.verified ? ` ${rowAsset(settlement)}` : " units";
        return h(
          "tr",
          null,
          h("td", null, txLink(view, settlement.txHash)),
          h("td", { class: "muted nowrap" }, utc(settlement.closedAt)),
          h(
            "td",
            { class: "num" },
            `${settlement.asset.verified ? decimalAmount(settlement.amount) : settlement.amount}${code}`,
          ),
          h(
            "td",
            { class: "num muted" },
            settlement.maxAmount === null
              ? "—"
              : `${settlement.asset.verified ? decimalAmount(settlement.maxAmount) : settlement.maxAmount}${code}`,
          ),
          h(
            "td",
            null,
            used === undefined
              ? h("span", { class: "muted" }, "—")
              : h(
                  "div",
                  { class: "barline" },
                  shareBar(used, "upto"),
                  h(
                    "span",
                    { class: "pct" },
                    percent(Number(settlement.amount), Number(settlement.maxAmount)),
                  ),
                ),
          ),
        );
      }),
    ),
    note("Charged and authorized amounts are read from the indexed settlements."),
  );
}

/** The registry entries of an account that belongs to a facilitator. */
function registryPanel(context: PageContext, address: string): Child {
  const view = context.layout.view;
  const memberships = context.registry.document.facilitators.flatMap((facilitator) =>
    facilitator.accounts
      .filter((account) => account.address === address)
      .map((account) => ({ facilitator, account })),
  );
  if (memberships.length === 0) return null;
  return panel(
    { title: "Facilitator registry", id: "registry" },
    rows(
      undefined,
      memberships.map(({ facilitator, account }) =>
        row(
          displayText(account.role, 32),
          h("a", { href: `${view.prefix}/facilitator/${facilitator.id}` }, facilitatorName(facilitator)),
          tierBadge(facilitator.tier),
          h(
            "span",
            { class: "small muted" },
            `ledgers ${groupThousands(account.validFromLedger)}–${account.validToLedger === null ? "now" : groupThousands(account.validToLedger)} (epoch ${account.epoch})`,
          ),
          externalLink(account.evidence[0]?.url, "evidence"),
        ),
      ),
    ),
  );
}

/** The account's totals per asset, both sides, from the indexer's totals. */
function totalsPanel(context: PageContext, model: AccountPageModel): Child {
  const view = context.layout.view;
  return panel(
    { title: "Totals per asset", id: "totals" },
    model.muxedId === undefined ? null : note("These totals cover all muxed ids of the base account."),
    model.totals.items.length === 0
      ? h("p", { class: "empty" }, `No x402 settlements for this account in epoch ${model.epoch}.`)
      : table(
          "mid",
          [
            { label: "Side" },
            { label: "Asset" },
            { label: "Payments", num: true },
            { label: "Volume", num: true },
            { label: "First" },
            { label: "Last" },
          ],
          model.totals.items.map((total) =>
            h(
              "tr",
              null,
              h("td", null, total.role === "payer" ? "Paid" : "Received"),
              h(
                "td",
                null,
                total.assetVerified && total.assetCode !== null
                  ? [
                      assetName(view.network, total.assetContract, total.assetCode, total.assetIssuer),
                      " ",
                      badge("verified", "ok"),
                    ]
                  : [
                      badge("custom token", "custom"),
                      " ",
                      h("span", { class: "mono" }, displayText(total.assetContract, 56)),
                    ],
              ),
              h("td", { class: "num" }, groupThousands(total.payments)),
              h(
                "td",
                { class: "num" },
                total.assetVerified ? decimalAmount(total.volume) : `${total.volume} atomic`,
              ),
              h("td", { class: "nowrap" }, utc(total.firstAt)),
              h("td", { class: "nowrap" }, utc(total.lastAt)),
            ),
          ),
        ),
    moreNotice(model.totals),
    note(
      "Totals include every tier, including unattributed x402-shaped matches; amounts of different assets are never summed.",
    ),
  );
}

export function accountPage(context: PageContext, model: AccountPageModel): string {
  const view = context.layout.view;
  const address = displayText(model.address, 56);
  const listings = model.listings?.status === "ok" ? model.listings.value : [];
  const seller = listings.length > 0;
  const name = seller ? serviceName(listings) : address.startsWith("C") ? "Contract account" : "Account";
  const base = `${view.prefix}/account/${address}`;
  const query = (role: AccountRole, cursor?: string) => {
    const params = new URLSearchParams();
    if (role !== "any") params.set("role", role);
    if (model.muxedId !== undefined) params.set("muxed", model.muxedId);
    if (cursor !== undefined) params.set("cursor", cursor);
    const text = params.toString();
    return `${text === "" ? base : `${base}?${text}`}#payments`;
  };
  const http = listings.filter((listing) => listing.type === "http").length;
  const mcp = listings.length - http;
  const schemes = [...new Set(listings.map((listing) => listing.scheme))].sort();
  const assets = [
    ...new Set(listings.map((listing) => verifiedAsset(context, listing.asset) ?? "a custom token")),
  ];
  const updated = listings.map((listing) => listing.lastUpdated).sort();
  const paid = model.paid?.status === "ok" ? model.paid.value : undefined;
  const receivedCount = model.totals.items
    .filter((total) => total.role === "payTo")
    .reduce((sum, total) => sum + total.payments, 0);
  return layout(
    {
      ...context.layout,
      section: seller ? "services" : undefined,
      title: seller ? `${name} (seller)` : `Account ${address.slice(0, 8)}…`,
      path: `/account/${address}`,
    },
    body(
      pageHead(
        {
          eyebrow: seller
            ? `${view.label} · seller`
            : `${view.label} · ${address.startsWith("C") ? "contract account" : "account"}`,
          avatar: h(
            "span",
            { class: seller ? "avatar accent" : "avatar", "aria-hidden": "true" },
            seller ? monogram(name) : address.slice(0, 2),
          ),
        },
        [
          h("h1", null, name),
          seller
            ? badge(
                `${String(listings.length)} listing${listings.length === 1 ? "" : "s"} in the Bazaar`,
                "accent",
              )
            : null,
        ],
        h(
          "div",
          { class: "line" },
          h("span", { class: "mono full soft" }, address),
          copyButton(address, "address"),
          externalLink(stellarExpertAccount(view, address), "stellar.expert ↗"),
        ),
        model.muxedId === undefined
          ? null
          : h("p", { class: "muted" }, `Payments to muxed id ${displayText(model.muxedId, 24)} only.`),
      ),
      model.listings?.status === "down" ? bazaarDown() : null,
      h(
        "div",
        { class: "grid-3" },
        seller
          ? panel(
              { title: "Overview", id: "overview" },
              rows(
                undefined,
                row("Service", name),
                row(
                  "Listings",
                  [
                    http > 0 ? `${String(http)} HTTP endpoint${http === 1 ? "" : "s"}` : "",
                    mcp > 0 ? `${String(mcp)} MCP tool${mcp === 1 ? "" : "s"}` : "",
                  ]
                    .filter((part) => part !== "")
                    .join(" · "),
                ),
                row("Schemes", schemes.map((scheme) => displayText(scheme, 16)).join(", ")),
                row(
                  "Asset",
                  assets
                    .map((asset) => (asset === "a custom token" ? asset : `${asset} (verified)`))
                    .join(", "),
                ),
                updated.length === 0
                  ? null
                  : row("Updated", `${day(updated[0] ?? "", false)} – ${day(updated.at(-1) ?? "", false)}`),
              ),
              note("From the Bazaar, off chain."),
            )
          : null,
        receivedPanel(context, model),
        holdingsPanel(model.holdings),
      ),
      registryPanel(context, model.address),
      seller
        ? h(
            "nav",
            { class: "sections", "aria-label": "Seller" },
            h("a", { href: "#listings", "aria-current": "true" }, `Listings (${String(listings.length)})`),
            h("a", { href: "#payments" }, `Payments (${groupThousands(receivedCount)})`),
            model.summary === undefined
              ? null
              : h("a", { href: "#received" }, `Payers (${groupThousands(model.summary.payers)})`),
            model.upto.length === 0 ? null : h("a", { href: "#upto" }, "Upto usage"),
          )
        : null,
      seller ? listingsPanel(context, model, listings) : null,
      uptoPanel(context, model),
      totalsPanel(context, model),
      panel(
        {
          title: "Payments",
          id: "payments",
          aside: h(
            "nav",
            { class: "seg", "aria-label": "Side" },
            (["any", "payer", "payTo"] as const).map((role) =>
              h(
                "a",
                { href: query(role), "aria-current": model.role === role ? "true" : undefined },
                ROLE_LABELS[role],
              ),
            ),
          ),
        },
        model.paid?.status === "down"
          ? h("p", { class: "notice" }, "The Bazaar did not answer: what each payment paid for is not shown.")
          : null,
        paymentTable(view, context.registry, model.items, paid, context.now),
        model.nextCursor === null
          ? null
          : h(
              "div",
              { class: "pager" },
              h(
                "div",
                { class: "actions" },
                h(
                  "a",
                  { class: "btn small", href: query(model.role, model.nextCursor), rel: "next" },
                  "Older payments ›",
                ),
              ),
            ),
      ),
    ),
  );
}

/** Says how many assets each side left out, when the totals were cut. */
function moreNotice(totals: AccountTotals): Child {
  const parts = [
    totals.more.payer > 0 ? `${groupThousands(totals.more.payer)} more paid` : "",
    totals.more.payTo > 0 ? `${groupThousands(totals.more.payTo)} more received` : "",
  ].filter((part) => part !== "");
  if (parts.length === 0) return null;
  return h(
    "p",
    { class: "notice", role: "status" },
    `${parts.join(" and ")} ${totals.more.payer + totals.more.payTo === 1 ? "asset is" : "assets are"} not shown. Each side lists verified Stellar assets first, then the assets with the most payments.`,
  );
}
