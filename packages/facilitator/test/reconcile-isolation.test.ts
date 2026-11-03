/**
 * Reconciliation runs per network: one network's ledger or RPC failing, or hanging, never stops
 * another network's recorded settlements from being finished.
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { USDC } from "@rail402.dev/stellar";
import { acceptedAsset, createStellarFacilitator, MemorySettlementLedger } from "@rail402.dev/facilitator";

function twoNetworks(testnetLedger: MemorySettlementLedger) {
  const pubnetLedger = new MemorySettlementLedger();
  let pubnetAsked = 0;
  const unfinished = pubnetLedger.unfinished.bind(pubnetLedger);
  pubnetLedger.unfinished = (...args: Parameters<typeof unfinished>) => {
    pubnetAsked++;
    return unfinished(...args);
  };
  const facilitator = createStellarFacilitator({
    networks: [
      {
        network: "stellar:testnet",
        rpcUrl: "https://testnet.invalid",
        sponsorSecret: Keypair.random().secret(),
        channelCount: 1,
        ledger: testnetLedger,
      },
      {
        network: "stellar:pubnet",
        rpcUrl: "https://pubnet.invalid",
        sponsorSecret: Keypair.random().secret(),
        channelCount: 1,
        ledger: pubnetLedger,
        unguarded: true,
        assets: [acceptedAsset(USDC["stellar:pubnet"], { minAmount: 10_000n })],
        policy: { maxTransactionFeeStroops: 100_000, inclusionFeeStroops: 200 },
      },
    ],
  });
  return { facilitator, asked: () => pubnetAsked };
}

describe("reconciliation per network", () => {
  it("still reconciles pubnet when testnet's ledger fails", async () => {
    const testnet = new MemorySettlementLedger();
    testnet.unfinished = () => Promise.reject(new Error("testnet pool: timeout acquiring a connection"));
    const { facilitator, asked } = twoNetworks(testnet);
    await expect(facilitator.reconcile()).resolves.toBe(0);
    expect(asked()).toBe(1);
    await expect(facilitator.reconcileNetwork("stellar:testnet")).rejects.toThrow(/testnet pool/);
  });

  it("reconciles pubnet on its own while testnet's round hangs", async () => {
    const testnet = new MemorySettlementLedger();
    testnet.unfinished = () => new Promise(() => undefined);
    const { facilitator, asked } = twoNetworks(testnet);
    void facilitator.reconcileNetwork("stellar:testnet");
    await expect(facilitator.reconcileNetwork("stellar:pubnet")).resolves.toBe(0);
    expect(asked()).toBe(1);
  });
});
