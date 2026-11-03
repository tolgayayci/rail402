import type { AdmissionContext, AdmissionRefusal, SponsorGuard } from "./engine.ts";
import { PUBLIC_CALLER } from "./caller.ts";
import type { ClaimLimit, SettlementLedger } from "./ledger.ts";

/** Which per-party limit refused a settlement. */
export type PartyLimit = "payer_rate" | "payto_rate" | "payer_cooldown" | "limiter_unavailable";

export interface SettleLimitsOptions {
  readonly network: string;
  /** The guard these limits wrap, usually a `SponsorBudget`; asked first. */
  readonly inner?: SponsorGuard;
  /**
   * Counts one settlement for `key` under `perMinute`: 0 when allowed, else seconds to wait. Shared
   * by every replica when it is backed by the database.
   */
  readonly take: (key: string, perMinute: number) => number | Promise<number>;
  /** Settlements one payer may start per minute on the network; unset = no limit. */
  readonly payerPerMinute?: number;
  /**
   * Settlements one `payTo` may receive per minute on the network from one caller; unset = no limit.
   * Each access key has its own bucket per payTo and every keyless caller shares one, so keyless
   * traffic can never use up the quota of a seller who settles under its own key.
   */
  readonly payToPerMinute?: number;
  /**
   * The failed-settlement cooldown: a payer whose settlements were included and failed this many
   * times in the last hour is refused until the hour moves on; unset = off.
   */
  readonly failuresPerHour?: number;
  /** Counts a payer's included failures (`SettlementLedger.failuresSince`). */
  readonly ledger?: Pick<SettlementLedger, "failuresSince">;
  /** Refuse when the counter or the ledger cannot answer, instead of admitting (pubnet). */
  readonly failClosed: boolean;
  readonly onRefusal?: (limit: PartyLimit) => void;
}

/**
 * Per-party limits on settlement: how many settlements one payer may start and one `payTo` may
 * receive per minute, and a cooldown for a payer whose settlements keep failing on-chain (each such
 * failure costs the sponsor a fee). They bound what one party can make the sponsor pay, below the
 * network and caller budgets.
 *
 * The payer and the payTo are read from the payment, which anyone can forge. So the per-minute
 * limits count only payments that proved the payer's signature (`admitVerified`, asked just before
 * the sponsor signs): a flood of payloads with garbage signatures that name a seller or a wallet
 * cannot use up their quota. Forged payloads are bounded by the per-address and per-key request
 * limits instead. The cooldown only reads included failures, which a forged payload cannot cause, so
 * it runs at admission, before any RPC work.
 */
export class SettleLimits implements SponsorGuard {
  private readonly options: SettleLimitsOptions;

  constructor(options: SettleLimitsOptions) {
    this.options = options;
  }

  async admit(
    context?: AdmissionContext,
  ): Promise<{ readonly ok: true } | ({ readonly ok: false } & AdmissionRefusal)> {
    const inner = await this.options.inner?.admit(context);
    if (inner !== undefined && !inner.ok) return inner;
    if (context === undefined) return { ok: true };
    const { network } = this.options;
    const failures = this.options.failuresPerHour;
    if (failures === undefined || this.options.ledger?.failuresSince === undefined) return { ok: true };
    try {
      const count = await this.options.ledger.failuresSince(
        network,
        context.payer,
        new Date(Date.now() - 3_600_000),
      );
      if (count >= failures) {
        return this.refuse(
          "payer_cooldown",
          `This payer's settlements failed on-chain ${String(count)} times in the last hour on ${network}; retry later.`,
        );
      }
    } catch {
      if (this.options.failClosed) return this.unavailable();
    }
    return { ok: true };
  }

  /** Counts a payment whose signature was proven against the payer and payTo limits. */
  async admitVerified(
    context: AdmissionContext,
  ): Promise<{ readonly ok: true } | ({ readonly ok: false } & AdmissionRefusal)> {
    const inner = await this.options.inner?.admitVerified?.(context);
    if (inner !== undefined && !inner.ok) return inner;
    const { network } = this.options;
    try {
      if (this.options.payerPerMinute !== undefined) {
        const wait = await this.options.take(
          `n:${network}|payer:${context.payer}`,
          this.options.payerPerMinute,
        );
        if (wait > 0) {
          return this.refuse(
            "payer_rate",
            `This payer started too many settlements on ${network}; retry in ${String(wait)} s.`,
          );
        }
      }
      if (this.options.payToPerMinute !== undefined && context.payTo !== undefined) {
        const wait = await this.options.take(payToBucket(network, context), this.options.payToPerMinute);
        if (wait > 0) {
          return this.refuse(
            "payto_rate",
            `This payTo received too many settlements from this caller on ${network}; retry in ${String(wait)} s.`,
          );
        }
      }
    } catch {
      if (this.options.failClosed) return this.unavailable();
    }
    return { ok: true };
  }

  limits(context: AdmissionContext): readonly ClaimLimit[] {
    return this.options.inner?.limits?.(context) ?? [];
  }

  refusedByLedger(limit: ClaimLimit, context: AdmissionContext): string {
    return (
      this.options.inner?.refusedByLedger?.(limit, context) ??
      `The hourly fee budget for ${this.options.network} is exhausted; retry later.`
    );
  }

  private unavailable(): { readonly ok: false } & AdmissionRefusal {
    return this.refuse(
      "limiter_unavailable",
      `Settlement limits cannot be checked on ${this.options.network}; retry shortly.`,
    );
  }

  private refuse(limit: PartyLimit, reason: string): { readonly ok: false } & AdmissionRefusal {
    try {
      this.options.onRefusal?.(limit);
    } catch {
      // Instrumentation never changes the answer.
    }
    return { ok: false, reason, ...(limit === "limiter_unavailable" ? {} : { limit }) };
  }
}

/**
 * The per-payTo bucket of a settlement: one per access key and payTo, and one per payTo shared by
 * every keyless caller. The caller chooses the payTo and the amount, so a single global bucket would
 * let anyone (keyless included) use up a seller's quota with genuine dust payments.
 */
export function payToBucket(network: string, context: Pick<AdmissionContext, "payTo" | "caller">): string {
  // `key:<id>` for an access-key holder, `public` for every keyless caller.
  const subject = context.caller?.subject ?? PUBLIC_CALLER;
  return `n:${network}|${subject}|payto:${context.payTo ?? ""}`;
}
