/**
 * Swimlane rows, projected from a run's lab events only.
 *
 * - Rows are ordered by causal step, not by arrival: the seller→facilitator and facilitator→Stellar
 *   rows are placed before the 200 row once the paid response and the chain read arrive.
 * - A request row is `live` until its response or failure arrives, and `pending` when the run ended
 *   without one.
 * - Every field names its source: `you` (your wire or your signer), `seller` (its 402,
 *   PAYMENT-RESPONSE or trace), `chain` (an RPC read) or `bazaar` (a Bazaar read). A row never claims
 *   more than its sources show.
 */
import type {
  DeliveryView,
  JsonValue,
  ListingView,
  OptionView,
  ScenarioId,
  Source,
  Trust,
  TxView,
  VersionView,
} from "../engine/events.ts";
import type { LabEvent } from "../engine/events.ts";
import { SCENARIO_DEFAULTS, SESSION_CHECK_WINDOW, type StepId } from "../../../src/shared/lab.ts";
import { DOCS, type DocRef } from "./docs.ts";
import {
  collectFacts,
  ended,
  httpExchanges,
  paidAmount,
  paysMcpTool,
  requiredOf,
  sdkEvents,
  settleOf,
  settlementTx,
  toolCallExchanges,
  type Exchange,
  type RunFacts,
  type ToolExchange,
} from "./facts.ts";
import {
  compareDecimal,
  decimalDelta,
  duration,
  pathAndQuery,
  short,
  signedAmount,
  toAtomic,
  toDecimal,
} from "./format.ts";
import { at, bool, inline, list, num, str } from "./json.ts";
import { LANE } from "./lanes.ts";

export type RowStatus = "pending" | "live" | "done" | "error";

/** An arrow between two lanes, or a step that happens inside one lane. */
export type RowLane = { readonly from: number; readonly to: number } | { readonly self: number };

export interface RowField {
  readonly key: string;
  readonly value: string;
  readonly source: Source;
}

export interface Row {
  /** Unique within a run; stable while the run grows. */
  readonly id: string;
  readonly lane: RowLane;
  readonly label: string;
  readonly sub: string;
  readonly status: RowStatus;
  /** Where the row's main fact comes from. */
  readonly source: Source;
  readonly step: StepId;
  readonly fields: readonly RowField[];
  readonly doc: DocRef;
}

export interface RowContext {
  /** The asset shown when an event does not name one (the configured asset). */
  readonly asset: { readonly symbol: string; readonly decimals: number };
}

/** The causal order of steps. Every scenario's rows are a subsequence of it. */
export const STEP_ORDER: readonly StepId[] = Object.freeze([
  "request",
  "quote",
  "refused",
  "sign",
  "paid-request",
  "work",
  "settle",
  "overcharge-refused",
  "submit",
  "deliver",
  "resend",
  "replay-refused",
  "charged-once",
  "catalog",
  "origin-check",
  "listed",
  "search",
  "results",
  "pick",
  "budget",
  "call-tool",
  "tool-settle",
  "tool-result",
]);

const TRUST_LABEL: Readonly<Record<Trust, string>> = {
  settled: "settled",
  origin_verified: "origin verified",
  domain_verified: "domain verified",
};

export function trustLabel(trust: Trust): string {
  return TRUST_LABEL[trust];
}

/** The rows of a run, in causal order. Wallet runs (no `run` start event) have none. */
export function projectRows(events: readonly LabEvent[], context: RowContext): readonly Row[] {
  const facts = collectFacts(events);
  if (facts.start === undefined) return [];
  const builder = new RowBuilder(facts, context, facts.start.scenario);
  const rows = facts.start.scenario === "agent" ? builder.agentRows() : builder.httpRows();
  // A refusal of a later call (the session check's second payment) comes after the call that paid.
  const late = refusedAfterPayment(events);
  const rank = (row: Row): number =>
    late && row.step === "refused" ? STEP_ORDER.indexOf("deliver") + 0.5 : STEP_ORDER.indexOf(row.step);
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index)
    .map(({ row }) => row);
}

/** Whether the run's refusal on your side came after an earlier call of the run was answered paid. */
function refusedAfterPayment(events: readonly LabEvent[]): boolean {
  const paidIds = new Set<string>();
  let answered = false;
  for (const event of events) {
    if (event.kind === "http" && event.phase === "request" && event.paid) paidIds.add(event.id);
    if (event.kind === "http" && event.phase === "response" && paidIds.has(event.id)) answered = true;
    if (
      event.kind === "refusal" &&
      (event.layer === "policy" || event.layer === "guard" || event.layer === "playground")
    )
      return answered;
  }
  return false;
}

class RowBuilder {
  private readonly facts: RunFacts;
  private readonly context: RowContext;
  private readonly scenario: ScenarioId;
  /** A Pay run paying an MCP tool: its requests are JSON-RPC `tools/call`s. */
  private readonly mcp: boolean;

  constructor(facts: RunFacts, context: RowContext, scenario: ScenarioId) {
    this.facts = facts;
    this.context = context;
    this.scenario = scenario;
    this.mcp = paysMcpTool(facts);
  }

  // ---------------------------------------------------------------- HTTP flows: pay, upto, sell, checks

  httpRows(): Row[] {
    const { probe, paid, resend } = httpExchanges(this.facts);
    const option = this.chosenOption(probe);
    // Other requests the relay stopped (a check may try more than one address) each get their row.
    const stopped = this.facts.exchanges.filter(
      (exchange) => exchange !== probe && !exchange.request.paid && exchange.failure !== undefined,
    );
    const requests = [...(probe === undefined ? [] : [probe]), ...stopped].sort(
      (a, b) => this.facts.exchanges.indexOf(a) - this.facts.exchanges.indexOf(b),
    );
    const rows: (Row | undefined)[] = [
      ...requests.map((exchange) => this.requestRow(exchange)),
      probe === undefined ? undefined : this.quoteRow(probe, option),
      this.refusedRow(),
      this.scenario === "sell" ? undefined : this.signRow(option),
      paid === undefined ? undefined : this.paidRequestRow(paid, option),
      paid === undefined || this.scenario !== "upto" ? undefined : this.workRow(paid, option),
      paid === undefined ? undefined : this.settleRow(paid, option),
      paid === undefined ? undefined : this.settleRefusedRow(paid, option),
      this.scenario === "sell" ? undefined : this.submitRow(),
      paid === undefined || this.scenario === "sell" ? undefined : this.deliverRow(paid),
      resend === undefined ? undefined : this.resendRow(resend),
      resend?.response === undefined ? undefined : this.replayRefusedRow(resend),
      resend?.response === undefined ? undefined : this.chargedOnceRow(),
      ...(this.scenario === "sell" && paid !== undefined ? this.sellRows(paid) : []),
    ];
    return rows.filter((row): row is Row => row !== undefined);
  }

  private requestRow(exchange: Exchange): Row {
    const { request, failure } = exchange;
    const fields: RowField[] = [
      { key: "method", value: request.method, source: "you" },
      { key: "url", value: request.url, source: "you" },
      { key: "sent via", value: viaText(request.via), source: "you" },
      { key: "headers", value: namesText(request.headerNames), source: "you" },
    ];
    if (failure !== undefined) fields.push(...this.failureFields(failure));
    return {
      id: `request-${request.id}`,
      lane: this.arrow("buyer", "seller"),
      label:
        request.rpc?.method === "tools/call"
          ? `tools/call ${request.rpc.toolName ?? "tool"}`
          : `${request.method} ${pathAndQuery(request.url)}`,
      sub: failure === undefined ? "no API key, no account" : `refused: ${failure.code}`,
      status: this.exchangeStatus(exchange),
      source: "you",
      step: "request",
      fields,
      doc: DOCS.x402,
    };
  }

