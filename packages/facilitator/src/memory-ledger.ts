import { randomUUID } from "node:crypto";
import type { SettleResponse } from "@x402/core/types";
import {
  ClaimLostError,
  ClaimRefusedError,
  DEFAULT_SCHEME,
  FIRST_SEND,
  SpendRefusedError,
  TERMINAL_STATES,
  emptyStateCounts,
  sameRequest,
  addUsd,
  type CallerUsage,
  type Claim,
  type ClaimDetails,
  type FinalState,
  type Finished,
  type FinishDetails,
  type RequestFingerprint,
  type SettlementEnvelope,
  type SettlementKey,
  type SettlementLedger,
  type SettlementRecord,
  type SettlementState,
  type SpendLimit,
  type UnfinishedOptions,
} from "./ledger.ts";
import { PUBLIC_CALLER } from "./caller.ts";

/**
 * Process-local settlement ledger for the in-process facilitator and tests. It gives the same
 * guarantees as the Postgres ledger within one process, and none across restarts.
 */
export class MemorySettlementLedger implements SettlementLedger {
  private readonly records = new Map<string, SettlementRecord>();
  private readonly byKey = new Map<string, string>();
  /** Fees reserved by claims that have not recorded an envelope yet, by record id. */
  private readonly reserved = new Map<string, bigint>();
  private readonly spend: { network: string; kind: string; fee: bigint; at: number }[] = [];
  private readonly spendById = new Map<string, { fee: bigint }>();

  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  claim(
    key: SettlementKey,
    fingerprint: RequestFingerprint,
    owner: string,
    ttlMs: number,
    details: ClaimDetails = {},
  ): Promise<Claim> {
    const keyString = keyOf(key);
    const existingId = this.byKey.get(keyString);
    const existing = existingId === undefined ? undefined : this.records.get(existingId);
    const now = this.now();

    if (existing !== undefined) {
      if (!sameRequest(existing, fingerprint)) return Promise.resolve({ kind: "conflict", record: existing });
      const stale = existing.state === "claimed" && existing.claimExpiresAt <= now;
      if (!stale) return Promise.resolve({ kind: "existing", record: existing });
      // The request that takes a stale claim over is the one that settles it: its attempt id, or none,
      // is what repeats echo, never that of the request that gave up.
      const { attempt: _abandoned, ...held } = existing;
      const taken: SettlementRecord = {
        ...held,
        ...(details.attempt === undefined ? {} : { attempt: details.attempt }),
        owner,
        claimExpiresAt: now + ttlMs,
        updatedAt: now,
      };
      this.records.set(taken.id, taken);
      return Promise.resolve({ kind: "claimed", record: taken });
    }

    // Checked and recorded in one synchronous step: no other claim can interleave.
    const caller = details.caller ?? PUBLIC_CALLER;
    const reserve = details.reserveFeeStroops ?? 0n;
    for (const limit of details.limits ?? []) {
      const committed = this.committed(
        key.network,
        limit.since,
        limit.scope === "caller" ? caller : undefined,
      );
      if (committed + reserve > limit.capStroops) return Promise.reject(new ClaimRefusedError(limit));
    }

    const record: SettlementRecord = {
      id: randomUUID(),
      key,
      caller,
      ...(details.serviceFeeUsd === undefined ? {} : { serviceFeeUsd: details.serviceFeeUsd }),
      scheme: details.scheme ?? DEFAULT_SCHEME,
      ...(details.amount === undefined ? {} : { amount: details.amount }),
      ...(details.attempt === undefined ? {} : { attempt: details.attempt }),
      payloadHash: fingerprint.payloadHash,
      requestHash: fingerprint.requestHash,
      state: "claimed",
      owner,
      claimExpiresAt: now + ttlMs,
      createdAt: now,
      updatedAt: now,
    };
    this.records.set(record.id, record);
    this.byKey.set(keyString, record.id);
    if (reserve > 0n) this.reserved.set(record.id, reserve);
    return Promise.resolve({ kind: "claimed", record });
  }

  recordEnvelope(id: string, owner: string, envelope: SettlementEnvelope): Promise<void> {
    const record = this.records.get(id);
    if (record?.state !== "claimed" || record.owner !== owner) return Promise.reject(new ClaimLostError(id));
    this.records.set(id, {
      ...record,
      ...envelope,
      state: "submitted",
      broadcastAccepted: false,
      sendsInFlight: [FIRST_SEND],
      updatedAt: this.now(),
    });
    this.reserved.delete(id);
    return Promise.resolve();
  }

