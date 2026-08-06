import { z } from "zod";
import { Keypair } from "@stellar/stellar-sdk";
import { X402Error } from "@x402-stellar/errors";

/**
 * 12-factor configuration with fail-fast validation.
 *
 * Everything configurable is genuinely config here: networks, RPC endpoints,
 * sponsorship, fees, caller auth, metering, and rate limits.
 *
 * Two rules drive the design:
 *
 * 1. **Testnet must be free and frictionless.** Defaults are zero-fee, no API key, testnet enabled.
 *    A fresh `docker run` with only a secret key yields a working public testnet facilitator.
 *    No mainnet fee is hard-wired anywhere (a hard rule).
 *
 * 2. **Fail at startup, never at first request.** `@x402/stellar`'s `getRpcUrl()` throws for
 *    `stellar:pubnet` when no RPC URL is configured — as a lazy runtime error, that would surface
 *    as a 500 on a real payment. We surface it as a startup error with a coded, actionable message.
 */

export const STELLAR_TESTNET = "stellar:testnet";
export const STELLAR_PUBNET = "stellar:pubnet";
export type StellarNetwork = typeof STELLAR_TESTNET | typeof STELLAR_PUBNET;

const csv = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

/** Stellar secret seeds are S… strings; never log or echo one. */
const secretSeed = z
  .string()
  .refine(s => /^S[A-Z2-7]{55}$/.test(s), "must be a Stellar secret seed (S…, 56 chars)");

const booleanish = (def: boolean) =>
  z
    .string()
    .optional()
    .transform(v => (v === undefined || v === "" ? def : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().max(65535).default(4022),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),

  /** Comma-separated CAIP-2 ids. Both networks are supported. */
  STELLAR_NETWORKS: z.string().default(STELLAR_TESTNET),

  STELLAR_TESTNET_RPC_URL: z.string().url().default("https://soroban-testnet.stellar.org"),
  /** No default: @x402/stellar has none for pubnet and throws without one. */
  STELLAR_PUBNET_RPC_URL: z.string().url().optional(),

  /** Settlement signers. Multiple ⇒ round-robin across sequence numbers (throughput). */
  FACILITATOR_STELLAR_SECRET: secretSeed.optional(),
  FACILITATOR_STELLAR_CHANNEL_SECRETS: z.string().optional(),
  /** Separate fee source, so fee payment is decoupled from sequence-number management. */
  FACILITATOR_STELLAR_FEE_BUMP_SECRET: secretSeed.optional(),

  /**
   * Safety ceiling, not a budget knob. The spec/library default of 50,000 is known to be too low:
   * Stellar's own reference facilitator documents real Soroban resource fees exceeding it.
   */
  MAX_TRANSACTION_FEE_STROOPS: z.coerce.number().int().positive().default(100_000),

  /**
   * Must reflect actual runtime behaviour — never advertise sponsorship falsely.
   *
   * Effectively fixed to `true`: the exact scheme on Stellar settles by rebuilding the transaction
   * with a facilitator-funded source, which IS sponsorship, so `false` is rejected at startup rather
   * than advertised as a lie (see the mismatch guard below). It stays an env var only so the check
   * is explicit and a future non-sponsored flow has a home.
   */
  FEES_SPONSORED: booleanish(true),

  /** Caller authentication. Unset ⇒ open, which is the intended default for free testnet. */
  FACILITATOR_API_KEYS: z.string().optional(),
  /** Networks exempt from auth even when keys are set, so testnet stays frictionless. */
  AUTH_EXEMPT_NETWORKS: z.string().default(STELLAR_TESTNET),

  RATE_LIMIT_ENABLED: booleanish(true),
  RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(120),

  CORS_ORIGINS: z.string().optional(),
  TRUST_PROXY: booleanish(false),

  /**
   * Where the catalog is persisted. Unset ⇒ in-memory, which is the historical behaviour and still
   * the right default for a test or a throwaway run.
   *
   * Set it on any deployment you would be sorry to restart: the catalog is derived state in
   * principle, but "rebuild it from settlement history" is a replay tool nobody has written, so in
   * practice a restart forgets every seller. Uses Node's built-in SQLite — no new dependency, no
   * service to operate. Ranking is unaffected either way (apps/bazaar/src/catalog/persistence.ts).
   */
  CATALOG_DB_PATH: z.string().optional(),
});