  private quoteRow(exchange: Exchange, option: OptionView | undefined): Row | undefined {
    const response = exchange.response;
    if (response === undefined) return undefined;
    const required = requiredOf(exchange);
    if ((!this.mcp && response.status !== 402) || required === undefined) {
      return {
        id: `quote-${response.id}`,
        lane: this.arrow("seller", "buyer"),
        label: `${String(response.status)} ${statusText(response.status)}`,
        sub: "no payment was asked for",
        status: response.status < 400 ? "done" : "error",
        source: "seller",
        step: "quote",
        fields: [
          { key: "status", value: String(response.status), source: "seller" },
          { key: "time", value: duration(response.ms), source: "you" },
        ],
        doc: DOCS.x402,
      };
    }
    const price = option === undefined ? undefined : this.optionAmount(option);
    const upto = option?.scheme === "upto";
    const fields: RowField[] = [];
    if (option !== undefined) {
      fields.push(
        {
          key: "scheme",
          value: upto ? "upto (pay for usage, up to a cap)" : `${option.scheme} (fixed price)`,
          source: "seller",
        },
        { key: upto ? "cap" : "amount", value: this.atomicText(option), source: "seller" },
        { key: "payTo", value: short(option.payTo), source: "seller" },
        { key: "network", value: option.network, source: "seller" },
        {
          key: "fees",
          value:
            option.feesSponsored === true
              ? "sponsored by the facilitator"
              : option.feesSponsored === false
                ? "not sponsored"
                : "not stated",
          source: "seller",
        },
        { key: "expires after", value: `${String(option.maxTimeoutSeconds)} s`, source: "seller" },
      );
      if (option.facilitatorAddress !== null) {
        fields.push({
          key: "settles via",
          value: `${short(option.facilitatorAddress)}${advertisedText(option.facilitatorAddressAdvertised)}`,
          source: "seller",
        });
      }
    }
    if (required.bazaar.declared) {
      fields.push({
        key: "discovery",
        value: [required.bazaar.type, required.bazaar.method ?? required.bazaar.toolName]
          .filter((part): part is string => part !== null)
          .join(" "),
        source: "seller",
      });
    }
    if (required.options.length > 1) {
      const acceptable = required.options.filter((item) => item.verdict?.acceptable === true).length;
      fields.push({
        key: "options",
        value: `${String(required.options.length)} offered, ${String(acceptable)} within your policy`,
        source: "you",
      });
    }
    if (option?.verdict !== null && option?.verdict !== undefined) {
      fields.push({
        key: "your policy",
        value: option.verdict.acceptable
          ? "allows it ✓"
          : `refuses it: ${option.verdict.code ?? "not acceptable"}`,
        source: "you",
      });
    }
    if (required.error !== null) fields.push({ key: "error", value: required.error, source: "seller" });
    const priceText = price === undefined ? "" : `${upto ? "up to " : ""}${price}`;
    return {
      id: `quote-${response.id}`,
      lane: this.arrow("seller", "buyer"),
      label: this.mcp
        ? "Payment required"
        : this.scenario === "pay"
          ? "402 Payment Required"
          : `402 · ${priceText}`,
      sub: this.mcp
        ? priceText === ""
          ? "tools/call error with the payment terms"
          : `tools/call error with the price: ${priceText}`
        : this.scenario === "sell" && required.bazaar.declared
          ? "price + discovery metadata"
          : upto
            ? `scheme: upto · cap ${price ?? "unknown"}`
            : `PAYMENT-REQUIRED: ${priceText}`,
      status: "done",
      source: "seller",
      step: "quote",
      fields,
      doc: upto ? DOCS.upto : DOCS.architecture,
    };
  }

  private refusedRow(): Row | undefined {
    // Refusals by the seller or the facilitator are shown where they happened, and relay refusals on
    // the request they stopped; this row is for refusals on your side, which come before any signature.
    const refusal = this.facts.refusals.find(
      (item) => item.layer === "policy" || item.layer === "guard" || item.layer === "playground",
    );
    const signed = sdkEvents(this.facts, "signed").length;
    const elsewhere = this.facts.refusals.some(
      (item) => item.layer !== "policy" && item.layer !== "guard" && item.layer !== "playground",
    );
    const sdkRefusal = signed === 0 && !elsewhere ? sdkEvents(this.facts, "refused")[0] : undefined;
    if (refusal === undefined && sdkRefusal === undefined) return undefined;
    const code = refusal?.code ?? sdkRefusal?.code ?? "";
    const reserved = sdkEvents(this.facts, "reserved").length;
    const fields: RowField[] = [{ key: "code", value: code, source: "you" }];
    if (refusal !== undefined) {
      fields.push(
        { key: "reason", value: refusal.reason, source: "you" },
        { key: "refused by", value: layerText(refusal.layer), source: "you" },
      );
      for (const [key, name] of [
        ["price", "price"],
        ["your cap", "cap"],
        ["ceiling", "ceiling"],
        ["network", "network"],
        ["asset", "asset"],
        ["recipient", "payTo"],
      ] as const) {
        const value = detailText(refusal.details, name);
        if (value !== undefined) fields.push({ key, value, source: "you" });
      }
    }
    fields.push(
      {
        key: "signed",
        value: signed === 0 ? "nothing" : `${String(signed)} authorization(s)`,
        source: "you",
      },
      {
        key: "reserved",
        value: reserved === 0 ? "nothing" : `${String(reserved)} hold(s)`,
        source: "you",
      },
      {
        key: "paid",
        value: this.facts.txs.length === 0 ? "nothing" : `${String(this.facts.txs.length)} transaction(s)`,
        source: "chain",
      },
    );
    // Before signing when the refused call itself signed nothing (an earlier call of the run may have).
    const refusedCall = detailText(refusal?.details, "callId") ?? sdkRefusal?.callId;
    const signedForCall =
      refusedCall === undefined
        ? signed
        : sdkEvents(this.facts, "signed").filter((event) => event.callId === refusedCall).length;
    return {
      id: "refused",
      lane: { self: LANE.http.you },
      label: signedForCall === 0 ? "Refused before signing" : "Refused",
      sub: code,
      status: "error",
      source: "you",
      step: "refused",
      fields,
      doc: code.startsWith("egress_") ? DOCS.egress : DOCS.spendingPolicy,
    };
  }

  private signRow(option: OptionView | undefined): Row | undefined {
    const reserved = sdkEvents(this.facts, "reserved")[0];
    const signed = sdkEvents(this.facts, "signed")[0];
    const auth = this.facts.auth;
    if (reserved === undefined && signed === undefined && auth === undefined) return undefined;
    const upto = auth?.scheme === "upto" || option?.scheme === "upto";
    const fields = this.signFields(option);
    const cap = this.runCap();
    return {
      id: "sign",
      lane: { self: LANE.http.you },
      label: upto ? "Authorize the cap" : "Sign one authorization",
      sub: upto
        ? `settle(terms) + approve(${this.uptoMax() ?? "cap"})`
        : cap === null
          ? "checked against your cap"
          : `checked against your ${cap} cap`,
      status: signed !== undefined ? "done" : this.openStatus(),
      source: "you",
      step: "sign",
      fields,
      doc: upto ? DOCS.uptoContract : DOCS.authorization,
    };
  }

