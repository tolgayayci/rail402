/**
 * What a run is waiting for while its current step stays on screen: the message still in flight
 * (the paid request while the seller verifies and the facilitator settles, a chain read), said in
 * plain words. Derived from the steps only: the current step still going, or the step that comes next
 * and has not happened yet.
 */
import { useEffect, useState } from "react";
import type { StageLane, StageStep, StepKind } from "../../projection/stage.ts";

/** How long a wait lasts before it is named, so quick steps do not flash a line. */
export const WAIT_SHOWN_AFTER_MS = 1_500;

interface Names {
  /** "Rail402", or "the facilitator" for another seller's. */
  readonly facilitator: string;
  /** "the API" or "the tool". */
  readonly seller: string;
}

function namesOf(lanes: readonly StageLane[], agent: boolean): Names {
  const rail = lanes.find((lane) => lane.tone === "rail")?.label;
  return {
    facilitator: rail === undefined || rail === "Facilitator" ? "the facilitator" : rail,
    seller: agent ? "the tool" : "the API",
  };
}

/** What a step still going is waiting for. */
function liveText(kind: StepKind, names: Names): string {
  const texts: Partial<Record<StepKind, string>> = {
    request: `Waiting for ${names.seller} to answer`,
    call: `Waiting for ${names.seller} to answer`,
    sign: "Your wallet is signing",
    paid: `Waiting for ${names.seller} to check the payment and ${names.facilitator} to settle it on Stellar`,
    search: "Waiting for the Bazaar",
  };
  return texts[kind] ?? "Waiting for the next message";
}

/** What the step to come is waiting for. */
function nextText(kind: StepKind, names: Names): string {
  const texts: Partial<Record<StepKind, string>> = {
    quote: `Waiting for ${names.seller} to name its price`,
    sign: "Your wallet is signing",
    paid: "Sending the paid request",
    work: `Waiting for ${names.seller} to do the work`,
    settle: `Waiting for ${names.seller} to check the payment and ${names.facilitator} to settle it on Stellar`,
    submit: "Reading the transaction from Stellar",
    deliver: `Waiting for ${names.seller}'s answer`,
    results: "Waiting for the Bazaar's results",
    budget: "Checking the agent's limits",
    call: "Calling the tool",
  };
  return texts[kind] ?? "Waiting for the next step";
}

/**
 * The wait behind the current step, or null when the next step is already there to show. With no
 * step to come and the run still going, it is the last chain read: the balance after the payment.
 */
export function waitingFor(
  steps: readonly StageStep[],
  currentId: string,
  lanes: readonly StageLane[],
  options: { readonly ended: boolean; readonly agent: boolean },
): string | null {
  const index = steps.findIndex((step) => step.id === currentId);
  const current = steps[index];
  if (current === undefined || options.ended) return null;
  const names = namesOf(lanes, options.agent);
  if (current.state === "live") return liveText(current.kind, names);
  const next = steps[index + 1];
  if (next === undefined) return "Reading your balance from Stellar to check what moved";
  return next.planned ? nextText(next.kind, names) : null;
}

/** Milliseconds since `key` last changed, updated twice a second. */
export function useElapsed(key: string): number {
  const [state, setState] = useState({ key, since: Date.now(), now: Date.now() });
  const current = state.key === key ? state : { key, since: Date.now(), now: Date.now() };
  if (current !== state) setState(current);
  useEffect(() => {
    const timer = setInterval(() => {
      setState((previous) => ({ ...previous, now: Date.now() }));
    }, 500);
    return () => {
      clearInterval(timer);
    };
  }, [key]);
  return Math.max(0, current.now - current.since);
}
