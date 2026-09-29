import { randomUUID } from "node:crypto";
import type { SettleResponse } from "@x402/core/types";
import {
  ClaimLostError,
  TERMINAL_STATES,
  type Claim,
  type FinalState,
  type Finished,
  type SettlementEnvelope,
  type SettlementKey,
  type SettlementLedger,
  type SettlementRecord,
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

  claim(key: SettlementKey, payloadHash: string, owner: string, ttlMs: number): Promise<Claim> {
    const keyString = keyOf(key);
    const existingId = this.byKey.get(keyString);
    const existing = existingId === undefined ? undefined : this.records.get(existingId);
    const now = this.now();

    if (existing !== undefined) {
      if (existing.payloadHash !== payloadHash)
        return Promise.resolve({ kind: "conflict", record: existing });
      const stale = existing.state === "claimed" && existing.claimExpiresAt <= now;
      if (!stale) return Promise.resolve({ kind: "existing", record: existing });
      const taken = { ...existing, owner, claimExpiresAt: now + ttlMs, updatedAt: now };
      this.records.set(taken.id, taken);
      return Promise.resolve({ kind: "claimed", record: taken });
    }

    const record: SettlementRecord = {
      id: randomUUID(),
      key,
      payloadHash,
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

  finish(id: string, state: FinalState, response: SettleResponse): Promise<Finished> {
    const record = this.records.get(id);
    if (record === undefined) return Promise.reject(new Error(`unknown settlement ${id}`));
    if (TERMINAL_STATES.has(record.state)) return Promise.resolve({ record, transitioned: false });
    const finished = { ...record, state, response, updatedAt: this.now() };
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

  committedFeesSince(network: string, since: Date): Promise<bigint> {
    let total = 0n;
    for (const record of this.records.values()) {
      if (record.key.network !== network || record.maxFeeStroops === undefined) continue;
      if (record.createdAt >= since.getTime()) total += BigInt(record.maxFeeStroops);
    }
    return Promise.resolve(total);
  }

  unfinished(network: string): Promise<SettlementRecord[]> {
    return Promise.resolve(
      [...this.records.values()].filter((r) => r.state === "submitted" && r.key.network === network),
    );
  }
}

function keyOf(key: SettlementKey): string {
  return `${key.network}\u0000${key.payer}\u0000${key.nonce}`;
}
