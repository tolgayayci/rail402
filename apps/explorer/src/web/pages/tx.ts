import type {
  CheckId,
  ExclusionReason,
  FailedAttemptRow,
  RegistrySnapshot,
  SettlementRow,
} from "@rail402.dev/x402-index";
import { COUNT_CAP } from "../../api/queries-b.ts";
import type { Answer, PaidFor } from "../bazaar.ts";
import { h, rowAsset, type Child, type Node } from "../components.ts";
import { decimalAmount, groupThousands, shortKey, stellarExpertTx, type NetworkView } from "../format.ts";
import { displayText } from "../text.ts";
import {
  actionLink,
  bdg,
  card,
  checks,
  copyAction,
  copyMini,
  facPill,
  kv,
  networkPill,
  page,
  pageHead,
  schemePill,
  tile,
} from "../ui.ts";
import type { PageContext } from "./context.ts";
import { facilitatorShort, paymentRow, rowAmount, rowFacilitator, rowHash } from "./payments.ts";

export type TxModel =
  | { readonly kind: "settlement"; readonly row: SettlementRow; readonly live: boolean }
  | { readonly kind: "failed"; readonly row: FailedAttemptRow; readonly live: boolean }
  | {
      readonly kind: "not_x402";
      readonly hash: string;
      readonly ledger: number;
      readonly closedAt: string;
      readonly reason: ExclusionReason | null;
    };

export interface TxPageContext {
  readonly page: PageContext;
  /** This page's public address, for "Copy link". */
  readonly url: string;
  /** What the payment paid for, from the Bazaar; undefined when this network has no Bazaar. */
  readonly paid: Answer<PaidFor> | undefined;
  /** Payments the buyer made in the epoch, when the index can say. */
  readonly buyerPayments?: number | undefined;
  /** The seller's Bazaar listings, or the payments it received when the Bazaar cannot say. */
  readonly seller?: { readonly services?: number; readonly payments?: number } | undefined;
  /** Payments between the same buyer and seller next to this one, and how many the buyer's list holds. */
  readonly same?: { readonly rows: readonly SettlementRow[]; readonly total: number | undefined } | undefined;
}

/**
 * The payments-list facilitator filter that holds a row: none for registered payments, `shaped` for
 * the apart ones, the beta's id for the concluded beta (never in the registered list).
 */
export function buyerList(row: Pick<SettlementRow, "attribution">): string | undefined {
  if (row.attribution.tier === "shaped") return "shaped";
  if (row.attribution.tier === "rail402-beta") return row.attribution.facilitatorId ?? undefined;
  return undefined;
}

/** The near miss each exclusion is, in the words of the check it failed. */
const EXCLUSIONS: Readonly<Record<ExclusionReason, string>> = {
  multi_operation: "One operation only",
  multi_auth: "Buyer signed once",
  delegated_credentials: "Buyer signed with its own key",
  sub_invocations: "Signed for this payment only",
  transfer_event_mismatch: "One token transfer",
  unproven_authorization: "Buyer's signature proven",
  self_paid_fee: "Buyer paid no network fee",
  upto_unregistered_contract: "Registered settlement contract",
  upto_wasm_mismatch: "Registered settlement contract",
  malformed: "Reads as a settlement",
};

/**
 * The rule checks in plain words. Checks that prove one thing together (the transfer and its event, the
 * signature and its proof) share a line; a line passes when every check under it passed.
 */
const LINES: Readonly<Record<"exact" | "upto" | "beta", readonly (readonly [string, readonly CheckId[]])[]>> =
  {
    exact: [
      ["Succeeded on Stellar", ["E1"]],
      ["One token transfer", ["E2", "E6"]],
      ["Buyer signed once", ["E3", "E7"]],
      ["Signed for this payment only", ["E4"]],
      ["Buyer paid no network fee", ["E5"]],
    ],
    upto: [
      ["Succeeded on Stellar", ["U1"]],
      ["One settle call", ["U2"]],
      ["Registered settlement contract", ["U3", "U4"]],
      ["Settled amount matches the transfer", ["U5", "U6"]],
      ["Buyer paid no network fee", ["U7"]],
    ],
    beta: [
      ["Succeeded on Stellar", ["B1"]],
      ["One settle call", ["B2"]],
      ["Concluded beta contract", ["B2"]],
      ["One token transfer", ["B3"]],
      ["Buyer paid no network fee", ["B3"]],
    ],
  };

