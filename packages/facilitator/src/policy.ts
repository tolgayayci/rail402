import type { StellarNetwork, TokenInfo } from "@rail402.dev/stellar";

/** Operator policy for one network. Every limit is configuration, never a constant in code. */
export interface NetworkPolicy {
  readonly network: StellarNetwork;
  /** SEP-41 tokens this facilitator settles, keyed by contract address. */
  readonly assets: ReadonlyMap<string, AcceptedAsset>;
  /** Accepted range for `maxTimeoutSeconds`. */
  readonly timeoutSeconds: { readonly min: number; readonly max: number };
  /**
   * Ledgers the payer's authorization must remain valid for after the current ledger. Settlement
   * lands one or two ledgers later; an authorization expiring sooner would fail on-chain after the
   * sponsor has paid its fee.
   */
  readonly expirationMarginLedgers: number;
  /** Ceiling on the simulation-derived settlement fee, in stroops. */
  readonly maxTransactionFeeStroops: number;
  /** Inclusion fee bid on top of the resource fee, in stroops (at least 100 per the exact spec). */
  readonly inclusionFeeStroops: number;
}

export interface AcceptedAsset extends TokenInfo {
  /** Inclusive bounds on `amount`, in the token's smallest unit. */
  readonly minAmount: bigint;
  readonly maxAmount: bigint;
}

export const DEFAULT_TIMEOUT_SECONDS = { min: 10, max: 300 } as const;
export const DEFAULT_EXPIRATION_MARGIN_LEDGERS = 1;
/**
 * The exact spec's default ceiling is 50,000 stroops. Smart-account (C…) payers cost more:
 * protocol 28 measurements of `__check_auth` payments range from 180k to 226k stroops, so the
 * default leaves room for them. Operators lower it when they serve only G… payers.
 */
export const DEFAULT_MAX_TRANSACTION_FEE_STROOPS = 300_000;
/** The spec minimum. Pubnet surge pricing needs more; operators raise it per network. */
export const MIN_INCLUSION_FEE_STROOPS = 100;

export function acceptedAsset(
  token: TokenInfo,
  bounds?: Partial<Pick<AcceptedAsset, "minAmount" | "maxAmount">>,
): AcceptedAsset {
  return {
    ...token,
    minAmount: bounds?.minAmount ?? 1n,
    // Anything above i128 cannot be a transfer amount.
    maxAmount: bounds?.maxAmount ?? (1n << 127n) - 1n,
  };
}
