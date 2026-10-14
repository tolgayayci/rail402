/**
 * Send it twice: pays the weather endpoint once, then sends the identical paid request again, straight
 * through the transport. The SDK is not involved in the resend, so nothing is signed or reserved. The
 * seller asks Rail402 to verify it, Rail402 finds the authorization's nonce already used (or, when the
 * resend comes too late, the authorization expired), and the seller answers 402: the payer is charged
 * once, which the balance read after the resend shows. The run claims that only when the first
 * payment is proven on chain, the copy was refused with one of those codes, and the balance held.
 */
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { untrustedReason } from "@rail402.dev/sdk/browser";
import { clientError } from "../errors.ts";
import { REPLAY_REFUSAL_CODES } from "../../../../src/shared/lab.ts";
import { toAtomic } from "../../projection/format.ts";
import {
  outcomeOf,
  payHttp,
  lastTxLedger,
  readBalance,
  reportBalance,
  reportRefusal,
  settledOutcome,
  type Outcome,
  type RunContext,
} from "../scenarios/context.ts";
import { weatherUrl } from "../scenarios/pay.ts";

export async function runReplay(
  context: RunContext,
  params?: Readonly<Record<string, string | number>>,
): Promise<Outcome> {
  const held = context.replay();
  try {
    const first = await payHttp(context, weatherUrl(context, params));
    if (!first.ok) return outcomeOf(first.error);
    if (!first.result.paid || !held.held) {
      return {
        status: "info",
        reason: "The resource answered without asking for payment; there is nothing to resend.",
      };
    }
    const payment = first.result.payment;
    if (payment?.status !== "settled" || !payment.verifiedOnChain) {
      // Without a proven first payment, a refused copy would show nothing.
      return settledOutcome(first.result, "");
    }
    // Read as of the first payment's settlement, so a node behind it cannot show the payment as the resend.
    const before = await readBalance(context, lastTxLedger(context));
    let response: Response;
    try {
      response = await held.resend();
    } catch (error) {
      const coded = reportRefusal(context, error);
      await reportBalance(context, before);
      return { status: "error", code: coded.code, reason: coded.reason };
    }
    const required = response.headers.get("payment-required");
    await response.body?.cancel().catch(() => undefined);
    let code: string | undefined;
    try {
      const error = required === null ? undefined : decodePaymentRequiredHeader(required).error;
      // Only a code-shaped answer is a code; seller text is never looked up as one.
      code = typeof error === "string" && REFUSAL_CODE.test(error) ? untrustedReason(error, 100) : undefined;
    } catch {
      code = undefined;
    }
    const after = await reportBalance(context, before);
    if (response.status !== 402) {
      return {
        status: "error",
        code: clientError("playground_unexpected_error").code,
        reason: `The seller answered the repeated payment with HTTP ${String(response.status)} instead of refusing it.`,
      };
    }
    const meaning =
      code === undefined || !Object.hasOwn(REPLAY_REFUSAL_CODES, code)
        ? undefined
        : REPLAY_REFUSAL_CODES[code];
    const refusedCode = code ?? "payment_rejected";
    context.run.emit({
      kind: "refusal",
      layer: "facilitator",
      code: refusedCode,
      reason:
        meaning === undefined
          ? "The seller refused the repeated payment."
          : `The seller refused the repeated payment: ${meaning}.`,
      details: { status: 402 },
    });
    const moved = balanceMoved(before, after, context.config.asset.decimals);
    if (moved !== false) {
      return {
        status: "error",
        code: clientError("playground_unexpected_error").code,
        reason:
          moved === true
            ? "Your balance moved around the repeated payment although the seller refused it."
            : "Your balance could not be read around the repeated payment, so a single charge is not proven.",
      };
    }
    if (meaning === undefined) {
      return {
        status: "error",
        code: refusedCode,
        reason:
          "The seller refused the repeated payment, but not because its authorization was used or expired.",
      };
    }
    return {
      status: "info",
      code: refusedCode,
      reason: `Paid once: the same payment sent again was refused (${meaning}), and your balance did not move.`,
    };
  } finally {
    held.drop();
  }
}

/** What a refusal code looks like; anything else a seller sends is not read as one. */
const REFUSAL_CODE = /^[a-z][a-z0-9_]{0,99}$/;

/** Whether a balance moved between two reads; undefined when either is unknown. */
export function balanceMoved(
  before: string | null,
  after: string | null,
  decimals: number,
): boolean | undefined {
  if (before === null || after === null) return undefined;
  const a = toAtomic(before, decimals);
  const b = toAtomic(after, decimals);
  if (a === undefined || b === undefined) return undefined;
  return a !== b;
}
