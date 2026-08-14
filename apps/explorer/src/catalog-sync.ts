import type { Logger } from "pino";
import type { ExplorerStore } from "./db.js";
import type { FetchLike } from "./rpc.js";

/**
 * Bazaar catalog sync — the "registered" half of the seller directory.
 *
 * On-chain data tells the explorer who has been PAID; the Bazaar tells it who has REGISTERED. This
 * task pulls the whole Bazaar catalog periodically and marks each listed payTo as registered, so a
 * seller who registers through our facilitator appears in `/sellers` automatically — even before
 * their first settled payment. It is advisory: a failure never blocks anything, and it only ever
 * annotates the sellers table.
 */

const PAGE_LIMIT = 100;
const MAX_PAGES = 200; // 20k listings ceiling — a runaway-catalog backstop
const FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

interface CatalogAccept {
  network?: unknown;
  payTo?: unknown;
}
interface CatalogItem {
  resource?: unknown;
  serviceName?: unknown;
  description?: unknown;
  accepts?: CatalogAccept[];
}
interface CatalogPage {
  items?: CatalogItem[];
  pagination?: { total?: number };
}

export interface CatalogSyncOptions {
  readonly store: ExplorerStore;
  readonly bazaarUrl: string;
  readonly logger: Logger;
  readonly fetchImpl?: FetchLike;
  readonly now?: () => Date;
  readonly intervalMs?: number;
}

export class CatalogSync {
  readonly counters = { syncs: 0, registered: 0 };

  private readonly store: ExplorerStore;
  private readonly bazaarUrl: string;
  private readonly logger: Logger;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | undefined;
  private syncing = false;

  constructor(options: CatalogSyncOptions) {
    this.store = options.store;
    this.bazaarUrl = options.bazaarUrl;
    this.logger = options.logger;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  }

  start(): void {
    const tick = (): void => {
      if (this.syncing) return;
      this.syncing = true;
      void this.syncOnce()
        .catch(error => {
          this.logger.warn(
            { err: error instanceof Error ? error.message : String(error) },
            "bazaar catalog sync failed; will retry next interval",
          );
        })
        .finally(() => {
          this.syncing = false;
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

  /** One full walk of the Bazaar catalog. Returns the number of registered sellers marked. */
  async syncOnce(): Promise<number> {
    let offset = 0;
    let marked = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = new URL("/discovery/resources", this.bazaarUrl);
      url.searchParams.set("limit", String(PAGE_LIMIT));
      url.searchParams.set("offset", String(offset));
      let body: CatalogPage;
      try {
        const response = await this.fetchImpl(url.toString(), {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!response.ok) return marked;
        body = (await response.json()) as CatalogPage;
      } catch (error) {
        this.logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          "bazaar catalog page fetch failed",
        );
        return marked;
      }
      const items = body.items ?? [];
      if (items.length === 0) break;
      for (const item of items) {
        for (const accept of item.accepts ?? []) {
          const network = typeof accept.network === "string" ? accept.network : undefined;
          const payTo = typeof accept.payTo === "string" ? accept.payTo : undefined;
          if (!network || !payTo) continue;
          this.store.markRegisteredSeller({
            network,
            payTo,
            ...(typeof item.serviceName === "string" ? { serviceName: item.serviceName } : {}),
            ...(typeof item.resource === "string" ? { resource: item.resource } : {}),
            ...(typeof item.description === "string" ? { description: item.description } : {}),
            fetchedAt: this.now().toISOString(),
          });
          marked += 1;
        }
      }
      if (items.length < PAGE_LIMIT) break;
      offset += PAGE_LIMIT;
    }
    this.counters.syncs += 1;
    this.counters.registered = marked;
    this.logger.debug({ registered: marked }, "bazaar catalog synced");
    return marked;
  }
}
