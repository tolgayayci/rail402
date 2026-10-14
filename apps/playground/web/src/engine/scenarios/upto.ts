/**
 * Pay per use (upto): the demo seller's history endpoint quotes a cap, the payer authorizes up to it,
 * and the seller settles what the work cost. The unused part of the cap returns to the session budget
 * once the settlement is proven on chain (`released settled_below_cap`).
 */
import { SCENARIO_DEFAULTS } from "../../../../src/shared/lab.ts";
import {
  outcomeOf,
  payHttp,
  settledOutcome,
  urlOf,
  withParams,
  type Outcome,
  type RunContext,
} from "./context.ts";

export function historyUrl(
  base: string,
  path: string,
  params?: Readonly<Record<string, string | number>>,
): string {
  return urlOf(base, path, withParams(SCENARIO_DEFAULTS.upto.query, params));
}

export async function runUpto(
  context: RunContext,
  params?: Readonly<Record<string, string | number>>,
): Promise<Outcome> {
  const paid = await payHttp(
    context,
    historyUrl(context.config.urls.demoSeller, SCENARIO_DEFAULTS.upto.path, params),
  );
  if (!paid.ok) return outcomeOf(paid.error);
  const settled = paid.result.payment?.settled?.amount;
  const authorized = paid.result.payment?.authorized.amount;
  return settledOutcome(
    paid.result,
    settled === undefined || authorized === undefined
      ? "Paid for what was used."
      : `Settled ${settled} of ${authorized} authorized; the rest returns to the budget.`,
  );
}
