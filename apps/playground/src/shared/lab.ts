/**
 * The Playground's fixed vocabulary: lab seller paths and prices, scenario, experiment and check ids,
 * the default targets, and the step ids the code panel highlights. Shared by the server (routes), the
 * engine (targets) and the page (labels and the code panel).
 */

/** Routes of the Playground's own sellers. Only these are called directly, without the relay. */
export const LAB_PATHS = Object.freeze({
  /** The sandbox seller, listed in the Bazaar: exact, LAB_PRICES.sell, with discovery metadata. */
  sell: "/lab/sell/forecast/:city",
  /** An upto seller that settles more than the authorized cap on purpose; Rail402 refuses it. */
  greedy: "/lab/greedy/history",
  /** 402-only offers that a buyer's policy must refuse; they never verify or settle. */
  offers: Object.freeze({
    pubnet: "/lab/offers/pubnet",
    asset: "/lab/offers/asset",
    zero: "/lab/offers/zero",
  }),
});

/** Prefix shared by every lab route. */
export const LAB_PREFIX = "/lab/";

/** The city the sandbox seller's listing shows as its example. */
export const SANDBOX_EXAMPLE_CITY = "Ankara";

/** The sandbox seller's URL for one city. */
export function sellPath(city: string): string {
  return LAB_PATHS.sell.replace(":city", encodeURIComponent(city));
}

/** Lab prices: decimal USDC (7 decimals) and the same amounts in base units. */
export const LAB_PRICES = Object.freeze({
  sell: Object.freeze({ decimal: "0.01", atomic: "100000" }),
  /** The cap the greedy seller quotes. */
  greedyCap: Object.freeze({ decimal: "0.01", atomic: "100000" }),
  /** What the greedy seller then asks Rail402 to settle: twice the cap. */
  greedyCharge: Object.freeze({ decimal: "0.02", atomic: "200000" }),
});

/** `maxTimeoutSeconds` of the greedy seller, so a refused hold returns to the budget within a minute. */
export const GREEDY_MAX_TIMEOUT_SECONDS = 60;

export const SCENARIO_IDS = Object.freeze(["pay", "upto", "agent"] as const);
export type ScenarioId = (typeof SCENARIO_IDS)[number];

export const EXPERIMENT_IDS = Object.freeze(["normal", "replay", "overcharge"] as const);
export type ExperimentId = (typeof EXPERIMENT_IDS)[number];

/** The experiments each scenario offers; `normal` first. */
export const SCENARIO_EXPERIMENTS: Readonly<Record<ScenarioId, readonly ExperimentId[]>> = Object.freeze({
  pay: Object.freeze(["normal", "replay"] as const),
  upto: Object.freeze(["normal", "overcharge"] as const),
  agent: Object.freeze(["normal"] as const),
});

/** Refusal checks, tried from the Lab. Each must end refused, with nothing signed. */
export const CHECK_IDS = Object.freeze([
  "network",
  "asset",
  "amount",
  "recipient",
  "per-call-cap",
  "session-budget",
  "private-address",
] as const);
export type CheckId = (typeof CHECK_IDS)[number];

/** The code each check expects. */
export const CHECK_EXPECTED_CODES: Readonly<Record<CheckId, string>> = Object.freeze({
  network: "payment_network_not_permitted",
  asset: "payment_asset_not_permitted",
  amount: "payment_amount_not_permitted",
  recipient: "payment_recipient_not_permitted",
  "per-call-cap": "payment_per_call_cap_exceeded",
  "session-budget": "payment_session_cap_exceeded",
  "private-address": "egress_destination_not_allowed",
});

/** The facilitator's refusal of a payment whose authorization was already used: the one a replay expects. */
export const REPLAY_REFUSAL_CODE = "invalid_exact_stellar_payload_nonce_already_used";

/**
 * The facilitator's refusals of a repeated payment, with what each means: the nonce was already used,
 * or the copy came after the authorization expired. Either way it cannot be paid again.
 */
export const REPLAY_REFUSAL_CODES: Readonly<Record<string, string>> = Object.freeze({
  [REPLAY_REFUSAL_CODE]: "its authorization was already used once",
  invalid_exact_stellar_signature_expired: "its authorization has expired",
});

