import { z } from "zod";
import { X402Error } from "@rail402/errors";

/**
 * 12-factor configuration with fail-fast validation, mirroring apps/facilitator/src/config/env.ts.
 *
 * Two rules drive the design:
 *
 * 1. **Network scope is config, never code** (apps/explorer/README.md decision 3). The default is
 *    `stellar:testnet` with built-in endpoints; any additional network is one JSON entry carrying
 *    its passphrase and endpoints. Nothing network-specific is hardcoded outside this module, and
 *    observation is read-only public chain data — this service holds no keys and moves no funds.
 *
 * 2. **Fail at startup, never at first poll.** A watched network with no RPC URL, or malformed
 *    JSON in an override, refuses to start with a coded reason — a typo that silently watches
 *    nothing is indistinguishable from a quiet ledger, and nobody would notice for weeks.
 */

/** Networks with built-in defaults. Anything else needs an EXPLORER_NETWORK_CONFIG entry. */
const BUILTIN_NETWORKS: Record<
  string,
  { passphrase: string; rpcUrl: string; horizonUrl: string }
> = {
  "stellar:testnet": {
    passphrase: "Test SDF Network ; September 2015",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
  },
};

export interface ExplorerNetworkConfig {
  /** CAIP-2 id, e.g. "stellar:testnet". */
  readonly network: string;
  readonly passphrase: string;
  readonly rpcUrl: string;
  readonly horizonUrl: string;
  /**
   * SAC contract IDs whose `transfer` events are watched. EMPTY = watch every transfer event on
   * the network, which is the right default at testnet volume (~1.6 transfer events/ledger,
   * measured 2026-08-13) and catches run-scoped self-issued assets that no allowlist could know.
   * Narrow it on a high-volume network where an unfiltered tail would be expensive.
   */
  readonly watchedSacs: readonly string[];
}

export interface ExplorerConfig {
  readonly port: number;
  readonly host: string;
  readonly logLevel: string;
  readonly networks: readonly ExplorerNetworkConfig[];
  /** SQLite file for the payment store, or undefined for in-memory (tests, throwaway runs). */
  readonly dbPath?: string;
  /** getEvents poll cadence. Ledgers close ~5s apart; polling faster buys nothing. */
  readonly pollIntervalMs: number;
  /** Whether the ingest loop runs. Off = API-only mode over an existing database. */
  readonly ingestEnabled: boolean;
  /** Facilitator base URLs seeded into the registry at startup. */
  readonly facilitatorSeeds: readonly string[];
  /**
   * Bearer tokens for facilitators whose /supported requires auth, keyed by base URL. A base URL
   * here is ALSO seeded automatically. Tokens are secrets — provided by env, never committed.
   */
  readonly facilitatorAuth: ReadonlyMap<string, string>;
  /** How often /supported is re-polled for every registered facilitator. */
  readonly supportedPollIntervalMs: number;
  /**
   * upto settlement contracts watched even before any facilitator advertises them. The registry
   * learns others dynamically from /supported `extra.uptoContract`.
   */
  readonly knownUptoContracts: readonly string[];
  /** Bazaar base URL used to enrich payTo addresses into named resources. */
  readonly bazaarUrl: string;
  /** CORS origins for the read API. "*" is the default — this is public data. */
  readonly corsOrigins: readonly string[];
}

const csv = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

const booleanish = (def: boolean) =>
  z
    .string()
    .optional()
    .transform(v =>
      v === undefined || v === "" ? def : ["1", "true", "yes", "on"].includes(v.toLowerCase()),
    );

