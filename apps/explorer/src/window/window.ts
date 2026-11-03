import { rmSync } from "node:fs";
import type { Kysely } from "kysely";
import type { AnchorSource, FetchedLedger, LedgerSource, SourcedLedger } from "@rail402.dev/ledger-source";
import {
  RULES_VERSION,
  type IndexNetwork,
  type RegistrySnapshot,
  type SettlementRow,
} from "@rail402.dev/x402-index";
import type { ExplorerDatabase } from "../db.ts";
import type { Epoch } from "../epoch.ts";
import { Accumulator, canonicalJson, sha256, type Totals } from "../rebuild/aggregates.ts";
import { dataLakeDescription, rangeAnchors, rebuild } from "../rebuild/rebuild.ts";

/** Stellar closes a ledger about every 5 seconds: the ledgers of a window of `hours`. */
export const LEDGERS_PER_HOUR = 720;
/** The longest window: 7 days. */
export const MAX_WINDOW_HOURS = 168;

export type NetworkWindowErrorCode =
  | "network_window_time_budget"
  | "network_window_download_budget"
  | "network_window_row_budget"
  | "network_window_range";

/** A window run stopped at one of its budgets, or had no range to read. The last published window stays. */
export class NetworkWindowError extends Error {
  readonly code: NetworkWindowErrorCode;
  constructor(code: NetworkWindowErrorCode, message: string) {
    super(message);
    this.name = "NetworkWindowError";
    this.code = code;
  }
}

/**
 * The network-wide block of the Ecosystem Report: every ledger of a recent window read in full from the
 * public data lake (a full-scope rebuild of that range), so it counts the settlements of every
 * facilitator, registered or not. It is a sample of one window, never the lifetime totals.
 */
export interface NetworkWindowDocument {
  readonly label: "network-wide (sampled window)";
  readonly network: IndexNetwork;
  readonly epoch: string;
  readonly generatedAt: string;
  /** Always `full`: every ledger of the window was read and verified. */
  readonly scope: "full";
  readonly window: {
    /** The window asked for, in hours; `ledgers` is that many hours at one ledger per 5 seconds. */
    readonly hours: number;
    readonly from: number;
    readonly to: number;
    readonly ledgers: number;
    /** Close times of the first and last ledger: the time the window actually spans. */
    readonly firstClosedAt: string;
    readonly lastClosedAt: string;
  };
  /** Self-payments excluded, as in the report's other totals. */
  readonly tiers: {
    /** Settled by the hosted Rail402 service (tier rail402). */
    readonly rail402: Totals;
    /** Settled by another facilitator in the registry (tier facilitator). */
    readonly otherRegistered: Totals;
    /**
     * The x402 shape with no registry account: unregistered facilitators, smart-wallet relays, test
     * scripts, and transfers that only look like x402 payments (tier shaped).
     */
    readonly unattributed: Totals;
  };
  readonly rail402Beta: Totals;
  readonly selfPayments: Totals;
  /** Of `otherRegistered`, payments through shared relayers, which also relay non-x402 transfers. */
  readonly sharedRelayerPayments: number;
  readonly failedAttempts: number;
  readonly excluded: Readonly<Record<string, number>>;
  readonly assets: Readonly<
    Record<
      string,
      { readonly code: string | null; readonly issuer: string | null; readonly verified: boolean }
    >
  >;
  readonly rulesVersion: string;
  readonly registryVersion: string;
  readonly registrySha256: string;
  /** SHA-256 of the window's manifest.json, byte-identical to the one `rebuildCommand` writes. */
  readonly manifestSha256: string;
  readonly totalsSha256: string;
  /** The Horizon whose hashes anchor both ends of the window, or null when none was configured. */
  readonly anchorHorizon: string | null;
  /** Rebuilds this window from the public data lake: prints `manifestSha256` when nothing differs. */
  readonly rebuildCommand: string;
  /** What the run cost: wall time and the ledger bytes it downloaded. */
  readonly run: { readonly seconds: number; readonly downloadedBytes: number };
}

export interface NetworkWindow {
  readonly document: NetworkWindowDocument;
  /** manifest.json exactly as the rebuild command writes it. */
  readonly manifestText: string;
}

