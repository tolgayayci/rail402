import { describe, expect, it, vi } from "vitest";
import type { rpc } from "@stellar/stellar-sdk";
import { InclusionFeeOracle, MemorySettlementLedger, SponsorBudget } from "@rail402.dev/facilitator";

function server(p90: string | Error): { calls: number; server: rpc.Server } {
  const state = { calls: 0 };
  const fake = {
    getFeeStats: () => {
      state.calls++;
      return p90 instanceof Error ? Promise.reject(p90) : Promise.resolve({ sorobanInclusionFee: { p90 } });
    },
  } as unknown as rpc.Server;
  return {
    get calls() {
      return state.calls;
    },
    server: fake,
  };
}

describe("InclusionFeeOracle", () => {
  it("bids the configured percentile, clamped between floor and cap", async () => {
    expect(
      await new InclusionFeeOracle(server("250").server, { floor: 100, cap: 1_000, percentile: "p90" }).bid(),
    ).toBe(250);
    expect(
      await new InclusionFeeOracle(server("50").server, { floor: 100, cap: 1_000, percentile: "p90" }).bid(),
    ).toBe(100);
    expect(
      await new InclusionFeeOracle(server("90000").server, {
        floor: 100,
        cap: 1_000,
        percentile: "p90",
      }).bid(),
    ).toBe(1_000);
  });

  it("falls back to the floor when fee stats are unavailable", async () => {
    expect(
      await new InclusionFeeOracle(server(new Error("rpc down")).server, {
        floor: 200,
        cap: 1_000,
        percentile: "p90",
      }).bid(),
    ).toBe(200);
  });

  it("reuses a reading within its cache window", async () => {
    const fake = server("300");
    const oracle = new InclusionFeeOracle(fake.server, {
      floor: 100,
      cap: 1_000,
      percentile: "p90",
      cacheMs: 60_000,
    });
    await Promise.all([oracle.bid(), oracle.bid(), oracle.bid()]);
    await oracle.bid();
    expect(fake.calls).toBe(1);
  });

  it("answers a stale reading while refreshing it, and waits once it is too old", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const fees = { p90: "300", calls: 0 };
      const fake = {
        getFeeStats: () => {
          fees.calls++;
          return Promise.resolve({ sorobanInclusionFee: { p90: fees.p90 } });
        },
      } as unknown as rpc.Server;
      const oracle = new InclusionFeeOracle(fake, {
        floor: 100,
        cap: 1_000,
        percentile: "p90",
        cacheMs: 5_000,
        staleMs: 60_000,
      });
      expect(await oracle.bid()).toBe(300);

      fees.p90 = "400";
      vi.advanceTimersByTime(10_000);
      expect(await oracle.bid()).toBe(300); // stale: answered at once, refreshed behind it
      expect(fees.calls).toBe(2);
      expect(await oracle.bid()).toBe(400);

      fees.p90 = "500";
      vi.advanceTimersByTime(120_000);
      expect(await oracle.bid()).toBe(500); // too old: waits for the network
      expect(fees.calls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a floor below the spec minimum or a cap below the floor", () => {
    expect(
      () => new InclusionFeeOracle(server("1").server, { floor: 50, cap: 1_000, percentile: "p90" }),
    ).toThrow();
    expect(
      () => new InclusionFeeOracle(server("1").server, { floor: 500, cap: 100, percentile: "p90" }),
    ).toThrow();
  });
});

describe("SponsorBudget", () => {
  const envelope = (maxFeeStroops: string) => ({
    channel: "GCH",
    transactionHash: "a".repeat(64),
    innerTransactionHash: "b".repeat(64),
    envelopeXdr: "AAAA",
    validUntil: 1,
    maxFeeStroops,
  });

  it("refuses while the sponsor is below its reserve, admits otherwise", async () => {
    let balance: bigint | undefined = 10n;
    const guard = new SponsorBudget({
      network: "stellar:testnet",
      ledger: new MemorySettlementLedger(),
      balance: () => balance,
      minBalanceStroops: 100n,
    });
    expect(await guard.admit()).toMatchObject({ ok: false });
    balance = 1_000n;
    expect(await guard.admit()).toEqual({ ok: true });
    balance = undefined;
    expect(await guard.admit()).toEqual({ ok: true });
  });

  it("refuses once the hourly fee budget is committed", async () => {
    const ledger = new MemorySettlementLedger();
    const guard = new SponsorBudget({
      network: "stellar:testnet",
      ledger,
      balance: () => 10_000_000n,
      minBalanceStroops: 0n,
      maxSpendPerHourStroops: 50_000n,
    });
    const { record } = await ledger.claim(
      { network: "stellar:testnet", payer: "G1", nonce: "1" },
      "p",
      "o",
      60_000,
    );
    await ledger.recordEnvelope(record.id, "o", envelope("30000"));
    expect(await guard.admit()).toEqual({ ok: true });
    const second = await ledger.claim(
      { network: "stellar:testnet", payer: "G2", nonce: "1" },
      "p",
      "o",
      60_000,
    );
    await ledger.recordEnvelope(second.record.id, "o", envelope("30000"));
    const refused = await guard.admit();
    expect(refused.ok).toBe(false);
    expect(refused.ok ? "" : refused.reason).toContain("hourly fee budget");
  });
});
