/**
 * Swimlanes: the four parties of each scenario, left to right. A lane's tone is the party's colour
 * (`tokens.css`); a row names its lanes by index.
 */
import type { ScenarioId } from "../engine/events.ts";

/** Who a lane stands for; each has its own colour. */
export type LaneTone = "you" | "seller" | "rail" | "stellar" | "bazaar";

export interface Lane {
  readonly tone: LaneTone;
  readonly label: string;
  /** A short role or host line under the label. */
  readonly role: string;
}

export interface LaneOptions {
  /** The seller's host, shown under its lane. */
  readonly sellerHost: string;
  /** Overrides the seller lane's name, such as `Seller` for a URL the visitor chose. */
  readonly sellerLabel?: string;
  /**
   * Overrides the facilitator lane's name: `Facilitator` for a seller whose facilitator is not shown
   * to be Rail402 (its fee payer or settler is not advertised in Rail402's /supported).
   */
  readonly facilitatorLabel?: string;
}

/** The lanes of a scenario. Rows refer to them by index, 0 to 3. */
export function lanesFor(scenario: ScenarioId, options: LaneOptions): readonly Lane[] {
  const seller = (label: string, role = options.sellerHost): Lane => ({
    tone: "seller",
    label: options.sellerLabel ?? label,
    role,
  });
  const rail = options.facilitatorLabel ?? "Rail402";
  switch (scenario) {
    case "pay":
      return [
        { tone: "you", label: "You", role: "your app" },
        seller("Weather API"),
        { tone: "rail", label: rail, role: "facilitator" },
        { tone: "stellar", label: "Stellar", role: "testnet" },
      ];
    case "upto":
      return [
        { tone: "you", label: "You", role: "your app" },
        seller("History API"),
        { tone: "rail", label: rail, role: "facilitator" },
        { tone: "stellar", label: "Stellar", role: "upto contract" },
      ];
    case "agent":
      return [
        { tone: "you", label: "Your agent", role: "rail402-mcp tools" },
        { tone: "bazaar", label: "Bazaar", role: "search" },
        seller("Forecast tool", "MCP server"),
        { tone: "rail", label: "Rail402", role: "settles on Stellar" },
      ];
    case "sell":
      return [
        { tone: "you", label: "A buyer", role: "you, in this tab" },
        seller("Sample API", "stands in for yours"),
        { tone: "rail", label: "Rail402", role: "facilitator" },
        { tone: "bazaar", label: "Bazaar", role: "discovery" },
      ];
  }
}

/** Lane indices by scenario, so rows read as names instead of numbers. */
export const LANE = Object.freeze({
  http: Object.freeze({ you: 0, seller: 1, rail: 2, stellar: 3 }),
  agent: Object.freeze({ agent: 0, bazaar: 1, tool: 2, rail: 3 }),
  sell: Object.freeze({ buyer: 0, api: 1, rail: 2, bazaar: 3 }),
});
