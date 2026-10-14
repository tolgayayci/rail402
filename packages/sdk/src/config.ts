import { homedir } from "node:os";
import { join } from "node:path";
import type { EgressPolicyInput } from "@rail402.dev/safe-fetch";
import { PUBNET, TESTNET, isStellarNetwork, type StellarNetwork } from "@rail402.dev/stellar";
import { paymentError, type PaymentError } from "./codes.ts";
import { explorerTemplate, type ExplorerProvider } from "./explorer.ts";
import { SECRET_KEY_ENV, SECRET_KEY_FILE_ENV, expandHome, secretKeySource, type KeySource } from "./keys.ts";
import { parseMoney, type Money } from "./money.ts";
import { NETWORK_DEFAULTS } from "./networks.ts";
import { DEFAULT_SESSION } from "./policy/budget.ts";
import {
  SCHEME_NAMES,
  TRUST_LEVELS,
  type PolicyAssetInput,
  type SchemeName,
  type SpendingPolicyInput,
  type Trust,
} from "./policy/policy.ts";

/**
 * Configuration shared by the rail402 CLI and the rail402-mcp server, read from `RAIL402_*`
 * environment variables with command-line flags taking precedence. It fails fast: an invalid or
 * unsafe value refuses to start instead of being ignored.
 */

export interface AgentFlags {
  readonly network?: string | undefined;
  readonly rpcUrl?: string | undefined;
  readonly bazaarUrl?: string | undefined;
  readonly keyFile?: string | undefined;
  readonly maxPerCall?: string | undefined;
  readonly maxTotal?: string | undefined;
  readonly session?: string | undefined;
  readonly sessionTtl?: string | undefined;
  readonly budgetStore?: string | undefined;
  readonly ledgerPath?: string | undefined;
  readonly allowHttp?: boolean | undefined;
  readonly allowPrivateNetwork?: boolean | undefined;
  readonly explorer?: string | undefined;
}

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
const LOG_LEVELS: readonly LogLevel[] = ["fatal", "error", "warn", "info", "debug", "trace", "silent"];

export interface AgentConfig {
  readonly network: StellarNetwork;
  readonly rpcUrl: string;
  readonly bazaarUrl: string;
  /** Undefined: search-only; paying is refused with `payment_signer_unavailable`. */
  readonly key: KeySource | undefined;
  readonly policy: SpendingPolicyInput;
  readonly session: { readonly name: string; readonly ttlMs: number };
  readonly budgetStore: "sqlite" | "memory";
  /** SQLite ledger file (`budgetStore: "sqlite"`). */
  readonly ledgerPath: string;
  readonly egress: {
    readonly allowHttp: boolean;
    readonly allowPrivateNetwork: false | "loopback";
    /** Seller ports allowed; undefined keeps the default (443, and 80 when http is allowed). */
    readonly ports: readonly number[] | undefined;
  };
  readonly maxInflight: number;
  readonly explorer: ExplorerProvider;
  readonly logLevel: LogLevel;
}

/** `$XDG_STATE_HOME/rail402/ledger.sqlite`, falling back to `~/.local/state/rail402/ledger.sqlite`. */
export function defaultLedgerPath(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const state = env["XDG_STATE_HOME"];
  const base = state?.startsWith("/") === true ? state : join(homedir(), ".local", "state");
  return join(base, "rail402", "ledger.sqlite");
}

/**
 * Resolves the configuration. `RAIL402_SECRET_KEY` is removed from `env` once read, whether or not it
 * is used. Pubnet needs an explicit RPC and Bazaar URL, refuses the http and private-network
 * development switches, and needs caps whenever a key is configured.
 */
