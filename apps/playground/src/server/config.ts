import { z } from "zod";
import { Asset, Keypair, Networks } from "@stellar/stellar-sdk";
import { USDC_TESTNET_ADDRESS } from "@x402/stellar";
import { X402Error } from "@rail402.dev/errors";

/**
 * 12-factor configuration for the playground server, following the facilitator's two rules:
 * defaults must yield a working testnet service, and anything wrong fails at startup with a coded
 * error — never at the first browser session.
 *
 * The playground is testnet-only by design: it exists to hand strangers a funded wallet, which is
 * only ever safe with test funds. There is deliberately no network knob.
 */

export const NETWORK = "stellar:testnet" as const;
export const NETWORK_PASSPHRASE = Networks.TESTNET;
export const HORIZON_URL = "https://horizon-testnet.stellar.org";
export const FRIENDBOT_URL = "https://friendbot.stellar.org";
export const RPC_URL = "https://soroban-testnet.stellar.org";

/**
 * The canonical testnet USDC issuer. A hint, not a fact: `loadConfig` verifies it by deriving the
 * SAC and comparing against `@x402/stellar`'s `USDC_TESTNET_ADDRESS` — the same
 * verify-rather-than-remember rule the canary's provisioning uses. A lookalike "USDC" from a
 * different issuer derives a different contract address and fails startup.
 */
const USDC_ISSUER_HINT = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8090),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),

  /** The wallet that drips USDC to fresh sessions. The one secret this service holds. */
  PLAYGROUND_DISPENSER_SECRET: z.string().optional(),

  /** The facilitator every demo flow verifies and settles through. */
  PLAYGROUND_FACILITATOR_URL: z.string().url().default("https://facilitator.rail402.dev"),

  /**
   * Where demo-seller payments land. Defaults to the dispenser's own account, which closes the
   * loop: USDC dripped to a session mostly returns as the session pays the demo endpoints.
   */
  PLAYGROUND_PAYTO_ADDRESS: z.string().optional(),

  PLAYGROUND_USDC_ISSUER: z.string().default(USDC_ISSUER_HINT),

  /** Drip size per fresh session, in stroops (7 decimals). 5_000_000 = 0.5 USDC. */
  PLAYGROUND_DRIP_STROOPS: z.coerce.bigint().positive().default(5_000_000n),

  /** Price of the exact-scheme demo endpoint, in stroops. 500_000 = 0.05 USDC. */
  PLAYGROUND_EXACT_PRICE_STROOPS: z.coerce.bigint().positive().default(500_000n),

  /** Cost of one metered-demo call, in stroops. 70_000 = 0.007 USDC. */
  PLAYGROUND_METER_UNIT_STROOPS: z.coerce.bigint().positive().default(70_000n),

  /** Dispenser rate limits: max drips per window, per client IP and per account. */
  PLAYGROUND_RATE_WINDOW_SECONDS: z.coerce.number().int().positive().default(3600),
  PLAYGROUND_RATE_MAX_PER_IP: z.coerce.number().int().positive().default(6),
  PLAYGROUND_RATE_MAX_PER_ACCOUNT: z.coerce.number().int().positive().default(2),

  /** CORS for the playground API itself. The demo exists to be called from browsers. */
  PLAYGROUND_CORS_ORIGINS: z.string().default("*"),

  /**
   * Public base URL of this deployment, used in 402 challenges and discovery metadata. Behind a
   * proxy the request URL shows the internal host, which would catalog an unreachable resource.
   * Unset ⇒ derived from each request (fine for local runs).
   */
  PLAYGROUND_PUBLIC_URL: z.string().url().optional(),

  /**
   * The Rail402 explorer's read API — the data source for /debug/tx. The default is the
   * explorer's documented custom domain; deployments set this to the concrete host while that
   * domain's DNS record is pending.
   */
  PLAYGROUND_EXPLORER_API_URL: z.string().url().default("https://explorer-api.rail402.dev"),

  /** The explorer's page base, used for outbound "view on the explorer" links. */
  PLAYGROUND_EXPLORER_URL: z.string().url().default("https://explorer.rail402.dev"),
});

