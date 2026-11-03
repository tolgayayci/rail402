import type { RegistrySnapshot, RegistryUptoContract } from "./registry.ts";
import type { SettlementRow } from "./types.ts";

/**
 * The facilitator of a settlement (rules/v2.md section 6.1): the first of `accounts` (fee payer, inner
 * source, operation source) that the registry lists for this epoch and ledger. Keyed on the ledger,
 * never on when an entry was added, so a rebuild with the same registry attributes history the same way.
 */
export function attribute(
  registry: RegistrySnapshot,
  accounts: readonly string[],
  epoch: string,
  ledger: number,
): SettlementRow["attribution"] {
  for (const address of accounts) {
    const match = registry.accountAt(address, epoch, ledger);
    if (match === undefined) continue;
    return {
      tier: match.facilitator.tier,
      facilitatorId: match.facilitator.id,
      evidenceUrl: match.account.evidence[0]?.url ?? null,
      sharedRelayer: match.facilitator.sharedRelayer,
    };
  }
  return { tier: "shaped", facilitatorId: null, evidenceUrl: null, sharedRelayer: false };
}

/** The stored fields attribution depends on: everything else about a row is fixed by the ledger. */
export interface AttributionInput {
  readonly epoch: string;
  readonly ledger: number;
  readonly ruleId: SettlementRow["ruleId"];
  readonly upto: { readonly contract: string } | null;
  readonly fee: { readonly payer: string; readonly innerSource: string; readonly opSource: string };
}

/**
 * The attribution of a settlement row under `registry` (rules/v2.md section 6.1), from its stored
 * fields alone. The classifier and the re-attribution after a registry change both use it, so a row
 * re-attributed in place equals the row a fresh index would write.
 */
export function attributeSettlement(
  registry: RegistrySnapshot,
  row: AttributionInput,
): SettlementRow["attribution"] {
  const accounts = [...new Set([row.fee.payer, row.fee.innerSource, row.fee.opSource])];
  const byAccount = attribute(registry, accounts, row.epoch, row.ledger);
  if (row.ruleId !== "R-UPTO-BETA" || row.upto === null) return byAccount;
  const entry = registry.uptoContractAt(row.upto.contract, row.epoch, row.ledger);
  return entry === undefined ? byAccount : betaAttribution(entry, byAccount);
}

/**
 * A settlement through a concluded beta contract (rule R-UPTO-BETA) is beta history whoever submitted
 * it: tier `rail402-beta`, the contract entry's facilitator (or the matched account's, when it is a beta
 * account) and the contract's evidence.
 */
export function betaAttribution(
  entry: RegistryUptoContract,
  byAccount: SettlementRow["attribution"],
): SettlementRow["attribution"] {
  if (byAccount.tier === "rail402-beta") return byAccount;
  return {
    tier: "rail402-beta",
    facilitatorId: entry.facilitatorId ?? null,
    evidenceUrl: entry.evidence[0]?.url ?? null,
    sharedRelayer: false,
  };
}
