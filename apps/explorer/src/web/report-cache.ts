import type { Kysely } from "kysely";
import type { IndexNetwork, RegistrySnapshot } from "@rail402.dev/x402-index";
import type { ExplorerDatabase } from "../db.ts";
import type { Epoch } from "../epoch.ts";
import { loadReport, type ComputedReport } from "../api/report.ts";
import type { WebMetrics } from "./metrics.ts";

export interface ReportTarget {
  readonly network: IndexNetwork;
  readonly epoch: Epoch;
  readonly registry: RegistrySnapshot;
}

interface Logger {
  warn(fields: object, message: string): void;
}

/**
 * Each network's report as the indexer last published it, re-read in the background every
 * `refreshMs` (one short indexed read; the web role never rescans settlements). A failed read keeps the
 * previous report; requests never wait for one.
 */
export class ReportCache {
  readonly #db: Kysely<ExplorerDatabase>;
  readonly #targets: readonly ReportTarget[];
  readonly #reports = new Map<IndexNetwork, ComputedReport>();
  readonly #running = new Map<IndexNetwork, Promise<void>>();
  readonly #metrics: WebMetrics | undefined;
  readonly #logger: Logger | undefined;
  #timer: NodeJS.Timeout | undefined;

  constructor(
    db: Kysely<ExplorerDatabase>,
    targets: readonly ReportTarget[],
    options: { metrics?: WebMetrics; logger?: Logger } = {},
  ) {
    this.#db = db;
    this.#targets = targets;
    this.#metrics = options.metrics;
    this.#logger = options.logger;
  }

  get(network: IndexNetwork): ComputedReport | undefined {
    const report = this.#reports.get(network);
    if (report !== undefined) {
      this.#metrics?.reportAge.set(
        { network },
        (Date.now() - Date.parse(report.document.generatedAt)) / 1000,
      );
    }
    return report;
  }

  /** Recomputes every network's report once; resolves when all are done. */
  async refreshAll(): Promise<void> {
    await Promise.all(this.#targets.map((target) => this.refresh(target.network)));
  }

  refresh(network: IndexNetwork): Promise<void> {
    const running = this.#running.get(network);
    if (running !== undefined) return running;
    const target = this.#targets.find((entry) => entry.network === network);
    if (target === undefined) return Promise.resolve();
    const run = loadReport(this.#db, target.network, target.epoch.id)
      .then((report) => {
        if (report === undefined) return;
        this.#reports.set(network, report);
        this.#metrics?.reportLastLedger.set({ network }, report.document.range.to);
        this.#metrics?.reportAge.set({ network }, 0);
      })
      .catch((error: unknown) => {
        this.#metrics?.reportFailures.inc({ network });
        this.#logger?.warn(
          { network, err: error instanceof Error ? error.message : String(error) },
          "the report could not be read; the previous one stays served",
        );
      })
      .finally(() => this.#running.delete(network));
    this.#running.set(network, run);
    return run;
  }

  start(refreshMs: number): void {
    void this.refreshAll();
    this.#timer = setInterval(() => void this.refreshAll(), refreshMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
  }
}
