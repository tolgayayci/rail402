import { createHash } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { PUBNET, TESTNET, USDC, isStellarNetwork, type StellarNetwork } from "@rail402.dev/stellar";
import {
  DEFAULT_EXPIRATION_MARGIN_LEDGERS,
  DEFAULT_TIMEOUT_SECONDS,
  MIN_INCLUSION_FEE_STROOPS,
  PUBNET_MIN_INCLUSION_FEE_STROOPS,
  RECONCILE_MARGIN_MS,
  acceptedAsset,
  type AcceptedAsset,
} from "@rail402.dev/facilitator";
import { UPTO_DEPLOYMENTS, minTimeoutSecondsFor, type ZeroSettlementMode } from "@rail402.dev/upto";
import { ConfigError } from "./config-error.ts";
import { resolveSecret, sponsorSeedFrom } from "./secrets.ts";
import {
  parseAccessKeys,
  readAccessKeyFile,
  xlmToStroops,
  type AccessKeyRecord,
  type AccessKeyRules,
} from "./access.ts";

export { ConfigError, configFailureLine } from "./config-error.ts";
// --- discovery settings (DISCOVERY) ---
import { loadDiscoveryConfig, type DiscoveryConfig } from "./discovery-config.ts";
// --- end discovery settings ---

/**
 * Service configuration, read once from the environment and validated before anything starts.
 * A missing credential, an unsafe mainnet setting or a malformed value stops the process with a
 * message naming the variable; nothing is guessed.
 */
export interface Config {
  readonly port: number;
  readonly host: string;
  readonly logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  readonly store:
    | {
        readonly kind: "postgres";
        readonly url: string;
        /** How long a query waits for a pooled connection before it fails (DATABASE_ACQUIRE_TIMEOUT_MS). */
        readonly acquireTimeoutMs: number;
      }
    | { readonly kind: "memory" };
  readonly migrations: {
    /** Apply pending migrations at startup; otherwise refuse to start while one is pending. */
    readonly onStart: boolean;
    /**
     * The connection migrations run through (a role that owns the schema), when it differs from the
     * service's own; `node dist/migrate.js` uses it too.
     */
    readonly url: string | undefined;
  };
  readonly networks: readonly NetworkConfig[];
  readonly http: {
    readonly bodyLimitBytes: number;
    /**
     * How long a response may take to reach its client once its handler has answered; the
     * connection of a client that has not taken it by then is reset.
     */
    readonly responseWriteTimeoutMs: number;
    /**
     * Requests one connection may have waiting for their responses to be sent; a client that pipelines
     * more is reset.
     */
    readonly maxPipelinedRequests: number;
    /** Requests per minute per client IP; 0 disables. */
    readonly rateLimitPerMinute: number;
    /** Trust X-Forwarded-For from this many proxy hops (0 when it is reached directly). */
    readonly trustedProxyHops: number;
  };
  readonly auth: {
    /** SHA-256 hex digests of accepted API keys (`API_KEY_SHA256`, single-network deployments). */
    readonly apiKeyHashes: ReadonlySet<string>;
    /**
     * The access-key file, re-read when it changes: `API_KEYS_FILE`, or `keys.json` in `API_KEYS_DIR`
     * (a directory mount, in which a file replaced by rename is seen; a single-file mount is not).
     */
    readonly keysFile: string | undefined;
    /** The variable that named `keysFile`, for error messages. */
    readonly keysSource: "API_KEYS_FILE" | "API_KEYS_DIR";
    /** The keys of `keysFile` as read at startup. */
    readonly keys: readonly AccessKeyRecord[];
    readonly rules: AccessKeyRules;
    /** Discovery requests per minute of a `discovery-internal` key whose record sets none. */
    readonly discoveryInternalPerMinute: number;
  };
  /** Access keys issued to signed-in GitHub accounts (`KEY_SIGNUP=github`); undefined when off. */
  readonly keySignup: KeySignupConfig | undefined;
  readonly observability: {
    /** SHA-256 hex digest of the bearer token /metrics requires; public when unset. */
    readonly metricsTokenSha256: string | undefined;
    /**
     * SHA-256 hex digest of the bearer token `/metrics/private` and `/health/private` require; both are
     * not served when unset. Required with pubnet, whose budget figures only these paths show.
     */
    readonly metricsPrivateTokenSha256: string | undefined;
    /** Committed fees at this share of an hourly budget raise a `/health` warning. */
    readonly budgetWarnPercent: number;
    readonly contractTtl: {
      readonly pollMs: number;
      /** A watched contract with fewer ledgers left is a /health warning. */
      readonly warnLedgers: number;
      /** A watched contract with fewer ledgers left makes /health report `degraded`. */
      readonly criticalLedgers: number;
    };
  };
  /**
   * Host-scoped views: a request whose `Host` is listed sees only that network in `/supported`, and
   * `/verify` and `/settle` for another network are refused. Unlisted hosts see every network.
   */
  readonly publicHosts: ReadonlyMap<string, StellarNetwork>;
  readonly shutdownGraceMs: number;
  readonly reconcileIntervalMs: number;
  readonly settlement: {
    /** How long a settle request waits for a free channel account. */
    readonly channelWaitMs: number;
    /** How long a settle request waits for confirmation before answering `settlement_pending`. */
    readonly confirmTimeoutMs: number;
    /**
     * How long after its envelope was recorded a settlement is left to the request confirming it, on
     * any replica, before the reconciler drives it.
     */
    readonly reconcileIdleMs: number;
    /**
     * How long a channel stays out of rotation after another transaction took its sequence number,
     * doubled for each further conflict in a row.
     */
    readonly channelQuarantineMs: number;
    /** Answer a payment another party's transaction landed first, exactly as signed, as settled there. */
    readonly reconcileThirdParty: boolean;
  };
  /** Price per successful settlement charged to API-key holders, in US dollars (metered, billed off-chain). */
  readonly serviceFeePerSettlementUsd: string;
  readonly bazaar: {
    readonly enabled: boolean;
    /** Catalog and fetch loopback resources. For conformance runs on a local network only. */
    readonly allowLoopback: boolean;
    readonly originCheckIntervalMs: number;
  };
  readonly search: {
    /** Semantic search with the local embedding model; without it search is lexical-only. */
    readonly embeddings: boolean;
    readonly modelDirectory: string;
    /** Download the pinned model when it is not in modelDirectory (development convenience). */
    readonly modelDownload: boolean;
    /** Shared by every replica so cursors survive restarts and load balancing; random when unset. */
    readonly cursorSecret: Buffer | undefined;
    readonly similarityFloor: number;
  };
  // --- discovery settings (DISCOVERY) ---
  /** The Bazaar's per-network catalog policy and the discovery limits. */
  readonly discovery: DiscoveryConfig;
  // --- end discovery settings ---
}

export interface NetworkConfig {
  readonly network: StellarNetwork;
  /** The first RPC provider's URL. */
  readonly rpcUrl: string;
  /** The RPC providers in order of preference; the first is the primary. */
  readonly rpcProviders: readonly { readonly alias: string; readonly url: string }[];
  readonly sponsorSecret: string;
  readonly channelCount: number;
  readonly assets: readonly AcceptedAsset[];
  /** The variable the assets come from (`TESTNET_ASSETS`), named in errors about them. */
  readonly assetsVariable: string;
  readonly maxTransactionFeeStroops: number;
  readonly inclusionFeeStroops: number;
  readonly expirationMarginLedgers: number;
  readonly timeoutSeconds: { readonly min: number; readonly max: number };
  /** Readiness fails while the sponsor holds less than this many stroops. */
  readonly minSponsorBalanceStroops: bigint;
  /** Settlements are refused while the sponsor holds less than this many stroops. */
  readonly sponsorReserveStroops: bigint;
  /** Settlements are refused once this many stroops of fees were committed in the last hour. */
  readonly maxSponsorSpendPerHourStroops: bigint | undefined;
  readonly inclusionFeeCapStroops: number;
  readonly inclusionFeePercentile: "p50" | "p70" | "p80" | "p90" | "p95" | "p99";
  /** Whether /verify and /settle require an API key on this network. */
  readonly requireApiKey: boolean;
  /** Requests per minute per client address for keyless callers on this network; undefined = no limit. */
  readonly keylessRequestsPerMinute: number | undefined;
  /** Requests per minute for a key on this network when its record sets none. */
  readonly keyRequestsPerMinute: number;
  /** Fees keyless settlements may commit per hour on this network, together, in stroops. */
  readonly keylessSponsorBudgetStroopsPerHour: bigint | undefined;
  /** Per-party settlement limits; each undefined = off. */
  readonly settleLimits: {
    readonly payerPerMinute: number | undefined;
    readonly payToPerMinute: number | undefined;
    /** Included, failed settlements of one payer per hour before it is cooled down. */
    readonly payerFailuresPerHour: number | undefined;
  };
  /** Create missing channel accounts at startup (sponsor pays their reserves). */
  readonly autoProvisionChannels: boolean;
  /**
   * Contracts whose TTL is watched: every accepted asset, the `upto` settlement contract when `upto`
   * is served, then the extra contracts configured.
   */
  readonly ttlContracts: readonly { readonly alias: string; readonly contract: string }[];
  /** `upto` on this network; undefined when it is not served. */
  readonly upto: UptoConfig | undefined;
  /**
   * Check the sponsor account's signers at startup (pubnet unless `ALLOW_SINGLE_SIGNER_SPONSOR`): the
   * hot key must not meet the high threshold, and the cold signer must, alone.
   */
  readonly checkSponsorSigners: boolean;
  /** The cold signer the check requires (`SPONSOR_COLD_SIGNER`); set whenever the check runs. */
  readonly sponsorColdSigner: string | undefined;
  /** Whether this network's readiness decides the aggregate `/ready`. */
  readonly gatesReady: boolean;
  /**
   * What a failed chain check at startup does: `exit` stops the process (single-network default),
   * `hold` starts it with this network held until the check passes (multi-network default).
   */
  readonly onStartupCheckFailure: "exit" | "hold";
  /** Bound on this network's chain checks at startup when they hold instead of exiting. */
  readonly startupTimeoutMs: number;
}