const ROLES: Readonly<Record<string, string>> = {
  sponsor: "sponsor",
  channel: "channel",
  "upto-authority": "settlement authority",
  "fee-bump": "fee bump",
  relayer: "relayer",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct 29 · 14:32:55 UTC", with the year when it is not this year. */
function closedLabel(iso: string, now: number): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const year =
    date.getUTCFullYear() === new Date(now).getUTCFullYear() ? "" : `, ${String(date.getUTCFullYear())}`;
  return `${MONTHS[date.getUTCMonth()] ?? ""} ${String(date.getUTCDate())}${year} · ${date.toISOString().slice(11, 19)} UTC`;
}

/** How far `other` is from `base`: "31 min later", "5 s earlier". */
function relative(other: string, base: string): string {
  const seconds = Math.round((Date.parse(other) - Date.parse(base)) / 1000);
  const size = Math.abs(seconds);
  const amount =
    size < 60
      ? `${String(size)} s`
      : size < 3600
        ? `${String(Math.round(size / 60))} min`
        : size < 172_800
          ? `${String(Math.round(size / 3600))} h`
          : `${String(Math.round(size / 86_400))} days`;
  return seconds === 0 ? "same ledger time" : `${amount} ${seconds > 0 ? "later" : "earlier"}`;
}

/** An account linked to its page, short. */
const accountLink = (view: NetworkView, address: string, cls = "u") =>
  h(
    "a",
    { class: cls, href: `${view.prefix}/account/${address}`, title: address, "aria-label": address },
    shortKey(address),
  );

/** The role an account plays in a settlement: a registry role, the buyer, or not registered. */
function roleOf(registry: RegistrySnapshot, row: SettlementRow, address: string): Node {
  if (address === row.payer) return bdg("buyer", "mut");
  const match = registry.accountAt(address, row.epoch, row.ledger);
  return match === undefined
    ? bdg("not registered", "dash")
    : bdg(ROLES[match.account.role] ?? "registered", "mut");
}

const hashValue = (hash: string, what = "hash") => [
  h("span", { title: hash }, `${hash.slice(0, 8)}…${hash.slice(-7)}`),
  copyMini(hash, what),
];

/** The head's actions: copy this page's link, open the transaction on stellar.expert. */
const headActions = (context: TxPageContext, hash: string) => [
  copyAction(context.url, "Copy link"),
  actionLink(stellarExpertTx(context.page.layout.view, hash), "stellar.expert", "external", true, true),
];

/** The Details card (two lists of equal length) beside a check card. */
function detailsAndChecks(
  left: readonly (readonly [string, ...Child[]])[],
  right: readonly (readonly [string, ...Child[]])[],
  title: string,
  items: readonly { readonly label: string; readonly ok: boolean }[],
): Node {
  const passed = items.filter((item) => item.ok).length;
  return h(
    "div",
    { class: "g2 pg2" },
    card({ title: "Details", icon: "coin" }, h("div", { class: "kvs" }, kv(left), kv(right))),
    card(
      {
        title,
        icon: "shield",
        end: bdg(
          `${String(passed)} of ${String(items.length)}`,
          passed === items.length ? undefined : "warn",
        ),
      },
      checks(items, left.length > 6 ? "why one tall" : "why one"),
    ),
  );
}

function paidForValue(context: TxPageContext): Child {
  const view = context.page.layout.view;
  const paid = context.paid;
  if (paid === undefined) return h("span", { class: "muted oa-b-sans" }, `No Bazaar on ${view.label}`);
  if (paid.status === "down") return bdg("Bazaar did not answer", "mut");
  if (paid.status !== "ok")
    return bdg("not listed", "mut", "The Bazaar links no public listing to this payment.");
  const listing = paid.value.listing;
  let where = displayText(listing.serviceName ?? listing.resource, 120);
  if (listing.serviceName === undefined && listing.type !== "mcp") {
    try {
      where = new URL(listing.resource).host;
    } catch {
      // Not a URL: shown as it is.
    }
  }
  if (listing.type === "mcp" && listing.toolName !== undefined) where = displayText(listing.toolName, 128);
  return h("a", { class: "u oa-b-sans", href: `${view.prefix}/resource/${listing.id}` }, where);
}

