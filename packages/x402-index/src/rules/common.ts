import type { Buffer } from "buffer";
import type { xdr } from "@stellar/stellar-sdk";
import type { ContractEventView } from "../events.ts";
import type { OperationView, TransactionView } from "../transaction.ts";
import type { CheckId, ExclusionReason, RuleId } from "../types.ts";
import type { AddressView } from "../xdr.ts";

/** What a rule sees of one transaction. */
export interface RuleFacts {
  readonly view: TransactionView;
  /** The candidate operation and its index. */
  readonly operation: OperationView;
  readonly operationIndex: number;
  /** The candidate operation's contract events; empty for a failed transaction. */
  readonly events: readonly ContractEventView[];
  /** WASM hashes of contract instances in the transaction's ledger entry changes. */
  readonly instanceWasm: ReadonlyMap<string, ReadonlySet<string>>;
  /** The network's passphrase and its id (SHA-256 of the passphrase). */
  readonly passphrase: string;
  readonly networkId: Buffer;
  /** The ledger the transaction was applied in. */
  readonly ledger: number;
}

/** The payment a rule proved. */
export interface RuleMatch {
  readonly kind: "match";
  readonly scheme: "exact" | "upto";
  readonly ruleId: RuleId;
  readonly payer: AddressView;
  readonly payTo: string;
  readonly payToMuxedId: string | null;
  readonly amount: bigint;
  readonly maxAmount: bigint | null;
  readonly assetContract: string;
  readonly assetTopic: string | null;
  readonly upto: { readonly contract: string; readonly authority: string } | null;
  readonly checks: readonly CheckId[];
}

export type RuleOutcome =
  RuleMatch | { readonly kind: "excluded"; readonly reason: ExclusionReason } | { readonly kind: "none" };

export const excluded = (reason: ExclusionReason): RuleOutcome => ({ kind: "excluded", reason });
export const NONE: RuleOutcome = { kind: "none" };

/** The operation's source, or the inner transaction's source when it sets none. */
export function operationSource(facts: Pick<RuleFacts, "view" | "operation">): AddressView {
  return facts.operation.source ?? facts.view.innerSource;
}

/** Whether `address` is the fee payer, the inner source or the operation source (base accounts). */
export function isSource(facts: Pick<RuleFacts, "view" | "operation">, address: string): boolean {
  return (
    address === facts.view.feePayer.base ||
    address === facts.view.innerSource.base ||
    address === operationSource(facts).base
  );
}

/** Whether two ScVals encode to the same bytes. */
export function sameScVal(a: xdr.ScVal, b: xdr.ScVal): boolean {
  try {
    return a.toXDR("base64") === b.toXDR("base64");
  } catch {
    return false;
  }
}