/** `upto` on one network. */
export interface UptoConfig {
  /** The settlement contract (`C…`). */
  readonly contract: string;
  /** Hex sha256 of the contract's WASM; startup refuses a live contract that runs other code. */
  readonly wasmHash: string;
  readonly zeroSettlement: ZeroSettlementMode;
  /** Ceiling on the simulated `upto` settlement fee, in stroops. */
  readonly maxTransactionFeeStroops: number;
  /**
   * Seconds per ledger for the expiration window, fixed; estimated from the network's RPC when
   * undefined.
   */
  readonly ledgerSeconds: number | undefined;
  readonly ttl: UptoTtlConfig;
  /**
   * After a sponsor rotation: the previous sponsor's secret, whose derived settlement authority stays
   * accepted until `validUntil` (at most `TIMEOUT_MAX_SECONDS` away), so payments signed before the
   * rotation can still be settled.
   */
  readonly previousAuthority?: { readonly sponsorSecret: string; readonly validUntil: Date };
}

/** How the service keeps the settlement contract's instance and code entries live. */
export interface UptoTtlConfig {
  /** Extend and (where allowed) restore the contract in the background. */
  readonly keeper: boolean;
  /** Extend once the instance or code entry has fewer ledgers left than this. */
  readonly extendBelowLedgers: number;
  /** Ledgers past the current one an extension reaches; undefined means the network maximum less one day. */
  readonly extendToLedgers: number | undefined;
  /** Restore an archived contract without an operator. */
  readonly autoRestore: boolean;
  /** Ceiling on the fee of one extension or restoration, in stroops. */
  readonly maxFeeStroops: number;
  /** Most the keeper may spend in any 24 hours, in stroops; undefined = no daily cap. */
  readonly dailyMaxFeeStroops?: number | undefined;
}

/** The TTL alias of the `upto` settlement contract in metrics and `/health`. */
export const UPTO_TTL_ALIAS = "upto";

/**
 * The `upto` fee ceiling on testnet unless configured. A smart account's first payment can create
 * state of its own: under OpenZeppelin's spending-limit policy the policy's record of the account is
 * written, and its rent makes that one payment cost several times more than later ones. Testnet
 * serves every kind of payer; pubnet has no default: its operator sets the ceiling.
 */
export const TESTNET_UPTO_MAX_TX_FEE_STROOPS = 5_000_000;

/**
 * The `exact` fee ceiling on testnet unless configured. A payment to a recipient that has never held
 * the token creates its balance entry, and a custom SEP-41 token loads its whole contract code and may
 * pay rent on every read. Testnet's rent price follows the size of its ledger state: a smart-account
 * payment in the TEST6 test token carried a resource fee of 794,766 stroops and, nine days later with
 * the same resources, was simulated at 1,083,927. Testnet sponsors are funded by Friendbot, so the
 * ceiling there leaves room for such payments as the price keeps rising; pubnet has no default.
 */
export const TESTNET_MAX_TX_FEE_STROOPS = 2_000_000;

/**
 * The ceiling on one `upto` contract extension or restoration on testnet unless configured: room for
 * extending the code entry by the network maximum (about 32 XLM on testnet). Pubnet sets its own.
 */
export const TESTNET_UPTO_TTL_MAX_FEE_STROOPS = 500_000_000;

/**
 * The expiration margin on pubnet unless configured: one ledger more than testnet's, so a settlement
 * that lands a ledger late does not fail on-chain after the sponsor paid its fee.
 */
export const PUBNET_EXPIRATION_MARGIN_LEDGERS = 2;

/** The most channel accounts one network may use (`CHANNEL_COUNT`). */
export const MAX_CHANNEL_COUNT = 1_000;

const int = (min: number, max = Number.MAX_SAFE_INTEGER) => z.coerce.number().int().min(min).max(max);
const bool = z.enum(["true", "false"]).transform((value) => value === "true");

const baseSchema = z.object({
  PORT: int(1, 65_535).default(8080),
  HOST: z.string().min(1).default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  STORE: z.enum(["postgres", "memory"]).default("postgres"),
  DATABASE_URL: z.url().optional(),
  DATABASE_MIGRATION_URL: z.url().optional(),
  MIGRATE_ON_START: bool.default(true),
  DATABASE_ACQUIRE_TIMEOUT_MS: int(100, 60_000).default(5_000),
  NETWORKS: z.string().min(1).default(TESTNET),
  BODY_LIMIT_BYTES: int(1_024, 1_048_576).default(131_072),
  RESPONSE_WRITE_TIMEOUT_MS: int(1_000, 600_000).default(30_000),
  MAX_PIPELINED_REQUESTS: int(1, 1_000).default(4),
  RATE_LIMIT_PER_MINUTE: int(0).default(600),
  TRUSTED_PROXY_HOPS: int(0, 10).default(0),
  API_KEY_SHA256: z.string().default(""),
  API_KEYS_FILE: z.string().optional(),
  API_KEYS_DIR: z.string().optional(),
  PUBLIC_HOSTS: z.string().optional(),
  ACCESS_KEYS_FUTURE_NETWORKS: bool.default(false),
  ACCESS_KEY_MAX_LIFETIME_DAYS: int(1, 3_650).default(400),
  ACCESS_KEYS_MAX: int(1, 100_000).default(1_000),
  KEY_SIGNUP: z.enum(["off", "github"]).default("off"),
  KEY_SIGNUP_GITHUB_CLIENT_ID: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,64}$/, "must be a GitHub OAuth client id")
    .optional(),
  KEY_SIGNUP_GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
  KEY_SIGNUP_CALLBACK_URL: z.url().optional(),
  KEY_SIGNUP_NETWORK: z.string().default(PUBNET),
  KEY_SIGNUP_REQUESTS_PER_MINUTE: int(1, 100_000).default(60),
  KEY_SIGNUP_SPONSOR_BUDGET_XLM_PER_HOUR: z.string().default("0.5"),
  KEY_SIGNUP_DAYS: int(1, 3_650).default(90),
  KEY_SIGNUP_PER_HOUR: int(1, 100_000).default(30),
  KEY_SIGNUP_REISSUE_MINUTES: int(0, 525_600).default(60),
  KEY_SIGNUP_MIN_ACCOUNT_AGE_DAYS: int(0, 3_650).default(30),
  DISCOVERY_INTERNAL_REQUESTS_PER_MINUTE: int(1, 1_000_000).default(6_000),
  SHUTDOWN_GRACE_MS: int(0, 600_000).default(30_000),
  RECONCILE_INTERVAL_MS: int(1_000, 600_000).default(5_000),
  SETTLE_CHANNEL_WAIT_MS: int(0, 120_000).default(5_000),
  SETTLE_CONFIRM_TIMEOUT_MS: int(0, 300_000).default(25_000),
  SETTLE_CHANNEL_QUARANTINE_MS: int(0, 3_600_000).default(60_000),
  /** Unset: SETTLE_CONFIRM_TIMEOUT_MS plus 5 s. */
  SETTLE_RECONCILE_IDLE_MS: int(0, 600_000).optional(),
  RECONCILE_THIRD_PARTY_SETTLEMENTS: bool.default(true),
  METRICS_TOKEN_SHA256: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "must be a SHA-256 hex digest")
    .optional(),
  METRICS_PRIVATE_TOKEN_SHA256: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "must be a SHA-256 hex digest")
    .optional(),
  CONTRACT_TTL_POLL_MS: int(10_000, 86_400_000).default(300_000),
  CONTRACT_TTL_WARN_LEDGERS: int(0).default(518_400),
  CONTRACT_TTL_CRITICAL_LEDGERS: int(0).default(120_960),
  SPONSOR_BUDGET_WARN_PERCENT: int(1, 100).default(80),
  SERVICE_FEE_PER_SETTLEMENT_USD: z
    .string()
    .regex(/^\d{1,6}(\.\d{1,7})?$/, "must be a decimal amount in US dollars")
    .default("0"),
  // --- discovery settings (DISCOVERY) ---
  BAZAAR_ENABLED: bool.default(true),
  DISCOVERY_ALLOW_LOOPBACK: bool.default(false),
  ORIGIN_CHECK_INTERVAL_MS: int(1_000, 3_600_000).default(5_000),
  SEARCH_EMBEDDINGS: bool.default(true),
  SEARCH_MODEL_DIR: z.string().min(1).default(".models"),
  SEARCH_MODEL_DOWNLOAD: bool.default(false),
  SEARCH_CURSOR_SECRET: z
    .string()
    .regex(/^[0-9a-fA-F]{64,}$/, "must be at least 32 bytes of hex")
    .optional(),
  SEARCH_SIMILARITY_FLOOR: z.coerce.number().min(-1).max(1).default(0.3),
  // --- end discovery settings ---
});

