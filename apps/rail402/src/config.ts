import { z } from "zod";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { PUBNET, TESTNET, USDC, isStellarNetwork, type StellarNetwork } from "@rail402.dev/stellar";
import {
  DEFAULT_EXPIRATION_MARGIN_LEDGERS,
  DEFAULT_MAX_TRANSACTION_FEE_STROOPS,
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_UPTO_MAX_TRANSACTION_FEE_STROOPS,
  MIN_INCLUSION_FEE_STROOPS,
  RECONCILE_MARGIN_MS,
  acceptedAsset,
  type AcceptedAsset,
} from "@rail402.dev/facilitator";
import { UPTO_DEPLOYMENTS, minTimeoutSecondsFor, type ZeroSettlementMode } from "@rail402.dev/upto";

/**
 * Service configuration, read once from the environment and validated before anything starts.
 * A missing credential, an unsafe mainnet setting or a malformed value stops the process with a
 * message naming the variable; nothing is guessed.
 */
export interface Config {
  readonly port: number;
  readonly host: string;
  readonly logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  readonly store: { readonly kind: "postgres"; readonly url: string } | { readonly kind: "memory" };
  readonly networks: readonly NetworkConfig[];
  readonly http: {
    readonly bodyLimitBytes: number;
    /** Requests per minute per client IP; 0 disables. */
    readonly rateLimitPerMinute: number;
    /** Trust X-Forwarded-For from this many proxy hops (Railway: 1). */
    readonly trustedProxyHops: number;
  };
  readonly auth: {
    /** SHA-256 hex digests of accepted API keys. */
    readonly apiKeyHashes: ReadonlySet<string>;
  };
  readonly observability: {
    /** SHA-256 hex digest of the bearer token /metrics requires; public when unset. */
    readonly metricsTokenSha256: string | undefined;
    readonly contractTtl: {
      readonly pollMs: number;
      /** A watched contract with fewer ledgers left is a /health warning. */
      readonly warnLedgers: number;
      /** A watched contract with fewer ledgers left makes /health report `degraded`. */
      readonly criticalLedgers: number;
    };
  };
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
    /** Answer a payment another party's transaction landed first, exactly as signed, as settled there. */
    readonly reconcileThirdParty: boolean;
  };
  /** Price per successful settlement charged to API-key holders, in US dollars (metered, billed off-chain). */
  readonly serviceFeePerSettlementUsd: string;
  readonly bazaar: {
    readonly enabled: boolean;
    /** Catalog and fetch loopback resources. For conformance runs on a local network only. */
    readonly allowLoopback: boolean;
    readonly maxNewListingsPerOwnerPerHour: number;
    readonly maxNewListingsPerPayerPerHour: number;
    readonly maxNewListingsPerHour: number;
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
}

export interface NetworkConfig {
  readonly network: StellarNetwork;
  readonly rpcUrl: string;
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
  /** Create missing channel accounts at startup (sponsor pays their reserves). */
  readonly autoProvisionChannels: boolean;
  /**
   * Contracts whose TTL is watched: every accepted asset, the `upto` settlement contract when `upto`
   * is served, then the extra contracts configured.
   */
  readonly ttlContracts: readonly { readonly alias: string; readonly contract: string }[];
  /** `upto` on this network; undefined when it is not served. */
  readonly upto: UptoConfig | undefined;
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
}

/** The TTL alias of the `upto` settlement contract in metrics and `/health`. */
export const UPTO_TTL_ALIAS = "upto";

/**
 * The `upto` fee ceiling on testnet unless configured. A smart account's first payment can create
 * state of its own: under OpenZeppelin's spending-limit policy the policy's record of the account is
 * written, and its rent makes that one payment cost several times more than later ones. Testnet
 * serves every kind of payer; pubnet keeps the tighter default until its operator decides.
 */
export const TESTNET_UPTO_MAX_TX_FEE_STROOPS = 5_000_000;

