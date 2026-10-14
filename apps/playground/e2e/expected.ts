/**
 * The swimlane each lab run must draw, as `step lane status source` per row in drawing order. Shared
 * by the browser tests and the live Playground evidence run, so both hold the page to the same rows.
 */

/** Paying an HTTP resource with `exact`, from the request to the delivered answer. */
const PAID_EXACT = [
  "request 0→1 done you",
  "quote 1→0 done seller",
  "sign self 0 done you",
  "paid-request 0→1 done you",
  "settle 1→2 done seller",
  "submit 2→3 done chain",
  "deliver 1→0 done you",
] as const;

/** The first four rows of an `upto` payment, before the seller does the work. */
const UPTO_AUTHORIZED = [
  "request 0→1 done you",
  "quote 1→0 done seller",
  "sign self 0 done you",
  "paid-request 0→1 done you",
  "work self 1 done seller",
] as const;

export const LAB_ROWS = Object.freeze({
  "pay-normal": PAID_EXACT,
  /** An MCP tool from the Bazaar, paid on the Pay page: the tool calls, not the transport's requests. */
  "pay-mcp-listing": PAID_EXACT,
  "pay-low-cap": ["request 0→1 done you", "quote 1→0 done seller", "refused self 0 error you"],
  /** The rows after the first payment's seven. */
  "pay-replay-tail": [
    "resend 0→1 done you",
    "replay-refused 1→0 error seller",
    "charged-once self 0 done chain",
  ],
  "upto-normal": [
    ...UPTO_AUTHORIZED,
    "settle 1→2 done seller",
    "submit 2→3 done chain",
    "deliver 1→0 done you",
  ],
  "upto-overcharge": [
    ...UPTO_AUTHORIZED,
    "settle 1→2 error seller",
    "overcharge-refused self 2 error seller",
    "deliver 1→0 error seller",
  ],
  "agent-normal": [
    "search 0→1 done you",
    "results 1→0 done bazaar",
    "pick self 0 done you",
    "budget self 0 done you",
    "call-tool 0→2 done you",
    "tool-settle 2→3 done chain",
    "tool-result 2→0 done you",
  ],
  "sell-normal": [
    "request 0→1 done you",
    "quote 1→0 done seller",
    "paid-request 0→1 done you",
    "settle 1→2 done seller",
    "catalog 2→3 done bazaar",
    "origin-check 2→1 done bazaar",
    "listed self 3 done bazaar",
  ],
} satisfies Record<string, readonly string[]>);

/** The outcome badge each lab run ends with. */
export const LAB_BADGES = Object.freeze({
  "pay-normal": "Paid and delivered",
  "pay-low-cap": "Refused safely",
  "pay-replay": "Paid once",
  "upto-normal": "Charged for usage",
  "upto-overcharge": "Overcharge blocked",
  "agent-normal": "Agent paid within budget",
  "sell-normal": "Earned and listed",
});
