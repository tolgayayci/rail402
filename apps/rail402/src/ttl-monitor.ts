import type { rpc } from "@stellar/stellar-sdk";
import type { Logger } from "@rail402.dev/facilitator";
import { readContractTtl } from "@rail402.dev/stellar";
import type { Metrics } from "./metrics.ts";

/** A contract whose TTL is watched, under a short operator-chosen alias used as its metric label. */
export interface WatchedContract {
  readonly alias: string;
  readonly contract: string;
}

/** What the last check found for one watched contract. */
export interface ContractTtlStatus {
  readonly alias: string;
  readonly id: string;
  readonly kind?: "wasm" | "stellar_asset";
  /** Ledgers until the instance entry is archived; negative once it is. */
  readonly instanceTtlLedgers?: number;
  /** Ledgers until the code entry is archived; absent for a Stellar Asset Contract. */
  readonly codeTtlLedgers?: number;
  /** The instance is not in the live state: never deployed, or archived and evicted. */
  readonly missing?: boolean;
}

export interface ContractTtlSnapshot {
  readonly checkedAt?: Date;
  /** The last check failed to read the ledger; `contracts` then holds the previous findings. */
  readonly error?: string;
  readonly contracts: readonly ContractTtlStatus[];
}

/**
 * Watches the TTL of the contracts a network's settlements depend on: every accepted token (the USDC
 * Stellar Asset Contract, other SEP-41 tokens) and any contract the operator adds. An archived
 * contract fails every payment that touches it, so its remaining ledgers are exported as
 * `rail402_contract_ttl_ledgers{network,contract,entry}` and surface as `/health` warnings.
 */
export class ContractTtlMonitor {
  private readonly network: string;
  private readonly server: Pick<rpc.Server, "getLedgerEntries">;
  private readonly contracts: readonly WatchedContract[];
  private readonly metrics: Metrics;
  private readonly log: Logger;
  private last: ContractTtlSnapshot = { contracts: [] };

  constructor(options: {
    network: string;
    server: Pick<rpc.Server, "getLedgerEntries">;
    contracts: readonly WatchedContract[];
    metrics: Metrics;
    log: Logger;
  }) {
    this.network = options.network;
    this.server = options.server;
    this.contracts = options.contracts;
    this.metrics = options.metrics;
    this.log = options.log;
  }

  get watched(): readonly WatchedContract[] {
    return this.contracts;
  }

  snapshot(): ContractTtlSnapshot {
    return this.last;
  }

  /** Reads every watched contract's TTL once; never throws. */
  async check(): Promise<ContractTtlSnapshot> {
    if (this.contracts.length === 0) return this.last;
    const network = this.network;
    try {
      const reading = await readContractTtl(
        this.server,
        this.contracts.map((watched) => watched.contract),
      );
      const contracts = this.contracts.map((watched): ContractTtlStatus => {
        const ttl = reading.contracts.get(watched.contract);
        const labels = { network, contract: watched.alias };
        if (ttl === undefined) {
          this.metrics.contractTtl.remove({ ...labels, entry: "instance" });
          this.metrics.contractTtl.remove({ ...labels, entry: "code" });
          return { alias: watched.alias, id: watched.contract, missing: true };
        }
        const instanceTtlLedgers = ttl.instanceLiveUntil - reading.latestLedger;
        const codeTtlLedgers =
          ttl.codeLiveUntil === undefined ? undefined : ttl.codeLiveUntil - reading.latestLedger;
        this.metrics.contractTtl.set({ ...labels, entry: "instance" }, instanceTtlLedgers);
        if (codeTtlLedgers === undefined) this.metrics.contractTtl.remove({ ...labels, entry: "code" });
        else this.metrics.contractTtl.set({ ...labels, entry: "code" }, codeTtlLedgers);
        return {
          alias: watched.alias,
          id: watched.contract,
          kind: ttl.kind,
          instanceTtlLedgers,
          ...(codeTtlLedgers === undefined ? {} : { codeTtlLedgers }),
        };
      });
      this.last = { checkedAt: new Date(), contracts };
    } catch (error) {
      this.metrics.contractTtlCheckErrors.inc({ network });
      this.log.warn({ err: error, network }, "contract TTL check failed");
      this.last = {
        ...this.last,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    return this.last;
  }
}
