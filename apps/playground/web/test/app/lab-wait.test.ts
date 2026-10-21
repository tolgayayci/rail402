import { describe, expect, it } from "vitest";
import type { EngineState, WalletState } from "../../src/engine/types.ts";
import { canRun, runBlocker } from "../../src/app/gate.ts";
import { waitingFor } from "../../src/app/lab/waiting.ts";
import { projectStage, type StageContext } from "../../src/projection/stage.ts";
import { CONFIG } from "../fixtures/config.ts";
import { scenarioRun } from "../fixtures/runs.ts";

const context = (mode: StageContext["mode"]): StageContext => ({ mode, plan: "normal", config: CONFIG });

const READY: Extract<WalletState, { status: "ready" }> = {
  status: "ready",
  address: "GBSVTVRQ4AEFRNGH2MIOOWZSAVLZKOKNKI4UAGSMBZSNRP4I3FL3ELYP",
  network: "stellar:testnet",
  createdAt: "2026-10-01T00:00:00.000Z",
  storage: "persistent",
  setup: { account: false, trustline: false, funded: false },
};

function state(overrides: Partial<EngineState>): EngineState {
  return {
    wallet: READY,
    balances: null,
    balancesRead: "pending",
    budget: null,
    activeRun: null,
    unfinished: 0,
    lastError: null,
    ...overrides,
  };
}

describe("what the current step waits for", () => {
  const events = scenarioRun("pay", "normal");

  it("names the settlement while the paid request has no answer yet", () => {
    // The run as it stands right after the paid request was sent.
    const sent = events.findIndex(
      (event) => event.kind === "http" && event.phase === "request" && event.paid,
    );
    const stage = projectStage(events.slice(0, sent + 1), context("exact"));
    const paid = stage.steps.find((step) => step.kind === "paid");
    expect(paid?.state).toBe("live");
    expect(waitingFor(stage.steps, paid?.id ?? "", stage.lanes, { ended: false, agent: false })).toBe(
      "Waiting for the API to check the payment and Rail402 to settle it on Stellar",
    );
  });

  it("names the chain read of the transaction while its step is still to come", () => {
    const read = events.findIndex((event) => event.kind === "chain" && event.phase === "tx");
    const stage = projectStage(events.slice(0, read), context("exact"));
    const settle = stage.steps.find((step) => step.kind === "settle");
    expect(waitingFor(stage.steps, settle?.id ?? "", stage.lanes, { ended: false, agent: false })).toBe(
      "Reading the transaction from Stellar",
    );
  });

  it("says nothing once the next step is there, or the run is over", () => {
    const stage = projectStage(events, context("exact"));
    const first = stage.steps[0];
    expect(waitingFor(stage.steps, first?.id ?? "", stage.lanes, { ended: false, agent: false })).toBeNull();
    const last = stage.steps.at(-1);
    expect(waitingFor(stage.steps, last?.id ?? "", stage.lanes, { ended: true, agent: false })).toBeNull();
    expect(waitingFor(stage.steps, last?.id ?? "", stage.lanes, { ended: false, agent: false })).toBe(
      "Reading your balance from Stellar to check what moved",
    );
  });
});

describe("whether a run may start", () => {
  it("knows nothing of the setup before the chain is read, so it does not block", () => {
    expect(runBlocker(state({}))).toBeNull();
    expect(canRun(state({}))).toBe(true);
  });

  it("blocks a wallet the chain shows is not set up, with its code", () => {
    const unfunded = state({ balancesRead: "ok", balances: { xlm: null, asset: null, readAt: 0 } });
    expect(runBlocker(unfunded)?.code).toBe("playground_wallet_not_set_up");
    expect(canRun(unfunded)).toBe(false);
    const funded = state({
      wallet: { ...READY, setup: { account: true, trustline: true, funded: true } },
      balancesRead: "ok",
      balances: { xlm: "10", asset: "1", readAt: 0 },
    });
    expect(runBlocker(funded)).toBeNull();
    expect(runBlocker({ ...funded, activeRun: "run-1" })?.code).toBe("playground_run_in_progress");
  });
});