export function resolveAgentConfig(
  env: Record<string, string | undefined>,
  flags: AgentFlags = {},
): AgentConfig {
  const read = (name: string): string | undefined => {
    const value = env[name];
    return value === undefined || value.trim() === "" ? undefined : value.trim();
  };

  const secret = env[SECRET_KEY_ENV];
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete env[SECRET_KEY_ENV];

  const networkText = flags.network ?? read("RAIL402_NETWORK") ?? TESTNET;
  if (!isStellarNetwork(networkText)) {
    throw invalid("RAIL402_NETWORK", `network must be "${TESTNET}" or "${PUBNET}".`);
  }
  const network = networkText;
  const pubnet = network === PUBNET;
  const defaults = NETWORK_DEFAULTS[network];

  const rpcUrl = url("RAIL402_RPC_URL", flags.rpcUrl ?? read("RAIL402_RPC_URL") ?? defaults.rpcUrl, pubnet);
  const bazaarUrl = url(
    "RAIL402_BAZAAR_URL",
    flags.bazaarUrl ?? read("RAIL402_BAZAAR_URL") ?? defaults.bazaarUrl,
    pubnet,
  );

  const keyFile = flags.keyFile ?? read(SECRET_KEY_FILE_ENV);
  const key: KeySource | undefined =
    keyFile !== undefined
      ? { secretFile: expandHome(keyFile) }
      : secret !== undefined && secret.trim() !== ""
        ? secretKeySource(secret.trim())
        : undefined;

  const allowHttp = flags.allowHttp ?? bool("RAIL402_ALLOW_HTTP", read("RAIL402_ALLOW_HTTP"), false);
  const privateText = read("RAIL402_ALLOW_PRIVATE_NETWORK");
  const allowPrivateNetwork: false | "loopback" =
    flags.allowPrivateNetwork === true || privateText === "loopback"
      ? "loopback"
      : privateText === undefined || privateText === "false" || flags.allowPrivateNetwork === false
        ? false
        : fail("RAIL402_ALLOW_PRIVATE_NETWORK", 'the only accepted values are "loopback" and "false".');
  if (pubnet && (allowHttp || allowPrivateNetwork !== false)) {
    throw invalid(
      allowHttp ? "RAIL402_ALLOW_HTTP" : "RAIL402_ALLOW_PRIVATE_NETWORK",
      "plain http and private-network destinations are never allowed on pubnet.",
    );
  }

  const portsText = read("RAIL402_ALLOWED_PORTS");
  const ports = portsText === undefined ? undefined : list(portsText).map(port);
  if (pubnet && ports?.some((value) => value !== 443) === true) {
    throw invalid(
      "RAIL402_ALLOWED_PORTS",
      "extra ports are for local development; pubnet sellers are paid on port 443.",
    );
  }

  const policy = policyFrom(read, flags, key !== undefined, pubnet);

  const ttlText = flags.sessionTtl ?? read("RAIL402_SESSION_TTL");
  const session = {
    name: flags.session ?? read("RAIL402_SESSION") ?? DEFAULT_SESSION.name,
    ttlMs: ttlText === undefined ? DEFAULT_SESSION.ttlMs : duration("RAIL402_SESSION_TTL", ttlText),
  };
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(session.name)) {
    throw invalid("RAIL402_SESSION", "a session name is 1-64 letters, digits, dots, dashes or underscores.");
  }

  const storeText = flags.budgetStore ?? read("RAIL402_BUDGET_STORE") ?? "sqlite";
  if (storeText !== "sqlite" && storeText !== "memory") {
    throw invalid("RAIL402_BUDGET_STORE", 'the budget store is "sqlite" or "memory".');
  }
  const ledgerPath = expandHome(flags.ledgerPath ?? read("RAIL402_LEDGER_PATH") ?? defaultLedgerPath(env));

  const inflightText = read("RAIL402_MAX_INFLIGHT") ?? "1";
  const maxInflight = Number(inflightText);
  if (!/^[0-9]+$/.test(inflightText) || maxInflight < 1 || maxInflight > 8) {
    throw invalid("RAIL402_MAX_INFLIGHT", "RAIL402_MAX_INFLIGHT is an integer from 1 to 8.");
  }

  const explorerText = flags.explorer ?? read("RAIL402_EXPLORER") ?? "stellar.expert";
  let explorer: ExplorerProvider;
  if (explorerText === "stellar.expert") {
    explorer = "stellar.expert";
  } else if (explorerText === "rail402") {
    const template = read("RAIL402_EXPLORER_URL");
    if (template === undefined) {
      throw invalid(
        "RAIL402_EXPLORER_URL",
        "the rail402 explorer needs RAIL402_EXPLORER_URL (a template with {hash}).",
      );
    }
    explorer = explorerFrom("RAIL402_EXPLORER_URL", template);
  } else {
    explorer = explorerFrom("RAIL402_EXPLORER", explorerText);
  }

  const logLevel = (read("RAIL402_LOG_LEVEL") ?? "info") as LogLevel;
  if (!LOG_LEVELS.includes(logLevel)) {
    throw invalid("RAIL402_LOG_LEVEL", `the log level is one of ${LOG_LEVELS.join(", ")}.`);
  }

  return {
    network,
    rpcUrl,
    bazaarUrl,
    key,
    policy,
    session,
    budgetStore: storeText,
    ledgerPath,
    egress: { allowHttp, allowPrivateNetwork, ports },
    maxInflight,
    explorer,
    logLevel,
  };
}

