/**
 * The runs the pages started, kept above the pages: leaving a page during a run (or after it) and
 * coming back shows the same run, with its steps, outcome and report. While the Lab plays a payment
 * step by step, it holds the header's balance at what it was before the run, so the header does not
 * give the ending away before the transfer is shown.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import type { RunHandle } from "../engine/types.ts";

interface RunsStore {
  readonly handle: (key: string) => RunHandle | null;
  readonly setHandle: (key: string, handle: RunHandle | null) => void;
  /** The Lab's last path (with its mode), for the header's links back to it. */
  readonly labPath: string;
  readonly setLabPath: (path: string) => void;
  /** The balance the header shows while a run plays; null shows the engine's. */
  readonly heldBalance: string | null;
  readonly holdBalance: (balance: string | null) => void;
}

const RunsContext = createContext<RunsStore | null>(null);

export function RunsProvider({ children }: { readonly children: ReactNode }): ReactElement {
  const [handles, setHandles] = useState<Readonly<Record<string, RunHandle | null>>>({});
  const [labPath, setLabPath] = useState("/");
  const [heldBalance, holdBalance] = useState<string | null>(null);

  const setHandle = useCallback((key: string, handle: RunHandle | null) => {
    setHandles((current) => ({ ...current, [key]: handle }));
  }, []);

  const store = useMemo<RunsStore>(
    () => ({
      handle: (key) => handles[key] ?? null,
      setHandle,
      labPath,
      setLabPath,
      heldBalance,
      holdBalance,
    }),
    [handles, setHandle, labPath, heldBalance],
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

/** The runs key of the Bazaar's last payment of a listing, which the Lab can play (`?watch=`). */
export function bazaarRunKey(listingId: string): string {
  return `bazaar:${listingId}`;
}