  private signFields(option: OptionView | undefined): RowField[] {
    const auth = this.facts.auth;
    const reserved = sdkEvents(this.facts, "reserved")[0];
    const signed = sdkEvents(this.facts, "signed")[0];
    const fields: RowField[] = [];
    const symbol = option?.symbol ?? this.context.asset.symbol;
    if (auth?.scheme === "exact") {
      fields.push({
        key: "call",
        value: `${symbol}.transfer(you → ${short(auth.transfer.to)}, ${auth.transfer.amount})`,
        source: "you",
      });
    } else if (auth?.scheme === "upto") {
      fields.push(
        { key: "contract", value: short(auth.contract), source: "you" },
        { key: "recipient", value: short(auth.terms.recipient), source: "you" },
        {
          key: "max",
          value: this.amount(auth.terms.maxAmount, option) ?? auth.terms.maxAmount,
          source: "you",
        },
        { key: "settler", value: short(auth.terms.facilitator), source: "you" },
      );
      if (auth.approve !== null) {
        fields.push({
          key: "approve",
          value: `${short(auth.approve.spender)} may move ${this.amount(auth.approve.amount, option) ?? auth.approve.amount}`,
          source: "you",
        });
      }
    }
    const capCheck = this.capCheck(option);
    if (capCheck !== undefined) fields.push({ key: "cap check", value: capCheck, source: "you" });
    if (reserved !== undefined) {
      fields.push({
        key: "reserved",
        value: this.amount(reserved.amount, option) ?? reserved.amount,
        source: "you",
      });
    }
    if (auth !== undefined) {
      fields.push(
        { key: "nonce", value: short(auth.nonce, 6), source: "you" },
        {
          key: "expires",
          value: `ledger ${String(auth.expirationLedger)}${
            auth.expiresInSeconds === null ? "" : ` (about ${String(auth.expiresInSeconds)} s)`
          }`,
          source: "you",
        },
        { key: "credential", value: auth.credential, source: "you" },
      );
    } else if (signed !== undefined) {
      fields.push({ key: "expires", value: `ledger ${String(signed.expirationLedger)}`, source: "you" });
    }
    return fields;
  }

  private paidRequestRow(exchange: Exchange, option: OptionView | undefined): Row {
    const { request } = exchange;
    const fields: RowField[] = this.mcp
      ? [
          {
            key: "payment",
            value: '_meta["x402/payment"], the signed authorization (not shown)',
            source: "you",
          },
          { key: "sent via", value: viaText(request.via), source: "you" },
        ]
      : [
          { key: "headers", value: namesText(request.headerNames), source: "you" },
          {
            key: "payload",
            value: `${this.payloadText(option)}, the signed authorization (not shown)`,
            source: "you",
          },
          { key: "sent via", value: viaText(request.via), source: "you" },
        ];
    if (this.scenario === "sell") fields.unshift(...this.signFields(option));
    if (exchange.failure !== undefined) fields.push(...this.failureFields(exchange.failure));
    return {
      id: `paid-${request.id}`,
      lane: this.arrow("buyer", "seller"),
      label: this.mcp
        ? `tools/call ${request.rpc?.toolName ?? "tool"}, paid`
        : this.scenario === "sell"
          ? "Paid retry"
          : "Retry with PAYMENT-SIGNATURE",
      sub: this.mcp
        ? "the same call, with the payment in _meta"
        : this.scenario === "sell"
          ? "signed within your cap"
          : `payload: ${this.payloadText(option)}`,
      status: this.exchangeStatus(exchange),
      source: "you",
      step: "paid-request",
      fields,
      doc: this.scenario === "sell" ? DOCS.x402 : DOCS.x402Headers,
    };
  }

  /** The payment payload's shape: exact sends a signed transaction, upto signed authorizations. */
  private payloadText(option: OptionView | undefined): string {
    const scheme = this.facts.auth?.scheme ?? option?.scheme;
    return scheme === "upto" ? "{ authorization, signerAuthorizations }" : "{ transaction }";
  }

  private workRow(exchange: Exchange, option: OptionView | undefined): Row | undefined {
    const response = exchange.response;
    if (response === undefined) return undefined;
    const requested =
      response.trace?.settle?.requested ?? settleOf(exchange)?.amount ?? response.trace?.settle?.amount;
    if (requested === undefined) return undefined;
    const charge = this.amount(requested, option) ?? requested;
    const fields: RowField[] = [{ key: "charge", value: charge, source: "seller" }];
    const max = this.uptoMax();
    if (max !== undefined) fields.push({ key: "authorized cap", value: max, source: "you" });
    return {
      id: "work",
      lane: { self: LANE.http.seller },
      label: "Do the work",
      sub: `then charge ${charge}`,
      status: "done",
      source: "seller",
      step: "work",
      fields,
      doc: DOCS.meteredPricing,
    };
  }

  private settleRow(exchange: Exchange, option: OptionView | undefined): Row | undefined {
    const response = exchange.response;
    if (response === undefined) return undefined;
    const trace = response.trace;
    const settle = settleOf(exchange);
    if (trace?.settle === undefined && trace?.verify === undefined && settle === undefined) return undefined;
    const success = trace?.settle?.success ?? settle?.success;
    const requested = trace?.settle?.requested ?? trace?.settle?.amount ?? settle?.amount ?? undefined;
    const fields: RowField[] = [];
    if (trace !== undefined) {
      if (trace.verify !== undefined) {
        fields.push({
          key: "/verify",
          value: trace.verify.isValid
            ? `valid ✓ (${duration(trace.verify.ms)})`
            : `invalid: ${trace.verify.code ?? "no code"}`,
          source: "seller",
        });
      }
      if (trace.settle !== undefined) {
        fields.push({
          key: "/settle",
          value: trace.settle.success
            ? `settled ✓ (${duration(trace.settle.ms)})`
            : `refused: ${trace.settle.code ?? "no code"}`,
          source: "seller",
        });
        if (trace.settle.requested !== undefined) {
          fields.push({
            key: "asked to settle",
            value: this.amount(trace.settle.requested, option) ?? trace.settle.requested,
            source: "seller",
          });
        }
      }
      if (trace.bazaar !== undefined) {
        fields.push({
          key: "bazaar extension",
          value: `${trace.bazaar.status} · ${trace.bazaar.code}`,
          source: "seller",
        });
      }
    }
    if (settle !== undefined) {
      fields.push({
        key: settle.from === "mcp-meta" ? "_meta payment-response" : "PAYMENT-RESPONSE",
        value: settle.success ? "success" : `failed: ${settle.errorReason ?? "no reason"}`,
        source: "seller",
      });
      if (settle.transaction !== null)
        fields.push({ key: "transaction", value: short(settle.transaction, 6), source: "seller" });
      if (settle.payer !== null) fields.push({ key: "payer", value: short(settle.payer), source: "seller" });
    }
    const tx = settlementTx(this.facts);
    if (tx?.feeBump !== null && tx?.feeBump !== undefined) {
      fields.push({
        key: "fee source",
        value: `${short(tx.feeBump.feeSource)}${advertisedText(tx.feeSourceAdvertised)}`,
        source: "chain",
      });
    }
    // The amount the chain proves when it does; what the seller reported is only its claim.
    const paid = paidAmount(this.facts);
    const reportedText = requested === undefined ? undefined : this.amount(requested, option);
    const provenText = paid?.proven === true ? this.amount(paid.atomic, option) : undefined;
    if (reportedText !== undefined) {
      fields.push({ key: "reported amount", value: reportedText, source: "seller" });
    }
    if (provenText !== undefined) {
      fields.push({ key: "proven amount", value: provenText, source: "chain" });
      if (
        requested !== undefined &&
        /^\d+$/.test(requested) &&
        paid !== undefined &&
        BigInt(requested) !== BigInt(paid.atomic)
      ) {
        fields.push({
          key: "mismatch",
          value: `the seller reported ${reportedText ?? requested}, the chain shows ${provenText}`,
          source: "chain",
        });
      }
    }
    const amountText = provenText ?? (reportedText === undefined ? undefined : `${reportedText} (reported)`);
    const traced = trace?.settle !== undefined || trace?.verify !== undefined;
    return {
      id: "settle",
      lane: this.arrow("seller", "rail"),
      label:
        this.scenario === "upto" && success === false && reportedText !== undefined
          ? `/settle ${reportedText}`
          : this.scenario === "upto" && amountText !== undefined
            ? `/settle ${amountText}`
            : this.scenario === "sell"
              ? "/settle"
              : "/verify → /settle",
      sub:
        success === false
          ? this.overCap(trace?.settle?.requested)
            ? "more than you authorized"
            : (trace?.settle?.code ?? settle?.errorReason ?? "settlement failed")
          : this.scenario === "sell"
            ? "with the bazaar extension"
            : traced
              ? "reported by the seller's trace"
              : tx === undefined
                ? `reported in ${this.mcp ? "the result's _meta" : "PAYMENT-RESPONSE"}`
                : `reported in ${this.mcp ? "the result's _meta" : "PAYMENT-RESPONSE"}, proven on chain`,
      status: success === false ? "error" : "done",
      source: "seller",
      step: "settle",
      fields,
      doc: this.scenario === "upto" ? DOCS.upto : DOCS.verificationRules,
    };
  }

