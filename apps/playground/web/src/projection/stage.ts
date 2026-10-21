/**
 * The Lab's stage, projected from a run's events only: the lanes, one step per message in causal
 * order (with the steps still to come as placeholders while the run goes), and for each step a short
 * label for its arrow, a plain title, one sentence on what happened and a few key facts.
 *
 * HTTP payments reuse the swimlane rows (projectRows), which already order the messages and judge
 * what the chain proves; the agent's tool calls are split into the payment's own messages here. Every
 * number shown comes from an event: a quote, the signer, the seller's trace or response, or a chain
 * read. Nothing is assumed.
 */
import type { JsonValue, LabEvent, OptionView, TxView } from "../engine/events.ts";
import type { PublicConfig } from "../engine/types.ts";
import { CHECK_IDS, REPLAY_REFUSAL_CODES, type CheckId } from "../../../src/shared/lab.ts";
import { DOCS, type DocRef } from "./docs.ts";
import {
  collectFacts,
  facilitatorShown,
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
  displayUrl,
  hostOf,
  pathAndQuery,
  short,
  toDecimal,
} from "./format.ts";
import { at, bool, list, str } from "./json.ts";
import { projectRows, statusText, trustLabel, type Row, type RowLane } from "./rows.ts";
import { sellerLaneFor, type LabMode } from "./targets.ts";

/** What a run plays: a mode's payment, a refusal check, or a refusal after signing. */
export type StagePlan = "normal" | CheckId | "replay" | "overcharge";

export type LaneIcon = "user" | "server" | "rail" | "chain" | "agent" | "grid" | "tool";

export interface StageLane {
  readonly label: string;
  readonly role: string;
  readonly icon: LaneIcon;
  /** The lane's colour on the stage. */
  readonly tone: "you" | "seller" | "rail" | "chain" | "bazaar" | "tool";
}

export type StepState = "pending" | "live" | "done" | "error";

export interface StageFact {
  readonly label: string;
  readonly value: string;
  /** Shown in the code font: addresses, codes, amounts. */
  readonly mono?: boolean;
  /** An https link for the value (an account or transaction in the explorer). */
  readonly href?: string;
}

export type StepKind =
  | "request"
  | "quote"
  | "refused"
  | "sign"
  | "paid"
  | "work"
  | "settle"
  | "overcharge-refused"
  | "submit"
  | "deliver"
  | "resend"
  | "replay-refused"
  | "charged-once"
  | "search"
  | "results"
  | "budget"
  | "call"
  | "other";

export interface StageStep {
  /** Stable while the run grows; placeholders are `plan-<kind>`. */
  readonly id: string;
  readonly kind: StepKind;
  readonly lane: RowLane;
  /** The words on the arrow, or in the pill of a step inside one lane. */
  readonly chip: string;
  /** The step in plain words, for the checklist and the inspector. */
  readonly title: string;
  /** One or two sentences on what happened. */
  readonly explain: string;
  readonly facts: readonly StageFact[];
  /** What came back, as readable key and value pairs (a delivered body or a tool result). */
  readonly result: readonly StageFact[];
  readonly doc: DocRef;
  readonly state: StepState;
  /** A step that has not happened yet. */
  readonly planned: boolean;
}

export interface StageContext {
  readonly mode: LabMode;
  readonly plan: StagePlan;
  readonly config: Pick<PublicConfig, "asset" | "urls" | "lab" | "explorerTemplate">;
  /** The URL the visitor is about to pay, for the seller lane before any event names it. */
  readonly target?: string;
}

export interface StageView {
  readonly mode: LabMode;
  readonly plan: StagePlan;
  readonly lanes: readonly StageLane[];
  /** Every step in order: what happened, then (while the run goes) what is still to come. */
  readonly steps: readonly StageStep[];
  readonly started: boolean;
  readonly ended: boolean;
  /** The seller is the Playground's own (the demo seller or a lab route), which settles through Rail402. */
  readonly ours: boolean;
}

/** The plan a run's start event names: a check, an experiment, or the normal flow. */
export function planOf(variant: string | undefined): StagePlan {
  if (variant === "replay" || variant === "overcharge") return variant;
  if (variant !== undefined && (CHECK_IDS as readonly string[]).includes(variant)) return variant as CheckId;
  return "normal";
}

export function projectStage(events: readonly LabEvent[], context: StageContext): StageView {
  const facts = collectFacts(events);
  const start = facts.start;
  const mode: LabMode =
    start?.scenario === "agent"
      ? "agent"
      : start !== undefined
        ? (flowScheme(facts) ??
          (start.scenario === "upto" ? "upto" : context.mode === "agent" ? "exact" : context.mode))
        : context.mode;
  const plan = start === undefined ? context.plan : planOf(start.variant);
  const builder = new StageBuilder(events, facts, context, mode);
  const real = start === undefined ? [] : mode === "agent" ? builder.agentSteps() : builder.httpSteps();
  const ended = facts.end !== undefined;
  const steps = ended ? real : withPlaceholders(real, planKinds(mode, plan), builder);
  return {
    mode,
    plan,
    lanes: builder.lanes(),
    steps,
    started: start !== undefined,
    ended,
    ours: mode === "agent" || builder.sellerIsOurs(),
  };
}

/** The kinds of step a plan goes through, in order. */
export function planKinds(mode: LabMode, plan: StagePlan): readonly StepKind[] {
  if (mode === "agent") {
    return ["search", "results", "budget", "call", "quote", "sign", "paid", "settle", "submit", "deliver"];
  }
  const exact: readonly StepKind[] = ["request", "quote", "sign", "paid", "settle", "submit", "deliver"];
  const upto: readonly StepKind[] = [
    "request",
    "quote",
    "sign",
    "paid",
    "work",
    "settle",
    "submit",
    "deliver",
  ];
  switch (plan) {
    case "normal":
      return mode === "upto" ? upto : exact;
    case "replay":
      return [...exact, "resend", "replay-refused", "charged-once"];
    case "overcharge":
      return ["request", "quote", "sign", "paid", "work", "settle", "overcharge-refused", "deliver"];
    case "session-budget":
      return [...exact, "refused"];
    case "private-address":
      return ["request"];
    case "network":
    case "asset":
    case "amount":
    case "recipient":
    case "per-call-cap":
      return ["request", "quote", "refused"];
  }
}

/**
 * The steps that happened, with the plan's steps still to come placed where they belong: before the
 * first real step that comes later in the plan, else at the end.
 */
function withPlaceholders(
  real: readonly StageStep[],
  plan: readonly StepKind[],
  builder: StageBuilder,
): readonly StageStep[] {
  const seen = new Set(real.map((step) => step.kind));
  const waiting = plan.map((kind, index) => ({ kind, index })).filter((item) => !seen.has(item.kind));
  const out: StageStep[] = [];
  for (const step of real) {
    const index = plan.indexOf(step.kind);
    if (index >= 0) {
      while (waiting[0] !== undefined && waiting[0].index < index) {
        const next = waiting.shift();
        if (next !== undefined) out.push(builder.placeholder(next.kind));
      }
    }
    out.push(step);
  }
  // Steps of the plan that come before the last real step were skipped (a refusal ends a run early).
  const last = Math.max(-1, ...real.map((step) => plan.indexOf(step.kind)));
  for (const item of waiting) if (item.index > last) out.push(builder.placeholder(item.kind));
  return out;
}