const networkSchema = z.object({
  RPC_URL: z.url().optional(),
  RPC_URLS: z.string().optional(),
  RPC_SINGLE_PROVIDER: bool.default(false),
  SPONSOR_SECRET: z
    .string()
    .refine((value) => StrKey.isValidEd25519SecretSeed(value), "must be an S… secret seed"),
  CHANNEL_COUNT: int(1, MAX_CHANNEL_COUNT).default(8),
  ASSETS: z.string().optional(),
  MAX_TX_FEE_STROOPS: int(MIN_INCLUSION_FEE_STROOPS).optional(),
  INCLUSION_FEE_STROOPS: int(MIN_INCLUSION_FEE_STROOPS).optional(),
  ALLOW_INCLUSION_FEE_BELOW_FLOOR: bool.default(false),
  ALLOW_SINGLE_SIGNER_SPONSOR: bool.default(false),
  SPONSOR_COLD_SIGNER: z
    .string()
    .refine((value) => StrKey.isValidEd25519PublicKey(value), "must be a G… public key")
    .optional(),
  // At least one: an authorization expiring at the current ledger can no longer be included.
  EXPIRATION_MARGIN_LEDGERS: int(1, 100).optional(),
  TIMEOUT_MIN_SECONDS: int(1).default(DEFAULT_TIMEOUT_SECONDS.min),
  TIMEOUT_MAX_SECONDS: int(1).default(DEFAULT_TIMEOUT_SECONDS.max),
  MIN_SPONSOR_BALANCE_XLM: int(0).default(25),
  SPONSOR_RESERVE_XLM: int(0).default(5),
  MAX_SPONSOR_SPEND_XLM_PER_HOUR: int(1).optional(),
  INCLUSION_FEE_CAP_STROOPS: int(MIN_INCLUSION_FEE_STROOPS).default(10_000),
  INCLUSION_FEE_PERCENTILE: z.enum(["p50", "p70", "p80", "p90", "p95", "p99"]).default("p90"),
  REQUIRE_API_KEY: bool.optional(),
  RATE_LIMIT_PER_MINUTE: int(1, 1_000_000).optional(),
  KEY_DEFAULT_REQUESTS_PER_MINUTE: int(1, 100_000).optional(),
  KEYLESS_SPONSOR_BUDGET_XLM_PER_HOUR: z.string().optional(),
  MAX_SETTLEMENTS_PER_PAYER_PER_MINUTE: int(0, 100_000).optional(),
  MAX_SETTLEMENTS_PER_PAYTO_PER_MINUTE: int(0, 100_000).optional(),
  PAYER_FAILURES_PER_HOUR: int(0, 100_000).optional(),
  AUTO_PROVISION_CHANNELS: bool.optional(),
  TTL_CONTRACTS: z.string().optional(),
  UPTO_ENABLED: bool.optional(),
  UPTO_CONTRACT: z
    .string()
    .refine((value) => StrKey.isValidContract(value), "must be a C… contract address")
    .optional(),
  UPTO_WASM_HASH: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "must be a SHA-256 hex digest")
    .transform((value) => value.toLowerCase())
    .optional(),
  UPTO_ZERO_SETTLEMENT: z.enum(["onchain", "offchain"]).optional(),
  UPTO_MAX_TX_FEE_STROOPS: int(MIN_INCLUSION_FEE_STROOPS).optional(),
  // No ledger closes faster than a second; rule 7 and the restore hold never count shorter ones.
  UPTO_LEDGER_SECONDS: z.coerce.number().min(1).max(60).optional(),
  UPTO_TTL_KEEPER: bool.default(true),
  UPTO_TTL_EXTEND_BELOW_LEDGERS: int(1).default(518_400),
  UPTO_TTL_EXTEND_TO_LEDGERS: int(2).optional(),
  UPTO_TTL_AUTO_RESTORE: bool.optional(),
  UPTO_TTL_MAX_FEE_STROOPS: int(MIN_INCLUSION_FEE_STROOPS).optional(),
  UPTO_TTL_DAILY_MAX_FEE_STROOPS: int(MIN_INCLUSION_FEE_STROOPS).optional(),
  PREVIOUS_SPONSOR_SECRET: z
    .string()
    .refine((value) => StrKey.isValidEd25519SecretSeed(value), "must be an S… secret seed")
    .optional(),
  PREVIOUS_AUTHORITY_UNTIL: z.iso.datetime({ offset: true }).optional(),
  GATES_READY: bool.optional(),
  ON_STARTUP_CHECK_FAILURE: z.enum(["exit", "hold"]).optional(),
  STARTUP_TIMEOUT_MS: int(1_000, 600_000).default(30_000),
  // --- discovery settings (DISCOVERY) ---
  // --- end discovery settings ---
});

