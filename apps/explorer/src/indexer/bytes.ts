import {
  LedgerSourceError,
  type FetchedLedger,
  type RpcRetention,
  type SourcedLedger,
} from "@rail402.dev/ledger-source";

/** The RPC side of a byte source: Lumeus RPC `getLedgers` and its retention window. */
export interface RecentLedgers {
  retention(): Promise<RpcRetention>;
  fetchLedgers(start: number, limit: number): Promise<FetchedLedger[]>;
}

/** The public data lake (or a stand-in): one object per ledger. */
export interface LakeLedgers {
  fetchLedger(sequence: number): Promise<FetchedLedger | undefined>;
}

export interface LedgerBytesOptions {
  /** The public data lake (or a stand-in): every ledger, once published there. */
  readonly lake: LakeLedgers;
  /** RPC `getLedgers`, for ledgers inside its retention; without it every ledger comes from the lake. */
  readonly rpc?: RecentLedgers;
  /** Ledgers kept clear of the retention's oldest edge, which moves while a request is under way (default 120). */
  readonly retentionMarginLedgers?: number;
  /** Most ledgers per `getLedgers` call (default 100). */
  readonly pageLimit?: number;
  /** Lake requests in flight (default 8). */
  readonly concurrency?: number;
  /**
   * Raw ledger bytes held at once, fetched and not yet handed over (default 64 MiB). No request starts
   * while this much is held, and a `getLedgers` page is sized to about half of it from the ledger sizes
   * seen so far.
   */
  readonly maxBytesInFlight?: number;
  readonly onRead?: (source: "lake" | "rpc", count: number) => void;
  /** Called whenever the raw bytes held change, with the new total. */
  readonly onBytesInFlight?: (bytes: number) => void;
}

/** One requested ledger: decoded, or `undefined` where no source holds it yet. */
export interface LedgerRead {
  readonly sequence: number;
  readonly ledger: SourcedLedger | undefined;
}

export const DEFAULT_MAX_BYTES_IN_FLIGHT = 64 * 1024 * 1024;

interface Flow {
  readonly max: number;
  /** Resolves when a new request may start. */
  readonly room: () => Promise<void>;
  readonly deliver: (sequence: number, fetched: FetchedLedger | undefined) => void;
  readonly stopped: () => boolean;
}

/**
 * Fetches the full bytes (envelopes, results and metas) of selected ledgers: runs of ledgers inside the
 * RPC's retention through `getLedgers`, in pages; older ledgers, one object each, from the public data
 * lake. A ledger that drops out of the retention while it is asked for is read from the lake instead.
 * Nothing here is trusted: the caller verifies every ledger before it is classified.
 *
 * Memory stays bounded whatever the number of ledgers asked for: fetched ledgers are held as raw bytes
 * (at most `maxBytesInFlight`, plus the requests under way), and each one is decoded only when the
 * caller takes it, so one decoded ledger is alive at a time.
 */
export class LedgerBytes {
  readonly #options: LedgerBytesOptions;
  /** Raw bytes per ledger of the last `getLedgers` page, to size the next one. */
  #bytesPerLedger: number | undefined;

  constructor(options: LedgerBytesOptions) {
    this.#options = options;
  }