function policyFrom(
  read: (name: string) => string | undefined,
  flags: AgentFlags,
  hasKey: boolean,
  pubnet: boolean,
): SpendingPolicyInput {
  const assets: PolicyAssetInput[] = [{ asset: "USDC" }];
  const extra = read("RAIL402_ASSETS");
  if (extra !== undefined) {
    for (const entry of list(extra)) {
      const match = /^([A-Za-z0-9]{1,12}):(C[A-Z2-7]{55}):([0-9]{1,2})$/.exec(entry);
      if (match === null) {
        throw invalid("RAIL402_ASSETS", "each asset is SYMBOL:CONTRACT:DECIMALS, e.g. TEST6:C…:6.");
      }
      const [, symbol = "", contract = "", decimals = "0"] = match;
      assets.push({ asset: contract, symbol, decimals: Number(decimals) });
    }
  }

  const capList = (setting: string, text: string | undefined): Money[] =>
    text === undefined
      ? []
      : list(text).map(
          (item) =>
            parseMoney(item) ??
            fail(setting, 'a cap is a decimal amount and an optional asset, e.g. "0.10 USDC".'),
        );
  const assign = (setting: string, caps: Money[], field: "perCall" | "sessionTotal") => {
    for (const cap of caps) {
      const name = cap.asset ?? "USDC";
      const index = assets.findIndex((asset) => asset.asset === name || asset.symbol === name);
      const target = assets[index];
      if (target === undefined) throw invalid(setting, `${name} is not a configured asset.`);
      assets[index] = { ...target, [field]: cap.amount };
    }
  };
  const perCall = capList("RAIL402_MAX_PER_CALL", flags.maxPerCall ?? read("RAIL402_MAX_PER_CALL"));
  const total = capList("RAIL402_MAX_TOTAL", flags.maxTotal ?? read("RAIL402_MAX_TOTAL"));
  if (pubnet && hasKey && (perCall.length === 0 || total.length === 0)) {
    throw invalid(
      perCall.length === 0 ? "RAIL402_MAX_PER_CALL" : "RAIL402_MAX_TOTAL",
      "pubnet has no default caps: set RAIL402_MAX_PER_CALL and RAIL402_MAX_TOTAL when a key is configured.",
    );
  }
  assign("RAIL402_MAX_PER_CALL", perCall, "perCall");
  assign("RAIL402_MAX_TOTAL", total, "sessionTotal");

  const schemesText = read("RAIL402_SCHEMES");
  const schemes =
    schemesText === undefined
      ? undefined
      : list(schemesText).map((scheme) =>
          SCHEME_NAMES.includes(scheme as SchemeName)
            ? (scheme as SchemeName)
            : fail("RAIL402_SCHEMES", `schemes are a comma-separated list of ${SCHEME_NAMES.join(", ")}.`),
        );
  const uptoContractsText = read("RAIL402_UPTO_CONTRACTS");
  const uptoContracts = uptoContractsText === undefined ? undefined : list(uptoContractsText);
  for (const contract of uptoContracts ?? []) {
    if (!/^C[A-Z2-7]{55}$/.test(contract)) {
      fail("RAIL402_UPTO_CONTRACTS", "upto settlement contracts are C… contract addresses.");
    }
  }
  const facilitatorsText = read("RAIL402_UPTO_FACILITATORS");
  const uptoFacilitators = facilitatorsText === undefined ? undefined : list(facilitatorsText);
  for (const address of uptoFacilitators ?? []) {
    if (!/^[GC][A-Z2-7]{55}$/.test(address)) {
      fail("RAIL402_UPTO_FACILITATORS", "upto settlement authorities are G… or C… addresses.");
    }
  }

  const allow = read("RAIL402_ALLOWED_RECIPIENTS");
  const deny = read("RAIL402_DENIED_RECIPIENTS");
  const requireListing = read("RAIL402_REQUIRE_LISTING");
  const minTrust = read("RAIL402_MIN_TRUST");
  return {
    assets,
    ...(allow === undefined && deny === undefined
      ? {}
      : {
          recipients: {
            ...(allow === undefined ? {} : { allow: list(allow) }),
            ...(deny === undefined ? {} : { deny: list(deny) }),
          },
        }),
    ...(requireListing === undefined
      ? {}
      : { requireCatalogListing: bool("RAIL402_REQUIRE_LISTING", requireListing, false) }),
    ...(minTrust === undefined ? {} : { minTrust: trust(minTrust) }),
    ...(schemes === undefined ? {} : { schemes }),
    ...(uptoContracts === undefined ? {} : { uptoContracts }),
    ...(uptoFacilitators === undefined ? {} : { uptoFacilitators }),
  };
}