export function loadConfig(environment: Readonly<Record<string, string | undefined>> = process.env): Config {
  const env = withSecrets(environment);
  const base = parse(baseSchema, env, "");
  const networks = base.NETWORKS.split(",").map((value) => value.trim());
  for (const network of networks) {
    if (!isStellarNetwork(network)) throw new ConfigError(`NETWORKS: unknown network "${network}"`);
  }
  if (new Set(networks).size !== networks.length) throw new ConfigError("NETWORKS lists a network twice");

  if (base.STORE === "postgres" && base.DATABASE_URL === undefined) {
    throw new ConfigError("DATABASE_URL is required when STORE=postgres");
  }
  // The process that holds the pubnet sponsor seed never holds the schema owner's credentials too:
  // migrations run as their own step (node dist/migrate.js), which reads them without loading this
  // configuration.
  if (networks.includes(PUBNET) && base.DATABASE_MIGRATION_URL !== undefined) {
    throw new ConfigError(
      "DATABASE_MIGRATION_URL cannot be given to the service when pubnet is enabled: run node dist/migrate.js with it, then start the service with MIGRATE_ON_START=false and without it",
      "config_pubnet_migration_url_in_service",
    );
  }

  const apiKeyHashes = new Set(
    base.API_KEY_SHA256.split(",")
      .map((value) => value.trim().toLowerCase())
      .filter((value) => value !== ""),
  );
  for (const hash of apiKeyHashes) {
    if (!/^[0-9a-f]{64}$/.test(hash))
      throw new ConfigError("API_KEY_SHA256 entries must be SHA-256 hex digests");
  }
  if (networks.includes(PUBNET) && apiKeyHashes.size > 0) {
    throw new ConfigError(
      "API_KEY_SHA256 cannot be used when pubnet is enabled: its keys would open every network; issue keys scoped to networks in API_KEYS_FILE",
      "config_legacy_api_keys_with_pubnet",
    );
  }
  const rules: AccessKeyRules = {
    networks,
    futureNetworks: base.ACCESS_KEYS_FUTURE_NETWORKS,
    maxLifetimeDays: base.ACCESS_KEY_MAX_LIFETIME_DAYS,
    max: base.ACCESS_KEYS_MAX,
  };
  const { path: keysFile, source: keysSource } = accessKeysPath(base.API_KEYS_FILE, base.API_KEYS_DIR);
  const keys =
    keysFile === undefined
      ? []
      : parseAccessKeys(readAccessKeyFile(keysFile, keysSource).text, rules, keysSource);
  const keyNetworks = (network: string) =>
    apiKeyHashes.size + keys.filter((key) => key.networks.includes(network as StellarNetwork)).length;

  if (base.CONTRACT_TTL_CRITICAL_LEDGERS > base.CONTRACT_TTL_WARN_LEDGERS) {
    throw new ConfigError("CONTRACT_TTL_CRITICAL_LEDGERS exceeds CONTRACT_TTL_WARN_LEDGERS");
  }

  if (networks.includes(PUBNET) && base.METRICS_PRIVATE_TOKEN_SHA256 === undefined) {
    throw new ConfigError(
      "METRICS_PRIVATE_TOKEN_SHA256 must be set when pubnet is enabled: pubnet's sponsor and budget figures are served only at /metrics/private and /health/private",
      "config_metrics_private_token_missing",
    );
  }

  if (base.DISCOVERY_ALLOW_LOOPBACK && networks.includes(PUBNET)) {
    throw new ConfigError(
      "DISCOVERY_ALLOW_LOOPBACK is for local conformance runs and cannot be enabled with pubnet",
    );
  }

  const sponsors = new Set<string>();
  const networkConfigs = networks.map((network) => {
    const config = loadNetwork(
      network as StellarNetwork,
      env,
      keyNetworks(network),
      keysFile !== undefined,
      base.STORE,
      networks.length > 1,
    );
    const sponsor = Keypair.fromSecret(config.sponsorSecret).publicKey();
    if (sponsors.has(sponsor)) throw new ConfigError("each network needs its own sponsor account");
    sponsors.add(sponsor);
    return config;
  });

  return {
    port: base.PORT,
    host: base.HOST,
    logLevel: base.LOG_LEVEL,
    store:
      base.STORE === "postgres" && base.DATABASE_URL !== undefined
        ? { kind: "postgres", url: base.DATABASE_URL, acquireTimeoutMs: base.DATABASE_ACQUIRE_TIMEOUT_MS }
        : { kind: "memory" },
    networks: networkConfigs,
    migrations: { onStart: base.MIGRATE_ON_START, url: base.DATABASE_MIGRATION_URL },
    http: {
      bodyLimitBytes: base.BODY_LIMIT_BYTES,
      responseWriteTimeoutMs: base.RESPONSE_WRITE_TIMEOUT_MS,
      maxPipelinedRequests: base.MAX_PIPELINED_REQUESTS,
      rateLimitPerMinute: base.RATE_LIMIT_PER_MINUTE,
      trustedProxyHops: base.TRUSTED_PROXY_HOPS,
    },
    keySignup: keySignupConfig(base, networks),
    auth: {
      apiKeyHashes,
      keysFile,
      keysSource,
      keys,
      rules,
      discoveryInternalPerMinute: base.DISCOVERY_INTERNAL_REQUESTS_PER_MINUTE,
    },
    observability: {
      metricsTokenSha256: base.METRICS_TOKEN_SHA256?.toLowerCase(),
      metricsPrivateTokenSha256: base.METRICS_PRIVATE_TOKEN_SHA256?.toLowerCase(),
      budgetWarnPercent: base.SPONSOR_BUDGET_WARN_PERCENT,
      contractTtl: {
        pollMs: base.CONTRACT_TTL_POLL_MS,
        warnLedgers: base.CONTRACT_TTL_WARN_LEDGERS,
        criticalLedgers: base.CONTRACT_TTL_CRITICAL_LEDGERS,
      },
    },
    publicHosts: parsePublicHosts(base.PUBLIC_HOSTS, networks),
    shutdownGraceMs: base.SHUTDOWN_GRACE_MS,
    reconcileIntervalMs: base.RECONCILE_INTERVAL_MS,
    settlement: {
      channelWaitMs: base.SETTLE_CHANNEL_WAIT_MS,
      confirmTimeoutMs: base.SETTLE_CONFIRM_TIMEOUT_MS,
      reconcileIdleMs: base.SETTLE_RECONCILE_IDLE_MS ?? base.SETTLE_CONFIRM_TIMEOUT_MS + RECONCILE_MARGIN_MS,
      channelQuarantineMs: base.SETTLE_CHANNEL_QUARANTINE_MS,
      reconcileThirdParty: base.RECONCILE_THIRD_PARTY_SETTLEMENTS,
    },
    serviceFeePerSettlementUsd: base.SERVICE_FEE_PER_SETTLEMENT_USD,
    search: {
      embeddings: base.SEARCH_EMBEDDINGS,
      modelDirectory: base.SEARCH_MODEL_DIR,
      modelDownload: base.SEARCH_MODEL_DOWNLOAD,
      cursorSecret:
        base.SEARCH_CURSOR_SECRET === undefined ? undefined : Buffer.from(base.SEARCH_CURSOR_SECRET, "hex"),
      similarityFloor: base.SEARCH_SIMILARITY_FLOOR,
    },
    bazaar: {
      enabled: base.BAZAAR_ENABLED,
      allowLoopback: base.DISCOVERY_ALLOW_LOOPBACK,
      originCheckIntervalMs: base.ORIGIN_CHECK_INTERVAL_MS,
    },
    // --- discovery settings (DISCOVERY) ---
    discovery: loadDiscoveryConfig(env, networks as StellarNetwork[]),
    // --- end discovery settings ---
  };
}

