/**
 * An open-loop, constant-arrival-rate load driver. Request i is due at `i / rate` seconds after the
 * start and is sent then, whether or not earlier requests have answered, so a slow service cannot slow
 * the load down. Each latency is measured from when the request was due, not from when it could be
 * sent: queueing in the client counts, and coordinated omission cannot hide a stall in the tail.
 * `runClosedLoop` is the closed-loop counterpart, for a throughput curve over a number of clients.
 */

/** One request to send. */
export interface Planned {
  readonly path: string;
  /** What the request measures, e.g. `warm`, `uncached`, `list`, `probe`. */
  readonly label: string;
}

/** One request's outcome: a line of `requests.ndjson`. */
export interface Sample {
  /** Milliseconds from the run's start to when the request was due. */
  readonly dueMs: number;
  readonly label: string;
  readonly path: string;
  /** HTTP status; 0 when no response arrived (network error, timeout, client saturated). */
  readonly status: number;
  /** From when the request was due to its last response byte. */
  readonly latencyMs: number;
  /** From when it was sent to its last response byte. */
  readonly serviceMs: number;
  readonly method?: string;
  readonly partialResults?: boolean;
  readonly queryEmbedding?: string;
  readonly revision?: number;
  /** Why the request failed; on a settle probe sample, also a settlement answered without success. */
  readonly error?: string;
  /** The settlement transaction of a settle probe sample. */
  readonly transaction?: string;
}

export interface OpenLoopOptions {
  readonly base: string;
  /** Requests per second. */
  readonly rate: number;
  readonly durationMs: number;
  /** The request due at position `index`. */
  readonly next: (index: number) => Planned;
  readonly onSample: (sample: Sample) => void;
  /** Requests in flight at most; a request due beyond it is recorded as `client_saturated`, unsent. */
  readonly maxInFlight?: number;
  readonly timeoutMs?: number;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly now?: () => number;
}

/** Runs the schedule to its end and waits for every request sent; returns how many were sent and refused. */
export async function runOpenLoop(options: OpenLoopOptions): Promise<{ sent: number; saturated: number }> {
  const now = options.now ?? (() => performance.now());
  const send = options.fetch ?? ((url, init) => fetch(url, init));
  const maxInFlight = options.maxInFlight ?? 10_000;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const total = Math.floor((options.rate * options.durationMs) / 1_000);
  const interval = 1_000 / options.rate;
  const start = now();
  const pending = new Set<Promise<void>>();
  let sent = 0;
  let saturated = 0;

  for (let index = 0; index < total; index++) {
    const due = index * interval;
    const wait = start + due - now();
    if (wait > 1) await new Promise((resolve) => setTimeout(resolve, wait));
    const planned = options.next(index);
    if (pending.size >= maxInFlight) {
      saturated++;
      options.onSample({
        dueMs: round(due),
        label: planned.label,
        path: planned.path,
        status: 0,
        latencyMs: 0,
        serviceMs: 0,
        error: "client_saturated",
      });
      continue;
    }
    sent++;
    const request = measure(planned, start + due, start, send, options.base, timeoutMs, now).then(
      (sample) => {
        options.onSample(sample);
      },
    );
    pending.add(request);
    void request.finally(() => pending.delete(request));
  }
  await Promise.all(pending);
  return { sent, saturated };
}

export interface ClosedLoopOptions {
  readonly base: string;
  /** Clients, each sending its next request as soon as its previous one has answered. */
  readonly concurrency: number;
  readonly durationMs: number;
  /** The request at position `index`, across every client in the order they are sent. */
  readonly next: (index: number) => Planned;
  readonly onSample: (sample: Sample) => void;
  readonly timeoutMs?: number;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly now?: () => number;
}

/**
 * A closed loop of `concurrency` clients for `durationMs`: each client sends a request, waits for its
 * answer and sends the next. It measures how much the service completes at a given concurrency and the
 * latency at that throughput; a request's latency is its service time, since nothing waits to be sent.
 * Unlike the open loop it slows down with the service, so use it for a concurrency curve, not to report
 * latency at an arrival rate. Returns how many requests were sent and the completed requests per second.
 */
export async function runClosedLoop(
  options: ClosedLoopOptions,
): Promise<{ sent: number; throughputPerSecond: number }> {
  const now = options.now ?? (() => performance.now());
  const send = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? 30_000;
  const start = now();
  const end = start + options.durationMs;
  let index = 0;
  const client = async (): Promise<void> => {
    while (now() < end) {
      const planned = options.next(index++);
      const sentAt = now();
      options.onSample(await measure(planned, sentAt, start, send, options.base, timeoutMs, now));
    }
  };
  await Promise.all(Array.from({ length: options.concurrency }, () => client()));
  const elapsed = Math.max(now() - start, 1);
  return { sent: index, throughputPerSecond: round((index * 1_000) / elapsed) };
}

async function measure(
  planned: Planned,
  dueAt: number,
  start: number,
  send: (url: string, init: RequestInit) => Promise<Response>,
  base: string,
  timeoutMs: number,
  now: () => number,
): Promise<Sample> {
  const sentAt = now();
  const common = { dueMs: round(dueAt - start), label: planned.label, path: planned.path };
  try {
    const response = await send(`${base}${planned.path}`, { signal: AbortSignal.timeout(timeoutMs) });
    const text = await response.text();
    const done = now();
    return {
      ...common,
      status: response.status,
      latencyMs: round(done - dueAt),
      serviceMs: round(done - sentAt),
      ...searchFields(text),
    };
  } catch (error) {
    const done = now();
    return {
      ...common,
      status: 0,
      latencyMs: round(done - dueAt),
      serviceMs: round(done - sentAt),
      error: error instanceof Error ? error.name : "error",
    };
  }
}

/** What a search response says about how it was answered. */
function searchFields(text: string): Partial<Sample> {
  if (!text.startsWith("{")) return {};
  try {
    const body = JSON.parse(text) as {
      partialResults?: boolean;
      rail402?: { method?: string; queryEmbedding?: string; revision?: number };
    };
    if (body.rail402?.method === undefined) return {};
    return {
      method: body.rail402.method,
      ...(body.partialResults === undefined ? {} : { partialResults: body.partialResults }),
      ...(body.rail402.queryEmbedding === undefined ? {} : { queryEmbedding: body.rail402.queryEmbedding }),
      ...(body.rail402.revision === undefined ? {} : { revision: body.rail402.revision }),
    };
  } catch {
    return {};
  }
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
