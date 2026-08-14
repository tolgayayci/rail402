import { describe, it, expect, beforeEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { X402Error } from "@rail402/errors";
import { loadConfig, type PlaygroundConfig } from "./config.js";
import { createDispenser, type BalanceLine, type HorizonGateway } from "./dispenser.js";

const SECRET = Keypair.random().secret();
const TARGET = Keypair.random().publicKey();

function config(): PlaygroundConfig {
  return loadConfig({ PLAYGROUND_DISPENSER_SECRET: SECRET } as NodeJS.ProcessEnv);
}

const usdcLine = (c: PlaygroundConfig, balance: string): BalanceLine => ({
  assetCode: c.usdc.code,
  assetIssuer: c.usdc.issuer,
  balance,
  native: false,
});
const xlmLine: BalanceLine = { balance: "10000.0000000", native: true };

interface FakeHorizon extends HorizonGateway {
  accounts: Map<string, BalanceLine[]>;
  payments: Array<{ to: string; amountStroops: bigint }>;
  failNextSubmit?: Error;
}

function fakeHorizon(c: PlaygroundConfig): FakeHorizon {
  const fake: FakeHorizon = {
    accounts: new Map([[c.dispenser.publicKey(), [usdcLine(c, "100.0000000"), xlmLine]]]),
    payments: [],
    async getBalances(id) {
      return fake.accounts.get(id) ?? null;
    },
    async submitPayment({ to, amountStroops }) {
      if (fake.failNextSubmit) {
        const err = fake.failNextSubmit;
        delete fake.failNextSubmit;
        throw err;
      }
      fake.payments.push({ to, amountStroops });
      return { hash: `hash-${fake.payments.length}` };
    },
  };
  return fake;
}

const expectCode = async (p: Promise<unknown>, code: string) => {
  try {
    await p;
    throw new Error("expected a coded refusal");
  } catch (err) {
    expect(err).toBeInstanceOf(X402Error);
    expect((err as X402Error).code).toBe(code);
    expect((err as X402Error).reason.trim().length).toBeGreaterThan(20);
  }
};

describe("dispenser", () => {
  let c: PlaygroundConfig;
  let horizon: FakeHorizon;
  let clock: number;
  let dispenser: ReturnType<typeof createDispenser>;

  beforeEach(() => {
    c = config();
    horizon = fakeHorizon(c);
    clock = 1_000_000;
    dispenser = createDispenser({ config: c, horizon, now: () => clock });
  });

  it("drips to a funded account with a trustline and empty balance", async () => {
    horizon.accounts.set(TARGET, [usdcLine(c, "0.0000000"), xlmLine]);
    const drip = await dispenser.fund(TARGET);
    expect(drip.amountStroops).toBe(c.dripStroops);
    expect(horizon.payments).toEqual([{ to: TARGET, amountStroops: c.dripStroops }]);
  });

  it("refuses a malformed address before touching Horizon", async () => {
    await expectCode(dispenser.fund("not-an-address"), "playground_invalid_request");
    expect(horizon.payments).toHaveLength(0);
  });

  it("names the next step when the account does not exist yet", () =>
    expectCode(dispenser.fund(TARGET), "playground_dispenser_account_not_found"));

  it("names the next step when the trustline is missing", async () => {
    horizon.accounts.set(TARGET, [xlmLine]);
    await expectCode(dispenser.fund(TARGET), "playground_dispenser_trustline_missing");
  });

  it("refuses to double-fund a session that already holds the drip", async () => {
    horizon.accounts.set(TARGET, [usdcLine(c, "0.5000000"), xlmLine]);
    await expectCode(dispenser.fund(TARGET), "playground_dispenser_already_funded");
  });

  it("reports an empty dispenser as an operator problem, retryable", async () => {
    horizon.accounts.set(TARGET, [usdcLine(c, "0"), xlmLine]);
    horizon.accounts.set(c.dispenser.publicKey(), [usdcLine(c, "0.1000000"), xlmLine]);
    try {
      await dispenser.fund(TARGET);
      throw new Error("expected refusal");
    } catch (err) {
      expect((err as X402Error).code).toBe("playground_dispenser_exhausted");
      expect((err as X402Error).retryable).toBe(true);
    }
  });

  it("rate-limits per target account inside the window and recovers after it", async () => {
    horizon.accounts.set(TARGET, [usdcLine(c, "0"), xlmLine]);
    await dispenser.fund(TARGET);
    // Second drip inside the window: refused by the account window, not by balance (the fake
    // balance still reads 0, so reaching the guard proves the window check ran first).
    horizon.accounts.set(TARGET, [usdcLine(c, "0"), xlmLine]);
    await dispenser.fund(TARGET);
    await expectCode(dispenser.fund(TARGET), "playground_dispenser_rate_limited");
    clock += c.rate.windowSeconds * 1000 + 1;
    await dispenser.fund(TARGET);
    expect(horizon.payments).toHaveLength(3);
  });

  it("wraps a Horizon submission failure in a retryable coded error", async () => {
    horizon.accounts.set(TARGET, [usdcLine(c, "0"), xlmLine]);
    horizon.failNextSubmit = new Error("tx_bad_seq");
    try {
      await dispenser.fund(TARGET);
      throw new Error("expected refusal");
    } catch (err) {
      expect((err as X402Error).code).toBe("playground_dispenser_failed");
      expect((err as X402Error).retryable).toBe(true);
    }
    // The queue must not be poisoned by the failure: the next drip succeeds.
    horizon.accounts.set(TARGET, [usdcLine(c, "0"), xlmLine]);
    const drip = await dispenser.fund(TARGET);
    expect(drip.hash).toBe("hash-1");
  });
});
