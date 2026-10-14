/**
 * The runs the pages started, kept above the pages: leaving a page during a run (or after it) and
 * coming back shows the same run, with its rows, outcome and report. The refusal checks' "run all"
 * sequence lives here too, so it is never left running unseen by a page that went away; leaving the
 * Pay page stops the sequence after the check in progress.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import type { CheckId } from "../engine/events.ts";
import type { CodedError, RunHandle } from "../engine/types.ts";
import { toCodedError, useEngine } from "./engine.tsx";

interface ChecksState {
  readonly handles: Partial<Record<CheckId, RunHandle>>;
  readonly sequence: boolean;
  readonly error: CodedError | null;
}

interface RunsStore {
  readonly handle: (key: string) => RunHandle | null;
  readonly setHandle: (key: string, handle: RunHandle | null) => void;
  /** The lab's last path (with its scenario and experiment), for the Playground link. */
  readonly labPath: string;
  readonly setLabPath: (path: string) => void;
  readonly checks: ChecksState;
  readonly startCheck: (id: CheckId) => RunHandle | undefined;
  readonly runAllChecks: (ids: readonly CheckId[]) => Promise<void>;
  /** Stops a running sequence after the check in progress. */
  readonly stopChecks: () => void;
  readonly clearCheckError: () => void;
}

const RunsContext = createContext<RunsStore | null>(null);

export function RunsProvider({ children }: { readonly children: ReactNode }): ReactElement {
  const engine = useEngine();
  const [handles, setHandles] = useState<Readonly<Record<string, RunHandle | null>>>({});
  const [labPath, setLabPath] = useState("/");
  const [checks, setChecks] = useState<ChecksState>({ handles: {}, sequence: false, error: null });
  const stopped = useRef(false);

  const setHandle = useCallback((key: string, handle: RunHandle | null) => {
    setHandles((current) => ({ ...current, [key]: handle }));
  }, []);

  const startCheck = useCallback(
    (id: CheckId): RunHandle | undefined => {
      try {
        const handle = engine.check(id);
        setChecks((current) => ({ ...current, error: null, handles: { ...current.handles, [id]: handle } }));
        return handle;
      } catch (reason) {
        setChecks((current) => ({ ...current, error: toCodedError(reason) }));
        return undefined;
      }
    },
    [engine],
  );

  const runAllChecks = useCallback(
    async (ids: readonly CheckId[]): Promise<void> => {
      stopped.current = false;
      const stop = (): boolean => stopped.current;
      setChecks((current) => ({ ...current, sequence: true, error: null }));
      for (const id of ids) {
        if (stop()) break;
        const handle = startCheck(id);
        if (handle === undefined) break;
        await handle.done;
      }
      setChecks((current) => ({ ...current, sequence: false }));
    },
    [startCheck],
  );

  const stopChecks = useCallback(() => {
    stopped.current = true;
  }, []);
  const clearCheckError = useCallback(() => {
    setChecks((current) => ({ ...current, error: null }));
  }, []);

  const store = useMemo<RunsStore>(
    () => ({
      handle: (key) => handles[key] ?? null,
      setHandle,
      labPath,
      setLabPath,
      checks,
      startCheck,
      runAllChecks,
      stopChecks,
      clearCheckError,
    }),
    [handles, setHandle, labPath, checks, startCheck, runAllChecks, stopChecks, clearCheckError],
  );
  return <RunsContext.Provider value={store}>{children}</RunsContext.Provider>;
}

export function useRuns(): RunsStore {
  const store = useContext(RunsContext);
  if (store === null) throw new Error("useRuns needs a RunsProvider");
  return store;
}

/** A page's last run under `key`, kept while the visitor is on other pages. */
export function usePageRun(key: string): readonly [RunHandle | null, (handle: RunHandle | null) => void] {
  const store = useRuns();
  const handle = store.handle(key);
  const set = useCallback(
    (next: RunHandle | null) => {
      store.setHandle(key, next);
    },
    [store, key],
  );
  return [handle, set] as const;
}
