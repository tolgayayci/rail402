import type { RegistrySnapshot } from "./registry.ts";

/** "x402 Stellar indexing rules v2" (rules/v2.md). Stamped on every row. */
export const RULES_VERSION = "2";

export type IndexNetwork = "stellar:testnet" | "stellar:pubnet";

export interface ClassifyContext {
  readonly network: IndexNetwork;
  /** "pubnet", or the date of the testnet reset the ledgers belong to, e.g. "2025-12-17". */
  readonly epoch: string;
  readonly passphrase: string;
  readonly registry: RegistrySnapshot;
}

export interface TransactionInput {
  /** Base64 TransactionEnvelope (v1 or fee bump). */
  readonly envelopeXdr: string;
  /** Base64 TransactionResult, as RPC `getTransaction` returns it. */
  readonly resultXdr: string;
  /** Base64 TransactionMeta (version 0 to 4). */
  readonly metaXdr: string;
  readonly ledger: number;
  /** 1-based application order in the ledger. */
  readonly txIndex: number;
  /** ISO 8601 close time of the ledger. */
  readonly closedAt: string;
}

export type ExclusionReason =
  | "multi_operation"
  | "multi_auth"
  | "delegated_credentials"
  | "sub_invocations"
  | "transfer_event_mismatch"
  | "unproven_authorization"
  | "self_paid_fee"
  | "upto_unregistered_contract"
  | "upto_wasm_mismatch"
  | "malformed";

export const EXCLUSION_REASONS: readonly ExclusionReason[] = [
  "multi_operation",
  "multi_auth",
  "delegated_credentials",
  "sub_invocations",
  "transfer_event_mismatch",
  "unproven_authorization",
  "self_paid_fee",
  "upto_unregistered_contract",
  "upto_wasm_mismatch",
  "malformed",
];

export type AttributionTier = "rail402" | "rail402-beta" | "facilitator" | "shaped";
export type RuleId = "R-EXACT" | "R-UPTO" | "R-UPTO-BETA";

/** The check ids of rules/v2.md that a row passed, in rule order. */
export type CheckId =
  | "E1"
  | "E2"
  | "E3"
  | "E4"
  | "E5"
  | "E6"
  | "E7"
  | "U1"
  | "U2"
  | "U3"
  | "U4"
  | "U5"
  | "U6"
  | "U7"
  | "B1"
  | "B2"
  | "B3";

/** One sentence per check, as rules/v2.md words it, for pages that list the checks a row passed. */
export const CHECKS: Readonly<Record<CheckId, string>> = {
  E1: "The transaction succeeded.",
  E2: "One operation: a contract's transfer(from, to, amount) with a positive amount.",
  E3: "Exactly one authorization entry, with address credentials naming from.",
  E4: "That entry's root invocation is this transfer exactly, with no sub-invocations.",
  E5: "The payer is neither the fee payer nor a source account: the fee was sponsored.",
  E6: "Exactly one transfer event from the token names the same payer, seller and amount.",
  E7: "The payer's authorization is proven: the token is a verified Stellar Asset Contract, or the payer's own key signed the entry.",
  U1: "The transaction succeeded.",
  U2: "One operation: settle on a contract.",
  U3: "The contract is in the upto registry for this ledger.",
  U4: "The contract runs the registered WASM.",
  U5: "Exactly one upto_settled event from that contract.",
  U6: "The token's transfer events match the settled amount.",
  U7: "The payer is neither the fee payer nor a source account: the fee was sponsored.",
  B1: "The transaction succeeded.",
  B2: "One operation: settle on a concluded beta upto contract.",
  B3: "Exactly one transfer event, from someone other than the fee payer and the sources.",
};

export interface SettlementRow {
  readonly network: IndexNetwork;
  readonly epoch: string;
  readonly ledger: number;
  readonly txIndex: number;
  /** The outer hash for a fee bump, otherwise the transaction hash. */
  readonly txHash: string;
  readonly innerHash: string | null;
  readonly closedAt: string;
  readonly scheme: "exact" | "upto";
  readonly ruleId: RuleId;
  readonly rulesVersion: string;
  readonly registryVersion: string;
  /** `code` and `issuer` are set only when `verified`: the SAC contract id of that asset is `contract`. */
  readonly asset: {
    readonly contract: string;
    readonly code: string | null;
    readonly issuer: string | null;
    readonly verified: boolean;
  };
  readonly payer: string;
  readonly payerKind: "G" | "C";
  /** The seller's base account. */
  readonly payTo: string;
  readonly payToMuxedId: string | null;
  /** Atomic units, from the event. */
  readonly amount: string;
  /** The upto cap. */
  readonly maxAmount: string | null;
  readonly upto: { readonly contract: string; readonly authority: string } | null;
  readonly fee: {
    readonly bump: boolean;
    readonly payer: string;
    readonly innerSource: string;
    readonly opSource: string;
    readonly chargedStroops: string;
    readonly sponsored: boolean;
  };
  readonly attribution: {
    readonly tier: AttributionTier;
    readonly facilitatorId: string | null;
    readonly evidenceUrl: string | null;
    /**
     * The facilitator is marked `sharedRelayer`: it also relays transfers that are not x402 payments,
     * so this row may not be one (rules/v2.md section 6.1).
     */
    readonly sharedRelayer: boolean;
  };
  readonly checks: readonly CheckId[];
}

export interface FailedAttemptRow {
  readonly network: IndexNetwork;
  readonly epoch: string;
  readonly ledger: number;
  readonly txIndex: number;
  readonly txHash: string;
  readonly scheme: "exact" | "upto";
  /** Outer, inner and operation result codes joined with ":". */
  readonly resultCode: string;
  readonly feePayer: string;
  readonly feeChargedStroops: string;
}

export type Classification =
  | { readonly kind: "settlement"; readonly row: SettlementRow }
  | { readonly kind: "failed_attempt"; readonly row: FailedAttemptRow }
  | { readonly kind: "excluded"; readonly reason: ExclusionReason }
  | { readonly kind: "none" };

export interface LedgerClassification {
  readonly ledger: number;
  readonly ledgerHash: string;
  readonly previousLedgerHash: string;
  readonly closedAt: string;
  readonly txCount: number;
  /** Sorted by `txIndex`. */
  readonly rows: readonly SettlementRow[];
  readonly failed: readonly FailedAttemptRow[];
  readonly excluded: Readonly<Partial<Record<ExclusionReason, number>>>;
}
