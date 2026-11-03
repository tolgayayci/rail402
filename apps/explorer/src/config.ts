import { readFileSync } from "node:fs";
import {
  LedgerSourceError,
  checkLumeusKey,
  lumeusEndpoint,
  lumeusHostNetwork,
  lumeusUrl,
  LUMEUS_MAX_CONCURRENCY,
} from "@rail402.dev/ledger-source";
import type { IndexNetwork } from "@rail402.dev/x402-index";

/** A setting is missing or invalid. The process exits with code 78 (configuration error). */
export class ExplorerConfigError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ExplorerConfigError";
    this.code = code;
  }
}

export interface IndexerConfig {
  readonly network: IndexNetwork;
  readonly databaseUrl: string;
  /** When set, the indexer migrates the database with this (owner) URL before it starts. */
  readonly migrationDatabaseUrl: string | undefined;
  readonly fromLedger: number | undefined;
  readonly toLedger: number | undefined;
  /** The Lumeus server key of this network, read from EXPLORER_LUMEUS_KEY_FILE. Never logged. */
  readonly lumeusKey: string;
  /** Lumeus Activity, the discovery source. */
  readonly activityUrl: string;
  /** RPC `getLedgers` for ledgers inside its retention; the Lumeus key goes only to a Lumeus RPC host. */
  readonly rpcUrl: string;
  /** Whether `rpcUrl` is this network's Lumeus RPC (and so gets the key). */
  readonly rpcIsLumeus: boolean;
  /** Most ledgers per `getLedgers` call. */
  readonly rpcPageLedgers: number;
  /** Ledgers kept clear of the RPC retention's oldest edge. */
  readonly retentionMarginLedgers: number;
  /** Horizon with full history for independent ledger-hash anchors; undefined only on testnet with "off". */
  readonly anchorHorizonUrl: string | undefined;
  readonly facilitatorDatabase: string;
  /** Testnet only: run under a role the startup check would refuse (local development). */
  readonly allowUnsafeRole: boolean;
  readonly healthHost: string;
  readonly healthPort: number;
  readonly maxLagLedgers: number;
  /** Raw ledger bytes held at once, fetched and not yet decoded, in MiB. */
  readonly bytesInFlightMib: number;
  /** Lumeus requests, routes walked and ledgers anchored at once (at most 8). */
  readonly concurrency: number;
  /** Ledgers per discovery window. */
  readonly windowLedgers: number;
  /** New candidate ledgers one route may add per round; the rest waits for the next round. */
  readonly maxCandidatesPerRound: number;
  /** At the head, routes of non-fee-paying roles (channels, upto authorities) are walked every this many rounds. */
  readonly slowRouteRounds: number;
  /** Wait between rounds at the head. */
  readonly pollSeconds: number;
  /** How often the indexer computes and publishes the report; 0 turns it off. */
  readonly reportRefreshSeconds: number;
}

/** Where the pubnet index starts by default: the data lake partition before the first x402 settlements. */
export const PUBNET_DEFAULT_FROM = 61_440_000;
const TESTNET_HORIZON = "https://horizon-testnet.stellar.org";

export type Env = Readonly<Record<string, string | undefined>>;

export function secret(env: Env, name: string): string | undefined {
  const file = env[`${name}_FILE`];
  if (file !== undefined && file !== "") {
    try {
      return readFileSync(file, "utf8").trim();
    } catch {
      throw new ExplorerConfigError("config_secret_unreadable", `${name}_FILE cannot be read`);
    }
  }
  const value = env[name];
  return value === undefined || value === "" ? undefined : value;
}

/**
 * The Lumeus key of `network`, from the file named by `<prefix>_LUMEUS_KEY_FILE` only: a key set inline
 * in the environment is refused, since environments leak into process listings and logs. The key's shape
 * and network are checked (a publishable key only with `publishable`); no error repeats it.
 */