function settlementBody(context: TxPageContext, row: SettlementRow, live: boolean): Child[] {
  const page = context.page;
  const view = page.layout.view;
  const registry = page.registry;
  const facilitator =
    row.attribution.facilitatorId === null ? undefined : registry.facilitator(row.attribution.facilitatorId);
  const registered = row.attribution.tier !== "shaped";
  const verified = row.asset.verified && row.asset.code !== null;
  const amount = verified ? decimalAmount(row.amount) : row.amount;
  const unit = verified ? rowAsset(row) : "units";
  const fee = decimalAmount(row.fee.chargedStroops);
  const feePayerMatch = registry.accountAt(row.fee.payer, row.epoch, row.ledger);
  const feeBy =
    feePayerMatch !== undefined
      ? bdg(`paid by ${facilitatorShort(feePayerMatch.facilitator)}`, "ok")
      : row.fee.payer === row.payer
        ? bdg("paid by the buyer", "warn")
        : bdg(`paid by ${shortKey(row.fee.payer)}`, "mut");
  const rule = row.ruleId === "R-UPTO" ? "upto" : row.ruleId === "R-UPTO-BETA" ? "beta" : "exact";
  const passed = new Set<string>(row.checks);
  const items = [
    ...LINES[rule].map(([label, ids]) => ({ label, ok: ids.every((id) => passed.has(id)) })),
    { label: live ? "Ledger check once indexed" : "Ledger matches the record", ok: !live },
    { label: "Registered facilitator", ok: registered },
  ];
  const upto = row.scheme === "upto";
  const used =
    row.maxAmount !== null && BigInt(row.maxAmount) > 0n
      ? Number((BigInt(row.amount) * 1000n) / BigInt(row.maxAmount)) / 10
      : undefined;
  const notRecorded = h("span", { class: "muted" }, "not recorded");
  const left: (readonly [string, ...Child[]])[] = [
    ["Network", networkPill(view)],
    ["Scheme", schemePill(row.scheme)],
    [
      "Asset",
      verified ? rowAsset(row) : h("span", { title: row.asset.contract }, shortKey(row.asset.contract)),
      verified ? bdg("verified", "ok") : bdg("unverified token", "warn"),
    ],
    ["Amount", h("b", null, rowAmount(row))],
    ...(upto
      ? [
          row.maxAmount === null
            ? (["Max amount", notRecorded] as const)
            : ([
                "Max amount",
                rowAmount(row, row.maxAmount),
                used === undefined ? null : bdg(`${String(used)}% used`, "info"),
              ] as const),
        ]
      : []),
    ["Facilitator", rowFacilitator(view.prefix, registry, row)],
    ["Paid for", paidForValue(context)],
  ];
  const right: (readonly [string, ...Child[]])[] = [
    [
      "Fee payer",
      accountLink(view, row.fee.payer),
      roleOf(registry, row, row.fee.payer),
      copyMini(row.fee.payer, "fee payer address"),
    ],
    ["Sent from", accountLink(view, row.fee.innerSource), roleOf(registry, row, row.fee.innerSource)],
    ...(upto
      ? [
          row.upto === null
            ? (["Authority", notRecorded] as const)
            : ([
                "Authority",
                accountLink(view, row.upto.authority),
                roleOf(registry, row, row.upto.authority),
              ] as const),
        ]
      : []),
    ["Envelope", row.fee.bump ? bdg("fee bump", "info") : bdg("single", "mut")],
    ["Network fee", `${fee} XLM`],
    ["Position", `tx ${String(row.txIndex)} in its ledger`],
    ["Hash", ...hashValue(row.txHash)],
  ];
  const same = context.same;
  const list = buyerList(row);
  const sameHref = `${view.prefix}/payments?account=${row.payer}${list === undefined ? "" : `&facilitator=${list}`}`;
  return [
    pageHead({
      crumbs: [
        ["Payments", `${view.prefix}/payments`],
        [rowHash(row.txHash), undefined],
      ],
      title: [amount, " ", h("span", { class: "oa-b-unit" }, unit)],
      badges: [
        bdg("✓ Settled", "ok"),
        schemePill(row.scheme),
        rowFacilitator(view.prefix, registry, row),
        registered
          ? null
          : bdg("kept apart", "warn", "Not settled by a registered facilitator: never in the totals."),
        row.payer === row.payTo
          ? bdg("self-payment", "warn", "The buyer paid itself: never in the totals.")
          : null,
        row.fee.sponsored ? bdg("fee sponsored", "ok") : bdg("fee not sponsored", "warn"),
        row.attribution.sharedRelayer || facilitator?.sharedRelayer === true
          ? bdg("shared relayer", "warn", "This relayer also sends transfers that are not x402 payments.")
          : null,
        live
          ? bdg("not indexed yet", "info", "Read from the network just now; it enters the index soon.")
          : null,
        bdg(closedLabel(row.closedAt, page.now), "mut"),
      ],
      actions: headActions(context, row.txHash),
    }),
    h(
      "div",
      { class: "g4 oa-b-tiles" },
      tile({
        label: "Buyer",
        icon: "user",
        value: [accountLink(view, row.payer, "u oa-b-key"), copyMini(row.payer, "buyer address")],
        badges: [
          context.buyerPayments === undefined
            ? bdg(row.payerKind === "C" ? "contract account" : "account", "mut")
            : bdg(
                `${groupThousands(context.buyerPayments)} payment${context.buyerPayments === 1 ? "" : "s"}`,
                "mut",
              ),
        ],
      }),
      tile({
        label: "Seller",
        icon: "bazaar",
        value: [accountLink(view, row.payTo, "u oa-b-key"), copyMini(row.payTo, "seller address")],
        badges: [
          context.seller?.services !== undefined
            ? bdg(
                context.seller.services === 0
                  ? "no listings"
                  : `${groupThousands(context.seller.services)} service${context.seller.services === 1 ? "" : "s"}`,
                "mut",
              )
            : context.seller?.payments !== undefined
              ? bdg(`${groupThousands(context.seller.payments)} payments received`, "mut")
              : null,
          row.payToMuxedId === null ? null : bdg(`muxed ${displayText(row.payToMuxedId, 24)}`, "mut"),
        ],
      }),
      tile({
        label: "Ledger",
        icon: "ledger",
        value: groupThousands(row.ledger),
        badges: [bdg(`tx ${String(row.txIndex)} of the ledger`, "mut")],
      }),
      tile({
        label: "Network fee",
        icon: "shield",
        value: fee,
        unit: "XLM",
        valueCls: "oa-b-fee",
        badges: [feeBy],
      }),
    ),
    detailsAndChecks(left, right, "Why it counts", items),
    same === undefined || same.rows.length === 0
      ? null
      : card(
          {
            title: "Same buyer and seller",
            icon: "list",
            cls: "oa-b-same",
            link: {
              href: sameHref,
              label:
                same.total === undefined
                  ? "All →"
                  : `All ${groupThousands(Math.min(same.total, COUNT_CAP))}${same.total > COUNT_CAP ? "+" : ""} →`,
            },
          },
          h(
            "div",
            { class: "feed2" },
            same.rows.map((other) => paymentRow(page, other, relative(other.closedAt, row.closedAt))),
          ),
        ),
  ];
}