const EnvSchema = z.object({
  /** Default deliberately outside 4022–4030: the upstream e2e suite's port allocator owns that band. */
  PORT: z.coerce.number().int().positive().max(65535).default(4040),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),

  /** Comma-separated CAIP-2 ids to observe. */
  EXPLORER_NETWORKS: z.string().default("stellar:testnet"),

  /**
   * Per-network overrides/additions as a JSON object keyed by CAIP-2 id:
   * `{"stellar:testnet":{"rpcUrl":"…","horizonUrl":"…","passphrase":"…","watchedSacs":["C…"]}}`
   * A network without built-in defaults must appear here with at least passphrase + rpcUrl +
   * horizonUrl.
   */
  EXPLORER_NETWORK_CONFIG: z.string().optional(),

  EXPLORER_DB_PATH: z.string().optional(),
  EXPLORER_POLL_INTERVAL_MS: z.coerce.number().int().min(500).default(5000),
  EXPLORER_INGEST_ENABLED: booleanish(true),

  EXPLORER_FACILITATOR_SEEDS: z
    .string()
    .default("https://facilitator.rail402.dev,https://x402.org/facilitator"),
  /**
   * Bearer tokens for facilitators whose /supported needs auth, as JSON `{ "<baseUrl>": "<token>" }`.
   * Each base URL is also seeded. SECRET — set via env/secret manager, never commit a real token.
   * Example: {"https://channels.openzeppelin.com/x402/testnet":"<key>"}
   */
  EXPLORER_FACILITATOR_AUTH: z.string().optional(),
  EXPLORER_SUPPORTED_POLL_INTERVAL_MS: z.coerce.number().int().min(10_000).default(300_000),

  /** The canonical shared upto contract (packages/scheme-upto-stellar/src/constants.ts). */
  EXPLORER_KNOWN_UPTO_CONTRACTS: z
    .string()
    .default("CCMM3FMGEH7FHRYXZ3WQDQCTIWDXGZBGW7D4UT7NKH34SUQACYC3U54X"),

  EXPLORER_BAZAAR_URL: z.string().url().default("https://facilitator.rail402.dev"),

  CORS_ORIGINS: z.string().default("*"),
});

interface NetworkOverride {
  rpcUrl?: string;
  horizonUrl?: string;
  passphrase?: string;
  watchedSacs?: string[];
}