  private settleRefusedRow(exchange: Exchange, option: OptionView | undefined): Row | undefined {
    const response = exchange.response;
    if (response === undefined) return undefined;
    const traced = response.trace?.settle;
    const settle = settleOf(exchange);
    const failed = traced?.success === false || settle?.success === false;
    if (!failed) return undefined;
    const code = traced?.code ?? settle?.errorReason ?? "settlement_failed";
    const reason = traced?.reason ?? settle?.errorMessage ?? undefined;
    const fields: RowField[] = [{ key: "code", value: code, source: "seller" }];
    if (reason !== undefined) fields.push({ key: "reason", value: reason, source: "seller" });
    if (traced?.requested !== undefined) {
      fields.push({
        key: "asked",
        value: this.amount(traced.requested, option) ?? traced.requested,
        source: "seller",
      });
    }
    const max = this.uptoMax();
    if (max !== undefined) fields.push({ key: "your cap", value: max, source: "you" });
    fields.push({
      key: "moved",
      value:
        this.facts.txs.length === 0
          ? "nothing: no transaction"
          : `${String(this.facts.txs.length)} transaction(s)`,
      source: "chain",
    });
    return {
      id: "settle-refused",
      lane: { self: LANE.http.rail },
      label: "Refused at /settle",
      sub: code,
      status: "error",
      source: "seller",
      step: "overcharge-refused",
      fields,
      doc: DOCS.uptoContract,
    };
  }

  private submitRow(): Row | undefined {
    const proven = settlementTx(this.facts);
    const tx = proven ?? this.facts.txs[0];
    if (tx === undefined) return undefined;
    const upto = tx.x402Shape === "upto";
    const fields = this.txFields(tx);
    const moved = tx.transfers[0];
    if (proven === undefined) {
      // The seller reported a transaction the chain does not show settling this payment.
      fields.unshift({
        key: "this payment",
        value: "not proven: the transaction did not consume this payment's nonce with its amount",
        source: "chain",
      });
      return {
        id: `submit-${tx.hash}`,
        lane: this.arrow("rail", "stellar"),
        label: "Reported transaction",
        sub: "seller-reported hash, not proven for this payment",
        status: "error",
        source: "chain",
        step: "submit",
        fields,
        doc: DOCS.receipts,
      };
    }
    return {
      id: `submit-${tx.hash}`,
      lane: this.arrow("rail", "stellar"),
      label: upto ? "upto contract settles" : "Transaction submitted",
      sub: upto
        ? `transfers ${moved === undefined ? "the usage" : this.transferAmount(moved)}${
            tx.uptoSettled === null ? "; no upto_settled event was read" : ", emits upto_settled"
          }`
        : tx.feeBump === null
          ? `ledger ${String(tx.ledger)}`
          : "fee paid by the facilitator",
      status: tx.status === "SUCCESS" ? "done" : "error",
      source: "chain",
      step: "submit",
      fields,
      doc: upto ? DOCS.uptoContract : DOCS.feeSponsorship,
    };
  }

  private deliverRow(exchange: Exchange): Row | undefined {
    const { response, failure } = exchange;
    if (failure !== undefined) {
      return {
        id: `deliver-${failure.id}`,
        lane: this.arrow("seller", "buyer"),
        label: "No answer",
        sub: failure.code,
        status: "error",
        source: "you",
        step: "deliver",
        fields: this.failureFields(failure),
        doc: DOCS.errorCodes,
      };
    }
    if (response === undefined) return undefined;
    const paid = paidAmount(this.facts);
    const paidText =
      paid === undefined
        ? undefined
        : `${this.amount(paid.atomic) ?? paid.atomic}${paid.proven ? "" : " (reported)"}`;
    const released = sdkEvents(this.facts, "released").find((event) => event.reason === "settled_below_cap");
    const expired = sdkEvents(this.facts, "released").find((event) => event.reason === "expired_unused");
    const unresolved = sdkEvents(this.facts, "unresolved")[0];
    const refusal = this.facts.refusals.find(
      (item) => item.layer === "seller" || item.layer === "facilitator",
    );
    const delivery = this.facts.delivery;
    const settle = settleOf(exchange);
    const ok = this.mcp
      ? response.rpc?.isError !== true && delivery?.isError !== true && settle?.success !== false
      : response.status >= 200 && response.status < 300;
    const fields: RowField[] = [
      this.mcp
        ? { key: "result", value: ok ? "tool result" : "error", source: "you" }
        : { key: "status", value: String(response.status), source: "you" },
    ];
    if (settle !== undefined) {
      fields.push({
        key: settle.from === "mcp-meta" ? "_meta payment-response" : "PAYMENT-RESPONSE",
        value: settle.success
          ? `success${settle.transaction === null ? "" : `, tx ${short(settle.transaction, 6)}`}`
          : `failed: ${settle.errorReason ?? "no reason"}`,
        source: "seller",
      });
    }
    if (paidText !== undefined) {
      fields.push({ key: "settled", value: paidText, source: paid?.proven === true ? "chain" : "seller" });
    }
    if (ok) fields.push({ key: "on chain", value: this.onChainText(), source: "chain" });
    if (released !== undefined) {
      fields.push({
        key: "released",
        value: `${this.amount(released.amount) ?? released.amount} back in your budget`,
        source: "you",
      });
    }
    if (refusal !== undefined && !ok) {
      fields.push({ key: "code", value: refusal.code, source: "seller" });
      const upstream = detailText(refusal.details, "upstream", "code");
      if (upstream !== undefined) fields.push({ key: "upstream code", value: upstream, source: "seller" });
    }
    if (expired !== undefined) {
      fields.push({
        key: "hold",
        value: `${this.amount(expired.amount) ?? expired.amount} back in your budget: the authorization expired unused${
          this.facts.auth === undefined ? "" : ` (ledger ${String(this.facts.auth.expirationLedger)})`
        }`,
        source: "you",
      });
    } else if (unresolved !== undefined) {
      fields.push({
        key: "hold",
        value: `${unresolved.code}: kept until the authorization expires`,
        source: "you",
      });
    }
    if (delivery !== undefined) fields.push(...bodyFields(delivery));
    fields.push({ key: "time", value: duration(response.ms), source: "you" });
    const receiptText = paidText === undefined ? undefined : `receipt for ${paidText}`;
    return {
      id: `deliver-${response.id}`,
      lane: this.arrow("seller", "buyer"),
      label: this.mcp
        ? ok
          ? "Tool result + receipt"
          : "Tool error"
        : ok
          ? `${String(response.status)} OK${settle === undefined ? "" : " + PAYMENT-RESPONSE"}`
          : `${String(response.status)} ${statusText(response.status)}`,
      sub: ok
        ? receiptText === undefined
          ? this.mcp
            ? "the tool's result"
            : "the response"
          : `${this.mcp ? "result" : "response"} + ${receiptText}`
        : (refusal?.code ?? settle?.errorReason ?? "payment rejected"),
      status: ok ? "done" : "error",
      source: ok ? "you" : "seller",
      step: "deliver",
      fields,
      doc: ok ? DOCS.receipts : DOCS.errorCodes,
    };
  }