/** The scheme the run quoted or signed, when it got that far. */
function flowScheme(facts: RunFacts): "exact" | "upto" | undefined {
  if (facts.auth !== undefined) return facts.auth.scheme;
  const option = chosenOption(httpExchanges(facts).probe);
  return option?.scheme === "upto" ? "upto" : option?.scheme === "exact" ? "exact" : undefined;
}

/** The option the buyer took: the first its policy accepted, else the first offered. */
function chosenOption(exchange: Exchange | undefined): OptionView | undefined {
  const options = requiredOf(exchange)?.options ?? [];
  return options.find((option) => option.verdict?.acceptable === true) ?? options[0];
}

/** Agent lanes by index. */
const AGENT = Object.freeze({ agent: 0, bazaar: 1, tool: 2, rail: 3, stellar: 4 });
/** HTTP lanes by index (the same as the swimlane rows'). */
const HTTP = Object.freeze({ you: 0, seller: 1, rail: 2, stellar: 3 });

const LAYER_TEXT: Readonly<Record<string, string>> = {
  policy: "your spending policy",
  guard: "the signing guard",
  relay: "the Playground relay",
  playground: "the Playground",
  seller: "the seller",
  facilitator: "the facilitator",
};

export function layerText(layer: string): string {
  return LAYER_TEXT[layer] ?? layer;
}

class StageBuilder {
  private readonly events: readonly LabEvent[];
  private readonly facts: RunFacts;
  private readonly context: StageContext;
  private readonly mode: LabMode;

  constructor(events: readonly LabEvent[], facts: RunFacts, context: StageContext, mode: LabMode) {
    this.events = events;
    this.facts = facts;
    this.context = context;
    this.mode = mode;
  }

  // ---------------------------------------------------------------- lanes and names

  lanes(): readonly StageLane[] {
    const rail: StageLane = { label: this.facilitator(), role: "facilitator", icon: "rail", tone: "rail" };
    const chain: StageLane = { label: "Stellar", role: "testnet", icon: "chain", tone: "chain" };
    if (this.mode === "agent") {
      return [
        { label: "AI agent", role: "rail402-mcp", icon: "agent", tone: "you" },
        { label: "Bazaar", role: "search", icon: "grid", tone: "bazaar" },
        { label: this.toolName() ?? "MCP tool", role: "MCP tool", icon: "tool", tone: "tool" },
        rail,
        chain,
      ];
    }
    const seller = this.seller();
    return [
      { label: "You", role: "your wallet", icon: "user", tone: "you" },
      { label: seller.label, role: seller.role, icon: "server", tone: "seller" },
      rail,
      chain,
    ];
  }

  sellerIsOurs(): boolean {
    return this.seller().ours;
  }

  private seller(): ReturnType<typeof sellerLaneFor> {
    const url = this.facts.exchanges.find((exchange) => exchange.request.rpc === undefined)?.request.url;
    return sellerLaneFor(url ?? this.context.target, this.context.config as PublicConfig);
  }

  /**
   * Rail402 by name only when it is shown to be the seller's facilitator, or the seller is the
   * Playground's own and nothing shows otherwise; any other seller's facilitator is "Facilitator".
   */
  private facilitator(): string {
    if (facilitatorShown(this.facts)) return "Rail402";
    const tx = settlementTx(this.facts);
    if (tx?.feeSourceAdvertised === false) return "Facilitator";
    return this.mode === "agent" || this.seller().ours ? "Rail402" : "Facilitator";
  }

  private toolName(): string | undefined {
    const pay = this.tool("pay_and_call");
    const listingId = pay === undefined ? undefined : str(pay.call.args, "listingId");
    const picked = this.facts.searches[0]?.top.find((item) => item.id === listingId);
    return picked?.toolName ?? this.facts.searches[0]?.top[0]?.toolName ?? undefined;
  }

  /** An MCP tool paid as a URL or listing: its payment travels in `_meta`, not in headers. */
  private get mcp(): boolean {
    return paysMcpTool(this.facts);
  }

  private tool(name: ToolExchange["name"]): ToolExchange | undefined {
    return this.facts.tools.find((tool) => tool.name === name);
  }

  // ---------------------------------------------------------------- amounts

  private get symbol(): string {
    return this.context.config.asset.symbol;
  }

  private get decimals(): number {
    return this.context.config.asset.decimals;
  }

  private get asset(): ResultAsset {
    return { symbol: this.symbol, decimals: this.decimals };
  }

  /** Base units as `0.001 USDC`, in the option's asset when known. */
  private amount(atomic: string | null | undefined, option?: OptionView): string | undefined {
    if (atomic === null || atomic === undefined) return undefined;
    const decimal = toDecimal(atomic, option?.decimals ?? this.decimals);
    return decimal === undefined ? undefined : `${decimal} ${option?.symbol ?? this.symbol}`;
  }

  /** Base units as `0.001`, without the asset. */
  private bare(atomic: string | null | undefined, option?: OptionView): string | undefined {
    if (atomic === null || atomic === undefined) return undefined;
    return toDecimal(atomic, option?.decimals ?? this.decimals);
  }

  private optionAmount(option: OptionView | undefined): string | undefined {
    if (option === undefined) return undefined;
    if (option.decimal !== null) return `${option.decimal} ${option.symbol ?? this.symbol}`;
    return option.decimals === null ? `${option.amount} base units` : this.amount(option.amount, option);
  }

  private optionBare(option: OptionView | undefined): string | undefined {
    if (option === undefined) return undefined;
    return option.decimal ?? (option.decimals === null ? option.amount : this.bare(option.amount, option));
  }

  /** The cap the payment signed (upto), in base units. */
  private signedMax(): string | undefined {
    const auth = this.facts.auth;
    if (auth?.scheme === "upto") return auth.terms.maxAmount;
    if (auth?.scheme === "exact") return auth.transfer.amount;
    return undefined;
  }

  /** The run's per-call cap, decimal. */
  private runCap(): string | undefined {
    return this.facts.start?.cap ?? undefined;
  }

  private tx(): TxView | undefined {
    return settlementTx(this.facts) ?? this.facts.txs[0];
  }

  private link(address: string): string | undefined {
    return addressLink(this.context.config.explorerTemplate, address);
  }

  private payer(): string | undefined {
    const auth = this.facts.auth;
    return auth?.scheme === "exact" ? auth.transfer.from : auth?.address;
  }

  // ---------------------------------------------------------------- HTTP payments

  httpSteps(): StageStep[] {
    const rows = projectRows(this.events, { asset: { symbol: this.symbol, decimals: this.decimals } });
    return rows.map((row) => this.fromRow(row));
  }

  private fromRow(row: Row): StageStep {
    const state: StepState = row.status;
    const base = { id: row.id, lane: row.lane, state, planned: false, result: [] as StageFact[] };
    switch (row.step) {
      case "request":
        return { ...base, ...this.requestStep(row) };
      case "quote":
        return { ...base, ...this.quoteStep() };
      case "refused":
        return { ...base, ...this.refusedStep(row) };
      case "sign":
        return { ...base, ...this.signStep() };
      case "paid-request":
        return { ...base, ...this.paidStep() };
      case "work":
        return { ...base, ...this.workStep() };
      case "settle":
        return { ...base, ...this.settleStep(row) };
      case "overcharge-refused":
        return { ...base, ...this.overchargeStep() };
      case "submit":
        return { ...base, ...this.submitStep(row) };
      case "deliver":
        return { ...base, ...this.deliverStep(row) };
      case "resend":
        return { ...base, ...this.resendStep() };
      case "replay-refused":
        return { ...base, ...this.replayRefusedStep(row) };
      case "charged-once":
        return { ...base, ...this.chargedOnceStep(row) };
      // The agent's own rows are drawn by their own rows' words.
      case "search":
      case "results":
      case "pick":
      case "budget":
      case "call-tool":
      case "tool-settle":
      case "tool-result":
        return {
          ...base,
          kind: "other",
          chip: row.label,
          title: row.label,
          explain: row.sub,
          facts: row.fields
            .slice(0, 4)
            .map((field) => ({ label: capitalize(field.key), value: field.value })),
          doc: row.doc,
        };
    }
  }

