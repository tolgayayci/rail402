/**
 * `PaymentPayload.payload` of an x402 `upto` payment on Stellar.
 *
 * The client cannot build the settlement transaction: the amount is only known after the resource
 * is served, and the operation source and the authority's authorization belong to the facilitator.
 * The payer therefore signs one Soroban authorization entry, and the facilitator builds and submits
 * the invocation around it.
 */
export interface UptoStellarPayload {
  /** Base64 XDR `SorobanAuthorizationEntry` of the payer for `settle(terms)` (see `terms.ts`). */
  readonly authorization: string;
  /**
   * Base64 XDR entries that a smart-account payer's own `__check_auth` requires from delegated
   * signers. At most four; each has address credentials for an address other than the payer and a
   * root `ContractFn{payer, "__check_auth", …}` without children.
   */
  readonly signerAuthorizations?: readonly string[];
}

/** `PaymentRequirements.extra` of an `upto` payment on Stellar. */
export interface UptoStellarExtra {
  /** Must be `true`: the facilitator pays every network fee. */
  readonly areFeesSponsored: true;
  /** The settlement authority: the only address allowed to choose the amount and settle. */
  readonly facilitatorAddress: string;
}

/**
 * What a facilitator does with a zero-amount settlement:
 * - `onchain` submits `settle(…, 0)`, which consumes the payer's nonce, emits `upto_settled` and
 *   returns a transaction hash (the default);
 * - `offchain` records the authorization as used and returns `transaction: ""` without submitting.
 */
export type ZeroSettlementMode = "onchain" | "offchain";

/** A contract address per CAIP-2 network, or one address for every network. */
export type UptoContractOverride = string | Readonly<Record<string, string>>;

/** Seconds per ledger, fixed or estimated per network. */
export type LedgerSecondsSource = number | ((network: string) => number | Promise<number>);
