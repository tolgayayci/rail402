/**
 * One pass over a run's events into the facts the projections read: the HTTP exchanges in order, the
 * payment trace, the authorization, chain reads, tool calls and Bazaar reads.
 */
import type {
  AuthorizationView,
  DeliveryView,
  LabEvent,
  RequiredView,
  SdkPaymentEvent,
  SettleView,
  ToolName,
  TxView,
} from "../engine/events.ts";

type Of<K extends LabEvent["kind"], P = unknown> = Extract<LabEvent, { kind: K } & P>;

export type RunStart = Of<"run", { phase: "start" }>;
export type RunEnd = Of<"run", { phase: "end" }>;
export type HttpRequest = Of<"http", { phase: "request" }>;
export type HttpResponse = Of<"http", { phase: "response" }>;
export type HttpFailure = Of<"http", { phase: "failed" }>;
export type Refusal = Of<"refusal">;
export type Balance = Of<"chain", { phase: "balance" }>;
export type BazaarSearch = Of<"bazaar", { phase: "search" }>;
export type ToolCall = Of<"tool", { phase: "call" }>;
export type ToolResult = Of<"tool", { phase: "result" }>;

/** One request and what came back for it. */
export interface Exchange {
  readonly request: HttpRequest;
  readonly response: HttpResponse | undefined;
  readonly failure: HttpFailure | undefined;
}

export interface ToolExchange {
  readonly name: ToolName;
  readonly call: ToolCall;
  readonly result: ToolResult | undefined;
}

export interface RunFacts {
  readonly start: RunStart | undefined;
  readonly end: RunEnd | undefined;
  readonly exchanges: readonly Exchange[];
  readonly sdk: readonly SdkPaymentEvent[];
  readonly auth: AuthorizationView | undefined;
  readonly refusals: readonly Refusal[];
  readonly txs: readonly TxView[];
  /** Every read of the payer's balance, in order (a run that pays twice reads it twice). */
  readonly payerBalances: readonly Balance[];
  /** The run's payer balance: the first read's `before` and the last read's `after`. */
  readonly payerBalance: Balance | undefined;
  readonly payToBalance: Balance | undefined;
  /** What the paid call delivered, and the SDK's receipt. */
  readonly delivery: DeliveryView | undefined;
  /**
   * Transactions a background reconciliation proved for this run's payment after the run ended (its
   * `settled` events then come from the chain, not from the seller).
   */
  readonly provenLater: ReadonlySet<string>;
  readonly tools: readonly ToolExchange[];
  readonly searches: readonly BazaarSearch[];
}

/** SDK events that open a call: a run owns a call it saw opened. */
const OPENING_TYPES: ReadonlySet<SdkPaymentEvent["type"]> = new Set([
  "probe",
  "quote",
  "refused",
  "reserved",
]);

