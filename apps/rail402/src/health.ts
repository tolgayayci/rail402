import type { CatalogStats } from "@rail402.dev/bazaar";
import type { SettlementState } from "@rail402.dev/facilitator";
import type { Counter, Gauge, Histogram } from "prom-client";
import type { Metrics } from "./metrics.ts";
import type { ContractTtlSnapshot } from "./ttl-monitor.ts";
import type { UptoKeeperSnapshot } from "./upto-keeper.ts";
import { publicReason } from "./public-reason.ts";

/**
 * The `/health` body: a snapshot the background poller builds every 15 seconds, so answering it does
 * no I/O. `/health` answers 200 with it whenever the process is up; `state` says whether the
 * service is doing its job (`healthy`), is running with a problem an operator should look at
 * (`degraded`), or has not finished its first poll (`starting`).
 */
export interface HealthSnapshot {
  readonly status: "ok";
  readonly version: string;
  readonly state: "starting" | "healthy" | "degraded";
  readonly checkedAt: string | null;
  readonly warnings: readonly HealthWarning[];
  readonly networks: Readonly<Record<string, NetworkHealth>>;
  readonly catalog?: CatalogHealth;
  readonly search?: SearchHealth;
}

export type HealthWarningCode =
  | "rpc_unhealthy"
  | "ledger_stale"
  | "sponsor_below_floor"
  | "settlement_ledger_unreadable"
  | "settlements_unresolvable"
  | "contract_missing"
  | "contract_archived"
  | "contract_ttl_critical"
  | "contract_ttl_low"
  | "contract_ttl_unchecked"
  | "catalog_unreadable"
  | "search_index_failed"
  | "search_index_degraded"
  | "upto_authority_missing"
  | "upto_authority_funded"
  | "upto_authority_holds_tokens"
  | "upto_contract_restore_required"
  | "upto_ttl_keeper_failed";

/** A problem found by the last poll. `critical` makes the state `degraded`; `warning` does not. */
export interface HealthWarning {
  readonly code: HealthWarningCode;
  readonly severity: "critical" | "warning";
  readonly message: string;
  readonly network?: string;
  readonly contract?: string;
}

export interface NetworkHealth {
  readonly rpc: {
    readonly ok: boolean;
    readonly latestLedger: number | null;
    readonly ledgerAgeSeconds: number | null;
    readonly transportErrors1h: number;
  };
  readonly sponsor: {
    readonly address: string;
    readonly balanceStroops: string | null;
    readonly committed1hStroops: string | null;
    readonly wasted1hStroops: string;
  };
  readonly channels: {
    readonly total: number;
    readonly inUse: number | null;
    readonly leaseWaitP95Ms: number | null;
    readonly leaseTimeouts1h: number;
  };
  readonly settlements: {
    /** Settlements claimed in the last hour, by the state they are in now; null when the ledger could not be read. */
    readonly last1h: Readonly<Record<"succeeded" | "failed" | "expired" | "pending", number>> | null;
    readonly unfinished: number | null;
    readonly unresolvable: number;
    readonly repeats1h: number;
  };
  readonly sequenceConflicts1h: number;
  readonly contracts: Readonly<
    Record<
      string,
      {
        readonly id: string;
        readonly instanceTtlLedgers: number | null;
        readonly codeTtlLedgers?: number;
      }
    >
  >;
  /** Present when the network serves `upto`. */
  readonly upto?: UptoHealth;
}

/** The `upto` component of a network. Its problems degrade `/health` but never fail `/ready`. */
export interface UptoHealth {
  readonly contract: string;
  readonly authority: {
    readonly address: string;
    /** Null until the first poll read it. */
    readonly present: boolean | null;
    readonly balanceStroops: string | null;
    /** XLM beyond the authority's locked minimum balance; it should be zero. */
    readonly spendableStroops: string | null;
    /** Accepted tokens the authority holds; it should hold none. Null until the first poll read them. */
    readonly tokens:
      readonly { readonly symbol: string; readonly contract: string; readonly balance: string }[] | null;
  };
  readonly keeper: {
    readonly enabled: boolean;
    readonly autoRestore: boolean;
    readonly checkedAt: string | null;
    readonly plan: string | null;
    readonly lastAction: {
      readonly action: string;
      readonly transaction: string;
      readonly at: string;
    } | null;
    readonly error: string | null;
  };
}

