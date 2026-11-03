import { readFileSync } from "node:fs";
import { lumeusUrl } from "@rail402.dev/ledger-source";
import type { IndexNetwork } from "@rail402.dev/x402-index";
import {
  ExplorerConfigError,
  flag,
  httpsUrl,
  integer,
  lumeusKey,
  rpcTarget,
  secret,
  type Env,
} from "../config.ts";
import { BAZAAR_ACCESS_KEY } from "./bazaar.ts";
import { lookupBudget, type LookupBudget } from "./live-lookup.ts";

export interface NetworkSettings {
  readonly network: IndexNetwork;
  /** The RPC for live lookups of hashes not indexed yet; live lookups are off without one. */
  readonly lookupRpcUrl: string | undefined;
  /**
   * The network's Lumeus key for live lookups (a read-access server key or a publishable key, apart from
   * the indexer's), sent only when `lookupRpcUrl` is its Lumeus RPC. Never logged.
   */
  readonly lookupApiKey: string | undefined;
  /** The public RPC shown in the copy-paste getTransaction command. */
  readonly publicRpcUrl: string;
  /** The Bazaar whose public read API names what payments bought; no Bazaar data when undefined. */
  readonly bazaarUrl: string | undefined;
  /**
   * The network's Lumeus key for live holdings (Lumeus Assets), when they are on. The same key as live
   * lookups; never logged.
   */
  readonly holdingsKey: string | undefined;
  /**
   * The Bazaar's `discovery-internal` access key, so each visitor draws on its own discovery budget;
   * without it every Bazaar call shares the Explorer's address. From a file only; never logged.
   */
  readonly bazaarKey: string | undefined;
}

export interface WebConfig {
  readonly databaseUrl: string;
  readonly host: string;
  readonly port: number;
  readonly networks: readonly NetworkSettings[];
  readonly lookup: LookupBudget;
  readonly ratePerMinute: number;
  readonly trustedProxyHops: number;
  /** Requests served at once before answering 503. */
  readonly maxInFlight: number;
  readonly reportRefreshSeconds: number;
  /** Where service availability is reported; the report links to it. */
  readonly statusUrl: string | undefined;
  /** The Explorer's own public origin, for links in API answers and snapshots. */
  readonly publicUrl: string;
  readonly facilitatorDatabase: string;
  /** Testnet only: run under a role the startup check would refuse (local development). */
  readonly allowUnsafeRole: boolean;
  readonly metricsHost: string;
  readonly metricsPort: number;
  /** Per Bazaar call. */
  readonly bazaarTimeoutMs: number;
  /** How long Bazaar answers are kept. */
  readonly bazaarCacheSeconds: number;
  /** Lumeus Assets calls per minute per network, across all visitors. */
  readonly holdingsPerMinute: number;
}

const DEFAULT_RPC: Readonly<Record<IndexNetwork, string | undefined>> = {
  "stellar:testnet": "https://soroban-testnet.stellar.org",
  "stellar:pubnet": undefined,
};
const DEFAULT_PUBLIC_RPC: Readonly<Record<IndexNetwork, string>> = {
  "stellar:testnet": "https://soroban-testnet.stellar.org",
  "stellar:pubnet": "https://mainnet.sorobanrpc.com",
};

const DEFAULT_BAZAAR: Readonly<Record<IndexNetwork, string | undefined>> = {
  "stellar:testnet": "https://testnet.rail402.dev",
  "stellar:pubnet": undefined,
};
/** Live holdings are on by default where Lumeus testnet requests are free; pubnet needs an explicit yes. */
const DEFAULT_HOLDINGS: Readonly<Record<IndexNetwork, boolean>> = {
  "stellar:testnet": true,
  "stellar:pubnet": false,
};

/** A Bazaar URL: an https origin, never a path (which would be dropped from every route). */
function bazaarOrigin(name: string, value: string): string {
  const url = new URL(httpsUrl(name, value));
  if (
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new ExplorerConfigError("config_invalid", `${name} is an https origin, without a path`);
  }
  return url.origin;
}

/** The Bazaar access key of `<prefix>_BAZAAR_KEY_FILE`; an inline `<prefix>_BAZAAR_KEY` is refused. */
function bazaarKey(env: Env, prefix: string): string | undefined {
  if ((env[`${prefix}_BAZAAR_KEY`] ?? "") !== "") {
    throw new ExplorerConfigError(
      "config_secret_inline",
      `${prefix}_BAZAAR_KEY is refused: put the key in a file and name it in ${prefix}_BAZAAR_KEY_FILE`,
    );
  }
  const file = env[`${prefix}_BAZAAR_KEY_FILE`];
  if (file === undefined || file === "") return undefined;
  let key: string;
  try {
    key = readFileSync(file, "utf8").trim();
  } catch {
    throw new ExplorerConfigError("config_secret_unreadable", `${prefix}_BAZAAR_KEY_FILE cannot be read`);
  }
  if (!BAZAAR_ACCESS_KEY.test(key)) {
    throw new ExplorerConfigError(
      "config_invalid",
      `${prefix}_BAZAAR_KEY_FILE does not hold an r402_ access key`,
    );
  }
  return key;
}

const optionalHttps = (env: Env, name: string, fallback: string | undefined) => {
  const raw = env[name];
  const value = raw === undefined || raw === "" ? fallback : raw;
  return value === undefined ? undefined : httpsUrl(name, value);
};

/**
 * Reads the web role's settings. Pubnet fails closed: live lookups need an explicit RPC URL, and the
 * process never runs under a role the startup check refuses while pubnet is served.
 */
