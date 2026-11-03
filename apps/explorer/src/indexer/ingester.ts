import {
  LedgerSourceError,
  LumeusError,
  type ActivityRoute,
  type AnchorSource,
  type WalkStep,
} from "@rail402.dev/ledger-source";
import {
  RULES_VERSION,
  classificationFingerprint,
  type ClassifyContext,
  type IndexNetwork,
  type RegistrySnapshot,
} from "@rail402.dev/x402-index";
import { EpochError, RESET_MARGIN_LEDGERS, isReset, type Epoch } from "../epoch.ts";
import type { ExplorerMetrics } from "../metrics.ts";
import { indexSingle } from "../pipeline.ts";
import {
  discoveredThrough,
  type CheckedAnchor,
  type ExplorerStore,
  type LedgerVersions,
  type StoredRoute,
} from "../store.ts";
import type { LedgerBytes, LedgerRead } from "./bytes.ts";
import { discoveryPlan, type RouteCadence } from "./discovery.ts";

export interface Logger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

/** Where candidate ledgers come from: Lumeus Activity, or a stand-in in tests. */
export interface ActivitySource {
  walkRange(
    route: ActivityRoute,
    from: number,
    until: number | undefined,
    options: { readonly windowLedgers: number },
  ): AsyncGenerator<WalkStep>;
}

export interface IngesterOptions {
  readonly network: IndexNetwork;
  readonly registry: RegistrySnapshot;
  readonly epoch: Epoch;
  readonly store: ExplorerStore;
  readonly activity: ActivitySource;
  readonly bytes: LedgerBytes;
  /**
   * Independently known ledger hashes (Horizon). When set, every ledger is committed (so served and
   * reported) only after its hash matched; a different hash stops the indexer.
   */
  readonly anchors?: AnchorSource;
  readonly metrics: ExplorerMetrics;
  readonly logger: Logger;
  /** The first ledger of the index (the epoch start, or later). */
  readonly from: number;
  /** A bounded run stops after this ledger; without it the indexer follows the head. */
  readonly to?: number | undefined;
  /** Ledgers per discovery window (default 500,000); each page's candidates and checkpoint are committed together. */
  readonly windowLedgers?: number;
  /**
   * New candidate ledgers one route may add per round (default 20,000). A route that lists more continues
   * from its checkpoint next round, so a source that lists every ledger cannot make one round read (and,
   * on mainnet, pay for) an unbounded number of ledgers; the overflow is counted.
   */
  readonly maxCandidatesPerRound?: number;
  /** At the head, routes of non-fee-paying roles are walked every this many rounds (default 20). */
  readonly slowRouteRounds?: number;
  /** First wait before a candidate whose bytes or anchor are not available is tried again (default 15 s; doubles). */
  readonly deferSeconds?: number;
  /** Routes walked and ledgers anchored at once (default 8, the Lumeus guidance). */
  readonly concurrency?: number;
  /** Candidate ledgers read per round (default 200). */
  readonly ledgersPerRound?: number;
  /** Wait between rounds at the head (default 15 s). */
  readonly pollMs?: number;
  /** A bounded run retries a round that made no progress this many times before it fails (default 5). */
  readonly boundedRetries?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly signal?: AbortSignal;
}

/** The indexer was stopped on purpose, or hit a failure it must not skip. */
export class IndexerStopped extends Error {
  readonly code: string;
  constructor(code: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "IndexerStopped";
    this.code = code;
  }
}

/** Integrity failures: the ledger is marked failed and the indexer stops. */
const INTEGRITY = new Set([
  "ledger_hash_invalid",
  "tx_set_hash_mismatch",
  "result_set_hash_mismatch",
  "ledger_mismatch",
  "anchor_mismatch",
  "object_undecodable",
  "events_unbound",
  "ledger_undecodable",
  "meta_unsupported",
]);

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The registry-scope indexer. Each round it walks every discovery route (the activity of each registry
 * facilitator account and upto contract) from its checkpoint and stores the candidate ledgers found with
 * the new checkpoint; then it reads the pending candidates' full bytes (Lumeus RPC inside its retention,
 * the public data lake before it), verifies each ledger against its own hashes and, when configured, an
 * independent anchor, classifies it with the unchanged rules and commits it. Discovery only chooses
 * which ledgers to read: a row exists only for a transaction in a verified ledger.
 */
