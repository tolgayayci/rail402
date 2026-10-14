import { setTimeout as sleep } from "node:timers/promises";
import type { Keypair, rpc } from "@stellar/stellar-sdk";
import {
  ContractTtlError,
  contractLiveness,
  extendContractTtl,
  networkTtlLimits,
  planContractTtl,
  restoreContract,
  type ContractLiveness,
  type Logger,
  type TaskLock,
  type TtlPlan,
  type TtlTransaction,
} from "@rail402.dev/facilitator";
import { readContractTtl } from "@rail402.dev/stellar";
import type { UptoTtlConfig } from "./config.ts";
import type { Metrics } from "./metrics.ts";

/**
 * The lock of everything that submits from the sponsor account itself (its own sequence number):
 * channel and authority provisioning, and this keeper's rounds. It is keyed by the sponsor, so only
 * processes that share one wait for each other; a Postgres advisory lock spans the whole database,
 * whatever schema each deployment uses.
 */
export const sponsorLockName = (network: string, sponsor: string) => `sponsor:${network}:${sponsor}`;

/** How long an operator's forced round waits for another task on the sponsor account. */
const FORCED_ROUND_WAIT_MS = 60_000;

/** Ledgers left out of the network maximum when an extension target is not configured: one day. */
const EXTEND_TO_MARGIN_LEDGERS = 17_280;

/** What the keeper did or found in its last round. */
export interface KeeperAction {
  readonly action: "extend" | "restore";
  readonly transaction: string;
  readonly at: Date;
}

export interface UptoKeeperSnapshot {
  /** Whether the keeper extends and restores the contract; a disabled keeper still reports. */
  readonly enabled: boolean;
  readonly autoRestore: boolean;
  readonly checkedAt?: Date;
  /** What the last reading calls for; `restore_required` waits for an operator. */
  readonly plan?: TtlPlan["action"];
  readonly lastAction?: KeeperAction;
  /** The last round's failure; cleared by a round that succeeds. */
  readonly error?: string;
}

/** One maintenance round's outcome. */
export interface KeeperRound {
  readonly plan: TtlPlan;
  readonly liveness: ContractLiveness;
  /** Transactions submitted in the round, in order. */
  readonly transactions: readonly (TtlTransaction & { readonly action: "extend" | "restore" })[];
  /** The round did not run because another task held the sponsor account's lock. */
  readonly skipped?: boolean;
}

export interface UptoKeeperOptions {
  readonly network: string;
  readonly server: rpc.Server;
  readonly passphrase: string;
  /** Pays for extensions and restorations. */
  readonly sponsor: Keypair;
  readonly contract: string;
  readonly wasmHash: string;
  readonly ttl: UptoTtlConfig;
  readonly inclusionFeeStroops: number;
  /** XLM, in stroops, the sponsor keeps for settlements; a round never spends below it. */
  readonly sponsorReserveStroops: bigint;
  /** One round at a time across replicas, and never next to provisioning (see `sponsorLockName`). */
  readonly lock: TaskLock;
  readonly metrics: Metrics;
  readonly log: Logger;
}

/**
 * Keeps the `upto` settlement contract live on one network. Each round reads the instance and code
 * TTLs under a lock shared by every replica, extends both entries once either has fewer ledgers left
 * than the threshold, and restores archived entries where automatic restoration is allowed (then
 * extends them, since a restored entry comes back with the minimum TTL). The sponsor pays, outside
 * any payment: while the contract is archived, `upto` payments are refused rather than paying the
 * restoration inside a buyer's transaction.
 */
export class UptoTtlKeeper {
  private readonly options: UptoKeeperOptions;
  private last: UptoKeeperSnapshot;

  constructor(options: UptoKeeperOptions) {
    this.options = options;
    this.last = { enabled: options.ttl.keeper, autoRestore: options.ttl.autoRestore };
  }

  snapshot(): UptoKeeperSnapshot {
    return this.last;
  }

  /**
   * A background round: runs only when the keeper is enabled and never throws. Resolves whether it
   * submitted a transaction, so the caller can read the contract's TTL again.
   */
  async tick(): Promise<boolean> {
    if (!this.options.ttl.keeper) return false;
    try {
      return (await this.maintain()).transactions.length > 0;
    } catch {
      // maintain() recorded the failure in the snapshot, the metrics and the log.
      return false;
    }
  }