  /** Whether the chain proves this run's payment: the settlement bound to its nonce and amount. */
  private onChainText(): string {
    const proven = settlementTx(this.facts);
    if (proven !== undefined) return `verified ✓ (ledger ${String(proven.ledger)})`;
    const receipt = this.facts.delivery?.receipt;
    if (
      this.facts.txs.length > 0 ||
      (receipt !== null && receipt !== undefined && receipt.transaction !== null)
    )
      return "seller-reported hash, not proven for this payment";
    return ended(this.facts) ? "not proven" : "checking…";
  }

  private resendRow(exchange: Exchange): Row {
    const signed = sdkEvents(this.facts, "signed").length;
    return {
      id: `resend-${exchange.request.id}`,
      lane: this.arrow("buyer", "seller"),
      label: "Same PAYMENT-SIGNATURE again",
      sub: "a copy of the first payment",
      status: this.exchangeStatus(exchange),
      source: "you",
      step: "resend",
      fields: [
        { key: "headers", value: namesText(exchange.request.headerNames), source: "you" },
        { key: "payload", value: "identical to the first (not shown)", source: "you" },
        { key: "signed in this run", value: `${String(signed)} authorization(s)`, source: "you" },
        ...(exchange.failure === undefined ? [] : this.failureFields(exchange.failure)),
      ],
      doc: DOCS.idempotency,
    };
  }

  private replayRefusedRow(exchange: Exchange): Row | undefined {
    const response = exchange.response;
    if (response === undefined) return undefined;
    const error = response.required?.error ?? null;
    const first = settlementTx(this.facts) ?? this.facts.txs[0];
    const fields: RowField[] = [{ key: "status", value: String(response.status), source: "seller" }];
    if (error !== null) fields.push({ key: "error", value: error, source: "seller" });
    if (first !== undefined) {
      fields.push({ key: "first payment", value: `tx ${short(first.hash, 6)}`, source: "chain" });
    }
    fields.push({ key: "time", value: duration(response.ms), source: "you" });
    const refused = response.status === 402;
    return {
      id: `replay-${response.id}`,
      lane: this.arrow("seller", "buyer"),
      label: refused
        ? "402 · the copy is refused"
        : `${String(response.status)} ${statusText(response.status)}`,
      sub: error ?? (refused ? "payment required again" : ""),
      status: refused ? "error" : "done",
      source: "seller",
      step: "replay-refused",
      fields,
      doc: DOCS.verificationRules,
    };
  }

  private chargedOnceRow(): Row | undefined {
    // The balance read around the resend, once it exists: the first read is the first payment's.
    const balance = this.facts.payerBalances.length >= 2 ? this.facts.payerBalances.at(-1) : undefined;
    if (balance === undefined && !ended(this.facts)) return undefined;
    const nonce = this.facts.auth?.nonce;
    const forNonce =
      nonce === undefined ? this.facts.txs : this.facts.txs.filter((tx) => tx.nonces.includes(nonce));
    // The run reads the transactions it was told about, not every transaction on chain: the balance
    // read around the resend is the independent evidence.
    const fields: RowField[] = [
      {
        key: "transactions read",
        value:
          forNonce.length === 1 && forNonce[0] !== undefined
            ? `1 for this nonce (${short(forNonce[0].hash, 6)}); Soroban accepts a nonce once`
            : `${String(forNonce.length)} for this nonce`,
        source: "chain",
      },
    ];
    const { symbol, decimals } = this.context.asset;
    const delta = balance === undefined ? undefined : decimalDelta(balance.before, balance.after, decimals);
    const moved = delta === undefined ? undefined : toAtomic(delta, decimals);
    if (balance !== undefined) {
      fields.push({
        key: "your balance around the resend",
        value: `${balance.before ?? "none"} → ${balance.after ?? "none"} ${symbol}${
          delta === undefined ? "" : ` (${signedAmount(delta, symbol)})`
        }`,
        source: "chain",
      });
    }
    fields.push({
      key: "signed",
      value: `${String(sdkEvents(this.facts, "signed").length)} authorization(s)`,
      source: "you",
    });
    const once = forNonce.length === 1 && (moved === undefined || moved === 0n);
    return {
      id: "charged-once",
      lane: { self: LANE.http.you },
      label:
        forNonce.length !== 1
          ? `Charged ${String(forNonce.length)} times`
          : moved !== undefined && moved !== 0n
            ? "Charged again"
            : "Charged once",
      sub:
        moved !== undefined && moved !== 0n
          ? "your balance moved on the resend"
          : moved === undefined
            ? "one transaction read for this nonce"
            : "your balance did not move on the resend",
      status: once ? "done" : "error",
      source: "chain",
      step: "charged-once",
      fields,
      doc: DOCS.verificationRules,
    };
  }

  // ---------------------------------------------------------------- Sell: catalog, origin check, search

  private sellRows(paid: Exchange): Row[] {
    const outcome = paid.response?.trace?.bazaar;
    if (outcome === undefined) return [];
    const rows: Row[] = [];
    const listing = this.facts.listing;
    const catalogFields: RowField[] = [
      { key: "outcome", value: `${outcome.status} · ${outcome.code}`, source: "seller" },
    ];
    if (outcome.reason !== undefined)
      catalogFields.push({ key: "reason", value: outcome.reason, source: "seller" });
    if (listing !== undefined) catalogFields.push(...listingFields(listing));
    else if (outcome.listingId !== undefined)
      catalogFields.push({ key: "listing", value: outcome.listingId, source: "seller" });
    const rejected = outcome.status === "rejected";
    rows.push({
      id: "catalog",
      lane: this.arrow("rail", "bazaar"),
      label: "Catalog the route",
      sub: rejected ? `not cataloged: ${outcome.code}` : "from the settled payment",
      status: rejected ? "error" : listing !== undefined ? "done" : this.openStatus(),
      source: listing === undefined ? "seller" : "bazaar",
      step: "catalog",
      fields: catalogFields,
      doc: DOCS.cataloging,
    });
    if (rejected) return rows;

    const firstHand = outcome.code !== "recorded";
    // The latest check: versions are listed oldest first.
    const origin = this.facts.versions?.versions
      .filter((version) => version.cause === "origin_verification")
      .reduce<VersionView | undefined>(
        (latest, version) => (latest === undefined || version.version > latest.version ? version : latest),
        undefined,
      );
    const newCheck = origin !== undefined && origin.version > (outcome.version ?? 0);
    const originFields: RowField[] = [];
    if (origin !== undefined) {
      originFields.push(
        { key: "version", value: String(origin.version), source: "bazaar" },
        { key: "checked at", value: origin.createdAt, source: "bazaar" },
        { key: "state", value: origin.state, source: "bazaar" },
        { key: "trust", value: trustLabel(origin.trust), source: "bazaar" },
      );
      if (origin.reason !== null)
        originFields.push({ key: "reason", value: origin.reason, source: "bazaar" });
    }
    if (origin !== undefined || this.facts.versions !== undefined || ended(this.facts)) {
      originFields.push({
        key: "this run",
        value: !firstHand
          ? "checked when the route was listed; unchanged since"
          : newCheck
            ? "created or changed the listing, so the check ran after this payment"
            : "created or changed the listing; no check after this payment was recorded yet",
        source: "seller",
      });
    }
    rows.push({
      id: "origin-check",
      lane: this.arrow("rail", "seller"),
      label: "Origin check",
      sub:
        origin === undefined
          ? firstHand
            ? "waiting for the catalog to call the route"
            : "no check recorded"
          : firstHand && !newCheck
            ? "no check after this payment yet"
            : firstHand
              ? `the route asks the same price: ${origin.state}`
              : "checked when the route was listed; unchanged since",
      status:
        origin !== undefined && (!firstHand || newCheck)
          ? origin.state === "quarantined"
            ? "error"
            : "done"
          : this.openStatus(),
      source: "bazaar",
      step: "origin-check",
      fields: originFields,
      doc: DOCS.listingTrust,
    });

    const search = this.facts.searches.at(-1);
    if (search !== undefined) {
      const id = outcome.listingId ?? listing?.id;
      const hit = search.top.find((item) => item.id === id);
      rows.push({
        id: "listed",
        lane: { self: LANE.sell.bazaar },
        label: hit === undefined ? "Not in the results yet" : `Listed · ${trustLabel(hit.trust)}`,
        sub:
          hit === undefined
            ? `“${search.query}”: ${String(search.count)} results`
            : `rank ${String(hit.rank ?? "?")} for “${search.query}”`,
        status: hit === undefined ? "pending" : "done",
        source: "bazaar",
        step: "listed",
        fields: [
          { key: "search", value: `“${search.query}”`, source: "you" },
          { key: "results", value: String(search.count), source: "bazaar" },
          ...(search.method === null
            ? []
            : [{ key: "ranking", value: search.method, source: "bazaar" as const }]),
          ...(hit === undefined
            ? []
            : [
                { key: "rank", value: String(hit.rank ?? "?"), source: "bazaar" as const },
                { key: "trust", value: trustLabel(hit.trust), source: "bazaar" as const },
              ]),
        ],
        doc: DOCS.search,
      });
    }
    return rows;
  }

