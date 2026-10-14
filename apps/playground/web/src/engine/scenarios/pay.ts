/**
 * Pay for an API (exact): the demo seller's weather endpoint, paid once under the run's cap. The
 * "cap below the price" experiment runs the same call with the low cap preset, so the buyer refuses
 * the seller's price before anything is signed.
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

/** The demo seller's weather URL with the run's parameters. */
export function weatherUrl(
  context: Pick<RunContext, "config">,
  params?: Readonly<Record<string, string | number>>,
): string {
  const { path, query } = SCENARIO_DEFAULTS.pay;
  return urlOf(context.config.urls.demoSeller, path, withParams(query, params));
}

export async function runPay(
  context: RunContext,
  params?: Readonly<Record<string, string | number>>,
): Promise<Outcome> {
  const paid = await payHttp(context, weatherUrl(context, params));
  if (!paid.ok) return outcomeOf(paid.error);
  return settledOutcome(paid.result, "Paid and delivered.");
}
