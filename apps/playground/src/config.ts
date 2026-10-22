import { z } from "zod";
import { Asset, StrKey } from "@stellar/stellar-sdk";
import { TESTNET, USDC, networkPassphrase } from "@rail402.dev/stellar";
import { UPTO_TESTNET_DEPLOYMENT } from "@rail402.dev/upto";
import {
  CHECK_IDS,
  CHECK_NEEDS,
  DEFAULT_CAPS,
  EXPERIMENT_IDS,
  EXPERIMENT_NEEDS,
  LAB_PATHS,
  LAB_PRICES,
  SCENARIO_IDS,
  SCENARIO_NEEDS,
} from "./shared/lab.ts";
import { type PublicConfig, publicConfigSchema } from "./shared/public-config.ts";
import { RELAY_LIMITS, RELAY_MAX_REDIRECTS, RELAY_TIMEOUT_MAXIMA } from "./shared/relay-protocol.ts";

/**
 * The Playground server's configuration, read once from the environment and validated before anything
 * starts. It holds no secret: there is no field for one, and startup refuses any environment value that
 * is a Stellar secret seed. Every value is public and most of it is published at `/api/config`.
 */
export interface PlaygroundConfig {
  readonly port: number;
  /** The listening address: `::` by default, and only loopback (default 127.0.0.1) in local mode. */
  readonly host: string;
  /** `local` lets the relay reach loopback sellers over http; loopback PUBLIC_URL only. */
  readonly mode: "hosted" | "local";
  /** The Playground's own origin, without a trailing slash. */
  readonly publicUrl: string;
  readonly network: typeof TESTNET;
  readonly urls: {
    readonly rpc: string;
    readonly horizon: string;
    readonly friendbot: string;
    readonly facilitator: string;
    readonly bazaar: string;
    readonly demoSeller: string;
    readonly docs: string;
  };
  readonly asset: {
    readonly contract: string;
    readonly symbol: string;
    readonly decimals: number;
    readonly classic: { readonly code: string; readonly issuer: string };
  };
  readonly uptoContract: string;
  /** The account lab sellers are paid to; undefined when the lab is off. */
  readonly payTo: string | undefined;
  readonly explorerTemplate: string;
  readonly faucetUrl: string;
  readonly features: { readonly relay: boolean; readonly lab: boolean };
  /** Host names the relay never contacts, besides the Playground, facilitator and Bazaar hosts. */
  readonly relayDenyHosts: readonly string[];
  /**
   * Other names of the Playground itself, refused as a loop like its own host: the platform's generated
   * domain (`RAILWAY_PUBLIC_DOMAIN`) when it is set.
   */
  readonly relayLoopHosts: readonly string[];
  /** Host names allowed the higher per-host relay rate (the demo seller by default). */
  readonly relayTrustedHosts: readonly string[];
  readonly limits: Limits;
  /** Trust X-Forwarded-For from this many proxy hops (0 when it is reached directly). */
  readonly trustedProxyHops: number;
  readonly logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace";
  /** SHA-256 hex digest of the bearer token /metrics requires; public when unset. */
  readonly metricsTokenSha256: string | undefined;
  readonly version: string;
  readonly commit: string;
}

