import {
  CHECKS,
  type ExclusionReason,
  type FailedAttemptRow,
  type RegistrySnapshot,
  type SettlementRow,
} from "@rail402.dev/x402-index";
import type { Answer, PaidFor } from "../bazaar.ts";
import {
  amountLabel,
  amountText,
  assetLabel,
  badge,
  body,
  copyButton,
  externalLink,
  facilitatorName,
  fullAddress,
  fullHash,
  h,
  layout,
  listingTitle,
  notCataloged,
  note,
  panel,
  rowAsset,
  rows,
  row,
  schemeBadge,
  shortAddress,
  table,
  tierLabel,
  type Child,
  type LayoutOptions,
} from "../components.ts";
import {
  decimalAmount,
  groupThousands,
  rpcCommand,
  stellarExpertAccount,
  stellarExpertTx,
  utc,
  type NetworkView,
} from "../format.ts";
import { displayText } from "../text.ts";
import { listingPrice, type PageContext } from "./context.ts";

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
  readonly publicRpcUrl: string;
  /** What the payment paid for, from the Bazaar; undefined when this network has no Bazaar. */
  readonly paid: Answer<PaidFor> | undefined;
}

const EXCLUSIONS: Readonly<Record<ExclusionReason, string>> = {
  multi_operation: "It has more than one operation; the canonical scheme never batches.",
  multi_auth: "It does not carry exactly one authorization entry.",
  delegated_credentials:
    "Its authorization uses delegated credentials, which the canonical facilitator cannot verify today.",
  sub_invocations: "The authorized invocation has sub-invocations.",
  transfer_event_mismatch: "Its events do not prove the payment.",
  unproven_authorization:
    "Nothing on chain proves the payer authorized it: the token is not a Stellar Asset Contract and the payer's own key did not sign the authorization.",
  self_paid_fee: "The payer paid its own fee or signed as a source account, so the fee was not sponsored.",
  upto_unregistered_contract: "An upto_settled event came from a contract the registry does not list.",
  upto_wasm_mismatch: "The settlement contract runs WASM other than the registered one.",
  malformed: "Its XDR does not decode, or its arguments do not match a settlement.",
};

/** What each rule check reads from the transaction. */
const READS: Readonly<Record<string, string>> = {
  E1: "result",
  E2: "operation",
  E3: "auth",
  E4: "invocation",
  E5: "fee",
  E6: "events",
  E7: "signature",
  U1: "result",
  U2: "operation",
  U3: "registry",
  U4: "wasm",
  U5: "events",
  U6: "events",
  U7: "fee",
  B1: "result",
  B2: "operation",
  B3: "events",
};

const stellarExpertLedger = (view: NetworkView, ledger: number) =>
  `https://stellar.expert/explorer/${view.expert}/ledger/${String(ledger)}`;

/** The strip that sends the reader to sources other than this page. */
function proofStrip(context: TxPageContext, hash: string, ledger: number): Child {
  const view = context.page.layout.view;
  const command = rpcCommand(context.publicRpcUrl, hash);
  const rebuild = `pnpm explorer:rebuild --network ${view.slug} --from ${String(ledger)} --to ${String(ledger)}`;
  return h(
    "section",
    { class: "proof", id: "verify", "aria-labelledby": "verify-title" },
    h("h2", { id: "verify-title" }, "Don't trust us, check it"),
    h(
      "div",
      { class: "actions stack" },
      externalLink(stellarExpertTx(view, hash), "stellar.expert ↗", "btn on-dark"),
      h("a", { class: "btn on-dark", href: `/api/v1/${view.slug}/transactions/${hash}` }, "Raw transaction"),
      externalLink(
        "https://docs.rail402.dev/reference/explorer-rebuild",
        "Rebuild the index",
        "btn on-dark accent",
      ),
    ),
    h(
      "p",
      { class: "rebuild" },
      "From the network's public RPC (about the last seven days): ",
      h("code", null, command),
      copyButton(command, "command"),
    ),
    h(
      "p",
      { class: "rebuild" },
      "This ledger's rows from the public data lake, with no access to this site: ",
      h("code", null, rebuild),
      copyButton(rebuild, "command"),
    ),
  );
}

function liveNotice(): Child {
  return h(
    "p",
    { class: "notice info", role: "status" },
    h("strong", null, "Live lookup, not yet indexed. "),
    "This transaction was read from the network's RPC just now and classified with the same rules; it enters the index and the report once the indexer reaches its ledger.",
  );
}