  private requestStep(row: Row): StepText {
    const exchange = this.facts.exchanges.find((item) => `request-${item.request.id}` === row.id);
    const request = exchange?.request;
    const url = request?.url ?? "";
    const failure = exchange?.failure;
    // The relay refuses a destination at the URL or DNS stage, before any connection is made.
    const refusedBeforeConnecting = failure?.stage === "url" || failure?.stage === "dns";
    const facts: StageFact[] = [
      { label: "Request", value: `${request?.method ?? "GET"} ${pathAndQuery(url)}`, mono: true },
      { label: "Host", value: hostOf(url), mono: true },
      { label: "Sent via", value: request?.via === "direct" ? "this page" : "the Playground relay" },
    ];
    if (failure !== undefined) facts.push({ label: "Refused with", value: failure.code, mono: true });
    const toolCall = request?.rpc?.method === "tools/call" ? (request.rpc.toolName ?? "tool") : undefined;
    return {
      kind: "request",
      chip:
        toolCall === undefined
          ? `${request?.method ?? "GET"} ${pathAndQuery(url)}`
          : `tools/call ${toolCall}`,
      title:
        failure === undefined
          ? "You ask for the data"
          : refusedBeforeConnecting
            ? "The relay refuses the address"
            : "The call does not get through",
      explain:
        failure === undefined
          ? toolCall === undefined
            ? `A plain ${request?.method ?? "GET"} to ${hostOf(url)}: no API key, no account. A paid API answers with its price.`
            : `The ${toolCall} call goes to ${hostOf(url)} without payment first. A paid tool answers with its price.`
          : refusedBeforeConnecting
            ? `The relay refused to call ${displayUrl(url)} before connecting: ${failure.reason}`
            : `The call to ${displayUrl(url)} failed: ${failure.reason}`,
      facts,
      doc: failure === undefined ? DOCS.x402 : DOCS.egress,
    };
  }

  private quoteStep(): StepText {
    const { probe } = httpExchanges(this.facts);
    const response = probe?.response;
    const required = requiredOf(probe);
    const option = chosenOption(probe);
    // An MCP tool asks for payment in a JSON-RPC error, over an HTTP 200.
    if (response !== undefined && ((!this.mcp && response.status !== 402) || required === undefined)) {
      return {
        kind: "quote",
        chip: `${String(response.status)} ${statusText(response.status)}`.trim(),
        title: "The API answers",
        explain: "It answered without asking for payment, so there is nothing to pay.",
        facts: [{ label: "Status", value: String(response.status), mono: true }],
        doc: DOCS.x402,
      };
    }
    const upto = option?.scheme === "upto";
    const price = this.optionAmount(option) ?? "its price";
    const verdict = option?.verdict;
    const policy =
      verdict === null || verdict === undefined
        ? ""
        : verdict.acceptable
          ? " Your spending policy allows it, so your wallet may sign."
          : ` Your spending policy refuses it (${verdict.code ?? "not acceptable"}), so nothing will be signed.`;
    const facts: StageFact[] = [
      { label: upto ? "Up to" : "Price", value: price, mono: true },
      ...(option === undefined
        ? []
        : [
            {
              label: "Pay to",
              value: short(option.payTo),
              mono: true,
              ...hrefOf(this.link(option.payTo)),
            },
            { label: "Network", value: option.network, mono: true },
          ]),
      {
        label: "Network fee",
        value:
          option?.feesSponsored === true
            ? "paid by the facilitator"
            : option?.feesSponsored === false
              ? "not sponsored"
              : "not stated",
      },
    ];
    if (verdict !== null && verdict !== undefined) {
      facts.splice(3, 1, {
        label: "Your policy",
        value: verdict.acceptable ? "allows it" : `refuses: ${verdict.code ?? "not acceptable"}`,
        mono: !verdict.acceptable,
      });
    }
    return {
      kind: "quote",
      chip: `402 · ${upto ? "up to " : ""}${price}`,
      title: upto ? "The API names its terms" : "The API names its price",
      explain: `${this.mcp ? "It answers with a payment-required error" : "It answers 402 Payment Required"}: ${
        upto ? `it may charge up to ${price}, depending on the work` : `${price}, paid to its Stellar account`
      }.${policy}`,
      facts: facts.slice(0, 4),
      doc: upto ? DOCS.upto : DOCS.architecture,
    };
  }

  private refusedStep(row: Row): StepText {
    const refusal = this.facts.refusals.find(
      (item) => item.layer === "policy" || item.layer === "guard" || item.layer === "playground",
    );
    const code = refusal?.code ?? row.sub;
    const before = row.label === "Refused before signing";
    const signed = sdkEvents(this.facts, "signed").length;
    return {
      kind: "refused",
      chip: before ? "Refused before signing" : "Refused",
      title: before ? "Refused before signing" : "Refused",
      explain: `${refusal?.reason ?? "The payment was refused."}${before ? " Nothing was signed for it, and nothing left your wallet for it." : ""}`,
      facts: [
        { label: "Code", value: code, mono: true },
        { label: "Refused by", value: layerText(refusal?.layer ?? "policy") },
        { label: "Signed", value: signed === 0 ? "nothing" : `${String(signed)} earlier payment` },
        {
          label: "Paid",
          value:
            this.facts.txs.length === 0 ? "nothing" : `${String(this.facts.txs.length)} earlier transaction`,
        },
      ],
      doc: code.startsWith("egress_") ? DOCS.egress : DOCS.spendingPolicy,
    };
  }

  private signStep(): StepText {
    const auth = this.facts.auth;
    const reserved = sdkEvents(this.facts, "reserved")[0];
    const signed = sdkEvents(this.facts, "signed")[0];
    const option = chosenOption(httpExchanges(this.facts).probe);
    const cap = this.runCap();
    const expires =
      auth === undefined
        ? signed === undefined
          ? undefined
          : `ledger ${String(signed.expirationLedger)}`
        : `${auth.expiresInSeconds === null ? "" : `in about ${String(auth.expiresInSeconds)} s · `}ledger ${String(auth.expirationLedger)}`;
    if (auth?.scheme === "upto" || (auth === undefined && option?.scheme === "upto")) {
      const max = auth?.scheme === "upto" ? auth.terms.maxAmount : option?.amount;
      const maxText = this.amount(max, option) ?? "the cap";
      const settler = auth?.scheme === "upto" ? auth.terms.facilitator : option?.facilitatorAddress;
      return {
        kind: "sign",
        chip: `Sign up to ${this.bare(max, option) ?? "the cap"}`,
        title: "Your wallet signs once",
        explain: `Your wallet signs once for at most ${maxText}. The settlement contract can move less, never more, and only ${this.facilitator()} may settle it. The key never leaves this browser.`,
        facts: [
          { label: "At most", value: maxText, mono: true },
          ...(cap === undefined ? [] : [{ label: "Your cap", value: `${cap} ${this.symbol}`, mono: true }]),
          ...(settler === null || settler === undefined
            ? []
            : [{ label: "Only settler", value: short(settler), mono: true, ...hrefOf(this.link(settler)) }]),
          ...(expires === undefined ? [] : [{ label: "Expires", value: expires }]),
        ].slice(0, 4),
        doc: DOCS.uptoContract,
      };
    }
    const amount = auth?.scheme === "exact" ? auth.transfer.amount : option?.amount;
    const amountText = this.amount(amount, option) ?? "the price";
    return {
      kind: "sign",
      chip: `Sign ${this.bare(amount, option) ?? "once"}`,
      title: "Your wallet signs once",
      explain: `Your wallet signs one transfer of exactly ${amountText} to the seller${cap === undefined ? "" : `, after checking it against your ${cap} ${this.symbol} cap`}. The key never leaves this browser.`,
      facts: [
        { label: "Amount", value: amountText, mono: true },
        ...(cap === undefined ? [] : [{ label: "Your cap", value: `${cap} ${this.symbol}`, mono: true }]),
        ...(expires === undefined ? [] : [{ label: "Expires", value: expires }]),
        ...(reserved === undefined
          ? []
          : [
              {
                label: "Held in budget",
                value: this.amount(reserved.amount, option) ?? reserved.amount,
                mono: true,
              },
            ]),
      ].slice(0, 4),
      doc: DOCS.authorization,
    };
  }

