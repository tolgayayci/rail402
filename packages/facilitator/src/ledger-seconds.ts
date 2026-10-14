import type { rpc } from "@stellar/stellar-sdk";
import { NOMINAL_LEDGER_SECONDS } from "@rail402.dev/upto";
import { ledgerCloseSeconds } from "./engine.ts";
import { silentLogger, type Logger } from "./logger.ts";

/** How long an estimate is reused before the RPC is asked again. */
export const LEDGER_SECONDS_REFRESH_MS = 60_000;

/** Ledgers the RPC must retain for its window to count as an estimate. */
const MIN_WINDOW_LEDGERS = 20;

/** A transaction hash no transaction has: its lookup answers NOT_FOUND with the RPC's ledger window. */
const PROBE_HASH = "0".repeat(64);

/**
 * Seconds per ledger of a network, from its own RPC: the average close time over the ledgers the RPC
 * retains, which every `getTransaction` answer reports. It is read at most once per refresh interval
 * (concurrent readers share one request), so no payment request, however malformed, sends traffic to
 * a third party, and a network served through a private RPC needs nothing else. When the RPC cannot
 * answer, the last estimate stays in use, or the networks' nominal 5 seconds before the first one.
 */
export class RpcLedgerSeconds {
  private readonly server: Pick<rpc.Server, "getTransaction">;
  private readonly refreshMs: number;
  private readonly log: Logger;
  private cached: { readonly seconds: number; readonly at: number } | undefined;
  private reading: Promise<number> | undefined;

  constructor(
    server: Pick<rpc.Server, "getTransaction">,
    options: { readonly refreshMs?: number; readonly log?: Logger } = {},
  ) {
    this.server = server;
    this.refreshMs = options.refreshMs ?? LEDGER_SECONDS_REFRESH_MS;
    this.log = options.log ?? silentLogger;
  }

  /** The current estimate in seconds; never throws. */
  async seconds(): Promise<number> {
    const cached = this.cached;
    if (cached !== undefined && Date.now() - cached.at < this.refreshMs) return cached.seconds;
    this.reading ??= this.read().finally(() => {
      this.reading = undefined;
    });
    return this.reading;
  }

  private async read(): Promise<number> {
    const fallback = this.cached?.seconds ?? NOMINAL_LEDGER_SECONDS;
    try {
      const window = await this.server.getTransaction(PROBE_HASH);
      const ledgers = window.latestLedger - window.oldestLedger;
      const seconds =
        (ledgerCloseSeconds(window.latestLedgerCloseTime) -
          ledgerCloseSeconds(window.oldestLedgerCloseTime)) /
        ledgers;
      if (!(ledgers >= MIN_WINDOW_LEDGERS) || !Number.isFinite(seconds) || seconds <= 0) {
        this.log.warn({ ledgers }, "the RPC retains too few ledgers to estimate the ledger close time");
        this.cached = { seconds: fallback, at: Date.now() };
        return fallback;
      }
      this.cached = { seconds, at: Date.now() };
      return seconds;
    } catch (error) {
      this.log.warn({ err: error }, "could not estimate the ledger close time from the RPC");
      this.cached = { seconds: fallback, at: Date.now() };
      return fallback;
    }
  }
}
