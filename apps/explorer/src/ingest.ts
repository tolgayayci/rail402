import type { Logger } from "pino";
import { classifyTransaction, type ClassifiedPayment } from "./classify.js";
import type { ExplorerConfig, ExplorerNetworkConfig } from "./config.js";
import type { ExplorerStore } from "./db.js";
import type { Enricher } from "./enrich.js";
import { asIngestError, isOutOfWindowError, rpcCall, type FetchLike } from "./rpc.js";

/**
 * The ingest loop: poll getEvents → fetch envelopes for candidate hashes → classify → enrich →
 * insert. Every step is resumable (the getEvents cursor is persisted after each poll) and every
 * failure is contained — one bad transaction, one down RPC, or one unreachable Bazaar never
 * stops the loop.
 *
 * Known v1 limitation, on purpose: a zero-amount upto settle emits NO events (fixtures/README.md),
 * so event-driven discovery cannot see it. It moves no money; catching it needs per-facilitator
 * account streams, which are deferred.
 */

/** scvSymbol("transfer") as base64 XDR — the topic filter getEvents takes. Verified live: the
 * task-1 capture used exactly this constant and returned transfer events. */
const TRANSFER_TOPIC_B64 = "AAAADwAAAAh0cmFuc2Zlcg==";

/** How far behind the head a fresh (cursor-less) start begins. ~10 minutes of ledgers. */
const BACKSCAN_LEDGERS = 120;

const EVENTS_PAGE_LIMIT = 500;

/** Networks reset (testnet wipes) restart ledger numbering; a head this far BELOW our stored
 * high-water mark cannot be reorg jitter and is treated as a new chain epoch. */
const RESET_TOLERANCE_LEDGERS = 100;

const SEEN_CACHE_MAX = 10_000;

/** Envelope fetches during deep backfill run in a small pool; the live tail stays sequential. */
const BACKFILL_CONCURRENCY = 8;
const BACKFILL_PAGE_DELAY_MS = 250;
/** Once caught up, re-check this slowly so a chain reset (new epoch) restarts the walk. */
const BACKFILL_DONE_RECHECK_MS = 60_000;