function settlementBody(context: TxPageContext, settlement: SettlementRow, live: boolean): Child[] {
  const page = context.page;
  const view = page.layout.view;
  const registry: RegistrySnapshot = page.registry;
  const facilitator =
    settlement.attribution.facilitatorId === null
      ? undefined
      : registry.facilitator(settlement.attribution.facilitatorId);
  const paid = context.paid?.status === "ok" ? context.paid.value : undefined;
  const feeXlm = `${decimalAmount(settlement.fee.chargedStroops)} XLM`;
  const amount = amountText(settlement);
  const checks = settlement.checks.map((id) => ({
    id: displayText(id, 4),
    text: (CHECKS as Readonly<Record<string, string | undefined>>)[id] ?? displayText(id, 120),
    read: READS[id] ?? "",
  }));
  const settledBy =
    facilitator === undefined ? tierLabel(settlement.attribution.tier) : facilitatorName(facilitator);
  const title =
    paid === undefined
      ? `${amount} to ${settlement.payTo.slice(0, 4)}…${settlement.payTo.slice(-4)}`
      : `${amount} for ${listingTitle(paid.listing)}`;
  const paidForValue: Child =
    context.paid === undefined
      ? h("span", { class: "muted" }, "No Bazaar is configured for this network.")
      : context.paid.status === "down"
        ? h("span", { class: "muted" }, "The Bazaar did not answer; try again shortly.")
        : paid === undefined
          ? [
              notCataloged(),
              h(
                "span",
                { class: "small muted" },
                "The Bazaar links no public listing to this payment: it was not cataloged, its seller keeps usage private, or cataloging has not finished yet.",
              ),
            ]
          : [
              h(
                "a",
                { href: `${view.prefix}/resource/${paid.listing.id}`, class: "mono full" },
                `${paid.listing.type === "mcp" ? "MCP" : displayText(paid.listing.method ?? "", 8)} ${displayText(paid.listing.resource, 400)}${paid.listing.toolName === undefined ? "" : ` · ${displayText(paid.listing.toolName, 128)}`}`,
              ),
              badge(
                "First-party",
                "accent",
                "Rail402 settled this payment and cataloged the resource it paid for.",
              ),
            ];
  const moneyRows: Child[] = [
    h(
      "tr",
      null,
      h("td", null, shortAddress(view, settlement.payer)),
      h("td", null, "Payer"),
      h("td", { class: "num minus" }, `−${amount}`),
    ),
    h(
      "tr",
      null,
      h("td", null, shortAddress(view, settlement.payTo)),
      h("td", null, "Seller (payTo)"),
      h("td", { class: "num plus" }, `+${amount}`),
    ),
    h(
      "tr",
      null,
      h("td", null, shortAddress(view, settlement.fee.payer)),
      h("td", null, facilitator === undefined ? "Fee payer" : "Facilitator fee payer"),
      h("td", { class: "num" }, `−${feeXlm}`),
    ),
  ];
  const nonCustodial =
    settlement.fee.sponsored &&
    settlement.fee.payer !== settlement.payer &&
    settlement.fee.payer !== settlement.payTo;
  return [
    h(
      "div",
      { class: "page-head" },
      h(
        "div",
        { class: "titles" },
        h("p", { class: "eyebrow" }, `${view.label} · x402 payment`),
        h("h1", null, title),
        h(
          "div",
          { class: "badges" },
          badge("✓ Settled", "ok"),
          paid === undefined ? null : badge("First-party", "accent"),
          schemeBadge(settlement.scheme),
          badge(
            settledBy,
            facilitator?.tier === "rail402" ? "accent" : facilitator === undefined ? "warn" : undefined,
          ),
          live ? badge("Live lookup", "live") : null,
        ),
      ),
    ),
    h(
      "div",
      { class: "paid" },
      h("span", { class: "label" }, "Paid for"),
      paid === undefined
        ? h("span", null, "Not cataloged")
        : h("a", { href: `${view.prefix}/resource/${paid.listing.id}` }, listingTitle(paid.listing)),
      h("span", { class: "big" }, amount),
      h("span", { class: "small" }, `Fee ${feeXlm}, paid by ${settledBy}`),
    ),
    h(
      "nav",
      { class: "sections", "aria-label": "Payment" },
      h("a", { href: "#overview", "aria-current": "true" }, "Overview"),
      h("a", { href: "#money" }, "Money movement"),
      h("a", { href: "#checks" }, `Rule checks (${String(checks.length)})`),
      h("a", { href: "#verify" }, "Verify"),
    ),
    live ? liveNotice() : null,
    panel(
      { id: "overview", label: "Overview" },
      rows(
        "group",
        row(
          "Transaction hash",
          fullHash(settlement.txHash),
          settlement.fee.bump ? h("span", { class: "small muted" }, "fee bump, outer") : null,
        ),
        settlement.innerHash === null ? null : row("Inner hash", fullHash(settlement.innerHash)),
        row(
          "Status",
          badge("✓ Settled", "ok"),
          h("span", { class: "small muted" }, `rule ${settlement.ruleId}`),
        ),
        row(
          "Ledger",
          externalLink(
            stellarExpertLedger(view, settlement.ledger),
            groupThousands(settlement.ledger),
            "mono",
          ),
          h("span", { class: "small muted" }, `position ${String(settlement.txIndex)}`),
        ),
        row("Timestamp", utc(settlement.closedAt)),
        row("Network", `${view.label} (${settlement.network})`),
      ),
      rows(
        "group",
        row("Paid for", paidForValue),
        paid === undefined
          ? null
          : row(
              "Service",
              h(
                "a",
                { href: `${view.prefix}/account/${paid.listing.payTo}` },
                displayText(paid.listing.serviceName ?? hostOf(paid.listing.resource), 120),
              ),
              h("span", { class: "small muted" }, "seller page"),
            ),
        paid === undefined
          ? null
          : row(
              "Listed price",
              `${listingPrice(page, paid.listing)} · scheme ${displayText(paid.listing.scheme, 16)}`,
            ),
      ),
      rows(
        "group",
        row(
          "From (payer)",
          fullAddress(view, settlement.payer),
          h("span", { class: "small muted" }, settlement.payerKind === "C" ? "contract account" : "account"),
        ),
        row(
          "To (payTo)",
          fullAddress(view, settlement.payTo),
          settlement.payToMuxedId === null
            ? null
            : h("span", { class: "small muted" }, `muxed id ${displayText(settlement.payToMuxedId, 24)}`),
        ),
        row(
          "Amount",
          amountLabel(settlement),
          settlement.asset.verified ? badge("Verified asset", "grey") : null,
        ),
        settlement.scheme === "upto"
          ? row(
              "Authorized up to",
              settlement.maxAmount === null
                ? h("span", { class: "muted" }, "not recorded")
                : amountLabel(settlement, settlement.maxAmount),
              h("span", { class: "small muted" }, "Cap (upto)"),
            )
          : null,
        row(
          "Asset",
          assetLabel(settlement),
          externalLink(
            stellarExpertAccount(view, settlement.asset.contract),
            displayText(settlement.asset.contract, 56),
            "mono full",
          ),
          copyButton(displayText(settlement.asset.contract, 56), "token contract"),
        ),
        settlement.asset.verified && settlement.asset.issuer !== null
          ? row("Issuer", fullAddress(view, settlement.asset.issuer))
          : null,
        settlement.upto === null
          ? null
          : row(
              "Upto contract",
              h("span", { class: "mono full" }, displayText(settlement.upto.contract, 56)),
            ),
        settlement.upto === null
          ? null
          : row("Settlement authority", fullAddress(view, settlement.upto.authority)),
      ),
      rows(
        "group",
        row(
          "Settled by",
          facilitator === undefined
            ? badge(tierLabel(settlement.attribution.tier), "warn")
            : [
                h(
                  "a",
                  { href: `${view.prefix}/facilitator/${facilitator.id}` },
                  displayText(facilitator.name, 100),
                ),
                badge(facilitator.tier === "rail402-beta" ? "Concluded beta" : "Registered", "grey"),
              ],
          settlement.attribution.evidenceUrl === null
            ? h(
                "span",
                { class: "small muted" },
                "No registry account matched: smart-wallet relays, test scripts and unknown facilitators look the same.",
              )
            : externalLink(settlement.attribution.evidenceUrl, "attribution evidence"),
          settlement.attribution.sharedRelayer || facilitator?.sharedRelayer === true
            ? h(
                "span",
                { class: "small muted" },
                "Shared relayer: it also relays transactions that are not x402 payments.",
              )
            : null,
        ),
        row("Fee payer", fullAddress(view, settlement.fee.payer)),
        row(
          "Network fee",
          `${feeXlm} (${groupThousands(settlement.fee.chargedStroops)} stroops)`,
          settlement.fee.sponsored ? badge("Sponsored", "ok") : badge("Not sponsored", "warn"),
          h(
            "span",
            { class: "small muted" },
            settlement.fee.sponsored
              ? `the payer paid no fee${settlement.fee.bump ? "; sponsored through a fee bump" : ""}`
              : "the transaction source paid it",
          ),
        ),
        row("Transaction source", fullAddress(view, settlement.fee.innerSource)),
        row(
          "Rule",
          `${settlement.ruleId} v${displayText(settlement.rulesVersion, 8)} · ${String(checks.length)} of ${String(checks.length)} checks passed`,
        ),
        row(
          "Classified under",
          `rules v${displayText(settlement.rulesVersion, 8)}, registry ${displayText(settlement.registryVersion, 20)}`,
          live ? null : h("span", { class: "small muted" }, `epoch ${displayText(settlement.epoch, 32)}`),
        ),
      ),
      note(
        "“Paid for” comes from the Rail402 Bazaar (off chain). Everything else on this page is read from the ledger.",
      ),
    ),
    h(
      "div",
      { class: "grid-2" },
      panel(
        {
          title: "Money movement",
          id: "money",
          aside: nonCustodial ? badge("Non-custodial", "ok") : null,
        },
        table("narrow", [{ label: "Account" }, { label: "Role" }, { label: "Change", num: true }], moneyRows),
        h(
          "p",
          { class: "panel-note strong" },
          nonCustodial
            ? `The fee payer only paid the network fee. The rule checks prove the ${settlement.asset.verified ? rowAsset(settlement) : "token"} moved from the payer to the seller.`
            : "The fee was not sponsored by a separate account.",
        ),
      ),
      panel(
        {
          title: `Rule checks · ${settlement.ruleId} v${displayText(settlement.rulesVersion, 8)}`,
          id: "checks",
          aside: h("a", { href: "/methodology#checks" }, "Read the rules"),
        },
        checks.map((check) =>
          h(
            "div",
            { class: "check" },
            h("span", { class: "id" }, check.id),
            h("span", { class: "text" }, check.text),
            h("span", { class: "read" }, check.read),
            h("span", { class: "pass" }, "PASS"),
          ),
        ),
        note("Rule checks that matched, as the published indexing rules define them."),
      ),
    ),
    proofStrip(context, settlement.txHash, settlement.ledger),
  ];
}