function failedBody(context: TxPageContext, failed: FailedAttemptRow, live: boolean): Child[] {
  const page = context.page;
  const view = page.layout.view;
  const match = page.registry.accountAt(failed.feePayer, failed.epoch, failed.ledger);
  const fee = decimalAmount(failed.feeChargedStroops);
  return [
    pageHead({
      crumbs: [
        ["Payments", `${view.prefix}/payments`],
        [rowHash(failed.txHash), undefined],
      ],
      title: "Failed attempt",
      badges: [
        bdg("✗ Failed", "warn"),
        schemePill(failed.scheme),
        match === undefined
          ? null
          : facPill(
              facilitatorShort(match.facilitator),
              match.facilitator.id,
              `${view.prefix}/facilitator/${match.facilitator.id}`,
            ),
        bdg("never counted", "mut"),
        live ? bdg("not indexed yet", "info") : null,
      ],
      actions: headActions(context, failed.txHash),
    }),
    detailsAndChecks(
      [
        ["Network", networkPill(view)],
        ["Scheme", schemePill(failed.scheme)],
        ["Result", h("span", { title: displayText(failed.resultCode, 120) }, resultWords(failed.resultCode))],
        ["Ledger", groupThousands(failed.ledger)],
      ],
      [
        [
          "Fee payer",
          accountLink(view, failed.feePayer),
          match === undefined
            ? bdg("not registered", "dash")
            : bdg(ROLES[match.account.role] ?? "registered", "mut"),
        ],
        ["Network fee", `${fee} XLM`],
        ["Position", `tx ${String(failed.txIndex)} in its ledger`],
        ["Hash", ...hashValue(failed.txHash)],
      ],
      "Why it does not count",
      [
        { label: "Shaped like an x402 payment", ok: true },
        { label: "Succeeded on Stellar", ok: false },
        { label: live ? "Ledger check once indexed" : "Ledger matches the record", ok: !live },
        { label: "No money moved", ok: true },
      ],
    ),
  ];
}