export interface NetworkWindowOptions {
  readonly network: IndexNetwork;
  readonly epoch: Epoch;
  readonly registry: RegistrySnapshot;
  /** The public data lake, handing ledgers over undecoded so the byte budget holds. */
  readonly source: LedgerSource & {
    fetchLedger?(sequence: number): Promise<FetchedLedger | undefined>;
  };
  /** The window asked for, in hours (1 to 168). */
  readonly hours: number;
  /** Ledgers to read; defaults to `hours` × 720. */
  readonly ledgers?: number;
  /** A ledger the source is known to hold, where the search for its newest ledger starts. */
  readonly headHint: number;
  /**
   * Independent hashes for both ends of the window (`--anchor-horizon`), with the URL the command names. That
   * URL is published, so it must be a bare origin: a path may carry a provider key.
   */
  readonly anchors?: { readonly source: AnchorSource; readonly url: string };
  readonly maxSeconds: number;
  readonly maxDownloadBytes: number;
  readonly maxRows: number;
  readonly maxBytesInFlight: number;
  readonly concurrency: number;
  /** Where the rebuild writes its files; removed when the run ends. */
  readonly workDir: string;
  /** Stops the run (the process is shutting down). */
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
}

export const networkSlug = (network: IndexNetwork) => (network === "stellar:pubnet" ? "pubnet" : "testnet");

/**
 * Reads the newest window of the network the data lake holds, every ledger in full, through the same
 * `rebuild()` (scope full) the rebuild command runs, and returns its tier totals with the manifest. The
 * run stops at its time, download or row budget with a `NetworkWindowError`; memory stays flat (one
 * decoded ledger at a time, rows streamed to files that are removed afterwards).
 */
export async function runNetworkWindow(options: NetworkWindowOptions): Promise<NetworkWindow> {
  const started = Date.now();
  const deadline = AbortSignal.timeout(options.maxSeconds * 1000);
  const signal = options.signal === undefined ? deadline : AbortSignal.any([deadline, options.signal]);
  let downloaded = 0;
  const count = (bytes: number) => {
    downloaded += bytes;
    if (downloaded > options.maxDownloadBytes) {
      throw new NetworkWindowError(
        "network_window_download_budget",
        `the window downloaded more than ${String(options.maxDownloadBytes)} bytes of ledgers`,
      );
    }
  };
  const inner = options.source;
  const fetchLedger = inner.fetchLedger?.bind(inner);
  // Every ledger read is counted against the download budget; the run stops once it is spent.
  const source: LedgerSource & { fetchLedger?: (sequence: number) => Promise<FetchedLedger | undefined> } = {
    name: inner.name,
    latestLedger: (from) => inner.latestLedger(from),
    getLedger: async (sequence): Promise<SourcedLedger | undefined> => {
      const ledger = await inner.getLedger(sequence);
      if (ledger !== undefined) count(ledger.meta.toXDR().byteLength);
      return ledger;
    },
    ...(fetchLedger === undefined
      ? {}
      : {
          fetchLedger: async (sequence: number) => {
            const fetched = await fetchLedger(sequence);
            if (fetched !== undefined) count(fetched.bytes);
            return fetched;
          },
        }),
  };

  const to = await inner.latestLedger(options.headHint);
  const wanted = options.ledgers ?? options.hours * LEDGERS_PER_HOUR;
  const from = Math.max(options.epoch.fromLedger, to - wanted + 1);
  if (to < from) {
    throw new NetworkWindowError("network_window_range", "the data lake holds no ledger of this epoch yet");
  }
  if (options.anchors !== undefined) publishableAnchor(options.anchors.url);
  const anchors = options.anchors === undefined ? [] : await rangeAnchors(options.anchors.source, from, to);

  const tiers = {
    rail402: new Accumulator(),
    otherRegistered: new Accumulator(),
    unattributed: new Accumulator(),
  };
  const beta = new Accumulator();
  const self = new Accumulator();
  const assets = new Map<string, { code: string | null; issuer: string | null; verified: boolean }>();
  let sharedRelayer = 0;
  let rows = 0;
  let firstClosedAt = "";
  let lastClosedAt = "";
  const onRow = (row: SettlementRow) => {
    if (++rows > options.maxRows) {
      throw new NetworkWindowError(
        "network_window_row_budget",
        `the window holds more than ${String(options.maxRows)} settlement rows`,
      );
    }
    if (!assets.has(row.asset.contract)) {
      assets.set(row.asset.contract, {
        code: row.asset.verified ? row.asset.code : null,
        issuer: row.asset.verified ? row.asset.issuer : null,
        verified: row.asset.verified,
      });
    }
    if (row.payer === row.payTo) {
      self.add(row);
      return;
    }
    const tier = row.attribution.tier;
    if (tier === "rail402") tiers.rail402.add(row);
    else if (tier === "facilitator") {
      tiers.otherRegistered.add(row);
      if (row.attribution.sharedRelayer) sharedRelayer++;
    } else if (tier === "shaped") tiers.unattributed.add(row);
    else beta.add(row);
  };

  let result: Awaited<ReturnType<typeof rebuild>>;
  try {
    result = await rebuild({
      network: options.network,
      epoch: options.epoch,
      registry: options.registry,
      source,
      sourceDescription: dataLakeDescription(options.epoch),
      from,
      to,
      anchors,
      concurrency: options.concurrency,
      maxBytesInFlight: options.maxBytesInFlight,
      retainRows: false,
      signal,
      outDir: options.workDir,
      onLedger: (ledger) => {
        if (firstClosedAt === "") firstClosedAt = ledger.closedAt;
        lastClosedAt = ledger.closedAt;
      },
      onRow,
    });
  } catch (error) {
    if (deadline.aborted && !(error instanceof NetworkWindowError)) {
      throw new NetworkWindowError(
        "network_window_time_budget",
        `the window took longer than ${String(options.maxSeconds)} seconds`,
      );
    }
    throw error;
  } finally {
    rmSync(options.workDir, { recursive: true, force: true });
  }

  const { manifest, manifestSha256 } = result;
  const manifestText = `${canonicalJson(manifest)}\n`;
  const name = networkSlug(options.network);
  const command = [
    `pnpm explorer:rebuild --network ${name} --from ${String(from)} --to ${String(to)}`,
    options.anchors === undefined ? "" : ` --anchor-horizon ${options.anchors.url}`,
  ].join("");
  const document: NetworkWindowDocument = {
    label: "network-wide (sampled window)",
    network: options.network,
    epoch: options.epoch.id,
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    scope: "full",
    window: {
      hours: options.hours,
      from,
      to,
      ledgers: to - from + 1,
      firstClosedAt,
      lastClosedAt,
    },
    tiers: {
      rail402: tiers.rail402.totals(),
      otherRegistered: tiers.otherRegistered.totals(),
      unattributed: tiers.unattributed.totals(),
    },
    rail402Beta: beta.totals(),
    selfPayments: self.totals(),
    sharedRelayerPayments: sharedRelayer,
    failedAttempts: result.aggregates.failedAttempts,
    excluded: result.aggregates.excluded,
    assets: Object.fromEntries([...assets].sort(([a], [b]) => a.localeCompare(b))),
    rulesVersion: RULES_VERSION,
    registryVersion: options.registry.registryVersion,
    registrySha256: manifest.registrySha256,
    manifestSha256,
    totalsSha256: manifest.totalsSha256,
    anchorHorizon: options.anchors?.url ?? null,
    rebuildCommand: command,
    run: { seconds: Math.round((Date.now() - started) / 1000), downloadedBytes: downloaded },
  };
  if (sha256(manifestText) !== manifestSha256) throw new Error("the manifest text differs from its hash");
  return { document, manifestText };
}