  /**
   * Reads the contract's TTL and acts on it: extends, restores (when allowed) or does nothing.
   * `force` overrides the plan for an operator: `extend` extends even above the threshold, `restore`
   * restores archived entries even where automatic restoration is off. Throws on failure.
   */
  async maintain(force?: "extend" | "restore"): Promise<KeeperRound> {
    const { network, lock, log } = this.options;
    try {
      const name = sponsorLockName(network, this.options.sponsor.publicKey());
      let round = await lock.run(name, () => this.round(force));
      // A background round simply runs again later; an operator's forced round waits, within a bound,
      // for provisioning or another replica's round to finish.
      const deadline = Date.now() + (force === undefined ? 0 : FORCED_ROUND_WAIT_MS);
      while (round === undefined && Date.now() < deadline) {
        await sleep(1_000);
        round = await lock.run(name, () => this.round(force));
      }
      if (round === undefined) {
        const liveness = await this.liveness();
        return { plan: { action: "none" }, liveness, transactions: [], skipped: true };
      }
      const final = round.transactions.at(-1);
      this.last = {
        enabled: this.last.enabled,
        autoRestore: this.last.autoRestore,
        checkedAt: new Date(),
        // After an extension or restoration the contract needs nothing more.
        plan: final === undefined ? round.plan.action : "none",
        ...(final === undefined
          ? this.last.lastAction === undefined
            ? {}
            : { lastAction: this.last.lastAction }
          : { lastAction: { action: final.action, transaction: final.hash, at: new Date() } }),
      };
      if (round.plan.action === "restore_required") {
        log.error(
          { network, contract: this.options.contract },
          "the upto contract is archived; upto payments are refused until an operator restores it",
        );
      } else if (round.plan.action === "missing") {
        log.error(
          { network, contract: this.options.contract },
          "the upto contract or its code is not on the network; upto payments fail until it is deployed",
        );
      }
      return round;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.last = { ...this.last, checkedAt: new Date(), error: message };
      this.options.metrics.backgroundErrors.inc({ task: "upto_ttl_keeper" });
      log.error({ err: error, network }, "the upto contract TTL round failed");
      throw error;
    }
  }

  private async round(force?: "extend" | "restore"): Promise<KeeperRound> {
    const { ttl } = this.options;
    const liveness = await this.liveness();
    const plan = planContractTtl(liveness, {
      extendBelowLedgers: force === "extend" ? Number.POSITIVE_INFINITY : ttl.extendBelowLedgers,
      autoRestore: ttl.autoRestore || force === "restore",
    });
    const transactions: KeeperRound["transactions"][number][] = [];
    if (plan.action === "restore") {
      const restored = await this.act("restore", () =>
        restoreContract({
          ...this.maintenance(),
          archived: { instance: liveness.instanceArchived, code: liveness.codeArchived },
        }),
      );
      if (restored !== undefined) transactions.push({ ...restored, action: "restore" });
    }
    if (plan.action === "restore" || plan.action === "extend") {
      const extendToLedgers = await this.extendToLedgers();
      const extended = await this.act("extend", () =>
        extendContractTtl({ ...this.maintenance(), extendToLedgers }),
      );
      transactions.push({ ...extended, action: "extend" });
    }
    return {
      plan,
      liveness: transactions.length === 0 ? liveness : await this.liveness(),
      transactions,
    };
  }

  private async act<T extends TtlTransaction | undefined>(
    action: "extend" | "restore",
    run: () => Promise<T>,
  ): Promise<T> {
    const { metrics, network, log } = this.options;
    try {
      const result = await run();
      metrics.uptoTtlKeeperActions.inc({ network, action, outcome: "ok" });
      if (result !== undefined) {
        log.info(
          {
            network,
            contract: this.options.contract,
            transaction: result.hash,
            fee: String(result.feeChargedStroops),
          },
          action === "extend" ? "extended the upto contract TTL" : "restored the upto contract",
        );
      }
      return result;
    } catch (error) {
      metrics.uptoTtlKeeperActions.inc({ network, action, outcome: "failed" });
      if (error instanceof ContractTtlError && error.transaction !== undefined) {
        log.error({ network, transaction: error.transaction }, `the upto contract ${action} failed on-chain`);
      }
      throw error;
    }
  }

  private maintenance() {
    const { server, passphrase, sponsor, contract, wasmHash, ttl, inclusionFeeStroops } = this.options;
    return {
      server,
      passphrase,
      sponsor,
      contract,
      wasmHash,
      maxFeeStroops: ttl.maxFeeStroops,
      inclusionFeeStroops,
      reserveStroops: this.options.sponsorReserveStroops,
    };
  }

  private async extendToLedgers(): Promise<number> {
    const configured = this.options.ttl.extendToLedgers;
    if (configured !== undefined) return configured;
    const { maxEntryTtl } = await networkTtlLimits(this.options.server);
    const extendTo = maxEntryTtl - EXTEND_TO_MARGIN_LEDGERS;
    // Otherwise every round would find the contract below the threshold again and pay once more.
    if (extendTo <= this.options.ttl.extendBelowLedgers) {
      throw new Error(
        `the network's maximum TTL (${String(maxEntryTtl)} ledgers) leaves no room above the extension threshold; configure UPTO_TTL_EXTEND_TO_LEDGERS and UPTO_TTL_EXTEND_BELOW_LEDGERS`,
      );
    }
    return extendTo;
  }

  private async liveness(): Promise<ContractLiveness> {
    const reading = await readContractTtl(this.options.server, [this.options.contract]);
    return contractLiveness(reading.contracts.get(this.options.contract), reading.latestLedger);
  }
}
