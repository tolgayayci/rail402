/**
 * The swimlane each Lab run must end with, as `step lane look` per row in drawing order: the step's
 * kind, its lanes (`from→to` for a message, `self n` for a step inside one lane) and how it ended.
 * Shared by the browser tests and the live Playground evidence run, so both hold the page to the same
 * rows.
 */

/** Paying an HTTP resource with `exact`, from the request to the delivered answer. */
const PAID_EXACT = [
  "request 0→1 done",
  "quote 1→0 done",
  "sign self 0 done",
  "paid 0→1 done",
  "settle 1→2 done",
  "submit 2→3 done",
  "deliver 1→0 done",
] as const;

/** A buyer-side refusal: the price is read, then refused before anything is signed. */
const REFUSED_BEFORE_SIGNING = ["request 0→1 done", "quote 1→0 done", "refused self 0 error"] as const;

export const LAB_STEPS = Object.freeze({
  "exact-normal": PAID_EXACT,
  "exact-low-cap": REFUSED_BEFORE_SIGNING,
  "upto-normal": [
    "request 0→1 done",
    "quote 1→0 done",
    "sign self 0 done",
    "paid 0→1 done",
    "work self 1 done",
    "settle 1→2 done",
    "submit 2→3 done",
    "deliver 1→0 done",
  ],
  "agent-normal": [
    "search 0→1 done",
    "results 1→0 done",
    "budget self 0 done",
    "call 0→2 done",
    "quote 2→0 done",
    "sign self 0 done",
    "paid 0→2 done",
    "settle 2→3 done",
    "submit 3→4 done",
    "deliver 2→0 done",
  ],
  /** A URL the relay refuses to reach: the request never gets through. */
  "egress-refused": ["request 0→1 error"],
  replay: [...PAID_EXACT, "resend 0→1 done", "replay-refused 1→0 error", "charged-once self 0 done"],
  overcharge: [
    "request 0→1 done",
    "quote 1→0 done",
    "sign self 0 done",
    "paid 0→1 done",
    "work self 1 done",
    "settle 1→2 error",
    "overcharge-refused self 2 error",
    "deliver 1→0 error",
  ],
  "check-before-signing": REFUSED_BEFORE_SIGNING,
  /** The session check pays once within its window, then refuses the second payment. */
  "check-session-budget": [...PAID_EXACT, "refused self 0 error"],
  /** Both private addresses are refused by the relay. */
  "check-private-address": ["request 0→1 error", "request 0→1 error"],
} satisfies Record<string, readonly string[]>);
