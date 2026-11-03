import type { Kysely } from "kysely";
import type { IndexNetwork, RegistrySnapshot } from "@rail402.dev/x402-index";
import { computeReport, publishReport } from "../api/report.ts";
import type { ExplorerDatabase } from "../db.ts";
import type { Epoch } from "../epoch.ts";

interface Logger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

/**
 * Computes the network's report once per interval and publishes it for the web processes: the full
 * scan runs in this one process, never in every web replica. A failed run keeps the last published
 * report.
 */
export class ReportPublisher {
  readonly #db: Kysely<ExplorerDatabase>;
  readonly #target: { network: IndexNetwork; epoch: Epoch; registry: RegistrySnapshot };
  readonly #logger: Logger;
  #running: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;

  constructor(
    db: Kysely<ExplorerDatabase>,
    target: { network: IndexNetwork; epoch: Epoch; registry: RegistrySnapshot },
    logger: Logger,
  ) {
    this.#db = db;
    this.#target = target;
    this.#logger = logger;
  }

  /** Computes and publishes once; concurrent calls share one run. */
  publish(): Promise<void> {
    this.#running ??= computeReport(this.#db, this.#target)
      .then(async (report) => {
        if (report === undefined) return;
        await publishReport(this.#db, report);
        this.#logger.info(
          { network: this.#target.network, to: report.document.range.to },
          "published the report",
        );
      })
      .catch((error: unknown) => {
        this.#logger.warn(
          { network: this.#target.network, err: error instanceof Error ? error.message : String(error) },
          "the report could not be computed; the last published one stays",
        );
      })
      .finally(() => {
        this.#running = undefined;
      });
    return this.#running;
  }

  start(intervalMs: number): void {
    void this.publish();
    this.#timer = setInterval(() => void this.publish(), intervalMs);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    await this.#running;
  }
}
