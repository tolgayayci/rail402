import type { FacilitatorConfig } from "./config/env.js";

/**
 * Explorer announce heartbeat: tell an explorer this deployment exists, so third-party
 * deployments of this codebase appear on explorer.rail402.dev automatically (default ON,
 * `EXPLORER_ANNOUNCE_URL=""` disables — apps/explorer/README.md decision 1).
 *
 * Trust model: this is an INTRODUCTION, not an assertion. The body carries only the public base
 * URL the operator configured; the explorer probes `/supported` itself and attributes only what
 * it verifies against the ledger. Nothing here can inflate a facilitator's standing, so nothing
 * here needs authentication.
 *
 * Failure model: strictly fire-and-forget. An explorer being down must never affect a payment
 * path, so failures log at debug and the timer just tries again next interval. This runs from the
 * Node entrypoint only — on Workers a floating timer never fires, and the Railway
 * host is the deployment target.
 */

const ANNOUNCE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const ANNOUNCE_TIMEOUT_MS = 10_000;

interface AnnounceLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
}

export interface AnnounceOptions {
  readonly config: Pick<FacilitatorConfig, "publicUrl" | "explorerAnnounceUrl">;
  readonly logger: AnnounceLogger;
  readonly fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  readonly intervalMs?: number;
}

/** Start the heartbeat. Returns a stop function; a no-op stop when announce is not configured. */
export function startExplorerAnnounce(options: AnnounceOptions): () => void {
  const { config, logger } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const announceUrl = config.explorerAnnounceUrl;
  const publicUrl = config.publicUrl;

  if (announceUrl === undefined) {
    return () => {};
  }
  if (publicUrl === undefined) {
    logger.info(
      { announceUrl },
      "explorer announce is enabled but FACILITATOR_PUBLIC_URL is not set; nothing truthful to announce — set it to appear on the explorer",
    );
    return () => {};
  }

  const announce = async (): Promise<void> => {
    try {
      const response = await fetchImpl(announceUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: publicUrl }),
        signal: AbortSignal.timeout(ANNOUNCE_TIMEOUT_MS),
      });
      logger.debug({ announceUrl, status: response.status }, "explorer announce sent");
    } catch (error) {
      logger.debug(
        { announceUrl, err: error instanceof Error ? error.message : String(error) },
        "explorer announce failed; will retry next interval",
      );
    }
  };

  void announce();
  const timer = setInterval(() => void announce(), options.intervalMs ?? ANNOUNCE_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