export interface CatalogHealth {
  readonly listings: Readonly<Record<"published" | "pending" | "quarantined", number>> | null;
  readonly outboxPending: number | null;
  /** Cataloging outcomes in the last hour, by phase and status. */
  readonly outcomes1h: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

export interface SearchHealth {
  readonly indexRevision: number | null;
  readonly indexAgeSeconds: number | null;
  readonly lastBuild: "ok" | "degraded" | "failed" | null;
  readonly embeddingFailures1h: number;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
}

/** What the poller read for one network. */
export interface NetworkHealthInput {
  readonly network: string;
  readonly rpc: {
    readonly ok: boolean;
    readonly error?: string;
    readonly latestLedger?: number;
    /** Close time of the latest ledger. */
    readonly latestLedgerClosedAt?: Date;
  };
  readonly sponsor: {
    readonly address: string;
    readonly balanceStroops?: bigint;
    /** Below this balance the sponsor is reported as below its floor (the readiness minimum). */
    readonly floorStroops: bigint;
    readonly committed1hStroops?: bigint;
  };
  readonly channels: { readonly total: number; readonly inUse?: number };
  /** Undefined when the settlement ledger could not be read. */
  readonly settlements?: {
    readonly last1h: Readonly<Record<SettlementState, number>>;
    readonly unfinished: number;
  };
  readonly contracts: ContractTtlSnapshot;
  readonly upto?: {
    readonly contract: string;
    readonly authority: {
      readonly address: string;
      readonly present?: boolean;
      readonly balanceStroops?: bigint;
      readonly spendableStroops?: bigint;
      readonly tokens?: readonly {
        readonly symbol: string;
        readonly contract: string;
        readonly balance: bigint;
      }[];
    };
    readonly keeper: UptoKeeperSnapshot;
  };
}

export interface HealthInput {
  readonly networks: readonly NetworkHealthInput[];
  /** Present when the Bazaar is enabled; `stats` is undefined when the catalog could not be read. */
  readonly catalog?: { readonly stats?: CatalogStats };
  readonly search?: {
    readonly indexRevision?: number;
    readonly indexedAt?: Date;
    readonly lastBuild?: "ok" | "degraded" | "failed";
  };
}

export interface HealthOptions {
  readonly version: string;
  /** TTL below which a watched contract is a `warning`. */
  readonly ttlWarnLedgers: number;
  /** TTL below which a watched contract makes the service `degraded`. */
  readonly ttlCriticalLedgers: number;
  /** A latest ledger older than this makes the RPC stale. */
  readonly ledgerStaleSeconds?: number;
  readonly now?: () => number;
}

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const DEFAULT_LEDGER_STALE_SECONDS = 60;

/**
 * Builds the `/health` snapshot from what the poller read and from the service's own counters. The
 * "1h" figures come from per-minute samples of the counters: the increase since the sample taken an
 * hour ago, or since the process started when it is younger than that.
 */
export class HealthMonitor {
  private readonly metrics: Metrics;
  private readonly options: HealthOptions;
  private readonly now: () => number;
  private readonly windows = new CounterWindows();
  private unresolvable = new Map<string, number>();
  private current: HealthSnapshot;

  constructor(metrics: Metrics, options: HealthOptions) {
    this.metrics = metrics;
    this.options = options;
    this.now = options.now ?? Date.now;
    this.current = {
      status: "ok",
      version: options.version,
      state: "starting",
      checkedAt: null,
      warnings: [],
      networks: {},
    };
  }

  /** The last snapshot; never does I/O. */
  snapshot(): HealthSnapshot {
    return this.current;
  }