  /**
   * Yields every ledger of `sequences` once, in the order they arrive. Fetching runs ahead of the caller
   * while the bytes held stay under the limit. A source failure is thrown after the ledgers already
   * fetched have been yielded; stopping early (`break`) stops the fetching.
   */
  async *stream(sequences: readonly number[]): AsyncGenerator<LedgerRead> {
    const max = Math.max(1, this.#options.maxBytesInFlight ?? DEFAULT_MAX_BYTES_IN_FLIGHT);
    const ready: { sequence: number; fetched: FetchedLedger | undefined }[] = [];
    let held = 0;
    // Shared with the producer's callbacks.
    const state: { finished: boolean; closed: boolean; failure?: { error: unknown } } = {
      finished: false,
      closed: false,
    };
    let wake: (() => void) | undefined;
    let waiting: (() => void)[] = [];
    const notify = () => {
      const resolve = wake;
      wake = undefined;
      resolve?.();
    };
    const resume = () => {
      const resolvers = waiting;
      waiting = [];
      for (const resolve of resolvers) resolve();
    };
    const release = (bytes: number) => {
      if (bytes === 0) return;
      held -= bytes;
      this.#options.onBytesInFlight?.(held);
      resume();
    };
    const stopped = () => state.closed || state.failure !== undefined;
    const flow: Flow = {
      max,
      room: async () => {
        while (!stopped() && held > 0 && held >= max) {
          await new Promise<void>((resolve) => waiting.push(resolve));
        }
      },
      deliver: (sequence, fetched) => {
        if (state.closed) return;
        if (fetched !== undefined && fetched.bytes > 0) {
          held += fetched.bytes;
          this.#options.onBytesInFlight?.(held);
        }
        ready.push({ sequence, fetched });
        notify();
      },
      stopped,
    };

    void this.#produce(sequences, flow).then(
      () => {
        state.finished = true;
        notify();
      },
      (error: unknown) => {
        state.failure ??= { error };
        state.finished = true;
        resume();
        notify();
      },
    );

    try {
      for (;;) {
        const item = ready.shift();
        if (item !== undefined) {
          let ledger: SourcedLedger | undefined;
          try {
            ledger = item.fetched?.decode();
          } finally {
            release(item.fetched?.bytes ?? 0);
          }
          yield { sequence: item.sequence, ledger };
          continue;
        }
        if (state.finished) {
          if (state.failure !== undefined) throw state.failure.error;
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      state.closed = true;
      // Whatever was fetched and not taken is let go; the requests under way are dropped when they end.
      release(ready.splice(0).reduce((total, item) => total + (item.fetched?.bytes ?? 0), 0));
      resume();
    }
  }

  async #produce(sequences: readonly number[], flow: Flow): Promise<void> {
    const sorted = [...new Set(sequences)].sort((a, b) => a - b);
    let fromLake = sorted;
    const rpc = this.#options.rpc;
    if (rpc !== undefined && sorted.length > 0) {
      const { oldestLedger } = await rpc.retention();
      const floor = oldestLedger + (this.#options.retentionMarginLedgers ?? 120);
      const recent = sorted.filter((sequence) => sequence >= floor);
      fromLake = sorted.filter((sequence) => sequence < floor);
      const missed: number[] = [];
      let index = 0;
      while (index < recent.length) {
        await flow.room();
        if (flow.stopped()) return;
        const run = takeRun(recent, index, this.#pageLimit(flow.max));
        index += run.members.length;
        let ledgers: FetchedLedger[];
        try {
          ledgers = await rpc.fetchLedgers(run.start, run.end - run.start + 1);
        } catch (error) {
          // Only a ledger outside the retention goes to the lake; every other failure is the caller's.
          if (
            error instanceof LedgerSourceError &&
            error.code === "rpc_error" &&
            /retention|oldest/i.test(error.message)
          ) {
            missed.push(...run.members);
            continue;
          }
          throw error;
        }
        if (ledgers.length > 0) {
          const total = ledgers.reduce((sum, ledger) => sum + ledger.bytes, 0);
          this.#bytesPerLedger = Math.max(1, Math.ceil(total / ledgers.length));
        }
        // Only the ledgers asked for are kept; the page's others are let go here.
        const byNumber = new Map(ledgers.map((ledger) => [ledger.sequence, ledger]));
        let read = 0;
        for (const sequence of run.members) {
          const ledger = byNumber.get(sequence);
          if (ledger !== undefined) read++;
          flow.deliver(sequence, ledger);
        }
        this.#options.onRead?.("rpc", read);
      }
      fromLake = [...fromLake, ...missed].sort((a, b) => a - b);
    }
    const lake = this.#options.lake;
    let next = 0;
    const worker = async () => {
      while (!flow.stopped() && next < fromLake.length) {
        await flow.room();
        if (flow.stopped()) return;
        const sequence = fromLake[next++];
        if (sequence === undefined) return;
        const ledger = await lake.fetchLedger(sequence);
        if (ledger !== undefined) this.#options.onRead?.("lake", 1);
        flow.deliver(sequence, ledger);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.#options.concurrency ?? 8, Math.max(1, fromLake.length)) }, worker),
    );
  }

  /** Ledgers for the next `getLedgers` call: the page limit, fewer when ledgers are large. */
  #pageLimit(max: number): number {
    const limit = this.#options.pageLimit ?? 100;
    if (this.#bytesPerLedger === undefined) return limit;
    return Math.max(1, Math.min(limit, Math.floor(max / 2 / this.#bytesPerLedger)));
  }
}

interface Run {
  readonly start: number;
  readonly end: number;
  readonly members: readonly number[];
}

/**
 * The `getLedgers` call that starts at `sorted[index]`: at most `limit` consecutive ledgers. Ledgers a
 * few apart share a call when that costs fewer requests than it adds ledgers (gaps up to 3); farther
 * apart, each run is its own call.
 */
function takeRun(sorted: readonly number[], index: number, limit: number): Run {
  const first = sorted[index];
  if (first === undefined) throw new RangeError("no ledger at this index");
  const members = [first];
  let end = first;
  for (let at = index + 1; at < sorted.length; at++) {
    const sequence = sorted[at] as number;
    if (sequence - end > 4 || sequence - first >= limit) break;
    end = sequence;
    members.push(sequence);
  }
  return { start: first, end, members };
}

/** Groups sorted ledgers into `getLedgers` calls of at most `limit` consecutive ledgers (see `takeRun`). */
export function runs(sorted: readonly number[], limit: number): Run[] {
  const out: Run[] = [];
  for (let index = 0; index < sorted.length;) {
    const run = takeRun(sorted, index, limit);
    out.push(run);
    index += run.members.length;
  }
  return out;
}
