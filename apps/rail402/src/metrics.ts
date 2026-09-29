import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

/** Prometheus metrics exposed at /metrics. Label values are bounded: networks, routes and reason codes. */
export class Metrics {
  readonly registry = new Registry();

  readonly verifications = new Counter({
    name: "rail402_verifications_total",
    help: "Payment verifications by network and outcome; reason is the invalidReason code when invalid.",
    labelNames: ["network", "outcome", "reason"] as const,
    registers: [this.registry],
  });

  readonly settlements = new Counter({
    name: "rail402_settlements_total",
    help: "Settlement requests by network and outcome (success, failure, pending); reason is the errorReason code.",
    labelNames: ["network", "outcome", "reason"] as const,
    registers: [this.registry],
  });

  readonly requestDuration = new Histogram({
    name: "rail402_http_request_duration_seconds",
    help: "HTTP request duration by route and status.",
    labelNames: ["method", "route", "status"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [this.registry],
  });

  readonly sponsorBalance = new Gauge({
    name: "rail402_sponsor_balance_stroops",
    help: "Native XLM balance of each network's fee sponsor, in stroops.",
    labelNames: ["network"] as const,
    registers: [this.registry],
  });

  readonly channelsInUse = new Gauge({
    name: "rail402_channels_in_use",
    help: "Channel accounts currently leased by a settlement.",
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
    help: "Pending settlements brought to a final state by the reconciler.",
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
    help: "Bazaar cataloging outcomes reported in EXTENSION-RESPONSES, by phase, status and code.",
    labelNames: ["phase", "status", "code"] as const,
    registers: [this.registry],
  });

  readonly rateLimited = new Counter({
    name: "rail402_rate_limited_total",
    help: "Requests refused by the rate limiter.",
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: "rail402_process_" });
  }
}
