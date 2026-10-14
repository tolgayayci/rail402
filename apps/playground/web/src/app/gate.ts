/** Whether the page may start a paying run now, and if not, the coded reason it shows. */
import type { CodedError, EngineState } from "../engine/types.ts";
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
      return state.activeRun === null ? null : clientError("playground_run_in_progress");
  }
}

/** Whether a run can start: the wallet is ready and idle. */
export function canRun(state: EngineState): boolean {
  return state.wallet.status === "ready" && state.activeRun === null;
}
