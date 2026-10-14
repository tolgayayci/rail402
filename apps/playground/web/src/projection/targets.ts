/** What each lab scenario calls, for the flow header and the lanes, from the configuration. */
import type { ScenarioId } from "../engine/events.ts";
import type { PublicConfig } from "../engine/types.ts";
import { SCENARIO_DEFAULTS, type ExperimentId } from "../../../src/shared/lab.ts";
import { hostOf } from "./format.ts";
import type { LaneOptions } from "./lanes.ts";

export interface ScenarioTarget {
  readonly method: string;
  /** The URL called, or the agent's question. */
  readonly target: string;
  readonly isUrl: boolean;
  readonly lanes: LaneOptions;
}

function withQuery(base: string, path: string, query: Readonly<Record<string, string>>): string {
  const url = new URL(path, base.endsWith("/") ? base : `${base}/`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.href;
}

export function scenarioTarget(
  scenario: ScenarioId,
  experiment: ExperimentId,
  config: PublicConfig,
): ScenarioTarget {
  const demo = config.urls.demoSeller;
  switch (scenario) {
    case "pay":
      return {
        method: "GET",
        target: withQuery(demo, SCENARIO_DEFAULTS.pay.path, SCENARIO_DEFAULTS.pay.query),
        isUrl: true,
        lanes: { sellerHost: hostOf(demo) },
      };
    case "upto":
      if (experiment === "overcharge") {
        return {
          method: "GET",
          target: withQuery(config.urls.public, config.lab.paths.greedy, SCENARIO_DEFAULTS.upto.query),
          isUrl: true,
          lanes: { sellerHost: `${hostOf(config.urls.public)} (overcharges)`, sellerLabel: "Greedy API" },
        };
      }
      return {
        method: "GET",
        target: withQuery(demo, SCENARIO_DEFAULTS.upto.path, SCENARIO_DEFAULTS.upto.query),
        isUrl: true,
        lanes: { sellerHost: hostOf(demo) },
      };
    case "agent": {
      const { city, hours } = SCENARIO_DEFAULTS.agent.arguments;
      return {
        method: "MCP",
        target: `“What will the weather be in ${city} over the next ${String(hours)} hours?”`,
        isUrl: false,
        lanes: { sellerHost: hostOf(demo) },
      };
    }
    case "sell":
      return {
        method: "GET",
        target: new URL(
          config.lab.paths.sell.replace(":city", encodeURIComponent(SCENARIO_DEFAULTS.sell.city)),
          config.urls.public,
        ).href,
        isUrl: true,
        lanes: { sellerHost: hostOf(config.urls.public) },
      };
  }
}
