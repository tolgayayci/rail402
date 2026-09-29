import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  ClaimLostError,
  MemoryChannelPool,
  MemorySettlementLedger,
  deriveChannelKeypair,
  deriveChannelKeypairs,
  settleFailed,
  settleSucceeded,
  verifyRejected,
} from "@rail402.dev/facilitator";
import { exactStellarCodes } from "@rail402.dev/stellar";

const key = { network: "stellar:testnet", payer: "GPAYER", nonce: "7" };
const envelope = {
  channel: "GCHANNEL",
  transactionHash: "a".repeat(64),
  innerTransactionHash: "b".repeat(64),
  envelopeXdr: "AAAA",
  validUntil: 1_700_000_000,
  maxFeeStroops: "25000",
};

describe("MemorySettlementLedger", () => {
  it("gives one claim per authorization and reports the holder to later callers", async () => {
    const ledger = new MemorySettlementLedger();
    const first = await ledger.claim(key, "hash-1", "owner-1", 30_000);
    const second = await ledger.claim(key, "hash-1", "owner-2", 30_000);
    expect(first.kind).toBe("claimed");
    expect(second).toMatchObject({ kind: "existing", record: { id: first.record.id, owner: "owner-1" } });
  });

  it("reports a conflict when the same authorization arrives in a different envelope", async () => {
    const ledger = new MemorySettlementLedger();
    await ledger.claim(key, "hash-1", "owner-1", 30_000);
    expect((await ledger.claim(key, "hash-2", "owner-2", 30_000)).kind).toBe("conflict");
  });

  it("lets a stale claim without an envelope be taken over", async () => {
    let now = 1_000;
    const ledger = new MemorySettlementLedger(() => now);
    const first = await ledger.claim(key, "hash-1", "owner-1", 5_000);
    now += 5_000;
    const taken = await ledger.claim(key, "hash-1", "owner-2", 5_000);
    expect(taken).toMatchObject({ kind: "claimed", record: { id: first.record.id, owner: "owner-2" } });
    await expect(ledger.recordEnvelope(first.record.id, "owner-1", envelope)).rejects.toBeInstanceOf(
      ClaimLostError,
    );
  });

  it("never lets a recorded envelope be taken over", async () => {
    let now = 1_000;
    const ledger = new MemorySettlementLedger(() => now);
    const { record } = await ledger.claim(key, "hash-1", "owner-1", 5_000);
    await ledger.recordEnvelope(record.id, "owner-1", envelope);
    now += 60_000;
    expect(await ledger.claim(key, "hash-1", "owner-2", 5_000)).toMatchObject({
      kind: "existing",
      record: { state: "submitted", transactionHash: envelope.transactionHash },
    });
    expect(await ledger.unfinished("stellar:testnet")).toHaveLength(1);
  });

  it("transitions to a terminal state exactly once", async () => {
    const ledger = new MemorySettlementLedger();
    const { record } = await ledger.claim(key, "hash-1", "owner-1", 5_000);
    await ledger.recordEnvelope(record.id, "owner-1", envelope);
    const success = settleSucceeded("stellar:testnet", envelope.transactionHash, "GPAYER");
    const first = await ledger.finish(record.id, "succeeded", success);
    const second = await ledger.finish(
      record.id,
      "failed",
      settleFailed({ code: "invalid_transaction_state", network: "x" }),
    );
    expect(first).toMatchObject({ transitioned: true, record: { state: "succeeded" } });
    expect(second).toMatchObject({ transitioned: false, record: { state: "succeeded", response: success } });
    expect(await ledger.unfinished("stellar:testnet")).toHaveLength(0);
  });

  it("drops an abandoned claim so the payment can be retried", async () => {
    const ledger = new MemorySettlementLedger();
    const { record } = await ledger.claim(key, "hash-1", "owner-1", 5_000);
    await ledger.abandon(record.id, "owner-1");
    expect((await ledger.claim(key, "hash-1", "owner-2", 5_000)).kind).toBe("claimed");
  });
});

describe("MemoryChannelPool", () => {
  it("leases each channel exclusively and hands released channels to waiters", async () => {
    const pool = new MemoryChannelPool(["A", "B"]);
    const [a, b] = [await pool.acquire(0), await pool.acquire(0)];
    expect(new Set([a, b])).toEqual(new Set(["A", "B"]));
    expect(await pool.acquire(0)).toBeUndefined();

    const waiting = pool.acquire(1_000);
    await pool.release("A");
    expect(await waiting).toBe("A");
    expect(await pool.inUse()).toBe(2);
  });

  it("times out a waiter and ignores releasing a free channel", async () => {
    const pool = new MemoryChannelPool(["A"]);
    await pool.acquire(0);
    expect(await pool.acquire(20)).toBeUndefined();
    await pool.release("A");
    await pool.release("A");
    expect(await pool.inUse()).toBe(0);
    expect(await pool.acquire(0)).toBe("A");
  });

  it("rejects empty or duplicate pools", () => {
    expect(() => new MemoryChannelPool([])).toThrow();
    expect(() => new MemoryChannelPool(["A", "A"])).toThrow();
  });
});

describe("channel key derivation", () => {
  it("is deterministic per sponsor, network and index, and never collides", () => {
    const sponsor = Keypair.random();
    const again = Keypair.fromSecret(sponsor.secret());
    expect(deriveChannelKeypair(sponsor, "stellar:testnet", 3).publicKey()).toBe(
      deriveChannelKeypair(again, "stellar:testnet", 3).publicKey(),
    );
    const testnet = deriveChannelKeypairs(sponsor, "stellar:testnet", 50).map((k) => k.publicKey());
    const pubnet = deriveChannelKeypairs(sponsor, "stellar:pubnet", 50).map((k) => k.publicKey());
    expect(new Set([...testnet, ...pubnet, sponsor.publicKey()]).size).toBe(101);
    expect(deriveChannelKeypair(Keypair.random(), "stellar:testnet", 3).publicKey()).not.toBe(testnet[3]);
  });

  it("rejects invalid indexes", () => {
    expect(() => deriveChannelKeypair(Keypair.random(), "stellar:testnet", -1)).toThrow(RangeError);
  });
});

describe("wire responses", () => {
  it("always carry a registered code and a non-empty reason", () => {
    for (const code of Object.keys(exactStellarCodes) as (keyof typeof exactStellarCodes)[]) {
      const verify = verifyRejected(code);
      const settle = settleFailed({ code, network: "stellar:testnet" });
      expect(verify.invalidReason).toBe(code);
      expect(verify.invalidMessage?.trim()).not.toBe("");
      expect(settle.errorReason).toBe(code);
      expect(settle.errorMessage?.trim()).not.toBe("");
      expect(settle.transaction).toBe("");
    }
  });
});