export function lumeusKey(
  env: Env,
  prefix: string,
  network: IndexNetwork,
  options: { readonly publishable?: boolean } = {},
): string | undefined {
  if ((env[`${prefix}_LUMEUS_KEY`] ?? "") !== "") {
    throw new ExplorerConfigError(
      "config_secret_inline",
      `${prefix}_LUMEUS_KEY is refused: put the key in a file and name it in ${prefix}_LUMEUS_KEY_FILE`,
    );
  }
  const file = env[`${prefix}_LUMEUS_KEY_FILE`];
  if (file === undefined || file === "") return undefined;
  let key: string;
  try {
    key = readFileSync(file, "utf8").trim();
  } catch {
    throw new ExplorerConfigError("config_secret_unreadable", `${prefix}_LUMEUS_KEY_FILE cannot be read`);
  }
  try {
    checkLumeusKey(key, network, options);
  } catch (error) {
    throw new ExplorerConfigError(
      "config_lumeus_key_invalid",
      `${prefix}_LUMEUS_KEY_FILE: ${error instanceof Error ? error.message : "invalid"}`,
    );
  }
  return key;
}

/**
 * An RPC URL that may receive the Lumeus key: any https URL, but a Lumeus host must be the one of
 * `network` (a testnet key never goes to a mainnet host, nor the reverse). Returns whether it is Lumeus.
 */
export function rpcTarget(
  name: string,
  value: string,
  network: IndexNetwork,
): { url: string; lumeus: boolean } {
  const url = httpsUrl(name, value);
  const host = new URL(url).host;
  const hostNetwork = lumeusHostNetwork(host);
  if (hostNetwork === undefined) return { url, lumeus: false };
  try {
    lumeusEndpoint(value.replace(/\/+$/, ""), network, "rpc");
  } catch (error) {
    throw new ExplorerConfigError(
      "config_invalid",
      `${name}: ${error instanceof LedgerSourceError ? error.message : "not this network's Lumeus RPC"}`,
    );
  }
  return { url, lumeus: true };
}

export function integer(env: Env, name: string, fallback: number | undefined, min = 0): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+$/.test(raw) || Number(raw) < min || !Number.isSafeInteger(Number(raw))) {
    throw new ExplorerConfigError("config_invalid", `${name} must be an integer ≥ ${String(min)}`);
  }
  return Number(raw);
}

export function flag(env: Env, name: string): boolean {
  const raw = env[name];
  if (raw === undefined || raw === "" || raw === "false") return false;
  if (raw === "true") return true;
  throw new ExplorerConfigError("config_invalid", `${name} must be true or false`);
}

export function httpsUrl(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ExplorerConfigError("config_invalid", `${name} is not a URL`);
  }
  if (url.protocol !== "https:") throw new ExplorerConfigError("config_invalid", `${name} must be https`);
  return url.toString();
}

/**
 * Reads the indexer's settings. It needs this network's Lumeus key in a file. Pubnet fails closed: it
 * needs independent anchors and never runs under a role the startup check refuses.
 */
