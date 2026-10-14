/**
 * One run's event log. Events are stamped with the run id and the milliseconds since the run started,
 * kept in order, and delivered to subscribers (who first receive everything so far). A run ends once;
 * events that arrive later for its payments (reconciliation proving or releasing a reservation) are
 * still appended, so the log tells the whole story of the run's money.
 */
import type { LabEvent, LabEventBody } from "./events.ts";
import type { RunHandle, RunSummary } from "./types.ts";

export class Run implements RunHandle {
  readonly runId: string;
  /** ISO date-time of the start. */
  readonly startedAt: string;
  readonly done: Promise<RunSummary>;
  readonly #events: LabEvent[] = [];
  readonly #listeners = new Set<(event: LabEvent) => void>();
  readonly #controller = new AbortController();
  readonly #started: number;
  readonly #now: () => number;
  #summary: RunSummary | null = null;
  #resolve: (summary: RunSummary) => void = () => undefined;

  constructor(runId: string, now: () => number = Date.now) {
    this.runId = runId;
    this.#now = now;
    this.#started = now();
    this.startedAt = new Date(this.#started).toISOString();
    this.done = new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  /** Aborted when the page stops the run. */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get events(): readonly LabEvent[] {
    return this.#events;
  }

  get summary(): RunSummary | null {
    return this.#summary;
  }

  get ended(): boolean {
    return this.#summary !== null;
  }

  emit(body: LabEventBody): void {
    const event = { runId: this.runId, at: Math.max(0, this.#now() - this.#started), ...body } as LabEvent;
    this.#events.push(event);
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch {
        // A failing listener never breaks the run.
      }
    }
  }

  /** Ends the run with its `run end` event; later calls are ignored. */
  finish(summary: Omit<RunSummary, "runId">): RunSummary {
    if (this.#summary !== null) return this.#summary;
    const final: RunSummary = { runId: this.runId, ...summary };
    this.#summary = final;
    this.emit({
      kind: "run",
      phase: "end",
      status: final.status,
      ...(final.code === undefined ? {} : { code: final.code }),
      ...(final.reason === undefined ? {} : { reason: final.reason }),
    });
    this.#resolve(final);
    return final;
  }

  subscribe(listener: (event: LabEvent) => void): () => void {
    for (const event of this.#events) listener(event);
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  abort(): void {
    this.#controller.abort(new DOMException("The run was stopped.", "AbortError"));
  }
}
