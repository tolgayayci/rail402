import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair, Networks, type rpc } from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  DEFAULT_TIMING,
  MemoryChannelPool,
  MemorySettlementLedger,
  SettlementEngine,
  type NetworkPolicy,
  type PreflightedPayment,
  type SettlementTiming,
} from "@rail402.dev/facilitator";

/**
 * The settlement waits an in-process facilitator uses when `timing` is omitted, observed through the
 * engine's calls into its ledger, channel pool and RPC. Nothing here reaches a network.
 */
function engineWith(options: { timing?: Partial<SettlementTiming>; server?: Partial<rpc.Server> } = {}) {
  const channel = Keypair.random();
  const ledger = new MemorySettlementLedger();
  const channels = new MemoryChannelPool([channel.publicKey()]);
  const engine = new SettlementEngine({
    network: "stellar:testnet",
    passphrase: Networks.TESTNET,
    rpcUrl: "http://127.0.0.1:1/rpc",
    server: (options.server ?? {}) as rpc.Server,
    // The paths exercised here decide before any policy check.
    policy: {} as NetworkPolicy,
    ledger,
    channels,
    channelKeys: new Map([[channel.publicKey(), channel]]),
    sponsor: Keypair.random(),
    ...(options.timing === undefined ? {} : { timing: options.timing }),
  });
  return { engine, ledger, channels };
}

const payload = { x402Version: 2, payload: { transaction: "AAAA" } } as unknown as PaymentPayload;
const requirements = {} as PaymentRequirements;
const payment = {
  transfer: { from: Keypair.random().publicKey() },
  authorization: { nonce: 7n },
} as unknown as PreflightedPayment;

describe("settlement timing defaults", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("matches the documented defaults", () => {
    expect(DEFAULT_TIMING).toEqual({
      channelWaitMs: 5_000,
      claimTtlMs: 30_000,
      confirmTimeoutMs: 25_000,
      duplicateWaitMs: 25_000,
      pollIntervalMs: 1_000,
    });
  });

  it("claims for 30 s and waits 5 s for a free channel", async () => {
    const { engine, ledger, channels } = engineWith();
    const claim = vi.spyOn(ledger, "claim");
    const acquire = vi.spyOn(channels, "acquire").mockResolvedValue(undefined);
    const result = await engine.settle(payload, requirements, payment);
    expect(result).toMatchObject({ success: false, errorReason: "settle_exact_stellar_channel_unavailable" });
    expect(claim).toHaveBeenCalledWith(expect.anything(), expect.any(String), expect.any(String), 30_000);
    expect(acquire).toHaveBeenCalledWith(5_000);
  });

  it("keeps the other defaults when only some waits are overridden", async () => {
    const { engine, ledger, channels } = engineWith({ timing: { channelWaitMs: 10 } });
    const claim = vi.spyOn(ledger, "claim");
    const acquire = vi.spyOn(channels, "acquire").mockResolvedValue(undefined);
    await engine.settle(payload, requirements, payment);
    expect(acquire).toHaveBeenCalledWith(10);
    expect(claim).toHaveBeenCalledWith(expect.anything(), expect.any(String), expect.any(String), 30_000);
  });

  it("lets a duplicate request wait 25 s for the original", async () => {
    vi.useFakeTimers();
    const { engine, channels } = engineWith();
    // The original holds its claim while it waits for a channel that never frees up.
    vi.spyOn(channels, "acquire").mockReturnValue(new Promise(() => undefined));
    void engine.settle(payload, requirements, payment);

    let answered = false;
    const duplicate = engine.settle(payload, requirements, payment).finally(() => {
      answered = true;
    });
    await vi.advanceTimersByTimeAsync(24_900);
    expect(answered).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(answered).toBe(true);
    expect(await duplicate).toMatchObject({
      success: false,
      errorReason: "settle_exact_stellar_settlement_in_progress",
    });
  });

  it("polls for confirmation once a second", async () => {
    vi.useFakeTimers();
    const getTransaction = vi.fn(() => Promise.reject(new Error("RPC unavailable")));
    const { engine } = engineWith({ server: { getTransaction } });
    const record = {
      id: "settlement",
      key: { network: "stellar:testnet", payer: "GPAYER", nonce: "7" },
      payloadHash: "hash",
      state: "submitted",
      owner: "owner",
      claimExpiresAt: 0,
      createdAt: 0,
      updatedAt: 0,
      channel: "GCHANNEL",
      transactionHash: "a".repeat(64),
      innerTransactionHash: "b".repeat(64),
      envelopeXdr: "AAAA",
      validUntil: Number.MAX_SAFE_INTEGER,
      maxFeeStroops: "25000",
    } as const;

    const confirmed = engine.confirm(record, Date.now() + 5_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await confirmed).toMatchObject({ success: false, errorReason: "settlement_pending" });
    // At 0, 1, 2, 3, 4 and 5 seconds.
    expect(getTransaction).toHaveBeenCalledTimes(6);
  });
});
