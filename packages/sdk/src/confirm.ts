import { PUBNET, baseAccount, type StellarNetwork } from "@rail402.dev/stellar";
import { isPaymentError, paymentError } from "./codes.ts";
import { emit, type PaymentEventListener } from "./events.ts";
import type { SchemeName } from "./policy/policy.ts";

/**
 * What a payment is about to authorize, shown to whoever confirms it before anything is signed. All
 * of it comes from the option the spending policy selected; seller-provided strings (the resource
 * URL) are data to show, never instructions.
 */
export interface SignIntent {
  readonly callId: string;
  readonly network: StellarNetwork;
  readonly scheme: SchemeName;
  readonly asset: { readonly contract: string; readonly symbol: string; readonly decimals: number };
  /** The most this authorization can move: the price for exact, the cap for upto. */
  readonly amount: { readonly atomic: string; readonly decimal: string };
  readonly payTo: string;
  /** The paid URL, or the MCP endpoint and tool. */
  readonly resource: string;
  /** The Bazaar listing the payment is bound to, when it was selected from one. */
  readonly listingId: string | null;
  /** The upto settlement authority (`extra.facilitatorAddress`); null for exact. */
  readonly facilitator: string | null;
  /**
   * The budget session and window the payment reserves in: when the window ends (ISO 8601), and the
   * per-call cap and the budget left in it for this asset before this payment (decimal amounts).
   */
  readonly session: {
    readonly name: string;
    readonly window: string;
    readonly expiresAt: string;
    readonly perCall: string;
    readonly remaining: string;
  };
  /**
   * True when no payment of this approval scope (window, recipient, listing or resource, asset and
   * settlement authority) was confirmed yet in this buyer.
   */
  readonly firstInSession: boolean;
  /**
   * What approving this intent covers: `payment`, this payment only; `recipient` (the
   * `first-per-session` policy), also later payments of this window to the same recipient base
   * account for the same listing (or, without a listing, the same resource), asset and settlement
   * authority, each within the per-call cap and the budget left, until `session.expiresAt`. A new
   * recipient, listing, resource, asset or authority is asked about again.
   */
  readonly approvalScope: "payment" | "recipient";
}

/** The intent a confirmation gate is given; it adds what depends on its own policy and history. */
export type SignIntentInput = Omit<SignIntent, "firstInSession" | "approvalScope">;

/**
 * When a buyer asks before signing:
 * - `first-per-session`: the first payment of each budget window to each recipient and listing (or
 *   resource), per buyer instance; approving it covers that recipient and listing for the rest of the
 *   window (`SignIntent.approvalScope`);
 * - `every`: every payment;
 * - `never`: never (headless agents; the caps alone bound spending).
 */
export type ConfirmPolicy = "first-per-session" | "every" | "never";
export const CONFIRM_POLICIES: readonly ConfirmPolicy[] = ["first-per-session", "every", "never"];

/**
 * Asks whoever runs the buyer to approve a payment. True signs; false, or a thrown error, signs
 * nothing. A thrown PaymentError (such as `payment_confirmation_unavailable`) reaches the caller
 * unchanged and is reported as a `refused` event; any other error the function throws reaches the
 * caller unchanged without one (it is not a decision, e.g. "ask the user first").
 */
export type ConfirmSigning = (intent: SignIntent) => boolean | Promise<boolean>;

export interface ConfirmationOptions {
  readonly confirm?: ConfirmSigning | undefined;
  readonly confirmPolicy?: ConfirmPolicy | undefined;
  /** Called with every intent right before it is signed, after any confirmation. Observers only. */
  readonly onBeforeSign?: ((intent: SignIntent) => void) | undefined;
}

/** The confirmation step of one buyer: its policy, and the approvals it already holds. */
export interface ConfirmationGate {
  readonly policy: ConfirmPolicy;
  /** Asks when the policy says so; throws when nothing may be signed. */
  approve(intent: SignIntentInput, onEvent: PaymentEventListener | undefined): Promise<void>;
}

