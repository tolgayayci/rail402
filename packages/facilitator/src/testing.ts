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
import { Keypair, Networks } from "@stellar/stellar-sdk";
import { MemoryChannelPool, type ChannelPool } from "./channels.ts";
import { SettlementEngine } from "./engine.ts";
import {
  ClaimLostError,
  ClaimRefusedError,
  SpendRefusedError,
  type ClaimLimit,
  type RequestFingerprint,
  type SettlementLedger,
  FIRST_SEND,
  broadcastMayBePublic,
} from "./ledger.ts";
import type { NetworkPolicy } from "./policy.ts";
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
    // Each fee-limit test uses a network of its own, so earlier tests' fees never count.
    const hourAgo = () => new Date(Date.now() - 3_600_000);
    const budgetKey = (network: string) => ({ ...freshKey(), network });
    const limit = (scope: ClaimLimit["scope"], capStroops: bigint): ClaimLimit => ({
      scope,
      capStroops,
      since: hourAgo(),
    });

    it("tracks the sends of recorded bytes: public once one is accepted or its answer is lost", async () => {
      const { ledger } = await create();
      let envelopes = 100;
      const recorded = async () => {
        const { record } = await ledger.claim(freshKey(), request("payload"), "o", 60_000);
        await ledger.recordEnvelope(record.id, "o", envelope((envelopes += 10)));
        return record.id;
      };
      const read = async (id: string) => {
        const record = await ledger.get(id);
        if (record === undefined) throw new Error("no record");
        return record;
      };
      // The scheme's own send is in flight from the moment the envelope is recorded.
      const refused = await recorded();
      expect(await read(refused)).toMatchObject({ broadcastAccepted: false, sendsInFlight: [FIRST_SEND] });
      expect(broadcastMayBePublic(await read(refused))).toBe(true);
      await ledger.endSend(refused, FIRST_SEND, false);
      await ledger.beginSend(refused, "resend-1");
      await ledger.endSend(refused, "resend-1", false);
      expect(await read(refused)).toMatchObject({ broadcastAccepted: false, sendsInFlight: [] });
      expect(broadcastMayBePublic(await read(refused))).toBe(false);
      // An accepted send makes the bytes public for good, whatever later sends answer.
      await ledger.beginSend(refused, "resend-2");
      await ledger.endSend(refused, "resend-2", true);
      await ledger.beginSend(refused, "resend-3");
      await ledger.endSend(refused, "resend-3", false);
      expect(await read(refused)).toMatchObject({ broadcastAccepted: true, sendsInFlight: [] });
      expect(broadcastMayBePublic(await read(refused))).toBe(true);
      // A send that is never answered keeps them possibly public.
      const lost = await recorded();
      await ledger.endSend(lost, FIRST_SEND, false);
      await ledger.beginSend(lost, "resend-1");
      expect(await read(lost)).toMatchObject({ broadcastAccepted: false, sendsInFlight: ["resend-1"] });
      expect(broadcastMayBePublic(await read(lost))).toBe(true);
    });

    it("lets a submitted settlement give its channel back once, and keeps that when it finishes", async () => {
      const { ledger } = await create();
      if (ledger.releaseChannel === undefined) return;
      const { record: claimed } = await ledger.claim(freshKey(), request("payload"), "o", 60_000);
      // Nothing to give back before an envelope holds a channel.
      expect(await ledger.releaseChannel(claimed.id)).toBe(false);
      await ledger.recordEnvelope(claimed.id, "o", envelope(140));
      expect((await ledger.get(claimed.id))?.channelReleased).toBeUndefined();
      expect(await ledger.releaseChannel(claimed.id)).toBe(true);
      expect(await ledger.releaseChannel(claimed.id)).toBe(false);
      expect(await ledger.get(claimed.id)).toMatchObject({
        state: "submitted",
        channel: envelope(140).channel,
        channelReleased: true,
      });
      const listed = await ledger.unfinished("stellar:testnet");
      expect(listed.find((record) => record.id === claimed.id)).toMatchObject({ channelReleased: true });
      const { record: finished, transitioned } = await ledger.finish(claimed.id, "failed", {
        success: false,
        transaction: envelope(140).transactionHash,
        network: "stellar:testnet",
      });
      expect(transitioned).toBe(true);
      expect(finished.channelReleased).toBe(true);
      expect(await ledger.releaseChannel(claimed.id)).toBe(false);
    });

    it("reserves a claim's fee until its envelope replaces the reservation", async () => {
      const { ledger } = await create();
      const network = `test:reserve-${String(++sequence)}`;
      const { record } = await ledger.claim(budgetKey(network), request("p"), "o", 60_000, {
        caller: "key:a",
        reserveFeeStroops: 5_000n,
        limits: [limit("network", 1_000_000n)],
      });
      expect(record.caller).toBe("key:a");
      expect(await ledger.committedFeesSince(network, hourAgo())).toBe(5_000n);
      await ledger.recordEnvelope(record.id, "o", { ...envelope(3), maxFeeStroops: "3000" });
      expect(await ledger.committedFeesSince(network, hourAgo())).toBe(3_000n);
      expect(await ledger.committedFeesSince(network, hourAgo(), "key:a")).toBe(3_000n);
      expect(await ledger.committedFeesSince(network, hourAgo(), "key:b")).toBe(0n);
      // An abandoned claim releases its reservation.
      const second = await ledger.claim(budgetKey(network), request("q"), "o", 60_000, {
        reserveFeeStroops: 7_000n,
        limits: [limit("network", 1_000_000n)],
      });
      expect(await ledger.committedFeesSince(network, hourAgo())).toBe(10_000n);
      await ledger.abandon(second.record.id, "o");
      expect(await ledger.committedFeesSince(network, hourAgo())).toBe(3_000n);
    });

    it("refuses a claim beyond a fee limit and records nothing", async () => {
      const { ledger } = await create();
      const network = `test:refuse-${String(++sequence)}`;
      const details = (caller: string) => ({
        caller,
        reserveFeeStroops: 4_000n,
        limits: [limit("network", 10_000n), limit("caller", 6_000n)],
      });
      await ledger.claim(budgetKey(network), request("a"), "o", 60_000, details("key:a"));
      // key:a would pass the network budget but exceeds its own.
      const key = budgetKey(network);
      await expect(ledger.claim(key, request("b"), "o", 60_000, details("key:a"))).rejects.toBeInstanceOf(
        ClaimRefusedError,
      );
      expect(await ledger.find(key)).toBeUndefined();
      await ledger.claim(budgetKey(network), request("c"), "o", 60_000, details("key:b"));
      // 8,000 committed: a third reservation of 4,000 exceeds the network's 10,000.
      const refused = await ledger
        .claim(budgetKey(network), request("d"), "o", 60_000, details("key:c"))
        .catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(ClaimRefusedError);
      expect((refused as ClaimRefusedError).limit.scope).toBe("network");
    });

    it("answers a key it already holds whatever the limits say", async () => {
      const { ledger } = await create();
      const network = `test:held-${String(++sequence)}`;
      const key = budgetKey(network);
      const details = { reserveFeeStroops: 4_000n, limits: [limit("network", 5_000n)] };
      await ledger.claim(key, request("a"), "o", 60_000, details);
      expect((await ledger.claim(key, request("a"), "o2", 60_000, details)).kind).toBe("existing");
    });

    it("never lets concurrent claims at the budget edge exceed the budget", async () => {
      const { ledger } = await create();
      const network = `test:edge-${String(++sequence)}`;
      const outcomes = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          ledger
            .claim(budgetKey(network), request(`edge-${String(i)}`), "o", 60_000, {
              reserveFeeStroops: 1_000n,
              limits: [limit("network", 5_500n)],
            })
            .then(
              () => "claimed",
              (error: unknown) => (error instanceof ClaimRefusedError ? "refused" : "error"),
            ),
        ),
      );
      expect(outcomes.filter((outcome) => outcome === "claimed")).toHaveLength(5);
      expect(outcomes.filter((outcome) => outcome === "refused")).toHaveLength(15);
      expect(await ledger.committedFeesSince(network, hourAgo())).toBe(5_000n);
    });

    it("counts a payer's included failures and the sponsor's other spend", async () => {
      const { ledger } = await create();
      const network = `test:failures-${String(++sequence)}`;
      const key = { ...budgetKey(network), payer: "GFAILING" };
      const { record } = await ledger.claim(key, request("f"), "o", 60_000);
      await ledger.recordEnvelope(record.id, "o", envelope(41));
      await ledger.finish(record.id, "failed", settleFailed({ code: "invalid_transaction_state", network }), {
        feeChargedStroops: 300n,
      });
      expect(await ledger.failuresSince?.(network, "GFAILING", hourAgo())).toBe(1);
      expect(await ledger.failuresSince?.(network, "GOTHER", hourAgo())).toBe(0);
      expect(await ledger.failuresSince?.(network, "GFAILING", new Date(Date.now() + 60_000))).toBe(0);

      const before = await ledger.committedFeesSince(network, hourAgo());
      await ledger.recordSponsorSpend?.(network, "upto_ttl", 2_500n);
      expect(await ledger.sponsorSpendSince?.(network, hourAgo(), "upto_ttl")).toBe(2_500n);
      expect(await ledger.sponsorSpendSince?.(network, hourAgo(), "other")).toBe(0n);
      // Spend outside settlements counts toward the network, never toward a caller.
      expect(await ledger.committedFeesSince(network, hourAgo())).toBe(before + 2_500n);
      expect(await ledger.committedFeesSince(network, hourAgo(), "public")).toBe(before);
    });

    it("reserves sponsor spend within its caps before submission and corrects it afterwards", async () => {
      const { ledger } = await create();
      if (ledger.reserveSponsorSpend === undefined || ledger.settleSponsorSpend === undefined) return;
      const network = `test:spend-${String(++sequence)}`;
      const dayAgo = new Date(Date.now() - 86_400_000);
      const daily = { scope: "kind" as const, capStroops: 10_000n, since: dayAgo };
      const hourly = { scope: "network" as const, capStroops: 12_000n, since: hourAgo() };
      const { record } = await ledger.claim(budgetKey(network), request("s"), "o", 60_000, {
        reserveFeeStroops: 3_000n,
        limits: [limit("network", 1_000_000n)],
      });
      expect(record.state).toBe("claimed");

      const first = await ledger.reserveSponsorSpend(network, "upto_ttl", 6_000n, [daily, hourly]);
      // The ceiling counts at once, toward the network and toward its own kind.
      expect(await ledger.sponsorSpendSince?.(network, dayAgo, "upto_ttl")).toBe(6_000n);
      expect(await ledger.committedFeesSince(network, hourAgo())).toBe(9_000n);
      // A second ceiling would pass the daily cap (6,000 + 6,000 > 10,000): refused, nothing recorded.
      const refused = await ledger
        .reserveSponsorSpend(network, "upto_ttl", 6_000n, [daily, hourly])
        .catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(SpendRefusedError);
      expect((refused as SpendRefusedError).limit.scope).toBe("kind");
      expect((refused as SpendRefusedError).committedStroops).toBe(6_000n);
      expect(await ledger.sponsorSpendSince?.(network, dayAgo, "upto_ttl")).toBe(6_000n);

      // Corrected to what was charged, the room comes back.
      await ledger.settleSponsorSpend(first, 1_500n);
      expect(await ledger.committedFeesSince(network, hourAgo())).toBe(4_500n);
      await ledger.reserveSponsorSpend(network, "upto_ttl", 6_000n, [daily, hourly]);
      // The network budget counts the settlement claim too: 3,000 + 1,500 + 6,000 + 6,000 > 12,000.
      const overBudget = await ledger
        .reserveSponsorSpend(network, "other", 6_000n, [hourly])
        .catch((error: unknown) => error);
      expect((overBudget as SpendRefusedError).limit.scope).toBe("network");
      expect((overBudget as SpendRefusedError).committedStroops).toBe(10_500n);
    });

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

    it("gives a stale claim's settle attempt id to the request that takes it over", async () => {
      const { ledger, expireClaims } = await create();
      const key = freshKey();
      const first = await ledger.claim(key, request("payload"), "owner-1", 60_000, {
        attempt: "dead-attempt-id-00001",
      });
      expect(first.record.attempt).toBe("dead-attempt-id-00001");
      // A live claim keeps its id, whatever a repeat carries.
      const repeat = await ledger.claim(key, request("payload"), "owner-2", 60_000, {
        attempt: "repeat-attempt-id-0002",
      });
      expect(repeat).toMatchObject({ kind: "existing", record: { attempt: "dead-attempt-id-00001" } });
      await expireClaims();
      // The request that takes it over settles it: its id, or none, is the one repeats echo.
      const taken = await ledger.claim(key, request("payload"), "owner-3", 60_000, {
        attempt: "taking-attempt-id-003",
      });
      expect(taken).toMatchObject({ kind: "claimed", record: { attempt: "taking-attempt-id-003" } });
      expect((await ledger.get(first.record.id))?.attempt).toBe("taking-attempt-id-003");
      await expireClaims();
      const anonymous = await ledger.claim(key, request("payload"), "owner-4", 60_000);
      expect(anonymous.kind).toBe("claimed");
      expect(anonymous.record.attempt).toBeUndefined();
      expect((await ledger.get(first.record.id))?.attempt).toBeUndefined();
    });

    it("answers a repeat that waited through a takeover with the attempt id of the request that took it over", async () => {
      const { ledger, expireClaims } = await create();
      const key = freshKey();
      const fingerprint = request("payload");
      const channel = Keypair.random();
      const engine = new SettlementEngine({
        network: "stellar:testnet",
        passphrase: Networks.TESTNET,
        rpcUrl: "http://127.0.0.1:1/rpc",
        server: {} as never,
        policy: {} as NetworkPolicy,
        ledger,
        channels: new MemoryChannelPool([channel.publicKey()]),
        channelKeys: new Map([[channel.publicKey(), channel]]),
        sponsor: Keypair.random(),
        timing: { duplicateWaitMs: 10_000, pollIntervalMs: 10 },
      });
      // A request claims the settlement, and its process dies there.
      await ledger.claim(key, fingerprint, "owner-1", 60_000, { attempt: "dead-attempt-id-00001" });
      // A repeat finds the live claim and waits for it.
      const waiting = engine.execute(
        { scheme: "exact", key, fingerprint, payer: key.payer, attempt: "waiting-attempt-id-02" },
        {
          submit: () => Promise.reject(new Error("a waiting request never signs")),
          unsigned: (result) => Promise.resolve(result),
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      // The claim goes stale, and another request takes it over and settles.
      await expireClaims();
      const taken = await ledger.claim(key, fingerprint, "owner-2", 60_000, {
        attempt: "taking-attempt-id-003",
      });
      expect(taken.kind).toBe("claimed");
      await ledger.recordEnvelope(taken.record.id, "owner-2", envelope(7));
      await ledger.finish(
        taken.record.id,
        "succeeded",
        settleSucceeded("stellar:testnet", "7".repeat(64), key.payer),
      );
      expect((await waiting).extensionResponses).toEqual({
        rail402: { settlement: { repeat: true, settledBy: "rail402", attempt: "taking-attempt-id-003" } },
      });
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

    it("counts a finished settlement's charged fee, nothing when it expired or was refused unsent", async () => {
      const { ledger } = await create();
      const network = `stellar:finished-${String(++sequence)}`;
      const since = new Date(Date.now() - 60_000);
      const finished = async (n: number, state: "succeeded" | "failed" | "expired", fee?: bigint) => {
        const { record } = await ledger.claim(
          { network, payer: `GDONE${String(n)}`, nonce: "1" },
          request("payload"),
          "o",
          60_000,
        );
        await ledger.recordEnvelope(record.id, "o", envelope(n));
        await ledger.finish(
          record.id,
          state,
          state === "succeeded"
            ? settleSucceeded(network, "aa", `GDONE${String(n)}`)
            : settleFailed({ code: "settle_exact_stellar_transaction_submission_failed", network }),
          fee === undefined ? {} : { feeChargedStroops: fee },
        );
      };
      await finished(10, "succeeded", 2_345n); // ceiling 10 000, charged 2 345
      await finished(11, "failed", 0n); // the network refused the submission: nothing charged
      await finished(12, "expired"); // never included: nothing charged
      await finished(13, "succeeded"); // charged fee unknown: the ceiling, 13 000
      expect(await ledger.committedFeesSince(network, since)).toBe(2_345n + 13_000n);
      // A refused submission is no included failure: the payer cooldown does not count it.
      expect(await ledger.failuresSince?.(network, "GDONE11", since)).toBe(0);
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

    it("keeps a quarantined channel out of rotation until its cooldown passes", async () => {
      const pool = await create(["GONLY"]);
      expect(await pool.acquire(0)).toBe("GONLY");
      const started = Date.now();
      await pool.quarantine("GONLY", 200);
      expect(await pool.inUse()).toBe(0);
      expect(await pool.acquire(0)).toBeUndefined();
      expect(await pool.acquire(5_000)).toBe("GONLY");
      expect(Date.now() - started).toBeGreaterThanOrEqual(190);
      // Quarantining a channel that is not leased changes nothing.
      await pool.release("GONLY");
      await pool.quarantine("GONLY", 60_000);
      expect(await pool.acquire(0)).toBe("GONLY");
    });

    it("hands a quarantined channel's sequence number to its next lease, once", async () => {
      const pool = await create(["GONLY"]);
      expect(await pool.acquire(0)).toBe("GONLY");
      expect(await pool.takeQuarantineSequence("GONLY")).toBeUndefined();
      await pool.quarantine("GONLY", 50, "42");
      expect(await pool.acquire(5_000)).toBe("GONLY");
      expect(await pool.takeQuarantineSequence("GONLY")).toBe("42");
      expect(await pool.takeQuarantineSequence("GONLY")).toBeUndefined();
      // A plain release drops a sequence number nobody took.
      await pool.quarantine("GONLY", 50, "43");
      expect(await pool.acquire(5_000)).toBe("GONLY");
      await pool.release("GONLY");
      expect(await pool.acquire(0)).toBe("GONLY");
      expect(await pool.takeQuarantineSequence("GONLY")).toBeUndefined();
      await pool.release("GONLY");
    });

    it("doubles the cooldown of a channel quarantined again, until a plain release", async () => {
      const pool = await create(["GONLY"]);
      const cooldownAfterQuarantine = async () => {
        const started = Date.now();
        await pool.quarantine("GONLY", 200);
        expect(await pool.acquire(5_000)).toBe("GONLY");
        return Date.now() - started;
      };
      await pool.acquire(0);
      expect(await cooldownAfterQuarantine()).toBeLessThan(380);
      expect(await cooldownAfterQuarantine()).toBeGreaterThanOrEqual(390);
      await pool.release("GONLY");
      await pool.acquire(0);
      expect(await cooldownAfterQuarantine()).toBeLessThan(380);
    });
  });
}