function loadNetwork(
  network: StellarNetwork,
  env: Readonly<Record<string, string | undefined>>,
  keyCount: number,
  keysFile: boolean,
  store: "postgres" | "memory",
  multiNetwork: boolean,
): NetworkConfig {
  const prefix = network === PUBNET ? "PUBNET_" : "TESTNET_";
  if (
    (env[`${prefix}RPC_URL`] ?? "") === "" &&
    (env[`${prefix}RPC_URLS`] ?? "") === "" &&
    (env[`${prefix}RPC_URLS_FILE`] ?? "") === ""
  ) {
    throw new ConfigError(`${prefix}RPC_URL or ${prefix}RPC_URLS is required`, "config_rpc_missing");
  }
  // Resolved from the file by `withSecrets`; pubnet takes the seed from a file only.
  if ((env[`${prefix}SPONSOR_SECRET`] ?? "") === "") {
    throw new ConfigError(
      network === PUBNET
        ? "PUBNET_SPONSOR_SECRET_FILE is required: the path of the pubnet sponsor's tagged key file"
        : `${prefix}SPONSOR_SECRET or ${prefix}SPONSOR_SECRET_FILE is required`,
      "config_sponsor_secret_missing",
    );
  }
  const values = parse(networkSchema, env, prefix);
  const pubnet = network === PUBNET;
  const providers = rpcProviders(values.RPC_URL, values.RPC_URLS, prefix);
  const providersVariable = values.RPC_URLS === undefined ? `${prefix}RPC_URL` : `${prefix}RPC_URLS`;

  if (pubnet) {
    if (providers.some((provider) => new URL(provider.url).protocol !== "https:")) {
      throw new ConfigError(
        `${providersVariable} must use https for every provider`,
        "config_pubnet_rpc_insecure",
      );
    }
    // One process serving several networks keeps pubnet up through one provider's outage.
    if (multiNetwork && providers.length < 2 && !values.RPC_SINGLE_PROVIDER) {
      throw new ConfigError(
        "PUBNET_RPC_URLS must list at least two providers when several networks are served; set PUBNET_RPC_SINGLE_PROVIDER=true to accept running without failover",
        "config_pubnet_rpc_fallback_missing",
      );
    }
    // Mainnet access control is an operator decision that must be made explicitly.
    if (values.REQUIRE_API_KEY === undefined) {
      throw new ConfigError(
        "PUBNET_REQUIRE_API_KEY must be set to true or false when pubnet is enabled",
        "config_pubnet_api_key_policy_missing",
      );
    }
    // So is what the fee sponsor may spend: every settlement it sponsors costs real XLM.
    if (values.MAX_SPONSOR_SPEND_XLM_PER_HOUR === undefined) {
      throw new ConfigError(
        "PUBNET_MAX_SPONSOR_SPEND_XLM_PER_HOUR must be set when pubnet is enabled: it bounds the XLM the fee sponsor spends per hour",
        "config_pubnet_budget_missing",
      );
    }
    // And what one settlement may cost: no ceiling is assumed on mainnet.
    if (values.MAX_TX_FEE_STROOPS === undefined) {
      throw new ConfigError(
        "PUBNET_MAX_TX_FEE_STROOPS must be set when pubnet is enabled: it bounds what one exact settlement may cost the fee sponsor",
        "config_pubnet_fee_ceiling_missing",
      );
    }
    if (values.INCLUSION_FEE_STROOPS === undefined) {
      throw new ConfigError(
        `PUBNET_INCLUSION_FEE_STROOPS must be set when pubnet is enabled (at least ${String(PUBNET_MIN_INCLUSION_FEE_STROOPS)}): it is the lowest inclusion-fee bid and the bid while fee stats cannot be read`,
        "config_pubnet_fee_ceiling_missing",
      );
    }
    if (
      values.INCLUSION_FEE_STROOPS < PUBNET_MIN_INCLUSION_FEE_STROOPS &&
      !values.ALLOW_INCLUSION_FEE_BELOW_FLOOR
    ) {
      throw new ConfigError(
        `PUBNET_INCLUSION_FEE_STROOPS is below ${String(PUBNET_MIN_INCLUSION_FEE_STROOPS)}, mainnet's usual Soroban inclusion fee, so its bids may never be included; set PUBNET_ALLOW_INCLUSION_FEE_BELOW_FLOOR=true to accept that`,
        "config_pubnet_inclusion_floor_too_low",
      );
    }
    // Which tokens the sponsor pays to move, and from what amount, is never assumed on mainnet.
    if (values.ASSETS === undefined) {
      throw new ConfigError(
        "PUBNET_ASSETS must be set when pubnet is enabled, each asset with its minimum amount (CONTRACT:SYMBOL:DECIMALS:MIN[:MAX])",
        "config_pubnet_assets_missing",
      );
    }
  }
  // The signer check needs to know which key is the cold one: any other high signer could be a key the
  // service itself derives, or one whose secret is public once used.
  const checkSponsorSigners = pubnet && !values.ALLOW_SINGLE_SIGNER_SPONSOR;
  if (checkSponsorSigners && values.SPONSOR_COLD_SIGNER === undefined) {
    throw new ConfigError(
      "PUBNET_SPONSOR_COLD_SIGNER must be set when pubnet is enabled: the cold key, kept off the server, that alone reaches the sponsor account's high threshold",
      "config_pubnet_cold_signer_missing",
    );
  }
  if (
    values.SPONSOR_COLD_SIGNER !== undefined &&
    values.SPONSOR_COLD_SIGNER === Keypair.fromSecret(values.SPONSOR_SECRET).publicKey()
  ) {
    throw new ConfigError(
      `${prefix}SPONSOR_COLD_SIGNER is the sponsor's own key: it must be a key kept off the server`,
    );
  }
  // A pubnet floor of 0 would keep a drained sponsor ready and switch its balance alert off.
  if (pubnet && values.MIN_SPONSOR_BALANCE_XLM < 1) {
    throw new ConfigError(
      "PUBNET_MIN_SPONSOR_BALANCE_XLM must be at least 1: readiness and the sponsor balance alert are measured against it",
      "config_pubnet_sponsor_floor_invalid",
    );
  }
  const requireApiKey = values.REQUIRE_API_KEY ?? false;
  if (pubnet && requireApiKey && !keysFile) {
    throw new ConfigError(
      "PUBNET_REQUIRE_API_KEY=true needs API_KEYS_FILE or API_KEYS_DIR, the access keys with their networks, limits and budgets",
      "config_access_keys_missing",
    );
  }
  if (requireApiKey && keyCount === 0 && !keysFile) {
    throw new ConfigError(
      `${prefix}REQUIRE_API_KEY=true needs at least one key in API_KEYS_FILE, API_KEYS_DIR or API_KEY_SHA256`,
      "config_access_keys_missing",
    );
  }
  const keylessSponsorBudgetStroopsPerHour =
    values.KEYLESS_SPONSOR_BUDGET_XLM_PER_HOUR === undefined
      ? undefined
      : xlmToStroops(
          values.KEYLESS_SPONSOR_BUDGET_XLM_PER_HOUR,
          `${prefix}KEYLESS_SPONSOR_BUDGET_XLM_PER_HOUR`,
        );
  if (pubnet && !requireApiKey) {
    // Keyless mainnet access is allowed only with its own request limit and a shared fee budget.
    if (values.RATE_LIMIT_PER_MINUTE === undefined || keylessSponsorBudgetStroopsPerHour === undefined) {
      throw new ConfigError(
        "PUBNET_REQUIRE_API_KEY=false needs PUBNET_RATE_LIMIT_PER_MINUTE and PUBNET_KEYLESS_SPONSOR_BUDGET_XLM_PER_HOUR: keyless callers share one limit and one fee budget",
        "config_pubnet_keyless_limits_missing",
      );
    }
    // Whoever holds an upto payload can settle it for any amount up to the cap through /settle.
    if (values.UPTO_ENABLED === true) {
      throw new ConfigError(
        "PUBNET_UPTO_ENABLED=true needs PUBNET_REQUIRE_API_KEY=true: an upto payload settles for any amount up to its cap, so only known callers may settle it",
        "config_pubnet_api_key_policy_missing",
      );
    }
  }
  if (values.TIMEOUT_MIN_SECONDS > values.TIMEOUT_MAX_SECONDS) {
    throw new ConfigError(`${prefix}TIMEOUT_MIN_SECONDS exceeds ${prefix}TIMEOUT_MAX_SECONDS`);
  }
  // Pubnet has both set explicitly by now (checked above); testnet keeps its defaults.
  const maxTransactionFeeStroops = values.MAX_TX_FEE_STROOPS ?? TESTNET_MAX_TX_FEE_STROOPS;
  const inclusionFeeStroops = values.INCLUSION_FEE_STROOPS ?? MIN_INCLUSION_FEE_STROOPS;
  if (inclusionFeeStroops > maxTransactionFeeStroops) {
    throw new ConfigError(
      `${prefix}INCLUSION_FEE_STROOPS exceeds ${prefix}MAX_TX_FEE_STROOPS`,
      "config_fee_bounds_invalid",
    );
  }
  if (values.INCLUSION_FEE_CAP_STROOPS < inclusionFeeStroops) {
    throw new ConfigError(
      `${prefix}INCLUSION_FEE_CAP_STROOPS is below ${prefix}INCLUSION_FEE_STROOPS`,
      "config_fee_bounds_invalid",
    );
  }
  if (values.INCLUSION_FEE_CAP_STROOPS > maxTransactionFeeStroops) {
    throw new ConfigError(
      `${prefix}INCLUSION_FEE_CAP_STROOPS exceeds ${prefix}MAX_TX_FEE_STROOPS`,
      "config_fee_bounds_invalid",
    );
  }
  const expirationMarginLedgers =
    values.EXPIRATION_MARGIN_LEDGERS ??
    (pubnet ? PUBNET_EXPIRATION_MARGIN_LEDGERS : DEFAULT_EXPIRATION_MARGIN_LEDGERS);

  const assets =
    values.ASSETS === undefined
      ? [acceptedAsset(USDC[network])]
      : parseAssets(values.ASSETS, `${prefix}ASSETS`, { requireMinimum: pubnet });

  const upto = loadUpto(network, values, prefix, store, { inclusionFeeStroops, expirationMarginLedgers });
  const watched = watchedContracts(assets, values.TTL_CONTRACTS, `${prefix}TTL_CONTRACTS`, upto?.contract);

  return {
    network,
    rpcUrl: providers[0]?.url ?? "",
    rpcProviders: providers,
    sponsorSecret: values.SPONSOR_SECRET,
    channelCount: values.CHANNEL_COUNT,
    assets,
    assetsVariable: `${prefix}ASSETS`,
    maxTransactionFeeStroops,
    inclusionFeeStroops,
    expirationMarginLedgers,
    timeoutSeconds: { min: values.TIMEOUT_MIN_SECONDS, max: values.TIMEOUT_MAX_SECONDS },
    minSponsorBalanceStroops: BigInt(values.MIN_SPONSOR_BALANCE_XLM) * 10_000_000n,
    sponsorReserveStroops: BigInt(values.SPONSOR_RESERVE_XLM) * 10_000_000n,
    maxSponsorSpendPerHourStroops:
      values.MAX_SPONSOR_SPEND_XLM_PER_HOUR === undefined
        ? undefined
        : BigInt(values.MAX_SPONSOR_SPEND_XLM_PER_HOUR) * 10_000_000n,
    inclusionFeeCapStroops: values.INCLUSION_FEE_CAP_STROOPS,
    inclusionFeePercentile: values.INCLUSION_FEE_PERCENTILE,
    requireApiKey,
    keylessRequestsPerMinute: values.RATE_LIMIT_PER_MINUTE,
    keyRequestsPerMinute: values.KEY_DEFAULT_REQUESTS_PER_MINUTE ?? (pubnet ? 60 : 600),
    keylessSponsorBudgetStroopsPerHour,
    // Pubnet limits what one payer or payTo can make the sponsor pay; 0 turns a limit off.
    settleLimits: {
      payerPerMinute: positive(values.MAX_SETTLEMENTS_PER_PAYER_PER_MINUTE ?? (pubnet ? 10 : undefined)),
      payToPerMinute: positive(values.MAX_SETTLEMENTS_PER_PAYTO_PER_MINUTE ?? (pubnet ? 60 : undefined)),
      payerFailuresPerHour: positive(values.PAYER_FAILURES_PER_HOUR ?? (pubnet ? 3 : undefined)),
    },
    // Provisioning locks sponsor XLM in reserves; on mainnet that is an explicit operator action.
    autoProvisionChannels: values.AUTO_PROVISION_CHANNELS ?? network === TESTNET,
    ttlContracts: watched,
    upto,
    // One process serving several networks never lets one network take the others down: by default
    // no network decides the aggregate readiness, and a failed chain check holds only its network.
    checkSponsorSigners,
    sponsorColdSigner: values.SPONSOR_COLD_SIGNER,
    gatesReady: values.GATES_READY ?? !multiNetwork,
    onStartupCheckFailure: values.ON_STARTUP_CHECK_FAILURE ?? (multiNetwork ? "hold" : "exit"),
    startupTimeoutMs: values.STARTUP_TIMEOUT_MS,
  };
}