export function webConfig(env: Env): WebConfig {
  const databaseUrl = secret(env, "EXPLORER_DATABASE_URL");
  if (databaseUrl === undefined) {
    throw new ExplorerConfigError("config_database_missing", "EXPLORER_DATABASE_URL (or _FILE) is required");
  }
  const names = (env["EXPLORER_NETWORKS"] ?? "testnet,pubnet")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  if (names.length === 0 || names.some((name) => name !== "testnet" && name !== "pubnet")) {
    throw new ExplorerConfigError("config_invalid", "EXPLORER_NETWORKS lists testnet and/or pubnet");
  }
  const networks = [...new Set(names)].map((name): NetworkSettings => {
    const network: IndexNetwork = name === "pubnet" ? "stellar:pubnet" : "stellar:testnet";
    const prefix = `EXPLORER_${name.toUpperCase()}`;
    // With the network's Lumeus key, lookups default to its Lumeus RPC; another RPC never gets the key.
    const key = lumeusKey(env, prefix, network, { publishable: true });
    const raw = env[`${prefix}_LOOKUP_RPC_URL`];
    const chosen =
      raw !== undefined && raw !== ""
        ? raw
        : key !== undefined
          ? lumeusUrl(network, "rpc")
          : DEFAULT_RPC[network];
    const target = chosen === undefined ? undefined : rpcTarget(`${prefix}_LOOKUP_RPC_URL`, chosen, network);
    const rawBazaar = env[`${prefix}_BAZAAR_URL`];
    const bazaar =
      rawBazaar === "off"
        ? undefined
        : rawBazaar !== undefined && rawBazaar !== ""
          ? bazaarOrigin(`${prefix}_BAZAAR_URL`, rawBazaar)
          : DEFAULT_BAZAAR[network];
    const rawHoldings = env[`${prefix}_HOLDINGS`];
    if (rawHoldings !== undefined && rawHoldings !== "" && rawHoldings !== "on" && rawHoldings !== "off") {
      throw new ExplorerConfigError("config_invalid", `${prefix}_HOLDINGS is on or off`);
    }
    const holdings = rawHoldings === "on" ? true : rawHoldings === "off" ? false : DEFAULT_HOLDINGS[network];
    return {
      network,
      bazaarUrl: bazaar?.replace(/\/+$/, ""),
      holdingsKey: holdings ? key : undefined,
      bazaarKey: bazaar === undefined ? undefined : bazaarKey(env, prefix),
      lookupRpcUrl: target?.url,
      lookupApiKey: target?.lumeus === true ? key : undefined,
      publicRpcUrl:
        optionalHttps(env, `${prefix}_PUBLIC_RPC_URL`, DEFAULT_PUBLIC_RPC[network]) ??
        DEFAULT_PUBLIC_RPC[network],
    };
  });
  const allowUnsafeRole = flag(env, "EXPLORER_ALLOW_UNSAFE_ROLE");
  if (allowUnsafeRole && networks.some((entry) => entry.network === "stellar:pubnet")) {
    throw new ExplorerConfigError(
      "config_invalid",
      "EXPLORER_ALLOW_UNSAFE_ROLE is refused while pubnet is served",
    );
  }
  const publicUrl = (optionalHttps(env, "EXPLORER_PUBLIC_URL", "https://explorer.rail402.dev") ?? "").replace(
    /\/+$/,
    "",
  );
  return {
    databaseUrl,
    host: env["EXPLORER_HOST"] ?? "0.0.0.0",
    port: integer(env, "EXPLORER_PORT", 8080, 1) ?? 8080,
    networks,
    lookup: {
      perClientPerMinute:
        integer(env, "EXPLORER_LOOKUP_PER_CLIENT_PER_MINUTE", lookupBudget.perClientPerMinute, 1) ??
        lookupBudget.perClientPerMinute,
      globalPerMinute:
        integer(env, "EXPLORER_LOOKUP_GLOBAL_PER_MINUTE", lookupBudget.globalPerMinute, 1) ??
        lookupBudget.globalPerMinute,
      negativeTtlMs:
        (integer(env, "EXPLORER_LOOKUP_NEGATIVE_TTL_SECONDS", lookupBudget.negativeTtlMs / 1000, 1) ?? 20) *
        1000,
    },
    ratePerMinute: integer(env, "EXPLORER_RATE_LIMIT_PER_MINUTE", 120, 1) ?? 120,
    trustedProxyHops: integer(env, "EXPLORER_TRUSTED_PROXY_HOPS", 0) ?? 0,
    maxInFlight: integer(env, "EXPLORER_MAX_IN_FLIGHT", 32, 1) ?? 32,
    reportRefreshSeconds: integer(env, "EXPLORER_REPORT_REFRESH_SECONDS", 30, 5) ?? 30,
    statusUrl: optionalHttps(env, "EXPLORER_STATUS_URL", undefined),
    publicUrl,
    facilitatorDatabase: env["EXPLORER_FACILITATOR_DATABASE"] ?? "rail402",
    allowUnsafeRole,
    metricsHost: env["EXPLORER_METRICS_HOST"] ?? "127.0.0.1",
    metricsPort: integer(env, "EXPLORER_METRICS_PORT", 9465) ?? 9465,
    bazaarTimeoutMs: integer(env, "EXPLORER_BAZAAR_TIMEOUT_MS", 2_500, 100) ?? 2_500,
    bazaarCacheSeconds: integer(env, "EXPLORER_BAZAAR_CACHE_SECONDS", 60, 1) ?? 60,
    holdingsPerMinute: integer(env, "EXPLORER_HOLDINGS_PER_MINUTE", 30, 1) ?? 30,
  };
}
