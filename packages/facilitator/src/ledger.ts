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

export interface SettlementRecord extends Partial<SettlementEnvelope> {
  readonly id: string;
  readonly key: SettlementKey;
  /** SHA-256 of the payment transaction XDR the client signed. */
  readonly payloadHash: string;
  readonly state: SettlementState;
  readonly owner: string;
  /** A `claimed` record whose owner stops renewing it may be taken over after this time (ms epoch). */
  readonly claimExpiresAt: number;
  /** Final wire response, present once the state is terminal. */
  readonly response?: SettleResponse;
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

export interface SettlementLedger {
  /** Claims the settlement for `key`, or returns the record that already holds it. */
  claim(key: SettlementKey, payloadHash: string, owner: string, ttlMs: number): Promise<Claim>;
  /** Records the signed envelope before broadcast. Fails unless `owner` still holds the claim. */
  recordEnvelope(id: string, owner: string, envelope: SettlementEnvelope): Promise<void>;
  /**
   * Moves a record to a terminal state. Finishing an already-terminal record changes nothing and
   * reports `transitioned: false`: only the caller that made the transition may release the channel.
   */
  finish(id: string, state: FinalState, response: SettleResponse): Promise<Finished>;
  /** Drops a claim that never produced an envelope, so the same payment can be retried. */
  abandon(id: string, owner: string): Promise<void>;
  get(id: string): Promise<SettlementRecord | undefined>;
  /** Records with a recorded envelope that are not yet terminal. */
  unfinished(network: string): Promise<SettlementRecord[]>;
  /** Upper bound of the sponsor fees committed since `since`: the sum of recorded envelopes' max fees. */
  committedFeesSince(network: string, since: Date): Promise<bigint>;
}

export class ClaimLostError extends Error {
  override readonly name = "ClaimLostError";
  constructor(id: string) {
    super(`settlement ${id} is no longer owned by this worker`);
  }
}
