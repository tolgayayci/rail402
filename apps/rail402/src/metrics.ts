import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import type { CatalogObserver } from "@rail402.dev/bazaar";
import { SEQUENCE_CONFLICT_REASONS, type SettlementObserver } from "@rail402.dev/facilitator";
import type { SearchObserver } from "@rail402.dev/search";
import { isStellarNetwork } from "@rail402.dev/stellar";
import { isRail402Code } from "./codes.ts";
import { HOLD_REASONS, type HoldReason } from "./network-state.ts";
import { RESET_REASONS } from "./server.ts";

/** Every limit the sponsor guard refuses for, as `rail402_sponsor_guard_refusals_total` reasons. */
export const SPONSOR_REFUSALS = [
  "reserve",
  "budget",
  "caller_budget",
  "balance_unknown",
  "payer_rate",
  "payto_rate",
  "payer_cooldown",
  "limiter_unavailable",
] as const;
import { DISCOVERY_ROUTES, DISCOVERY_SHED_REASONS } from "./discovery.ts";

/**
 * Prometheus metrics exposed at /metrics. Label values are bounded: networks, schemes, routes, states
 * and registered reason codes.
 */
export class Metrics {
  readonly registry = new Registry();

  /** Per network, how to count leased channels; read by `refreshChannelsInUse`, never by a scrape. */
  private readonly channelReaders = new Map<string, () => Promise<number>>();
  /** The networks whose leased channels are being counted now. */
  private readonly channelsReading = new Set<string>();
  /**
   * Per network, the close time of the latest ledger its RPC reported, and when the process started
   * watching it; read on every scrape (see `readRpcLedgerClose`).
   */
  private readonly ledgerCloseReaders = new Map<
    string,
    { readonly since: number; readonly read: () => Date | undefined }
  >();

  readonly verifications = new Counter({
    name: "rail402_verifications_total",
    help: "Payment verifications by network, scheme and outcome; reason is the invalidReason code when invalid.",
    labelNames: ["network", "scheme", "outcome", "reason"] as const,
    registers: [this.registry],
  });

  readonly settlements = new Counter({
    name: "rail402_settlements_total",
    help: "Settle responses by network, scheme and outcome (success, failure, pending), repeats excluded; reason is the errorReason code.",
    labelNames: ["network", "scheme", "outcome", "reason"] as const,
    registers: [this.registry],
  });

  readonly settlementRepeats = new Counter({
    name: "rail402_settlement_repeats_total",
    help: "Settle requests answered from an existing settlement instead of starting one.",
    labelNames: ["network", "scheme"] as const,
    registers: [this.registry],
  });

  readonly settlementsFinalized = new Counter({
    name: "rail402_settlements_finalized_total",
    help: "Settlements that reached a final state, once each; reason is the errorReason code.",
    labelNames: ["network", "scheme", "state", "reason", "settled_by"] as const,
    registers: [this.registry],
  });

  readonly settlementsThirdParty = new Counter({
    name: "rail402_settlements_third_party_total",
    help: "Payments another party's transaction landed first with the payer's authorization as signed, answered as settled in that transaction.",
    labelNames: ["network", "scheme"] as const,
    registers: [this.registry],
  });

  readonly settlementDuration = new Histogram({
    name: "rail402_settlement_duration_seconds",
    help: "Time from claiming a settlement to its final state.",
    labelNames: ["network", "scheme", "state"] as const,
    buckets: [0.5, 1, 2, 3, 5, 7.5, 10, 15, 20, 30, 45, 60],
    registers: [this.registry],
  });

  readonly settlementsUnfinished = new Gauge({
    name: "rail402_settlements_unfinished",
    help: "Settlements whose transaction was recorded and is not final yet.",
    labelNames: ["network"] as const,
    registers: [this.registry],
  });

  readonly submissions = new Counter({
    name: "rail402_submissions_total",
    help: "Settlement transaction submissions by the status the network answered.",
    labelNames: ["network", "status"] as const,
    registers: [this.registry],
  });

  readonly sequenceConflicts = new Counter({
    name: "rail402_sequence_conflicts_total",
    help: "Submissions refused for a bad sequence number (bad_seq) or a full queue (try_again_later).",
    labelNames: ["network", "kind"] as const,
    registers: [this.registry],
  });