function hostOf(resource: string): string {
  try {
    return new URL(resource).host;
  } catch {
    return resource;
  }
}

function failedBody(context: TxPageContext, failed: FailedAttemptRow, live: boolean): Child[] {
  const view = context.page.layout.view;
  return [
    h(
      "div",
      { class: "page-head" },
      h(
        "div",
        { class: "titles" },
        h("p", { class: "eyebrow" }, `${view.label} · failed attempt`),
        h("h1", null, "Failed x402 attempt"),
        h(
          "div",
          { class: "badges" },
          badge("Failed", "error"),
          schemeBadge(failed.scheme),
          live ? badge("Live lookup", "live") : null,
        ),
      ),
    ),
    h(
      "p",
      { class: "notice error", role: "status" },
      h("strong", null, "Not a payment. "),
      "This transaction has the shape of an x402 settlement but failed on chain. Failed attempts are never counted.",
      live ? " (Live lookup, not yet indexed.)" : "",
    ),
    panel(
      { label: "Failed attempt" },
      rows(
        undefined,
        row("Network", `${view.label} (${failed.network})`),
        row("Result", h("code", null, displayText(failed.resultCode, 120))),
        row("Fee payer", fullAddress(view, failed.feePayer)),
        row("Fee charged", `${groupThousands(failed.feeChargedStroops)} stroops`),
        row("Hash", fullHash(failed.txHash)),
        row("Ledger", groupThousands(failed.ledger)),
      ),
    ),
    proofStrip(context, failed.txHash, failed.ledger),
  ];
}