/** Abuse limits; rates are per minute, every one configurable. */
export interface Limits {
  readonly relayUnpaidPerMinute: number;
  readonly relayUnpaidBurst: number;
  /** Unpaid relay calls of one network (an IPv4 address or an IPv6 /48), across its clients. */
  readonly relayUnpaidPerNetworkPerMinute: number;
  readonly relayPaidPerMinute: number;
  /** Paid relay calls to hosts other than the trusted ones, across every client. */
  readonly relayPaidGlobalPerMinute: number;
  /** Paid relay calls to the trusted hosts (the demo seller), a pool of their own. */
  readonly relayTrustedPaidGlobalPerMinute: number;
  readonly relayInFlightPerIp: number;
  readonly relayInFlightGlobal: number;
  /** Relay calls in flight to one destination host. */
  readonly relayInFlightPerHost: number;
  readonly relayStreamsPerIp: number;
  /** Longest a streamed (event-stream) relay exchange may last. */
  readonly relayStreamMaxMs: number;
  readonly relayHostPerMinute: number;
  readonly relayTrustedHostPerMinute: number;
  readonly relayBytesPerIpPerDay: number;
  readonly relayBytesPerNetworkPerDay: number;
  readonly relayBytesGlobalPerDay: number;
  readonly proxyPerMinute: number;
  /** Upstream fetches of the Bazaar and facilitator proxies; cached answers do not count. */
  readonly proxyGlobalPerMinute: number;
  readonly labUnpaidPerMinute: number;
  readonly labPaidPerMinute: number;
  readonly labPaidGlobalPerMinute: number;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

const SDF_TESTNET = Object.freeze({
  rpc: "https://soroban-testnet.stellar.org",
  horizon: "https://horizon-testnet.stellar.org",
  friendbot: "https://friendbot.stellar.org",
});
/** Circle's testnet USDC issuer: its asset contract is USDC[TESTNET].contract. */
const USDC_TESTNET_CLASSIC = "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const RAIL402_TESTNET = "https://testnet.rail402.dev";
const DEMO_SELLER = "https://demo.rail402.dev";

const int = (min: number, max = Number.MAX_SAFE_INTEGER) => z.coerce.number().int().min(min).max(max);
const bool = z.enum(["true", "false"]).transform((value) => value === "true");
const httpUrl = z.url({ protocol: /^https?$/ }).transform((value) => value.replace(/\/+$/, ""));
const hostList = z
  .string()
  .default("")
  .transform((value) =>
    value
      .split(",")
      .map((host) => normalizeHost(host))
      .filter((host) => host !== ""),
  );

const schema = z.object({
  PORT: int(1, 65_535).default(8080),
  HOST: z.string().min(1).optional(),
  PLAYGROUND_MODE: z.enum(["hosted", "local"]).default("hosted"),
  PUBLIC_URL: httpUrl,
  NETWORK: z.literal(TESTNET, { error: `only ${TESTNET} is served` }).default(TESTNET),
  RPC_URL: httpUrl.default(SDF_TESTNET.rpc),
  HORIZON_URL: httpUrl.default(SDF_TESTNET.horizon),
  FRIENDBOT_URL: httpUrl.default(SDF_TESTNET.friendbot),
  FACILITATOR_URL: httpUrl.default(RAIL402_TESTNET),
  BAZAAR_URL: httpUrl.default(RAIL402_TESTNET),
  DEMO_SELLER_URL: httpUrl.default(DEMO_SELLER),
  DOCS_URL: httpUrl.default("https://docs.rail402.dev"),
  ASSET_CONTRACT: z
    .string()
    .refine((value) => StrKey.isValidContract(value), "must be a C… contract address")
    .default(USDC[TESTNET].contract),
  ASSET_SYMBOL: z.string().min(1).max(12).default(USDC[TESTNET].symbol),
  ASSET_DECIMALS: int(0, 18).default(USDC[TESTNET].decimals),
  ASSET_CLASSIC: z
    .string()
    .regex(/^[A-Za-z0-9]{1,12}:G[A-Z2-7]{55}$/, "must be CODE:G… (the classic asset behind the contract)")
    .default(USDC_TESTNET_CLASSIC),
  UPTO_CONTRACT: z
    .string()
    .refine((value) => StrKey.isValidContract(value), "must be a C… contract address")
    .default(UPTO_TESTNET_DEPLOYMENT.address),
  PLAYGROUND_PAY_TO: z
    .string()
    .refine((value) => StrKey.isValidEd25519PublicKey(value), "must be a G… account address")
    .optional(),
  EXPLORER_TEMPLATE: z
    .string()
    .refine(isExplorerTemplate, "must be an https URL containing {hash}")
    .default("https://stellar.expert/explorer/{network}/tx/{hash}"),
  FAUCET_URL: httpUrl.default("https://faucet.circle.com"),
  RELAY_ENABLED: bool.default(true),
  LAB_ENABLED: bool.default(true),
  RELAY_DENY_HOSTS: hostList,
  RELAY_TRUSTED_HOSTS: z.string().optional(),
  RELAY_UNPAID_PER_MINUTE: int(1).default(60),
  RELAY_UNPAID_BURST: int(1).default(20),
  RELAY_UNPAID_PER_NETWORK_PER_MINUTE: int(1).default(240),
  RELAY_PAID_PER_MINUTE: int(1).default(20),
  RELAY_PAID_GLOBAL_PER_MINUTE: int(1).default(120),
  RELAY_TRUSTED_PAID_GLOBAL_PER_MINUTE: int(1).default(120),
  RELAY_IN_FLIGHT_PER_IP: int(1).default(4),
  RELAY_IN_FLIGHT_GLOBAL: int(1).default(128),
  RELAY_IN_FLIGHT_PER_HOST: int(1).default(32),
  RELAY_STREAMS_PER_IP: int(1).default(2),
  RELAY_STREAM_MAX_MS: int(1_000, 600_000).default(180_000),
  RELAY_HOST_PER_MINUTE: int(1).default(300),
  RELAY_TRUSTED_HOST_PER_MINUTE: int(1).default(1_200),
  RELAY_BYTES_PER_IP_PER_DAY: int(RELAY_LIMITS.responseBodyBytes).default(100 * 1_048_576),
  RELAY_BYTES_PER_NETWORK_PER_DAY: int(RELAY_LIMITS.responseBodyBytes).default(400 * 1_048_576),
  RELAY_BYTES_GLOBAL_PER_DAY: int(RELAY_LIMITS.responseBodyBytes).default(10 * 1_073_741_824),
  PROXY_PER_MINUTE: int(1).default(120),
  PROXY_GLOBAL_PER_MINUTE: int(1).default(240),
  LAB_UNPAID_PER_MINUTE: int(1).default(120),
  LAB_PAID_PER_MINUTE: int(1).default(20),
  LAB_PAID_GLOBAL_PER_MINUTE: int(1).default(60),
  TRUSTED_PROXY_HOPS: int(0, 10).default(0),
  RAILWAY_PUBLIC_DOMAIN: z.string().optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  METRICS_TOKEN_SHA256: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "must be a SHA-256 hex digest")
    .transform((value) => value.toLowerCase())
    .optional(),
  RAIL402_VERSION: z.string().min(1).max(80).optional(),
  RAIL402_COMMIT: z
    .string()
    .regex(/^[0-9a-f]{0,40}$/, "must be a hex commit id")
    .default(""),
});