  beginSend(id: string, send: string): Promise<void> {
    const record = this.records.get(id);
    if (record === undefined) return Promise.reject(new Error(`unknown settlement ${id}`));
    // Like the Postgres ledger, sends leave `updatedAt` alone: it times the reconciler's idle window.
    this.records.set(id, { ...record, sendsInFlight: [...(record.sendsInFlight ?? []), send] });
    return Promise.resolve();
  }

  releaseChannel(id: string): Promise<boolean> {
    const record = this.records.get(id);
    if (record?.state !== "submitted" || record.channelReleased === true) return Promise.resolve(false);
    this.records.set(id, { ...record, channelReleased: true });
    return Promise.resolve(true);
  }

  endSend(id: string, send: string, accepted: boolean): Promise<void> {
    const record = this.records.get(id);
    if (record === undefined) return Promise.reject(new Error(`unknown settlement ${id}`));
    this.records.set(id, {
      ...record,
      sendsInFlight: (record.sendsInFlight ?? []).filter((entry) => entry !== send),
      ...(accepted ? { broadcastAccepted: true } : {}),
    });
    return Promise.resolve();
  }

  finish(
    id: string,
    state: FinalState,
    response: SettleResponse,
    details: FinishDetails = {},
  ): Promise<Finished> {
    const record = this.records.get(id);
    if (record === undefined) return Promise.reject(new Error(`unknown settlement ${id}`));
    if (TERMINAL_STATES.has(record.state)) return Promise.resolve({ record, transitioned: false });
    if (
      details.claimedBy !== undefined &&
      (record.state !== "claimed" || record.owner !== details.claimedBy)
    ) {
      return Promise.resolve({ record, transitioned: false });
    }
    if (record.envelopeXdr === undefined && !completesWithoutEnvelope(record, state)) {
      return Promise.reject(
        new Error(`settlement ${id} has no envelope; only an upto zero-amount success finishes without one`),
      );
    }
    const finished: SettlementRecord = {
      ...record,
      state,
      response,
      settledBy: details.settledBy ?? "rail402",
      ...(details.feeChargedStroops === undefined
        ? {}
        : { feeChargedStroops: details.feeChargedStroops.toString() }),
      updatedAt: this.now(),
    };
    this.records.set(id, finished);
    return Promise.resolve({ record: finished, transitioned: true });
  }

  abandon(id: string, owner: string): Promise<void> {
    const record = this.records.get(id);
    if (record?.state === "claimed" && record.owner === owner) {
      this.records.delete(id);
      this.byKey.delete(keyOf(record.key));
      this.reserved.delete(id);
    }
    return Promise.resolve();
  }

  get(id: string): Promise<SettlementRecord | undefined> {
    return Promise.resolve(this.records.get(id));
  }

  find(key: SettlementKey): Promise<SettlementRecord | undefined> {
    const id = this.byKey.get(keyOf(key));
    return Promise.resolve(id === undefined ? undefined : this.records.get(id));
  }

  countByState(network: string, since: Date): Promise<Record<SettlementState, number>> {
    const counts = emptyStateCounts();
    for (const record of this.records.values()) {
      if (record.key.network === network && record.createdAt >= since.getTime()) counts[record.state]++;
    }
    return Promise.resolve(counts);
  }

  committedFeesSince(network: string, since: Date, caller?: string): Promise<bigint> {
    return Promise.resolve(this.committed(network, since, caller));
  }

  usageSince(caller: string | undefined, since: Date, until = new Date(8.64e15)): Promise<CallerUsage[]> {
    const rows = new Map<
      string,
      { caller: string; network: string; day: string; succeeded: number; fees: bigint; usd: string[] }
    >();
    for (const record of this.records.values()) {
      const who = record.caller ?? PUBLIC_CALLER;
      if (caller !== undefined && who !== caller) continue;
      if (record.createdAt < since.getTime() || record.createdAt >= until.getTime()) continue;
      const day = new Date(record.createdAt).toISOString().slice(0, 10);
      const id = `${who}\u0000${record.key.network}\u0000${day}`;
      const row = rows.get(id) ?? {
        caller: who,
        network: record.key.network,
        day,
        succeeded: 0,
        fees: 0n,
        usd: [],
      };
      if (record.feeChargedStroops !== undefined) row.fees += BigInt(record.feeChargedStroops);
      if (record.state === "succeeded" && (record.settledBy ?? "rail402") === "rail402") {
        row.succeeded++;
        row.usd.push(record.serviceFeeUsd ?? "0");
      }
      rows.set(id, row);
    }
    return Promise.resolve(
      [...rows.values()].map((row) => ({
        caller: row.caller,
        network: row.network,
        day: row.day,
        succeeded: row.succeeded,
        sponsoredFeeStroops: row.fees,
        serviceFeeUsd: addUsd(row.usd),
      })),
    );
  }