  private paidStep(): StepText {
    const { paid } = httpExchanges(this.facts);
    const upto = this.facts.auth?.scheme === "upto";
    const failure = paid?.failure;
    const carrier = this.mcp
      ? { label: "Carries", value: '_meta["x402/payment"]' }
      : { label: "Header", value: "PAYMENT-SIGNATURE" };
    return {
      kind: "paid",
      chip: this.mcp ? "retry + payment" : "retry + signature",
      title: "You retry with the signature",
      explain:
        failure !== undefined
          ? `The paid request did not get an answer: ${failure.reason}`
          : this.mcp
            ? 'The same tool call again, with the signed payment in _meta["x402/payment"]. Only the signature travels; the key stays here.'
            : "The same request again, with the signed payment in the PAYMENT-SIGNATURE header. Only the signature travels; the key stays here.",
      facts: [
        { ...carrier, mono: true },
        {
          label: "Payload",
          value: upto ? "{ authorization, signerAuthorizations }" : "{ transaction }",
          mono: true,
        },
        { label: "Sent via", value: paid?.request.via === "direct" ? "this page" : "the Playground relay" },
        ...(failure === undefined ? [] : [{ label: "Failed with", value: failure.code, mono: true }]),
      ],
      doc: DOCS.x402Headers,
    };
  }

  private workStep(): StepText {
    const { paid } = httpExchanges(this.facts);
    const response = paid?.response;
    const requested =
      response?.trace?.settle?.requested ??
      settleOf(paid)?.amount ??
      response?.trace?.settle?.amount ??
      undefined;
    const max = this.signedMax();
    const charge = this.amount(requested) ?? "its charge";
    const over =
      requested !== undefined &&
      max !== undefined &&
      /^\d+$/.test(requested) &&
      /^\d+$/.test(max) &&
      BigInt(requested) > BigInt(max);
    const untaken =
      requested !== undefined && max !== undefined && !over && /^\d+$/.test(requested) && /^\d+$/.test(max)
        ? this.amount((BigInt(max) - BigInt(requested)).toString())
        : undefined;
    return {
      kind: "work",
      chip: `Charge ${this.bare(requested) ?? "usage"}`,
      title: "The API sets the charge",
      explain: over
        ? `The API asks for ${charge}, more than the ${this.amount(max) ?? "cap"} you signed for. The contract cannot move more than that.`
        : `The API did the work and asks for ${charge}. You signed for at most ${this.amount(max) ?? "your cap"}; more would fail on chain.`,
      facts: [
        { label: "Charge", value: charge, mono: true },
        ...(max === undefined ? [] : [{ label: "Signed for", value: this.amount(max) ?? max, mono: true }]),
        ...(untaken === undefined ? [] : [{ label: "Never taken", value: untaken, mono: true }]),
      ],
      doc: DOCS.meteredPricing,
    };
  }

  private settleStep(row: Row): StepText {
    const { paid } = httpExchanges(this.facts);
    const trace = paid?.response?.trace;
    const settle = settleOf(paid);
    const success = trace?.settle?.success ?? settle?.success;
    const requested = trace?.settle?.requested ?? trace?.settle?.amount ?? settle?.amount ?? undefined;
    const proven = paidAmount(this.facts);
    const tx = settlementTx(this.facts);
    const fac = this.facilitator();
    const upto = this.facts.auth?.scheme === "upto";
    const amountText = this.amount(proven?.atomic ?? requested);
    const facts: StageFact[] = [];
    if (trace?.verify !== undefined) {
      facts.push({
        label: "/verify",
        value: trace.verify.isValid ? "valid" : `invalid: ${trace.verify.code ?? "no code"}`,
        mono: !trace.verify.isValid,
      });
    }
    if (success === false) {
      facts.push(
        { label: "Asked to settle", value: this.amount(requested) ?? "unknown", mono: true },
        {
          label: "Refused with",
          value: trace?.settle?.code ?? settle?.errorReason ?? "settlement failed",
          mono: true,
        },
      );
    } else {
      facts.push({
        label: "Settled",
        value: `${amountText ?? "reported"}${proven?.proven === true ? "" : " (reported)"}`,
        mono: true,
      });
      if (tx?.feeBump !== null && tx?.feeBump !== undefined) {
        facts.push({
          label: "Fee paid by",
          value: `${short(tx.feeBump.feeSource)}${tx.feeSourceAdvertised === true ? " · Rail402" : ""}`,
          mono: true,
          ...hrefOf(this.link(tx.feeBump.feeSource)),
        });
      }
    }
    return {
      kind: "settle",
      chip: upto || success === false ? `/settle ${this.bare(requested) ?? ""}`.trim() : "/verify → /settle",
      title: success === false ? `${fac} refuses to settle` : `${fac} settles it`,
      explain:
        success === false
          ? `The API asked ${fac} to settle ${this.amount(requested) ?? "an amount"}, more than you signed for. ${fac} refused, so nothing was submitted.`
          : `The API hands the signed payment to ${fac}. It checks the signature, amount and nonce, submits it to Stellar and pays the network fee itself.`,
      facts: facts.slice(0, 4),
      doc: row.doc,
    };
  }

  private overchargeStep(): StepText {
    const { paid } = httpExchanges(this.facts);
    const traced = paid?.response?.trace?.settle;
    const settle = settleOf(paid);
    const code = traced?.code ?? settle?.errorReason ?? "settlement_failed";
    const max = this.signedMax();
    return {
      kind: "overcharge-refused",
      chip: "Refused at /settle",
      title: `${this.facilitator()} refuses the overcharge`,
      explain: `${this.facilitator()} refused to settle more than the cap you signed, so no transaction was sent and nothing moved.`,
      facts: [
        { label: "Code", value: code, mono: true },
        ...(traced?.requested === undefined
          ? []
          : [{ label: "Asked", value: this.amount(traced.requested) ?? traced.requested, mono: true }]),
        ...(max === undefined ? [] : [{ label: "Signed for", value: this.amount(max) ?? max, mono: true }]),
        {
          label: "Moved",
          value: this.facts.txs.length === 0 ? "nothing" : `${String(this.facts.txs.length)} transaction`,
        },
      ],
      doc: DOCS.uptoContract,
    };
  }

