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
  /** Who asked for the settlement: `key:<id>` or `public`. */
  readonly caller?: string;
  /** The service fee recorded at the claim, in US dollars. */
  readonly serviceFeeUsd?: string;
  readonly settledBy?: SettledBy;
  /**
   * Whether the network accepted a send of the recorded bytes (PENDING or DUPLICATE): `false` while
   * every send answered so far was refused (ERROR, TRY_AGAIN_LATER). Absent on records written before
   * sends were tracked, which count as accepted (see `broadcastMayBePublic`).
   */
  readonly broadcastAccepted?: boolean;
  /**
   * Sends of the recorded bytes whose answer is not known: under way, or lost to a timeout, a
   * transport error or a crash. Each may have been accepted. `FIRST_SEND` is the scheme's own.
   */
  readonly sendsInFlight?: readonly string[];
  /**
   * Whether the settlement gave its channel back before finishing (`SettlementLedger.releaseChannel`):
   * its recorded bytes can never apply, because another transaction took the channel's sequence number
   * or they were included and failed (which used it), while the payment's outcome still waits.
   * Finishing it releases no channel.
   */
  readonly channelReleased?: boolean;
  /**
   * The settle attempt id of the request that holds the claim (the one that started the settlement,
   * or the one that took its stale claim over), when it carried one.
   */
  readonly attempt?: string;
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
  /** Who asked for the settlement (`key:<id>` or `public`); `public` when omitted. */
  readonly caller?: string;
  /** The service fee in US dollars (decimal string, up to 7 decimals) the settlement accrues if it succeeds. */
  readonly serviceFeeUsd?: string;
  /** The resource server's settle attempt id the request carried; echoed in every repeat's marker. */
  readonly attempt?: string;
  /**
   * Fees the claim reserves until its envelope is recorded (then the envelope's maximum fee counts
   * instead), so concurrent claims see each other's cost before any of them has signed.
   */
  readonly reserveFeeStroops?: bigint;
  /**
   * Hourly fee limits the claim must stay within. A new claim is refused when the fees committed in
   * a limit's scope (recorded maximum fees and open reservations) plus its own reservation would
   * exceed the cap, with `ClaimRefusedError` and nothing recorded. The check and the insert are one
   * atomic step, across replicas. A key that is already held is answered as usual, whatever the limits.
   */
  readonly limits?: readonly ClaimLimit[];
}

/** One hourly fee limit of a claim. */
export interface ClaimLimit {
  /** `network`: every settlement of the network; `caller`: those of the claim's caller. */
  readonly scope: "network" | "caller";
  readonly capStroops: bigint;
  /** The start of the window, usually an hour ago. */
  readonly since: Date;
}

/** One limit a sponsor spend reservation must stay within (`SettlementLedger.reserveSponsorSpend`). */
export interface SpendLimit {
  /** `network`: every fee committed on the network; `kind`: the spend of the reservation's kind. */
  readonly scope: "network" | "kind";
  readonly capStroops: bigint;
  /** The start of the window, e.g. an hour or a day ago. */
  readonly since: Date;
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
  /**
   * Records the signed envelope before broadcast. Fails unless `owner` still holds the claim. The
   * scheme's own send (`FIRST_SEND`) starts in flight and nothing is accepted yet.
   */
  recordEnvelope(id: string, owner: string, envelope: SettlementEnvelope): Promise<void>;
  /**
   * Marks a send of the recorded bytes as under way, before it is made: until `endSend`, it may have
   * been accepted. A send whose answer is lost is never ended, so it keeps counting as accepted.
   */
  beginSend(id: string, send: string): Promise<void>;
  /** Records the answer to a send: `accepted` for PENDING or DUPLICATE, otherwise refused. */
  endSend(id: string, send: string, accepted: boolean): Promise<void>;
  /**
   * Moves a record to a terminal state. Finishing an already-terminal record changes nothing and
   * reports `transitioned: false`: only the caller that made the transition may release the channel.
   * Only an `upto` zero-amount success finishes without a recorded envelope (see `claimedBy`).
   */
  finish(id: string, state: FinalState, response: SettleResponse, details?: FinishDetails): Promise<Finished>;
  /**
   * Marks a `submitted` settlement's channel as given back, once its recorded bytes can never apply
   * (another transaction took the channel's sequence number, or the bytes were included and failed,
   * which used it) while its outcome still waits: the
   * channel pool may lease that channel again, and finishing the settlement releases nothing. Answers
   * whether this call marked it, so only one caller hands the channel back. Optional: without it a
   * settlement keeps its channel until it finishes.
   */
  releaseChannel?(id: string): Promise<boolean>;
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
  /**
   * Upper bound of the sponsor fees committed since `since`: for unfinished settlements their recorded
   * envelopes' maximum fees or their claims' reservations; for finished ones the fee charged when
   * known (0 for a submission the network refused), nothing for an expired one and the maximum fee
   * otherwise; with `caller`, only that caller's.
   */
  committedFeesSince(network: string, since: Date, caller?: string): Promise<bigint>;
  /**
   * Settlements of `payer` on `network` that were included and failed (the sponsor paid their fee)
   * and finished at or after `since`. Optional: without it the failed-settlement cooldown is off.
   */
  failuresSince?(network: string, payer: string, since: Date): Promise<number>;
  /**
   * Records a fee the sponsor paid outside a settlement (`kind`, e.g. `upto_ttl`). It counts toward
   * the network's `committedFeesSince` (not any caller's). Optional, like `sponsorSpendSince`.
   */
  recordSponsorSpend?(network: string, kind: string, feeStroops: bigint): Promise<void>;
  /** Fees recorded with `recordSponsorSpend` since `since`, of `kind` when given. */
  sponsorSpendSince?(network: string, since: Date, kind?: string): Promise<bigint>;
  /**
   * Records `maxFeeStroops` as sponsor spend of `kind` before the transaction is submitted, refusing
   * with `SpendRefusedError` (nothing recorded) when it would pass one of `limits`. The check and the
   * insert are one step under the network's fee-admission lock, shared with settlement claims, so
   * spend outside settlements and settlements together never pass the network budget. Returns the
   * reservation's id for `settleSponsorSpend`. Optional, like `recordSponsorSpend`.
   */
  reserveSponsorSpend?(
    network: string,
    kind: string,
    maxFeeStroops: bigint,
    limits: readonly SpendLimit[],
  ): Promise<string>;
  /** Replaces a reservation's amount with what the sponsor was actually charged (0 when nothing landed). */
  settleSponsorSpend?(id: string, feeStroops: bigint): Promise<void>;
  /**
   * The ledger of `network` counted from since this settlement ledger was last returned to an earlier
   * state (restored from a backup or recovered to a point in time, so records written between that state
   * and the restore are gone), or `undefined` when it never was. The first caller after such a restore
   * records `ledger`, the network's current ledger as it read it; every caller then gets that recorded
   * ledger. With `restartedBelow`, a recorded ledger more than that above `ledger` is replaced by `ledger`:
   * only for a network reset the caller has corroborated, since one wrong reading would otherwise end the
   * hold. Optional: a ledger that is never restored leaves it out.
   */
  rewindLedger?(network: string, ledger: number, restartedBelow?: number): Promise<number | undefined>;
  /**
   * Read-only: the ledger of `network` recorded since this settlement ledger was last restored to an
   * earlier state, `null` when it was restored and nothing is recorded yet, or `undefined` when it never
   * was. Optional, like `rewindLedger`.
   */
  rewindAnchor?(network: string): Promise<number | null | undefined>;
  /**
   * What `caller`'s settlements created at or after `since` amount to, per network and UTC day:
   * successes Rail402 landed, the fees the sponsor was charged for them (whatever their outcome) and
   * the service fees they accrued at their recorded price. Optional, like the other usage methods.
   */
  usageSince?(caller: string | undefined, since: Date, until?: Date): Promise<CallerUsage[]>;
}