/** A failed transaction's result code in words. */
function resultWords(code: string): string {
  const text = displayText(code, 120).toLowerCase();
  if (text.includes("trapped")) return "Contract call failed";
  if (text.includes("resource_limit")) return "Ran out of resources";
  if (text.includes("insufficient_balance") || text.includes("underfunded")) return "Not enough funds";
  if (text.includes("bad_seq")) return "Wrong sequence number";
  if (text.includes("too_late") || text.includes("too_early")) return "Outside its time window";
  if (text.includes("bad_auth")) return "Signature not accepted";
  return "Rejected on chain";
}

function notX402Body(context: TxPageContext, model: Extract<TxModel, { kind: "not_x402" }>): Child[] {
  const view = context.page.layout.view;
  const near = model.reason !== null;
  return [
    pageHead({
      title: near ? "Near miss" : "Not an x402 payment",
      mono: false,
      badges: [
        near ? bdg("near miss · not counted", "warn") : bdg("not x402", "mut"),
        bdg("not indexed yet", "info", "Read from the network just now."),
        bdg(closedLabel(model.closedAt, context.page.now), "mut"),
      ],
      actions: headActions(context, model.hash),
    }),
    detailsAndChecks(
      [
        ["Network", networkPill(view)],
        ["Ledger", groupThousands(model.ledger)],
        ["Closed", closedLabel(model.closedAt, context.page.now)],
      ],
      [
        ["Hash", ...hashValue(model.hash)],
        ["Index", bdg("not indexed yet", "info")],
        ["Counted", bdg("never", "mut")],
      ],
      "Why it does not count",
      [
        { label: "Succeeded on Stellar", ok: true },
        {
          label: model.reason === null ? "Shaped like an x402 payment" : EXCLUSIONS[model.reason],
          ok: false,
        },
        { label: "Ledger check once indexed", ok: false },
      ],
    ),
  ];
}

export function txPage(context: TxPageContext, model: TxModel): string {
  const hash = model.kind === "not_x402" ? model.hash : model.row.txHash;
  const content =
    model.kind === "settlement"
      ? settlementBody(context, model.row, model.live)
      : model.kind === "failed"
        ? failedBody(context, model.row, model.live)
        : notX402Body(context, model);
  return page(
    {
      ...context.page.layout,
      section: "payments",
      title: `Payment ${hash.slice(0, 12)}…`,
      path: `/tx/${hash}`,
      description:
        "An x402 payment on Stellar: who paid whom, how much, the facilitator, the fee and the rule checks it passed.",
    },
    ...content,
  );
}
