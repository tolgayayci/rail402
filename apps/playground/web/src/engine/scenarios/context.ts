/**
 * What a scenario, experiment or check runs with, and the steps they share: paying once with the
 * payer's balance read before and after, reporting the settled transaction from the chain, and turning
 * a refusal into its lab event and the run's outcome.
 */
import {
  isPaymentError,
  untrustedReason,
  type Buyer,
  type CallResult,
  type PaymentTarget,
  type SessionOptions,
} from "@rail402.dev/sdk/browser";
import type { Tools, ToolBuyer } from "@rail402.dev/mcp/tools";
import type { PublicConfig } from "../../../../src/shared/public-config.ts";
import type { ReplayHandle } from "../../transport/observe.ts";
import type { PolicyOptions } from "../buyer.ts";
import type { Catalog } from "../catalog.ts";
import type { ChainFacts } from "../chain.ts";
import { codedError, nothingPaid, refusalLayer } from "../errors.ts";
import { DELIVERY_BODY_LIMIT, type DeliveryView, type ReceiptView } from "../events.ts";
import type { Run } from "../run.ts";
import type { RunSummary } from "../types.ts";

/** A run's outcome, before the engine stamps the run id on it. */
export type Outcome = Omit<RunSummary, "runId">;

/** The buyer operations runs use. */
export type RunBuyer = Pick<
  Buyer,
  | "network"
  | "address"
  | "policy"
  | "pay"
  | "payListing"
  | "quote"
  | "search"
  | "listing"
  | "budget"
  | "reconcile"
>;

export interface RunContext {
  readonly run: Run;
  readonly config: PublicConfig;
  readonly buyer: RunBuyer;
  readonly payer: string;
  /** The run's per-call cap, decimal. */
  readonly cap: string;
  /** The run's idempotency key (`pg_` and the run id). */
  readonly key: string;
  readonly chain: Pick<ChainFacts, "assetBalance" | "tx">;
  readonly catalog: Pick<Catalog, "search" | "list" | "listing" | "versions">;
  /** Holds the run's next paid HTTP request for one resend. */
  readonly replay: () => ReplayHandle;
  /** A buyer with the same signer and ledger under other policy or session settings. */
  readonly derive: (options: {
    readonly policy?: PolicyOptions;
    readonly session?: SessionOptions;
  }) => Promise<RunBuyer>;
  /** Judges the quoted options of the next payments against this buyer's policy (a derived one). */
  readonly judgeWith: (buyer: RunBuyer) => void;
  /** The rail402-mcp tools over a buyer. */
  readonly tools: (buyer: ToolBuyer) => Tools;
  readonly sleep: (ms: number) => Promise<void>;
}

/** The run's cap (or another amount) as the SDK's money. */
export function money(context: RunContext, amount = context.cap): { amount: string; asset: string } {
  return { amount, asset: context.config.asset.symbol };
}

/** An absolute URL under `base` with query parameters. */
export function urlOf(
  base: string,
  path: string,
  query: Readonly<Record<string, string | number>> = {},
): string {
  const url = new URL(path, base);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, String(value));
  return url.href;
}

/** Scenario parameters over defaults: only names the defaults know, as strings. */
export function withParams(
  defaults: Readonly<Record<string, string>>,
  params: Readonly<Record<string, string | number>> | undefined,
): Record<string, string> {
  const merged: Record<string, string> = { ...defaults };
  for (const name of Object.keys(defaults)) {
    const value = params?.[name];
    if (typeof value === "string" || typeof value === "number") merged[name] = String(value).slice(0, 64);
  }
  return merged;
}

/**
 * The payer's balance of the policy asset, decimal; null when it cannot be read. With `atLeastLedger`
 * it is read as of that ledger or later (see ChainFacts.assetBalance).
 */
export async function readBalance(context: RunContext, atLeastLedger?: number): Promise<string | null> {
  try {
    return await context.chain.assetBalance(context.payer, atLeastLedger);
  } catch {
    return null;
  }
}

/** The ledger of the last transaction the run read from the chain; undefined before any. */
export function lastTxLedger(context: RunContext): number | undefined {
  for (let index = context.run.events.length - 1; index >= 0; index--) {
    const event = context.run.events[index];
    if (event?.kind === "chain" && event.phase === "tx") return event.view.ledger;
  }
  return undefined;
}

/**
 * Reports the payer's balance now against `before`, read as of the last transaction the run read (or
 * later), so the change it shows includes that settlement.
 */
export async function reportBalance(context: RunContext, before: string | null): Promise<string | null> {
  const after = await readBalance(context, lastTxLedger(context));
  context.run.emit({
    kind: "chain",
    phase: "balance",
    role: "payer",
    account: context.payer,
    asset: context.config.asset.contract,
    before,
    after,
  });
  return after;
}

/** Reads a settled transaction from the chain and reports it; a read failure leaves it unreported. */
export async function reportTransaction(context: RunContext, hash: string | null | undefined): Promise<void> {
  if (hash === null || hash === undefined) return;
  try {
    context.run.emit({ kind: "chain", phase: "tx", view: await context.chain.tx(hash) });
  } catch {
    // The receipt still carries the hash and its explorer link; the chain read is retried by the page.
  }
}

/**
 * What a call delivered, for the page: the body as bounded text (the SDK already removed any payment
 * material the seller echoed, and secrets and control characters are removed here too) and the
 * SDK's receipt, with whether it proved the settlement on chain.
 */
