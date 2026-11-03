import { createHash } from "node:crypto";
import type {
  AttributionTier,
  ExclusionReason,
  FailedAttemptRow,
  SettlementRow,
} from "@rail402.dev/x402-index";

/**
 * JSON with object keys sorted at every level and no whitespace: the same value always gives the same
 * bytes, so files and their hashes can be compared across machines.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export const sha256 = (text: string | Buffer): string => createHash("sha256").update(text).digest("hex");

/** Payments, volume per asset contract, distinct payers and sellers. */
export interface Totals {
  payments: number;
  /** Atomic units per asset contract (amounts of different assets are never summed). */
  volume: Record<string, string>;
  payers: number;
  sellers: number;
}

export interface Aggregates {
  /**
   * Registered facilitators, Rail402 included: the rail402 and facilitator tiers, self-payments excluded.
   * In a registry-scope report this covers only what registry discovery reads, never the whole network.
   */
  readonly headline: Totals;
  /**
   * The part of the headline relayed by facilitators marked sharedRelayer, which also relay transfers
   * that are not x402 payments: counted in the headline and shown on its own line.
   */
  readonly headlineSharedRelayer: Totals;
  /** Settled by the hosted Rail402 service (tier rail402), self-payments excluded. */
  readonly rail402: Totals;
  /** Shaped matches no registry account explains: shown apart, never in the headline. */
  readonly unattributedShaped: Totals;
  /** The concluded Rail402 beta. */
  readonly rail402Beta: Totals;
  /** Payments whose payer is also the seller, in any tier: never in the headline. */
  readonly selfPayments: Totals;
  readonly byFacilitator: Record<string, Totals>;
  readonly byScheme: Record<string, Totals>;
  readonly byTier: Record<string, Totals>;
  /** Per UTC day: headline payments. */
  readonly daily: Record<string, { readonly headline: number; readonly unattributedShaped: number }>;
  readonly failedAttempts: number;
  readonly excluded: Partial<Record<ExclusionReason, number>>;
}

/** Totals of the rows added to it. */
export class Accumulator {
  payments = 0;
  readonly volume = new Map<string, bigint>();
  readonly payers = new Set<string>();
  readonly sellers = new Set<string>();

  add(row: SettlementRow): void {
    this.payments++;
    this.volume.set(row.asset.contract, (this.volume.get(row.asset.contract) ?? 0n) + BigInt(row.amount));
    this.payers.add(row.payer);
    this.sellers.add(row.payTo);
  }

  totals(): Totals {
    return {
      payments: this.payments,
      volume: Object.fromEntries(
        [...this.volume]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([asset, sum]) => [asset, sum.toString()]),
      ),
      payers: this.payers.size,
      sellers: this.sellers.size,
    };
  }
}

const HEADLINE_TIERS: ReadonlySet<AttributionTier> = new Set(["rail402", "facilitator"]);

/**
 * Totals for the report, row by row, following the tier rules of rules/v2.md section 6.1. Feeding the
 * same rows in the same order as `aggregate()` gives the same result, so a reader that streams rows
 * from a database computes exactly what a rebuild computes from ledgers.
 */
export class Aggregator {
  readonly #headline = new Accumulator();
  readonly #sharedRelayer = new Accumulator();
  readonly #rail402 = new Accumulator();
  readonly #shaped = new Accumulator();
  readonly #beta = new Accumulator();
  readonly #self = new Accumulator();
  readonly #byFacilitator = new Map<string, Accumulator>();
  readonly #byScheme = new Map<string, Accumulator>();
  readonly #byTier = new Map<string, Accumulator>();
  readonly #daily = new Map<string, { headline: number; unattributedShaped: number }>();
  #failedAttempts = 0;
  readonly #excluded: Partial<Record<ExclusionReason, number>> = {};

  add(row: SettlementRow): void {
    const tier = row.attribution.tier;
    bucket(this.#byTier, tier).add(row);
    if (row.payer === row.payTo) {
      this.#self.add(row);
      return;
    }
    const key = row.closedAt.slice(0, 10);
    const day = this.#daily.get(key) ?? { headline: 0, unattributedShaped: 0 };
    this.#daily.set(key, day);
    if (HEADLINE_TIERS.has(tier)) {
      this.#headline.add(row);
      if (row.attribution.sharedRelayer) this.#sharedRelayer.add(row);
      day.headline++;
      bucket(this.#byScheme, row.scheme).add(row);
      if (row.attribution.facilitatorId !== null)
        bucket(this.#byFacilitator, row.attribution.facilitatorId).add(row);
      if (tier === "rail402") this.#rail402.add(row);
    } else if (tier === "shaped") {
      this.#shaped.add(row);
      day.unattributedShaped++;
    } else {
      this.#beta.add(row);
      if (row.attribution.facilitatorId !== null)
        bucket(this.#byFacilitator, row.attribution.facilitatorId).add(row);
    }
  }

  addFailedAttempts(count: number): void {
    this.#failedAttempts += count;
  }

  addExcluded(reason: ExclusionReason, count: number): void {
    this.#excluded[reason] = (this.#excluded[reason] ?? 0) + count;
  }

  result(): Aggregates {
    const sorted = (map: Map<string, Accumulator>) =>
      Object.fromEntries(
        [...map].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, value.totals()]),
      );
    return {
      headline: this.#headline.totals(),
      headlineSharedRelayer: this.#sharedRelayer.totals(),
      rail402: this.#rail402.totals(),
      unattributedShaped: this.#shaped.totals(),
      rail402Beta: this.#beta.totals(),
      selfPayments: this.#self.totals(),
      byFacilitator: sorted(this.#byFacilitator),
      byScheme: sorted(this.#byScheme),
      byTier: sorted(this.#byTier),
      daily: Object.fromEntries([...this.#daily].sort(([a], [b]) => a.localeCompare(b))),
      failedAttempts: this.#failedAttempts,
      excluded: Object.fromEntries(Object.entries(this.#excluded).sort(([a], [b]) => a.localeCompare(b))),
    };
  }
}

function bucket(map: Map<string, Accumulator>, key: string): Accumulator {
  const found = map.get(key) ?? new Accumulator();
  map.set(key, found);
  return found;
}

/** Totals for the report, following the tier rules of rules/v2.md section 6.1. */
export function aggregate(
  rows: readonly SettlementRow[],
  failed: readonly FailedAttemptRow[],
  excluded: Partial<Record<ExclusionReason, number>>,
): Aggregates {
  const aggregator = new Aggregator();
  for (const row of rows) aggregator.add(row);
  aggregator.addFailedAttempts(failed.length);
  for (const [reason, count] of Object.entries(excluded))
    aggregator.addExcluded(reason as ExclusionReason, count);
  return aggregator.result();
}