  private submitStep(row: Row): StepText {
    const tx = this.tx();
    const proven = settlementTx(this.facts) !== undefined;
    const transfer = tx?.transfers[0];
    const amount = transfer === undefined ? undefined : (transfer.decimal ?? undefined);
    const payer = this.payer();
    const feeByOther = tx?.feeBump !== null && tx?.feeBump !== undefined && tx.feeBump.feeSource !== payer;
    const facts: StageFact[] = [];
    if (transfer !== undefined) {
      facts.push(
        { label: "From → to", value: `${short(transfer.from)} → ${short(transfer.to)}`, mono: true },
        {
          label: "Amount",
          value: `${transfer.decimal ?? transfer.amount} ${transfer.symbol ?? this.symbol}`,
          mono: true,
        },
      );
    }
    if (tx !== undefined) {
      if (tx.feeBump !== null)
        facts.push({
          label: "Network fee",
          value: `${tx.feeBump.feeCharged} stroops, not from you`,
          mono: false,
        });
      facts.push({ label: "Transaction", value: short(tx.hash, 6), mono: true, href: tx.explorerUrl });
    }
    return {
      kind: "submit",
      chip: `transfer ${amount ?? ""}`.trim(),
      title: proven ? "The transfer lands" : "The reported transaction is not this payment",
      explain: !proven
        ? "The seller reported a transaction, but the chain does not show it settling this payment."
        : `Stellar moved ${amount === undefined ? "the payment" : `${amount} ${this.symbol}`} from you to the seller in ledger ${String(tx?.ledger ?? "")}${tx?.x402Shape === "upto" ? ", through the settlement contract, which checked it against your cap" : ""}.${feeByOther ? ` The network fee was paid by ${this.facilitator()}, not you.` : ""}`,
      facts: facts.slice(0, 4),
      doc: row.doc,
    };
  }

  private deliverStep(row: Row): StepText {
    const { paid } = httpExchanges(this.facts);
    const response = paid?.response;
    const paidAtomic = paidAmount(this.facts);
    const delivery = this.facts.delivery;
    const released = sdkEvents(this.facts, "released").find((event) => event.reason === "settled_below_cap");
    const ok = row.status !== "error";
    const proven = settlementTx(this.facts) !== undefined;
    const status = response?.status;
    const facts: StageFact[] = [];
    if (status !== undefined)
      facts.push({ label: "Status", value: `${String(status)} ${statusText(status)}`.trim(), mono: true });
    if (paidAtomic !== undefined)
      facts.push({
        label: "Paid",
        value: `${this.amount(paidAtomic.atomic) ?? paidAtomic.atomic}${paidAtomic.proven ? "" : " (reported)"}`,
        mono: true,
      });
    if (ok)
      facts.push({
        label: "On chain",
        value: proven ? "verified" : this.facts.end === undefined ? "checking…" : "not proven",
      });
    if (released !== undefined)
      facts.push({
        label: "Back in budget",
        value: this.amount(released.amount) ?? released.amount,
        mono: true,
      });
    const refusal = this.facts.refusals.find(
      (item) => item.layer === "seller" || item.layer === "facilitator",
    );
    if (!ok && refusal !== undefined) facts.push({ label: "Code", value: refusal.code, mono: true });
    return {
      kind: "deliver",
      chip: ok ? (this.mcp ? "result + receipt" : `${String(status ?? 200)} OK + receipt`) : row.label,
      title: ok ? "You get data + receipt" : "The API does not deliver",
      explain: !ok
        ? `The API did not deliver: ${refusal?.reason ?? row.sub}`
        : proven
          ? `The API returns the data with a receipt for ${this.amount(paidAtomic?.atomic) ?? "the payment"}. The page checked on chain that the transaction used your signature.`
          : "The API returns the data with a receipt; the transaction it names is not proven on chain yet.",
      facts: facts.slice(0, 4),
      result:
        delivery?.body === null || delivery?.body === undefined ? [] : summarize(delivery.body, this.asset),
      doc: row.doc,
    };
  }

  private resendStep(): StepText {
    return {
      kind: "resend",
      chip: "same signature again",
      title: "You send the same payment again",
      explain: "The exact same signed payment is sent a second time, as someone replaying it would.",
      facts: [
        { label: "Header", value: "PAYMENT-SIGNATURE", mono: true },
        { label: "Payload", value: "identical to the first" },
        { label: "New signatures", value: "none" },
      ],
      doc: DOCS.idempotency,
    };
  }

  private replayRefusedStep(row: Row): StepText {
    const { resend } = httpExchanges(this.facts);
    const error = resend?.response?.required?.error ?? null;
    const meaning = error === null ? undefined : REPLAY_REFUSAL_CODES[error];
    return {
      kind: "replay-refused",
      chip: row.status === "error" ? "402 · copy refused" : row.label,
      title: "The copy is refused",
      explain:
        meaning === undefined
          ? "The seller asks for payment again: the copy does not pay twice."
          : `The facilitator refuses the copy: ${meaning}. A signed payment can be used once.`,
      facts: [
        { label: "Status", value: String(resend?.response?.status ?? ""), mono: true },
        ...(error === null ? [] : [{ label: "Code", value: error, mono: true }]),
      ],
      doc: DOCS.verificationRules,
    };
  }

  private chargedOnceStep(row: Row): StepText {
    const balance = this.facts.payerBalances.length >= 2 ? this.facts.payerBalances.at(-1) : undefined;
    const delta =
      balance === undefined ? undefined : decimalDelta(balance.before, balance.after, this.decimals);
    return {
      kind: "charged-once",
      chip: row.label,
      title: "You are charged once",
      explain:
        row.status === "error"
          ? row.sub
          : "Your balance did not move on the second send: one signature, one payment.",
      facts: [
        ...(balance === undefined
          ? []
          : [
              {
                label: "Balance around the copy",
                value: `${balance.before ?? "none"} → ${balance.after ?? "none"}`,
                mono: true,
              },
            ]),
        ...(delta === undefined ? [] : [{ label: "Moved", value: `${delta} ${this.symbol}`, mono: true }]),
        { label: "Signatures", value: String(sdkEvents(this.facts, "signed").length) },
      ],
      doc: DOCS.verificationRules,
    };
  }

  // ---------------------------------------------------------------- the agent's tool calls

  agentSteps(): StageStep[] {
    const steps: (StageStep | undefined)[] = [
      this.searchStep(),
      this.resultsStep(),
      this.budgetStep(),
      ...this.toolPaymentSteps(),
    ];
    return steps.filter((step): step is StageStep => step !== undefined);
  }

  private open(done: boolean): StepState {
    if (done) return "done";
    return this.facts.end === undefined ? "live" : "pending";
  }

  private searchStep(): StageStep | undefined {
    const tool = this.tool("search_stellar_resources");
    if (tool === undefined) return undefined;
    const query = str(tool.call.args, "query") ?? "";
    const max = str(tool.call.args, "maxPrice", "amount");
    const type = str(tool.call.args, "type");
    return {
      id: "search",
      kind: "search",
      lane: { from: AGENT.agent, to: AGENT.bazaar },
      chip: `search: ${query}`,
      title: "Search the Bazaar",
      explain: `The agent calls search_stellar_resources for “${query}”${type === undefined ? "" : `, ${type} tools only`}${max === undefined ? "" : `, priced at most ${max} ${this.symbol}`}.`,
      facts: [
        { label: "Query", value: query },
        ...(type === undefined ? [] : [{ label: "Type", value: type, mono: true }]),
        ...(max === undefined ? [] : [{ label: "Max price", value: `${max} ${this.symbol}`, mono: true }]),
      ],
      result: [],
      doc: DOCS.search,
      state: tool.result === undefined ? this.open(false) : "done",
      planned: false,
    };
  }

