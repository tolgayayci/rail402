/**
 * The test wallet, made for the visitor: on a first visit (no wallet in this browser) the page
 * creates a key and sets it up with test funds on its own, showing the progress in a dialog. A stored
 * wallet that still has no test funds is set up the same way, once per page load. From the wallet
 * menu the visitor adds more test funds or resets the wallet, which deletes the key and starts over.
 *
 * Each step is an engine run (create, fund, forget): the key never reaches the page, only the
 * address, the setup flags and the setup transactions' hashes do. A setup that fails stops and says
 * why with its code; it is not retried on its own, only when the visitor asks.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import type { LabEvent } from "../engine/events.ts";
import type { CodedError, RunHandle, RunSummary } from "../engine/types.ts";
import { setupComplete } from "../projection/wallet.ts";
import { clientError, toCodedError, useEngine, useEngineState } from "./engine.tsx";

/** What the wallet is doing for the visitor: setting itself up, adding test funds, or resetting. */
export type WalletTaskKind = "setup" | "topUp" | "reset";

export interface WalletTask {
  readonly kind: WalletTaskKind;
  /** The setup started from no wallet, so it made the key. */
  readonly createsKey: boolean;
  /** Events of the task's runs so far. */
  readonly events: readonly LabEvent[];
  readonly status: "running" | "ok" | "failed";
  /** Why it failed. */
  readonly error: CodedError | null;
}

export interface WalletSetup {
  /** The current task, or the last one until the visitor dismisses it. */
  readonly task: WalletTask | null;
  readonly busy: boolean;
  /** Whether the setup dialog shows. */
  readonly dialogOpen: boolean;
  /** Closes the dialog; a setup in progress carries on and the header shows it. */
  readonly closeDialog: () => void;
  /** Starts the setup again after it failed. */
  readonly retry: () => void;
  /** Buys more test funds (and finishes any setup step not done yet). */
  readonly topUp: () => void;
  /** Deletes this wallet from the browser, then makes and funds a new one. */
  readonly reset: () => void;
}

/** How long the dialog shows a finished setup before it closes. */
export const SETUP_DONE_MS = 1_400;

function started(kind: WalletTaskKind, createsKey: boolean): WalletTask {
  return { kind, createsKey, events: [], status: "running", error: null };
}

const WalletSetupContext = createContext<WalletSetup | null>(null);

/** The coded error of a run that ended without success; null for success. */
export function summaryError(summary: RunSummary): CodedError | null {
  if (summary.status === "ok" || summary.status === "info") return null;
  if (summary.code === undefined || summary.reason === undefined || summary.reason === "")
    return clientError("playground_unexpected_error");
  return { code: summary.code, reason: summary.reason, retryable: false };
}

export function WalletSetupProvider({ children }: { readonly children: ReactNode }): ReactElement {
  const engine = useEngine();
  const state = useEngineState();
  const [task, setTask] = useState<WalletTask | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const busy = useRef(false);
  /** A failed setup waits for the visitor instead of starting again on its own. */
  const halted = useRef(false);
  /** Stored wallets already set up on their own during this page load. */
  const resumed = useRef(new Set<string>());
  const closing = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      clearTimeout(closing.current);
    },
    [],
  );

  /** Runs one engine run of the task, collecting its events; resolves with its error, if any. */
  const follow = useCallback(async (begin: () => RunHandle): Promise<CodedError | null> => {
    let handle: RunHandle;
    try {
      handle = begin();
    } catch (error) {
      return toCodedError(error);
    }
    const unsubscribe = handle.subscribe((event) => {
      setTask((current) => (current === null ? current : { ...current, events: [...current.events, event] }));
    });
    try {
      const summary = await handle.done;
      return summaryError(summary);
    } finally {
      unsubscribe();
    }
  }, []);

  const finish = useCallback((error: CodedError | null) => {
    setTask((current) =>
      current === null ? current : { ...current, error, status: error === null ? "ok" : "failed" },
    );
  }, []);

  /** Makes the key when there is none, then funds the wallet: each step shown in the dialog. */
  const setup = useCallback(
    async (createsKey: boolean): Promise<void> => {
      if (busy.current) return;
      busy.current = true;
      halted.current = false;
      clearTimeout(closing.current);
      setTask(started("setup", createsKey));
      setDialogOpen(true);
      try {
        let error = createsKey ? await follow(() => engine.wallet.create()) : null;
        if (error === null) error = await follow(() => engine.wallet.fund());
        finish(error);
        if (error === null) {
          closing.current = setTimeout(() => {
            setDialogOpen(false);
          }, SETUP_DONE_MS);
        } else {
          halted.current = true;
        }
      } finally {
        busy.current = false;
      }
    },
    [engine, follow, finish],
  );

  // A first visit, or a stored wallet without test funds: set it up without being asked.
  const { wallet, balances } = state;
  useEffect(() => {
    if (busy.current || halted.current) return;
    if (wallet.status === "none") {
      void setup(true);
    } else if (
      wallet.status === "ready" &&
      balances !== null &&
      !setupComplete(wallet) &&
      !resumed.current.has(wallet.address)
    ) {
      resumed.current.add(wallet.address);
      void setup(false);
    }
  }, [wallet, balances, setup]);

  const topUp = useCallback(() => {
    if (busy.current) return;
    busy.current = true;
    setTask(started("topUp", false));
    void follow(() => engine.wallet.fund({ topUp: true })).then((error) => {
      busy.current = false;
      finish(error);
    });
  }, [engine, follow, finish]);

  const reset = useCallback(() => {
    if (busy.current) return;
    busy.current = true;
    setTask(started("reset", true));
    void follow(() => engine.wallet.forget()).then((error) => {
      busy.current = false;
      if (error !== null) {
        finish(error);
        return;
      }
      resumed.current.clear();
      void setup(true);
    });
  }, [engine, follow, finish, setup]);

  const retry = useCallback(() => {
    void setup(wallet.status === "none");
  }, [setup, wallet.status]);

  const closeDialog = useCallback(() => {
    clearTimeout(closing.current);
    setDialogOpen(false);
  }, []);

  const busyNow = task?.status === "running";
  const control = useMemo<WalletSetup>(
    () => ({ task, busy: busyNow, dialogOpen, closeDialog, retry, topUp, reset }),
    [task, busyNow, dialogOpen, closeDialog, retry, topUp, reset],
  );
  return <WalletSetupContext.Provider value={control}>{children}</WalletSetupContext.Provider>;
}

export function useWalletSetup(): WalletSetup {
  const control = useContext(WalletSetupContext);
  if (control === null) throw new Error("useWalletSetup needs a WalletSetupProvider");
  return control;
}
