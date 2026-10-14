/**
 * Where the wallet panel opens from: the header's wallet chip, and the prompt a page shows when a run
 * cannot start because there is no wallet yet or it has no test funds.
 */
import { createContext, useContext, useMemo, useState, type ReactElement, type ReactNode } from "react";
import type { EngineState } from "../engine/types.ts";
import { setupComplete } from "../projection/wallet.ts";
import { Notice } from "../ui/Notice.tsx";
import { runBlocker } from "./gate.ts";

export const WALLET_PANEL_ID = "wallet-panel";

interface WalletPanelControl {
  readonly open: boolean;
  setOpen(open: boolean): void;
}

const WalletPanelContext = createContext<WalletPanelControl | null>(null);

export function WalletPanelProvider({ children }: { readonly children: ReactNode }): ReactElement {
  const [open, setOpen] = useState(false);
  const control = useMemo(() => ({ open, setOpen }), [open]);
  return <WalletPanelContext.Provider value={control}>{children}</WalletPanelContext.Provider>;
}

export function useWalletPanel(): WalletPanelControl {
  const control = useContext(WalletPanelContext);
  if (control === null) throw new Error("useWalletPanel needs a WalletPanelProvider");
  return control;
}

/**
 * Why a run cannot start, with the way out: the coded reason (no wallet, wallet in another tab, a run
 * in progress), or a hint to set up test funds when the wallet holds none yet. Nothing while running.
 */
export function WalletPrompt({
  state,
  running,
}: {
  readonly state: EngineState;
  readonly running: boolean;
}): ReactElement | null {
  const panel = useWalletPanel();
  if (running) return null;
  const blocker = runBlocker(state);
  const openButton = (label: string): ReactElement => (
    <button
      type="button"
      className="link-button"
      aria-controls={WALLET_PANEL_ID}
      onClick={() => {
        panel.setOpen(true);
      }}
    >
      {label}
    </button>
  );
  if (blocker !== null) {
    return (
      <Notice error={blocker} tone="info">
        {blocker.code === "playground_wallet_missing" ? openButton("Set up a test wallet") : null}
      </Notice>
    );
  }
  if (state.wallet.status === "ready" && !setupComplete(state.wallet)) {
    return (
      <p className="note wallet-hint" role="status">
        Your test wallet has no test funds yet, so a paid run will fail. Without them you can still try “Cap
        below the price” and every refusal check except “Session budget used up”.{" "}
        {openButton("Set up test funds")}
      </p>
    );
  }
  return null;
}