/**
 * Resolves a buyer's confirmation settings. On pubnet a buyer that can sign must say how payments are
 * confirmed: a `confirm` function (asked for the first payment of each window to each recipient and
 * listing unless `confirmPolicy`
 * says otherwise), or `confirmPolicy: "never"` for a headless agent. On testnet nothing is asked
 * unless `confirm` is given.
 */
export function createConfirmationGate(
  network: StellarNetwork,
  canSign: boolean,
  options: ConfirmationOptions,
): ConfirmationGate {
  const { confirm, onBeforeSign } = options;
  const requested: unknown = options.confirmPolicy;
  if (requested !== undefined && !CONFIRM_POLICIES.includes(requested as ConfirmPolicy)) {
    throw invalid(`confirmPolicy is one of ${CONFIRM_POLICIES.join(", ")}.`);
  }
  if (confirm !== undefined && typeof confirm !== "function") throw invalid("confirm must be a function.");
  const policy: ConfirmPolicy =
    (requested as ConfirmPolicy | undefined) ?? (confirm === undefined ? "never" : "first-per-session");
  if (policy !== "never" && confirm === undefined) {
    throw invalid(`confirmPolicy "${policy}" needs a confirm function to ask with.`);
  }
  if (network === PUBNET && canSign && confirm === undefined && requested !== "never") {
    throw invalid(
      'pubnet payments need a confirmation choice: pass confirm (asked before the first payment of each budget window to each recipient and listing), or confirmPolicy: "never" for a headless agent bounded by its caps alone.',
    );
  }
  // Approvals, each keyed by everything it was shown for: one approval never covers a payment to
  // another recipient, listing, resource, asset or settlement authority.
  const confirmed = new Set<string>();
  const approvalScope: SignIntent["approvalScope"] = policy === "first-per-session" ? "recipient" : "payment";

  return {
    policy,
    approve: async (base, onEvent) => {
      const scopeKey = approvalKey(base);
      const firstInSession = !confirmed.has(scopeKey);
      const intent: SignIntent = { ...base, firstInSession, approvalScope };
      const ask = policy === "every" || (policy === "first-per-session" && firstInSession);
      if (ask && confirm !== undefined) {
        let approved: boolean;
        try {
          // Only a literal true approves, whatever a caller's function returns.
          const answer: unknown = await confirm(Object.freeze({ ...intent }));
          approved = answer === true;
        } catch (error) {
          // A PaymentError is a decision (refused, or no way to ask) and is recorded as one. Any other
          // error, such as a host's signal that the user must be asked first, is not a refusal: it
          // reaches the caller without a refused event, and nothing is signed either way.
          if (isPaymentError(error)) {
            emit(onEvent, { type: "refused", callId: intent.callId, code: error.code });
          }
          throw error;
        }
        if (!approved) {
          emit(onEvent, { type: "refused", callId: intent.callId, code: "payment_confirmation_declined" });
          throw paymentError("payment_confirmation_declined", {
            reason: `The payment of ${intent.amount.decimal} ${intent.asset.symbol} to ${intent.payTo} on ${intent.network} was not confirmed; nothing was signed.`,
            callId: intent.callId,
          });
        }
        confirmed.add(scopeKey);
      }
      if (onBeforeSign !== undefined) {
        try {
          onBeforeSign(Object.freeze({ ...intent }));
        } catch {
          // Observers only.
        }
      }
    },
  };
}

/** What one `first-per-session` approval covers: the window, recipient, listing or resource, asset and authority. */
function approvalKey(intent: SignIntentInput): string {
  return JSON.stringify([
    intent.session.window,
    baseAccount(intent.payTo) ?? intent.payTo,
    intent.listingId === null ? `resource:${intent.resource}` : `listing:${intent.listingId}`,
    intent.asset.contract,
    intent.scheme,
    intent.facilitator,
  ]);
}

function invalid(reason: string) {
  return paymentError("payment_policy_invalid", { reason: `Invalid buyer options: ${reason}` });
}