export interface NetworkConfig {
  readonly network: StellarNetwork;
  readonly rpcUrl: string;
}

export interface FacilitatorConfig {
  readonly port: number;
  readonly host: string;
  readonly logLevel: string;
  readonly networks: readonly NetworkConfig[];
  readonly signerSecrets: readonly string[];
  readonly feeBumpSecret?: string;
  readonly maxTransactionFeeStroops: number;
  readonly areFeesSponsored: boolean;
  readonly apiKeys: readonly string[];
  readonly authExemptNetworks: readonly string[];
  readonly rateLimit: { enabled: boolean; windowSeconds: number; maxRequests: number };
  readonly corsOrigins: readonly string[];
  readonly trustProxy: boolean;
  /** SQLite file for the catalog, or undefined for in-memory. */
  readonly catalogDbPath?: string;
}

/**
 * Parse and validate configuration, or throw a coded X402Error describing exactly what to fix.
 *
 * @param env - process environment (injectable for tests)
 * @returns validated, frozen configuration
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): FacilitatorConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(i => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new X402Error("config_network_rpc_missing", {
      reason: `Invalid facilitator configuration — ${issues.join("; ")}`,
      details: { issues },
    });
  }
  const e = parsed.data;

  // ── Networks ──────────────────────────────────────────────────────────────
  const requested = csv(e.STELLAR_NETWORKS);
  if (requested.length === 0) {
    throw new X402Error("config_network_rpc_missing", {
      reason: `STELLAR_NETWORKS is empty. Enable at least one of "${STELLAR_TESTNET}" or "${STELLAR_PUBNET}".`,
    });
  }

  const unknown = requested.filter(n => n !== STELLAR_TESTNET && n !== STELLAR_PUBNET);
  if (unknown.length > 0) {
    throw new X402Error("config_network_rpc_missing", {
      reason: `Unsupported network(s) in STELLAR_NETWORKS: ${unknown.join(", ")}. Supported: ${STELLAR_TESTNET}, ${STELLAR_PUBNET}.`,
      details: { unknown },
    });
  }

  const networks: NetworkConfig[] = [];
  for (const network of requested as StellarNetwork[]) {
    if (network === STELLAR_TESTNET) {
      networks.push({ network, rpcUrl: e.STELLAR_TESTNET_RPC_URL });
      continue;
    }
    // Pubnet has no library default and would otherwise throw lazily on the first payment.
    if (!e.STELLAR_PUBNET_RPC_URL) {
      throw new X402Error("config_network_rpc_missing", {
        reason:
          `${STELLAR_PUBNET} is enabled but STELLAR_PUBNET_RPC_URL is not set. ` +
          `@x402/stellar ships no default mainnet RPC endpoint, so one must be configured explicitly.`,
        details: { network: STELLAR_PUBNET, variable: "STELLAR_PUBNET_RPC_URL" },
      });
    }
    networks.push({ network, rpcUrl: e.STELLAR_PUBNET_RPC_URL });
  }

  // ── Signers ───────────────────────────────────────────────────────────────
  const signerSecrets = [
    ...(e.FACILITATOR_STELLAR_SECRET ? [e.FACILITATOR_STELLAR_SECRET] : []),
    ...csv(e.FACILITATOR_STELLAR_CHANNEL_SECRETS),
  ];
  if (signerSecrets.length === 0) {
    throw new X402Error("config_no_signer", {
      reason:
        "No settlement signer configured. Set FACILITATOR_STELLAR_SECRET " +
        "(and optionally FACILITATOR_STELLAR_CHANNEL_SECRETS for higher throughput).",
    });
  }
  for (const secret of signerSecrets) {
    try {
      Keypair.fromSecret(secret);
    } catch {
      // Never echo the secret itself.
      throw new X402Error("config_no_signer", {
        reason: "A configured Stellar signer secret is not a valid seed. Check FACILITATOR_STELLAR_SECRET and FACILITATOR_STELLAR_CHANNEL_SECRETS.",
      });
    }
  }
  const uniqueSigners = [...new Set(signerSecrets)];
  if (uniqueSigners.length !== signerSecrets.length) {
    throw new X402Error("config_no_signer", {
      reason:
        "Duplicate signer secrets configured. Each channel account must be distinct, " +
        "otherwise they share a sequence number and provide no throughput benefit.",
    });
  }

  if (e.FACILITATOR_STELLAR_FEE_BUMP_SECRET) {
    try {
      Keypair.fromSecret(e.FACILITATOR_STELLAR_FEE_BUMP_SECRET);
    } catch {
      throw new X402Error("config_no_signer", {
        reason: "FACILITATOR_STELLAR_FEE_BUMP_SECRET is not a valid Stellar secret seed.",
      });
    }
  }

  // ── Truthful sponsorship ──────────────────────────────────────────────────
  // areFeesSponsored is advertised on /supported. It must describe what actually happens: the
  // facilitator sponsors fees precisely because it rebuilds the transaction with its own account
  // as source and pays from its own balance. Disabling sponsorship while still settling would
  // make the advertisement a lie, which is forbidden.
  if (!e.FEES_SPONSORED) {
    throw new X402Error("config_fee_sponsorship_mismatch", {
      reason:
        "FEES_SPONSORED=false is not supported: the exact scheme on Stellar settles by rebuilding " +
        "the transaction with a facilitator-funded source account, which IS fee sponsorship. " +
        "Advertising areFeesSponsored=false while doing so would be false advertising. " +
        "A non-sponsored flow is not yet defined by the spec.",
    });
  }

  return Object.freeze({
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    networks: Object.freeze(networks),
    signerSecrets: Object.freeze(uniqueSigners),
    ...(e.FACILITATOR_STELLAR_FEE_BUMP_SECRET
      ? { feeBumpSecret: e.FACILITATOR_STELLAR_FEE_BUMP_SECRET }
      : {}),
    maxTransactionFeeStroops: e.MAX_TRANSACTION_FEE_STROOPS,
    areFeesSponsored: e.FEES_SPONSORED,
    apiKeys: Object.freeze(csv(e.FACILITATOR_API_KEYS)),
    authExemptNetworks: Object.freeze(csv(e.AUTH_EXEMPT_NETWORKS)),
    rateLimit: Object.freeze({
      enabled: e.RATE_LIMIT_ENABLED,
      windowSeconds: e.RATE_LIMIT_WINDOW_SECONDS,
      maxRequests: e.RATE_LIMIT_MAX_REQUESTS,
    }),
    corsOrigins: Object.freeze(csv(e.CORS_ORIGINS)),
    trustProxy: e.TRUST_PROXY,
    ...(e.CATALOG_DB_PATH ? { catalogDbPath: e.CATALOG_DB_PATH } : {}),
  });
}

/** Redacted view for startup logging — never emits secrets. */
export function describeConfig(config: FacilitatorConfig): Record<string, unknown> {
  return {
    port: config.port,
    networks: config.networks.map(n => n.network),
    signerCount: config.signerSecrets.length,
    feeBump: config.feeBumpSecret ? "configured" : "disabled",
    maxTransactionFeeStroops: config.maxTransactionFeeStroops,
    areFeesSponsored: config.areFeesSponsored,
    auth: config.apiKeys.length > 0 ? `${config.apiKeys.length} key(s)` : "open",
    authExemptNetworks: config.authExemptNetworks,
    rateLimit: config.rateLimit.enabled
      ? `${config.rateLimit.maxRequests}/${config.rateLimit.windowSeconds}s`
      : "disabled",
  };
}