  /** Samples the counters and builds a new snapshot from `input`. */
  async refresh(input: HealthInput): Promise<HealthSnapshot> {
    const now = this.now();
    await this.sample(input, now);
    const warnings: HealthWarning[] = [];
    const networks: Record<string, NetworkHealth> = {};
    for (const network of input.networks) networks[network.network] = this.network(network, now, warnings);

    let catalog: CatalogHealth | undefined;
    if (input.catalog !== undefined) {
      const stats = input.catalog.stats;
      if (stats === undefined) {
        warnings.push({
          code: "catalog_unreadable",
          severity: "critical",
          message: "The catalog store could not be read.",
        });
      }
      catalog = {
        listings: stats === undefined ? null : { ...stats.listings },
        outboxPending: stats?.queuedSettlements ?? null,
        outcomes1h: this.catalogOutcomes(now),
      };
    }

    let search: SearchHealth | undefined;
    if (input.search !== undefined) {
      const { indexRevision, indexedAt, lastBuild } = input.search;
      if (lastBuild === "failed") {
        warnings.push({
          code: "search_index_failed",
          severity: "critical",
          message: "The last search index build could not read the catalog; searches use the previous index.",
        });
      } else if (lastBuild === "degraded") {
        warnings.push({
          code: "search_index_degraded",
          severity: "warning",
          message: "The search index was built without embeddings; searches are lexical-only and partial.",
        });
      }
      const durations = this.windows.buckets("search", now);
      search = {
        indexRevision: indexRevision ?? null,
        indexAgeSeconds: indexedAt === undefined ? null : seconds(now - indexedAt.getTime()),
        lastBuild: lastBuild ?? null,
        embeddingFailures1h: this.windows.increase("embedding_failures", now),
        p50Ms: milliseconds(bucketQuantile(durations, 0.5)),
        p95Ms: milliseconds(bucketQuantile(durations, 0.95)),
      };
    }

    this.current = {
      status: "ok",
      version: this.options.version,
      state: warnings.some((warning) => warning.severity === "critical") ? "degraded" : "healthy",
      checkedAt: new Date(now).toISOString(),
      warnings,
      networks,
      ...(catalog === undefined ? {} : { catalog }),
      ...(search === undefined ? {} : { search }),
    };
    return this.current;
  }