function parseNetworkOverrides(raw: string | undefined): Record<string, NetworkOverride> {
  if (!raw || !raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new X402Error("config_invalid_value", {
      reason: `EXPLORER_NETWORK_CONFIG is not valid JSON: ${error instanceof Error ? error.message : "unknown error"}. Expected an object keyed by CAIP-2 network id.`,
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new X402Error("config_invalid_value", {
      reason: "EXPLORER_NETWORK_CONFIG must be a JSON object keyed by CAIP-2 network id.",
    });
  }
  const out: Record<string, NetworkOverride> = {};
  for (const [network, value] of Object.entries(parsed)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new X402Error("config_invalid_value", {
        reason: `EXPLORER_NETWORK_CONFIG["${network}"] must be an object with rpcUrl/horizonUrl/passphrase/watchedSacs.`,
      });
    }
    const v = value as Record<string, unknown>;
    const entry: NetworkOverride = {};
    for (const field of ["rpcUrl", "horizonUrl", "passphrase"] as const) {
      const fv = v[field];
      if (fv !== undefined) {
        if (typeof fv !== "string" || !fv.trim()) {
          throw new X402Error("config_invalid_value", {
            reason: `EXPLORER_NETWORK_CONFIG["${network}"].${field} must be a non-empty string.`,
          });
        }
        entry[field] = fv;
      }
    }
    if (v["watchedSacs"] !== undefined) {
      if (
        !Array.isArray(v["watchedSacs"]) ||
        v["watchedSacs"].some(s => typeof s !== "string" || !/^C[A-Z2-7]{55}$/.test(s))
      ) {
        throw new X402Error("config_invalid_value", {
          reason: `EXPLORER_NETWORK_CONFIG["${network}"].watchedSacs must be an array of C… contract addresses.`,
        });
      }
      entry.watchedSacs = v["watchedSacs"] as string[];
    }
    out[network] = entry;
  }
  return out;
}

/** Parse and validate configuration, or throw a coded X402Error naming exactly what to fix. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ExplorerConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new X402Error("config_invalid_value", {
      reason: `Configuration variable ${issue?.path.join(".") ?? "(unknown)"} is invalid: ${issue?.message ?? "unparseable"}.`,
    });
  }
  const e = parsed.data;

  const networkIds = csv(e.EXPLORER_NETWORKS);
  if (networkIds.length === 0) {
    throw new X402Error("config_missing_required", {
      reason: "EXPLORER_NETWORKS resolved to an empty list; at least one network must be observed.",
    });
  }
  const overrides = parseNetworkOverrides(e.EXPLORER_NETWORK_CONFIG);

  const networks: ExplorerNetworkConfig[] = networkIds.map(network => {
    const builtin = BUILTIN_NETWORKS[network];
    const override = overrides[network] ?? {};
    const passphrase = override.passphrase ?? builtin?.passphrase;
    const rpcUrl = override.rpcUrl ?? builtin?.rpcUrl;
    const horizonUrl = override.horizonUrl ?? builtin?.horizonUrl;
    if (!passphrase || !rpcUrl || !horizonUrl) {
      throw new X402Error("config_network_rpc_missing", {
        reason: `Network "${network}" has no built-in defaults; EXPLORER_NETWORK_CONFIG must supply passphrase, rpcUrl and horizonUrl for it.`,
      });
    }
    return {
      network,
      passphrase,
      rpcUrl,
      horizonUrl,
      watchedSacs: override.watchedSacs ?? [],
    };
  });

  const facilitatorSeeds = csv(e.EXPLORER_FACILITATOR_SEEDS);
  for (const seed of facilitatorSeeds) {
    let url: URL;
    try {
      url = new URL(seed);
    } catch {
      throw new X402Error("config_invalid_value", {
        reason: `EXPLORER_FACILITATOR_SEEDS entry "${seed}" is not a valid URL.`,
      });
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new X402Error("config_invalid_value", {
        reason: `EXPLORER_FACILITATOR_SEEDS entry "${seed}" must be http(s).`,
      });
    }
  }

  const knownUptoContracts = csv(e.EXPLORER_KNOWN_UPTO_CONTRACTS);
  for (const contract of knownUptoContracts) {
    if (!/^C[A-Z2-7]{55}$/.test(contract)) {
      throw new X402Error("config_invalid_value", {
        reason: `EXPLORER_KNOWN_UPTO_CONTRACTS entry "${contract}" is not a C… contract address.`,
      });
    }
  }

  // Facilitator auth tokens (secrets). Each key is a base URL that gets an Authorization: Bearer
  // header on its /supported probe, and is also added to the seed set.
  const facilitatorAuth = new Map<string, string>();
  if (e.EXPLORER_FACILITATOR_AUTH && e.EXPLORER_FACILITATOR_AUTH.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(e.EXPLORER_FACILITATOR_AUTH);
    } catch {
      throw new X402Error("config_invalid_value", {
        reason: 'EXPLORER_FACILITATOR_AUTH is not valid JSON. Expected {"<baseUrl>":"<token>"}.',
      });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new X402Error("config_invalid_value", {
        reason: 'EXPLORER_FACILITATOR_AUTH must be a JSON object of base URL → bearer token.',
      });
    }
    for (const [baseUrl, token] of Object.entries(parsed)) {
      let url: URL;
      try {
        url = new URL(baseUrl);
      } catch {
        throw new X402Error("config_invalid_value", {
          reason: `EXPLORER_FACILITATOR_AUTH key "${baseUrl}" is not a valid URL.`,
        });
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new X402Error("config_invalid_value", {
          reason: `EXPLORER_FACILITATOR_AUTH key "${baseUrl}" must be http(s).`,
        });
      }
      if (typeof token !== "string" || token.trim() === "") {
        throw new X402Error("config_invalid_value", {
          reason: `EXPLORER_FACILITATOR_AUTH["${baseUrl}"] must be a non-empty bearer token.`,
        });
      }
      const normalized = baseUrl.replace(/\/+$/, "");
      facilitatorAuth.set(normalized, token);
      // An authed facilitator is also a seed, so configuring its key registers it.
      if (!facilitatorSeeds.includes(normalized)) facilitatorSeeds.push(normalized);
    }
  }

  return {
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    networks,
    ...(e.EXPLORER_DB_PATH ? { dbPath: e.EXPLORER_DB_PATH } : {}),
    pollIntervalMs: e.EXPLORER_POLL_INTERVAL_MS,
    ingestEnabled: e.EXPLORER_INGEST_ENABLED,
    facilitatorSeeds,
    facilitatorAuth,
    supportedPollIntervalMs: e.EXPLORER_SUPPORTED_POLL_INTERVAL_MS,
    knownUptoContracts,
    bazaarUrl: e.EXPLORER_BAZAAR_URL,
    corsOrigins: csv(e.CORS_ORIGINS),
  };
}

/** Loggable snapshot: no secrets exist in this config, but keep the shape audit-friendly anyway. */
export function describeConfig(config: ExplorerConfig): Record<string, unknown> {
  return {
    port: config.port,
    networks: config.networks.map(n => ({
      network: n.network,
      rpcUrl: n.rpcUrl,
      horizonUrl: n.horizonUrl,
      watchedSacs: n.watchedSacs.length === 0 ? "all" : n.watchedSacs.length,
    })),
    storage: config.dbPath ? "durable" : "memory",
    ingestEnabled: config.ingestEnabled,
    pollIntervalMs: config.pollIntervalMs,
    facilitatorSeeds: config.facilitatorSeeds,
    // Count only — never log the tokens themselves.
    facilitatorAuth: config.facilitatorAuth.size,
    knownUptoContracts: config.knownUptoContracts,
    bazaarUrl: config.bazaarUrl,
  };
}