  // ---------------------------------------------------------------- Agent: rail402-mcp tools

  agentRows(): Row[] {
    const search = this.tool("search_stellar_resources");
    const budget = this.tool("get_budget");
    const pay = this.tool("pay_and_call");
    const rows: (Row | undefined)[] = [
      search === undefined ? undefined : this.searchToolRow(search),
      search?.result === undefined ? undefined : this.resultsRow(search),
      pay === undefined ? undefined : this.pickRow(pay),
      budget === undefined ? undefined : this.budgetRow(budget),
      pay === undefined ? undefined : this.callToolRow(pay),
      this.toolSettleRow(),
      pay?.result === undefined ? undefined : this.toolResultRow(pay),
    ];
    return rows.filter((row): row is Row => row !== undefined);
  }

  private tool(name: ToolExchange["name"]): ToolExchange | undefined {
    return this.facts.tools.find((tool) => tool.name === name);
  }

  private searchToolRow(tool: ToolExchange): Row {
    const args = tool.call.args;
    const query = str(args, "query") ?? "";
    const fields: RowField[] = [{ key: "query", value: query, source: "you" }];
    const type = str(args, "type");
    if (type !== undefined) fields.push({ key: "type", value: type, source: "you" });
    const maxAmount = str(args, "maxPrice", "amount");
    if (maxAmount !== undefined) {
      fields.push({
        key: "max price",
        value: `${maxAmount} ${str(args, "maxPrice", "asset") ?? ""}`.trim(),
        source: "you",
      });
    }
    return {
      id: "search",
      lane: this.arrow("agent", "bazaar"),
      label: "search_stellar_resources",
      sub: `“${query}”`,
      status: tool.result === undefined ? this.openStatus() : "done",
      source: "you",
      step: "search",
      fields,
      doc: DOCS.search,
    };
  }

  private resultsRow(tool: ToolExchange): Row | undefined {
    const result = tool.result;
    if (result === undefined) return undefined;
    if (result.isError || bool(result.result, "ok") === false) {
      const code = str(result.result, "error", "code") ?? "search_failed";
      return {
        id: "results",
        lane: this.arrow("bazaar", "agent"),
        label: "Search failed",
        sub: code,
        status: "error",
        source: "bazaar",
        step: "results",
        fields: [
          { key: "code", value: code, source: "bazaar" },
          { key: "reason", value: str(result.result, "error", "reason") ?? "", source: "bazaar" },
        ],
        doc: DOCS.search,
      };
    }
    const event = this.facts.searches[0];
    const top: readonly ListingView[] = event?.top ?? [];
    const count = event?.count ?? list(result.result, "results").length;
    const fields: RowField[] = [];
    if (event?.method !== null && event?.method !== undefined)
      fields.push({ key: "ranking", value: event.method, source: "bazaar" });
    if (event?.partialResults === true) fields.push({ key: "partial", value: "yes", source: "bazaar" });
    top.slice(0, 3).forEach((item, index) => {
      fields.push({
        key: `#${String(item.rank ?? index + 1)}`,
        value: `${listingName(item)} · ${priceText(item)} · ${trustLabel(item.trust)}${item.callable === false ? " · not callable" : ""}`,
        source: "bazaar",
      });
    });
    const best = top[0];
    return {
      id: "results",
      lane: this.arrow("bazaar", "agent"),
      label: `${String(count)} ${count === 1 ? "match" : "matches"}`,
      sub:
        best === undefined
          ? "nothing found"
          : `best: ${listingName(best)}${best.price === null ? "" : ` (${best.price.scheme})`}`,
      status: count === 0 ? "error" : "done",
      source: "bazaar",
      step: "results",
      fields,
      doc: DOCS.search,
    };
  }

  private pickRow(pay: ToolExchange): Row | undefined {
    const listingId = str(pay.call.args, "listingId");
    if (listingId === undefined) return undefined;
    const picked = this.facts.searches[0]?.top.find((item) => item.id === listingId);
    const rule = SCENARIO_DEFAULTS.agent;
    const fields: RowField[] = [
      {
        key: "rule",
        value: `first result that is callable, within policy, trust ≥ ${trustLabel(rule.minimumTrust)}, tool ${rule.toolName}, served by the demo seller`,
        source: "you",
      },
      { key: "listing", value: short(listingId, 8), source: "you" },
    ];
    if (picked !== undefined) {
      fields.push(
        { key: "price", value: priceText(picked), source: "bazaar" },
        { key: "trust", value: trustLabel(picked.trust), source: "bazaar" },
      );
    }
    return {
      id: "pick",
      lane: { self: LANE.agent.agent },
      label: "Pick the best match",
      sub:
        picked === undefined ? short(listingId, 8) : `${listingName(picked)} · ${trustLabel(picked.trust)}`,
      status: "done",
      source: "you",
      step: "pick",
      fields,
      doc: DOCS.search,
    };
  }

  private budgetRow(tool: ToolExchange): Row {
    const result = tool.result?.result;
    const perCall = str(result, "policy", "assets", 0, "perCallCap");
    const sessionCap = str(result, "policy", "assets", 0, "sessionCap");
    const spent = str(result, "budget", "assets", 0, "spent");
    const remaining = str(result, "budget", "assets", 0, "remaining");
    const symbol = str(result, "policy", "assets", 0, "asset") ?? this.context.asset.symbol;
    const fields: RowField[] = [];
    if (perCall !== undefined) fields.push({ key: "per call", value: `${perCall} ${symbol}`, source: "you" });
    if (sessionCap !== undefined)
      fields.push({ key: "session", value: `${sessionCap} ${symbol}`, source: "you" });
    if (spent !== undefined) fields.push({ key: "spent", value: `${spent} ${symbol}`, source: "you" });
    if (remaining !== undefined) fields.push({ key: "left", value: `${remaining} ${symbol}`, source: "you" });
    const payments = str(result, "payments");
    if (payments !== undefined) fields.push({ key: "payments", value: payments, source: "you" });
    return {
      id: "budget",
      lane: { self: LANE.agent.agent },
      label: "Budget check",
      sub:
        perCall !== undefined && remaining !== undefined
          ? `cap ${perCall} per call · ${remaining} left`
          : tool.result === undefined
            ? "reading the budget"
            : "budget read",
      status: tool.result === undefined ? this.openStatus() : tool.result.isError ? "error" : "done",
      source: "you",
      step: "budget",
      fields,
      doc: DOCS.agentLimits,
    };
  }

