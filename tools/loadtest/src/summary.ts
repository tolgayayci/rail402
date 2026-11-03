import type { Sample } from "./driver.ts";

/** Latency statistics, in milliseconds. */
export interface LatencyStats {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly mean: number;
  readonly max: number;
}

export interface LabelSummary {
  /** Requests due, sent or not. */
  readonly requests: number;
  /** Requests that did not succeed (an answer other than 200, or a failed settlement), the unsent ones included. */
  readonly errors: number;
  readonly errorRate: number;
  /**
   * Requests the client never sent: due while the driver was at its in-flight cap, or a settlement
   * the probe could not sign. Recorded, in no latency.
   */
  readonly unsent: number;
  /**
   * Latency from when each request was due, over every request sent: a failure counts at the time it
   * took to fail, a timeout at the timeout. This is the figure to report.
   */
  readonly latencyMs: LatencyStats;
  /** The same over the requests that succeeded only. */
  readonly successLatencyMs: LatencyStats;
  /** The same over the requests sent that did not succeed (status 0: no response). */
  readonly errorLatencyMs: LatencyStats;
  /** Search answers by method, by query-embedding outcome, and how many were partial. */
  readonly methods: Readonly<Record<string, number>>;
  readonly queryEmbeddings: Readonly<Record<string, number>>;
  readonly partial: number;
  /** Responses by HTTP status (0: no response). */
  readonly statuses: Readonly<Record<string, number>>;
}

/** Nearest-rank percentile of `values` (0 when empty). */
export function percentile(values: readonly number[], p: number): number {
  return percentileOfSorted(Float64Array.from(values).sort(), p);
}

function percentileOfSorted(sorted: Float64Array, p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1] ?? 0;
}

/** p50, p95, p99, mean and max of `values`, sorting once; safe for any number of values. */
export function latencyStats(values: readonly number[]): LatencyStats {
  const sorted = Float64Array.from(values).sort();
  let sum = 0;
  for (const value of sorted) sum += value;
  return {
    count: sorted.length,
    p50: round(percentileOfSorted(sorted, 50)),
    p95: round(percentileOfSorted(sorted, 95)),
    p99: round(percentileOfSorted(sorted, 99)),
    mean: round(sum / (sorted.length || 1)),
    max: round(sorted.length === 0 ? 0 : (sorted[sorted.length - 1] ?? 0)),
  };
}

/** Summaries of `samples`, by label. */
export function summarize(samples: readonly Sample[]): Record<string, LabelSummary> {
  const byLabel = new Map<string, Sample[]>();
  for (const sample of samples) {
    const list = byLabel.get(sample.label) ?? [];
    list.push(sample);
    byLabel.set(sample.label, list);
  }
  const summaries: Record<string, LabelSummary> = {};
  for (const [label, list] of [...byLabel].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const sent: number[] = [];
    const ok: number[] = [];
    const failed: number[] = [];
    let unsent = 0;
    for (const sample of list) {
      if (sample.error?.startsWith("client_") === true) {
        unsent++;
        continue;
      }
      sent.push(sample.latencyMs);
      (succeeded(sample) ? ok : failed).push(sample.latencyMs);
    }
    const count = (key: (sample: Sample) => string | undefined) => {
      const counts: Record<string, number> = {};
      for (const sample of list) {
        const value = key(sample);
        if (value !== undefined) counts[value] = (counts[value] ?? 0) + 1;
      }
      return counts;
    };
    summaries[label] = {
      requests: list.length,
      errors: list.length - ok.length,
      errorRate: round((list.length - ok.length) / list.length),
      unsent,
      latencyMs: latencyStats(sent),
      successLatencyMs: latencyStats(ok),
      errorLatencyMs: latencyStats(failed),
      methods: count((sample) => sample.method),
      queryEmbeddings: count((sample) => sample.queryEmbedding),
      partial: list.filter((sample) => sample.partialResults === true).length,
      statuses: count((sample) => String(sample.status)),
    };
  }
  return summaries;
}

/** A 200 answer that reports no failure: a settle probe's failed settlement also answers 200. */
function succeeded(sample: Sample): boolean {
  return sample.status === 200 && sample.error === undefined;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
