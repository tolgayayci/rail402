/**
 * Plays a run's steps one at a time, at a pace a person can follow. Only steps that happened are ever
 * shown: playback holds a step back while one before it is still to come (a chain read that has not
 * arrived yet), and never invents one. The last step gets its turn as the current one like every
 * other before the run counts as finished. A run that was already under way when the page came back
 * to it is shown as it stands, without replaying.
 */
import { useEffect, useState } from "react";
import type { StageStep } from "../../projection/stage.ts";

/** The least time a step stays the current one before the next is shown. */
export const STEP_MS = 800;

export interface Playback {
  /** The ids of the steps shown so far. */
  readonly shown: ReadonlySet<string>;
  /** The step shown last, while the run goes or steps remain to show; null otherwise. */
  readonly current: string | null;
  /** The run ended and every step it made is shown. */
  readonly finished: boolean;
}

interface Shown {
  readonly runId: string | null;
  readonly ids: readonly string[];
  /** When the last of them was shown (epoch milliseconds); 0 before any. */
  readonly at: number;
  /** The last step had its turn as the current one after the run ended. */
  readonly done: boolean;
}

/** The next step to show: the first that happened and is not shown, unless a step before it is still to come. */
function nextStep(
  steps: readonly StageStep[],
  shown: ReadonlySet<string>,
  ended: boolean,
): StageStep | undefined {
  for (const step of steps) {
    if (step.planned) {
      if (!ended) return undefined;
      continue;
    }
    if (!shown.has(step.id)) return step;
  }
  return undefined;
}

export function usePlayback(
  steps: readonly StageStep[],
  runId: string | null,
  ended: boolean,
  options: {
    readonly paceMs?: number;
    /** Show every step at once: a run that started before the page showed it is not replayed. */
    readonly instant?: boolean;
  } = {},
): Playback {
  const pace = options.paceMs ?? STEP_MS;
  const [state, setState] = useState<Shown>({ runId, ids: [], at: 0, done: false });
  const current: Shown = state.runId === runId ? state : { runId, ids: [], at: 0, done: false };
  if (current !== state) setState(current);
  const shown = new Set(current.ids);
  const instant = options.instant === true;
  const next = nextStep(steps, shown, ended)?.id;
  const allShown = ended && next === undefined && steps.every((step) => step.planned || shown.has(step.id));

  useEffect(() => {
    if (next === undefined) return undefined;
    const reveal = (): void => {
      setState((previous) =>
        previous.runId !== runId || previous.ids.includes(next)
          ? previous
          : { ...previous, ids: [...previous.ids, next], at: Date.now() },
      );
    };
    const wait = instant ? 0 : Math.max(0, current.at + pace - Date.now());
    if (wait === 0) {
      reveal();
      return undefined;
    }
    const timer = setTimeout(reveal, wait);
    return () => {
      clearTimeout(timer);
    };
  }, [next, runId, pace, instant, current.at]);

  // Every step is shown: the last one stays current for its turn, then the run is finished.
  useEffect(() => {
    if (!allShown || current.done) return undefined;
    const finish = (): void => {
      setState((previous) => (previous.runId !== runId ? previous : { ...previous, done: true }));
    };
    const wait = instant || current.ids.length === 0 ? 0 : Math.max(0, current.at + pace - Date.now());
    if (wait === 0) {
      finish();
      return undefined;
    }
    const timer = setTimeout(finish, wait);
    return () => {
      clearTimeout(timer);
    };
  }, [allShown, current.done, current.ids.length, current.at, runId, pace, instant]);

  const shownSteps = steps.filter((step) => shown.has(step.id));
  const finished = allShown && current.done;
  return {
    shown,
    current: finished ? null : (shownSteps.at(-1)?.id ?? null),
    finished,
  };
}
