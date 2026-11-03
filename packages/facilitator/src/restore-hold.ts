import { PUBNET } from "@rail402.dev/stellar";
import type { SettlementLedger } from "./ledger.ts";
import { SHORTEST_LEDGER_SECONDS, restoreHoldLedgers } from "./upto-scheme.ts";

/**
 * After a restore, `upto` settlement stays held for `restoreHoldLedgers` ledgers counted from the first
 * one read after it (StellarUptoScheme). That ledger is recorded only here, from a reading that passes
 * checks one wrong reading cannot: a provider that lags, serves another network or lies would otherwise
 * set it too low and void the hold for every replica. A test network that is reset counts its ledgers
 * from the start again; only a reset corroborated here starts the hold again from the new chain, which
 * would otherwise stay held until it passed the old count.
 */

/** A newest ledger closed within this long counts as current; a lagging provider's closed minutes ago. */
export const RESET_FRESH_MS = 60_000;

/** How far in the future a newest ledger's close time may lie, for clocks that differ a little. */
export const CLOCK_SKEW_MS = 5_000;

/** What one reading of one provider saw, for deciding whether the hold starts again. */
export interface RestartReading {
  readonly network: string;
  /** The network's newest ledger, as the provider reported it. */
  readonly latestLedger: number;
  /** When that ledger closed, as the provider reported. */
  readonly closedAt: Date | undefined;
  readonly now: Date;
  /** The ledger the hold counts from. */
  readonly anchor: number;
  /** Ledgers the hold lasts (`restoreHoldLedgers`). */
  readonly holdLedgers: number;
  /** Whether the provider answered `getNetwork` with this network's passphrase. */
  readonly sameNetwork: boolean;
  /** The low ledger an earlier reading saw, if any. */
  readonly seen: number | undefined;
}

export type RestartDecision =
  | { readonly restart: true }
  /** `seen`: the low ledger to compare the next reading with. */
  | { readonly restart: false; readonly seen?: number };

function fresh(closedAt: Date | undefined, now: Date): boolean {
  if (closedAt === undefined) return false;
  const age = now.getTime() - closedAt.getTime();
  return age >= -CLOCK_SKEW_MS && age <= RESET_FRESH_MS;
}

/**
 * The highest ledger the chain can have reached by `now`: a ledger closes at most once a second
 * (`SHORTEST_LEDGER_SECONDS`), so as many may have closed since the reading's newest one as seconds
 * passed. Recording that instead of the reading keeps an older reading from setting the hold too low.
 */
function reachableLedger(latestLedger: number, closedAt: Date, now: Date): number {
  const seconds = Math.max(0, (now.getTime() - closedAt.getTime()) / 1_000);
  return latestLedger + Math.ceil(seconds / SHORTEST_LEDGER_SECONDS);
}

/**
 * Whether the network started over and the hold should count from its new ledgers. Never on pubnet,
 * whose ledgers never count from the start again. Elsewhere only for a reading more than a hold below
 * the recorded ledger, from a provider serving this network, whose newest ledger closed within the last
 * minute, and once a later reading sees the new chain again, still moving on.
 *
 * @param reading - What this reading saw
 * @returns The decision, and the low ledger to remember when it is the first sighting
 */
export function restartDecision(reading: RestartReading): RestartDecision {
  if (reading.network === PUBNET) return { restart: false };
  if (reading.latestLedger + reading.holdLedgers >= reading.anchor) return { restart: false };
  if (!reading.sameNetwork || !fresh(reading.closedAt, reading.now)) return { restart: false };
  if (reading.seen !== undefined && reading.latestLedger >= reading.seen) return { restart: true };
  return { restart: false, seen: reading.latestLedger };
}

export interface RestoreHoldOptions {
  readonly ledger: SettlementLedger;
  readonly network: string;
  /** The network's passphrase, which the provider must answer `getNetwork` with. */
  readonly passphrase: string;
  /** The network's largest accepted `maxTimeoutSeconds`. */
  readonly timeoutMaxSeconds: number;
  /** The newest ledger one provider reported. */
  readonly latestLedger: number;
  /** When that ledger closed, as the same provider reported. */
  readonly closedAt: Date | undefined;
  /** Asks the same provider for its network passphrase; called only when something may be recorded. */
  readonly networkPassphrase: () => Promise<string>;
  /** `seen` from the previous call's result. */
  readonly seen?: number | undefined;
  readonly now?: Date;
}

export interface RestoreHoldRecord {
  /** The ledger was restored and nothing is recorded yet: every `upto` request holds until there is. */
  readonly pending?: true;
  /** The first ledger recorded for the latest restore, by this call. */
  readonly recorded?: number;
  /** The ledger the hold counts from after a corroborated network reset, recorded by this call. */
  readonly restarted?: number;
  /** A low ledger the next call compares its reading with. */
  readonly seen?: number;
}

/**
 * Records where the restore hold counts from, from one provider's reading, and starts it again after a
 * corroborated network reset. Run it from a periodic task (the Rail402 service's network poll does),
 * passing the previous result's `seen`; requests never record anything. The first ledger after a
 * restore is recorded only when the provider serves this network and its newest ledger closed within
 * the last minute (and not in the future), as the ledger the chain can have reached since; until then
 * every request holds (`pending`).
 *
 * @param options - The ledger, the network and one provider's reading
 * @returns What was recorded, and what to pass as `seen` next time
 */
export async function recordRestoreHold(options: RestoreHoldOptions): Promise<RestoreHoldRecord> {
  const { ledger, network, latestLedger } = options;
  if (ledger.rewindAnchor === undefined || ledger.rewindLedger === undefined) return {};
  const anchor = await ledger.rewindAnchor(network);
  if (anchor === undefined) return {};
  const now = options.now ?? new Date();
  if (anchor === null) {
    const { closedAt } = options;
    if (closedAt === undefined || !fresh(closedAt, now)) return { pending: true };
    if ((await options.networkPassphrase()) !== options.passphrase) return { pending: true };
    const recorded = await ledger.rewindLedger(network, reachableLedger(latestLedger, closedAt, now));
    return recorded === undefined ? { pending: true } : { recorded };
  }
  const holdLedgers = restoreHoldLedgers(options.timeoutMaxSeconds);
  // The provider is asked only for a reading far below the hold, which is rare.
  if (network === PUBNET || latestLedger + holdLedgers >= anchor) return {};
  const sameNetwork =
    fresh(options.closedAt, now) && (await options.networkPassphrase()) === options.passphrase;
  const decision = restartDecision({
    network,
    latestLedger,
    closedAt: options.closedAt,
    now,
    anchor,
    holdLedgers,
    sameNetwork,
    seen: options.seen,
  });
  if (!decision.restart || options.closedAt === undefined) {
    return decision.restart || decision.seen === undefined ? {} : { seen: decision.seen };
  }
  const restarted = await ledger.rewindLedger(
    network,
    reachableLedger(latestLedger, options.closedAt, now),
    holdLedgers,
  );
  return restarted === undefined ? {} : { restarted };
}