  private network(input: NetworkHealthInput, now: number, warnings: HealthWarning[]): NetworkHealth {
    const network = input.network;
    const stale = this.options.ledgerStaleSeconds ?? DEFAULT_LEDGER_STALE_SECONDS;
    const ledgerAgeSeconds =
      input.rpc.latestLedgerClosedAt === undefined
        ? null
        : Math.max(0, seconds(now - input.rpc.latestLedgerClosedAt.getTime()));
    if (!input.rpc.ok) {
      warnings.push({
        code: "rpc_unhealthy",
        severity: "critical",
        network,
        message: `The RPC did not answer the last poll: ${input.rpc.error === undefined ? "unhealthy" : publicReason(input.rpc.error)}.`,
      });
    } else if (ledgerAgeSeconds !== null && ledgerAgeSeconds > stale) {
      warnings.push({
        code: "ledger_stale",
        severity: "critical",
        network,
        message: `The RPC's latest ledger closed ${String(ledgerAgeSeconds)} s ago.`,
      });
    }
    const balance = input.sponsor.balanceStroops;
    if (balance !== undefined && balance < input.sponsor.floorStroops) {
      warnings.push({
        code: "sponsor_below_floor",
        severity: "critical",
        network,
        message: `The fee sponsor holds ${String(balance)} stroops, below the minimum of ${String(input.sponsor.floorStroops)}.`,
      });
    }
    if (input.settlements === undefined) {
      warnings.push({
        code: "settlement_ledger_unreadable",
        severity: "critical",
        network,
        message: "The settlement ledger could not be read.",
      });
    }
    const unresolvable = this.unresolvable.get(network) ?? 0;
    if (unresolvable > 0) {
      warnings.push({
        code: "settlements_unresolvable",
        severity: "critical",
        network,
        message: `${String(unresolvable)} settlement(s) cannot be proven included or absent with the RPC's retained history; run \`channels status\` for their hashes.`,
      });
    }

    const contracts: Record<string, NetworkHealth["contracts"][string]> = {};
    if (input.contracts.error !== undefined) {
      warnings.push({
        code: "contract_ttl_unchecked",
        severity: "warning",
        network,
        message: `The last contract TTL check failed: ${publicReason(input.contracts.error)}.`,
      });
    }
    for (const contract of input.contracts.contracts) {
      contracts[contract.alias] = {
        id: contract.id,
        instanceTtlLedgers: contract.instanceTtlLedgers ?? null,
        ...(contract.codeTtlLedgers === undefined ? {} : { codeTtlLedgers: contract.codeTtlLedgers }),
      };
      if (contract.missing === true) {
        warnings.push({
          code: "contract_missing",
          severity: "critical",
          network,
          contract: contract.alias,
          message: `Contract ${contract.alias} (${contract.id}) is not in the live ledger state: it was never deployed, or it is archived and must be restored.`,
        });
        continue;
      }
      const lowest = Math.min(contract.instanceTtlLedgers ?? Infinity, contract.codeTtlLedgers ?? Infinity);
      if (lowest < 0) {
        warnings.push({
          code: "contract_archived",
          severity: "critical",
          network,
          contract: contract.alias,
          message: `Contract ${contract.alias} (${contract.id}) is archived: every payment that calls it fails until it is restored.`,
        });
      } else if (lowest < this.options.ttlCriticalLedgers) {
        warnings.push({
          code: "contract_ttl_critical",
          severity: "critical",
          network,
          contract: contract.alias,
          message: `Contract ${contract.alias} is archived in ${String(lowest)} ledgers unless its TTL is extended.`,
        });
      } else if (lowest < this.options.ttlWarnLedgers) {
        warnings.push({
          code: "contract_ttl_low",
          severity: "warning",
          network,
          contract: contract.alias,
          message: `Contract ${contract.alias} is archived in ${String(lowest)} ledgers unless its TTL is extended.`,
        });
      }
    }

    const upto = input.upto === undefined ? undefined : uptoHealth(input.upto, network, warnings);
    const states = input.settlements?.last1h;
    return {
      rpc: {
        ok: input.rpc.ok,
        latestLedger: input.rpc.latestLedger ?? null,
        ledgerAgeSeconds,
        transportErrors1h: this.windows.increase(`transport|${network}`, now),
      },
      sponsor: {
        address: input.sponsor.address,
        balanceStroops: balance === undefined ? null : String(balance),
        committed1hStroops:
          input.sponsor.committed1hStroops === undefined ? null : String(input.sponsor.committed1hStroops),
        wasted1hStroops: String(this.windows.increase(`wasted|${network}`, now)),
      },
      channels: {
        total: input.channels.total,
        inUse: input.channels.inUse ?? null,
        leaseWaitP95Ms: milliseconds(bucketQuantile(this.windows.buckets(`lease|${network}`, now), 0.95)),
        leaseTimeouts1h: this.windows.increase(`lease_timeouts|${network}`, now),
      },
      settlements: {
        last1h:
          states === undefined
            ? null
            : {
                succeeded: states.succeeded,
                failed: states.failed,
                expired: states.expired,
                pending: states.claimed + states.submitted,
              },
        unfinished: input.settlements?.unfinished ?? null,
        unresolvable,
        repeats1h: this.windows.increase(`repeats|${network}`, now),
      },
      sequenceConflicts1h: this.windows.increase(`conflicts|${network}`, now),
      contracts,
      ...(upto === undefined ? {} : { upto }),
    };
  }

  private catalogOutcomes(now: number): Record<string, Record<string, number>> {
    const outcomes: Record<string, Record<string, number>> = {};
    for (const key of this.windows.keys("catalog|")) {
      const [, phase = "", status = ""] = key.split("|");
      const count = this.windows.increase(key, now);
      if (count === 0) continue;
      (outcomes[phase] ??= {})[status] = count;
    }
    return outcomes;
  }

