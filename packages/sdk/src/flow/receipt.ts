import type { StellarNetwork } from "@rail402.dev/stellar";

/** An amount as a decimal in whole units of its asset and as base units. */
export interface ReceiptAmount {
  readonly amount: string;
  readonly atomic: string;
}

/** What a paid call paid, as far as the buyer can tell. */
export interface Receipt {
  /** `unknown`: a payment was sent but no settlement was reported; reconciliation settles it later. */
  readonly status: "settled" | "unknown";
  readonly scheme: "exact" | "upto";
  readonly network: StellarNetwork;
  /** The policy symbol of the asset, or its contract address when it has none. */
  readonly asset: string;
  readonly assetContract: string;
  readonly decimals: number;
  readonly authorized: ReceiptAmount;
  readonly settled: ReceiptAmount | null;
  readonly payTo: string;
  readonly payer: string;
  /** 64 lowercase hex characters: the hash the facilitator reported. */
  readonly transaction: string | null;
  readonly explorerUrl: string | null;
  readonly verifiedOnChain: boolean;
}
