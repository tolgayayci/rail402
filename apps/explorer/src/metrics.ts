import { Counter, Gauge, Histogram, Registry } from "prom-client";

/**
 * The indexer's metrics, all prefixed `rail402_explorer_`. Labels are bounded: network, source, product,
 * HTTP status, route kind, ledger status and code.
 */
export class ExplorerMetrics {
  readonly registry = new Registry();
  readonly lastLedger = new Gauge({
    name: "rail402_explorer_last_ledger",
    help: "The last ledger discovery has walked through on every route (the report's coverage limit).",
    labelNames: ["network"],
    registers: [this.registry],
  });
  readonly headLedger = new Gauge({
    name: "rail402_explorer_head_ledger",
    help: "The newest ledger the discovery source has published (Lumeus Activity published_through).",
    labelNames: ["network"],
    registers: [this.registry],
  });
  readonly lagLedgers = new Gauge({
    name: "rail402_explorer_lag_ledgers",
    help: "Ledgers between the discovery source's head and the ledger discovery has walked through.",
    labelNames: ["network"],
    registers: [this.registry],
  });
  readonly ledgers = new Counter({
    name: "rail402_explorer_ledgers_indexed_total",
    help: "Candidate ledgers read, verified, classified and committed, by where their bytes came from.",
    labelNames: ["network", "source"],
    registers: [this.registry],
  });
  readonly settlements = new Counter({
    name: "rail402_explorer_settlements_indexed_total",
    help: "Settlement rows written, by scheme and attribution tier.",
    labelNames: ["network", "scheme", "tier"],
    registers: [this.registry],
  });
  readonly failures = new Counter({
    name: "rail402_explorer_failures_total",
    help: "Indexing and discovery failures by code; integrity failures stop the indexer.",
    labelNames: ["network", "code"],
    registers: [this.registry],
  });
  readonly gaps = new Counter({
    name: "rail402_explorer_chain_breaks_total",
    help: "Ledgers whose hash differed from the independent anchor, or that were not the ledger asked for.",
    labelNames: ["network"],
    registers: [this.registry],
  });
  readonly lumeusRequests = new Counter({
    name: "rail402_explorer_lumeus_requests_total",
    help: "Requests to Lumeus by product and HTTP status (0: no answer).",
    labelNames: ["network", "product", "status"],
    registers: [this.registry],
  });
  readonly lumeusErrors = new Counter({
    name: "rail402_explorer_lumeus_errors_total",
    help: "Lumeus requests that failed, by product and Lumeus code.",
    labelNames: ["network", "product", "code"],
    registers: [this.registry],
  });
  readonly discoveryRecords = new Counter({
    name: "rail402_explorer_discovery_records_total",
    help: "Activity records read by discovery, by route kind.",
    labelNames: ["network", "kind"],
    registers: [this.registry],
  });
  readonly candidates = new Counter({
    name: "rail402_explorer_candidates_found_total",
    help: "Candidate ledgers found by discovery windows, by route kind (a ledger found by two routes counts twice).",
    labelNames: ["network", "kind"],
    registers: [this.registry],
  });
  readonly candidatesCapped = new Counter({
    name: "rail402_explorer_candidates_capped_total",
    help: "Route walks stopped for the round because they listed more new candidate ledgers than one round reads.",
    labelNames: ["network", "kind"],
    registers: [this.registry],
  });
  readonly unattributedCandidates = new Counter({
    name: "rail402_explorer_candidates_unattributed_total",
    help: "Candidate ledgers read and verified that held no row a registry facilitator settled.",
    labelNames: ["network"],
    registers: [this.registry],
  });
  readonly discoveryRestarts = new Counter({
    name: "rail402_explorer_discovery_restarts_total",
    help: "Routes walked again from their first ledger because the discovery source's generation or decoder changed.",
    labelNames: ["network", "kind"],
    registers: [this.registry],
  });
  readonly headRegressions = new Counter({
    name: "rail402_explorer_head_regressions_total",
    help: "Rounds in which the discovery source's head was far behind the newest indexed candidate.",
    labelNames: ["network"],
    registers: [this.registry],
  });
  readonly candidateLedgers = new Gauge({
    name: "rail402_explorer_candidate_ledgers",
    help: "Candidate ledgers by status: pending, indexed or failed.",
    labelNames: ["network", "status"],
    registers: [this.registry],
  });
  readonly bytesInFlight = new Gauge({
    name: "rail402_explorer_ledger_bytes_in_flight",
    help: "Raw ledger bytes fetched and not yet decoded (getLedgers metadata and lake objects); bounded by EXPLORER_BYTES_IN_FLIGHT_MIB.",
    labelNames: ["network"],
    registers: [this.registry],
  });
  readonly ledgerSeconds = new Histogram({
    name: "rail402_explorer_ledger_seconds",
    help: "Time to verify, anchor, classify and store one ledger.",
    labelNames: ["network"],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
}
