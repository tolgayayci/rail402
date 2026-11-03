import type { rpc } from "@stellar/stellar-sdk";
import { MIN_INCLUSION_FEE_STROOPS } from "./policy.ts";

export type FeePercentile = "p50" | "p70" | "p80" | "p90" | "p95" | "p99";

/**
 * One fee-stats reading: the bid it produced and, when the bid does not follow the network, why:
 * `cap` when the network asks for more than the cap (settlements may wait under surge pricing), or
 * `stats_unavailable` when fee stats could not be read and the floor is bid blind.
 */
export interface InclusionFeeReading {
  readonly bid: number;
  readonly pinned: "cap" | "stats_unavailable" | undefined;
}

export interface InclusionFeeOptions {
  /** Lowest bid, in stroops; also the bid when fee stats are unavailable. At least 100 (exact spec). */
  readonly floor: number;
  /** Highest bid, in stroops, whatever the network reports. */
  readonly cap: number;
  /** Which point of the recent Soroban inclusion-fee distribution to bid. */
  readonly percentile: FeePercentile;
  /** How long one fee-stats reading is reused as is. */
  readonly cacheMs?: number;
  /**
   * How long an older reading is still answered with while a fresh one is read in the background,
   * so no payment waits on fee stats. Past this age a bid waits for the network.
   */
  readonly staleMs?: number;
  /** Called with every fresh reading, e.g. to alert while bids are pinned at the cap. Never throws through. */
  readonly onReading?: (reading: InclusionFeeReading) => void;
}

/**
 * Inclusion-fee bids that follow the network. Bidding the spec minimum works on a quiet testnet but
 * leaves settlements waiting under surge pricing (pubnet's floor has been 200 stroops); bidding a
 * fixed high value overpays on every settlement. The bid tracks a percentile of recent Soroban
 * inclusion fees, clamped between an operator floor and cap, so the sponsor's worst case stays bounded.
 */
export class InclusionFeeOracle {
  private readonly server: rpc.Server;
  private readonly options: Required<Omit<InclusionFeeOptions, "onReading">> &
    Pick<InclusionFeeOptions, "onReading">;
  private cached: { readonly bid: number; readonly at: number } | undefined;
  private pending: Promise<number> | undefined;

  constructor(server: rpc.Server, options: InclusionFeeOptions) {
    if (options.floor < MIN_INCLUSION_FEE_STROOPS) {
      throw new RangeError(
        `the inclusion fee floor must be at least ${String(MIN_INCLUSION_FEE_STROOPS)} stroops`,
      );
    }
    if (options.cap < options.floor) throw new RangeError("the inclusion fee cap is below the floor");
    this.server = server;
    this.options = { cacheMs: 5_000, staleMs: 60_000, ...options };
  }

  /** The highest bid this oracle ever makes, in stroops. */
  get cap(): number {
    return this.options.cap;
  }

  /** The current bid in stroops. Never throws: falls back to the floor. */
  async bid(): Promise<number> {
    const age = this.cached === undefined ? Infinity : Date.now() - this.cached.at;
    if (this.cached !== undefined && age < this.options.cacheMs) return this.cached.bid;
    this.pending ??= this.read().finally(() => {
      this.pending = undefined;
    });
    if (this.cached !== undefined && age < this.options.staleMs) return this.cached.bid;
    return this.pending;
  }

  private async read(): Promise<number> {
    let observed: number | undefined;
    try {
      const stats = await this.server.getFeeStats();
      const value = Number(stats.sorobanInclusionFee[this.options.percentile]);
      if (Number.isFinite(value)) observed = value;
    } catch {
      // Keep bidding the floor while fee stats are unavailable.
    }
    const wanted = Math.ceil(observed ?? this.options.floor);
    const bid = Math.min(this.options.cap, Math.max(this.options.floor, wanted));
    this.cached = { bid, at: Date.now() };
    const pinned =
      observed === undefined ? "stats_unavailable" : wanted > this.options.cap ? "cap" : undefined;
    try {
      this.options.onReading?.({ bid, pinned });
    } catch {
      // Instrumentation never changes the bid.
    }
    return bid;
  }
}