  private callToolRow(pay: ToolExchange): Row {
    const args = pay.call.args;
    const toolArgs = at(args, "arguments");
    const { unpaid, paid } = toolCallExchanges(this.facts);
    const fields: RowField[] = [];
    const picked = this.facts.searches[0]?.top.find((item) => item.id === str(args, "listingId"));
    if (picked?.toolName !== null && picked?.toolName !== undefined)
      fields.push({ key: "tool", value: picked.toolName, source: "bazaar" });
    fields.push({ key: "arguments", value: inline(toolArgs), source: "you" });
    const capAmount = str(args, "spendingCap", "amount");
    if (capAmount !== undefined) {
      fields.push({
        key: "spending cap",
        value: `${capAmount} ${str(args, "spendingCap", "asset") ?? ""}`.trim(),
        source: "you",
      });
    }
    if (unpaid !== undefined) {
      const required = unpaid.response?.rpc?.required ?? null;
      const option = required?.options[0];
      fields.push({
        key: "1. tools/call",
        value:
          option === undefined
            ? unpaid.response === undefined
              ? "sent, unpaid"
              : "answered"
            : `payment required: ${option.scheme === "upto" ? "up to " : ""}${this.optionAmount(option)}`,
        source: "seller",
      });
    }
    if (this.facts.auth !== undefined || sdkEvents(this.facts, "signed").length > 0) {
      fields.push({ key: "2. signature", value: "one authorization, within the cap", source: "you" });
    }
    if (paid !== undefined) {
      fields.push({
        key: "3. tools/call",
        value: paid.response === undefined ? "sent with payment" : "sent with payment, answered",
        source: "you",
      });
    }
    const failed = pay.result?.isError === true || bool(pay.result?.result, "ok") === false;
    return {
      id: "call-tool",
      lane: this.arrow("agent", "tool"),
      label: "pay_and_call",
      sub: toolArgs === undefined ? "402 → sign → retry, handled for you" : inline(toolArgs, 40),
      status: failed ? "error" : pay.result === undefined ? this.openStatus() : "done",
      source: "you",
      step: "call-tool",
      fields,
      doc: DOCS.mcpServer,
    };
  }

  private toolSettleRow(): Row | undefined {
    const { paid } = toolCallExchanges(this.facts);
    const settle = paid?.response?.rpc?.settle ?? null;
    if (settle === null) return undefined;
    const tx = settlementTx(this.facts);
    const amountText = settle.amount === null ? undefined : this.amount(settle.amount);
    const fields: RowField[] = [
      {
        key: "reported",
        value: settle.success ? "success" : `failed: ${settle.errorReason ?? "no reason"}`,
        source: "seller",
      },
    ];
    if (amountText !== undefined) fields.push({ key: "charged", value: amountText, source: "seller" });
    if (settle.transaction !== null)
      fields.push({ key: "transaction", value: short(settle.transaction, 6), source: "seller" });
    if (tx !== undefined) fields.push(...this.txFields(tx));
    return {
      id: "tool-settle",
      lane: this.arrow("tool", "rail"),
      label: amountText === undefined ? "settle" : `settle ${amountText}`,
      sub: settle.success
        ? tx === undefined
          ? "reported in the result's _meta"
          : "proven on chain"
        : (settle.errorReason ?? "failed"),
      status: settle.success ? "done" : "error",
      source: tx === undefined ? "seller" : "chain",
      step: "tool-settle",
      fields,
      doc: DOCS.facilitator,
    };
  }

  private toolResultRow(pay: ToolExchange): Row | undefined {
    const result = pay.result;
    if (result === undefined) return undefined;
    const value = result.result;
    if (result.isError || bool(value, "ok") === false) {
      const code = str(value, "error", "code") ?? "tool_failed";
      return {
        id: "tool-result",
        lane: this.arrow("tool", "agent"),
        label: "Tool call failed",
        sub: code,
        status: "error",
        source: "you",
        step: "tool-result",
        fields: [
          { key: "code", value: code, source: "you" },
          { key: "reason", value: str(value, "error", "reason") ?? "", source: "you" },
        ],
        doc: DOCS.errorCodes,
      };
    }
    const fields: RowField[] = [];
    const settled = str(value, "payment", "settled", "amount");
    const symbol = str(value, "payment", "asset") ?? this.context.asset.symbol;
    if (settled !== undefined) fields.push({ key: "charged", value: `${settled} ${symbol}`, source: "you" });
    const transaction = str(value, "payment", "transaction");
    if (transaction !== undefined)
      fields.push({ key: "transaction", value: short(transaction, 6), source: "you" });
    const verified = bool(value, "payment", "verifiedOnChain");
    if (verified !== undefined)
      fields.push({ key: "on chain", value: verified ? "verified ✓" : "not proven", source: "chain" });
    const structured = at(value, "response", "structuredContent");
    if (structured !== undefined) fields.push({ key: "result", value: inline(structured), source: "seller" });
    const remaining = str(value, "budget", "assets", 0, "remaining");
    if (remaining !== undefined)
      fields.push({ key: "budget left", value: `${remaining} ${symbol}`, source: "you" });
    return {
      id: "tool-result",
      lane: this.arrow("tool", "agent"),
      label: "Result + receipt",
      sub: settled === undefined ? "structured result" : `structured result, paid ${settled} ${symbol}`,
      status: "done",
      source: "you",
      step: "tool-result",
      fields,
      doc: DOCS.mcpServer,
    };
  }

  // ---------------------------------------------------------------- helpers

  private arrow(from: LaneName, to: LaneName): RowLane {
    return { from: this.laneIndex(from), to: this.laneIndex(to) };
  }

  private laneIndex(name: LaneName): number {
    switch (this.scenario) {
      case "agent":
        return name === "agent" || name === "buyer"
          ? LANE.agent.agent
          : name === "bazaar"
            ? LANE.agent.bazaar
            : name === "tool" || name === "seller"
              ? LANE.agent.tool
              : LANE.agent.rail;
      case "sell":
        return name === "buyer" || name === "agent"
          ? LANE.sell.buyer
          : name === "seller" || name === "tool"
            ? LANE.sell.api
            : name === "rail"
              ? LANE.sell.rail
              : LANE.sell.bazaar;
      case "pay":
      case "upto":
        return name === "buyer" || name === "agent"
          ? LANE.http.you
          : name === "seller" || name === "tool"
            ? LANE.http.seller
            : name === "rail"
              ? LANE.http.rail
              : LANE.http.stellar;
    }
  }

  /** `live` while the run is going, `pending` when it ended before this step finished. */
  private openStatus(): RowStatus {
    return ended(this.facts) ? "pending" : "live";
  }

  private exchangeStatus(exchange: Exchange): RowStatus {
    if (exchange.failure !== undefined) return "error";
    if (exchange.response !== undefined) return "done";
    return this.openStatus();
  }

  private failureFields(failure: Exchange["failure"] & object): RowField[] {
    return [
      { key: "code", value: failure.code, source: "you" },
      { key: "reason", value: failure.reason, source: "you" },
      ...(failure.stage === undefined
        ? []
        : [{ key: "stage", value: failure.stage, source: "you" as const }]),
    ];
  }

