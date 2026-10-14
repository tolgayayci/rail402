import { randomUUID } from "node:crypto";
import type { SettleResponse } from "@x402/core/types";
import {
  ClaimLostError,
  DEFAULT_SCHEME,
  TERMINAL_STATES,
  emptyStateCounts,
  sameRequest,
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
  type UnfinishedOptions,
} from "./ledger.ts";

/**
 * Process-local settlement ledger for the in-process facilitator and tests. It gives the same
 * guarantees as the Postgres ledger within one process, and none across restarts.
 */
export class MemorySettlementLedger implements SettlementLedger {
  private readonly records = new Map<string, SettlementRecord>();
  private readonly byKey = new Map<string, string>();

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
      const taken = { ...existing, owner, claimExpiresAt: now + ttlMs, updatedAt: now };
      this.records.set(taken.id, taken);
      return Promise.resolve({ kind: "claimed", record: taken });
    }

    const record: SettlementRecord = {
      id: randomUUID(),
      key,
      scheme: details.scheme ?? DEFAULT_SCHEME,
      ...(details.amount === undefined ? {} : { amount: details.amount }),
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
    return Promise.resolve({ kind: "claimed", record });
  }

  recordEnvelope(id: string, owner: string, envelope: SettlementEnvelope): Promise<void> {
    const record = this.records.get(id);
    if (record?.state !== "claimed" || record.owner !== owner) return Promise.reject(new ClaimLostError(id));
    this.records.set(id, { ...record, ...envelope, state: "submitted", updatedAt: this.now() });
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

  committedFeesSince(network: string, since: Date): Promise<bigint> {
    let total = 0n;
    for (const record of this.records.values()) {
      if (record.key.network !== network || record.maxFeeStroops === undefined) continue;
      if (record.createdAt >= since.getTime()) total += BigInt(record.maxFeeStroops);
    }
    return Promise.resolve(total);
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
