import type { SettleResponse } from "@x402/core/types";

/**
 * The settlement ledger makes settlement idempotent and crash-safe.
 *
 * A signed Soroban authorization can move funds at most once, because its nonce is consumed on-chain.
 * The ledger mirrors that: one record per (network, payer, nonce). The signed envelope and its hash are
 * written *before* the transaction is broadcast, so after a crash or timeout the facilitator can always
 * find the original transaction and never needs to submit a different one.
 */

export interface SettlementKey {
  readonly network: string;
  readonly payer: string;
  /** The payer authorization's nonce, as a decimal string. */
  readonly nonce: string;
}

/**
 * - `claimed`: a worker owns the record; nothing has been signed yet.
 * - `submitted`: the fee-bumped envelope is recorded and may be on the network.
 * - `succeeded` / `failed` / `expired`: terminal. `expired` means the transaction's time bounds passed
 *   without it being included, so no funds moved.
 */
export type SettlementState = "claimed" | "submitted" | "succeeded" | "failed" | "expired";

export const TERMINAL_STATES: ReadonlySet<SettlementState> = new Set(["succeeded", "failed", "expired"]);

export type FinalState = "succeeded" | "failed" | "expired";

export interface Finished {
  readonly record: SettlementRecord;
  readonly transitioned: boolean;
}

export interface SettlementEnvelope {
  readonly channel: string;
  /** Hash of the fee-bump envelope: the hash reported to clients and polled on the network. */
  readonly transactionHash: string;
  readonly innerTransactionHash: string;
  /** The exact bytes to (re)submit. */
  readonly envelopeXdr: string;
  /** Upper time bound of the inner transaction, in unix seconds. */
  readonly validUntil: number;
  /** Most the sponsor can be charged for this transaction, in stroops (the fee-bump fee). */
  readonly maxFeeStroops: string;
}

/** Who landed the payment on-chain: Rail402's own transaction, or someone else's carrying the same authorization. */
export type SettledBy = "rail402" | "third_party";

/**
 * Identifies one settle request. The ledger answers a repeat of a settlement key from its record
 * only when the fingerprint matches; otherwise the repeat is an idempotency conflict.
 */
export interface RequestFingerprint {
  /** SHA-256 of the payment transaction XDR the client signed. */
  readonly payloadHash: string;
  /** SHA-256 of the canonical request terms, including the settle-time amount (see fingerprint.ts). */
  readonly requestHash: string;
}

export interface SettlementRecord extends Partial<SettlementEnvelope> {
  readonly id: string;
  readonly key: SettlementKey;
  /** The x402 scheme settled (`exact` for records written before schemes were recorded). */
  readonly scheme: string;
  /** The settle-time amount in base units, when the request recorded one. */
  readonly amount?: string;
  /** SHA-256 of the payment transaction XDR the client signed. */
  readonly payloadHash: string;
  /** Absent on records written before request fingerprints existed; those compare `payloadHash`. */
  readonly requestHash?: string;
  readonly state: SettlementState;
  readonly owner: string;
  /** A `claimed` record whose owner stops renewing it may be taken over after this time (ms epoch). */
  readonly claimExpiresAt: number;
  /** Final wire response, present once the state is terminal. */
  readonly response?: SettleResponse;
  /** What the fee sponsor was charged, once the transaction was found in a ledger. */
  readonly feeChargedStroops?: string;
  readonly settledBy?: SettledBy;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type Claim =
  /** The caller now owns a fresh `claimed` record. */
  | { readonly kind: "claimed"; readonly record: SettlementRecord }
  /** Another request already owns this settlement, or it has finished. */
  | { readonly kind: "existing"; readonly record: SettlementRecord }
  /** The same authorization was submitted inside a different transaction envelope. */
  | { readonly kind: "conflict"; readonly record: SettlementRecord };

/** What a claim records about the request besides its key and fingerprint. */
export interface ClaimDetails {
  /** The x402 scheme; `exact` when omitted. */
  readonly scheme?: string;
  /** The settle-time amount in base units. */
  readonly amount?: string;
}

/** Details stored with a final state. */
export interface FinishDetails {
  readonly feeChargedStroops?: bigint;
  readonly settledBy?: SettledBy;
  /**
   * Finishes a settlement that completes without a transaction (an `upto` zero settled off-chain):
   * the record must still be an unsigned claim held by this owner, otherwise nothing changes and
   * `transitioned` is false.
   */
  readonly claimedBy?: string;
}

export interface UnfinishedOptions {
  readonly idleForMs?: number;
}

export interface SettlementLedger {
  /**
   * Claims the settlement for `key`, or returns the record that already holds it. A record whose
   * fingerprint differs (see `sameRequest`) is returned as a conflict.
   */
  claim(
    key: SettlementKey,
    fingerprint: RequestFingerprint,
    owner: string,
    ttlMs: number,
    details?: ClaimDetails,
  ): Promise<Claim>;
  /** Records the signed envelope before broadcast. Fails unless `owner` still holds the claim. */
  recordEnvelope(id: string, owner: string, envelope: SettlementEnvelope): Promise<void>;
  /**
   * Moves a record to a terminal state. Finishing an already-terminal record changes nothing and
   * reports `transitioned: false`: only the caller that made the transition may release the channel.
   * Only an `upto` zero-amount success finishes without a recorded envelope (see `claimedBy`).
   */
  finish(id: string, state: FinalState, response: SettleResponse, details?: FinishDetails): Promise<Finished>;
  /** Drops a claim that never produced an envelope, so the same payment can be retried. */
  abandon(id: string, owner: string): Promise<void>;
  get(id: string): Promise<SettlementRecord | undefined>;
  /** The record for a settlement key, whatever its state. Read-only. */
  find(key: SettlementKey): Promise<SettlementRecord | undefined>;
  /** Records per state for one network, created at or after `since`. Every state is present. */
  countByState(network: string, since: Date): Promise<Record<SettlementState, number>>;
  /**
   * Records with a recorded envelope that are not yet terminal. With `idleForMs`, only those last
   * updated (for a submitted record: whose envelope was recorded) at least that long ago, by the
   * ledger's own clock, so replicas with skewed clocks agree.
   */
  unfinished(network: string, options?: UnfinishedOptions): Promise<SettlementRecord[]>;
  /** Upper bound of the sponsor fees committed since `since`: the sum of recorded envelopes' max fees. */
  committedFeesSince(network: string, since: Date): Promise<bigint>;
}

/**
 * Whether a request with `fingerprint` is the request `record` holds. Records written before request
 * fingerprints existed carry no `requestHash` and compare the signed transaction alone.
 */
export function sameRequest(record: SettlementRecord, fingerprint: RequestFingerprint): boolean {
  return record.requestHash === undefined
    ? record.payloadHash === fingerprint.payloadHash
    : record.requestHash === fingerprint.requestHash;
}

/** The scheme of records written before schemes were recorded. */
export const DEFAULT_SCHEME = "exact";

/** A count for every settlement state, all zero. */
export function emptyStateCounts(): Record<SettlementState, number> {
  return { claimed: 0, submitted: 0, succeeded: 0, failed: 0, expired: 0 };
}

export class ClaimLostError extends Error {
  override readonly name = "ClaimLostError";
  constructor(id: string) {
    super(`settlement ${id} is no longer owned by this worker`);
  }
}
