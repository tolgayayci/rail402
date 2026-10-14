/**
 * The page's access to the engine: a React context, the engine's state as a hook, and a run's events
 * as a hook. Components never hold the engine's internals, only what these hooks return.
 */
import { createContext, useContext, useEffect, useState, type ReactElement, type ReactNode } from "react";
import type { LabEvent } from "../engine/events.ts";
import type { CodedError, Engine, EngineState, RunHandle, RunSummary } from "../engine/types.ts";
import { playgroundClientCodes, type PlaygroundClientCode } from "../../../src/shared/codes.ts";

const EngineContext = createContext<Engine | null>(null);

export function EngineProvider({
  engine,
  children,
}: {
  readonly engine: Engine;
  readonly children: ReactNode;
}): ReactElement {
  return <EngineContext.Provider value={engine}>{children}</EngineContext.Provider>;
}

export function useEngine(): Engine {
  const engine = useContext(EngineContext);
  if (engine === null) throw new Error("useEngine needs an EngineProvider");
  return engine;
}

/** The engine's state, re-rendered on every change. */
export function useEngineState(): EngineState {
  const engine = useEngine();
  const [state, setState] = useState(() => engine.state());
  useEffect(() => {
    setState(engine.state());
    return engine.subscribe(setState);
  }, [engine]);
  return state;
}

export interface RunView {
  readonly runId: string | null;
  readonly events: readonly LabEvent[];
  /** Set when the run ended. */
  readonly summary: RunSummary | null;
}

const NO_RUN: RunView = { runId: null, events: [], summary: null };

/**
 * The events of a run as they arrive. The handle replays what it already emitted on subscribe, so a
 * remount (or React's development double mount) loses nothing.
 */
export function useRunView(handle: RunHandle | null): RunView {
  const [view, setView] = useState<RunView>(NO_RUN);
  useEffect(() => {
    if (handle === null) {
      setView(NO_RUN);
      return undefined;
    }
    let live = true;
    let events: LabEvent[] = [];
    setView({ runId: handle.runId, events, summary: null });
    const unsubscribe = handle.subscribe((event) => {
      events = [...events, event];
      const next = events;
      if (live) setView((current) => ({ ...current, runId: handle.runId, events: next }));
    });
    void handle.done.then((summary) => {
      if (live) setView((current) => ({ ...current, summary }));
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [handle]);
  return view;
}

/** Whether a value is the engine's coded error. */
export function isCodedError(value: unknown): value is CodedError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { code?: unknown }).code === "string" &&
    typeof (value as { reason?: unknown }).reason === "string"
  );
}

/** A coded error that can be thrown or rejected with; its message is the reason. */
export class CodedFailure extends Error implements CodedError {
  readonly code: string;
  readonly reason: string;
  readonly retryable: boolean;

  constructor(error: CodedError) {
    super(error.reason);
    this.name = "CodedFailure";
    this.code = error.code;
    this.reason = error.reason;
    this.retryable = error.retryable;
  }
}

/** One of the page's own registered errors, with its registered reason. */
export function clientError(code: PlaygroundClientCode): CodedError {
  const spec = playgroundClientCodes[code];
  return { code, reason: spec.reason, retryable: spec.retryable };
}

/** A coded error for anything a promise rejected with; unknown errors never show their text. */
export function toCodedError(value: unknown): CodedError {
  if (!isCodedError(value)) return clientError("playground_unexpected_error");
  return {
    code: value.code,
    reason: value.reason,
    retryable: value.retryable,
    ...(value.details === undefined ? {} : { details: value.details }),
  };
}
