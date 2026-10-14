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
import { ClaimLostError, type RequestFingerprint, type SettlementLedger } from "./ledger.ts";
import { settleFailed, settleSucceeded } from "./responses.ts";

export interface LedgerFixture {
  readonly ledger: SettlementLedger;
  /** Makes claims created so far look older than any TTL used by the suite (≥ 1 hour). */
  readonly expireClaims: () => Promise<void>;
}

/** A fingerprint whose payload and request hashes are both `hash`. */
function request(hash: string, terms = hash): RequestFingerprint {
  return { payloadHash: hash, requestHash: terms };
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
        Array.from({ length: 10 }, (_, i) =>
          ledger.claim(key, request("payload"), `owner-${String(i)}`, 60_000),
        ),
      );
      expect(claims.filter((claim) => claim.kind === "claimed")).toHaveLength(1);
      expect(new Set(claims.map((claim) => claim.record.id)).size).toBe(1);
    });

    it("reports a conflict for the same authorization in a different envelope", async () => {
      const { ledger } = await create();
      const key = freshKey();
      await ledger.claim(key, request("payload-a"), "owner-1", 60_000);
      expect((await ledger.claim(key, request("payload-b"), "owner-2", 60_000)).kind).toBe("conflict");
    });

    it("reports a conflict for the same transaction under different request terms", async () => {
      const { ledger } = await create();
      const key = freshKey();
      const { record } = await ledger.claim(key, request("payload", "terms-a"), "owner-1", 60_000);
      expect(record).toMatchObject({ payloadHash: "payload", requestHash: "terms-a" });
      expect(await ledger.claim(key, request("payload", "terms-b"), "owner-2", 60_000)).toMatchObject({
        kind: "conflict",
        record: { id: record.id },
      });
      expect((await ledger.claim(key, request("payload", "terms-a"), "owner-2", 60_000)).kind).toBe(
        "existing",
      );
    });

    it("finds a record by its key, read-only", async () => {
      const { ledger } = await create();
      const key = freshKey();
      expect(await ledger.find(key)).toBeUndefined();
      const { record } = await ledger.claim(key, request("payload"), "owner-1", 60_000);
      expect(await ledger.find(key)).toMatchObject({ id: record.id, state: "claimed", owner: "owner-1" });
      expect(await ledger.find({ ...key, nonce: `${key.nonce}0` })).toBeUndefined();
      expect(await ledger.find({ ...key, network: "stellar:pubnet" })).toBeUndefined();
      expect((await ledger.claim(key, request("payload"), "owner-2", 60_000)).kind).toBe("existing");
    });

    it("stores the fee charged and who settled with the final state", async () => {
      const { ledger } = await create();
      const first = await ledger.claim(freshKey(), request("payload"), "owner-1", 60_000);
      await ledger.recordEnvelope(first.record.id, "owner-1", envelope(6));
      const success = settleSucceeded("stellar:testnet", envelope(6).transactionHash, "GPAYER");
      await ledger.finish(first.record.id, "succeeded", success, { feeChargedStroops: 51_234n });
      expect(await ledger.get(first.record.id)).toMatchObject({
        feeChargedStroops: "51234",
        settledBy: "rail402",
      });

      const second = await ledger.claim(freshKey(), request("payload"), "owner-1", 60_000);
      await ledger.recordEnvelope(second.record.id, "owner-1", envelope(7));
      await ledger.finish(second.record.id, "succeeded", success, { settledBy: "third_party" });
      const stored = await ledger.get(second.record.id);
      expect(stored?.settledBy).toBe("third_party");
      expect(stored?.feeChargedStroops).toBeUndefined();
    });

    it("counts records per state for one network since a point in time", async () => {
      const { ledger } = await create();
      const network = `stellar:states-${String(++sequence)}`;
      const before = new Date(Date.now() - 60_000);
      const claimOn = (payer: string) =>
        ledger.claim({ network, payer, nonce: "1" }, request("payload"), "o", 60_000);
      await claimOn("GCLAIMED");
      const submitted = await claimOn("GSUBMITTED");
      await ledger.recordEnvelope(submitted.record.id, "o", envelope(8));
      for (const [n, state] of [
        [9, "succeeded"],
        [10, "failed"],
        [11, "failed"],
      ] as const) {
        const { record } = await claimOn(`GFINISHED${String(n)}`);
        await ledger.recordEnvelope(record.id, "o", envelope(n));
        await ledger.finish(
          record.id,
          state,
          state === "succeeded"
            ? settleSucceeded(network, envelope(n).transactionHash, "GPAYER")
            : settleFailed({ code: "invalid_transaction_state", network }),
        );
      }
      expect(await ledger.countByState(network, before)).toEqual({
        claimed: 1,
        submitted: 1,
        succeeded: 1,
        failed: 2,
        expired: 0,
      });
      expect(await ledger.countByState(network, new Date(Date.now() + 60_000))).toEqual({
        claimed: 0,
        submitted: 0,
        succeeded: 0,
        failed: 0,
        expired: 0,
      });
    });

    it("lets a stale claim be taken over, and the old owner can no longer record an envelope", async () => {
      const { ledger, expireClaims } = await create();
      const key = freshKey();
      const first = await ledger.claim(key, request("payload"), "owner-1", 60_000);
      await expireClaims();
      const taken = await ledger.claim(key, request("payload"), "owner-2", 60_000);
      expect(taken).toMatchObject({ kind: "claimed", record: { id: first.record.id, owner: "owner-2" } });
      await expect(ledger.recordEnvelope(first.record.id, "owner-1", envelope(1))).rejects.toBeInstanceOf(
        ClaimLostError,
      );
      await ledger.recordEnvelope(first.record.id, "owner-2", envelope(1));
    });

    it("keeps a recorded envelope forever and lists it until it is finished", async () => {
      const { ledger, expireClaims } = await create();
      const key = freshKey();
      const { record } = await ledger.claim(key, request("payload"), "owner-1", 60_000);
      await ledger.recordEnvelope(record.id, "owner-1", envelope(2));
      await expireClaims();
      expect(await ledger.claim(key, request("payload"), "owner-2", 60_000)).toMatchObject({
        kind: "existing",
        record: { state: "submitted", ...envelope(2) },
      });
      const unfinished = await ledger.unfinished("stellar:testnet");
      expect(unfinished.map((r) => r.id)).toContain(record.id);
      expect(await ledger.unfinished("stellar:pubnet")).toEqual([]);
    });

    it("lists a recorded envelope as idle only once it was recorded that long ago", async () => {
      const { ledger } = await create();
      const { record } = await ledger.claim(freshKey(), request("payload"), "owner-1", 60_000);
      await ledger.recordEnvelope(record.id, "owner-1", envelope(9));
      const ids = async (idleForMs?: number) =>
        (await ledger.unfinished("stellar:testnet", idleForMs === undefined ? {} : { idleForMs })).map(
          (r) => r.id,
        );
      expect(await ids(60_000)).not.toContain(record.id);
      expect(await ids(0)).toContain(record.id);
      expect(await ids()).toContain(record.id);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(await ids(20)).toContain(record.id);
    });

    it("finishes exactly once and stores the response verbatim", async () => {
      const { ledger } = await create();
      const { record } = await ledger.claim(freshKey(), request("payload"), "owner-1", 60_000);
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
          request("payload"),
          "o",
          60_000,
        );
        await ledger.recordEnvelope(record.id, "o", envelope(n));
      }
      await ledger.claim({ network, payer: "GNOENVELOPE", nonce: "1" }, request("payload"), "o", 60_000);
      expect(await ledger.committedFeesSince(network, before)).toBe(9_000n);
      expect(await ledger.committedFeesSince(network, new Date(Date.now() + 60_000))).toBe(0n);
    });

    it("records the scheme and the settle-time amount of a claim", async () => {
      const { ledger } = await create();
      const legacy = await ledger.claim(freshKey(), request("payload"), "owner-1", 60_000);
      expect(legacy.record.scheme).toBe("exact");
      expect(legacy.record.amount).toBeUndefined();
      const key = freshKey();
      const upto = await ledger.claim(key, request("payload"), "owner-1", 60_000, {
        scheme: "upto",
        amount: "250000",
      });
      expect(upto.record).toMatchObject({ scheme: "upto", amount: "250000" });
      expect(await ledger.find(key)).toMatchObject({ scheme: "upto", amount: "250000" });
    });

    it("finishes an upto zero-amount success without an envelope, only for the claim's owner", async () => {
      const { ledger } = await create();
      const key = freshKey();
      const { record } = await ledger.claim(key, request("payload"), "owner-1", 60_000, {
        scheme: "upto",
        amount: "0",
      });
      const success = { ...settleSucceeded("stellar:testnet", "", "GPAYER"), amount: "0" };
      expect(
        (await ledger.finish(record.id, "succeeded", success, { claimedBy: "owner-2" })).transitioned,
      ).toBe(false);
      const finished = await ledger.finish(record.id, "succeeded", success, { claimedBy: "owner-1" });
      expect(finished.transitioned).toBe(true);
      expect(await ledger.find(key)).toMatchObject({ state: "succeeded", response: success });
      expect((await ledger.find(key))?.envelopeXdr).toBeUndefined();
      expect((await ledger.claim(key, request("payload"), "owner-3", 60_000)).kind).toBe("existing");
      expect(
        (await ledger.finish(record.id, "succeeded", success, { claimedBy: "owner-1" })).transitioned,
      ).toBe(false);
    });

    it("never finishes any other settlement without an envelope", async () => {
      const { ledger } = await create();
      const success = settleSucceeded("stellar:testnet", "", "GPAYER");
      const partial = await ledger.claim(freshKey(), request("payload"), "o", 60_000, {
        scheme: "upto",
        amount: "5",
      });
      await expect(
        ledger.finish(partial.record.id, "succeeded", success, { claimedBy: "o" }),
      ).rejects.toThrow();
      const exact = await ledger.claim(freshKey(), request("payload"), "o", 60_000);
      await expect(ledger.finish(exact.record.id, "succeeded", success)).rejects.toThrow();
      const zero = await ledger.claim(freshKey(), request("payload"), "o", 60_000, {
        scheme: "upto",
        amount: "0",
      });
      await expect(
        ledger.finish(
          zero.record.id,
          "failed",
          settleFailed({ code: "unexpected_settle_error", network: "x" }),
        ),
      ).rejects.toThrow();
      expect((await ledger.get(zero.record.id))?.state).toBe("claimed");
    });

    it("drops an abandoned claim so the authorization can be claimed again", async () => {
      const { ledger } = await create();
      const key = freshKey();
      const { record } = await ledger.claim(key, request("payload"), "owner-1", 60_000);
      await ledger.abandon(record.id, "owner-2");
      expect((await ledger.claim(key, request("payload"), "owner-3", 60_000)).kind).toBe("existing");
      await ledger.abandon(record.id, "owner-1");
      expect((await ledger.claim(key, request("payload"), "owner-3", 60_000)).kind).toBe("claimed");
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
