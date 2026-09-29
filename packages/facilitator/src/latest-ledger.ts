import type { rpc } from "@stellar/stellar-sdk";
import { silentLogger, type Logger } from "./logger.ts";

/** A reading this young is used without refreshing it. */
export const LEDGER_FRESH_MS = 1_000;

/**
 * The network's latest ledger, read from the RPC's health endpoint. A reading younger than
 * LEDGER_FRESH_MS is used as is; an older one is refreshed in the background and still answered with
 * while it is younger than the caller's `maxAgeMs`, so requests rarely wait on the RPC. Past
 * `maxAgeMs` the caller waits for the network. Concurrent callers share one reading.
 */
export class LatestLedger {
  private readonly server: Pick<rpc.Server, "getHealth">;
  private readonly log: Logger;
  private cached: { readonly sequence: number; readonly at: number } | undefined;
  private reading: Promise<number> | undefined;

  constructor(server: Pick<rpc.Server, "getHealth">, log: Logger = silentLogger) {
    this.server = server;
    this.log = log;
  }

  async read(maxAgeMs: number): Promise<number> {
    const cached = this.cached;
    const age = cached === undefined ? Infinity : Date.now() - cached.at;
    if (cached !== undefined && age < LEDGER_FRESH_MS) return cached.sequence;
    this.reading ??= this.server
      .getHealth()
      .then((health) => {
        this.cached = { sequence: health.latestLedger, at: Date.now() };
        return health.latestLedger;
      })
      .finally(() => {
        this.reading = undefined;
      });
    if (cached !== undefined && age < maxAgeMs) {
      // The background reading must never surface as an unhandled rejection.
      this.reading.catch((error: unknown) => {
        this.log.warn({ err: error }, "latest ledger refresh failed");
      });
      return cached.sequence;
    }
    return this.reading;
  }
}