  readonly sequenceConflictOutcomes = new Counter({
    name: "rail402_sequence_conflict_outcomes_total",
    help: "Settlements whose channel sequence number another transaction took: finished at once (finished_early) or left waiting (declined), by reason; counted once per settlement and replica for each new decision.",
    labelNames: ["network", "outcome", "reason"] as const,
    registers: [this.registry],
  });

  readonly sponsorFees = new Counter({
    name: "rail402_sponsor_fees_stroops_total",
    help: "Fees charged to the sponsor for included settlements: charged (succeeded) or wasted (included and failed, including a payment another transaction landed first).",
    labelNames: ["network", "outcome"] as const,
    registers: [this.registry],
  });

  readonly channelLeaseWait = new Histogram({
    name: "rail402_channel_lease_wait_seconds",
    help: "Time a settlement waited for a channel account lease.",
    labelNames: ["network"] as const,
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [this.registry],
  });

  readonly channelLeaseTimeouts = new Counter({
    name: "rail402_channel_lease_timeouts_total",
    help: "Settlements refused because no channel account freed up in time.",
    labelNames: ["network"] as const,
    registers: [this.registry],
  });

  readonly ledgerReadFailures = new Counter({
    name: "rail402_settlement_ledger_read_failures_total",
    help: "Verifications whose settlement-ledger check was skipped because the ledger could not be read.",
    labelNames: ["network"] as const,
    registers: [this.registry],
  });

