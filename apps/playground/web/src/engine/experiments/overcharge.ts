/**
 * Seller charges over the cap: the Playground's greedy lab seller quotes an upto cap, then asks Rail402
 * to settle twice that. Rail402 refuses the settlement, the seller answers 402 with the refusal, and no
 * transaction is made. The authorization's hold returns to the budget once it expires unused, which
 * the background reconciliation proves and reports on this run.
 */
import { LAB_PATHS, OVERCHARGE_REFUSAL_CODE } from "../../../../src/shared/lab.ts";
import { clientError, upstreamCode } from "../errors.ts";
import { outcomeOf, payHttp, type Outcome, type RunContext } from "../scenarios/context.ts";
import { balanceMoved } from "./replay.ts";
import { historyUrl } from "../scenarios/upto.ts";

export async function runOvercharge(
  context: RunContext,
  params?: Readonly<Record<string, string | number>>,
): Promise<Outcome> {
  const paid = await payHttp(context, historyUrl(context.config.urls.public, LAB_PATHS.greedy, params));
  if (paid.ok) {
    if (paid.result.paid)
      return { status: "error", ...unexpected("The seller's overcharge was not refused.") };
    return {
      status: "info",
      reason:
        "The seller answered without asking for payment, so the experiment did not run; nothing was paid.",
    };
  }
  const refused = upstreamCode(paid.error);
  // Only Rail402's own refusal of the settlement shows the cap holding; anything else stopped earlier.
  if (refused !== OVERCHARGE_REFUSAL_CODE) return outcomeOf(paid.error);
  const balance = lastPayerBalance(context);
  const moved =
    balance === undefined
      ? undefined
      : balanceMoved(balance.before, balance.after, context.config.asset.decimals);
  if (moved !== false) {
    return {
      status: "error",
      ...unexpected(
        moved === true
          ? "Rail402 refused the overcharge, but your balance moved."
          : "Rail402 refused the overcharge, but your balance could not be read to show nothing moved.",
      ),
    };
  }
  return {
    status: "refused",
    code: refused,
    reason: "Overcharge blocked: Rail402 refused to settle more than the authorized cap, and nothing moved.",
  };
}

/** The payer balance the run read last. */
function lastPayerBalance(
  context: RunContext,
): { readonly before: string | null; readonly after: string | null } | undefined {
  for (let index = context.run.events.length - 1; index >= 0; index--) {
    const event = context.run.events[index];
    if (event?.kind === "chain" && event.phase === "balance" && event.role === "payer") return event;
  }
  return undefined;
}

function unexpected(reason: string): { code: string; reason: string } {
  const { code } = clientError("playground_unexpected_error");
  return { code, reason };
}