  private resultsStep(): StageStep | undefined {
    const tool = this.tool("search_stellar_resources");
    const result = tool?.result;
    if (result === undefined) return undefined;
    if (result.isError || bool(result.result, "ok") === false) {
      const code = str(result.result, "error", "code") ?? "search_failed";
      return {
        id: "results",
        kind: "results",
        lane: { from: AGENT.bazaar, to: AGENT.agent },
        chip: "search failed",
        title: "Pick a tool in budget",
        explain: str(result.result, "error", "reason") ?? "The search failed.",
        facts: [{ label: "Code", value: code, mono: true }],
        result: [],
        doc: DOCS.search,
        state: "error",
        planned: false,
      };
    }
    const event = this.facts.searches[0];
    const count = event?.count ?? list(result.result, "results").length;
    const pay = this.tool("pay_and_call");
    const listingId = pay === undefined ? undefined : str(pay.call.args, "listingId");
    const picked = event?.top.find((item) => item.id === listingId) ?? event?.top[0];
    const price = picked?.price;
    const priceText =
      price === null || price === undefined
        ? undefined
        : `${price.scheme === "upto" ? "up to " : ""}${price.decimal ?? price.amount} ${price.symbol ?? this.symbol}`;
    return {
      id: "results",
      kind: "results",
      lane: { from: AGENT.bazaar, to: AGENT.agent },
      chip: `${String(count)} ${count === 1 ? "tool" : "tools"}${priceText === undefined ? "" : ` · ${priceText}`}`,
      title: "Pick a tool in budget",
      explain:
        picked === undefined
          ? "The Bazaar found nothing that fits."
          : `The Bazaar returns ${String(count)} ${count === 1 ? "match" : "matches"}${event?.method === null || event?.method === undefined ? "" : `, ranked ${event.method}`}. The agent picks ${picked.toolName ?? "the first"}: callable, within its policy and at least origin-verified.`,
      facts: [
        ...(picked === undefined
          ? []
          : [{ label: "Pick", value: picked.toolName ?? short(picked.id, 8), mono: true }]),
        ...(priceText === undefined ? [] : [{ label: "Price", value: priceText, mono: true }]),
        ...(picked === undefined ? [] : [{ label: "Trust", value: trustLabel(picked.trust) }]),
        ...(picked === undefined ? [] : [{ label: "Seller", value: hostOf(picked.resource), mono: true }]),
      ],
      result: [],
      doc: DOCS.search,
      state: count === 0 ? "error" : "done",
      planned: false,
    };
  }

  private budgetStep(): StageStep | undefined {
    const tool = this.tool("get_budget");
    if (tool === undefined) return undefined;
    const result = tool.result?.result;
    const perCall = str(result, "policy", "assets", 0, "perCallCap");
    const remaining = str(result, "budget", "assets", 0, "remaining");
    const spent = str(result, "budget", "assets", 0, "spent");
    const price = this.facts.searches[0]?.top[0]?.price?.decimal ?? undefined;
    const fits =
      price !== undefined &&
      perCall !== undefined &&
      remaining !== undefined &&
      compareDecimal(price, perCall, this.decimals) !== 1 &&
      compareDecimal(price, remaining, this.decimals) !== 1;
    return {
      id: "budget",
      kind: "budget",
      lane: { self: AGENT.agent },
      chip: tool.result === undefined ? "Check budget" : fits ? "Within budget" : "Budget read",
      title: "Check the limits",
      explain:
        perCall === undefined || remaining === undefined
          ? "The agent reads its budget with get_budget before it pays."
          : `get_budget: at most ${perCall} ${this.symbol} per call and ${remaining} ${this.symbol} left this session.${fits ? " The price fits, so it may pay." : ""}`,
      facts: [
        ...(perCall === undefined
          ? []
          : [{ label: "Per-call limit", value: `${perCall} ${this.symbol}`, mono: true }]),
        ...(remaining === undefined
          ? []
          : [{ label: "Session left", value: `${remaining} ${this.symbol}`, mono: true }]),
        ...(spent === undefined ? [] : [{ label: "Spent", value: `${spent} ${this.symbol}`, mono: true }]),
      ],
      result: [],
      doc: DOCS.agentLimits,
      state: tool.result === undefined ? this.open(false) : tool.result.isError ? "error" : "done",
      planned: false,
    };
  }

