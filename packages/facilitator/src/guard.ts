import type { SponsorGuard } from "./engine.ts";
import type { SettlementLedger } from "./ledger.ts";

export interface SponsorBudgetOptions {
  readonly network: string;
  readonly ledger: SettlementLedger;
  /** Latest known sponsor balance in stroops, or undefined while unknown. */
  readonly balance: () => bigint | undefined;
  /** Refuse settlements while the sponsor holds less than this (stroops). */
  readonly minBalanceStroops: bigint;
  /** Refuse settlements once this much fee (stroops) was committed in the last hour; undefined = no cap. */
  readonly maxSpendPerHourStroops?: bigint;
}

/**
 * Circuit breaker for the fee sponsor. It stops new settlements — before any RPC work or fee is
 * committed — when the sponsor's balance falls below its reserve floor, or when the fees committed in
 * the last hour (the recorded envelopes' maximum fees, summed across every replica) reach the budget.
 * It bounds what a flood of settlements, legitimate or griefing, can cost the operator.
 */
export class SponsorBudget implements SponsorGuard {
  private readonly options: SponsorBudgetOptions;

  constructor(options: SponsorBudgetOptions) {
    this.options = options;
  }

  async admit(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const balance = this.options.balance();
    if (balance !== undefined && balance < this.options.minBalanceStroops) {
      return {
        ok: false,
        reason: `The fee sponsor's balance is below its reserve floor on ${this.options.network}; settlement resumes once it is refunded.`,
      };
    }
    const cap = this.options.maxSpendPerHourStroops;
    if (cap !== undefined) {
      const spent = await this.options.ledger.committedFeesSince(
        this.options.network,
        new Date(Date.now() - 3_600_000),
      );
      if (spent >= cap) {
        return {
          ok: false,
          reason: `The hourly fee budget for ${this.options.network} is exhausted; retry later.`,
        };
      }
    }
    return { ok: true };
  }
}