/**
 * The `exact` fee ceiling on testnet unless configured. A payment to a recipient that has never held
 * the token creates its balance entry, and a custom SEP-41 token loads its whole contract code: on
 * testnet such first payments were simulated at 316,000 to 463,000 stroops, above pubnet's default.
 * Testnet sponsors are funded by Friendbot, so the ceiling there leaves room for every such payment.
 */
export const TESTNET_MAX_TX_FEE_STROOPS = 1_000_000;

export class ConfigError extends Error {
  override readonly name = "ConfigError";
  /**
   * A stable identifier for a configuration that parses but does not match the network, found at
   * startup (for example `asset_decimals_mismatch`); unset for errors in the variables themselves.
   */
  readonly code: string | undefined;

  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

const int = (min: number, max = Number.MAX_SAFE_INTEGER) => z.coerce.number().int().min(min).max(max);
const bool = z.enum(["true", "false"]).transform((value) => value === "true");

const baseSchema = z.object({
  PORT: int(1, 65_535).default(8080),
  HOST: z.string().min(1).default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  STORE: z.enum(["postgres", "memory"]).default("postgres"),
  DATABASE_URL: z.url().optional(),
  NETWORKS: z.string().min(1).default(TESTNET),
  BODY_LIMIT_BYTES: int(1_024, 1_048_576).default(131_072),
  RATE_LIMIT_PER_MINUTE: int(0).default(600),
  TRUSTED_PROXY_HOPS: int(0, 10).default(0),
  API_KEY_SHA256: z.string().default(""),
  SHUTDOWN_GRACE_MS: int(0, 600_000).default(30_000),
  RECONCILE_INTERVAL_MS: int(1_000, 600_000).default(5_000),
  SETTLE_CHANNEL_WAIT_MS: int(0, 120_000).default(5_000),
  SETTLE_CONFIRM_TIMEOUT_MS: int(0, 300_000).default(25_000),
  /** Unset: SETTLE_CONFIRM_TIMEOUT_MS plus 5 s. */
  SETTLE_RECONCILE_IDLE_MS: int(0, 600_000).optional(),
  RECONCILE_THIRD_PARTY_SETTLEMENTS: bool.default(true),
  METRICS_TOKEN_SHA256: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "must be a SHA-256 hex digest")
    .optional(),
  CONTRACT_TTL_POLL_MS: int(10_000, 86_400_000).default(300_000),
  CONTRACT_TTL_WARN_LEDGERS: int(0).default(518_400),
  CONTRACT_TTL_CRITICAL_LEDGERS: int(0).default(120_960),
  SERVICE_FEE_PER_SETTLEMENT_USD: z
    .string()
    .regex(/^\d{1,6}(\.\d{1,7})?$/, "must be a decimal amount in US dollars")
    .default("0"),
  BAZAAR_ENABLED: bool.default(true),
  DISCOVERY_ALLOW_LOOPBACK: bool.default(false),
  BAZAAR_MAX_NEW_LISTINGS_PER_OWNER_PER_HOUR: int(1, 100_000).default(20),
  BAZAAR_MAX_NEW_LISTINGS_PER_PAYER_PER_HOUR: int(1, 100_000).default(10),
  BAZAAR_MAX_NEW_LISTINGS_PER_HOUR: int(1, 10_000_000).default(1_000),
  ORIGIN_CHECK_INTERVAL_MS: int(1_000, 3_600_000).default(5_000),
  SEARCH_EMBEDDINGS: bool.default(true),
  SEARCH_MODEL_DIR: z.string().min(1).default(".models"),
  SEARCH_MODEL_DOWNLOAD: bool.default(false),
  SEARCH_CURSOR_SECRET: z
    .string()
    .regex(/^[0-9a-fA-F]{64,}$/, "must be at least 32 bytes of hex")
    .optional(),
  SEARCH_SIMILARITY_FLOOR: z.coerce.number().min(-1).max(1).default(0.3),
});