export function indexerConfig(env: Env): IndexerConfig {
  const networkName = env["EXPLORER_NETWORK"];
  if (networkName !== "testnet" && networkName !== "pubnet") {
    throw new ExplorerConfigError("config_network_missing", "EXPLORER_NETWORK must be testnet or pubnet");
  }
  const network: IndexNetwork = networkName === "pubnet" ? "stellar:pubnet" : "stellar:testnet";
  const databaseUrl = secret(env, "EXPLORER_DATABASE_URL");
  if (databaseUrl === undefined) {
    throw new ExplorerConfigError("config_database_missing", "EXPLORER_DATABASE_URL (or _FILE) is required");
  }
  const key = lumeusKey(env, "EXPLORER", network);
  if (key === undefined) {
    throw new ExplorerConfigError(
      "config_lumeus_key_missing",
      "EXPLORER_LUMEUS_KEY_FILE (a file holding this network's Lumeus server key) is required: discovery reads Lumeus Activity",
    );
  }
  const activity = env["EXPLORER_LUMEUS_API_URL"];
  const activityUrl = activity === undefined || activity === "" ? lumeusUrl(network, "activity") : activity;
  try {
    lumeusEndpoint(activityUrl.replace(/\/+$/, ""), network, "activity");
  } catch (error) {
    throw new ExplorerConfigError(
      "config_invalid",
      `EXPLORER_LUMEUS_API_URL: ${error instanceof LedgerSourceError ? error.message : "invalid"}`,
    );
  }
  const rpc = env["EXPLORER_RPC_URL"];
  const target = rpcTarget(
    "EXPLORER_RPC_URL",
    rpc === undefined || rpc === "" ? lumeusUrl(network, "rpc") : rpc,
    network,
  );
  const anchor = env["EXPLORER_ANCHOR_HORIZON_URL"];
  if ((anchor === undefined || anchor === "" || anchor === "off") && network === "stellar:pubnet") {
    throw new ExplorerConfigError(
      "config_anchor_missing",
      "EXPLORER_ANCHOR_HORIZON_URL (a Horizon with full history) is required on pubnet",
    );
  }
  const anchorHorizonUrl =
    anchor === "off"
      ? undefined
      : httpsUrl(
          "EXPLORER_ANCHOR_HORIZON_URL",
          anchor === undefined || anchor === "" ? TESTNET_HORIZON : anchor,
        );
  const allowUnsafeRole = flag(env, "EXPLORER_ALLOW_UNSAFE_ROLE");
  if (allowUnsafeRole && network === "stellar:pubnet") {
    throw new ExplorerConfigError("config_invalid", "EXPLORER_ALLOW_UNSAFE_ROLE is refused on pubnet");
  }
  const fromLedger = integer(
    env,
    "EXPLORER_FROM_LEDGER",
    network === "stellar:pubnet" ? PUBNET_DEFAULT_FROM : undefined,
    1,
  );
  const toLedger = integer(env, "EXPLORER_TO_LEDGER", undefined, 1);
  if (fromLedger !== undefined && toLedger !== undefined && toLedger < fromLedger) {
    throw new ExplorerConfigError("config_invalid", "EXPLORER_TO_LEDGER precedes EXPLORER_FROM_LEDGER");
  }
  // Lumeus getLedgers: 100 testnet ledgers stay far below its 64 MiB answer cap; mainnet allows 20.
  const maxPage = network === "stellar:pubnet" ? 20 : 100;
  const rpcPageLedgers = integer(env, "EXPLORER_RPC_PAGE_LEDGERS", maxPage, 1) ?? maxPage;
  if (rpcPageLedgers > maxPage) {
    throw new ExplorerConfigError(
      "config_invalid",
      `EXPLORER_RPC_PAGE_LEDGERS must be at most ${String(maxPage)}`,
    );
  }
  const concurrency =
    integer(env, "EXPLORER_CONCURRENCY", LUMEUS_MAX_CONCURRENCY, 1) ?? LUMEUS_MAX_CONCURRENCY;
  if (concurrency > LUMEUS_MAX_CONCURRENCY) {
    throw new ExplorerConfigError(
      "config_invalid",
      `EXPLORER_CONCURRENCY must be at most ${String(LUMEUS_MAX_CONCURRENCY)} (Lumeus requests in flight)`,
    );
  }
  return {
    network,
    databaseUrl,
    migrationDatabaseUrl: secret(env, "EXPLORER_MIGRATION_DATABASE_URL"),
    fromLedger,
    toLedger,
    lumeusKey: key,
    activityUrl: activityUrl.replace(/\/+$/, ""),
    rpcUrl: target.url,
    rpcIsLumeus: target.lumeus,
    rpcPageLedgers,
    retentionMarginLedgers: integer(env, "EXPLORER_RETENTION_MARGIN_LEDGERS", 120) ?? 120,
    anchorHorizonUrl,
    facilitatorDatabase: env["EXPLORER_FACILITATOR_DATABASE"] ?? "rail402",
    allowUnsafeRole,
    healthHost: env["EXPLORER_HEALTH_HOST"] ?? "127.0.0.1",
    healthPort: integer(env, "EXPLORER_HEALTH_PORT", 9464) ?? 9464,
    maxLagLedgers: integer(env, "EXPLORER_MAX_LAG_LEDGERS", 120, 1) ?? 120,
    concurrency,
    bytesInFlightMib: integer(env, "EXPLORER_BYTES_IN_FLIGHT_MIB", 64, 8) ?? 64,
    windowLedgers: integer(env, "EXPLORER_DISCOVERY_WINDOW_LEDGERS", 500_000, 1) ?? 500_000,
    maxCandidatesPerRound: integer(env, "EXPLORER_MAX_CANDIDATES_PER_ROUND", 20_000, 1) ?? 20_000,
    slowRouteRounds: integer(env, "EXPLORER_SLOW_ROUTE_ROUNDS", 20, 1) ?? 20,
    pollSeconds: integer(env, "EXPLORER_POLL_SECONDS", 15, 1) ?? 15,
    reportRefreshSeconds: integer(env, "EXPLORER_REPORT_REFRESH_SECONDS", 300) ?? 300,
  };
}

