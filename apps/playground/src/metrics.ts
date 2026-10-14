import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import { egressCodes } from "@rail402.dev/safe-fetch/codes";
import { isPlaygroundCode } from "./shared/codes.ts";

/**
 * Prometheus metrics exposed at /metrics. Labels are bounded: route templates, registered codes and
 * fixed names. Never a host, path, address or header.
 */
export class Metrics {
  readonly registry = new Registry();

  readonly requestDuration = new Histogram({
    name: "rail402_playground_http_request_duration_seconds",
    help: "HTTP request duration by route and status.",
    labelNames: ["method", "route", "status"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 150],
    registers: [this.registry],
  });

  readonly relayRequests = new Counter({
    name: "rail402_playground_relay_requests_total",
    help: "Relay calls by outcome: upstream when the seller answered, else the refusal or failure code; paid when they carried a payment.",
    labelNames: ["outcome", "paid"] as const,
    registers: [this.registry],
  });

  readonly relayUpstreamLatency = new Histogram({
    name: "rail402_playground_relay_upstream_seconds",
    help: "Time from sending a relayed request to the seller's response headers.",
    labelNames: ["paid"] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20, 30, 60, 120],
    registers: [this.registry],
  });

  readonly relayResponseBytes = new Counter({
    name: "rail402_playground_relay_response_bytes_total",
    help: "Decoded seller body bytes passed back through the relay.",
    registers: [this.registry],
  });

  readonly rateLimited = new Counter({
    name: "rail402_playground_rate_limited_total",
    help: "Requests refused by a limit, by the limit's name.",
    labelNames: ["limit"] as const,
    registers: [this.registry],
  });

  readonly proxyRequests = new Counter({
    name: "rail402_playground_proxy_requests_total",
    help: "Bazaar and facilitator proxy requests by target and outcome (hit, fetched, or the failure code).",
    labelNames: ["target", "outcome"] as const,
    registers: [this.registry],
  });

  readonly proxyUpstreamLatency = new Histogram({
    name: "rail402_playground_proxy_upstream_seconds",
    help: "Time the facilitator or Bazaar took to answer a proxied request.",
    labelNames: ["target"] as const,
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });

  readonly labOutcomes = new Counter({
    name: "rail402_playground_lab_outcomes_total",
    help: "Lab seller payment outcomes by route, phase (verify, settle) and code.",
    labelNames: ["route", "phase", "code"] as const,
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: "rail402_playground_process_" });
  }
}

/** A bounded label for a code: Playground and egress codes as themselves, anything else as `other`. */
export function codeLabel(code: string): string {
  if (isPlaygroundCode(code) || Object.hasOwn(egressCodes, code)) return code;
  return "other";
}