  readonly requestDuration = new Histogram({
    name: "rail402_http_request_duration_seconds",
    help: "HTTP request duration by route and status.",
    labelNames: ["method", "route", "status"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [this.registry],
  });

  readonly connectionsReset = new Counter({
    name: "rail402_http_connections_reset_total",
    help: "Connections the server reset, by reason: write_timeout (the client did not take a ready response within RESPONSE_WRITE_TIMEOUT_MS, or during shutdown within its window) or backlog (it pipelined more than MAX_PIPELINED_REQUESTS requests).",
    labelNames: ["reason"] as const,
    registers: [this.registry],
  });

  readonly sponsorBalance = new Gauge({
    name: "rail402_sponsor_balance_stroops",
    help: "Native XLM balance of each network's fee sponsor, in stroops.",
    labelNames: ["network"] as const,
    registers: [this.registry],
  });

  readonly sponsorBalanceFloor = new Gauge({
    name: "rail402_sponsor_balance_floor_stroops",
    help: "Each network's readiness floor for its fee sponsor (<NET>_MIN_SPONSOR_BALANCE_XLM), in stroops.",
    labelNames: ["network"] as const,
    registers: [this.registry],
  });

  readonly channelsInUse: Gauge<"network"> = new Gauge({
    name: "rail402_channels_in_use",
    help: "Channel accounts currently leased by a settlement, read every second in the background.",
    labelNames: ["network"] as const,
    registers: [this.registry],
  });

  readonly channelsTotal = new Gauge({
    name: "rail402_channels_total",
    help: "Channel accounts configured per network.",
    labelNames: ["network"] as const,
    registers: [this.registry],
  });

  readonly settlementsReconciled = new Counter({
    name: "rail402_settlements_reconciled_total",
    help: "Reconciliation attempts of recorded settlements, by outcome: the final state reached, pending, or unresolvable.",
    labelNames: ["network", "outcome"] as const,
    registers: [this.registry],
  });

  readonly settlementsUnresolvable = new Gauge({
    name: "rail402_settlements_unresolvable",
    help: "Recorded settlements past their time bound whose landing can be neither proven nor ruled out (the RPC no longer retains their ledgers, or the payer's authorization was consumed by an unidentified transaction); an operator must resolve them.",
    labelNames: ["network"] as const,
    registers: [this.registry],
  });

  readonly backgroundErrors = new Counter({
    name: "rail402_background_errors_total",
    help: "Failures of background work (reconciliation, balance polling, RPC health).",
    labelNames: ["task"] as const,
    registers: [this.registry],
  });

  readonly catalogOutcomes = new Counter({
    name: "rail402_catalog_outcomes_total",
    help: "Bazaar cataloging outcomes by phase (verify and settle, reported in EXTENSION-RESPONSES; outbox, origin_check and enrich, background work), status and code.",
    labelNames: ["phase", "status", "code"] as const,
    registers: [this.registry],
  });

  readonly catalogListings = new Gauge({
    name: "rail402_catalog_listings",
    help: "Catalog listings by state (pending, published, quarantined).",
    labelNames: ["state"] as const,
    registers: [this.registry],
  });

  readonly catalogOutboxPending = new Gauge({
    name: "rail402_catalog_outbox_pending",
    help: "Settled payments queued for cataloging and not cataloged yet.",
    registers: [this.registry],
  });

  readonly sponsorGuardRefusals = new Counter({
    name: "rail402_sponsor_guard_refusals_total",
    help: "Settlements refused to protect the fee sponsor: below its reserve floor (reserve) or over the hourly fee budget (budget).",
    labelNames: ["network", "reason"] as const,
    registers: [this.registry],
  });

  readonly sponsorFeesCommitted = new Gauge({
    name: "rail402_sponsor_fees_committed_stroops",
    help: "Upper bound of the fees committed in the last hour: the maximum fees of the settlement envelopes recorded, across replicas.",
    labelNames: ["network"] as const,
    registers: [this.registry],
  });

  readonly rpcActive = new Gauge({
    name: "rail402_rpc_active",
    help: "1 for the network's active RPC provider (by alias), 0 for the others.",
    labelNames: ["network", "provider"] as const,
    registers: [this.registry],
  });

  readonly rpcFailovers = new Counter({
    name: "rail402_rpc_failovers_total",
    help: "Switches of a network's active RPC provider, from one alias to another.",
    labelNames: ["network", "from", "to"] as const,
    registers: [this.registry],
  });

  readonly rpcRequests = new Counter({
    name: "rail402_rpc_requests_total",
    help: "Stellar RPC calls made by Rail402, by provider alias, method and outcome (ok, rpc_error, http_error, timeout, network_error).",
    labelNames: ["network", "provider", "method", "outcome"] as const,
    registers: [this.registry],
  });

  readonly rpcDuration = new Histogram({
    name: "rail402_rpc_request_duration_seconds",
    help: "Duration of Stellar RPC calls made by Rail402, by method.",
    labelNames: ["network", "method"] as const,
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [this.registry],
  });

  readonly rpcTransportErrors = new Counter({
    name: "rail402_rpc_transport_errors_total",
    help: "Failed HTTP exchanges with the configured Stellar RPC (rpc) or the public Horizon upstream reads ledger times from (horizon), from any client in the process: network errors, HTTP 5xx and HTTP 429.",
    labelNames: ["network", "target", "kind"] as const,
    registers: [this.registry],
  });

  readonly rpcLatestLedger = new Gauge({
    name: "rail402_rpc_latest_ledger",
    help: "Latest ledger the network's RPC reported at the last poll.",
    labelNames: ["network"] as const,
    registers: [this.registry],
  });

  readonly rpcLedgerAge: Gauge<"network"> = new Gauge({
    name: "rail402_rpc_ledger_age_seconds",
    help: "Seconds between the close time of the latest ledger the network's RPC reported and the scrape; while no ledger was read yet, since the process started watching the network.",
    labelNames: ["network"] as const,
    registers: [this.registry],
    collect: () => {
      // Computed at the scrape, so a poll that keeps failing, or never succeeded, makes the age grow
      // instead of freezing at its last value or never appearing.
      for (const [network, { since, read }] of this.ledgerCloseReaders) {
        const closedAt = read()?.getTime() ?? since;
        this.rpcLedgerAge.set({ network }, Math.max(0, (Date.now() - closedAt) / 1_000));
      }
    },
  });

  readonly contractTtl = new Gauge({
    name: "rail402_contract_ttl_ledgers",
    help: "Ledgers until a watched contract's instance or code entry is archived; negative when it already is.",
    labelNames: ["network", "contract", "entry"] as const,
    registers: [this.registry],
  });

  readonly contractTtlCheckErrors = new Counter({
    name: "rail402_contract_ttl_check_errors_total",
    help: "Contract TTL checks that could not read the ledger.",
    labelNames: ["network"] as const,
    registers: [this.registry],
  });

  readonly uptoSettlements = new Counter({
    name: "rail402_upto_settlements_total",
    help: "Successful upto settlements, repeats excluded, by the amount settled against the cap (zero, partial, max) and whether a transaction carried it (onchain) or the authorization was consumed without one (offchain).",
    labelNames: ["network", "amount", "mode"] as const,
    registers: [this.registry],
  });

  readonly uptoRestoreHoldPending = new Gauge({
    name: "rail402_upto_restore_hold_pending",
    help: "1 while upto is held after a database restore and no ledger to count the hold from could be recorded yet (every upto request is refused until one is); 0 otherwise.",
    labelNames: ["network"] as const,
    registers: [this.registry],
  });

  readonly uptoAuthorityBalance = new Gauge({
    name: "rail402_upto_authority_balance_stroops",
    help: "Native balance of the upto settlement authority, in stroops; it holds nothing (its reserve is sponsored), so anything above zero needs an operator.",
    labelNames: ["network"] as const,
    registers: [this.registry],
  });

  readonly uptoTtlKeeperActions = new Counter({
    name: "rail402_upto_ttl_keeper_actions_total",
    help: "Extensions and restorations of the upto settlement contract by the TTL keeper or an operator command, by outcome.",
    labelNames: ["network", "action", "outcome"] as const,
    registers: [this.registry],
  });

  readonly searchIndexBuilds = new Counter({
    name: "rail402_search_index_builds_total",
    help: "Search index builds: ok, degraded (embeddings failed; lexical-only) or failed (catalog unreadable).",
    labelNames: ["outcome"] as const,
    registers: [this.registry],
  });

  readonly searchEmbeddingFailures = new Counter({
    name: "rail402_search_embedding_failures_total",
    help: "Embeddings that failed or ran out of time, for a listing (document) or a query (query).",
    labelNames: ["stage"] as const,
    registers: [this.registry],
  });

  readonly searchIndexAge = new Gauge({
    name: "rail402_search_index_age_seconds",
    help: "Seconds since the search index was last confirmed current with the catalog.",
    registers: [this.registry],
  });

  readonly searchDuration = new Histogram({
    name: "rail402_search_duration_seconds",
    help: "Time to answer a search, by method (hybrid, lexical, filter) and whether the results were partial.",
    labelNames: ["method", "partial"] as const,
    buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [this.registry],
  });

  readonly inclusionFeeBid = new Gauge({
    name: "rail402_inclusion_fee_bid_stroops",
    help: "The inclusion-fee bid of the last fee-stats reading, in stroops.",
    labelNames: ["network"] as const,
    registers: [this.registry],
  });

  readonly inclusionFeePinned = new Counter({
    name: "rail402_inclusion_fee_pinned_total",
    help: "Fee-stats readings whose bid did not follow the network: cause cap (the network asked for more than the cap) or stats_unavailable (the floor was bid blind).",
    labelNames: ["network", "cause"] as const,
    registers: [this.registry],
  });

  readonly networkServing = new Gauge({
    name: "rail402_network_serving",
    help: "1 while the network serves /verify and /settle, 0 while it is starting or held.",
    labelNames: ["network"] as const,
    registers: [this.registry],
  });

  readonly networkHold = new Gauge({
    name: "rail402_network_hold",
    help: "1 for the reason a network is held, 0 for the other reasons.",
    labelNames: ["network", "reason"] as const,
    registers: [this.registry],
  });
  // --- discovery settings (DISCOVERY) ---
  readonly searchQueryEmbeddings = new Counter({
    name: "rail402_search_query_embeddings_total",
    help: "How searches got their query embedding: cached, computed, saturated (embedder at its cap; lexical-only), failed or none.",
    labelNames: ["outcome"] as const,
    registers: [this.registry],
  });

  readonly searchSnapshots = new Gauge({
    name: "rail402_search_snapshots",
    help: "Search index snapshots kept: the latest and those a valid cursor still uses.",
    registers: [this.registry],
  });

  readonly searchSnapshotBytes = new Gauge({
    name: "rail402_search_snapshot_bytes",
    help: "Estimated memory held by the kept search index snapshots, in bytes.",
    registers: [this.registry],
  });

  readonly searchLeftOut = new Gauge({
    name: "rail402_search_listings_left_out",
    help: "Published listings the latest search snapshot left out because their network's share of the index was full, by network.",
    labelNames: ["network"] as const,
    registers: [this.registry],
  });

  readonly discoveryRateLimited = new Counter({
    name: "rail402_discovery_rate_limited_total",
    help: "Discovery requests refused by a per-client limit, by route: the cost limit, or the share of a lane one client may hold at once.",
    labelNames: ["route"] as const,
    registers: [this.registry],
  });

  readonly discoveryShed = new Counter({
    name: "rail402_discovery_shed_total",
    help: "Discovery requests refused with 503 under load, by route and reason: admission (every slot and queue place taken, or the queue wait ran out), database_busy (no discovery pool connection within its acquire timeout, or a read cut by its statement timeout), database_unavailable.",
    labelNames: ["route", "reason"] as const,
    registers: [this.registry],
  });

  readonly discoveryInFlight = new Gauge({
    name: "rail402_discovery_in_flight",
    help: "Discovery requests being served now, each until its response has been handed to its client's connection (at most DISCOVERY_MAX_IN_FLIGHT per lane).",
    registers: [this.registry],
  });

  readonly discoveryQueued = new Gauge({
    name: "rail402_discovery_queued",
    help: "Discovery requests waiting for a turn now (at most DISCOVERY_QUEUE_LENGTH).",
    registers: [this.registry],
  });
  // --- end discovery settings ---

  readonly keySignups = new Counter({
    name: "rail402_key_signups_total",
    help: "Access-key sign-ups through GitHub by outcome: issued, or the error code that refused it.",
    labelNames: ["outcome"] as const,
    registers: [this.registry],
  });

  readonly rateLimited = new Counter({
    name: "rail402_rate_limited_total",
    help: "Requests refused by a rate limit: scope ip (per client address, every route), key (an access key's own bucket on /verify and /settle), network (per key or address on one network) or discovery (an internal discovery identity or its forwarded client).",
    labelNames: ["scope"] as const,
    registers: [this.registry],
  });

  readonly rateLimiterFailures = new Counter({
    name: "rail402_rate_limiter_failures_total",
    help: "Requests the shared rate limiter could not answer, by scope; pubnet requests are refused then.",
    labelNames: ["scope"] as const,
    registers: [this.registry],
  });

  readonly accessRequests = new Counter({
    name: "rail402_access_requests_total",
    help: "/verify and /settle requests by network, access key id (public, invalid, or the key's id) and outcome.",
    labelNames: ["network", "key_id", "outcome"] as const,
    registers: [this.registry],
  });

  readonly sponsorBudgetUsed = new Gauge({
    name: "rail402_sponsor_budget_used_ratio",
    help: "Fees committed in the last hour as a share of the network's hourly fee budget (1 = spent).",
    labelNames: ["network"] as const,
    registers: [this.registry],
  });

  readonly accessSponsorCommitted = new Gauge({
    name: "rail402_access_sponsor_committed_stroops",
    help: "Fees an access key's settlements committed in the last hour, per network.",
    labelNames: ["network", "key_id"] as const,
    registers: [this.registry],
  });

  readonly accessKeys = new Gauge({
    name: "rail402_access_keys",
    help: "Access keys per network and state (active, expired, revoked).",
    labelNames: ["network", "state"] as const,
    registers: [this.registry],
  });

  readonly accessKeysReloadFailures = new Counter({
    name: "rail402_access_keys_reload_failures_total",
    help: "Changes to the access-key file that failed validation; the previous keys stay in force.",
    registers: [this.registry],
  });

  /** Counts a network's leased channels with `read` at every `refreshChannelsInUse`. */
  readChannelsInUse(network: string, read: () => Promise<number>): void {
    this.channelReaders.set(network, read);
  }

  /**
   * Counts every network's leased channels into `rail402_channels_in_use`, one count per network at a
   * time: a network still being counted is skipped. The runtime calls it on a timer. `/metrics` is
   * public, so a scrape only reads what this left and never takes a database connection, least of all
   * one of the pools settlements use. A failing count keeps the last value.
   */
  async refreshChannelsInUse(): Promise<void> {
    await Promise.all(
      [...this.channelReaders].map(async ([network, read]) => {
        if (this.channelsReading.has(network)) return;
        this.channelsReading.add(network);
        try {
          this.channelsInUse.set({ network }, await read());
        } catch {
          // Keep the last value; the network poll reports a store that cannot be read.
        } finally {
          this.channelsReading.delete(network);
        }
      }),
    );
  }

  /**
   * Reports `rail402_rpc_ledger_age_seconds` for `network` from `read`, the close time of the latest
   * ledger its RPC reported (`undefined` while none was read), measured from `since` until one is.
   */
  readRpcLedgerClose(network: string, read: () => Date | undefined, since = Date.now()): void {
    this.ledgerCloseReaders.set(network, { since, read });
  }

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: "rail402_process_" });
    // Signals with a known label set are exported at zero from the start, so a scrape shows them
    // (and a rate over them is defined) before the first event.
    for (const outcome of ["ok", "degraded", "failed"]) this.searchIndexBuilds.inc({ outcome }, 0);
    for (const stage of ["document", "query"]) this.searchEmbeddingFailures.inc({ stage }, 0);
    for (const scope of ["ip", "key", "network", "discovery"]) {
      this.rateLimited.inc({ scope }, 0);
      this.rateLimiterFailures.inc({ scope }, 0);
    }
    this.accessKeysReloadFailures.inc(0);
    for (const reason of RESET_REASONS) this.connectionsReset.inc({ reason }, 0);
    for (const method of ["hybrid", "lexical", "filter"]) {
      for (const partial of ["false", "true"]) this.searchDuration.zero({ method, partial });
    }
    // --- discovery settings (DISCOVERY) ---
    for (const outcome of ["cached", "computed", "saturated", "failed", "none"]) {
      this.searchQueryEmbeddings.inc({ outcome }, 0);
    }
    for (const route of DISCOVERY_ROUTES) {
      this.discoveryRateLimited.inc({ route }, 0);
      for (const reason of DISCOVERY_SHED_REASONS) this.discoveryShed.inc({ route, reason }, 0);
    }
    for (const network of ["stellar:testnet", "stellar:pubnet"]) this.searchLeftOut.set({ network }, 0);
    // --- end discovery settings ---
  }

  /** Records whether a network serves and, while it is held, why. */
  recordServing(network: string, serving: boolean, reason: HoldReason | null): void {
    this.networkServing.set({ network }, serving ? 1 : 0);
    for (const candidate of HOLD_REASONS)
      this.networkHold.set({ network, reason: candidate }, candidate === reason ? 1 : 0);
  }

  /**
   * Exports a network's counters whose labels are known up front at zero: its settled and verified
   * payments per scheme, and its failure counters. Every one is scraped before it first counts.
   */
  prepareNetwork(network: string, schemes: readonly string[]): void {
    for (const scheme of schemes) {
      this.verifications.inc({ network, scheme, outcome: "valid", reason: "" }, 0);
      this.settlements.inc({ network, scheme, outcome: "success", reason: "" }, 0);
    }
    for (const kind of ["bad_seq", "try_again_later"]) this.sequenceConflicts.inc({ network, kind }, 0);
    for (const [outcome, reasons] of Object.entries(SEQUENCE_CONFLICT_REASONS)) {
      for (const reason of reasons) this.sequenceConflictOutcomes.inc({ network, outcome, reason }, 0);
    }
    for (const reason of SPONSOR_REFUSALS) this.sponsorGuardRefusals.inc({ network, reason }, 0);
    for (const cause of ["cap", "stats_unavailable"]) this.inclusionFeePinned.inc({ network, cause }, 0);
    this.channelLeaseTimeouts.inc({ network }, 0);
    this.ledgerReadFailures.inc({ network }, 0);
    this.contractTtlCheckErrors.inc({ network }, 0);
    this.recordServing(network, false, null);
  }

  /**
   * Exports a network's provider switches at zero for every ordered pair of its RPC providers. A
   * counter series that first appears at 1 has no increase Prometheus can see, so without this the
   * first failover after a start (and the first fail-back) would never raise Rail402RpcFailover.
   */
  prepareRpcProviders(network: string, aliases: readonly string[]): void {
    for (const from of aliases) {
      for (const to of aliases) if (from !== to) this.rpcFailovers.inc({ network, from, to }, 0);
    }
  }
}

