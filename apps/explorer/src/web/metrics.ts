import { Counter, Gauge, Histogram, Registry } from "prom-client";

/** The web role's metrics, prefixed `rail402_explorer_web_`. Labels are bounded: route, status, network. */
export class WebMetrics {
  readonly registry = new Registry();
  readonly requests = new Counter({
    name: "rail402_explorer_web_requests_total",
    help: "Requests answered, by route pattern and status.",
    labelNames: ["route", "status"],
    registers: [this.registry],
  });
  readonly seconds = new Histogram({
    name: "rail402_explorer_web_request_seconds",
    help: "Time to answer a request, by route pattern.",
    labelNames: ["route"],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [this.registry],
  });
  readonly rateLimited = new Counter({
    name: "rail402_explorer_web_rate_limited_total",
    help: "Requests refused by the per-client rate limit.",
    registers: [this.registry],
  });
  readonly lookups = new Counter({
    name: "rail402_explorer_web_live_lookups_total",
    help: "Live lookups of hashes not indexed yet, by outcome.",
    labelNames: ["network", "outcome"],
    registers: [this.registry],
  });
  readonly bazaar = new Counter({
    name: "rail402_explorer_web_bazaar_requests_total",
    help: "Calls to the Bazaar's read API, by network, route and outcome (ok, none, error, limited, deadline).",
    labelNames: ["network", "route", "outcome"],
    registers: [this.registry],
  });
  readonly holdings = new Counter({
    name: "rail402_explorer_web_holdings_requests_total",
    help: "Live holdings reads from Lumeus Assets, by network and outcome (ok, none, error, budget).",
    labelNames: ["network", "outcome"],
    registers: [this.registry],
  });
  readonly reportAge = new Gauge({
    name: "rail402_explorer_web_report_age_seconds",
    help: "Seconds since the network's report was computed.",
    labelNames: ["network"],
    registers: [this.registry],
  });
  readonly reportLastLedger = new Gauge({
    name: "rail402_explorer_web_report_last_ledger",
    help: "The last ledger the network's report covers.",
    labelNames: ["network"],
    registers: [this.registry],
  });
  readonly reportFailures = new Counter({
    name: "rail402_explorer_web_report_failures_total",
    help: "Report computations that failed; the previous report stays served.",
    labelNames: ["network"],
    registers: [this.registry],
  });
}
