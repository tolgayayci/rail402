import { describe, expect, it } from "vitest";
import type { rpc } from "@stellar/stellar-sdk";
import { KeyHolder, paymentError } from "@rail402.dev/sdk/browser";
import {
  fundAccount,
  type OnboardingOperations,
  type OnboardingOptions,
  type OnboardingStep,
  type SetupStatus,
} from "../../src/wallet/onboarding.ts";
import { ISSUER, USDC_CONTRACT } from "../engine/helpers.ts";

function setup(statuses: SetupStatus[], overrides: Partial<OnboardingOperations> = {}) {
  const calls: string[] = [];
  const steps: [OnboardingStep, string | undefined][] = [];
  let index = 0;
  const operations: OnboardingOperations = {
    status: () => Promise.resolve(statuses[Math.min(index++, statuses.length - 1)] as SetupStatus),
    friendbot: (_options, address) => {
      calls.push(`friendbot ${address}`);
      return Promise.resolve("f".repeat(64));
    },
    trustline: (_chain, signer, asset) => {
      calls.push(`trustline ${signer.address} ${asset.getCode()}`);
      return Promise.resolve("t".repeat(64));
    },
    buy: (_chain, _signer, purchase) => {
      calls.push(`buy ${purchase.amount} keep ${String(purchase.keep)}`);
      return Promise.resolve("b".repeat(64));
    },
    ...overrides,
  };
  const options: OnboardingOptions = {
    server: {} as rpc.Server,
    passphrase: "Test SDF Network ; September 2015",
    friendbotUrl: "https://friendbot.example",
    asset: { contract: USDC_CONTRACT, code: "USDC", issuer: ISSUER },
    buyAmount: "1",
    keepXlm: "10",
    onStep: (step, transaction) => steps.push([step, transaction]),
    sleep: () => Promise.resolve(),
  };
  return { operations, options, calls, steps };
}

const none = { account: false, trustline: false, funded: false };
const account = { account: true, trustline: false, funded: false };
const trusted = { account: true, trustline: true, funded: false };

describe("onboarding", () => {
  it("funds, trusts and buys in order, each a step with its transaction", async () => {
    const key = KeyHolder.random();
    const { operations, options, calls, steps } = setup([none, none, account]);
    await fundAccount(key, options, operations);
    expect(calls).toEqual([
      `friendbot ${key.address}`,
      `trustline ${key.address} USDC`,
      "buy 1 keep 100000000",
    ]);
    expect(steps).toEqual([
      ["friendbot", "f".repeat(64)],
      ["trustline", "t".repeat(64)],
      ["bought", "b".repeat(64)],
    ]);
  });

  it("skips the steps already done", async () => {
    const { operations, options, calls } = setup([trusted]);
    await fundAccount(KeyHolder.random(), options, operations);
    expect(calls).toEqual(["buy 1 keep 100000000"]);
  });

  it("fails when Friendbot answered but the account never appears", async () => {
    const { operations, options } = setup([none]);
    await expect(fundAccount(KeyHolder.random(), options, operations)).rejects.toMatchObject({
      code: "account_friendbot_failed",
    });
  });

  it("stops at the step that failed, with its code", async () => {
    const { operations, options, steps } = setup([account], {
      trustline: () =>
        Promise.reject(
          paymentError("account_trustline_failed", { details: { result: "changeTrustLowReserve" } }),
        ),
    });
    await expect(fundAccount(KeyHolder.random(), options, operations)).rejects.toMatchObject({
      code: "account_trustline_failed",
    });
    expect(steps).toEqual([]);
  });
});