  /** The option the buyer took: the first its policy accepted, else the first offered. */
  private chosenOption(probe: Exchange | undefined): OptionView | undefined {
    const options = requiredOf(probe)?.options ?? [];
    return options.find((option) => option.verdict?.acceptable === true) ?? options[0];
  }

  private optionAmount(option: OptionView): string {
    const decimal =
      option.decimal ??
      (option.decimals === null ? null : (toDecimal(option.amount, option.decimals) ?? null));
    return decimal === null ? `${option.amount} base units` : `${decimal} ${option.symbol ?? ""}`.trimEnd();
  }

  private atomicText(option: OptionView): string {
    const decimal =
      option.decimal ??
      (option.decimals === null ? null : (toDecimal(option.amount, option.decimals) ?? null));
    return decimal === null
      ? `${option.amount} base units`
      : `${option.amount} = ${decimal} ${option.symbol ?? ""}`.trimEnd();
  }

  /** Base units as `0.001 USDC` in the option's asset, or the configured one. */
  private amount(atomic: string, option?: OptionView): string | undefined {
    const decimals = option?.decimals ?? this.context.asset.decimals;
    const symbol = option?.symbol ?? this.context.asset.symbol;
    const decimal = toDecimal(atomic, decimals);
    return decimal === undefined ? undefined : `${decimal} ${symbol}`;
  }

  private uptoMax(): string | undefined {
    const auth = this.facts.auth;
    if (auth?.scheme === "upto") return this.amount(auth.terms.maxAmount);
    const { probe } = httpExchanges(this.facts);
    const option = this.chosenOption(probe);
    return option?.scheme === "upto" ? this.optionAmount(option) : undefined;
  }

  /** Whether a requested settlement (base units) is above the signed upto cap. */
  private overCap(requested: string | undefined): boolean {
    const auth = this.facts.auth;
    if (requested === undefined || auth?.scheme !== "upto") return false;
    if (!/^\d+$/.test(requested) || !/^\d+$/.test(auth.terms.maxAmount)) return false;
    return BigInt(requested) > BigInt(auth.terms.maxAmount);
  }

  /**
   * The per-call cap the payment was checked against: the run's, or for the session check the room it
   * left in your window (one price).
   */
  private runCap(): string | null {
    if (this.facts.start?.variant === "session-budget") return SESSION_CHECK_WINDOW.total;
    return this.facts.start?.cap ?? null;
  }

  /** `0.001 ≤ 0.01 ✓`: the price against the run's cap. */
  private capCheck(option: OptionView | undefined): string | undefined {
    const cap = this.runCap();
    if (cap === null || option === undefined) return undefined;
    const decimals = option.decimals ?? this.context.asset.decimals;
    const price = option.decimal ?? toDecimal(option.amount, decimals);
    if (price === undefined) return undefined;
    const order = compareDecimal(price, cap, decimals);
    if (order === undefined) return undefined;
    return order <= 0 ? `${price} ≤ ${cap} ✓` : `${price} > ${cap} ✗`;
  }

  private transferAmount(transfer: TxView["transfers"][number]): string {
    return transfer.decimal === null
      ? `${transfer.amount} base units`
      : `${transfer.decimal} ${transfer.symbol ?? this.context.asset.symbol}`;
  }

  private txFields(tx: TxView): RowField[] {
    const fields: RowField[] = tx.transfers.map((transfer, index) => ({
      key: tx.transfers.length === 1 ? "transfer" : `transfer ${String(index + 1)}`,
      value: `${short(transfer.from)} → ${short(transfer.to)}, ${this.transferAmount(transfer)}`,
      source: "chain" as const,
    }));
    if (tx.feeBump !== null) {
      fields.push({
        key: "fee",
        value: `${tx.feeBump.feeCharged} stroops, paid by ${short(tx.feeBump.feeSource)}${advertisedText(tx.feeSourceAdvertised)}`,
        source: "chain",
      });
    }
    if (tx.uptoSettled !== null) {
      fields.push({
        key: "upto_settled",
        value: `${this.amount(tx.uptoSettled.amount) ?? tx.uptoSettled.amount}${
          tx.uptoSettled.maxAmount === null
            ? ""
            : ` of ${this.amount(tx.uptoSettled.maxAmount) ?? tx.uptoSettled.maxAmount}`
        }`,
        source: "chain",
      });
    }
    if (tx.nonces.length > 0)
      fields.push({
        key: "nonce used",
        value: tx.nonces.map((nonce) => short(nonce, 6)).join(", "),
        source: "chain",
      });
    fields.push(
      { key: "ledger", value: String(tx.ledger), source: "chain" },
      { key: "status", value: tx.status, source: "chain" },
      { key: "transaction", value: short(tx.hash, 6), source: "chain" },
    );
    return fields;
  }
}

type LaneName = "buyer" | "seller" | "rail" | "stellar" | "agent" | "bazaar" | "tool";

function viaText(via: "relay" | "direct"): string {
  return via === "relay" ? "the Playground relay" : "directly (same origin)";
}

function namesText(names: readonly string[]): string {
  return names.length === 0 ? "none" : names.join(", ");
}

function advertisedText(advertised: boolean | null): string {
  return advertised === true
    ? " · advertised in /supported ✓"
    : advertised === false
      ? " · not in /supported ✗"
      : "";
}

function layerText(layer: string): string {
  switch (layer) {
    case "policy":
      return "your spending policy";
    case "guard":
      return "the signing guard";
    case "relay":
      return "the Playground relay";
    case "playground":
      return "the Playground";
    default:
      return layer;
  }
}

/** A string or number at a path of a refusal's details. */
function detailText(details: JsonValue | undefined, ...path: readonly string[]): string | undefined {
  const text = str(details, ...path);
  if (text !== undefined) return text;
  const number = num(details, ...path);
  return number === undefined ? undefined : String(number);
}

/** Most characters of a delivered body a row field shows; the Pay page shows all of it. */
const BODY_FIELD_CHARS = 300;

/** The delivered body, as the row's inspector shows it: its type and text, untrusted. */
function bodyFields(delivery: DeliveryView): RowField[] {
  const fields: RowField[] = [];
  if (delivery.contentType !== null)
    fields.push({ key: "content type", value: delivery.contentType, source: "seller" });
  if (delivery.body !== null) {
    const cut = delivery.truncated || delivery.body.length > BODY_FIELD_CHARS;
    fields.push({
      key: "body",
      value: `${delivery.body.slice(0, BODY_FIELD_CHARS)}${cut ? "…" : ""}`,
      source: "seller",
    });
  } else fields.push({ key: "body", value: "empty", source: "seller" });
  return fields;
}

function listingName(listing: ListingView): string {
  if (listing.toolName !== null) return listing.toolName;
  return `${listing.method ?? "GET"} ${pathAndQuery(listing.resource)}`;
}

function priceText(listing: ListingView): string {
  const price = listing.price;
  if (price === null) return "price unknown";
  const amount =
    price.decimal === null
      ? `${price.amount} base units`
      : `${price.decimal} ${price.symbol ?? ""}`.trimEnd();
  return price.scheme === "upto" ? `up to ${amount}` : amount;
}

function listingFields(listing: ListingView): RowField[] {
  return [
    { key: "listing", value: listing.id, source: "bazaar" },
    { key: "owner", value: short(listing.owner), source: "bazaar" },
    { key: "state", value: listing.state ?? "unknown", source: "bazaar" },
    { key: "trust", value: trustLabel(listing.trust), source: "bazaar" },
    { key: "version", value: String(listing.version), source: "bazaar" },
    { key: "settlements", value: String(listing.settlements), source: "bazaar" },
  ];
}

const STATUS_TEXT: Readonly<Record<number, string>> = {
  200: "OK",
  201: "Created",
  204: "No Content",
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

export function statusText(status: number): string {
  return STATUS_TEXT[status] ?? "";
}

export { listingName, priceText };
