import type { FinalState, SettledBy } from "./ledger.ts";
import type { Logger } from "./logger.ts";

/**
 * What one `sendTransaction` answered. `UPSTREAM_ERROR` marks a submission made inside the upstream
 * scheme that failed after its envelope was recorded; the engine's immediate rebroadcast of the same
 * bytes then reports the network's own answer.
 */
export type SubmissionStatus = "PENDING" | "DUPLICATE" | "TRY_AGAIN_LATER" | "ERROR" | "UPSTREAM_ERROR";

export interface SubmissionEvent {
  readonly status: SubmissionStatus;
  /** The transaction result code of an `ERROR`, e.g. `txBadSeq`. */
  readonly resultCode?: string;
  /** `submit`: the first submission of a settlement; `rebroadcast`: the recorded bytes sent again. */
  readonly phase: "submit" | "rebroadcast";
}

export interface FinalizedEvent {
  readonly network: string;
  readonly scheme: string;
  readonly state: FinalState;
  /** The response's `errorReason`, absent on success. */
  readonly reason?: string;
  /** What the fee sponsor was actually charged, when the transaction was included. */
  readonly feeChargedStroops?: bigint;
  /** From the claim to the final state. */
  readonly durationMs: number;
  /** The transaction was included in a ledger and failed there, so its fee was spent for nothing. */
  readonly onChainFailure: boolean;
  readonly settledBy: SettledBy;
}

/** The outcome of one reconciliation attempt of a recorded, unfinished settlement. */
export type ReconcileOutcome = FinalState | "pending" | "unresolvable";

/**
 * Instrumentation seam of the settlement engine. The engine calls it at each step that matters for
 * operations — channel leases, submissions, final states, reconciliation, repeats — and never
 * depends on what the observer does with it. Implementations must be cheap and must not throw; the
 * engine contains any error an observer raises.
 */
export interface SettlementObserver {
  /** A channel lease was granted (`acquired`) or timed out after `ms`. */
  leaseWait(network: string, ms: number, acquired: boolean): void;
  submission(network: string, event: SubmissionEvent): void;
  /** A settlement reached its final state; called once per settlement, by the caller that finished it. */
  finalized(event: FinalizedEvent): void;
  reconciled(network: string, outcome: ReconcileOutcome): void;
  /**
   * After each reconciliation pass: how many recorded settlements are unresolvable, i.e. past their
   * time bound while the RPC no longer retains the ledgers that could prove them included or absent.
   */
  unresolvable(network: string, count: number): void;
  /** A settle request was answered from an existing settlement instead of starting one. */
  repeat(network: string, scheme: string): void;
  /** Verify could not read the settlement ledger and skipped its replay check. */
  ledgerReadFailed(network: string): void;
}

export const silentObserver: SettlementObserver = {
  leaseWait: () => undefined,
  submission: () => undefined,
  finalized: () => undefined,
  reconciled: () => undefined,
  unresolvable: () => undefined,
  repeat: () => undefined,
  ledgerReadFailed: () => undefined,
};

/** Wraps an observer so that nothing it throws can reach the settlement path. */
export function containedObserver(observer: SettlementObserver, log: Logger): SettlementObserver {
  const contain =
    <A extends unknown[]>(name: string, call: (...args: A) => void) =>
    (...args: A): void => {
      try {
        call(...args);
      } catch (error) {
        log.warn({ err: error, hook: name }, "settlement observer failed");
      }
    };
  return {
    leaseWait: contain("leaseWait", (...args) => {
      observer.leaseWait(...args);
    }),
    submission: contain("submission", (...args) => {
      observer.submission(...args);
    }),
    finalized: contain("finalized", (...args) => {
      observer.finalized(...args);
    }),
    reconciled: contain("reconciled", (...args) => {
      observer.reconciled(...args);
    }),
    unresolvable: contain("unresolvable", (...args) => {
      observer.unresolvable(...args);
    }),
    repeat: contain("repeat", (...args) => {
      observer.repeat(...args);
    }),
    ledgerReadFailed: contain("ledgerReadFailed", (...args) => {
      observer.ledgerReadFailed(...args);
    }),
  };
}
