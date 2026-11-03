/**
 * The network window job: every EXPLORER_NETWORK_WINDOW_EVERY_HOURS, rebuilds the newest
 * EXPLORER_NETWORK_WINDOW_HOURS of ledgers in full from the public data lake (the rebuild command's own
 * code, scope full) and publishes its tier totals and manifest as the report's network-wide block. Off
 * unless EXPLORER_NETWORK_WINDOW_HOURS is set; it never touches the payment path, Lumeus or the indexer.
 * Settings: networkWindowConfig in config.ts.
 *
 *   EXPLORER_NETWORK=testnet EXPLORER_NETWORK_WINDOW_HOURS=24 EXPLORER_DATABASE_URL=postgres://… \
 *   pnpm --filter @rail402.dev/explorer network-window [--once]
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { DataLakeSource, HorizonAnchors } from "@rail402.dev/ledger-source";
import { migrate } from "@rail402.dev/store-postgres";
import { REGISTRIES } from "@rail402.dev/x402-index/registry";
import { ExplorerConfigError, PUBNET_DEFAULT_FROM, networkWindowConfig } from "../config.ts";
import { EXPLORER_MIGRATIONS, createExplorerDatabase } from "../db.ts";
import { detectEpoch } from "../epoch.ts";
import { assertWriterRole } from "../roles.ts";
import { loadNetworkWindow, publishNetworkWindow, runNetworkWindow } from "./window.ts";

const logger = pino({ name: "rail402-explorer-network-window" });
const MIB = 1024 * 1024;

async function main(): Promise<number> {
  const config = networkWindowConfig(process.env, { workDir: join(tmpdir(), "rail402-explorer-window") });
  if (config.hours === 0) {
    logger.info({ network: config.network }, "the network window is off (EXPLORER_NETWORK_WINDOW_HOURS)");
    return 0;
  }
  const once = process.argv.includes("--once");
  const registry = REGISTRIES[config.network];
  const newest = registry.document.epochs.at(-1);
  if (newest === undefined) throw new ExplorerConfigError("config_invalid", "the registry lists no epoch");
  const epoch = detectEpoch(registry, { passphrase: newest.passphrase, folder: newest.dataLakeFolder });

  if (config.migrationDatabaseUrl !== undefined) {
    const owner = createExplorerDatabase({
      connectionString: config.migrationDatabaseUrl,
      maxConnections: 1,
    });
    try {
      await migrate(owner, EXPLORER_MIGRATIONS);
    } finally {
      await owner.destroy();
    }
  }
  const db = createExplorerDatabase({ connectionString: config.databaseUrl, maxConnections: 2 });
  try {
    await assertWriterRole(db, { facilitatorDatabase: config.facilitatorDatabase });
  } catch (error) {
    if (!config.allowUnsafeRole) {
      await db.destroy();
      throw error;
    }
    logger.warn(
      { err: (error as Error).message },
      "running under an unsafe role (EXPLORER_ALLOW_UNSAFE_ROLE)",
    );
  }

  const abort = new AbortController();
  const stopping = (): boolean => abort.signal.aborted;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      logger.info({ signal }, "stopping");
      abort.abort(new Error(`stopped by ${signal}`));
    });
  }
  const lake = new DataLakeSource({ folder: epoch.dataLakeFolder, passphrase: epoch.passphrase });
  const anchors =
    config.anchorHorizonUrl === undefined || config.publicAnchorHorizonUrl === undefined
      ? undefined
      : { source: new HorizonAnchors({ url: config.anchorHorizonUrl }), url: config.publicAnchorHorizonUrl };
  let failed = false;
  try {
    while (!stopping()) {
      const previous = await loadNetworkWindow(db, config.network, epoch.id);
      let peakRss = process.memoryUsage().rss;
      const sampler = setInterval(() => {
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
      }, 1000);
      sampler.unref();
      try {
        const window = await runNetworkWindow({
          network: config.network,
          epoch,
          registry,
          source: lake,
          hours: config.hours,
          // A ledger the lake holds: the last window's end, or a known recent one.
          headHint: Math.max(
            config.network === "stellar:pubnet" ? PUBNET_DEFAULT_FROM : epoch.fromLedger,
            previous?.document.window.to ?? 0,
          ),
          ...(anchors === undefined ? {} : { anchors }),
          maxSeconds: config.maxSeconds,
          maxDownloadBytes: config.maxDownloadMib * MIB,
          maxRows: config.maxRows,
          maxBytesInFlight: config.bytesInFlightMib * MIB,
          concurrency: config.concurrency,
          workDir: config.workDir,
          signal: abort.signal,
        });
        await publishNetworkWindow(db, window);
        failed = false;
        logger.info(
          {
            network: config.network,
            from: window.document.window.from,
            to: window.document.window.to,
            seconds: window.document.run.seconds,
            downloadedMiB: Math.round(window.document.run.downloadedBytes / MIB),
            peakRssMiB: Math.round(peakRss / MIB),
            manifestSha256: window.document.manifestSha256,
          },
          "published the network window",
        );
      } catch (error) {
        if (stopping()) break;
        failed = true;
        logger.warn(
          {
            network: config.network,
            code: (error as { code?: string }).code,
            err: error instanceof Error ? error.message : String(error),
            peakRssMiB: Math.round(peakRss / MIB),
          },
          "the network window could not be built; the last published one stays",
        );
      } finally {
        clearInterval(sampler);
      }
      if (once) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, config.everyHours * 3_600_000);
        abort.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  } finally {
    await db.destroy();
  }
  return once && failed ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    logger.error(
      { err: error instanceof Error ? error.message : String(error) },
      "the network window job could not start",
    );
    process.exitCode = error instanceof ExplorerConfigError ? 78 : 1;
  },
);