export function collectFacts(events: readonly LabEvent[]): RunFacts {
  let start: RunStart | undefined;
  let end: RunEnd | undefined;
  const exchanges: { request: HttpRequest; response?: HttpResponse; failure?: HttpFailure }[] = [];
  const byId = new Map<string, (typeof exchanges)[number]>();
  const sdk: SdkPaymentEvent[] = [];
  let auth: AuthorizationView | undefined;
  const refusals: Refusal[] = [];
  const txs: TxView[] = [];
  const payerBalances: Balance[] = [];
  let payToBalance: Balance | undefined;
  let delivery: DeliveryView | undefined;
  const provenLater = new Set<string>();
  const opened = new Set<string>();
  const tools: { name: ToolName; call: ToolCall; result?: ToolResult }[] = [];
  const searches: BazaarSearch[] = [];

  for (const event of events) {
    switch (event.kind) {
      case "run":
        if (event.phase === "start") start = event;
        else end = event;
        break;
      case "http":
        if (event.phase === "request") {
          const exchange = { request: event };
          exchanges.push(exchange);
          byId.set(event.id, exchange);
        } else if (event.phase === "response") {
          const exchange = byId.get(event.id);
          if (exchange !== undefined) exchange.response = event;
        } else {
          const exchange = byId.get(event.id);
          if (exchange !== undefined) exchange.failure = event;
        }
        break;
      case "sdk": {
        const sdkEvent = event.event;
        const callId = "callId" in sdkEvent ? sdkEvent.callId : undefined;
        if (callId !== undefined) {
          // Events of a call this run never opened belong to another payment (a reconciliation of an
          // older reservation that ran during this run): they are not this run's facts.
          if (OPENING_TYPES.has(sdkEvent.type)) opened.add(callId);
          else if (!opened.has(callId)) break;
        }
        sdk.push(sdkEvent);
        if (sdkEvent.type === "settled" && end !== undefined && sdkEvent.transaction !== null) {
          provenLater.add(sdkEvent.transaction);
        }
        break;
      }
      case "auth":
        auth = event.view;
        break;
      case "refusal":
        refusals.push(event);
        break;
      case "chain":
        if (event.phase === "tx") {
          if (!txs.some((tx) => tx.hash === event.view.hash)) txs.push(event.view);
        } else if (event.role === "payer") payerBalances.push(event);
        else payToBalance = event;
        break;
      case "delivery":
        delivery ??= event.view;
        break;
      case "tool":
        if (event.phase === "call") tools.push({ name: event.name, call: event });
        else {
          const open = tools.find((tool) => tool.name === event.name && tool.result === undefined);
          if (open !== undefined) open.result = event;
        }
        break;
      case "bazaar":
        if (event.phase === "search") searches.push(event);
        break;
      case "wallet":
        break;
    }
  }

  return {
    start,
    end,
    exchanges: exchanges.map((exchange) => ({
      request: exchange.request,
      response: exchange.response,
      failure: exchange.failure,
    })),
    sdk,
    auth,
    refusals,
    txs,
    payerBalances,
    payerBalance: runBalance(payerBalances),
    payToBalance,
    delivery,
    provenLater,
    tools: tools.map((tool) => ({ name: tool.name, call: tool.call, result: tool.result })),
    searches,
  };
}

/** The SDK events of one type, in order. */
export function sdkEvents<T extends SdkPaymentEvent["type"]>(
  facts: RunFacts,
  type: T,
): Extract<SdkPaymentEvent, { type: T }>[] {
  return facts.sdk.filter((event): event is Extract<SdkPaymentEvent, { type: T }> => event.type === type);
}

/** Whether the run has ended. */
export function ended(facts: RunFacts): boolean {
  return facts.end !== undefined;
}

/** The balance across several reads: the first `before` and the last `after`. */
function runBalance(reads: readonly Balance[]): Balance | undefined {
  const first = reads[0];
  const last = reads.at(-1);
  if (first === undefined || last === undefined) return undefined;
  return { ...last, before: first.before };
}

/**
 * Whether a run outside the agent scenario pays an MCP tool (a Bazaar listing tried with your wallet):
 * the run says so, or its paid exchanges are JSON-RPC `tools/call`s.
 */
export function paysMcpTool(facts: RunFacts): boolean {
  if (facts.start?.scenario === "agent") return false;
  if (facts.start?.target !== undefined) return facts.start.target === "mcp";
  return facts.exchanges.some((exchange) => exchange.request.rpc?.method === "tools/call");
}

/**
 * The exchanges of a payment, split into the unpaid probe, the paid call and a resend. For an HTTP
 * resource these are the plain requests (not JSON-RPC). For an MCP tool they are the `tools/call`s;
 * the transport's other requests (initialize, notifications, the optional event stream) are not
 * part of the payment.
 */