/** Run `fn` over `items` with at most `limit` in flight. Rejections surface as per-item nulls. */
async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<(R | null)[]> {
  const results: (R | null)[] = new Array(items.length).fill(null);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index] as T);
      } catch {
        results[index] = null;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

interface GetEventsResult {
  readonly events: readonly unknown[];
  readonly latestLedger: number;
  readonly cursor?: string;
}

export interface NetworkIngestHealth {
  readonly network: string;
  readonly epoch?: string;
  readonly lastLedger?: number;
  readonly lastPollAt?: string;
  readonly lastError?: string;
  readonly consecutiveFailures: number;
  /** Tier-1 deep backfill: "done", "running (cursor at …)", or absent before it starts. */
  readonly backfill?: string;
}

export interface IngestCounters {
  polls: number;
  eventsSeen: number;
  transactionsFetched: number;
  paymentsInserted: number;
  rpcFailures: number;
  backfillPages: number;
}

export interface IngestWorkerOptions {
  readonly store: ExplorerStore;
  readonly config: ExplorerConfig;
  readonly enricher: Enricher;
  readonly logger: Logger;
  readonly fetchImpl?: FetchLike;
  readonly now?: () => Date;
  /** The registry id treated as first-party for the confidence tier. */
  readonly selfFacilitatorId?: string;
}

export class IngestWorker {
  readonly counters: IngestCounters = {
    polls: 0,
    eventsSeen: 0,
    transactionsFetched: 0,
    paymentsInserted: 0,
    rpcFailures: 0,
    backfillPages: 0,
  };

  private readonly store: ExplorerStore;
  private readonly config: ExplorerConfig;
  private readonly enricher: Enricher;
  private readonly logger: Logger;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private readonly selfFacilitatorId: string;
  /** Hashes already fetched+classified this process — most transfer events are NOT x402, and
   * without this every non-payment hash would be re-fetched on every poll. */
  private readonly seenHashes = new Set<string>();
  private readonly health = new Map<string, NetworkIngestHealth>();
  private readonly timers: NodeJS.Timeout[] = [];
  /** One live backfill timer per network — replaced each step so the set never grows (m6). */
  private readonly backfillTimers = new Map<string, NodeJS.Timeout>();
  private readonly polling = new Set<string>();
  /** Stable epoch per network before the first cursor exists — see currentEpoch(). */
  private readonly bootEpoch = new Map<string, string>();
  private stopped = false;

  constructor(options: IngestWorkerOptions) {
    this.store = options.store;
    this.config = options.config;
    this.enricher = options.enricher;
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.selfFacilitatorId = options.selfFacilitatorId ?? "rail402";
  }

  start(): void {
    for (const network of this.config.networks) {
      const tick = (): void => {
        // Never overlap polls for one network; a slow RPC must not stack requests.
        if (this.polling.has(network.network)) return;
        this.polling.add(network.network);
        void this.pollOnce(network)
          .catch(error => {
            this.logger.warn(
              { network: network.network, err: asIngestError(error).payload },
              "ingest poll failed",
            );
          })
          .finally(() => this.polling.delete(network.network));
      };
      tick();
      const timer = setInterval(tick, this.config.pollIntervalMs);
      timer.unref();
      this.timers.push(timer);
      // Deep backfill walks the rest of the retention window behind the tail. Idempotent and
      // resumable, so starting it unconditionally is safe — a completed backfill no-ops.
      this.runBackfill(network);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
    for (const timer of this.backfillTimers.values()) clearTimeout(timer);
    this.timers.length = 0;
    this.backfillTimers.clear();
  }

  healthReport(): NetworkIngestHealth[] {
    return this.config.networks.map(n => {
      const base = this.health.get(n.network) ?? { network: n.network, consecutiveFailures: 0 };
      const backfill = this.store.getBackfill(n.network, this.currentEpoch(n.network));
      return {
        ...base,
        ...(backfill !== undefined
          ? { backfill: backfill.done ? "done" : `running (target ledger ${backfill.targetLedger})` }
          : {}),
      };
    });
  }

  /** One poll for one network. Exposed for tests and the live e2e — start() just schedules it. */
  async pollOnce(network: ExplorerNetworkConfig): Promise<{ inserted: number; events: number }> {
    this.counters.polls += 1;
    const previous = this.health.get(network.network);
    try {
      const result = await this.fetchEvents(network);
      // Resolved AFTER fetchEvents, which may have rotated the epoch on a detected reset; one
      // value threads through rows, cursor and health so a first poll cannot mint two epochs.
      const epoch = this.currentEpoch(network.network);
      const { inserted, failed } = await this.processEvents(network, result, epoch);
      // If any hash in this page could not be fetched, HOLD the cursor so the next poll re-presents
      // it (review M2). Advancing past it would drop that payment permanently. Dedupe makes the
      // re-processing of the already-stored rows free.
      if (!failed) {
        this.store.setCursor({
          network: network.network,
          epoch,
          ...(result.cursor !== undefined ? { cursor: result.cursor } : {}),
          lastLedger: result.latestLedger,
          updatedAt: this.now().toISOString(),
        });
      }
      this.health.set(network.network, {
        network: network.network,
        epoch,
        lastLedger: result.latestLedger,
        lastPollAt: this.now().toISOString(),
        consecutiveFailures: 0,
      });
      return { inserted, events: result.events.length };
    } catch (error) {
      this.counters.rpcFailures += 1;
      this.health.set(network.network, {
        network: network.network,
        ...(previous?.epoch !== undefined ? { epoch: previous.epoch } : {}),
        ...(previous?.lastLedger !== undefined ? { lastLedger: previous.lastLedger } : {}),
        ...(previous?.lastPollAt !== undefined ? { lastPollAt: previous.lastPollAt } : {}),
        lastError: error instanceof Error ? error.message : "unknown error",
        consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
      });
      throw error;
    }
  }

  /**
   * The chain epoch for a network. Once a cursor exists it is authoritative; before then a single
   * stable boot epoch is used per network — NOT a fresh `now()` each call, or the backfill would
   * write its state under one timestamp and health/resume would read another (introduced with the
   * epoch-keyed backfill, review M3).
   */
  currentEpoch(network: string): string {
    const stored = this.store.getCursor(network)?.epoch;
    if (stored !== undefined) return stored;
    let boot = this.bootEpoch.get(network);
    if (boot === undefined) {
      boot = this.now().toISOString();
      this.bootEpoch.set(network, boot);
    }
    return boot;
  }

  private eventFilters(network: ExplorerNetworkConfig): unknown[] {
    if (network.watchedSacs.length === 0) {
      return [{ type: "contract", topics: [[TRANSFER_TOPIC_B64, "**"]] }];
    }
    // getEvents allows 5 filters × 5 contract IDs = 25 watched SACs.
    const filters: unknown[] = [];
    for (let i = 0; i < network.watchedSacs.length && filters.length < 5; i += 5) {
      filters.push({
        type: "contract",
        contractIds: network.watchedSacs.slice(i, i + 5),
        topics: [[TRANSFER_TOPIC_B64, "**"]],
      });
    }
    if (network.watchedSacs.length > 25) {
      this.logger.warn(
        { network: network.network, watched: network.watchedSacs.length },
        "getEvents supports at most 25 contract IDs; extra watchedSacs are NOT watched",
      );
    }
    return filters;
  }

  private async fetchEvents(network: ExplorerNetworkConfig): Promise<GetEventsResult> {
    const state = this.store.getCursor(network.network);
    const filters = this.eventFilters(network);
    const paramsBase = { filters, xdrFormat: "json" };

    if (state?.cursor !== undefined) {
      try {
        const result = await rpcCall(
          network.rpcUrl,
          "getEvents",
          { ...paramsBase, pagination: { cursor: state.cursor, limit: EVENTS_PAGE_LIMIT } },
          this.fetchImpl,
        );
        return this.asEventsResult(result);
      } catch (error) {
        if (!isOutOfWindowError(error)) throw error;
        // Cursor fell out of the retention window (long downtime) — or the chain was reset.
        this.logger.warn(
          { network: network.network },
          "getEvents cursor out of window; re-anchoring at the ledger head",
        );
      }
    }

    const health = (await rpcCall(network.rpcUrl, "getHealth", undefined, this.fetchImpl)) as {
      latestLedger: number;
      oldestLedger: number;
    };
    if (
      state !== undefined &&
      health.latestLedger + RESET_TOLERANCE_LEDGERS < state.lastLedger
    ) {
      // The head moved BACKWARDS past any plausible jitter: a network reset. New epoch — rows
      // from the old chain must never collide with the new one (README decision 3).
      const epoch = this.now().toISOString();
      this.logger.warn(
        { network: network.network, storedLedger: state.lastLedger, head: health.latestLedger, epoch },
        "network reset detected; starting a new epoch",
      );
      this.store.setCursor({
        network: network.network,
        epoch,
        lastLedger: 0,
        updatedAt: this.now().toISOString(),
      });
    }
    const startLedger = Math.max(
      health.oldestLedger,
      health.latestLedger - BACKSCAN_LEDGERS,
    );
    const result = await rpcCall(
      network.rpcUrl,
      "getEvents",
      { ...paramsBase, startLedger, pagination: { limit: EVENTS_PAGE_LIMIT } },
      this.fetchImpl,
    );
    return this.asEventsResult(result);
  }

  private asEventsResult(raw: unknown): GetEventsResult {
    const r = raw as { events?: unknown[]; latestLedger?: number; cursor?: string };
    return {
      events: Array.isArray(r.events) ? r.events : [],
      latestLedger: typeof r.latestLedger === "number" ? r.latestLedger : 0,
      ...(typeof r.cursor === "string" ? { cursor: r.cursor } : {}),
    };
  }

  /**
   * The classification context is rebuilt per batch so registry updates take effect promptly.
   * Public: the Horizon backfill (Tier 2) classifies through the same context.
   *
   * The trusted upto-contract set is `knownUptoContracts` ONLY (config) — NOT registry-learned
   * contracts (review C2). The classifier treats a known contract address as proof of an upto
   * settlement without inspecting an auth entry, so a self-reported `/supported` contract must not
   * enter that set or an attacker could mint fabricated rows via a no-op contract they deployed.
   * Every legitimate deployment shares the one hardcoded `CCMM…` contract, which is configured by
   * default, so this loses no real coverage.
   */
  classifyCtx(network: ExplorerNetworkConfig, epoch: string) {
    return {
      network: network.network,
      epoch,
      signerIndex: this.store.signerIndex(),
      uptoContracts: new Set<string>(this.config.knownUptoContracts),
      selfFacilitatorId: this.selfFacilitatorId,
    };
  }

  /** Fetch one envelope, classify, enrich and insert. Shared by the live tail and the backfill. */
  private async processHash(
    network: ExplorerNetworkConfig,
    txHash: string,
    ctx: ReturnType<IngestWorker["classifyCtx"]>,
  ): Promise<{ inserted: number; failed: boolean }> {
    this.rememberHash(txHash);
    if (this.store.getPaymentByHash(txHash, network.network)) return { inserted: 0, failed: false };
    let transaction: unknown;
    try {
      this.counters.transactionsFetched += 1;
      transaction = await rpcCall(
        network.rpcUrl,
        "getTransaction",
        { hash: txHash, xdrFormat: "json" },
        this.fetchImpl,
      );
    } catch (error) {
      // One unfetchable transaction must not fail the batch: un-remember it so a later pass
      // retries, and signal failure so the caller holds the cursor (review M2).
      this.seenHashes.delete(txHash);
      this.counters.rpcFailures += 1;
      this.logger.warn(
        { txHash, err: error instanceof Error ? error.message : String(error) },
        "getTransaction failed; will retry later",
      );
      return { inserted: 0, failed: true };
    }
    // getTransaction responses omit the hash we asked for — carry it in.
    const withHash =
      typeof transaction === "object" && transaction !== null
        ? { txHash, ...(transaction as Record<string, unknown>) }
        : transaction;
    return {
      inserted: await this.insertClassified(network, classifyTransaction(withHash, ctx)),
      failed: false,
    };
  }

  /** Enrich + insert classified rows. Also used by the Horizon backfill (Tier 2). */
  async insertClassified(
    network: ExplorerNetworkConfig,
    rows: readonly ClassifiedPayment[],
  ): Promise<number> {
    let inserted = 0;
    for (const row of rows) {
      const meta = await this.enricher.lookup(network.network, row.seller);
      const ok = this.store.insertPayment({
        ...row,
        ...(meta?.serviceName !== undefined ? { serviceName: meta.serviceName } : {}),
        ...(meta?.resource !== undefined ? { resource: meta.resource } : {}),
        ingestedAt: this.now().toISOString(),
      });
      if (ok) {
        inserted += 1;
        this.counters.paymentsInserted += 1;
        this.logger.info(
          {
            network: network.network,
            txHash: row.txHash,
            scheme: row.scheme,
            amount: row.amount,
            buyer: row.buyer,
            seller: row.seller,
            confidence: row.confidence,
            closedAt: row.closedAt,
            ...(meta?.serviceName !== undefined ? { serviceName: meta.serviceName } : {}),
          },
          "payment ingested",
        );
      }
    }
    return inserted;
  }

  private candidateHashes(result: GetEventsResult): string[] {
    const seen = new Set<string>();
    for (const raw of result.events) {
      const hash = (raw as { txHash?: string }).txHash;
      if (typeof hash !== "string" || this.seenHashes.has(hash)) continue;
      seen.add(hash);
    }
    return [...seen];
  }

  private async processEvents(
    network: ExplorerNetworkConfig,
    result: GetEventsResult,
    epoch: string,
  ): Promise<{ inserted: number; failed: boolean }> {
    this.counters.eventsSeen += result.events.length;
    const candidates = this.candidateHashes(result);
    const ctx = this.classifyCtx(network, epoch);
    let inserted = 0;
    let failed = false;
    for (const txHash of candidates) {
      const r = await this.processHash(network, txHash, ctx);
      inserted += r.inserted;
      if (r.failed) failed = true;
    }
    return { inserted, failed };
  }

  // ── Tier-1 deep backfill: replay the whole RPC retention window ────────────

  /**
   * One backfill page. Resumable (cursor persisted per page), idempotent (PK dedupe), and
   * bounded: done once the walk reaches the ledger where the live tail first anchored — from
   * there the tail's own cursor has continuous coverage.
   */
  async backfillTick(network: ExplorerNetworkConfig): Promise<{ done: boolean; inserted: number }> {
    // Epoch-keyed (review M3): after a chain reset the epoch changes and getBackfill returns
    // undefined, so the walk restarts for the new chain instead of staying falsely "done".
    const epoch = this.currentEpoch(network.network);
    let state = this.store.getBackfill(network.network, epoch);
    if (state?.done) return { done: true, inserted: 0 };

    const filters = this.eventFilters(network);
    let result: GetEventsResult;
    if (state?.cursor !== undefined) {
      try {
        result = this.asEventsResult(
          await rpcCall(
            network.rpcUrl,
            "getEvents",
            { filters, xdrFormat: "json", pagination: { cursor: state.cursor, limit: EVENTS_PAGE_LIMIT } },
            this.fetchImpl,
          ),
        );
      } catch (error) {
        if (!isOutOfWindowError(error)) throw error;
        // The backfill cursor itself expired (very long downtime): restart the walk — dedupe
        // makes the overlap free.
        state = undefined;
        result = await this.backfillFirstPage(network, filters);
      }
    } else {
      result = await this.backfillFirstPage(network, filters);
    }

    this.counters.backfillPages += 1;
    const targetLedger =
      state?.targetLedger ??
      this.store.getCursor(network.network)?.lastLedger ??
      result.latestLedger;

    // Ledgers the live tail already covers are skipped; the PK would dedupe them anyway.
    const inScope = result.events.filter(raw => {
      const ledger = (raw as { ledger?: number }).ledger;
      return typeof ledger !== "number" || ledger <= targetLedger;
    });
    this.counters.eventsSeen += inScope.length;
    const ctx = this.classifyCtx(network, epoch);
    const candidates = this.candidateHashes({ ...result, events: inScope });
    const results = await mapPool(candidates, BACKFILL_CONCURRENCY, hash =>
      this.processHash(network, hash, ctx),
    );
    const inserted = results.reduce<number>((sum, r) => sum + (r?.inserted ?? 0), 0);

    const maxLedger = result.events.reduce<number>((max, raw) => {
      const ledger = (raw as { ledger?: number }).ledger;
      return typeof ledger === "number" && ledger > max ? ledger : max;
    }, 0);
    const done =
      result.events.length === 0 || maxLedger >= targetLedger || result.cursor === undefined;

    this.store.setBackfill({
      network: network.network,
      epoch,
      ...(result.cursor !== undefined ? { cursor: result.cursor } : {}),
      targetLedger,
      done,
      updatedAt: this.now().toISOString(),
    });
    if (done) {
      this.logger.info(
        { network: network.network, targetLedger, pages: this.counters.backfillPages },
        "deep backfill complete — full RPC retention window ingested",
      );
    }
    return { done, inserted };
  }

  private async backfillFirstPage(
    network: ExplorerNetworkConfig,
    filters: unknown[],
  ): Promise<GetEventsResult> {
    const health = (await rpcCall(network.rpcUrl, "getHealth", undefined, this.fetchImpl)) as {
      latestLedger: number;
      oldestLedger: number;
    };
    this.logger.info(
      { network: network.network, from: health.oldestLedger, head: health.latestLedger },
      "deep backfill starting from the oldest retained ledger",
    );
    return this.asEventsResult(
      await rpcCall(
        network.rpcUrl,
        "getEvents",
        {
          filters,
          xdrFormat: "json",
          startLedger: health.oldestLedger,
          pagination: { limit: EVENTS_PAGE_LIMIT },
        },
        this.fetchImpl,
      ),
    );
  }

  /**
   * Continuous page-after-page driver, kicked off by start(). When a walk finishes it does NOT
   * stop — it re-checks slowly (review M3): after a chain reset the epoch changes and a fresh walk
   * is needed, and re-arming here is the only in-process path to it. A single timer per network is
   * kept (review m6) so the timer set never grows unbounded.
   */
  private runBackfill(network: ExplorerNetworkConfig): void {
    const schedule = (delay: number): void => {
      if (this.stopped) return;
      const timer = setTimeout(step, delay);
      timer.unref();
      this.backfillTimers.set(network.network, timer);
    };
    const step = (): void => {
      if (this.stopped) return;
      void this.backfillTick(network)
        .then(({ done }) => {
          schedule(done ? BACKFILL_DONE_RECHECK_MS : BACKFILL_PAGE_DELAY_MS);
        })
        .catch(error => {
          this.counters.rpcFailures += 1;
          this.logger.warn(
            { network: network.network, err: asIngestError(error).payload.reason },
            "backfill page failed; retrying shortly",
          );
          schedule(5_000);
        });
    };
    step();
  }

  private rememberHash(hash: string): void {
    if (this.seenHashes.size >= SEEN_CACHE_MAX) {
      const oldest = this.seenHashes.values().next().value;
      if (oldest !== undefined) this.seenHashes.delete(oldest);
    }
    this.seenHashes.add(hash);
  }
}