/** Feeds the catalog's background outcomes into the service metrics. */
export function metricsCatalogObserver(metrics: Metrics): CatalogObserver {
  return {
    outcome(phase, status, code) {
      metrics.catalogOutcomes.inc({ phase, status, code });
    },
  };
}

/** Feeds search index builds, embedding failures and search timings into the service metrics. */
export function metricsSearchObserver(metrics: Metrics): SearchObserver {
  return {
    indexBuild(outcome) {
      metrics.searchIndexBuilds.inc({ outcome });
    },
    embeddingFailure(stage) {
      metrics.searchEmbeddingFailures.inc({ stage });
    },
    search(method, partial, ms) {
      metrics.searchDuration.observe({ method, partial: String(partial) }, ms / 1_000);
    },
    // --- discovery settings (DISCOVERY) ---
    queryEmbedding(outcome) {
      metrics.searchQueryEmbeddings.inc({ outcome });
    },
    snapshots(count, bytes) {
      metrics.searchSnapshots.set(count);
      metrics.searchSnapshotBytes.set(bytes);
    },
    leftOut(network, count) {
      // Catalog networks are served networks; anything else would only grow the label set.
      if (isStellarNetwork(network)) metrics.searchLeftOut.set({ network }, count);
    },
    // --- end discovery settings ---
  };
}