export class Ingester {
  readonly #options: IngesterOptions;
  readonly #ctx: ClassifyContext;
  readonly #versions: LedgerVersions;
  #retryAfterUntil = 0;
  /** Ledger bytes (Lumeus RPC) asked to wait: no candidate is read before this time. */
  #bytesRetryUntil = 0;
  #rounds = 0;
  #cadence = new Map<string, RouteCadence>();
  /** The newest published ledger seen by the walks of the current round. */
  #roundHead: number | null = null;
  #status: {
    lastLedger: number | null;
    head: number | null;
    error: string | null;
    mode: "backfill" | "tail" | "idle";
  } = { lastLedger: null, head: null, error: null, mode: "idle" };

  constructor(options: IngesterOptions) {
    this.#options = options;
    this.#ctx = {
      network: options.network,
      epoch: options.epoch.id,
      passphrase: options.epoch.passphrase,
      registry: options.registry,
    };
    this.#versions = {
      rules: RULES_VERSION,
      registry: options.registry.registryVersion,
      classification: classificationFingerprint(options.registry.document),
    };
  }

  get status() {
    return { ...this.#status };
  }

  /**
   * Plans the routes from the registry, then runs rounds until the signal aborts, or, in a bounded run,
   * until every route is walked through `to` and every candidate is indexed. The routes keep their
   * registry bounds only: `to` bounds this run's walks, so a later run with a wider bound (or none)
   * resumes where this one stopped and loses nothing.
   */
  async run(): Promise<void> {
    const { store, network, epoch, from, to } = this.#options;
    if (from < epoch.fromLedger || (to !== undefined && to < from)) {
      throw new IndexerStopped(
        "range_invalid",
        `the range ${String(from)}-${String(to)} is not inside epoch ${epoch.id}`,
      );
    }
    const plan = discoveryPlan(this.#options.registry, epoch.id, { from });
    this.#cadence = new Map(plan.map((route) => [`${route.kind}:${route.address}`, route.cadence]));
    const removed = await store.syncRoutes(network, epoch.id, plan);
    this.#options.logger.info({ network, routes: plan.length, removed }, "discovery routes planned");
    let idle = 0;
    for (;;) {
      if (this.#aborted()) return;
      const progress = await this.#round();
      if (to !== undefined) {
        if (await this.#complete(to)) return;
        if (progress) idle = 0;
        else if (++idle > (this.#options.boundedRetries ?? 5)) {
          throw new IndexerStopped(
            "range_incomplete",
            `discovery or a candidate ledger through ${String(to)} is not available yet; a bounded run never leaves a hole`,
          );
        }
      }
      if (!progress || to === undefined) await this.#sleep(this.#options.pollMs ?? 15_000);
    }
  }

  /** One round: walk every route, then index pending ledgers. Returns whether anything moved. */
  async #round(): Promise<boolean> {
    this.#rounds++;
    const discovered = await this.#discover();
    let indexed = 0;
    for (;;) {
      if (this.#aborted()) break;
      const count = await this.#indexPending();
      indexed += count;
      if (count < (this.#options.ledgersPerRound ?? 200)) break;
    }
    await this.#observe();
    return discovered || indexed > 0;
  }

  /** Walks every route due this round from its checkpoint. Returns whether any route moved. */
  async #discover(): Promise<boolean> {
    if (Date.now() < this.#retryAfterUntil) return false;
    this.#roundHead = null;
    const { store, network, epoch } = this.#options;
    const routes = (await store.routes(network, epoch.id)).filter(
      (route) => this.#open(route) && this.#due(route),
    );
    let moved = false;
    await pool(this.#options.concurrency ?? 8, routes, async (route) => {
      if (this.#aborted()) return;
      if (await this.#walk(route)) moved = true;
    });
    // The head is what the discovery source published in this round, so a reset shows at once.
    // (set by the walks above, through #seeHead)
    const head = this.#roundHead as number | null;
    if (head !== null) this.#status.head = head;
    return moved;
  }

  /** The route still has ledgers to walk inside its bounds and the run's. */
  #open(route: StoredRoute): boolean {
    const end = this.#routeEnd(route);
    return end === undefined || (route.scannedThrough ?? route.from - 1) < end;
  }

  /**
   * Whether the route is walked this round: always in a bounded run, while it catches up, and for
   * fee-paying roles; a slow route at the head every `slowRouteRounds` rounds.
   */
  #due(route: StoredRoute): boolean {
    if (this.#cadence.get(`${route.kind}:${route.address}`) !== "slow") return true;
    if (this.#options.to !== undefined) return true;
    const head = this.#status.head;
    if (head === null || route.scannedThrough === null || head - route.scannedThrough > 720) return true;
    return this.#rounds % Math.max(1, this.#options.slowRouteRounds ?? 20) === 0;
  }

  /** The route's last ledger in this run, or undefined when it follows the head. */
  #routeEnd(route: StoredRoute): number | undefined {
    const to = this.#options.to;
    if (route.to === null) return to;
    return to === undefined ? route.to : Math.min(route.to, to);
  }

  /**
   * Walks one route from its checkpoint, storing every page as it is read. A new generation or decoder
   * of the discovery source starts the route again from its first ledger (on testnet, together with a
   * head far behind the indexed candidates, it is a reset and stops the indexer). Stops for the round
   * after `maxCandidatesPerRound` new candidates. Returns whether the route moved.
   */
  async #walk(route: StoredRoute): Promise<boolean> {
    const { store, network, epoch, metrics, logger } = this.#options;
    const end = this.#routeEnd(route);
    const start = (route.scannedThrough ?? route.from - 1) + 1;
    const cap = this.#options.maxCandidatesPerRound ?? 20_000;
    const name = `${route.kind}:${route.address}`;
    let known = { generation: route.generation, decoder: route.decoderVersion };
    let moved = false;
    let added = 0;
    try {
      for await (const page of this.#options.activity.walkRange(
        { kind: route.kind, address: route.address },
        start,
        end === undefined ? undefined : end + 1,
        { windowLedgers: this.#options.windowLedgers ?? 500_000 },
      )) {
        this.#seeHead(page.readView.publishedThrough);
        if (
          known.generation !== null &&
          (page.readView.generation !== known.generation || page.readView.decoderVersion !== known.decoder)
        ) {
          await this.#newReadView(route, page, known.generation);
          return true;
        }
        known = { generation: page.readView.generation, decoder: page.readView.decoderVersion };
        const ledgers = [...new Set(page.records.map((record) => record.ledger))];
        const stored = await store.recordWindow({
          network,
          epoch: epoch.id,
          kind: route.kind,
          address: route.address,
          ledgers,
          scannedThrough: page.scannedThrough,
          readView: page.readView,
        });
        if (stored.moved || stored.added > 0) moved = true;
        added += stored.added;
        metrics.discoveryRecords.inc({ network, kind: route.kind }, page.records.length);
        metrics.candidates.inc({ network, kind: route.kind }, stored.added);
        if (added >= cap && !page.complete) {
          metrics.candidatesCapped.inc({ network, kind: route.kind });
          logger.warn(
            { network, route: name, added, cap },
            "a route listed more new candidate ledgers than one round reads; it continues next round",
          );
          break;
        }
      }
    } catch (error) {
      if (error instanceof LumeusError && error.retryable) {
        metrics.failures.inc({ network, code: error.code });
        if (error.retryAfterSeconds !== undefined) {
          this.#retryAfterUntil = Math.max(
            this.#retryAfterUntil,
            Date.now() + error.retryAfterSeconds * 1000,
          );
        }
        logger.warn(
          { network, route: name, code: error.code, requestId: error.requestId },
          "discovery failed for now; the route resumes from its checkpoint",
        );
        return moved;
      }
      this.#stop(error);
    }
    return moved;
  }

  /**
   * The discovery source answered under another generation or decoder than the route's last page: it
   * rebuilt its index (records may be added or corrected) or, on testnet, the network was reset. A head
   * far behind the newest candidate on testnet is a reset: the indexer stops until the new epoch is in the
   * registry. On pubnet a head behind is only alerted. Otherwise the route starts again from its first
   * ledger.
   */
  async #newReadView(route: StoredRoute, page: WalkStep, previous: string): Promise<void> {
    const { store, network, epoch, metrics, logger } = this.#options;
    const newest = await store.newestCandidate(network, epoch.id);
    const behind = newest !== null && page.readView.publishedThrough + RESET_MARGIN_LEDGERS < newest;
    if (
      isReset({
        network,
        generationChanged: page.readView.generation !== previous,
        head: page.readView.publishedThrough,
        newestIndexed: newest,
      })
    ) {
      this.#stop(
        new EpochError(
          "epoch_reset",
          `the discovery source changed generation (${previous} to ${page.readView.generation}) and its newest ledger ${String(page.readView.publishedThrough)} is behind ledger ${String(newest)} already indexed in epoch ${epoch.id}: the network was reset; add its new epoch to the registry`,
        ),
      );
    }
    if (behind) metrics.headRegressions.inc({ network });
    await store.restartRoute(network, epoch.id, route, page.readView);
    metrics.discoveryRestarts.inc({ network, kind: route.kind });
    logger.warn(
      {
        network,
        route: `${route.kind}:${route.address}`,
        from: previous,
        to: page.readView.generation,
        decoder: page.readView.decoderVersion,
      },
      "the discovery source's read view changed; the route is walked again from its first ledger",
    );
  }

  /**
   * Reads, verifies, anchors, classifies and commits up to one round of pending ledgers. Returns how many.
   * Ledgers are taken from the byte source one at a time as they arrive: each is verified and classified
   * at once, so its decoded bytes are let go before the next one is decoded, and only the rows wait for
   * their commit (at most `concurrency` commits at once).
   */
  async #indexPending(): Promise<number> {
    const { store, network, epoch, metrics } = this.#options;
    if (Date.now() < this.#bytesRetryUntil) return 0;
    const pending = await store.pendingLedgers(network, epoch.id, this.#options.ledgersPerRound ?? 200);
    if (pending.length === 0) return 0;
    // Anchors for the whole batch in as few requests as the anchor source allows (Horizon /ledgers
    // pages); a ledger it did not answer for is asked for alone.
    let prefetched = new Map<number, string>();
    const anchors = this.#options.anchors;
    if (anchors?.ledgerHashes !== undefined) {
      try {
        prefetched = await anchors.ledgerHashes(pending);
      } catch (error) {
        if (!(error instanceof LedgerSourceError)) throw error;
        metrics.failures.inc({ network, code: error.code });
      }
    }
    let committed = 0;
    const writes = new Writes(this.#options.concurrency ?? 8);
    const reads = this.#options.bytes.stream(pending);
    try {
      for (;;) {
        let next: IteratorResult<LedgerRead>;
        try {
          next = await reads.next();
        } catch (error) {
          await writes.settle();
          this.#readFailed(error);
          break;
        }
        if (next.done === true) break;
        const { sequence, ledger } = next.value;
        if (ledger === undefined) {
          // Not published by any source yet: try again later, without holding back newer candidates.
          await writes.run(() => store.deferLedger(network, epoch.id, sequence, this.#options.deferSeconds));
          continue;
        }
        const started = performance.now();
        let indexed;
        try {
          indexed = indexSingle(sequence, ledger, this.#ctx);
        } catch (error) {
          await writes.settle();
          return await this.#fail(sequence, error);
        }
        const { verified, classification, source } = indexed;
        await writes.run(async () => {
          const anchor = await this.#anchor(sequence, verified.hash, prefetched.get(sequence));
          if (anchor === null) {
            await store.deferLedger(network, epoch.id, sequence, this.#options.deferSeconds);
            return;
          }
          const written = await store.commitLedger({
            network,
            epoch: epoch.id,
            ledger: sequence,
            hash: verified.hash,
            previousHash: verified.previousHash,
            closedAt: verified.closedAt,
            source,
            rows: classification.rows,
            failed: classification.failed,
            excluded: classification.excluded,
            versions: this.#versions,
            ...(anchor === undefined ? {} : { anchor }),
          });
          if (!written) return;
          committed++;
          metrics.ledgers.inc({ network, source });
          metrics.ledgerSeconds.observe({ network }, (performance.now() - started) / 1000);
          for (const row of classification.rows)
            metrics.settlements.inc({ network, scheme: row.scheme, tier: row.attribution.tier });
          if (classification.rows.every((row) => row.attribution.tier === "shaped"))
            metrics.unattributedCandidates.inc({ network });
        });
      }
      await writes.finish();
    } finally {
      await reads.return(undefined);
    }
    return committed;
  }

  /**
   * A ledger source failed. A retryable failure (counted) leaves the rest of the batch pending, and a
   * Retry-After (for example the daily testnet request cap) pauses every ledger read until then; any
   * other failure stops the indexer.
   */
  #readFailed(error: unknown): void {
    const { network, metrics } = this.#options;
    if (!(error instanceof LedgerSourceError && error.retryable)) this.#stop(error);
    metrics.failures.inc({ network, code: error.code });
    if (error.retryAfterSeconds !== undefined) {
      this.#bytesRetryUntil = Math.max(this.#bytesRetryUntil, Date.now() + error.retryAfterSeconds * 1000);
    }
    this.#options.logger.warn(
      { network, code: error.code, retryAfterSeconds: error.retryAfterSeconds },
      "ledger source failed; retrying later",
    );
  }

  /**
   * Checks a ledger's hash against the independent anchor: the checked anchor; undefined without anchors;
   * null when the anchor cannot be read yet (the ledger stays pending). A different hash marks the ledger
   * failed and stops the indexer.
   */
  async #anchor(
    sequence: number,
    hash: string,
    known: string | undefined,
  ): Promise<CheckedAnchor | undefined | null> {
    const anchors = this.#options.anchors;
    if (anchors === undefined) return undefined;
    let expected: string;
    try {
      expected = known ?? (await anchors.ledgerHash(sequence));
    } catch (error) {
      if (error instanceof LedgerSourceError && error.code !== "anchor_mismatch") {
        this.#options.metrics.failures.inc({ network: this.#options.network, code: error.code });
        return null;
      }
      throw error;
    }
    if (expected !== hash) {
      await this.#fail(
        sequence,
        new LedgerSourceError(
          "anchor_mismatch",
          `ledger ${String(sequence)}: hash ${hash} differs from ${anchors.name}'s ${expected}`,
        ),
      );
    }
    return { ledger: sequence, hash, source: anchors.name };
  }

  /** Marks the ledger failed when the failure is about the ledger itself, and stops. */
  async #fail(sequence: number, error: unknown): Promise<never> {
    const code = errorCode(error);
    if (INTEGRITY.has(code)) {
      await this.#options.store.markFailed(
        this.#options.network,
        this.#options.epoch.id,
        sequence,
        `${code}: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (code === "anchor_mismatch" || code === "ledger_mismatch") {
        this.#options.metrics.gaps.inc({ network: this.#options.network });
      }
    }
    this.#stop(error);
  }

  /**
   * Stops the indexer. Health shows only the stable code: messages can quote a remote server's error
   * text, which goes to the log alone.
   */
  #stop(error: unknown): never {
    const code = errorCode(error);
    const message = `${code}: ${error instanceof Error ? error.message : String(error)}`;
    this.#status.error = code;
    this.#options.metrics.failures.inc({ network: this.#options.network, code });
    this.#options.logger.error({ network: this.#options.network, code }, message);
    throw error instanceof IndexerStopped ? error : new IndexerStopped(code, message, error);
  }

  #seeHead(head: number): void {
    if (this.#roundHead === null || head > this.#roundHead) this.#roundHead = head;
  }

  /**
   * Coverage, lag and mode after a round. A discovery head far behind the newest candidate without a new
   * generation is a lagging or dishonest source, not a reset: it is counted and logged, never a stop.
   */
  async #observe(): Promise<void> {
    const { store, network, epoch, metrics } = this.#options;
    const routes = await store.routes(network, epoch.id);
    const newest = await store.newestCandidate(network, epoch.id);
    const head = this.#roundHead;
    if (head !== null && newest !== null && head + RESET_MARGIN_LEDGERS < newest) {
      metrics.headRegressions.inc({ network });
      this.#options.logger.warn(
        { network, head, newest },
        "the discovery source's head is far behind the indexed candidates",
      );
    }
    const counts = await store.ledgerCounts(network, epoch.id);
    const covered = discoveredThrough(routes, this.#options.to);
    this.#status.lastLedger = covered;
    if (head !== null) metrics.headLedger.set({ network }, head);
    if (covered !== null) metrics.lastLedger.set({ network }, covered);
    if (head !== null && covered !== null) metrics.lagLedgers.set({ network }, Math.max(0, head - covered));
    for (const [status, count] of Object.entries(counts))
      metrics.candidateLedgers.set({ network, status }, count);
    const behind = head === null || covered === null ? Infinity : head - covered;
    this.#status.mode = counts.pending > 0 || behind > 720 ? "backfill" : "tail";
  }

  /** A bounded run is done when every route is walked through `to` and no candidate waits. */
  async #complete(to: number): Promise<boolean> {
    const { store, network, epoch } = this.#options;
    const routes = await store.routes(network, epoch.id);
    if (routes.some((route) => this.#open(route))) return false;
    const counts = await store.ledgerCounts(network, epoch.id);
    return counts.pending === 0 && counts.failed === 0 && (discoveredThrough(routes, to) ?? 0) >= to;
  }

  #aborted(): boolean {
    return this.#options.signal?.aborted === true;
  }

  #sleep(ms: number): Promise<void> {
    return (this.#options.sleep ?? defaultSleep)(ms);
  }
}

/**
 * Runs `task` over `items` with at most `concurrency` at once. After the first failure no new item starts;
 * the ones under way finish, then the failure is thrown, so nothing keeps writing after a stop.
 */
async function pool<T>(
  concurrency: number,
  items: readonly T[],
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async () => {
    while (failure === undefined && next < items.length) {
      const item = items[next++] as T;
      try {
        await task(item);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  if (failure !== undefined) throw failure.error;
}

/**
 * At most `limit` writes at once. After the first failure no new write starts: `run` and `finish` wait
 * for the ones under way, then throw that failure, so nothing keeps writing after a stop.
 */
class Writes {
  readonly #limit: number;
  readonly #active = new Set<Promise<void>>();
  #failure: { error: unknown } | undefined;

  constructor(limit: number) {
    this.#limit = Math.max(1, limit);
  }

  /** Starts `task` once a slot is free; throws an earlier write's failure instead. */
  async run(task: () => Promise<void>): Promise<void> {
    while (this.#active.size >= this.#limit && this.#failure === undefined) await Promise.race(this.#active);
    if (this.#failure !== undefined) {
      await this.settle();
      throw this.#failure.error;
    }
    const running: Promise<void> = task()
      .catch((error: unknown) => {
        this.#failure ??= { error };
      })
      .finally(() => this.#active.delete(running));
    this.#active.add(running);
  }

  /** Waits for every write under way. */
  async settle(): Promise<void> {
    await Promise.all(this.#active);
  }

  /** Waits for every write under way, then throws the first failure, if any. */
  async finish(): Promise<void> {
    await this.settle();
    if (this.#failure !== undefined) throw this.#failure.error;
  }
}

function errorCode(error: unknown): string {
  if (error !== null && typeof error === "object" && "code" in error && typeof error.code === "string")
    return error.code;
  if (error instanceof Error && error.name === "UnsupportedMetaError") return "meta_unsupported";
  return "indexer_error";
}
