import {
  type FetchedLedger,
  type HashChain,
  LedgerSourceError,
  verifyLedger,
  type LedgerSource,
  type SourcedLedger,
  type VerifiedLedger,
} from "@rail402.dev/ledger-source";
import { classifyLedger, type ClassifyContext, type LedgerClassification } from "@rail402.dev/x402-index";

/** One ledger read, verified against its own hashes and the chain, and classified. */
export interface IndexedLedger {
  readonly verified: VerifiedLedger;
  readonly classification: LedgerClassification;
  readonly source: "lake" | "rpc";
  readonly uri: string;
}

/**
 * Verifies one ledger on its own (its header, transaction set and results against its hash; it must be
 * the ledger asked for) and classifies it. Used where ledgers are read one by one rather than as a chain:
 * a registry-scope index or rebuild reads only the ledgers discovery selected.
 */
export function indexSingle(sequence: number, sourced: SourcedLedger, ctx: ClassifyContext): IndexedLedger {
  const verified = verifyLedger(sourced.meta);
  if (verified.ledger !== sequence) {
    throw new LedgerSourceError(
      "ledger_mismatch",
      `ledger ${String(sequence)} was asked for, and the source served ledger ${String(verified.ledger)}`,
    );
  }
  return {
    verified,
    classification: classifyLedger(sourced.meta, ctx),
    source: sourced.source,
    uri: sourced.uri,
  };
}

/** A source that can hand a ledger over as raw bytes, decoded only when it is processed. */
export interface FetchingSource extends LedgerSource {
  fetchLedger(sequence: number): Promise<FetchedLedger | undefined>;
}

const fetches = (source: LedgerSource): source is FetchingSource =>
  typeof (source as Partial<FetchingSource>).fetchLedger === "function";

export interface IndexRangeOptions {
  /** Requests in flight (default 8). */
  readonly concurrency?: number;
  /**
   * Raw ledger bytes held at once, fetched and not yet processed. With a source that hands ledgers over
   * undecoded (`fetchLedger`, as the data lake does), no request starts while this much is held, and
   * each ledger is decoded only at its turn, so one decoded ledger is alive at a time. Without it, up to
   * `concurrency` decoded ledgers are held.
   */
  readonly maxBytesInFlight?: number;
  /** Checked before each ledger; an aborted signal stops the read with its reason. */
  readonly signal?: AbortSignal;
}

/**
 * Reads `from`..`to` (inclusive) with up to `concurrency` requests in flight, yielding ledgers in
 * order. Stops early, without error, at the head of the source.
 */
export async function* indexRange(
  source: LedgerSource,
  chain: HashChain,
  from: number,
  to: number,
  ctx: ClassifyContext,
  options: IndexRangeOptions = {},
): AsyncGenerator<IndexedLedger> {
  const concurrency = Math.max(1, options.concurrency ?? 8);
  const budget = options.maxBytesInFlight;
  const raw = budget !== undefined && fetches(source) ? source : undefined;
  const window = new Map<number, Promise<SourcedLedger | FetchedLedger | undefined>>();
  const sizes = new Map<number, number>();
  let held = 0;
  let next = from;
  const fill = () => {
    while (next <= to && window.size < concurrency && (budget === undefined || held < budget)) {
      const sequence = next;
      const promise =
        raw === undefined
          ? source.getLedger(sequence)
          : raw.fetchLedger(sequence).then((fetched) => {
              if (fetched !== undefined && window.has(sequence)) {
                held += fetched.bytes;
                sizes.set(sequence, fetched.bytes);
              }
              return fetched;
            });
      // Read errors surface when the ledger's turn comes; until then, keep them from being unhandled.
      promise.catch(() => undefined);
      window.set(sequence, promise);
      next++;
    }
  };
  try {
    for (let sequence = from; sequence <= to; sequence++) {
      options.signal?.throwIfAborted();
      fill();
      const pending = window.get(sequence);
      const answer = await pending;
      window.delete(sequence);
      held -= sizes.get(sequence) ?? 0;
      sizes.delete(sequence);
      if (answer === undefined) return;
      const sourced = "decode" in answer ? answer.decode() : answer;
      const verified = verifyLedger(sourced.meta);
      chain.append(verified);
      yield {
        verified,
        classification: classifyLedger(sourced.meta, ctx),
        source: sourced.source,
        uri: sourced.uri,
      };
    }
  } finally {
    // Ledgers fetched ahead and not taken are let go.
    window.clear();
    sizes.clear();
  }
}
