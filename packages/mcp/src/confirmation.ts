import { sanitizeLine } from "@rail402.dev/sdk/discovery";
import type { SignIntent } from "@rail402.dev/sdk/browser";

/**
 * Pubnet payment confirmation in the MCP server. The buyer's `confirm` function cannot block a tool
 * call while a human decides, so it raises `ConfirmationRequired`; the server answers the call with
 * a form elicitation (`input_required`), and the client retries it with the answer. The retry carries
 * the intent that was asked about in an integrity-protected request state, and only a payment that
 * matches it (same network, scheme, asset, recipient, resource, listing, upto settlement authority
 * and budget window, at most the same amount) is signed. Nothing here imports a Node module.
 */

/** The parts of a sign intent a confirmation binds to. */
export interface ConfirmedIntent {
  readonly network: string;
  readonly scheme: string;
  readonly asset: string;
  readonly amount: string;
  readonly payTo: string;
  readonly resource: string;
  /** The Bazaar listing; "" when the payment is not bound to one. */
  readonly listingId: string;
  /** The upto settlement authority; "" for exact. */
  readonly facilitator: string;
  /**
   * The budget window the question was shown for, with its end and the budget left in it. A payment
   * in another window (it renewed, or the session was restarted, while the user decided) is asked
   * about again.
   */
  readonly window: string;
}

/** What the client said about a confirmation it was asked for, on the retried call. */
export interface ConfirmationAnswer {
  readonly approved: boolean;
  readonly intent: ConfirmedIntent;
}

/** Per tool call: whether the client can be asked, and its answer when this is the retry. */
export interface ToolCallContext {
  /** The client declared form elicitation support. */
  readonly canElicit: boolean;
  readonly answer?: ConfirmationAnswer | undefined;
}

/** Raised by the confirm function when the client must be asked first; nothing was signed. */
export class ConfirmationRequired extends Error {
  readonly intent: SignIntent;

  constructor(intent: SignIntent) {
    super("The payment needs the user's confirmation.");
    this.name = "ConfirmationRequired";
    this.intent = intent;
  }
}

/** Runs a paid tool call with its confirmation context in reach of the buyer's confirm function. */
export interface ConfirmationScope {
  run<T>(context: ToolCallContext | undefined, body: () => Promise<T>): Promise<T>;
}

export function confirmedIntent(intent: SignIntent): ConfirmedIntent {
  return {
    network: intent.network,
    scheme: intent.scheme,
    asset: intent.asset.contract,
    amount: intent.amount.atomic,
    payTo: intent.payTo,
    resource: intent.resource,
    listingId: intent.listingId ?? "",
    facilitator: intent.facilitator ?? "",
    window: intent.session.window,
  };
}

/** Whether an approved intent covers this one: the same payment, for no more than was approved. */
export function covers(approved: ConfirmedIntent, intent: SignIntent): boolean {
  const current = confirmedIntent(intent);
  let amountCovered: boolean;
  try {
    amountCovered = BigInt(current.amount) <= BigInt(approved.amount);
  } catch {
    amountCovered = false;
  }
  return (
    amountCovered &&
    approved.network === current.network &&
    approved.scheme === current.scheme &&
    approved.asset === current.asset &&
    approved.payTo === current.payTo &&
    approved.resource === current.resource &&
    approved.listingId === current.listingId &&
    approved.facilitator === current.facilitator &&
    approved.window === current.window
  );
}

/** Whether a decoded request state has the shape of a confirmed intent. */
export function isConfirmedIntent(value: unknown): value is ConfirmedIntent {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return [
    "network",
    "scheme",
    "asset",
    "amount",
    "payTo",
    "resource",
    "listingId",
    "facilitator",
    "window",
  ].every((key) => typeof record[key] === "string");
}

/**
 * The question shown to the user: network, amount, asset, recipient, resource, listing, the upto
 * settlement authority, and exactly what approving covers (`SignIntent.approvalScope`). Untrusted
 * fields are shown on one line each, without control, line-break or bidirectional characters.
 */
export function confirmationMessage(intent: SignIntent): string {
  const symbol = sanitizeLine(intent.asset.symbol, 16);
  const amount =
    intent.scheme === "upto"
      ? `up to ${intent.amount.decimal} ${symbol} (upto: the settlement authority below settles at most this, for what the call uses)`
      : `${intent.amount.decimal} ${symbol}`;
  const target = intent.listingId === null ? "this resource" : "this listing";
  const scope =
    intent.approvalScope === "recipient"
      ? `Approving also lets this session pay ${intent.payTo} for ${target} again without asking, up to ${intent.session.perCall} ${symbol} per call and ${intent.session.remaining} ${symbol} in total, until ${intent.session.expiresAt}. Any other recipient, listing or resource is asked about again.`
      : "Approving covers this one payment only.";
  return [
    `Confirm a payment on ${intent.network}${intent.network === "stellar:pubnet" ? " (real funds)" : ""}.`,
    `Amount: ${amount}, token ${intent.asset.contract}.`,
    `To: ${intent.payTo}.`,
    `For: ${sanitizeLine(intent.resource, 300)}.`,
    ...(intent.listingId === null ? [] : [`Listing: ${sanitizeLine(intent.listingId, 100)}.`]),
    ...(intent.facilitator === null ? [] : [`Settlement authority: ${intent.facilitator}.`]),
    `Budget session: ${sanitizeLine(intent.session.name, 64)}.`,
    scope,
  ].join("\n");
}
