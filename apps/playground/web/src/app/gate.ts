/** Whether the page may start a paying run now, and if not, the coded reason it shows. */
import type { CodedError, EngineState } from "../engine/types.ts";
import { setupComplete } from "../projection/wallet.ts";
import { clientError } from "./engine.tsx";

export function runBlocker(state: EngineState): CodedError | null {
  switch (state.wallet.status) {
    case "loading":
      return null;
    case "none":
      return clientError("playground_wallet_missing");
    case "locked":
      return clientError("playground_wallet_locked");
    case "ready":
      if (state.activeRun !== null) return clientError("playground_run_in_progress");
      // Only a read of the chain says the wallet is not set up; before it, nothing is known.
      return state.balancesRead === "ok" && !setupComplete(state.wallet)
        ? clientError("playground_wallet_not_set_up")
        : null;
  }
}

/** Whether a run can start: the wallet is ready, set up as far as the chain has shown, and idle. */
export function canRun(state: EngineState): boolean {
  return runBlocker(state) === null && state.wallet.status === "ready";
}
