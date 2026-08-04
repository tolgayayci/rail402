/**
 * `upto` payload for Stellar.
 *
 * `transaction` is authoritative — the echoed fields exist so a facilitator can validate cheaply
 * before XDR decoding, and MUST be rejected on any mismatch with the decoded transaction. They are
 * a convenience, never a source of truth.
 */
export interface UptoStellarPayloadV2 extends Record<string, unknown> {
  /** Base64 XDR: one invokeHostFunction calling `settle`, carrying the signed auth tree. */
  transaction: string;
  /** The client-signed ceiling, atomic units. */
  maxAmount: string;
  /** Last ledger at which the authorization is valid. */
  expirationLedger: number;
  /** 32-byte hex nonce making the authorization single-use. */
  nonce: string;
}

/** `extra` on PaymentRequirements for `upto` on Stellar. */
export interface UptoStellarExtra {
  /** Settlement contract for this network. Clients MUST verify against the canonical table. */
  uptoContract: string;
  areFeesSponsored: boolean;
}