const networkSchema = z.object({
  RPC_URL: z.url(),
  SPONSOR_SECRET: z
    .string()
    .refine((value) => StrKey.isValidEd25519SecretSeed(value), "must be an S… secret seed"),
  CHANNEL_COUNT: int(1, 1_000).default(8),
  ASSETS: z.string().optional(),
  MAX_TX_FEE_STROOPS: int(MIN_INCLUSION_FEE_STROOPS).optional(),
  INCLUSION_FEE_STROOPS: int(MIN_INCLUSION_FEE_STROOPS).default(MIN_INCLUSION_FEE_STROOPS),
  // At least one: an authorization expiring at the current ledger can no longer be included.
  EXPIRATION_MARGIN_LEDGERS: int(1, 100).default(DEFAULT_EXPIRATION_MARGIN_LEDGERS),
  TIMEOUT_MIN_SECONDS: int(1).default(DEFAULT_TIMEOUT_SECONDS.min),
  TIMEOUT_MAX_SECONDS: int(1).default(DEFAULT_TIMEOUT_SECONDS.max),
  MIN_SPONSOR_BALANCE_XLM: int(0).default(25),
  SPONSOR_RESERVE_XLM: int(0).default(5),
  MAX_SPONSOR_SPEND_XLM_PER_HOUR: int(1).optional(),
  INCLUSION_FEE_CAP_STROOPS: int(MIN_INCLUSION_FEE_STROOPS).default(10_000),
  INCLUSION_FEE_PERCENTILE: z.enum(["p50", "p70", "p80", "p90", "p95", "p99"]).default("p90"),
  REQUIRE_API_KEY: bool.optional(),
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
  UPTO_LEDGER_SECONDS: z.coerce.number().positive().max(60).optional(),
  UPTO_TTL_KEEPER: bool.default(true),
  UPTO_TTL_EXTEND_BELOW_LEDGERS: int(1).default(518_400),
  UPTO_TTL_EXTEND_TO_LEDGERS: int(2).optional(),
  UPTO_TTL_AUTO_RESTORE: bool.optional(),
  UPTO_TTL_MAX_FEE_STROOPS: int(MIN_INCLUSION_FEE_STROOPS).default(500_000_000),
});