/**
 * `upto` settings of one network. Testnet serves `upto` by default with the canonical settlement
 * contract; pubnet serves it only when enabled explicitly, and then needs the contract and its WASM
 * hash spelled out, since no canonical deployment is assumed there.
 */
function loadUpto(
  network: StellarNetwork,
  values: z.infer<typeof networkSchema>,
  prefix: string,
  store: "postgres" | "memory",
  resolved: { readonly inclusionFeeStroops: number; readonly expirationMarginLedgers: number },
): UptoConfig | undefined {
  if (!(values.UPTO_ENABLED ?? network === TESTNET)) return undefined;
  const pubnet = network === PUBNET;
  // A zero settled on-chain costs the sponsor a transaction fee and moves nothing, so pubnet settles
  // zeros off-chain by default. Testnet settles them on-chain, where the transaction is public proof.
  const zeroSettlement = values.UPTO_ZERO_SETTLEMENT ?? (network === PUBNET ? "offchain" : "onchain");
  if (zeroSettlement === "offchain" && store === "memory") {
    // An off-chain zero is only a ledger record: lost on restart, or unseen by another process, the
    // same authorization could still be settled on-chain for more.
    throw new ConfigError(
      `${prefix}UPTO_ZERO_SETTLEMENT=offchain needs STORE=postgres, so the settled zero survives restarts and is shared by every replica; set ${prefix}UPTO_ZERO_SETTLEMENT=onchain to use STORE=memory`,
    );
  }
  const canonical = UPTO_DEPLOYMENTS[network];
  if (pubnet && (values.UPTO_CONTRACT === undefined || values.UPTO_WASM_HASH === undefined)) {
    throw new ConfigError(
      `${prefix}UPTO_ENABLED=true needs ${prefix}UPTO_CONTRACT and ${prefix}UPTO_WASM_HASH on pubnet`,
      "config_upto_contract_missing",
    );
  }
  if (pubnet && values.UPTO_MAX_TX_FEE_STROOPS === undefined) {
    throw new ConfigError(
      "PUBNET_UPTO_MAX_TX_FEE_STROOPS must be set when pubnet serves upto: it is the most one upto settlement may cost the fee sponsor",
      "config_pubnet_fee_ceiling_missing",
    );
  }
  if (pubnet && values.UPTO_TTL_KEEPER && values.UPTO_TTL_MAX_FEE_STROOPS === undefined) {
    throw new ConfigError(
      "PUBNET_UPTO_TTL_MAX_FEE_STROOPS must be set when pubnet keeps the upto contract live (PUBNET_UPTO_TTL_KEEPER): it is the most one extension or restoration may cost the fee sponsor",
      "config_pubnet_fee_ceiling_missing",
    );
  }
  const contract = values.UPTO_CONTRACT ?? canonical?.address;
  if (contract === undefined) {
    throw new ConfigError(
      `${prefix}UPTO_CONTRACT is required: ${network} has no canonical upto contract`,
      "config_upto_contract_missing",
    );
  }
  let wasmHash = values.UPTO_WASM_HASH;
  if (contract === canonical?.address) {
    if (wasmHash !== undefined && wasmHash !== canonical.wasmHash) {
      throw new ConfigError(
        `${prefix}UPTO_WASM_HASH does not match the canonical contract's WASM (${canonical.wasmHash})`,
      );
    }
    wasmHash = canonical.wasmHash;
  }
  if (wasmHash === undefined) {
    throw new ConfigError(
      `${prefix}UPTO_WASM_HASH is required with a non-canonical ${prefix}UPTO_CONTRACT`,
      "config_upto_contract_missing",
    );
  }
  const maxTransactionFeeStroops = values.UPTO_MAX_TX_FEE_STROOPS ?? TESTNET_UPTO_MAX_TX_FEE_STROOPS;
  if (maxTransactionFeeStroops < resolved.inclusionFeeStroops) {
    throw new ConfigError(
      `${prefix}INCLUSION_FEE_STROOPS exceeds ${prefix}UPTO_MAX_TX_FEE_STROOPS`,
      "config_fee_bounds_invalid",
    );
  }
  // upto refuses timeouts shorter than one ledger more than the margin; some must remain.
  const margin = resolved.expirationMarginLedgers;
  if (minTimeoutSecondsFor(margin) > values.TIMEOUT_MAX_SECONDS) {
    throw new ConfigError(
      `${prefix}TIMEOUT_MAX_SECONDS must be at least ${minTimeoutSecondsFor(margin)} for upto with ${prefix}EXPIRATION_MARGIN_LEDGERS=${margin}`,
    );
  }
  let previousAuthority: { sponsorSecret: string; validUntil: Date } | undefined;
  if ((values.PREVIOUS_SPONSOR_SECRET === undefined) !== (values.PREVIOUS_AUTHORITY_UNTIL === undefined)) {
    throw new ConfigError(
      `${prefix}PREVIOUS_SPONSOR_SECRET and ${prefix}PREVIOUS_AUTHORITY_UNTIL go together`,
    );
  }
  if (values.PREVIOUS_SPONSOR_SECRET !== undefined && values.PREVIOUS_AUTHORITY_UNTIL !== undefined) {
    const validUntil = new Date(values.PREVIOUS_AUTHORITY_UNTIL);
    // No payment can still be pending later than the longest timeout accepted, counted from now.
    if (validUntil.getTime() - Date.now() > values.TIMEOUT_MAX_SECONDS * 1_000) {
      throw new ConfigError(
        `${prefix}PREVIOUS_AUTHORITY_UNTIL is more than ${prefix}TIMEOUT_MAX_SECONDS (${String(values.TIMEOUT_MAX_SECONDS)} s) away: no payment signed before the rotation can be valid that long`,
      );
    }
    // A grace that has passed already is not loaded at all.
    if (validUntil.getTime() > Date.now()) {
      previousAuthority = { sponsorSecret: values.PREVIOUS_SPONSOR_SECRET, validUntil };
    }
  }
  const extendTo = values.UPTO_TTL_EXTEND_TO_LEDGERS;
  if (extendTo !== undefined && extendTo <= values.UPTO_TTL_EXTEND_BELOW_LEDGERS) {
    throw new ConfigError(
      `${prefix}UPTO_TTL_EXTEND_TO_LEDGERS must exceed ${prefix}UPTO_TTL_EXTEND_BELOW_LEDGERS`,
    );
  }
  return {
    ...(previousAuthority === undefined ? {} : { previousAuthority }),
    contract,
    wasmHash,
    zeroSettlement,
    maxTransactionFeeStroops,
    ledgerSeconds: values.UPTO_LEDGER_SECONDS,
    ttl: {
      keeper: values.UPTO_TTL_KEEPER,
      extendBelowLedgers: values.UPTO_TTL_EXTEND_BELOW_LEDGERS,
      extendToLedgers: extendTo,
      // Restoring pays rent from the sponsor; on mainnet that is an operator's decision.
      autoRestore: values.UPTO_TTL_AUTO_RESTORE ?? network === TESTNET,
      maxFeeStroops: values.UPTO_TTL_MAX_FEE_STROOPS ?? TESTNET_UPTO_TTL_MAX_FEE_STROOPS,
      // Pubnet allows one maximal extension per day unless configured otherwise.
      dailyMaxFeeStroops:
        values.UPTO_TTL_DAILY_MAX_FEE_STROOPS ?? (pubnet ? values.UPTO_TTL_MAX_FEE_STROOPS : undefined),
    },
  };
}

/**
 * The environment with every secret in place: read from its `<NAME>_FILE` when that is set (see
 * `readSecretFile`), else taken from `<NAME>`. With pubnet enabled every secret must come from a file:
 * an environment variable is visible to anyone who can inspect the container or the process, and one
 * process then also serves the public testnet. A pubnet sponsor key file must be tagged for pubnet and
 * readable by its owner only.
 */