  private toolPaymentSteps(): (StageStep | undefined)[] {
    const pay = this.tool("pay_and_call");
    if (pay === undefined) return [];
    const { unpaid, paid } = toolCallExchanges(this.facts);
    const required = unpaid?.response?.rpc?.required ?? null;
    const option =
      required?.options.find((item) => item.verdict?.acceptable === true) ?? required?.options[0];
    const upto = option?.scheme === "upto";
    const priceText = this.optionAmount(option);
    const auth = this.facts.auth;
    const perCall = str(pay.call.args, "spendingCap", "amount");
    const name = this.toolName() ?? "the tool";
    const args = at(pay.call.args, "arguments");
    const settle = paid?.response?.rpc?.settle ?? null;
    const tx = this.tx();
    const proven = settlementTx(this.facts);
    const settledAmount = settle?.amount ?? null;
    const result = pay.result;
    const failed = result !== undefined && (result.isError || bool(result.result, "ok") === false);
    const steps: (StageStep | undefined)[] = [];
    const step = (
      id: string,
      kind: StepKind,
      lane: RowLane,
      state: StepState,
      text: Omit<StepText, "kind">,
      resultFacts: readonly StageFact[] = [],
    ): StageStep => ({ id, kind, lane, state, planned: false, result: resultFacts, ...text });

    steps.push(
      unpaid === undefined
        ? undefined
        : step(
            "call",
            "call",
            { from: AGENT.agent, to: AGENT.tool },
            unpaid.failure === undefined
              ? unpaid.response === undefined
                ? this.open(false)
                : "done"
              : "error",
            {
              chip: "tools/call",
              title: "Call the tool",
              explain: `pay_and_call sends the ${name} call to ${hostOf(unpaid.request.url)} without payment first${args === undefined ? "" : `, with ${plain(args, 60)}`}.`,
              facts: [
                { label: "Tool", value: name, mono: true },
                ...(args === undefined ? [] : [{ label: "Arguments", value: plain(args, 60), mono: true }]),
                { label: "Server", value: hostOf(unpaid.request.url), mono: true },
              ],
              doc: DOCS.mcpServer,
            },
          ),
    );
    steps.push(
      required === null || unpaid?.response === undefined
        ? undefined
        : step("tool-quote", "quote", { from: AGENT.tool, to: AGENT.agent }, "done", {
            chip: `402 · ${upto ? "up to " : ""}${priceText ?? "price"}`,
            title: "The tool names its price",
            explain: `The tool answers with a payment-required error: ${upto ? "up to " : ""}${priceText ?? "its price"}, paid to its Stellar account.`,
            facts: [
              { label: upto ? "Up to" : "Price", value: priceText ?? "unknown", mono: true },
              ...(option === undefined
                ? []
                : [
                    {
                      label: "Pay to",
                      value: short(option.payTo),
                      mono: true,
                      ...hrefOf(this.link(option.payTo)),
                    },
                  ]),
              ...(option?.verdict === null || option?.verdict === undefined
                ? []
                : [
                    {
                      label: "Agent policy",
                      value: option.verdict.acceptable
                        ? "allows it"
                        : `refuses: ${option.verdict.code ?? ""}`,
                    },
                  ]),
            ],
            doc: upto ? DOCS.upto : DOCS.architecture,
          }),
    );
    const max =
      auth?.scheme === "upto"
        ? auth.terms.maxAmount
        : auth?.scheme === "exact"
          ? auth.transfer.amount
          : undefined;
    steps.push(
      auth === undefined
        ? undefined
        : step("sign", "sign", { self: AGENT.agent }, "done", {
            chip: `Sign ${auth.scheme === "upto" ? "up to " : ""}${this.bare(max) ?? ""}`.trim(),
            title: "The agent signs once",
            explain: `pay_and_call signs once for ${auth.scheme === "upto" ? "at most " : ""}${this.amount(max) ?? "the price"}${perCall === undefined ? "" : `, under its ${perCall} ${this.symbol} per-call limit`}. Nothing above the limit can be signed.`,
            facts: [
              {
                label: auth.scheme === "upto" ? "At most" : "Amount",
                value: this.amount(max) ?? "",
                mono: true,
              },
              ...(perCall === undefined
                ? []
                : [{ label: "Per-call limit", value: `${perCall} ${this.symbol}`, mono: true }]),
              ...(auth.expiresInSeconds === null
                ? []
                : [{ label: "Expires", value: `in about ${String(auth.expiresInSeconds)} s` }]),
            ],
            doc: auth.scheme === "upto" ? DOCS.uptoContract : DOCS.authorization,
          }),
    );
    steps.push(
      paid === undefined
        ? undefined
        : step(
            "paid",
            "paid",
            { from: AGENT.agent, to: AGENT.tool },
            paid.failure !== undefined ? "error" : paid.response === undefined ? this.open(false) : "done",
            {
              chip: "retry + payment",
              title: "The agent retries with payment",
              explain: 'The same tool call again, with the signed payment in _meta["x402/payment"].',
              facts: [
                { label: "Carries", value: '_meta["x402/payment"]', mono: true },
                {
                  label: "Sent via",
                  value: paid.request.via === "direct" ? "this page" : "the Playground relay",
                },
              ],
              doc: DOCS.mcpServer,
            },
          ),
    );
    steps.push(
      settle === null
        ? undefined
        : step(
            "tool-settle",
            "settle",
            { from: AGENT.tool, to: AGENT.rail },
            settle.success ? "done" : "error",
            {
              chip: `/settle ${this.bare(settledAmount) ?? ""}`.trim(),
              title: `${this.facilitator()} settles it`,
              explain: settle.success
                ? `The tool's server hands the payment to ${this.facilitator()}, which checks it, submits it to Stellar and pays the network fee.`
                : `Settlement failed: ${settle.errorReason ?? "no reason given"}.`,
              facts: [
                { label: "Charged", value: this.amount(settledAmount) ?? "reported", mono: true },
                ...(max === undefined || auth?.scheme !== "upto"
                  ? []
                  : [{ label: "Signed for", value: this.amount(max) ?? "", mono: true }]),
                ...(tx?.feeBump === null || tx?.feeBump === undefined
                  ? []
                  : [
                      {
                        label: "Fee paid by",
                        value: `${short(tx.feeBump.feeSource)}${tx.feeSourceAdvertised === true ? " · Rail402" : ""}`,
                        mono: true,
                      },
                    ]),
              ],
              doc: DOCS.facilitator,
            },
          ),
    );
    const transfer = tx?.transfers[0];
    steps.push(
      tx === undefined
        ? undefined
        : step(
            "submit",
            "submit",
            { from: AGENT.rail, to: AGENT.stellar },
            tx.status === "SUCCESS" && proven !== undefined ? "done" : "error",
            {
              chip: `transfer ${transfer?.decimal ?? ""}`.trim(),
              title: "The transfer lands",
              explain:
                proven === undefined
                  ? "The tool reported a transaction, but the chain does not show it settling this payment."
                  : `Stellar moved ${transfer?.decimal ?? "the payment"} ${this.symbol} from the agent's wallet to the tool's seller in ledger ${String(tx.ledger)}.`,
              facts: [
                ...(transfer === undefined
                  ? []
                  : [
                      {
                        label: "From → to",
                        value: `${short(transfer.from)} → ${short(transfer.to)}`,
                        mono: true,
                      },
                    ]),
                { label: "Ledger", value: String(tx.ledger), mono: true },
                { label: "Transaction", value: short(tx.hash, 6), mono: true, href: tx.explorerUrl },
              ],
              doc: DOCS.feeSponsorship,
            },
          ),
    );
    const value = result?.result;
    const charged = str(value, "payment", "settled", "amount");
    const remaining = str(value, "budget", "assets", 0, "remaining");
    const verified = bool(value, "payment", "verifiedOnChain");
    const structured = at(value, "response", "structuredContent");
    steps.push(
      result === undefined
        ? undefined
        : step(
            "tool-result",
            "deliver",
            { from: AGENT.tool, to: AGENT.agent },
            failed ? "error" : "done",
            {
              chip: failed ? "tool call failed" : "result + receipt",
              title: "Result + receipt",
              explain: failed
                ? (str(value, "error", "reason") ?? "The tool call failed.")
                : `The tool returns its answer with a receipt${charged === undefined ? "" : ` for ${charged} ${this.symbol}`}${verified === true ? ", checked on chain" : ""}.`,
              facts: failed
                ? [{ label: "Code", value: str(value, "error", "code") ?? "tool_failed", mono: true }]
                : [
                    ...(charged === undefined
                      ? []
                      : [{ label: "Paid", value: `${charged} ${this.symbol}`, mono: true }]),
                    ...(verified === undefined
                      ? []
                      : [{ label: "On chain", value: verified ? "verified" : "not proven" }]),
                    ...(remaining === undefined
                      ? []
                      : [{ label: "Session left", value: `${remaining} ${this.symbol}`, mono: true }]),
                  ],
              doc: DOCS.mcpServer,
            },
            structured === undefined ? [] : summarize(structured, this.asset),
          ),
    );
    return steps;
  }

  // ---------------------------------------------------------------- what is still to come

  placeholder(kind: StepKind): StageStep {
    const agent = this.mode === "agent";
    const fac = this.facilitator();
    const lanes: Readonly<Partial<Record<StepKind, RowLane>>> = agent
      ? {
          search: { from: AGENT.agent, to: AGENT.bazaar },
          results: { from: AGENT.bazaar, to: AGENT.agent },
          budget: { self: AGENT.agent },
          call: { from: AGENT.agent, to: AGENT.tool },
          quote: { from: AGENT.tool, to: AGENT.agent },
          sign: { self: AGENT.agent },
          paid: { from: AGENT.agent, to: AGENT.tool },
          settle: { from: AGENT.tool, to: AGENT.rail },
          submit: { from: AGENT.rail, to: AGENT.stellar },
          deliver: { from: AGENT.tool, to: AGENT.agent },
        }
      : {
          request: { from: HTTP.you, to: HTTP.seller },
          quote: { from: HTTP.seller, to: HTTP.you },
          refused: { self: HTTP.you },
          sign: { self: HTTP.you },
          paid: { from: HTTP.you, to: HTTP.seller },
          work: { self: HTTP.seller },
          settle: { from: HTTP.seller, to: HTTP.rail },
          "overcharge-refused": { self: HTTP.rail },
          submit: { from: HTTP.rail, to: HTTP.stellar },
          deliver: { from: HTTP.seller, to: HTTP.you },
          resend: { from: HTTP.you, to: HTTP.seller },
          "replay-refused": { from: HTTP.seller, to: HTTP.you },
          "charged-once": { self: HTTP.you },
        };
    const text = PLANNED[kind];
    return {
      id: `plan-${kind}`,
      kind,
      lane: lanes[kind] ?? { self: 0 },
      chip:
        kind === "request" && this.context.target !== undefined
          ? `GET ${pathAndQuery(this.context.target)}`
          : agent
            ? (AGENT_CHIPS[kind] ?? text.chip)
            : text.chip,
      title: (agent
        ? (AGENT_TITLES[kind] ?? text.title)
        : this.mode === "upto" && kind === "quote"
          ? "The API names its terms"
          : text.title
      ).replace("{fac}", fac),
      explain: text.explain.replace("{fac}", fac),
      facts: [],
      result: [],
      doc: text.doc,
      state: "pending",
      planned: true,
    };
  }
}