  private async sample(input: HealthInput, now: number): Promise<void> {
    const m = this.metrics;
    const [
      transport,
      fees,
      timeouts,
      repeats,
      conflicts,
      lease,
      catalog,
      embeddings,
      searches,
      unresolvable,
    ] = await Promise.all([
      values(m.rpcTransportErrors),
      values(m.sponsorFees),
      values(m.channelLeaseTimeouts),
      values(m.settlementRepeats),
      values(m.sequenceConflicts),
      values(m.channelLeaseWait),
      values(m.catalogOutcomes),
      values(m.searchEmbeddingFailures),
      values(m.searchDuration),
      values(m.settlementsUnresolvable),
    ]);
    this.unresolvable = new Map(
      unresolvable.map((entry) => [String(entry.labels["network"]), entry.value] as const),
    );
    for (const { network } of input.networks) {
      const mine = (entry: MetricValue) => entry.labels["network"] === network;
      this.windows.record(`transport|${network}`, now, sum(transport.filter(mine)));
      this.windows.record(
        `wasted|${network}`,
        now,
        sum(fees.filter((entry) => mine(entry) && entry.labels["outcome"] === "wasted")),
      );
      this.windows.record(`lease_timeouts|${network}`, now, sum(timeouts.filter(mine)));
      this.windows.record(`repeats|${network}`, now, sum(repeats.filter(mine)));
      this.windows.record(`conflicts|${network}`, now, sum(conflicts.filter(mine)));
      this.windows.recordBuckets(`lease|${network}`, now, lease.filter(mine));
    }
    const byOutcome = new Map<string, number>();
    for (const entry of catalog) {
      const key = `catalog|${String(entry.labels["phase"])}|${String(entry.labels["status"])}`;
      byOutcome.set(key, (byOutcome.get(key) ?? 0) + entry.value);
    }
    for (const [key, value] of byOutcome) this.windows.record(key, now, value);
    this.windows.record("embedding_failures", now, sum(embeddings));
    this.windows.recordBuckets("search", now, searches);
  }
}

/** The `upto` component and its warnings. The contract's own TTL is reported with the other contracts. */
function uptoHealth(
  input: NonNullable<NetworkHealthInput["upto"]>,
  network: string,
  warnings: HealthWarning[],
): UptoHealth {
  const { authority, keeper } = input;
  if (authority.present === false) {
    warnings.push({
      code: "upto_authority_missing",
      severity: "critical",
      network,
      message: `The upto settlement authority ${authority.address} does not exist; upto payments fail until it is provisioned (\`upto authority provision\`).`,
    });
  } else {
    if (authority.spendableStroops !== undefined && authority.spendableStroops > 0n) {
      warnings.push({
        code: "upto_authority_funded",
        severity: "warning",
        network,
        message: `The upto settlement authority ${authority.address} can spend ${String(authority.spendableStroops)} stroops of XLM beyond its reserve; it should hold nothing it can spend. Move the XLM out.`,
      });
    }
    for (const token of authority.tokens ?? []) {
      warnings.push({
        code: "upto_authority_holds_tokens",
        severity: "warning",
        network,
        contract: token.contract,
        message: `The upto settlement authority ${authority.address} holds ${String(token.balance)} base units of ${token.symbol}; it never receives payments and should hold no tokens. Move them out.`,
      });
    }
  }
  if (keeper.plan === "restore_required") {
    warnings.push({
      code: "upto_contract_restore_required",
      severity: "critical",
      network,
      message:
        "The upto settlement contract is archived and automatic restoration is off; upto payments are refused until an operator restores it (`upto ttl restore`).",
    });
  }
  if (keeper.error !== undefined) {
    warnings.push({
      code: "upto_ttl_keeper_failed",
      severity: "warning",
      network,
      message: `The last upto contract TTL round failed: ${publicReason(keeper.error)}.`,
    });
  }
  return {
    contract: input.contract,
    authority: {
      address: authority.address,
      present: authority.present ?? null,
      balanceStroops: authority.balanceStroops === undefined ? null : String(authority.balanceStroops),
      spendableStroops: authority.spendableStroops === undefined ? null : String(authority.spendableStroops),
      tokens:
        authority.tokens === undefined
          ? null
          : authority.tokens.map((token) => ({
              symbol: token.symbol,
              contract: token.contract,
              balance: String(token.balance),
            })),
    },
    keeper: {
      enabled: keeper.enabled,
      autoRestore: keeper.autoRestore,
      checkedAt: keeper.checkedAt?.toISOString() ?? null,
      plan: keeper.plan ?? null,
      lastAction:
        keeper.lastAction === undefined
          ? null
          : {
              action: keeper.lastAction.action,
              transaction: keeper.lastAction.transaction,
              at: keeper.lastAction.at.toISOString(),
            },
      error: keeper.error === undefined ? null : publicReason(keeper.error),
    },
  };
}

interface MetricValue {
  readonly value: number;
  readonly labels: Readonly<Record<string, string | number | undefined>>;
  readonly metricName?: string;
}

async function values(metric: Counter | Gauge | Histogram): Promise<MetricValue[]> {
  return (await metric.get()).values;
}

function sum(entries: readonly MetricValue[]): number {
  return entries.reduce((total, entry) => total + entry.value, 0);
}

/**
 * Per-minute samples of cumulative values. The increase over the last hour is the latest sample minus
 * the newest sample at least an hour old, or minus zero while the process is younger than an hour
 * (every counter starts at zero with the process).
 */
export class CounterWindows {
  private readonly samples = new Map<string, { at: number; value: number }[]>();