/** One caller's settlements on one network and day (see `SettlementLedger.usageSince`). */
export interface CallerUsage {
  readonly caller: string;
  readonly network: string;
  /** UTC calendar day, `YYYY-MM-DD`. */
  readonly day: string;
  /** Succeeded settlements that Rail402's own transaction (or an off-chain zero) landed. */
  readonly succeeded: number;
  /** Fees the sponsor was charged for this caller's included transactions, in stroops. */
  readonly sponsoredFeeStroops: bigint;
  /** The service fees the successes accrued, at the price recorded with each, as a decimal string. */
  readonly serviceFeeUsd: string;
}

/** Adds decimal US-dollar amounts of up to 7 fraction digits exactly; the sum has 7 fraction digits. */
export function addUsd(amounts: readonly string[]): string {
  let units = 0n;
  for (const amount of amounts) {
    const [whole = "0", fraction = ""] = amount.split(".");
    units += BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, "0").slice(0, 7));
  }
  const text = units.toString().padStart(8, "0");
  return `${text.slice(0, -7)}.${text.slice(-7)}`;
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

/** The id of the scheme's own first send of a recorded envelope (see `SettlementLedger.recordEnvelope`). */
export const FIRST_SEND = "first";

/**
 * Whether the network may have accepted the recorded bytes, and so anyone may have read the payer's
 * authorization from them: unless every send was answered with a refusal, and a record written before
 * sends were tracked always may.
 */
export function broadcastMayBePublic(record: SettlementRecord): boolean {
  return record.broadcastAccepted !== false || (record.sendsInFlight?.length ?? 1) > 0;
}

/** The scheme of records written before schemes were recorded. */
export const DEFAULT_SCHEME = "exact";

/** A count for every settlement state, all zero. */
export function emptyStateCounts(): Record<SettlementState, number> {
  return { claimed: 0, submitted: 0, succeeded: 0, failed: 0, expired: 0 };
}

/** A new claim would commit fees beyond one of its limits; nothing was recorded. */
export class ClaimRefusedError extends Error {
  override readonly name = "ClaimRefusedError";
  readonly limit: ClaimLimit;
  constructor(limit: ClaimLimit) {
    super(`the ${limit.scope} hourly fee budget is committed`);
    this.limit = limit;
  }
}

/** A sponsor spend reservation would pass one of its limits; nothing was recorded. */
export class SpendRefusedError extends Error {
  override readonly name = "SpendRefusedError";
  readonly limit: SpendLimit;
  /** What was already committed in the limit's window. */
  readonly committedStroops: bigint;
  constructor(limit: SpendLimit, committedStroops: bigint) {
    super(
      `${String(committedStroops)} stroops are committed against the ${limit.scope} cap of ${String(limit.capStroops)}`,
    );
    this.limit = limit;
    this.committedStroops = committedStroops;
  }
}

export class ClaimLostError extends Error {
  override readonly name = "ClaimLostError";
  constructor(id: string) {
    super(`settlement ${id} is no longer owned by this worker`);
  }
}