type StepText = Pick<StageStep, "kind" | "chip" | "title" | "explain" | "facts" | "doc"> & {
  readonly result?: readonly StageFact[];
};

const PLANNED: Readonly<Record<StepKind, { chip: string; title: string; explain: string; doc: DocRef }>> = {
  request: {
    chip: "GET",
    title: "You ask for the data",
    explain: "A plain request with no API key and no account.",
    doc: DOCS.x402,
  },
  quote: {
    chip: "402",
    title: "The API names its price",
    explain: "A paid API answers 402 Payment Required with its price.",
    doc: DOCS.architecture,
  },
  refused: {
    chip: "refuse",
    title: "Refused before signing",
    explain: "Your buyer must refuse this before anything is signed.",
    doc: DOCS.spendingPolicy,
  },
  sign: {
    chip: "sign",
    title: "Your wallet signs once",
    explain: "Your wallet signs one payment, checked against your cap first.",
    doc: DOCS.authorization,
  },
  paid: {
    chip: "retry + signature",
    title: "You retry with the signature",
    explain: "The same request again, carrying the signed payment.",
    doc: DOCS.x402Headers,
  },
  work: {
    chip: "charge",
    title: "The API sets the charge",
    explain: "A metered API does the work, then charges what it cost, never more than you signed for.",
    doc: DOCS.meteredPricing,
  },
  settle: {
    chip: "/settle",
    title: "{fac} settles it",
    explain: "{fac} verifies the payment and submits it to Stellar, paying the network fee.",
    doc: DOCS.verificationRules,
  },
  "overcharge-refused": {
    chip: "refuse",
    title: "{fac} refuses the overcharge",
    explain: "A settlement above the signed cap must be refused.",
    doc: DOCS.uptoContract,
  },
  submit: {
    chip: "transfer",
    title: "The transfer lands",
    explain: "Stellar moves the money from you to the seller.",
    doc: DOCS.feeSponsorship,
  },
  deliver: {
    chip: "200 OK + receipt",
    title: "You get data + receipt",
    explain: "The API returns the data with a receipt naming the transaction.",
    doc: DOCS.receipts,
  },
  resend: {
    chip: "same signature again",
    title: "You send the same payment again",
    explain: "The signed payment is sent a second time.",
    doc: DOCS.idempotency,
  },
  "replay-refused": {
    chip: "402",
    title: "The copy is refused",
    explain: "A signed payment can be used once.",
    doc: DOCS.verificationRules,
  },
  "charged-once": {
    chip: "charged once",
    title: "You are charged once",
    explain: "Your balance moves once, not twice.",
    doc: DOCS.verificationRules,
  },
  search: {
    chip: "search",
    title: "Search the Bazaar",
    explain: "The agent searches the Bazaar for a tool that answers the question.",
    doc: DOCS.search,
  },
  results: {
    chip: "results",
    title: "Pick a tool in budget",
    explain: "The agent picks the best match it can pay.",
    doc: DOCS.search,
  },
  budget: {
    chip: "budget",
    title: "Check the limits",
    explain: "The agent reads its budget before it pays.",
    doc: DOCS.agentLimits,
  },
  call: {
    chip: "tools/call",
    title: "Call the tool",
    explain: "The tool call goes out without payment first.",
    doc: DOCS.mcpServer,
  },
  other: { chip: "", title: "", explain: "", doc: DOCS.x402 },
};

const AGENT_CHIPS: Readonly<Partial<Record<StepKind, string>>> = {
  paid: "retry + payment",
  deliver: "result + receipt",
};

const AGENT_TITLES: Readonly<Partial<Record<StepKind, string>>> = {
  quote: "The tool names its price",
  sign: "The agent signs once",
  paid: "The agent retries with payment",
  deliver: "Result + receipt",
};

function capitalize(text: string): string {
  return text.length === 0 ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function hrefOf(href: string | undefined): { href?: string } {
  return href === undefined ? {} : { href };
}

/** An explorer link for an account (`G…`) or a contract (`C…`), from the transaction link template. */
export function addressLink(template: string, address: string): string | undefined {
  const kind = /^G[A-Z2-7]{55}$/.test(address)
    ? "account"
    : /^C[A-Z2-7]{55}$/.test(address)
      ? "contract"
      : undefined;
  if (kind === undefined || !template.includes("/tx/{hash}")) return undefined;
  const url = template.replace("/tx/{hash}", `/${kind}/${address}`).replaceAll("{network}", "testnet");
  if (!URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" ? url : undefined;
}

/** Most pairs a result summary shows. */
const RESULT_PAIRS = 6;

/** The asset a seller's `amount` fields are in: x402 amounts are base units of the payment asset. */
export interface ResultAsset {
  readonly symbol: string;
  readonly decimals: number;
}

/**
 * A response body or tool result as readable pairs: the top-level fields of a JSON object, with
 * lists counted and nested objects inlined; other text as one value. An `amount` in base units (a
 * string of digits, as x402 writes amounts) is shown in the payment asset. Seller content: shown as
 * text.
 */
export function summarize(value: JsonValue | string, asset?: ResultAsset): StageFact[] {
  let parsed: JsonValue | undefined;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value) as JsonValue;
    } catch {
      return [{ label: "Body", value: value.length > 160 ? `${value.slice(0, 160)}…` : value }];
    }
  } else parsed = value;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [{ label: "Body", value: plain(parsed, 160, asset) }];
  }
  return Object.entries(parsed)
    .slice(0, RESULT_PAIRS)
    .map(([key, item]) => ({
      label: key,
      value: key === "amount" ? baseUnitsText(item, asset) : plain(item, 80, asset),
    }));
}

/** `21000` base units as `0.0021 USDC`; anything else as plain text. */
function baseUnitsText(value: JsonValue, asset: ResultAsset | undefined): string {
  if (asset !== undefined && typeof value === "string" && /^\d{1,30}$/.test(value)) {
    const decimal = toDecimal(value, asset.decimals);
    if (decimal !== undefined) return `${decimal} ${asset.symbol}`;
  }
  return plain(value, 80, asset);
}

/** A JSON value in words: text as is, lists counted, an object's fields as `name value` pairs. */
function plain(value: JsonValue, max: number, asset?: ResultAsset): string {
  let text: string;
  if (Array.isArray(value)) text = `${String(value.length)} ${value.length === 1 ? "item" : "items"}`;
  else if (value === null) text = "none";
  else if (typeof value === "object")
    text = Object.entries(value)
      .map(
        ([name, item]) =>
          `${name} ${
            name === "amount"
              ? baseUnitsText(item, asset)
              : Array.isArray(item) || (item !== null && typeof item === "object")
                ? plain(item, 24, asset)
                : String(item)
          }`,
      )
      .join(" · ");
  else text = String(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
