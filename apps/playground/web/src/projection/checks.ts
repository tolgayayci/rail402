/**
 * The result of a refusal check, from its events only: the code it ended with against the one it
 * expects, and proof from the payer's balance read before and after that nothing moved (or, for the
 * session-budget check, exactly its one first payment).
 */
import type { CheckId, LabEvent } from "../engine/events.ts";
import { CHECK_EXPECTED_CODES, SESSION_CHECK_WINDOW } from "../../../src/shared/lab.ts";
import { collectFacts, sdkEvents } from "./facts.ts";
import { decimalDelta, toAtomic } from "./format.ts";

/** The result of a refusal check: the code against the expected one, and proof that nothing moved. */
export interface CheckResult {
  readonly check: CheckId;
  readonly finished: boolean;
  readonly expected: string;
  readonly code: string | null;
  readonly reason: string | null;
  readonly layer: string | null;
  readonly passed: boolean;
  readonly signed: number;
  readonly reserved: number;
  readonly transactions: number;
  /** The transactions the check settled on purpose (the session check's first payment), with their links. */
  readonly paid: readonly { readonly hash: string; readonly explorerUrl: string }[];
  readonly balance: "unchanged" | "changed" | "unknown";
  /** The payer's balance change over the whole check, decimal and signed; null when unread. */
  readonly delta: string | null;
}

export function projectCheck(check: CheckId, events: readonly LabEvent[], decimals: number): CheckResult {
  const facts = collectFacts(events);
  const refusal = facts.refusals.at(-1);
  const code = facts.end?.code ?? refusal?.code ?? null;
  // Over the whole check: the session check pays once before its second payment is refused.
  const balance = facts.payerBalance;
  const delta = balance === undefined ? undefined : decimalDelta(balance.before, balance.after, decimals);
  const expected = CHECK_EXPECTED_CODES[check];
  const signed = sdkEvents(facts, "signed").length;
  const reserved = sdkEvents(facts, "reserved").length;
  const moved = delta === undefined ? undefined : toAtomic(delta, decimals);
  const balanceState = moved === undefined ? "unknown" : moved === 0n ? "unchanged" : "changed";
  // Proof that only what the check allows moved, from a balance read before and after: nothing for a
  // refusal check; for the session check, exactly one price when its first payment was signed.
  const price = toAtomic(SESSION_CHECK_WINDOW.total, decimals) ?? 0n;
  const moneyProven =
    check === "session-budget"
      ? signed <= 1 && reserved <= 1 && moved !== undefined && moved === (signed === 1 ? -price : 0n)
      : signed === 0 && reserved === 0 && balanceState === "unchanged";
  return {
    check,
    finished: facts.end !== undefined,
    expected,
    code,
    reason: facts.end?.reason ?? refusal?.reason ?? null,
    layer: refusal?.layer ?? null,
    passed: facts.end?.status === "refused" && code === expected && moneyProven,
    signed,
    reserved,
    transactions: facts.txs.length,
    paid: facts.txs
      .filter((tx) => tx.status === "SUCCESS")
      .map((tx) => ({ hash: tx.hash, explorerUrl: tx.explorerUrl })),
    balance: balanceState,
    delta: delta ?? null,
  };
}