  failuresSince(network: string, payer: string, since: Date): Promise<number> {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.key.network !== network || record.key.payer !== payer) continue;
      if (
        record.state === "failed" &&
        record.feeChargedStroops !== undefined &&
        BigInt(record.feeChargedStroops) > 0n &&
        record.updatedAt >= since.getTime()
      )
        count++;
    }
    return Promise.resolve(count);
  }

  recordSponsorSpend(network: string, kind: string, feeStroops: bigint): Promise<void> {
    this.spend.push({ network, kind, fee: feeStroops, at: this.now() });
    return Promise.resolve();
  }

  sponsorSpendSince(network: string, since: Date, kind?: string): Promise<bigint> {
    return Promise.resolve(this.spent(network, since, kind));
  }

  reserveSponsorSpend(
    network: string,
    kind: string,
    maxFeeStroops: bigint,
    limits: readonly SpendLimit[],
  ): Promise<string> {
    for (const limit of limits) {
      const committed =
        limit.scope === "network"
          ? this.committed(network, limit.since, undefined)
          : this.spent(network, limit.since, kind);
      if (committed + maxFeeStroops > limit.capStroops) {
        return Promise.reject(new SpendRefusedError(limit, committed));
      }
    }
    const entry = { network, kind, fee: maxFeeStroops, at: this.now() };
    this.spend.push(entry);
    const id = randomUUID();
    this.spendById.set(id, entry);
    return Promise.resolve(id);
  }

  settleSponsorSpend(id: string, feeStroops: bigint): Promise<void> {
    const entry = this.spendById.get(id);
    if (entry !== undefined) entry.fee = feeStroops;
    return Promise.resolve();
  }

  private spent(network: string, since: Date, kind?: string): bigint {
    let total = 0n;
    for (const entry of this.spend) {
      if (
        entry.network === network &&
        entry.at >= since.getTime() &&
        (kind === undefined || entry.kind === kind)
      )
        total += entry.fee;
    }
    return total;
  }

  private committed(network: string, since: Date, caller?: string): bigint {
    let total = caller === undefined ? this.spent(network, since) : 0n;
    for (const record of this.records.values()) {
      if (record.key.network !== network || record.createdAt < since.getTime()) continue;
      if (caller !== undefined && (record.caller ?? PUBLIC_CALLER) !== caller) continue;
      const fee = committedFeeOf(record, this.reserved.get(record.id));
      if (fee !== undefined) total += fee;
    }
    return total;
  }

  unfinished(network: string, options: UnfinishedOptions = {}): Promise<SettlementRecord[]> {
    const before = this.now() - (options.idleForMs ?? 0);
    return Promise.resolve(
      [...this.records.values()].filter(
        (r) => r.state === "submitted" && r.key.network === network && r.updatedAt <= before,
      ),
    );
  }
}

/** The only final state a record may reach without an envelope, as the Postgres schema enforces. */
function completesWithoutEnvelope(record: SettlementRecord, state: FinalState): boolean {
  return record.scheme === "upto" && record.amount === "0" && state === "succeeded";
}

function keyOf(key: SettlementKey): string {
  return `${key.network}\u0000${key.payer}\u0000${key.nonce}`;
}

/**
 * What one settlement commits against the hourly budgets (as `PostgresSettlementLedger` counts it):
 * an unfinished one its maximum fee or reservation; a finished one what was charged when known,
 * nothing when it expired, and its maximum fee otherwise.
 */
function committedFeeOf(record: SettlementRecord, reserved: bigint | undefined): bigint | undefined {
  const ceiling = record.maxFeeStroops === undefined ? reserved : BigInt(record.maxFeeStroops);
  if (record.state === "claimed" || record.state === "submitted") return ceiling;
  if (record.feeChargedStroops !== undefined) return BigInt(record.feeChargedStroops);
  if (record.state === "expired") return 0n;
  return ceiling;
}