function withSecrets(env: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
  const listed = (env["NETWORKS"] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  const pubnet = listed.includes(PUBNET);
  const resolved: Record<string, string | undefined> = { ...env };
  const put = (name: string, value: string | undefined) => {
    resolved[name] = value;
    resolved[`${name}_FILE`] = undefined;
  };
  // With pubnet these files hold the credentials of the database with pubnet's settlements and the
  // cursor secret: readable by the service's owner and group only, never by others.
  const privateFile = { notWorldReadable: pubnet };
  put("DATABASE_URL", resolveSecret(env, { name: "DATABASE_URL", fileOnly: pubnet, options: privateFile }));
  put(
    "DATABASE_MIGRATION_URL",
    resolveSecret(env, { name: "DATABASE_MIGRATION_URL", fileOnly: pubnet, options: privateFile }),
  );
  put(
    "KEY_SIGNUP_GITHUB_CLIENT_SECRET",
    resolveSecret(env, { name: "KEY_SIGNUP_GITHUB_CLIENT_SECRET", fileOnly: pubnet, options: privateFile }),
  );
  put(
    "SEARCH_CURSOR_SECRET",
    resolveSecret(env, { name: "SEARCH_CURSOR_SECRET", fileOnly: pubnet, options: privateFile }),
  );
  for (const network of [TESTNET, PUBNET] as const) {
    if (!(listed.length === 0 ? network === TESTNET : listed.includes(network))) continue;
    const prefix = network === PUBNET ? "PUBNET_" : "TESTNET_";
    // A provider list may embed keys in its URLs, so it may come from a file too. On pubnet a URL
    // that visibly carries credentials (user info, a query or a fragment) must come from the file.
    if (network === PUBNET) refuseCredentialsInEnv(env);
    put(`${prefix}RPC_URLS`, resolveSecret(env, { name: `${prefix}RPC_URLS`, fileOnly: false }));
    const previous = `${prefix}PREVIOUS_SPONSOR_SECRET`;
    put(
      previous,
      resolveSecret(env, {
        name: previous,
        fileOnly: network === PUBNET,
        options: { privateToOwner: network === PUBNET },
        fromFile: (content) => sponsorSeedFrom(`${previous}_FILE`, content, network),
      }),
    );
    const name = `${prefix}SPONSOR_SECRET`;
    put(
      name,
      resolveSecret(env, {
        name,
        fileOnly: network === PUBNET,
        options: { privateToOwner: network === PUBNET },
        fromFile: (content) => sponsorSeedFrom(`${name}_FILE`, content, network),
      }),
    );
  }
  return resolved;
}

/** Access keys issued to signed-in GitHub accounts. */
export interface KeySignupConfig {
  readonly provider: "github";
  readonly clientId: string;
  readonly clientSecret: string;
  /** Where GitHub sends the browser back: `https://<host>/keys/callback`, the host serving `network`. */
  readonly callbackUrl: URL;
  /** The network the keys are for. */
  readonly network: StellarNetwork;
  readonly requestsPerMinute: number;
  readonly sponsorBudgetStroopsPerHour: bigint;
  readonly lifetimeDays: number;
  /** New keys per hour across the service. */
  readonly perHour: number;
  /** Shortest time between two keys of one account, in seconds. */
  readonly reissueSeconds: number;
  /** Youngest GitHub account issued a key, in days. */
  readonly minAccountAgeDays: number;
}

function keySignupConfig(
  base: z.infer<typeof baseSchema>,
  networks: readonly string[],
): KeySignupConfig | undefined {
  if (base.KEY_SIGNUP === "off") return undefined;
  const fail = (message: string): never => {
    throw new ConfigError(`KEY_SIGNUP=github: ${message}`, "config_key_signup_invalid");
  };
  if (base.STORE !== "postgres") fail("needs STORE=postgres: issued keys are kept in the database");
  const clientId = base.KEY_SIGNUP_GITHUB_CLIENT_ID ?? fail("KEY_SIGNUP_GITHUB_CLIENT_ID is required");
  const clientSecret =
    base.KEY_SIGNUP_GITHUB_CLIENT_SECRET ??
    fail("KEY_SIGNUP_GITHUB_CLIENT_SECRET (or KEY_SIGNUP_GITHUB_CLIENT_SECRET_FILE) is required");
  const network = base.KEY_SIGNUP_NETWORK;
  if (!isStellarNetwork(network) || !networks.includes(network))
    fail(`KEY_SIGNUP_NETWORK "${network}" is not a network listed in NETWORKS`);
  const raw = base.KEY_SIGNUP_CALLBACK_URL ?? fail("KEY_SIGNUP_CALLBACK_URL is required");
  const callbackUrl = new URL(raw);
  if (
    callbackUrl.protocol !== "https:" ||
    callbackUrl.pathname !== "/keys/callback" ||
    callbackUrl.search !== ""
  )
    fail("KEY_SIGNUP_CALLBACK_URL must be https://<host>/keys/callback");
  const hosts = parsePublicHosts(base.PUBLIC_HOSTS, networks);
  if (hosts.get(callbackUrl.host) !== network)
    fail(`KEY_SIGNUP_CALLBACK_URL's host must be listed in PUBLIC_HOSTS for ${network}`);
  if (base.KEY_SIGNUP_DAYS > base.ACCESS_KEY_MAX_LIFETIME_DAYS)
    fail("KEY_SIGNUP_DAYS exceeds ACCESS_KEY_MAX_LIFETIME_DAYS");
  return {
    provider: "github",
    clientId,
    clientSecret,
    callbackUrl,
    network: network as StellarNetwork,
    requestsPerMinute: base.KEY_SIGNUP_REQUESTS_PER_MINUTE,
    sponsorBudgetStroopsPerHour: xlmToStroops(
      base.KEY_SIGNUP_SPONSOR_BUDGET_XLM_PER_HOUR,
      "KEY_SIGNUP_SPONSOR_BUDGET_XLM_PER_HOUR",
      "config_key_signup_invalid",
    ),
    lifetimeDays: base.KEY_SIGNUP_DAYS,
    perHour: base.KEY_SIGNUP_PER_HOUR,
    reissueSeconds: base.KEY_SIGNUP_REISSUE_MINUTES * 60,
    minAccountAgeDays: base.KEY_SIGNUP_MIN_ACCOUNT_AGE_DAYS,
  };
}

/** The name of the key file inside `API_KEYS_DIR`. */
export const ACCESS_KEYS_DIR_FILE = "keys.json";

/**
 * Where the access keys are read from: `API_KEYS_FILE`, or `keys.json` inside `API_KEYS_DIR`. A
 * directory mount lets an operator replace the file by rename and have every replica see it within a
 * reload round; a single-file mount pins the file it was created with, so a replaced file is never seen.
 */
function accessKeysPath(
  file: string | undefined,
  dir: string | undefined,
): { path: string | undefined; source: "API_KEYS_FILE" | "API_KEYS_DIR" } {
  if (file !== undefined && dir !== undefined) {
    throw new ConfigError("set API_KEYS_FILE or API_KEYS_DIR, not both", "config_access_keys_invalid");
  }
  if (dir === undefined) return { path: file, source: "API_KEYS_FILE" };
  if (!isAbsolute(dir)) {
    throw new ConfigError("API_KEYS_DIR must be an absolute path", "config_access_keys_invalid");
  }
  return { path: join(dir, ACCESS_KEYS_DIR_FILE), source: "API_KEYS_DIR" };
}

/**
 * Refuses a pubnet RPC URL given in the environment when it visibly carries credentials: user info,
 * a query string or a fragment, where providers put their keys. The environment is visible to anyone
 * who can inspect the container or the process; such a list belongs in `PUBNET_RPC_URLS_FILE`. A key
 * embedded in a URL's path cannot be told from a path, so the documentation asks for the file then too.
 */
function refuseCredentialsInEnv(env: Readonly<Record<string, string | undefined>>): void {
  for (const name of ["PUBNET_RPC_URL", "PUBNET_RPC_URLS"]) {
    const value = env[name];
    if (value === undefined || value === "") continue;
    for (const entry of value.split(",")) {
      const candidate = entry.trim().replace(/^[a-z0-9-]{1,16}=/, "");
      let url: URL;
      try {
        url = new URL(candidate);
      } catch {
        continue; // The provider list's own parsing names a malformed entry.
      }
      if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
        throw new ConfigError(
          `${name} carries credentials in a URL; with pubnet enabled put the provider list in PUBNET_RPC_URLS_FILE`,
          "config_secret_in_env",
        );
      }
    }
  }
}

/**
 * A SHA-256 digest of one network's effective settings, everything but the sponsor secret: logged at
 * startup and printed by `check-config`, so an operator can tell that two replicas, or a preflight and
 * the service it guards, run with the same money-relevant settings without either printing them.
 */