/** Stores a window as the network's current one (the writer role). */
export async function publishNetworkWindow(
  db: Kysely<ExplorerDatabase>,
  window: NetworkWindow,
): Promise<void> {
  const row = {
    network: window.document.network,
    epoch: window.document.epoch,
    generated_at: window.document.generatedAt,
    from_ledger: String(window.document.window.from),
    to_ledger: String(window.document.window.to),
    document: JSON.stringify(window.document),
    manifest: window.manifestText,
  };
  await db
    .insertInto("network_windows")
    .values(row)
    .onConflict((conflict) =>
      conflict.columns(["network", "epoch"]).doUpdateSet({
        generated_at: row.generated_at,
        from_ledger: row.from_ledger,
        to_ledger: row.to_ledger,
        document: row.document,
        manifest: row.manifest,
      }),
    )
    .execute();
}

/** The network's current window, or undefined when none is published (the job is off by default). */
export async function loadNetworkWindow(
  db: Kysely<ExplorerDatabase>,
  network: IndexNetwork,
  epoch: string,
): Promise<NetworkWindow | undefined> {
  const row = await db
    .selectFrom("network_windows")
    .select(["document", "manifest"])
    .where("network", "=", network)
    .where("epoch", "=", epoch)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  const document = JSON.parse(row.document) as Partial<NetworkWindowDocument> | null;
  if (document?.scope !== "full" || document.label !== "network-wide (sampled window)") return undefined;
  return { document: document as NetworkWindowDocument, manifestText: row.manifest };
}

/** Refuses an anchor URL a window would publish with a path, query or credentials, which may carry a key. */
function publishableAnchor(value: string): void {
  const url = new URL(value);
  if (
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new Error("a network window publishes its anchor URL, so it must be a bare origin");
  }
}