export interface PlaygroundConfig {
  readonly port: number;
  readonly logLevel: string;
  readonly dispenser: Keypair;
  readonly facilitatorUrl: string;
  readonly payTo: string;
  readonly usdc: { readonly code: "USDC"; readonly issuer: string; readonly sac: string };
  readonly dripStroops: bigint;
  readonly exactPriceStroops: bigint;
  readonly meterUnitStroops: bigint;
  readonly rate: {
    readonly windowSeconds: number;
    readonly maxPerIp: number;
    readonly maxPerAccount: number;
  };
  readonly corsOrigins: readonly string[];
  readonly publicUrl: string | undefined;
  readonly explorerApiUrl: string;
  readonly explorerUrl: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PlaygroundConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new X402Error("config_invalid_value", {
      reason: `Playground configuration is invalid: ${parsed.error.issues
        .map(i => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}. Fix the environment and restart.`,
    });
  }
  const e = parsed.data;

  if (!e.PLAYGROUND_DISPENSER_SECRET) {
    throw new X402Error("config_missing_required", {
      reason:
        "PLAYGROUND_DISPENSER_SECRET is not set. The playground cannot fund sessions without a dispenser wallet. Provide the secret key of a testnet account holding USDC.",
    });
  }
  let dispenser: Keypair;
  try {
    dispenser = Keypair.fromSecret(e.PLAYGROUND_DISPENSER_SECRET);
  } catch {
    throw new X402Error("config_invalid_value", {
      reason:
        "PLAYGROUND_DISPENSER_SECRET is not a valid Stellar secret key (expected an S… strkey).",
    });
  }

  const sac = new Asset("USDC", e.PLAYGROUND_USDC_ISSUER).contractId(NETWORK_PASSPHRASE);
  if (sac !== USDC_TESTNET_ADDRESS) {
    throw new X402Error("config_invalid_value", {
      reason: `PLAYGROUND_USDC_ISSUER ${e.PLAYGROUND_USDC_ISSUER} derives contract ${sac}, not the ${USDC_TESTNET_ADDRESS} that @x402/stellar treats as testnet USDC. A lookalike asset would break every stock client. Do not guess issuers.`,
    });
  }

  const payTo = e.PLAYGROUND_PAYTO_ADDRESS ?? dispenser.publicKey();
  try {
    Keypair.fromPublicKey(payTo);
  } catch {
    throw new X402Error("config_invalid_value", {
      reason:
        "PLAYGROUND_PAYTO_ADDRESS is not a valid Stellar public key (expected a G… strkey).",
    });
  }

  return Object.freeze({
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    dispenser,
    facilitatorUrl: e.PLAYGROUND_FACILITATOR_URL.replace(/\/$/, ""),
    payTo,
    usdc: Object.freeze({ code: "USDC" as const, issuer: e.PLAYGROUND_USDC_ISSUER, sac }),
    dripStroops: e.PLAYGROUND_DRIP_STROOPS,
    exactPriceStroops: e.PLAYGROUND_EXACT_PRICE_STROOPS,
    meterUnitStroops: e.PLAYGROUND_METER_UNIT_STROOPS,
    rate: Object.freeze({
      windowSeconds: e.PLAYGROUND_RATE_WINDOW_SECONDS,
      maxPerIp: e.PLAYGROUND_RATE_MAX_PER_IP,
      maxPerAccount: e.PLAYGROUND_RATE_MAX_PER_ACCOUNT,
    }),
    corsOrigins: Object.freeze(
      e.PLAYGROUND_CORS_ORIGINS.split(",")
        .map(s => s.trim())
        .filter(Boolean),
    ),
    publicUrl: e.PLAYGROUND_PUBLIC_URL?.replace(/\/$/, ""),
    explorerApiUrl: e.PLAYGROUND_EXPLORER_API_URL.replace(/\/$/, ""),
    explorerUrl: e.PLAYGROUND_EXPLORER_URL.replace(/\/$/, ""),
  });
}

/** Redacted view for the startup log line. Never includes the secret. */
export function describeConfig(c: PlaygroundConfig): Record<string, unknown> {
  return {
    port: c.port,
    facilitatorUrl: c.facilitatorUrl,
    dispenserAccount: c.dispenser.publicKey(),
    payTo: c.payTo,
    usdcIssuer: c.usdc.issuer,
    dripStroops: c.dripStroops.toString(),
    exactPriceStroops: c.exactPriceStroops.toString(),
    meterUnitStroops: c.meterUnitStroops.toString(),
    rate: c.rate,
    corsOrigins: c.corsOrigins,
    explorerApiUrl: c.explorerApiUrl,
    explorerUrl: c.explorerUrl,
  };
}