/**
 * Reads and validates the configuration. Throws a ConfigError naming the variable on any problem,
 * and when any environment value holds a Stellar secret seed: the Playground never needs one, so one
 * found anywhere is a mistake to stop on, not to ignore. Variable names are never pattern-matched
 * (hosting platforms inject names of their own); only values are.
 */
export function loadConfig(
  env: Readonly<Record<string, string | undefined>>,
  defaults: { readonly version: string },
): PlaygroundConfig {
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && containsSecretSeed(value)) {
      throw new ConfigError(
        `${name} holds a Stellar secret seed; the Playground never takes one. Remove it from the environment.`,
      );
    }
  }
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const [issue] = parsed.error.issues;
    const name = issue?.path.join(".") ?? "environment";
    throw new ConfigError(`${name}: ${issue?.message ?? "invalid"}`);
  }
  const e = parsed.data;

  const publicUrl = new URL(e.PUBLIC_URL);
  if (publicUrl.pathname !== "/" || publicUrl.search !== "" || publicUrl.hash !== "") {
    throw new ConfigError("PUBLIC_URL must be an origin such as https://playground.rail402.dev");
  }
  const loopback = isLoopbackHost(publicUrl.hostname);
  if (publicUrl.protocol !== "https:" && !loopback) {
    throw new ConfigError("PUBLIC_URL must use https unless it is a loopback address");
  }
  if (e.PLAYGROUND_MODE === "local" && !loopback) {
    throw new ConfigError("PLAYGROUND_MODE=local is allowed only with a loopback PUBLIC_URL");
  }
  // Local mode lets the relay reach loopback services, so only this machine may reach the server.
  if (e.PLAYGROUND_MODE === "local" && e.HOST !== undefined && !isLoopbackHost(e.HOST)) {
    throw new ConfigError(
      "HOST must be a loopback address (127.0.0.1, ::1 or localhost) while PLAYGROUND_MODE=local",
    );
  }
  if (e.LAB_ENABLED && e.PLAYGROUND_PAY_TO === undefined) {
    throw new ConfigError("PLAYGROUND_PAY_TO is required while LAB_ENABLED=true (a public G… address)");
  }

  const [code = "", issuer = ""] = e.ASSET_CLASSIC.split(":");
  const passphrase = networkPassphrase(TESTNET);
  if (new Asset(code, issuer).contractId(passphrase) !== e.ASSET_CONTRACT) {
    throw new ConfigError("ASSET_CLASSIC does not match ASSET_CONTRACT on this network");
  }

  const demoSellerHost = normalizeHost(new URL(e.DEMO_SELLER_URL).hostname);
  const trustedHosts =
    e.RELAY_TRUSTED_HOSTS === undefined
      ? [demoSellerHost]
      : e.RELAY_TRUSTED_HOSTS.split(",")
          .map((host) => normalizeHost(host))
          .filter((host) => host !== "");

  return {
    port: e.PORT,
    host: e.HOST ?? (e.PLAYGROUND_MODE === "local" ? "127.0.0.1" : "::"),
    mode: e.PLAYGROUND_MODE,
    publicUrl: publicUrl.origin,
    network: TESTNET,
    urls: {
      rpc: e.RPC_URL,
      horizon: e.HORIZON_URL,
      friendbot: e.FRIENDBOT_URL,
      facilitator: e.FACILITATOR_URL,
      bazaar: e.BAZAAR_URL,
      demoSeller: e.DEMO_SELLER_URL,
      docs: e.DOCS_URL,
    },
    asset: {
      contract: e.ASSET_CONTRACT,
      symbol: e.ASSET_SYMBOL,
      decimals: e.ASSET_DECIMALS,
      classic: { code, issuer },
    },
    uptoContract: e.UPTO_CONTRACT,
    payTo: e.LAB_ENABLED ? e.PLAYGROUND_PAY_TO : undefined,
    explorerTemplate: e.EXPLORER_TEMPLATE,
    faucetUrl: e.FAUCET_URL,
    features: { relay: e.RELAY_ENABLED, lab: e.LAB_ENABLED },
    relayDenyHosts: e.RELAY_DENY_HOSTS,
    relayLoopHosts: [normalizeHost(e.RAILWAY_PUBLIC_DOMAIN ?? "")].filter(
      (host) => host !== "" && host !== normalizeHost(publicUrl.hostname) && URL.canParse(`https://${host}/`),
    ),
    relayTrustedHosts: trustedHosts,
    limits: {
      relayUnpaidPerMinute: e.RELAY_UNPAID_PER_MINUTE,
      relayUnpaidBurst: e.RELAY_UNPAID_BURST,
      relayUnpaidPerNetworkPerMinute: e.RELAY_UNPAID_PER_NETWORK_PER_MINUTE,
      relayPaidPerMinute: e.RELAY_PAID_PER_MINUTE,
      relayPaidGlobalPerMinute: e.RELAY_PAID_GLOBAL_PER_MINUTE,
      relayTrustedPaidGlobalPerMinute: e.RELAY_TRUSTED_PAID_GLOBAL_PER_MINUTE,
      relayInFlightPerIp: e.RELAY_IN_FLIGHT_PER_IP,
      relayInFlightGlobal: e.RELAY_IN_FLIGHT_GLOBAL,
      relayInFlightPerHost: e.RELAY_IN_FLIGHT_PER_HOST,
      relayStreamsPerIp: e.RELAY_STREAMS_PER_IP,
      relayStreamMaxMs: e.RELAY_STREAM_MAX_MS,
      relayHostPerMinute: e.RELAY_HOST_PER_MINUTE,
      relayTrustedHostPerMinute: e.RELAY_TRUSTED_HOST_PER_MINUTE,
      relayBytesPerIpPerDay: e.RELAY_BYTES_PER_IP_PER_DAY,
      relayBytesPerNetworkPerDay: e.RELAY_BYTES_PER_NETWORK_PER_DAY,
      relayBytesGlobalPerDay: e.RELAY_BYTES_GLOBAL_PER_DAY,
      proxyPerMinute: e.PROXY_PER_MINUTE,
      proxyGlobalPerMinute: e.PROXY_GLOBAL_PER_MINUTE,
      labUnpaidPerMinute: e.LAB_UNPAID_PER_MINUTE,
      labPaidPerMinute: e.LAB_PAID_PER_MINUTE,
      labPaidGlobalPerMinute: e.LAB_PAID_GLOBAL_PER_MINUTE,
    },
    trustedProxyHops: e.TRUSTED_PROXY_HOPS,
    logLevel: e.LOG_LEVEL,
    metricsTokenSha256: e.METRICS_TOKEN_SHA256,
    version:
      e.RAIL402_VERSION ??
      (e.RAIL402_COMMIT === "" ? defaults.version : `${defaults.version}+${e.RAIL402_COMMIT.slice(0, 12)}`),
    commit: e.RAIL402_COMMIT,
  };
}

