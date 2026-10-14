/**
 * Event logs of every scenario, experiment and check, and of wallet setup, recorded from real runs on
 * the local stack (record.ts): the lab's runs in Chromium through the page, the checks and the
 * setup by the engine in Node. Each log is one complete run, as its run report holds it.
 */
import type { CheckId, LabEvent, ScenarioId } from "../../src/engine/events.ts";
import type { RunReport } from "../../src/engine/types.ts";
import type { ExperimentId } from "../../../src/shared/lab.ts";
import agentNormal from "./recorded/agent-normal.json" with { type: "json" };
import checkAmount from "./recorded/check-amount.json" with { type: "json" };
import checkAsset from "./recorded/check-asset.json" with { type: "json" };
import checkNetwork from "./recorded/check-network.json" with { type: "json" };
import checkPerCallCap from "./recorded/check-per-call-cap.json" with { type: "json" };
import checkPrivateAddress from "./recorded/check-private-address.json" with { type: "json" };
import checkRecipient from "./recorded/check-recipient.json" with { type: "json" };
import checkSessionBudget from "./recorded/check-session-budget.json" with { type: "json" };
import payLowCap from "./recorded/pay-low-cap.json" with { type: "json" };
import payMcpListing from "./recorded/pay-mcp-listing.json" with { type: "json" };
import payNormal from "./recorded/pay-normal.json" with { type: "json" };
import payReplay from "./recorded/pay-replay.json" with { type: "json" };
import sellNormal from "./recorded/sell-normal.json" with { type: "json" };
import uptoNormal from "./recorded/upto-normal.json" with { type: "json" };
import uptoOvercharge from "./recorded/upto-overcharge.json" with { type: "json" };
import walletFund from "./recorded/wallet-fund.json" with { type: "json" };

/** The events of a recorded run report. */
function events(recorded: unknown): readonly LabEvent[] {
  const report = recorded as { readonly [key in keyof RunReport]?: unknown };
  if (report.format !== "rail402-playground-run" || report.version !== 1 || !Array.isArray(report.events)) {
    throw new Error("not a recorded run report");
  }
  return report.events as LabEvent[];
}

/** Runs by `scenario:experiment`, for every combination the lab offers. */
export const SCENARIO_RUNS: Readonly<Record<string, readonly LabEvent[]>> = {
  "pay:normal": events(payNormal),
  "pay:low-cap": events(payLowCap),
  "pay:replay": events(payReplay),
  "upto:normal": events(uptoNormal),
  "upto:overcharge": events(uptoOvercharge),
  "agent:normal": events(agentNormal),
  "sell:normal": events(sellNormal),
};

/** The run of a scenario and experiment; every offered combination has one. */
export function scenarioRun(scenario: ScenarioId, experiment: ExperimentId): readonly LabEvent[] {
  const log = SCENARIO_RUNS[`${scenario}:${experiment}`];
  if (log === undefined) throw new Error(`no fixture for ${scenario}:${experiment}`);
  return log;
}

/** An MCP tool from the Bazaar, paid on the Pay page (the Bazaar's Try on an MCP listing). */
export const PAY_MCP_LISTING_RUN: readonly LabEvent[] = events(payMcpListing);

export const CHECK_RUNS: Readonly<Record<CheckId, readonly LabEvent[]>> = {
  network: events(checkNetwork),
  asset: events(checkAsset),
  amount: events(checkAmount),
  recipient: events(checkRecipient),
  "per-call-cap": events(checkPerCallCap),
  "session-budget": events(checkSessionBudget),
  "private-address": events(checkPrivateAddress),
};

/** Wallet setup: Friendbot, then the trustline and the purchase, each a transaction. */
export const WALLET_FUND: readonly LabEvent[] = events(walletFund);