  record(key: string, at: number, value: number): void {
    let series = this.samples.get(key);
    if (series === undefined) this.samples.set(key, (series = []));
    const last = series.at(-1);
    if (last !== undefined && Math.floor(last.at / MINUTE_MS) === Math.floor(at / MINUTE_MS)) {
      series[series.length - 1] = { at, value };
    } else {
      series.push({ at, value });
    }
    // Keep one sample older than an hour as the baseline, nothing older.
    while (series.length > 1 && (series[1]?.at ?? Infinity) <= at - HOUR_MS) series.shift();
  }

  /** Records a histogram's cumulative bucket counts, summed over the given series. */
  recordBuckets(key: string, at: number, entries: readonly MetricValue[]): void {
    const counts = new Map<number, number>();
    for (const entry of entries) {
      if (entry.metricName?.endsWith("_bucket") !== true) continue;
      const le = entry.labels["le"];
      const bound = le === "+Inf" ? Infinity : Number(le);
      counts.set(bound, (counts.get(bound) ?? 0) + entry.value);
    }
    for (const [bound, count] of counts) this.record(`${key}|${String(bound)}`, at, count);
  }

  keys(prefix: string): string[] {
    return [...this.samples.keys()].filter((key) => key.startsWith(prefix));
  }

  increase(key: string, at: number): number {
    const series = this.samples.get(key);
    const latest = series?.at(-1);
    if (series === undefined || latest === undefined) return 0;
    const first = series[0];
    const baseline = first !== undefined && first.at <= at - HOUR_MS ? first.value : 0;
    return Math.max(0, latest.value - baseline);
  }

  /** A histogram's bucket counts over the last hour, as cumulative counts by upper bound. */
  buckets(key: string, at: number): { le: number; count: number }[] {
    return this.keys(`${key}|`)
      .map((bucket) => ({ le: Number(bucket.slice(key.length + 1)), count: this.increase(bucket, at) }))
      .sort((a, b) => a.le - b.le);
  }
}

/**
 * The q-quantile of a histogram given as cumulative bucket counts, interpolating linearly inside the
 * bucket as Prometheus' histogram_quantile does; undefined without observations. A quantile that
 * falls in the +Inf bucket is reported as the largest finite bound.
 */
export function bucketQuantile(
  buckets: readonly { le: number; count: number }[],
  q: number,
): number | undefined {
  const total = buckets.at(-1)?.count ?? 0;
  if (total === 0) return undefined;
  const rank = q * total;
  let lower = 0;
  let below = 0;
  for (const bucket of buckets) {
    if (bucket.count >= rank) {
      if (bucket.le === Infinity) return lower;
      const inside = bucket.count - below;
      return inside === 0 ? bucket.le : lower + ((bucket.le - lower) * (rank - below)) / inside;
    }
    lower = bucket.le;
    below = bucket.count;
  }
  return lower;
}

function seconds(ms: number): number {
  return Math.round(ms / 1_000);
}

function milliseconds(secondsValue: number | undefined): number | null {
  return secondsValue === undefined ? null : Math.round(secondsValue * 1_000 * 10) / 10;
}