/** The relay's egress policy as the page mirrors it: https:443 to public hosts, plus loopback http locally. */
export function relayPolicyOf(config: PlaygroundConfig): PublicConfig["relay"]["policy"] {
  const local = config.mode === "local";
  return {
    schemes: local ? ["https:", "http:"] : ["https:"],
    // Local mode also allows each target's own port, which the page cannot list in advance.
    ports: local ? [443, 80] : [443],
    allowLoopback: local,
    maxRedirects: RELAY_MAX_REDIRECTS,
  };
}

/**
 * The `/api/config` body. Validated against the shared schema, so a drift fails at startup. Only the
 * scenarios, experiments and checks whose features are on are offered.
 */
export function publicConfigOf(config: PlaygroundConfig): PublicConfig {
  const available = (needs: readonly ("relay" | "lab")[]): boolean =>
    needs.every((feature) => config.features[feature]);
  return publicConfigSchema.parse({
    version: config.version,
    commit: config.commit,
    mode: config.mode,
    network: config.network,
    networkPassphrase: networkPassphrase(config.network),
    urls: { public: config.publicUrl, ...config.urls },
    explorerTemplate: config.explorerTemplate,
    asset: {
      contract: config.asset.contract,
      symbol: config.asset.symbol,
      decimals: config.asset.decimals,
      classic: { ...config.asset.classic },
    },
    uptoContract: config.uptoContract,
    caps: {
      perCallDefault: DEFAULT_CAPS.perCall,
      perCallLowPreset: DEFAULT_CAPS.lowCap,
      perCallCeiling: DEFAULT_CAPS.perCallCeiling,
      sessionTotal: DEFAULT_CAPS.sessionTotal,
      sessionTtlMs: DEFAULT_CAPS.sessionTtlMs,
    },
    lab: {
      enabled: config.features.lab,
      payTo: config.payTo ?? null,
      paths: { sell: LAB_PATHS.sell, greedy: LAB_PATHS.greedy, offers: { ...LAB_PATHS.offers } },
      prices: {
        sell: LAB_PRICES.sell.atomic,
        greedyCap: LAB_PRICES.greedyCap.atomic,
        greedyCharge: LAB_PRICES.greedyCharge.atomic,
      },
      scenarios: SCENARIO_IDS.filter((id) => available(SCENARIO_NEEDS[id])),
      experiments: EXPERIMENT_IDS.filter((id) => available(EXPERIMENT_NEEDS[id])),
      checks: CHECK_IDS.filter((id) => available(CHECK_NEEDS[id])),
    },
    relay: {
      enabled: config.features.relay,
      policy: relayPolicyOf(config),
      limits: { ...RELAY_LIMITS },
      timeoutMaxima: { ...RELAY_TIMEOUT_MAXIMA },
    },
    onboarding: { buyAmount: "1", keepXlm: "10", faucetUrl: config.faucetUrl },
  });
}

/** The connect-src origins the page needs besides its own: RPC, Horizon and Friendbot. */
export function connectOrigins(config: PlaygroundConfig): string[] {
  return [
    ...new Set([config.urls.rpc, config.urls.horizon, config.urls.friendbot].map((u) => new URL(u).origin)),
  ];
}

/** Lower-case, without brackets or a trailing dot. */
export function normalizeHost(host: string): string {
  return host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

/** `localhost`, a 127.0.0.0/8 address or ::1. */
export function isLoopbackHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/** Whether a value is, or contains, a valid Stellar secret seed (`S…`). */
export function containsSecretSeed(value: string): boolean {
  // A lookahead finds overlapping candidates, so a seed glued to other base32 text is still found.
  for (const match of value.matchAll(/(?=(S[A-Z2-7]{55}))/g)) {
    if (StrKey.isValidEd25519SecretSeed(match[1] ?? "")) return true;
  }
  return false;
}

function isExplorerTemplate(template: string): boolean {
  const sample = template.replaceAll("{network}", "testnet").replaceAll("{hash}", "0".repeat(64));
  return template.includes("{hash}") && URL.canParse(sample) && new URL(sample).protocol === "https:";
}