export interface NetworkWindowConfig {
  readonly network: IndexNetwork;
  /** The window in hours; 0 turns the job off (the default). */
  readonly hours: number;
  readonly databaseUrl: string;
  readonly migrationDatabaseUrl: string | undefined;
  readonly facilitatorDatabase: string;
  /** Testnet only: run under a role the startup check would refuse (local development). */
  readonly allowUnsafeRole: boolean;
  /** Hours between runs. */
  readonly everyHours: number;
  /** Longest one run may take; past it the run stops and the last window stays published. */
  readonly maxSeconds: number;
  /** Most ledger bytes one run may download from the data lake. */
  readonly maxDownloadMib: number;
  /** Most settlement rows one window may hold. */
  readonly maxRows: number;
  /** Raw ledger bytes held at once, fetched and not yet decoded, in MiB. */
  readonly bytesInFlightMib: number;
  /** Data lake requests in flight. */
  readonly concurrency: number;
  /** Horizon with full history whose hashes anchor both ends of the window; undefined only on testnet with "off". */
  readonly anchorHorizonUrl: string | undefined;
  /**
   * The Horizon the published window names (`anchorHorizon` and `--anchor-horizon` in its rebuild command):
   * EXPLORER_NETWORK_WINDOW_PUBLIC_ANCHOR_URL, or the anchor itself when its path is `/`. Never a URL with a
   * path, which may carry a provider key.
   */
  readonly publicAnchorHorizonUrl: string | undefined;
  /** Where a run writes its rebuild files; removed when the run ends. */
  readonly workDir: string;
}

/**
 * Reads the network window job's settings. Off unless EXPLORER_NETWORK_WINDOW_HOURS is set. Pubnet fails
 * closed: a pubnet window needs an explicit download budget and independent anchors, and never runs under
 * a role the startup check refuses.
 */