export function deliveryView(result: CallResult): DeliveryView {
  const response = result.response;
  let text: string | undefined;
  let truncated = response.truncated;
  let contentType: string | null;
  if (response.kind === "http") {
    contentType = response.contentType;
    text = response.json !== undefined ? safeJson(response.json) : response.text;
  } else if (response.structuredContent !== undefined) {
    contentType = "application/json";
    text = safeJson(response.structuredContent);
  } else {
    contentType = response.content.length === 0 ? null : "text/plain";
    text = response.content.length === 0 ? undefined : response.content.map((item) => item.text).join("\n");
  }
  if (text !== undefined && text.length > DELIVERY_BODY_LIMIT) truncated = true;
  return {
    target: response.kind,
    status: response.kind === "http" ? response.status : null,
    isError: response.kind === "mcp" && response.isError,
    contentType: contentType === null ? null : untrustedReason(contentType, 100),
    body: text === undefined || text === "" ? null : untrustedReason(text, DELIVERY_BODY_LIMIT),
    truncated,
    receipt: result.payment === null ? null : receiptView(result.payment),
  };
}

/** The SDK's receipt as the page shows it. */
function receiptView(payment: NonNullable<CallResult["payment"]>): ReceiptView {
  return {
    status: payment.status,
    scheme: payment.scheme,
    transaction: payment.transaction,
    settled: payment.settled?.atomic ?? null,
    payTo: payment.payTo,
    payer: payment.payer,
    verifiedOnChain: payment.verifiedOnChain,
  };
}

/**
 * A call that failed after its payment left (the resource failed after settling, or the settlement
 * could not be confirmed) carries the SDK's receipt: it is reported as the delivery, with no body, and
 * its transaction is read from the chain. A run that started on an MCP target reports an MCP delivery.
 */
async function reportFailedDelivery(context: RunContext, error: unknown): Promise<void> {
  if (!isPaymentError(error) || error.receipt === undefined) return;
  const target = context.run.events.some(
    (event) => event.kind === "run" && event.phase === "start" && event.target === "mcp",
  )
    ? "mcp"
    : "http";
  context.run.emit({
    kind: "delivery",
    view: {
      target,
      status: null,
      isError: target === "mcp",
      contentType: null,
      body: null,
      truncated: false,
      receipt: receiptView(error.receipt),
    },
  });
  await reportTransaction(context, error.receipt.transaction);
}

function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/** Reports a refusal or failure as a lab event and returns it coded. */
export function reportRefusal(context: RunContext, error: unknown): ReturnType<typeof codedError> {
  const coded = codedError(error);
  context.run.emit({
    kind: "refusal",
    layer: refusalLayer(error),
    code: coded.code,
    reason: coded.reason,
    ...(coded.details === undefined ? {} : { details: coded.details }),
  });
  return coded;
}

/** The outcome of a run that ended on `error`: refused when nothing was paid, else an error. */
export function outcomeOf(error: unknown, coded = codedError(error)): Outcome {
  return { status: nothingPaid(error) ? "refused" : "error", code: coded.code, reason: coded.reason };
}

export type Paid =
  { readonly ok: true; readonly result: CallResult } | { readonly ok: false; readonly error: unknown };

/**
 * Makes one call that may pay, with the payer's balance read before and after. A settled payment's
 * transaction is read from the chain; a refusal is reported with its layer.
 */
export async function payOnce(context: RunContext, call: () => Promise<CallResult>): Promise<Paid> {
  const before = await readBalance(context);
  try {
    const result = await call();
    context.run.emit({ kind: "delivery", view: deliveryView(result) });
    await reportTransaction(context, result.payment?.transaction);
    await reportBalance(context, before);
    return { ok: true, result };
  } catch (error) {
    reportRefusal(context, error);
    await reportFailedDelivery(context, error);
    await reportBalance(context, before);
    return { ok: false, error };
  }
}

/** Pays an HTTP target under the run's cap and key. */
export function payHttp(
  context: RunContext,
  url: string,
  options: { readonly cap?: string; readonly key?: string; readonly buyer?: RunBuyer } = {},
): Promise<Paid> {
  const target: PaymentTarget = { kind: "http", url };
  const buyer = options.buyer ?? context.buyer;
  return payOnce(context, () =>
    buyer.pay(target, {
      maxAmount: money(context, options.cap),
      idempotencyKey: options.key ?? context.key,
      signal: context.run.signal,
    }),
  );
}

/**
 * The outcome of a call that returned: ok only when the SDK proved the settlement on chain (it
 * succeeded and consumed this payment's own nonce). A seller's reported transaction alone is not
 * proof: the hold then stays in the budget until the chain proves what moved.
 */
export function settledOutcome(result: CallResult, reason: string): Outcome {
  if (!result.paid) {
    return { status: "info", reason: "The resource answered without asking for payment; nothing was paid." };
  }
  const payment = result.payment;
  if (payment?.status === "settled" && payment.verifiedOnChain) return { status: "ok", reason };
  return {
    status: "info",
    code: "payment_settlement_unconfirmed",
    reason:
      payment?.transaction === null || payment?.transaction === undefined
        ? "Paid, but the seller reported no settlement transaction; the hold stays in your budget until the chain proves what moved."
        : "Paid, but the transaction the seller reported does not prove this payment on chain yet; the hold stays in your budget until it does.",
  };
}
