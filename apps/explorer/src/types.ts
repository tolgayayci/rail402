/** Shared domain types for the explorer. Amounts are ALWAYS decimal strings of stroop-scale
 * integers (i128-safe); nothing in this service ever holds an amount as a float. */

export type Scheme = "exact" | "upto";

/**
 * How sure we are about what a row is. Shown honestly on every surface — inference is never
 * presented as fact.
 *
 * - `rail402`              — transaction source is one of OUR deployment's published signers.
 * - `verified-facilitator` — source matches a registered facilitator's published /supported signers.
 * - `x402-shaped`          — matches the structural classifier; submitter unknown.
 */
export type Confidence = "rail402" | "verified-facilitator" | "x402-shaped";

export interface PaymentRow {
  /** CAIP-2 network id. */
  readonly network: string;
  /** Chain-epoch discriminator: testnet resets restart ledger numbering, so every row carries the
   * epoch it was observed in and nothing joins across epochs (README decision 3). */
  readonly epoch: string;
  readonly ledger: number;
  readonly txHash: string;
  readonly opIndex: number;
  readonly scheme: Scheme;
  readonly buyer: string;
  readonly seller: string;
  /** Amount actually moved, stroop-scale decimal string. Zero is legal (upto nonce burn). */
  readonly amount: string;
  /** upto only: the client-authorized ceiling (invocation arg 3). */
  readonly ceiling?: string;
  /** The SAC contract the transfer happened on. */
  readonly assetContract: string;
  /** SEP-11 asset string from the event's 4th topic ("native" | "CODE:ISSUER"), when present. */
  readonly asset?: string;
  readonly txSource: string;
  /** Outer fee-bump fee source, when the envelope was fee-bumped. */
  readonly feeSource?: string;
  /** Net fee in stroops (charge minus refund), from transaction-level fee events. */
  readonly feeCharged?: string;
  /** Registry id of the facilitator that submitted this, when attributable. */
  readonly facilitatorId?: string;
  readonly confidence: Confidence;
  readonly sigExpirationLedger?: number;
  readonly memo?: string;
  /** Destination muxed id when the transfer event carried `{amount, to_muxed_id}`. */
  readonly muxedId?: string;
  /** Ledger close time, ISO-8601. */
  readonly closedAt: string;
  /** Enrichment: Bazaar serviceName for the seller, when known. */
  readonly serviceName?: string;
  /** Enrichment: Bazaar resource URL for the seller, when known. */
  readonly resource?: string;
  /** Full getTransaction JSON, verbatim — reclassification must be a DB job, never a re-crawl. */
  readonly rawEnvelope: string;
  readonly ingestedAt: string;
}

export interface FacilitatorRow {
  /** Stable slug, e.g. "rail402", "x402-org", or derived from the announced host. */
  readonly id: string;
  readonly baseUrl: string;
  readonly displayName?: string;
  /** True once a live /supported probe succeeded. Announcements start unverified. */
  readonly verified: boolean;
  /** Signer addresses published by /supported `signers` (all networks' values, flattened). */
  readonly signers: readonly string[];
  /** upto settlement contracts advertised in /supported `extra.uptoContract`. */
  readonly uptoContracts: readonly string[];
  /** CAIP-2 networks the facilitator advertises. */
  readonly networks: readonly string[];
  readonly source: "seed" | "announce";
  readonly lastSeenAt?: string;
  readonly lastError?: string;
  readonly createdAt: string;
}

export interface SellerMeta {
  readonly network: string;
  readonly payTo: string;
  readonly serviceName?: string;
  readonly resource?: string;
  readonly description?: string;
  readonly fetchedAt: string;
}

export interface CursorState {
  readonly network: string;
  readonly epoch: string;
  /** getEvents cursor to resume from; undefined before the first successful poll. */
  readonly cursor?: string;
  readonly lastLedger: number;
  readonly updatedAt: string;
}

/** Tier-1 deep-backfill progress: replaying the RPC retention window behind the live tail. */
export interface BackfillState {
  readonly network: string;
  /** Chain epoch this backfill belongs to — a reset starts a fresh backfill (review M3). */
  readonly epoch: string;
  /** getEvents cursor inside the backfill walk; undefined before the first page. */
  readonly cursor?: string;
  /** The ledger where the live tail began — backfill is done once it reaches this. */
  readonly targetLedger: number;
  readonly done: boolean;
  readonly updatedAt: string;
}
