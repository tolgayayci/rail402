import type { RegistrySnapshot } from "@rail402.dev/x402-index";

export type Epoch = RegistrySnapshot["document"]["epochs"][number];

export class EpochError extends Error {
  readonly code: "epoch_unknown" | "epoch_reset";
  constructor(code: "epoch_unknown" | "epoch_reset", message: string) {
    super(message);
    this.name = "EpochError";
    this.code = code;
  }
}

/** How far behind the newest indexed candidate a discovery head must be to count as a reset. */
export const RESET_MARGIN_LEDGERS = 1_000;

/**
 * Whether a discovery answer shows a testnet reset: the discovery source changed its index generation
 * (as it does after a reset) and its newest ledger is more than `RESET_MARGIN_LEDGERS` behind a ledger
 * already indexed. A head a little behind (a lagging replica) or behind without a new generation is not
 * a reset, and pubnet is never reset: there a head behind is alerted, never a stop.
 */
export function isReset(at: {
  readonly network: string;
  readonly generationChanged: boolean;
  readonly head: number;
  readonly newestIndexed: number | null;
}): boolean {
  return (
    at.network === "stellar:testnet" &&
    at.generationChanged &&
    at.newestIndexed !== null &&
    at.head + RESET_MARGIN_LEDGERS < at.newestIndexed
  );
}

/**
 * The registry epoch the indexer works in: the one whose data lake folder is `folder` (the newest
 * epoch when no folder is given), with a matching passphrase. A testnet reset is detected while
 * indexing (`isReset`); the indexer then stops until the new epoch is added to the registry. Ledger
 * numbers repeat across epochs, so rows are always keyed by epoch.
 */
export function detectEpoch(
  registry: RegistrySnapshot,
  at: {
    readonly passphrase: string;
    readonly folder?: string;
  },
): Epoch {
  const epochs = registry.document.epochs;
  const epoch =
    at.folder === undefined ? epochs.at(-1) : epochs.find((entry) => entry.dataLakeFolder === at.folder);
  if (epoch === undefined) {
    throw new EpochError(
      "epoch_unknown",
      `no registry epoch for data lake folder ${at.folder ?? "(newest)"}`,
    );
  }
  if (epoch.passphrase !== at.passphrase) {
    throw new EpochError("epoch_unknown", `epoch ${epoch.id} is for another network passphrase`);
  }
  return epoch;
}
