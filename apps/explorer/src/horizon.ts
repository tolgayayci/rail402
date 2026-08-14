import type { Logger } from "pino";
import { classifyTransaction, type ClassifiedPayment } from "./classify.js";
import type { ClassificationContext } from "./classify.js";
import type { ExplorerConfig, ExplorerNetworkConfig } from "./config.js";
import type { ExplorerStore } from "./db.js";
import type { IngestWorker } from "./ingest.js";
import type { FetchLike } from "./rpc.js";
import { adaptHorizonRecord, type HorizonTxRecord } from "./xdr-adapter.js";

/**
 * Tier-2 backfill: recover known facilitators' history for the WHOLE chain epoch.
 *
 * Horizon-testnet retains the complete current epoch (since the 2025-12-17 reset), and it indexes
 * fee-bump fee sources as transaction participants — so walking one fee account's history returns
 * every payment that facilitator sponsored, including through rotating channel accounts. For each
 * verified registry facilitator we walk every published signer, oldest first, with a persisted
 * per-(network, account) cursor.
 *
 * Records older than the RPC retention window cannot be re-fetched from RPC, so they are decoded
 * from Horizon's `envelope_xdr` (xdr-adapter.ts) and classified through the SAME classifier as
 * live rows; `fee_charged` comes from Horizon itself. This walk keeps running (default every
 * 10 min), which also gives known facilitators a second capture channel — including zero-amount
 * upto settles that emit no events and are invisible to the getEvents tail.
 *
 * Coverage note, stated honestly: this recovers history for KNOWN (registry-verified)
 * facilitators only. Unknown-facilitator traffic older than the RPC window stays invisible —
 * that would need the Parquet lake, which is deliberately parked.
 */

const PAGE_LIMIT = 200;
/** Politeness bound per account per walk; the cursor resumes next walk. */
const MAX_PAGES_PER_WALK = 25;
const FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;

interface HorizonPage {
  _embedded?: { records?: HorizonTxRecord[] };
}

export interface HorizonBackfillOptions {
  readonly store: ExplorerStore;
  readonly config: ExplorerConfig;
  readonly worker: IngestWorker;
  readonly logger: Logger;
  readonly fetchImpl?: FetchLike;
  readonly now?: () => Date;
  readonly intervalMs?: number;
}

export class HorizonBackfill {
  readonly counters = { pages: 0, inserted: 0 };

  private readonly store: ExplorerStore;
  private readonly config: ExplorerConfig;
  private readonly worker: IngestWorker;
  private readonly logger: Logger;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private walking = false;

  constructor(options: HorizonBackfillOptions) {
    this.store = options.store;
    this.config = options.config;
    this.worker = options.worker;
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  start(): void {
    const tick = (): void => {
      if (this.walking) return;
      this.walking = true;
      void this.walkOnce()
        .catch(error => {
          this.logger.warn(
            { err: error instanceof Error ? error.message : String(error) },
            "horizon backfill walk failed; will retry next interval",
          );
        })
        .finally(() => {
          this.walking = false;
        });
    };
    tick();
    this.timer = setInterval(tick, this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass over every verified facilitator signer on every network. Returns rows inserted. */
  async walkOnce(): Promise<number> {
    const facilitators = this.store.listFacilitators().filter(f => f.verified);
    let inserted = 0;
    for (const network of this.config.networks) {
      for (const facilitator of facilitators) {
        for (const signer of facilitator.signers) {
          inserted += await this.walkAccount(network, signer);
        }
      }
    }
    if (inserted > 0) {
      this.logger.info({ inserted }, "horizon backfill recovered payments");
    }
    return inserted;
  }

  private async walkAccount(network: ExplorerNetworkConfig, account: string): Promise<number> {
    let cursor = this.store.getHorizonCursor(network.network, account);
    const ctx = this.worker.classifyCtx(network, this.worker.currentEpoch(network.network));
    let inserted = 0;
    for (let page = 0; page < MAX_PAGES_PER_WALK; page += 1) {
      const url = new URL(
        `/accounts/${account}/transactions`,
        network.horizonUrl.replace(/\/+$/, "") + "/",
      );
      url.searchParams.set("limit", String(PAGE_LIMIT));
      url.searchParams.set("order", "asc");
      url.searchParams.set("include_failed", "false");
      if (cursor !== undefined) url.searchParams.set("cursor", cursor);

      let response: Response;
      try {
        response = await this.fetchImpl(url.toString(), {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
      } catch (error) {
        this.logger.warn(
          { account, err: error instanceof Error ? error.message : String(error) },
          "horizon page fetch failed; cursor keeps our place",
        );
        return inserted;
      }
      // An account Horizon has never seen (fresh signer, no funding yet) is a quiet skip.
      if (response.status === 404) return inserted;
      if (!response.ok) {
        this.logger.warn({ account, status: response.status }, "horizon page refused");
        return inserted;
      }
      let records: HorizonTxRecord[];
      try {
        // A proxy returning 200-with-HTML would throw here — one bad page must not abort the whole
        // walk cycle across every other signer and network (review m4).
        const body = (await response.json()) as HorizonPage;
        records = body._embedded?.records ?? [];
      } catch (error) {
        this.logger.warn(
          { account, err: error instanceof Error ? error.message : String(error) },
          "horizon page body was not JSON; cursor keeps our place",
        );
        return inserted;
      }
      if (records.length === 0) return inserted;

      let pageInserted = 0;
      for (const record of records) {
        if (typeof record.paging_token === "string") cursor = record.paging_token;
        if (typeof record.hash !== "string") continue;
        if (this.store.getPaymentByHash(record.hash, network.network)) continue;
        let rows: ClassifiedPayment[];
        try {
          const adapted = adaptHorizonRecord(record);
          if (!adapted) continue;
          rows = classifyRows(adapted, ctx, record);
        } catch (error) {
          // Any XDR shape the SDK accessors reject skips that record, never the walk (m4).
          this.logger.warn(
            { hash: record.hash, err: error instanceof Error ? error.message : String(error) },
            "horizon record could not be adapted; skipping",
          );
          continue;
        }
        pageInserted += await this.worker.insertClassified(network, rows);
      }
      inserted += pageInserted;
      this.counters.pages += 1;
      this.counters.inserted += pageInserted; // per-page delta, not the running total (m1)
      if (cursor !== undefined) {
        this.store.setHorizonCursor(network.network, account, cursor, this.now().toISOString());
      }
      if (records.length < PAGE_LIMIT) return inserted; // caught up
    }
    return inserted;
  }
}

function classifyRows(
  adapted: Record<string, unknown>,
  ctx: ClassificationContext,
  record: HorizonTxRecord,
): ClassifiedPayment[] {
  // Horizon's fee_charged is the actual post-refund charge; it replaces the fee-event
  // computation live rows use (verified equal on tx feb9bedb…: both 23,086 stroops).
  return classifyTransaction(adapted, ctx).map(row => ({
    ...row,
    ...(record.fee_charged !== undefined ? { feeCharged: String(record.fee_charged) } : {}),
  }));
}
