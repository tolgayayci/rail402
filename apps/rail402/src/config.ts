import { z } from "zod";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { PUBNET, TESTNET, USDC, isStellarNetwork, type StellarNetwork } from "@rail402.dev/stellar";
import {
  DEFAULT_EXPIRATION_MARGIN_LEDGERS,
  DEFAULT_MAX_TRANSACTION_FEE_STROOPS,
  DEFAULT_TIMEOUT_SECONDS,
  MIN_INCLUSION_FEE_STROOPS,
  acceptedAsset,
  type AcceptedAsset,
} from "@rail402.dev/facilitator";

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
  readonly shutdownGraceMs: number;
  readonly reconcileIntervalMs: number;
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
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
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
  MAX_TX_FEE_STROOPS: int(MIN_INCLUSION_FEE_STROOPS).default(DEFAULT_MAX_TRANSACTION_FEE_STROOPS),
  INCLUSION_FEE_STROOPS: int(MIN_INCLUSION_FEE_STROOPS).default(MIN_INCLUSION_FEE_STROOPS),
  EXPIRATION_MARGIN_LEDGERS: int(0, 100).default(DEFAULT_EXPIRATION_MARGIN_LEDGERS),
  TIMEOUT_MIN_SECONDS: int(1).default(DEFAULT_TIMEOUT_SECONDS.min),
  TIMEOUT_MAX_SECONDS: int(1).default(DEFAULT_TIMEOUT_SECONDS.max),
  MIN_SPONSOR_BALANCE_XLM: int(0).default(25),
  SPONSOR_RESERVE_XLM: int(0).default(5),
  MAX_SPONSOR_SPEND_XLM_PER_HOUR: int(1).optional(),
  INCLUSION_FEE_CAP_STROOPS: int(MIN_INCLUSION_FEE_STROOPS).default(10_000),
  INCLUSION_FEE_PERCENTILE: z.enum(["p50", "p70", "p80", "p90", "p95", "p99"]).default("p90"),
  REQUIRE_API_KEY: bool.optional(),
  AUTO_PROVISION_CHANNELS: bool.optional(),
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

  if (base.DISCOVERY_ALLOW_LOOPBACK && networks.includes(PUBNET)) {
    throw new ConfigError(
      "DISCOVERY_ALLOW_LOOPBACK is for local conformance runs and cannot be enabled with pubnet",
    );
  }

  const sponsors = new Set<string>();
  const networkConfigs = networks.map((network) => {
    const config = loadNetwork(network as StellarNetwork, env, apiKeyHashes.size);
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
    shutdownGraceMs: base.SHUTDOWN_GRACE_MS,
    reconcileIntervalMs: base.RECONCILE_INTERVAL_MS,
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
): NetworkConfig {
  const prefix = network === PUBNET ? "PUBNET_" : "TESTNET_";
  const values = parse(networkSchema, env, prefix);

  if (network === PUBNET) {
    if (new URL(values.RPC_URL).protocol !== "https:") throw new ConfigError("PUBNET_RPC_URL must use https");
    // Mainnet access control is an operator decision that must be made explicitly.
    if (values.REQUIRE_API_KEY === undefined) {
      throw new ConfigError("PUBNET_REQUIRE_API_KEY must be set to true or false when pubnet is enabled");
    }
  }
  const requireApiKey = values.REQUIRE_API_KEY ?? false;
  if (requireApiKey && apiKeyCount === 0) {
    throw new ConfigError(`${prefix}REQUIRE_API_KEY=true needs at least one key in API_KEY_SHA256`);
  }
  if (values.TIMEOUT_MIN_SECONDS > values.TIMEOUT_MAX_SECONDS) {
    throw new ConfigError(`${prefix}TIMEOUT_MIN_SECONDS exceeds ${prefix}TIMEOUT_MAX_SECONDS`);
  }
  if (values.INCLUSION_FEE_STROOPS > values.MAX_TX_FEE_STROOPS) {
    throw new ConfigError(`${prefix}INCLUSION_FEE_STROOPS exceeds ${prefix}MAX_TX_FEE_STROOPS`);
  }
  if (values.INCLUSION_FEE_CAP_STROOPS < values.INCLUSION_FEE_STROOPS) {
    throw new ConfigError(`${prefix}INCLUSION_FEE_CAP_STROOPS is below ${prefix}INCLUSION_FEE_STROOPS`);
  }
  if (values.INCLUSION_FEE_CAP_STROOPS > values.MAX_TX_FEE_STROOPS) {
    throw new ConfigError(`${prefix}INCLUSION_FEE_CAP_STROOPS exceeds ${prefix}MAX_TX_FEE_STROOPS`);
  }

  return {
    network,
    rpcUrl: values.RPC_URL,
    sponsorSecret: values.SPONSOR_SECRET,
    channelCount: values.CHANNEL_COUNT,
    assets:
      values.ASSETS === undefined
        ? [acceptedAsset(USDC[network])]
        : parseAssets(values.ASSETS, `${prefix}ASSETS`),
    maxTransactionFeeStroops: values.MAX_TX_FEE_STROOPS,
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
  };
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