export function httpExchanges(facts: RunFacts): {
  readonly probe: Exchange | undefined;
  readonly paid: Exchange | undefined;
  readonly resend: Exchange | undefined;
} {
  if (paysMcpTool(facts)) {
    const { unpaid, paid } = toolCallExchanges(facts);
    return { probe: unpaid, paid, resend: undefined };
  }
  const plain = facts.exchanges.filter((exchange) => exchange.request.rpc === undefined);
  const paidCalls = plain.filter((exchange) => exchange.request.paid);
  // The probe of the payment: the last unpaid request before the first paid one (a check may quote
  // with one buyer before another pays), or the last unpaid request when nothing was paid.
  const firstPaid = paidCalls[0] === undefined ? plain.length : plain.indexOf(paidCalls[0]);
  const probe = plain.slice(0, firstPaid).findLast((exchange) => !exchange.request.paid);
  return { probe, paid: paidCalls[0], resend: paidCalls[1] };
}

/** The JSON-RPC `tools/call` exchanges of an MCP payment, unpaid first. */
export function toolCallExchanges(facts: RunFacts): {
  readonly unpaid: Exchange | undefined;
  readonly paid: Exchange | undefined;
} {
  const calls = facts.exchanges.filter((exchange) => exchange.request.rpc?.method === "tools/call");
  return {
    unpaid: calls.find((exchange) => exchange.request.rpc?.hasPayment === false),
    paid: calls.find((exchange) => exchange.request.rpc?.hasPayment === true),
  };
}

/** The payment requirements an answer carried: a 402's header, or an MCP payment-required error. */
export function requiredOf(exchange: Exchange | undefined): RequiredView | undefined {
  const response = exchange?.response;
  return response?.required ?? response?.rpc?.required ?? undefined;
}

/** The settlement an answer reported: `PAYMENT-RESPONSE`, or an MCP result's `_meta`. */
export function settleOf(exchange: Exchange | undefined): SettleView | undefined {
  const response = exchange?.response;
  return response?.settle ?? response?.rpc?.settle ?? undefined;
}

/**
 * The transaction that settled this run's payment, when the chain proves it: it succeeded, consumed
 * the nonce of the authorization this run signed, and moved the signed amount (exact) or at most the
 * signed cap (upto) from the payer to the recipient. A transaction the seller merely reported is not
 * this payment's settlement. When the SDK's receipt says it could not prove the settlement, a
 * transaction is taken as proof only once a later reconciliation proved it from the chain.
 */
export function settlementTx(facts: RunFacts): TxView | undefined {
  const receipt = facts.delivery?.receipt;
  const unverified = receipt !== null && receipt !== undefined && !receipt.verifiedOnChain;
  const auth = facts.auth;
  if (auth === undefined) return undefined;
  return facts.txs.find(
    (tx) => provesAuthorization(tx, auth) && (!unverified || facts.provenLater.has(tx.hash)),
  );
}

/** What this run's payment paid, in base units, and whether the chain proves that amount. */
export interface PaidAmount {
  readonly atomic: string;
  readonly proven: boolean;
}

/**
 * The amount this run paid: what the proving transaction moved to the recipient (an upto settlement's
 * own event, else its transfers), or the SDK receipt's amount when it verified it on chain. Otherwise
 * the amount the seller reported (the first `settled` event), which is a claim, not proof.
 */
export function paidAmount(facts: RunFacts): PaidAmount | undefined {
  const tx = settlementTx(facts);
  const auth = facts.auth;
  if (tx !== undefined && auth !== undefined) {
    if (tx.uptoSettled !== null && /^\d+$/.test(tx.uptoSettled.amount)) {
      return { atomic: tx.uptoSettled.amount, proven: true };
    }
    const to = auth.scheme === "exact" ? auth.transfer.to : auth.terms.recipient;
    const from = auth.scheme === "exact" ? auth.transfer.from : auth.address;
    const moved = tx.transfers
      .filter((transfer) => transfer.from === from && transfer.to === to && /^\d+$/.test(transfer.amount))
      .reduce((sum, transfer) => sum + BigInt(transfer.amount), 0n);
    return { atomic: moved.toString(), proven: true };
  }
  const receipt = facts.delivery?.receipt;
  if (receipt?.verifiedOnChain === true && receipt.settled !== null) {
    return { atomic: receipt.settled, proven: true };
  }
  const settled = facts.sdk.find((event) => event.type === "settled");
  return settled === undefined ? undefined : { atomic: settled.amount, proven: false };
}

