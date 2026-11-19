import type { Histogram } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { defaultResource, resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";

/**
 * The optional OTLP copy of the HTTP request metrics (`OTLP_METRICS_ENDPOINT`, `OTLP_METRICS_TOKEN`).
 * It records one stable OpenTelemetry metric, `http.server.request.duration`, with the method, the
 * route template, the status code and, for a 5xx answer, `error.type`: never a path, query, header,
 * body, key or client address. The Prometheus metrics at `/metrics` are recorded as before; this is a
 * second copy, pushed every `intervalMs` to `<endpoint>/v1/metrics` with the token as a bearer token.
 */
export interface OtlpMetrics {
  /** One answered request. `route` is the route template, or undefined for an unmatched path. */
  record(method: string, route: string | undefined, status: number, seconds: number): void;
  /** Exports what is still pending and stops; later records are dropped. */
  shutdown(): Promise<void>;
}

/** The request methods recorded by name; any other is `_OTHER`, as the HTTP semantic conventions say. */
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "DELETE", "CONNECT", "OPTIONS", "TRACE", "PATCH"]);

/** Probes and scrapes, which are not API traffic. */
const OPERATIONAL = /^\/(health|ready|metrics)(\/|$)/;

/** The bucket boundaries the HTTP semantic conventions advise for `http.server.request.duration`. */
const BOUNDARIES = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10];

export function startOtlpMetrics(options: {
  readonly endpoint: string;
  readonly token: string;
  readonly version: string;
  /** How often metrics are pushed; the OpenTelemetry default, 60 s, unless given. */
  readonly intervalMs?: number;
}): OtlpMetrics {
  const exporter = new OTLPMetricExporter({
    url: `${options.endpoint}/v1/metrics`,
    headers: { Authorization: `Bearer ${options.token}` },
  });
  const provider = new MeterProvider({
    resource: defaultResource().merge(
      resourceFromAttributes({ "service.name": "rail402", "service.version": options.version }),
    ),
    readers: [
      new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: options.intervalMs ?? 60_000 }),
    ],
  });
  const duration: Histogram = provider.getMeter("rail402").createHistogram("http.server.request.duration", {
    description: "Duration of HTTP server requests.",
    unit: "s",
    advice: { explicitBucketBoundaries: BOUNDARIES },
  });
  return {
    record(method, route, status, seconds) {
      if (route !== undefined && OPERATIONAL.test(route)) return;
      duration.record(seconds, {
        "http.request.method": METHODS.has(method) ? method : "_OTHER",
        "http.response.status_code": status,
        ...(route === undefined ? {} : { "http.route": route }),
        ...(status >= 500 ? { "error.type": String(status) } : {}),
      });
    },
    shutdown: () => provider.shutdown(),
  };
}