export function networkWindowConfig(env: Env, defaults: { readonly workDir: string }): NetworkWindowConfig {
  const networkName = env["EXPLORER_NETWORK"];
  if (networkName !== "testnet" && networkName !== "pubnet") {
    throw new ExplorerConfigError("config_network_missing", "EXPLORER_NETWORK must be testnet or pubnet");
  }
  const network: IndexNetwork = networkName === "pubnet" ? "stellar:pubnet" : "stellar:testnet";
  const pubnet = network === "stellar:pubnet";
  const hours = integer(env, "EXPLORER_NETWORK_WINDOW_HOURS", 0) ?? 0;
  if (hours > 168) {
    throw new ExplorerConfigError(
      "config_invalid",
      "EXPLORER_NETWORK_WINDOW_HOURS must be at most 168 (7 days)",
    );
  }
  const databaseUrl = secret(env, "EXPLORER_DATABASE_URL");
  if (hours > 0 && databaseUrl === undefined) {
    throw new ExplorerConfigError("config_database_missing", "EXPLORER_DATABASE_URL (or _FILE) is required");
  }
  const download = integer(env, "EXPLORER_NETWORK_WINDOW_MAX_DOWNLOAD_MIB", pubnet ? undefined : 8192, 1);
  if (hours > 0 && download === undefined) {
    throw new ExplorerConfigError(
      "config_window_budget_missing",
      "EXPLORER_NETWORK_WINDOW_MAX_DOWNLOAD_MIB is required for a pubnet window: pubnet ledgers are large, so the bytes one run may download must be set explicitly",
    );
  }
  const anchor = env["EXPLORER_ANCHOR_HORIZON_URL"];
  if ((anchor === undefined || anchor === "" || anchor === "off") && pubnet && hours > 0) {
    throw new ExplorerConfigError(
      "config_anchor_missing",
      "EXPLORER_ANCHOR_HORIZON_URL (a Horizon with full history) is required on pubnet",
    );
  }
  const anchorHorizonUrl =
    anchor === "off"
      ? undefined
      : httpsUrl(
          "EXPLORER_ANCHOR_HORIZON_URL",
          anchor === undefined || anchor === "" ? TESTNET_HORIZON : anchor,
        );
  const publicAnchorHorizonUrl = hours > 0 ? publicAnchor(env, anchorHorizonUrl) : undefined;
  const allowUnsafeRole = flag(env, "EXPLORER_ALLOW_UNSAFE_ROLE");
  if (allowUnsafeRole && pubnet) {
    throw new ExplorerConfigError("config_invalid", "EXPLORER_ALLOW_UNSAFE_ROLE is refused on pubnet");
  }
  const concurrency = integer(env, "EXPLORER_NETWORK_WINDOW_CONCURRENCY", 4, 1) ?? 4;
  if (concurrency > 16) {
    throw new ExplorerConfigError("config_invalid", "EXPLORER_NETWORK_WINDOW_CONCURRENCY must be at most 16");
  }
  const workDir = env["EXPLORER_NETWORK_WINDOW_DIR"];
  return {
    network,
    hours,
    databaseUrl: databaseUrl ?? "",
    migrationDatabaseUrl: secret(env, "EXPLORER_MIGRATION_DATABASE_URL"),
    facilitatorDatabase: env["EXPLORER_FACILITATOR_DATABASE"] ?? "rail402",
    allowUnsafeRole,
    everyHours: integer(env, "EXPLORER_NETWORK_WINDOW_EVERY_HOURS", 24, 1) ?? 24,
    maxSeconds: integer(env, "EXPLORER_NETWORK_WINDOW_MAX_SECONDS", 3600, 60) ?? 3600,
    maxDownloadMib: download ?? 0,
    maxRows: integer(env, "EXPLORER_NETWORK_WINDOW_MAX_ROWS", 500_000, 1) ?? 500_000,
    bytesInFlightMib: integer(env, "EXPLORER_NETWORK_WINDOW_BYTES_IN_FLIGHT_MIB", 32, 8) ?? 32,
    concurrency,
    anchorHorizonUrl,
    publicAnchorHorizonUrl,
    workDir: workDir === undefined || workDir === "" ? defaults.workDir : workDir,
  };
}

/**
 * The Horizon a published window names. The anchor Rail402 reads may be a paid provider whose key sits in
 * the URL path, so a window names only a URL whose path is `/`: the operator's public anchor, or else the
 * anchor itself. An anchor with a path and no public anchor is refused at startup.
 */
function publicAnchor(env: Env, anchor: string | undefined): string | undefined {
  if (anchor === undefined) return undefined;
  const declared = env["EXPLORER_NETWORK_WINDOW_PUBLIC_ANCHOR_URL"];
  if (declared !== undefined && declared !== "") {
    const url = new URL(httpsUrl("EXPLORER_NETWORK_WINDOW_PUBLIC_ANCHOR_URL", declared));
    if (
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.pathname !== "/"
    ) {
      throw new ExplorerConfigError(
        "config_invalid",
        "EXPLORER_NETWORK_WINDOW_PUBLIC_ANCHOR_URL is published: it must be a bare origin, with no path, query or credentials",
      );
    }
    return url.toString();
  }
  const url = new URL(anchor);
  if (url.pathname !== "/" || url.search !== "" || url.username !== "" || url.password !== "") {
    throw new ExplorerConfigError(
      "config_anchor_not_public",
      "EXPLORER_ANCHOR_HORIZON_URL has a path, which may carry a provider key, and a window publishes the Horizon it names: set EXPLORER_NETWORK_WINDOW_PUBLIC_ANCHOR_URL to a public full-history Horizon",
    );
  }
  return anchor;
}