/** The facilitator's refusal of an upto settlement above the signed cap. */
export const OVERCHARGE_REFUSAL_CODE = "invalid_upto_stellar_payload_settlement_exceeds_amount";

/**
 * What a run needs from the server: the relay (to reach the demo seller and other sellers) and the
 * lab sellers (the Playground's own routes). A switched-off feature takes what needs it off the page.
 */
export const SCENARIO_NEEDS: Readonly<Record<ScenarioId, readonly ("relay" | "lab")[]>> = Object.freeze({
  pay: ["relay"],
  upto: ["relay"],
  agent: ["relay"],
});
export const EXPERIMENT_NEEDS: Readonly<Record<ExperimentId, readonly ("relay" | "lab")[]>> = Object.freeze({
  normal: [],
  replay: ["relay"],
  overcharge: ["lab"],
});
export const CHECK_NEEDS: Readonly<Record<CheckId, readonly ("relay" | "lab")[]>> = Object.freeze({
  network: ["lab"],
  asset: ["lab"],
  amount: ["lab"],
  recipient: ["relay"],
  "per-call-cap": ["relay"],
  "session-budget": ["relay"],
  "private-address": ["relay"],
});

/** Private and metadata addresses the private-address check tries to pay. */
export const PRIVATE_ADDRESS_TARGETS = Object.freeze(["https://127.0.0.1/", "https://169.254.169.254/"]);

/**
 * The session-budget check pays from your own budget window, with room for exactly one payment of
 * `total` left in it (its per-call ceiling is this amount too), so the second payment cannot fit.
 */
export const SESSION_CHECK_WINDOW = Object.freeze({ total: "0.001" });

/** Default caps, decimal USDC. The page can only lower the session total. */
export const DEFAULT_CAPS = Object.freeze({
  perCall: "0.01",
  /** A cap below the demo price, which the per-call cap check pays with. */
  lowCap: "0.0005",
  perCallCeiling: "0.1",
  sessionTotal: "1",
  sessionTtlMs: 24 * 60 * 60 * 1_000,
});

/**
 * How the page labels the agent scenario's agent: scripted, not a language model, and pinned to the
 * demo seller's tool.
 */
export const AGENT_PLANNER_LABEL =
  "A scripted agent, not a language model: it always searches, checks its budget and pays the best match from the demo seller, with the real rail402-mcp tools. The Agents page shows how to give the same tools to any MCP client.";

/** Default scenario inputs; paths are relative to the configured demo seller or the Playground. */
export const SCENARIO_DEFAULTS = Object.freeze({
  pay: Object.freeze({ path: "/weather", query: Object.freeze({ city: "Ankara" }) }),
  upto: Object.freeze({ path: "/history", query: Object.freeze({ city: "Berlin", days: "7" }) }),
  agent: Object.freeze({
    query: "air quality",
    type: "mcp" as const,
    maxPrice: Object.freeze({ amount: "0.05", asset: "USDC" }),
    toolName: "air_quality",
    minimumTrust: "origin_verified" as const,
    arguments: Object.freeze({ city: "Istanbul" }),
    /** The agent's per-call limit the Lab starts with, as the Agents page suggests for any agent. */
    cap: "0.05",
  }),
});

/** Idempotency keys of Playground runs: `pg_` and the run id. */
export function runIdempotencyKey(runId: string): string {
  return `pg_${runId}`;
}

/**
 * Step ids: one per kind of swimlane row. Code-panel snippets mark the lines of a step with
 * `// @step:<id>`, and selecting a row highlights them.
 */
export const STEP_IDS = Object.freeze([
  // Paying an HTTP resource (pay, upto)
  "request",
  "quote",
  "refused",
  "sign",
  "paid-request",
  "work",
  "settle",
  "submit",
  "deliver",
  // Send it twice
  "resend",
  "replay-refused",
  "charged-once",
  // Seller charges over the cap
  "overcharge-refused",
  // Agent pays a tool
  "search",
  "results",
  "pick",
  "budget",
  "call-tool",
  "tool-settle",
  "tool-result",
] as const);
export type StepId = (typeof STEP_IDS)[number];
