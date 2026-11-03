import { PUBLIC_CALLER } from "./caller.ts";
import type { AdmissionContext, SponsorGuard } from "./engine.ts";
import type { ClaimLimit, SettlementLedger } from "./ledger.ts";

/** The limit that refused a settlement, as counted in metrics. */
export type SponsorRefusal = "reserve" | "budget" | "caller_budget" | "balance_unknown";

export interface SponsorBudgetOptions {
  readonly network: string;
  readonly ledger: SettlementLedger;
  /** Latest known sponsor balance in stroops, or undefined while unknown. */
  readonly balance: () => bigint | undefined;
  /** Refuse settlements while the sponsor holds less than this (stroops). */
  readonly minBalanceStroops: bigint;
  /**
   * Refuse while the balance is unknown (after a restart, or while the RPC cannot be read) instead of
   * admitting: the reserve floor cannot be checked then. Pubnet sets it.
   */
  readonly refuseWhileUnknown?: boolean;
  /** Refuse settlements once this much fee (stroops) was committed in the last hour; undefined = no cap. */
  readonly maxSpendPerHourStroops?: bigint;
  /**
   * The hourly budget of callers that bring none of their own (`CallerContext` without
   * `sponsorBudgetStroopsPerHour`), shared by all of them; undefined = no keyless cap.
   */
  readonly keylessSpendPerHourStroops?: bigint;
  /** Called on each refusal with the limit that refused. */
  readonly onRefusal?: (limit: SponsorRefusal) => void;
}

/**
 * Circuit breaker for the fee sponsor. It stops new settlements — before any RPC work or fee is
 * committed — when the sponsor's balance falls below its reserve floor, or when the fees committed in
 * the last hour (the recorded envelopes' maximum fees and the reservations of claims not yet signed,
 * summed across every replica) would exceed the network's budget or the caller's own. The budgets are
 * enforced by the settlement ledger together with each claim (`limits`), so concurrent admissions
 * cannot overshoot them. It bounds what a flood of settlements, legitimate or griefing, can cost the
 * operator, and what one caller can take from the others.
 */
export class SponsorBudget implements SponsorGuard {
  private readonly options: SponsorBudgetOptions;

  constructor(options: SponsorBudgetOptions) {
    this.options = options;
  }

  async admit(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const balance = this.options.balance();
    if (balance === undefined && this.options.refuseWhileUnknown === true) {
      this.refused("balance_unknown");
      return {
        ok: false,
        reason: `The fee sponsor's balance on ${this.options.network} has not been read yet; retry shortly.`,
      };
    }
    if (balance !== undefined && balance < this.options.minBalanceStroops) {
      this.refused("reserve");
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
        this.refused("budget");
        return {
          ok: false,
          reason: `The hourly fee budget for ${this.options.network} is exhausted; retry later.`,
        };
      }
    }
    return { ok: true };
  }

  limits(context: AdmissionContext): readonly ClaimLimit[] {
    const since = new Date(Date.now() - 3_600_000);
    const limits: ClaimLimit[] = [];
    const network = this.options.maxSpendPerHourStroops;
    if (network !== undefined) limits.push({ scope: "network", capStroops: network, since });
    // Keyless callers share the keyless budget; a key brings its own, or none.
    const who = context.caller;
    const caller =
      who === undefined || who.subject === PUBLIC_CALLER
        ? this.options.keylessSpendPerHourStroops
        : who.sponsorBudgetStroopsPerHour;
    if (caller !== undefined) limits.push({ scope: "caller", capStroops: caller, since });
    return limits;
  }

  refusedByLedger(limit: ClaimLimit): string {
    if (limit.scope === "caller") {
      this.refused("caller_budget");
      return `This caller's hourly fee budget for ${this.options.network} is spent; retry later.`;
    }
    this.refused("budget");
    return `The hourly fee budget for ${this.options.network} is exhausted; retry later.`;
  }

  private refused(limit: SponsorRefusal): void {
    try {
      this.options.onRefusal?.(limit);
    } catch {
      // Instrumentation never changes the guard's answer.
    }
  }
}