/**
 * What is known about the money of a run that did not end ok, from its last refusal's `paid`:
 * `settled` (the payment settled, the call failed after it), `unknown` (sent, outcome not proven) or
 * `none` (nothing was paid).
 */
export function paidStateOf(facts: RunFacts): "settled" | "unknown" | "none" {
  if (facts.end?.code === "payment_settlement_unconfirmed") return "unknown";
  for (let index = facts.refusals.length - 1; index >= 0; index--) {
    const details = facts.refusals[index]?.details;
    const paid =
      typeof details === "object" && details !== null && !Array.isArray(details)
        ? (details as Record<string, unknown>)["paid"]
        : undefined;
    if (paid === "settled" || paid === "unknown") return paid;
    if (paid === "none" || paid === "not_settled") return "none";
  }
  return "none";
}

/** What kind of payment a run made, for wording that depends on it. */
export interface FlowKind {
  /** An MCP tool call (the payment travels in `_meta`), not an HTTP request. */
  readonly mcp: boolean;
  /** The scheme signed or quoted: `exact`, `upto`, or null before any quote. */
  readonly scheme: "exact" | "upto" | null;
}

export function flowKindOf(facts: RunFacts): FlowKind {
  const mcp = facts.start?.scenario === "agent" || paysMcpTool(facts);
  const scheme =
    facts.auth?.scheme ??
    (() => {
      const { probe } = httpExchanges(facts);
      const options = requiredOf(probe)?.options ?? [];
      const option = options.find((item) => item.verdict?.acceptable === true) ?? options[0];
      return option?.scheme === "upto" ? "upto" : option?.scheme === "exact" ? "exact" : null;
    })();
  return { mcp, scheme };
}

/** Whether a transaction is the settlement of an authorization (see settlementTx). */
export function provesAuthorization(tx: TxView, auth: AuthorizationView): boolean {
  if (tx.status !== "SUCCESS" || !tx.nonces.includes(auth.nonce)) return false;
  if (auth.scheme === "exact") {
    const { from, to, amount, contract } = auth.transfer;
    return tx.transfers.some(
      (transfer) =>
        transfer.from === from &&
        transfer.to === to &&
        transfer.amount === amount &&
        transfer.contract === contract,
    );
  }
  const { recipient, token, maxAmount } = auth.terms;
  if (!/^\d+$/.test(maxAmount)) return false;
  const moved = tx.transfers.filter(
    (transfer) =>
      transfer.from === auth.address &&
      transfer.to === recipient &&
      transfer.contract === token &&
      /^\d+$/.test(transfer.amount),
  );
  const total = moved.reduce((sum, transfer) => sum + BigInt(transfer.amount), 0n);
  // A zero settlement moves nothing; it still consumed the nonce.
  return total <= BigInt(maxAmount) && (moved.length > 0 || tx.uptoSettled?.amount === "0");
}

/**
 * Whether the run shows Rail402 as the seller's facilitator: the option paid names a settler, or the
 * settlement's fee was paid by an account, that Rail402's /supported advertises.
 */
export function facilitatorShown(facts: RunFacts): boolean {
  if (settlementTx(facts)?.feeSourceAdvertised === true) return true;
  const { probe } = httpExchanges(facts);
  const options = requiredOf(probe)?.options ?? [];
  const option = options.find((item) => item.verdict?.acceptable === true) ?? options[0];
  return option?.facilitatorAddressAdvertised === true;
}
