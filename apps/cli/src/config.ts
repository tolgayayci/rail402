import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

/**
 * Configuration resolution.
 *
 * Every endpoint defaults to Rail402's own hosted testnet infrastructure, and every one is
 * overridable — so the same CLI drives your own self-hosted facilitator or explorer with one flag
 * or one env var. Precedence, highest first: command-line flag → environment variable → config file
 * (`~/.rail402/config.json`) → built-in default.
 */

export interface CliConfig {
  /** Facilitator base URL. Its Bazaar discovery endpoints live at the same origin. */
  facilitatorUrl: string;
  /** Explorer READ API base URL (data: /tx, /feed, /supported mirrors). */
  explorerUrl: string;
  /** Explorer WEB base URL, used only to print human-openable links (e.g. /tx/<hash>). */
  explorerWebUrl: string;
  /** CAIP-2 network id. */
  network: string;
  /** Stellar secret seed of the buying/paying account. Absent for read-only commands. */
  secret?: string;
}

export interface GlobalFlags {
  facilitator?: string;
  explorer?: string;
  explorerWeb?: string;
  network?: string;
  secret?: string;
}

export const DEFAULTS = {
  facilitatorUrl: "https://facilitator.rail402.dev",
  explorerUrl: "https://explorer-api.rail402.dev",
  explorerWebUrl: "https://explorer.rail402.dev",
  network: "stellar:testnet",
} as const;

const FILE_KEYS = [
  "facilitatorUrl",
  "explorerUrl",
  "explorerWebUrl",
  "network",
  "secret",
] as const;
export type ConfigKey = (typeof FILE_KEYS)[number];

const stripSlash = (u: string): string => u.replace(/\/+$/, "");

export function configFilePath(home = homedir()): string {
  return join(home, ".rail402", "config.json");
}

/** Read persisted config; a missing or unparseable file is treated as empty, never fatal. */
export function loadConfigFile(home = homedir()): Partial<CliConfig> {
  try {
    const raw = readFileSync(configFilePath(home), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Partial<CliConfig> = {};
    for (const key of FILE_KEYS) {
      const v = parsed[key];
      if (typeof v === "string" && v.length > 0) out[key] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function isConfigKey(key: string): key is ConfigKey {
  return (FILE_KEYS as readonly string[]).includes(key);
}

/** Persist a single key into the config file, preserving the rest. */
export function saveConfigValue(key: ConfigKey, value: string, home = homedir()): string {
  const path = configFilePath(home);
  const current = loadConfigFile(home);
  const next = { ...current, [key]: value };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
  return path;
}

export function resolveConfig(
  flags: GlobalFlags = {},
  env: NodeJS.ProcessEnv = process.env,
  fileValues: Partial<CliConfig> = loadConfigFile(),
): CliConfig {
  const pick = (flag: string | undefined, envVar: string | undefined, file: string | undefined, def: string) =>
    flag ?? envVar ?? file ?? def;

  const secret = flags.secret ?? env.RAIL402_SECRET ?? fileValues.secret;

  return {
    facilitatorUrl: stripSlash(
      pick(flags.facilitator, env.RAIL402_FACILITATOR_URL, fileValues.facilitatorUrl, DEFAULTS.facilitatorUrl),
    ),
    explorerUrl: stripSlash(
      pick(flags.explorer, env.RAIL402_EXPLORER_URL, fileValues.explorerUrl, DEFAULTS.explorerUrl),
    ),
    explorerWebUrl: stripSlash(
      pick(flags.explorerWeb, env.RAIL402_EXPLORER_WEB_URL, fileValues.explorerWebUrl, DEFAULTS.explorerWebUrl),
    ),
    network: pick(flags.network, env.RAIL402_NETWORK, fileValues.network, DEFAULTS.network),
    ...(secret ? { secret } : {}),
  };
}