/** Metric label for a reason code; codes outside the registry share one value, keeping cardinality bounded. */
export function reasonLabel(code: string | undefined): string {
  if (code === undefined || code === "") return "";
  return isRail402Code(code) ? code : "unregistered";
}

/** Feeds the settlement engine's events into the service metrics. */
export function metricsObserver(metrics: Metrics): SettlementObserver {
  return {
    leaseWait(network, ms, acquired) {
      metrics.channelLeaseWait.observe({ network }, ms / 1_000);
      if (!acquired) metrics.channelLeaseTimeouts.inc({ network });
    },
    submission(network, event) {
      metrics.submissions.inc({ network, status: event.status });
      if (event.status === "TRY_AGAIN_LATER")
        metrics.sequenceConflicts.inc({ network, kind: "try_again_later" });
      if (event.status === "ERROR" && event.resultCode?.includes("txBadSeq") === true) {
        metrics.sequenceConflicts.inc({ network, kind: "bad_seq" });
      }
    },
    finalized(event) {
      const { network, scheme, state } = event;
      metrics.settlementsFinalized.inc({
        network,
        scheme,
        state,
        reason: reasonLabel(event.reason),
        settled_by: event.settledBy,
      });
      metrics.settlementDuration.observe({ network, scheme, state }, event.durationMs / 1_000);
      if (event.settledBy === "third_party") metrics.settlementsThirdParty.inc({ network, scheme });
      if (event.feeChargedStroops !== undefined) {
        // Our own failed transaction is wasted even when another one landed the payment.
        const outcome = event.onChainFailure ? "wasted" : state === "succeeded" ? "charged" : undefined;
        if (outcome !== undefined)
          metrics.sponsorFees.inc({ network, outcome }, Number(event.feeChargedStroops));
      }
    },
    reconciled(network, outcome) {
      metrics.settlementsReconciled.inc({ network, outcome });
    },
    unresolvable(network, count) {
      metrics.settlementsUnresolvable.set({ network }, count);
    },
    repeat(network, scheme) {
      metrics.settlementRepeats.inc({ network, scheme });
    },
    ledgerReadFailed(network) {
      metrics.ledgerReadFailures.inc({ network });
    },
    sequenceConflict(network, event) {
      metrics.sequenceConflictOutcomes.inc({ network, outcome: event.outcome, reason: event.reason });
    },
  };
}
