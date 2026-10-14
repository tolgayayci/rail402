import { describe, expect, it } from "vitest";
import type { LabEvent } from "../../src/engine/events.ts";
import type { WalletState } from "../../src/engine/types.ts";
import { explorerLink, sessionTotalInput, setupComplete, setupSteps } from "../../src/projection/wallet.ts";
import { IDS } from "../fixtures/ids.ts";
import { WALLET_FUND } from "../fixtures/runs.ts";

const CONTEXT = { symbol: "USDC", buyAmount: "1", keepXlm: "10" };

function ready(setup: { account: boolean; trustline: boolean; funded: boolean }): WalletState {
  return {
    status: "ready",
    address: IDS.buyer,
    network: "stellar:testnet",
    createdAt: "2026-10-03T11:58:00Z",
    storage: "persistent",
    setup,
  };
}

const NOTHING = { account: false, trustline: false, funded: false };
const states = (steps: ReturnType<typeof setupSteps>): string[] => steps.map((step) => step.state);

describe("wallet setup steps", () => {
  it("follows the setup flags with no run", () => {
    expect(states(setupSteps({ status: "none", storage: "persistent" }, null, CONTEXT))).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
    expect(
      states(setupSteps(ready({ account: true, trustline: false, funded: false }), null, CONTEXT)),
    ).toEqual(["done", "pending", "pending"]);
    expect(setupSteps(ready(NOTHING), null, CONTEXT).map((step) => step.title)).toEqual([
      "Create the account with Friendbot",
      "Trust USDC",
      "Buy 1 USDC",
    ]);
  });

  it("marks the next step live while a run goes, with each transaction it reported", () => {
    const first = WALLET_FUND.slice(0, 1);
    const steps = setupSteps(ready(NOTHING), { events: first, summary: null }, CONTEXT);
    expect(states(steps)).toEqual(["done", "live", "pending"]);
    expect(steps[0]?.transaction).toMatch(/^[0-9a-f]{64}$/);
    expect(steps[1]?.transaction).toBeNull();
  });

  it("marks the step a run stopped at as failed", () => {
    const events: readonly LabEvent[] = WALLET_FUND.slice(0, 2);
    const steps = setupSteps(
      ready(NOTHING),
      { events, summary: { runId: "r", status: "error", code: "playground_unexpected_error", reason: "x" } },
      CONTEXT,
    );
    expect(states(steps)).toEqual(["done", "done", "error"]);
  });

  it("is complete only when the wallet is funded", () => {
    expect(setupComplete(ready({ account: true, trustline: true, funded: false }))).toBe(false);
    expect(setupComplete(ready({ account: true, trustline: true, funded: true }))).toBe(true);
    expect(setupComplete({ status: "locked" })).toBe(false);
  });
});

describe("explorer links", () => {
  const template = "https://stellar.expert/explorer/{network}/tx/{hash}";
  const hash = "A".repeat(64);

  it("fills the template for a transaction hash", () => {
    expect(explorerLink(template, hash)).toBe(`https://stellar.expert/explorer/testnet/tx/${"a".repeat(64)}`);
  });

  it("refuses anything that is not a hash, and templates that are not https", () => {
    expect(explorerLink(template, "nope")).toBeUndefined();
    expect(explorerLink(template, `${hash}/../x`)).toBeUndefined();
    expect(explorerLink("javascript:alert({hash})", hash)).toBeUndefined();
    expect(explorerLink("http://explorer.example/{hash}", hash)).toBeUndefined();
  });
});

describe("lowering the session budget", () => {
  it("accepts a positive amount up to the current total", () => {
    expect(sessionTotalInput(" 0.50 ", "1", 7)).toEqual({ valid: true, value: "0.5" });
    expect(sessionTotalInput("1", "1", 7)).toEqual({ valid: true, value: "1" });
  });

  it("refuses raising it, zero, junk and too many decimals with a code", () => {
    for (const input of ["2", "0", "", "abc", "-1", "0.00000001", "1e3"]) {
      const result = sessionTotalInput(input, "1", 7);
      expect(result.valid, input).toBe(false);
      if (!result.valid) {
        expect(result.error.code).toBe("playground_request_invalid");
        expect(result.error.reason).not.toBe("");
      }
    }
  });
});