export function networkSettingsDigest(network: NetworkConfig): string {
  const { sponsorSecret: _secret, ...rest } = network;
  const settings =
    rest.upto?.previousAuthority === undefined
      ? rest
      : {
          ...rest,
          upto: {
            ...rest.upto,
            previousAuthority: { validUntil: rest.upto.previousAuthority.validUntil },
          },
        };
  const canonical = JSON.stringify(settings, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  return createHash("sha256").update(canonical).digest("hex");
}

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;

/** `PUBLIC_HOSTS`: `host=network`, comma-separated, each network one the service serves. */
function parsePublicHosts(
  value: string | undefined,
  networks: readonly string[],
): Map<string, StellarNetwork> {
  const hosts = new Map<string, StellarNetwork>();
  for (const entry of (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")) {
    const [host = "", network = "", ...rest] = entry.split("=");
    const name = host.toLowerCase();
    if (rest.length > 0 || !HOST.test(name) || !isStellarNetwork(network) || !networks.includes(network)) {
      throw new ConfigError(
        `PUBLIC_HOSTS: "${entry}" must be host=network with a network listed in NETWORKS`,
        "config_public_hosts_invalid",
      );
    }
    if (hosts.has(name))
      throw new ConfigError(`PUBLIC_HOSTS lists ${name} twice`, "config_public_hosts_invalid");
    hosts.set(name, network);
  }
  return hosts;
}

const RPC_ALIAS = /^[a-z0-9-]{1,16}$/;

/**
 * The RPC providers of a network: `RPC_URL` (one provider, alias `primary`) or `RPC_URLS`, an ordered,
 * comma-separated list of `ALIAS=URL` or bare URLs (aliases `rpc0`, `rpc1`, …). Aliases appear in
 * metrics and `/health`; URLs never do, since a provider's URL often embeds a key.
 */
function rpcProviders(
  single: string | undefined,
  list: string | undefined,
  prefix: string,
): { alias: string; url: string }[] {
  if (single !== undefined && list !== undefined) {
    throw new ConfigError(`set ${prefix}RPC_URL or ${prefix}RPC_URLS, not both`, "config_rpc_conflict");
  }
  if (list === undefined) {
    if (single === undefined)
      throw new ConfigError(`${prefix}RPC_URL or ${prefix}RPC_URLS is required`, "config_rpc_missing");
    return [{ alias: "primary", url: single }];
  }
  const entries = list
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  if (entries.length === 0)
    throw new ConfigError(`${prefix}RPC_URLS lists no provider`, "config_rpc_missing");
  const providers = entries.map((entry, index) => {
    const at = entry.indexOf("=");
    const alias = at > 0 && !entry.slice(0, at).includes(":") ? entry.slice(0, at) : `rpc${String(index)}`;
    const url = at > 0 && !entry.slice(0, at).includes(":") ? entry.slice(at + 1) : entry;
    if (!RPC_ALIAS.test(alias)) {
      throw new ConfigError(
        `${prefix}RPC_URLS: alias "${alias}" must be 1 to 16 lower-case letters, digits or dashes`,
      );
    }
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("scheme");
    } catch {
      // The URL itself is never echoed: it may embed a provider key.
      throw new ConfigError(`${prefix}RPC_URLS: the URL of provider "${alias}" is not an http(s) URL`);
    }
    return { alias, url };
  });
  if (new Set(providers.map((provider) => provider.alias)).size !== providers.length) {
    throw new ConfigError(`${prefix}RPC_URLS uses an alias twice`);
  }
  return providers;
}

/** `value` when above zero; 0 and unset mean "off". */
function positive(value: number | undefined): number | undefined {
  return value === undefined || value === 0 ? undefined : value;
}

const ALIAS = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * The contracts whose TTL is watched on a network: every accepted asset under its symbol, the `upto`
 * settlement contract under `upto` when given, then the `ALIAS:CONTRACT` entries of `extra`,
 * comma-separated (e.g. a payment contract the operator relies on). Aliases label the TTL metric, so
 * they are short and unique per network.
 */
export function watchedContracts(
  assets: readonly AcceptedAsset[],
  extra: string | undefined,
  name: string,
  uptoContract?: string,
): { alias: string; contract: string }[] {
  const watched: { alias: string; contract: string }[] = [];
  const aliases = new Set<string>();
  const contracts = new Set<string>();
  for (const asset of assets) {
    // Two accepted tokens may share a symbol; the second one is told apart by its contract prefix.
    const alias = aliases.has(asset.symbol) ? `${asset.symbol}-${asset.contract.slice(0, 5)}` : asset.symbol;
    aliases.add(alias);
    contracts.add(asset.contract);
    watched.push({ alias, contract: asset.contract });
  }
  if (uptoContract !== undefined) {
    if (contracts.has(uptoContract)) throw new ConfigError(`${name}: the upto contract is an accepted asset`);
    if (aliases.has(UPTO_TTL_ALIAS)) {
      throw new ConfigError(
        `${name}: an accepted asset uses the symbol "${UPTO_TTL_ALIAS}", the TTL alias of the upto contract`,
      );
    }
    aliases.add(UPTO_TTL_ALIAS);
    contracts.add(uptoContract);
    watched.push({ alias: UPTO_TTL_ALIAS, contract: uptoContract });
  }
  for (const entry of (extra ?? "").split(",").map((part) => part.trim())) {
    if (entry === "") continue;
    const [alias = "", contract = "", ...rest] = entry.split(":");
    if (!ALIAS.test(alias) || rest.length > 0) {
      throw new ConfigError(
        `${name}: "${entry}" must be ALIAS:CONTRACT with a short alias (letters, digits, _ or -)`,
      );
    }
    if (!StrKey.isValidContract(contract))
      throw new ConfigError(`${name}: "${contract}" is not a C… contract address`);
    if (aliases.has(alias)) throw new ConfigError(`${name}: alias "${alias}" is used twice`);
    if (contracts.has(contract)) throw new ConfigError(`${name}: ${contract} is already watched`);
    aliases.add(alias);
    contracts.add(contract);
    watched.push({ alias, contract });
  }
  return watched;
}

/**
 * Parses `CONTRACT:SYMBOL:DECIMALS[:MIN:MAX]` entries separated by commas, e.g.
 * `CBIELTK6…DAMA:USDC:7,CAB…XYZ:EURC:7:10000:100000000`. Amounts are in base units. With
 * `requireMinimum` (pubnet), every entry must name its minimum: without one a payment of a single base
 * unit costs the sponsor a full settlement fee.
 */
export function parseAssets(
  value: string,
  name: string,
  options: { readonly requireMinimum?: boolean } = {},
): AcceptedAsset[] {
  const assets = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => {
      const [contract = "", symbol = "", decimals = "", min, max] = entry.split(":");
      if (!StrKey.isValidContract(contract))
        throw new ConfigError(`${name}: "${contract}" is not a C… contract address`);
      if (!/^[A-Za-z0-9]{1,12}$/.test(symbol)) throw new ConfigError(`${name}: invalid symbol "${symbol}"`);
      if (!/^\d{1,2}$/.test(decimals) || Number(decimals) > 38)
        throw new ConfigError(`${name}: invalid decimals "${decimals}"`);
      const bound = (raw: string | undefined, label: string) => {
        if (raw === undefined) return undefined;
        if (!/^\d+$/.test(raw)) throw new ConfigError(`${name}: invalid ${label} "${raw}"`);
        return BigInt(raw);
      };
      const minAmount = bound(min, "minimum");
      const maxAmount = bound(max, "maximum");
      if (options.requireMinimum === true && (minAmount === undefined || minAmount < 1n)) {
        throw new ConfigError(
          `${name}: ${symbol} needs a minimum amount of at least 1 base unit (CONTRACT:SYMBOL:DECIMALS:MIN[:MAX])`,
          "config_pubnet_asset_min_missing",
        );
      }
      if (minAmount !== undefined && maxAmount !== undefined && minAmount > maxAmount) {
        throw new ConfigError(`${name}: minimum exceeds maximum for ${symbol}`);
      }
      return acceptedAsset(
        { contract, symbol, decimals: Number(decimals) },
        {
          ...(minAmount === undefined ? {} : { minAmount }),
          ...(maxAmount === undefined ? {} : { maxAmount }),
        },
      );
    });
  if (assets.length === 0) throw new ConfigError(`${name} lists no assets`);
  if (new Set(assets.map((asset) => asset.contract)).size !== assets.length) {
    throw new ConfigError(`${name} lists an asset twice`);
  }
  return assets;
}

function parse<T extends z.ZodType>(
  schema: T,
  env: Readonly<Record<string, string | undefined>>,
  prefix: string,
): z.infer<T> {
  const shape = (schema as unknown as z.ZodObject).shape;
  const input: Record<string, string | undefined> = {};
  for (const key of Object.keys(shape)) {
    const value = env[`${prefix}${key}`];
    input[key] = value === "" ? undefined : value;
  }
  const result = schema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${prefix}${issue.path.join(".")}: ${issue.message}`);
    throw new ConfigError(`invalid configuration:\n  ${issues.join("\n  ")}`);
  }
  return result.data;
}

export { TESTNET, PUBNET };