function notX402Body(context: TxPageContext, model: Extract<TxModel, { kind: "not_x402" }>): Child[] {
  const view = context.page.layout.view;
  return [
    h(
      "div",
      { class: "page-head" },
      h(
        "div",
        { class: "titles" },
        h("p", { class: "eyebrow" }, `${view.label} · live lookup`),
        h("h1", null, "Not an x402 settlement"),
      ),
    ),
    h(
      "p",
      { class: "notice info", role: "status" },
      h("strong", null, "Live lookup, not yet indexed. "),
      model.reason === null
        ? "This transaction exists on chain, but it is not shaped like an x402 settlement under the indexing rules."
        : ["It is close to an x402 settlement but misses one check: ", EXCLUSIONS[model.reason]],
    ),
    panel(
      { label: "Transaction" },
      rows(
        undefined,
        row("Hash", fullHash(model.hash)),
        row("Ledger", groupThousands(model.ledger), h("span", { class: "small muted" }, utc(model.closedAt))),
        model.reason === null ? null : row("Excluded because", h("code", null, model.reason)),
      ),
    ),
    proofStrip(context, model.hash, model.ledger),
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
  const layoutOptions: LayoutOptions = {
    ...context.page.layout,
    section: "payments",
    title: `Payment ${hash.slice(0, 12)}…`,
    path: `/tx/${hash}`,
    description:
      "An x402 payment on Stellar: what it paid for, who paid whom, the facilitator, the fee sponsorship and the rule checks that matched.",
  };
  return layout(layoutOptions, body(...content));
}