export function loadConfig(env: Readonly<Record<string, string | undefined>> = process.env): Config {
  const base = parse(baseSchema, env, "");
  const networks = base.NETWORKS.split(",").map((value) => value.trim());
  for (const network of networks) {
    if (!isStellarNetwork(network)) throw new ConfigError(`NETWORKS: unknown network "${network}"`);
  }
  if (new Set(networks).size !== networks.length) throw new ConfigError("NETWORKS lists a network twice");

  if (base.STORE === "postgres" && base.DATABASE_URL === undefined) {
    throw new ConfigError("DATABASE_URL is required when STORE=postgres");
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

  if (base.CONTRACT_TTL_CRITICAL_LEDGERS > base.CONTRACT_TTL_WARN_LEDGERS) {
    throw new ConfigError("CONTRACT_TTL_CRITICAL_LEDGERS exceeds CONTRACT_TTL_WARN_LEDGERS");
  }

  if (base.DISCOVERY_ALLOW_LOOPBACK && networks.includes(PUBNET)) {
    throw new ConfigError(
      "DISCOVERY_ALLOW_LOOPBACK is for local conformance runs and cannot be enabled with pubnet",
    );
  }

  const sponsors = new Set<string>();
  const networkConfigs = networks.map((network) => {
    const config = loadNetwork(network as StellarNetwork, env, apiKeyHashes.size, base.STORE);
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
        ? { kind: "postgres", url: base.DATABASE_URL }
        : { kind: "memory" },
    networks: networkConfigs,
    http: {
      bodyLimitBytes: base.BODY_LIMIT_BYTES,
      rateLimitPerMinute: base.RATE_LIMIT_PER_MINUTE,
      trustedProxyHops: base.TRUSTED_PROXY_HOPS,
    },
    auth: { apiKeyHashes },
    observability: {
      metricsTokenSha256: base.METRICS_TOKEN_SHA256?.toLowerCase(),
      contractTtl: {
        pollMs: base.CONTRACT_TTL_POLL_MS,
        warnLedgers: base.CONTRACT_TTL_WARN_LEDGERS,
        criticalLedgers: base.CONTRACT_TTL_CRITICAL_LEDGERS,
      },
    },
    shutdownGraceMs: base.SHUTDOWN_GRACE_MS,
    reconcileIntervalMs: base.RECONCILE_INTERVAL_MS,
    settlement: {
      channelWaitMs: base.SETTLE_CHANNEL_WAIT_MS,
      confirmTimeoutMs: base.SETTLE_CONFIRM_TIMEOUT_MS,
      reconcileIdleMs: base.SETTLE_RECONCILE_IDLE_MS ?? base.SETTLE_CONFIRM_TIMEOUT_MS + RECONCILE_MARGIN_MS,
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
      maxNewListingsPerOwnerPerHour: base.BAZAAR_MAX_NEW_LISTINGS_PER_OWNER_PER_HOUR,
      maxNewListingsPerPayerPerHour: base.BAZAAR_MAX_NEW_LISTINGS_PER_PAYER_PER_HOUR,
      maxNewListingsPerHour: base.BAZAAR_MAX_NEW_LISTINGS_PER_HOUR,
      originCheckIntervalMs: base.ORIGIN_CHECK_INTERVAL_MS,
    },
  };
}

function loadNetwork(
  network: StellarNetwork,
  env: Readonly<Record<string, string | undefined>>,
  apiKeyCount: number,
  store: "postgres" | "memory",
): NetworkConfig {
  const prefix = network === PUBNET ? "PUBNET_" : "TESTNET_";
  const values = parse(networkSchema, env, prefix);

  if (network === PUBNET) {
    if (new URL(values.RPC_URL).protocol !== "https:") throw new ConfigError("PUBNET_RPC_URL must use https");
    // Mainnet access control is an operator decision that must be made explicitly.
    if (values.REQUIRE_API_KEY === undefined) {
      throw new ConfigError("PUBNET_REQUIRE_API_KEY must be set to true or false when pubnet is enabled");
    }
    // So is what the fee sponsor may spend: every settlement it sponsors costs real XLM.
    if (values.MAX_SPONSOR_SPEND_XLM_PER_HOUR === undefined) {
      throw new ConfigError(
        "PUBNET_MAX_SPONSOR_SPEND_XLM_PER_HOUR must be set when pubnet is enabled: it bounds the XLM the fee sponsor spends per hour",
      );
    }
  }
  const requireApiKey = values.REQUIRE_API_KEY ?? false;
  if (requireApiKey && apiKeyCount === 0) {
    throw new ConfigError(`${prefix}REQUIRE_API_KEY=true needs at least one key in API_KEY_SHA256`);
  }
  if (values.TIMEOUT_MIN_SECONDS > values.TIMEOUT_MAX_SECONDS) {
    throw new ConfigError(`${prefix}TIMEOUT_MIN_SECONDS exceeds ${prefix}TIMEOUT_MAX_SECONDS`);
  }
  const maxTransactionFeeStroops =
    values.MAX_TX_FEE_STROOPS ??
    (network === TESTNET ? TESTNET_MAX_TX_FEE_STROOPS : DEFAULT_MAX_TRANSACTION_FEE_STROOPS);
  if (values.INCLUSION_FEE_STROOPS > maxTransactionFeeStroops) {
    throw new ConfigError(`${prefix}INCLUSION_FEE_STROOPS exceeds ${prefix}MAX_TX_FEE_STROOPS`);
  }
  if (values.INCLUSION_FEE_CAP_STROOPS < values.INCLUSION_FEE_STROOPS) {
    throw new ConfigError(`${prefix}INCLUSION_FEE_CAP_STROOPS is below ${prefix}INCLUSION_FEE_STROOPS`);
  }
  if (values.INCLUSION_FEE_CAP_STROOPS > maxTransactionFeeStroops) {
    throw new ConfigError(`${prefix}INCLUSION_FEE_CAP_STROOPS exceeds ${prefix}MAX_TX_FEE_STROOPS`);
  }

  const assets =
    values.ASSETS === undefined
      ? [acceptedAsset(USDC[network])]
      : parseAssets(values.ASSETS, `${prefix}ASSETS`);

  const upto = loadUpto(network, values, prefix, store);
  const watched = watchedContracts(assets, values.TTL_CONTRACTS, `${prefix}TTL_CONTRACTS`, upto?.contract);

  return {
    network,
    rpcUrl: values.RPC_URL,
    sponsorSecret: values.SPONSOR_SECRET,
    channelCount: values.CHANNEL_COUNT,
    assets,
    assetsVariable: `${prefix}ASSETS`,
    maxTransactionFeeStroops,
    inclusionFeeStroops: values.INCLUSION_FEE_STROOPS,
    expirationMarginLedgers: values.EXPIRATION_MARGIN_LEDGERS,
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
    // Provisioning locks sponsor XLM in reserves; on mainnet that is an explicit operator action.
    autoProvisionChannels: values.AUTO_PROVISION_CHANNELS ?? network === TESTNET,
    ttlContracts: watched,
    upto,
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
): UptoConfig | undefined {
  if (!(values.UPTO_ENABLED ?? network === TESTNET)) return undefined;
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
  if (network === PUBNET && (values.UPTO_CONTRACT === undefined || values.UPTO_WASM_HASH === undefined)) {
    throw new ConfigError(
      `${prefix}UPTO_ENABLED=true needs ${prefix}UPTO_CONTRACT and ${prefix}UPTO_WASM_HASH on pubnet`,
    );
  }
  const contract = values.UPTO_CONTRACT ?? canonical?.address;
  if (contract === undefined) {
    throw new ConfigError(`${prefix}UPTO_CONTRACT is required: ${network} has no canonical upto contract`);
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
    throw new ConfigError(`${prefix}UPTO_WASM_HASH is required with a non-canonical ${prefix}UPTO_CONTRACT`);
  }
  const maxTransactionFeeStroops =
    values.UPTO_MAX_TX_FEE_STROOPS ??
    (network === TESTNET ? TESTNET_UPTO_MAX_TX_FEE_STROOPS : DEFAULT_UPTO_MAX_TRANSACTION_FEE_STROOPS);
  if (maxTransactionFeeStroops < values.INCLUSION_FEE_STROOPS) {
    throw new ConfigError(`${prefix}INCLUSION_FEE_STROOPS exceeds ${prefix}UPTO_MAX_TX_FEE_STROOPS`);
  }
  // upto refuses timeouts shorter than one ledger more than the margin; some must remain.
  if (minTimeoutSecondsFor(values.EXPIRATION_MARGIN_LEDGERS) > values.TIMEOUT_MAX_SECONDS) {
    throw new ConfigError(
      `${prefix}TIMEOUT_MAX_SECONDS must be at least ${minTimeoutSecondsFor(values.EXPIRATION_MARGIN_LEDGERS)} for upto with ${prefix}EXPIRATION_MARGIN_LEDGERS=${values.EXPIRATION_MARGIN_LEDGERS}`,
    );
  }
  const extendTo = values.UPTO_TTL_EXTEND_TO_LEDGERS;
  if (extendTo !== undefined && extendTo <= values.UPTO_TTL_EXTEND_BELOW_LEDGERS) {
    throw new ConfigError(
      `${prefix}UPTO_TTL_EXTEND_TO_LEDGERS must exceed ${prefix}UPTO_TTL_EXTEND_BELOW_LEDGERS`,
    );
  }
  return {
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
      maxFeeStroops: values.UPTO_TTL_MAX_FEE_STROOPS,
    },
  };
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
 * `CBIELTK6…DAMA:USDC:7,CAB…XYZ:EURC:7:10000:100000000`. Amounts are in base units.
 */
export function parseAssets(value: string, name: string): AcceptedAsset[] {
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
