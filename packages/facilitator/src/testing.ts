/**
 * Conformance suites for settlement ledgers and channel pools. Every implementation — the in-memory
 * defaults, Postgres, or an operator's own store — must pass these to be used by the settlement engine.
 *
 * Requires vitest in the consuming project:
 *
 *   import { settlementLedgerSuite } from "@rail402.dev/facilitator/testing";
 *   settlementLedgerSuite("my ledger", async () => ({ ledger: await makeLedger(), expireClaims }));
 */
import { describe, expect, it } from "vitest";
import type { ChannelPool } from "./channels.ts";
import { ClaimLostError, type SettlementLedger } from "./ledger.ts";
import { settleFailed, settleSucceeded } from "./responses.ts";

export interface LedgerFixture {
  readonly ledger: SettlementLedger;
  /** Makes claims created so far look older than any TTL used by the suite (≥ 1 hour). */
  readonly expireClaims: () => Promise<void>;
}

export function settlementLedgerSuite(name: string, create: () => Promise<LedgerFixture>): void {
  let sequence = 0;
  const freshKey = () => ({
    network: "stellar:testnet",
    payer: `GPAYER${String(++sequence)}`,
    nonce: String(sequence),
  });
  const envelope = (n: number) => ({
    channel: `GCHANNEL${String(n)}`,
    transactionHash: n.toString(16).padStart(64, "0"),
    innerTransactionHash: (n + 1).toString(16).padStart(64, "0"),
    envelopeXdr: `ENVELOPE${String(n)}`,
    validUntil: 1_700_000_000 + n,
    maxFeeStroops: String(1_000 * n),
  });

  describe(`${name}: settlement ledger contract`, () => {
    it("grants exactly one claim per authorization, even under concurrency", async () => {
      const { ledger } = await create();
      const key = freshKey();
      const claims = await Promise.all(
        Array.from({ length: 10 }, (_, i) => ledger.claim(key, "payload", `owner-${String(i)}`, 60_000)),
      );
      expect(claims.filter((claim) => claim.kind === "claimed")).toHaveLength(1);
      expect(new Set(claims.map((claim) => claim.record.id)).size).toBe(1);
    });

    it("reports a conflict for the same authorization in a different envelope", async () => {
      const { ledger } = await create();
      const key = freshKey();
      await ledger.claim(key, "payload-a", "owner-1", 60_000);
      expect((await ledger.claim(key, "payload-b", "owner-2", 60_000)).kind).toBe("conflict");
    });

    it("lets a stale claim be taken over, and the old owner can no longer record an envelope", async () => {
      const { ledger, expireClaims } = await create();
      const key = freshKey();
      const first = await ledger.claim(key, "payload", "owner-1", 60_000);
      await expireClaims();
      const taken = await ledger.claim(key, "payload", "owner-2", 60_000);
      expect(taken).toMatchObject({ kind: "claimed", record: { id: first.record.id, owner: "owner-2" } });
      await expect(ledger.recordEnvelope(first.record.id, "owner-1", envelope(1))).rejects.toBeInstanceOf(
        ClaimLostError,
      );
      await ledger.recordEnvelope(first.record.id, "owner-2", envelope(1));
    });

    it("keeps a recorded envelope forever and lists it until it is finished", async () => {
      const { ledger, expireClaims } = await create();
      const key = freshKey();
      const { record } = await ledger.claim(key, "payload", "owner-1", 60_000);
      await ledger.recordEnvelope(record.id, "owner-1", envelope(2));
      await expireClaims();
      expect(await ledger.claim(key, "payload", "owner-2", 60_000)).toMatchObject({
        kind: "existing",
        record: { state: "submitted", ...envelope(2) },
      });
      const unfinished = await ledger.unfinished("stellar:testnet");
      expect(unfinished.map((r) => r.id)).toContain(record.id);
      expect(await ledger.unfinished("stellar:pubnet")).toEqual([]);
    });

    it("finishes exactly once and stores the response verbatim", async () => {
      const { ledger } = await create();
      const { record } = await ledger.claim(freshKey(), "payload", "owner-1", 60_000);
      await ledger.recordEnvelope(record.id, "owner-1", envelope(3));
      const success = settleSucceeded("stellar:testnet", envelope(3).transactionHash, "GPAYER");
      const results = await Promise.all([
        ledger.finish(record.id, "succeeded", success),
        ledger.finish(record.id, "failed", settleFailed({ code: "invalid_transaction_state", network: "x" })),
      ]);
      expect(results.filter((result) => result.transitioned)).toHaveLength(1);
      const stored = await ledger.get(record.id);
      expect(stored?.response).toEqual(results.find((result) => result.transitioned)?.record.response);
      expect((await ledger.unfinished("stellar:testnet")).map((r) => r.id)).not.toContain(record.id);
    });

    it("sums the fees committed by recorded envelopes since a point in time", async () => {
      const { ledger } = await create();
      const network = `stellar:fees-${String(++sequence)}`;
      const before = new Date(Date.now() - 60_000);
      for (const n of [4, 5]) {
        const { record } = await ledger.claim(
          { network, payer: `GFEE${String(n)}`, nonce: "1" },
          "payload",
          "o",
          60_000,
        );
        await ledger.recordEnvelope(record.id, "o", envelope(n));
      }
      await ledger.claim({ network, payer: "GNOENVELOPE", nonce: "1" }, "payload", "o", 60_000);
      expect(await ledger.committedFeesSince(network, before)).toBe(9_000n);
      expect(await ledger.committedFeesSince(network, new Date(Date.now() + 60_000))).toBe(0n);
    });

    it("drops an abandoned claim so the authorization can be claimed again", async () => {
      const { ledger } = await create();
      const key = freshKey();
      const { record } = await ledger.claim(key, "payload", "owner-1", 60_000);
      await ledger.abandon(record.id, "owner-2");
      expect((await ledger.claim(key, "payload", "owner-3", 60_000)).kind).toBe("existing");
      await ledger.abandon(record.id, "owner-1");
      expect((await ledger.claim(key, "payload", "owner-3", 60_000)).kind).toBe("claimed");
    });
  });
}

export function channelPoolSuite(
  name: string,
  create: (addresses: readonly string[]) => Promise<ChannelPool>,
): void {
  describe(`${name}: channel pool contract`, () => {
    it("never leases one channel twice, even under concurrency", async () => {
      const addresses = Array.from({ length: 5 }, (_, i) => `GCHANNEL${String(i)}`);
      const pool = await create(addresses);
      const leased = await Promise.all(Array.from({ length: 8 }, () => pool.acquire(0)));
      const granted = leased.filter((address) => address !== undefined);
      expect(granted).toHaveLength(5);
      expect(new Set(granted).size).toBe(5);
      expect(await pool.inUse()).toBe(5);
    });

    it("hands a released channel to a waiting request", async () => {
      const pool = await create(["GONLY"]);
      expect(await pool.acquire(0)).toBe("GONLY");
      const waiting = pool.acquire(5_000);
      await pool.release("GONLY");
      expect(await waiting).toBe("GONLY");
    });

    it("gives up after the wait and treats double release as a no-op", async () => {
      const pool = await create(["GONLY"]);
      await pool.acquire(0);
      expect(await pool.acquire(50)).toBeUndefined();
      await pool.release("GONLY");
      await pool.release("GONLY");
      expect(await pool.inUse()).toBe(0);
    });
  });
}