function trust(text: string): { http?: Trust; mcp?: Trust } {
  const valid = (value: string): Trust =>
    TRUST_LEVELS.includes(value as Trust)
      ? (value as Trust)
      : fail("RAIL402_MIN_TRUST", `trust is one of ${TRUST_LEVELS.join(", ")}.`);
  if (!text.includes("=")) {
    const level = valid(text);
    return { http: level, mcp: level };
  }
  const result: { http?: Trust; mcp?: Trust } = {};
  for (const part of list(text)) {
    const [kind, level = ""] = part.split("=", 2);
    if (kind === "http") result.http = valid(level);
    else if (kind === "mcp") result.mcp = valid(level);
    else fail("RAIL402_MIN_TRUST", 'use "settled" or "http=origin_verified,mcp=domain_verified".');
  }
  return result;
}

function explorerFrom(setting: string, template: string): ExplorerProvider {
  try {
    return explorerTemplate(template);
  } catch {
    throw invalid(setting, "an explorer template is an https URL containing {hash}.");
  }
}

function url(setting: string, value: string | undefined, pubnet: boolean): string {
  if (value === undefined) throw invalid(setting, `${setting} is required on pubnet.`);
  if (!URL.canParse(value)) throw invalid(setting, `${setting} is not a valid URL.`);
  const protocol = new URL(value).protocol;
  if (protocol !== "https:" && (pubnet || protocol !== "http:")) {
    throw invalid(
      setting,
      `${setting} must use https${pubnet ? " on pubnet" : " (or http for a local network)"}.`,
    );
  }
  return value.replace(/\/+$/, "");
}

function port(text: string): number {
  const value = Number(text);
  if (!/^[0-9]{1,5}$/.test(text) || value < 1 || value > 65_535) {
    throw invalid("RAIL402_ALLOWED_PORTS", "allowed ports are a comma-separated list of 1-65535.");
  }
  return value;
}

/** The egress policy for seller URLs under a configuration. */
export function egressFromConfig(config: Pick<AgentConfig, "egress">): EgressPolicyInput {
  const { allowHttp, allowPrivateNetwork, ports } = config.egress;
  return {
    schemes: allowHttp ? ["https:", "http:"] : ["https:"],
    allowPrivateNetwork,
    ...(ports === undefined ? {} : { ports }),
  };
}

function bool(setting: string, value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return fail(setting, `${setting} is "true" or "false".`);
}

const UNITS: Readonly<Record<string, number>> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** "90s", "30m", "2h" or "1d" in milliseconds; from one minute to 30 days. */
export function duration(setting: string, text: string): number {
  const match = /^([0-9]{1,6})([smhd])$/.exec(text);
  const ms = match === null ? NaN : Number(match[1]) * (UNITS[match[2] ?? ""] ?? NaN);
  if (!Number.isFinite(ms) || ms < 60_000 || ms > 30 * 86_400_000) {
    throw invalid(setting, 'a duration is a number and a unit (s, m, h or d) from 1m to 30d, e.g. "24h".');
  }
  return ms;
}

function list(text: string): string[] {
  return text
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function invalid(setting: string, reason: string): PaymentError {
  return paymentError("payment_policy_invalid", {
    reason: `Invalid configuration: ${reason}`,
    details: { setting },
  });
}

function fail(setting: string, reason: string): never {
  throw invalid(setting, reason);
}
