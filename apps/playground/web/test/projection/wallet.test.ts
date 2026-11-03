import { describe, expect, it } from "vitest";
import type { LabEvent } from "../../src/engine/events.ts";
import type { WalletState } from "../../src/engine/types.ts";
import {
  accountLink,
  explorerLink,
  failedStep,
  setupComplete,
  setupSteps,
} from "../../src/projection/wallet.ts";
import { IDS } from "../fixtures/ids.ts";
import { WALLET_FUND } from "../fixtures/runs.ts";

const CONTEXT = { symbol: "USDC", buyAmount: "1", memory: false };

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
  it("follows the wallet and its setup flags with no run", () => {
    expect(states(setupSteps({ status: "none", storage: "persistent" }, null, CONTEXT))).toEqual([
      "pending",
      "pending",
      "pending",
    ]);
    expect(
      states(setupSteps(ready({ account: true, trustline: false, funded: false }), null, CONTEXT)),
    ).toEqual(["done", "done", "pending"]);
    expect(setupSteps(ready(NOTHING), null, CONTEXT).map((step) => step.title)).toEqual([
      "Key created",
      "Funding with Friendbot",
      "Adding test USDC",
    ]);
    expect(setupSteps(ready(NOTHING), null, CONTEXT)[2]?.detail).toBe("A USDC trustline and 1 test USDC");
  });

  it("marks the next step live while a setup runs, with each transaction it reported", () => {
    const first = WALLET_FUND.slice(0, 1);
    const steps = setupSteps(ready(NOTHING), { events: first, status: "running" }, CONTEXT);
    expect(states(steps)).toEqual(["done", "done", "live"]);
    expect(steps[1]?.transaction).toMatch(/^[0-9a-f]{64}$/);
    expect(steps[2]?.transaction).toBeNull();
    const creating = setupSteps(
      { status: "none", storage: "persistent" },
      { events: [], status: "running" },
      CONTEXT,
    );
    expect(states(creating)).toEqual(["live", "pending", "pending"]);
  });

  it("marks the step whose operation failed, and no step for a failure of none", () => {
    const events: readonly LabEvent[] = WALLET_FUND.slice(0, 2);
    const bought = { events, status: "failed" as const, error: { code: "account_funding_failed" } };
    expect(states(setupSteps(ready(NOTHING), bought, CONTEXT))).toEqual(["done", "done", "error"]);
    const friendbot = { events: [], status: "failed" as const, error: { code: "account_friendbot_failed" } };
    expect(states(setupSteps(ready(NOTHING), friendbot, CONTEXT))).toEqual(["done", "error", "pending"]);
    const rpc = { events: [], status: "failed" as const, error: { code: "rpc_unavailable" } };
    expect(states(setupSteps(ready(NOTHING), rpc, CONTEXT))).toEqual(["done", "pending", "pending"]);
    expect(failedStep("rpc_unavailable")).toBeUndefined();
  });

  it("says when the key lives in this tab only", () => {
    const steps = setupSteps(ready(NOTHING), null, { ...CONTEXT, memory: true });
    expect(steps[0]?.detail).toContain("this tab only");
  });

  it("is complete only when the wallet is funded", () => {
    expect(setupComplete(ready({ account: true, trustline: true, funded: false }))).toBe(false);
    expect(setupComplete(ready({ account: true, trustline: true, funded: true }))).toBe(true);
    expect(setupComplete({ status: "locked" })).toBe(false);
  });
});

describe("explorer links", () => {
  const network = "stellar:testnet" as const;
  const expert = { explorer: "stellar.expert" as const, network };
  const hash = "A".repeat(64);
  const template = (value: string, accountTemplate?: string) => ({
    explorer: { template: value, ...(accountTemplate === undefined ? {} : { accountTemplate }) },
    network,
  });

  it("links a transaction on the configured network", () => {
    expect(explorerLink(expert, hash)).toBe(`https://stellar.expert/explorer/testnet/tx/${"a".repeat(64)}`);
    expect(explorerLink({ explorer: "rail402", network }, hash)).toBe(
      `https://explorer.rail402.dev/testnet/tx/${"a".repeat(64)}`,
    );
  });

  it("refuses anything that is not a hash, and templates that are not https", () => {
    expect(explorerLink(expert, "nope")).toBeUndefined();
    expect(explorerLink(expert, `${hash}/../x`)).toBeUndefined();
    expect(explorerLink(template("javascript:alert({hash})"), hash)).toBeUndefined();
    expect(explorerLink(template("http://explorer.example/{hash}"), hash)).toBeUndefined();
  });

  it("links accounts and contracts through the explorer's own account pages, and nothing else", () => {
    expect(accountLink(expert, IDS.buyer)).toBe(
      `https://stellar.expert/explorer/testnet/account/${IDS.buyer}`,
    );
    expect(accountLink(expert, IDS.usdc)).toBe(
      `https://stellar.expert/explorer/testnet/contract/${IDS.usdc}`,
    );
    expect(accountLink({ explorer: "rail402", network }, IDS.buyer)).toBe(
      `https://explorer.rail402.dev/testnet/account/${IDS.buyer}`,
    );
    expect(accountLink(expert, "not-an-account")).toBeUndefined();
    // A template without an account template gives no account links: nothing is rewritten.
    expect(accountLink(template("https://explorer.example/tx/{hash}"), IDS.buyer)).toBeUndefined();
    expect(
      accountLink(
        template("https://explorer.example/tx/{hash}", "https://explorer.example/a/{address}"),
        IDS.buyer,
      ),
    ).toBe(`https://explorer.example/a/${IDS.buyer}`);
  });
});
