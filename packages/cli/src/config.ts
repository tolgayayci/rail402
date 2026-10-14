import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StrKey } from "@stellar/stellar-sdk";
import { isRail402Error } from "@rail402.dev/errors";
import {
  SECRET_KEY_ENV,
  SECRET_KEY_FILE_ENV,
  TESTNET,
  expandHome,
  resolveAgentConfig,
  type AgentConfig,
  type AgentFlags,
  type StellarNetwork,
} from "@rail402.dev/sdk";
import { booleanFlag, stringFlag, type ParsedCommand } from "./args.ts";
import { cliError } from "./codes.ts";

/**
 * The CLI's configuration: command-line flags, then `RAIL402_*` environment variables, then the
 * config file (`$XDG_CONFIG_HOME/rail402/config.json`), then the network's defaults. The config
 * file holds endpoints, network and caps; it is refused if it holds anything that looks like a
 * secret key, since key material belongs in a 0600 key file.
 */

export const FRIENDBOT_URL_ENV = "RAIL402_FRIENDBOT_URL";
export const FACILITATOR_URL_ENV = "RAIL402_FACILITATOR_URL";
export const OUTPUT_ENV = "RAIL402_OUTPUT";

/** Friendbot of the public testnet. Pubnet has none. */
export const TESTNET_FRIENDBOT_URL = "https://friendbot.stellar.org";
const MAX_CONFIG_BYTES = 65_536;
const DEFAULT_TIMEOUT_MS = 120_000;

/** Config file fields and the environment variable each one stands in for. */
const FILE_FIELDS = {
  network: "RAIL402_NETWORK",
  rpcUrl: "RAIL402_RPC_URL",
  bazaarUrl: "RAIL402_BAZAAR_URL",
  facilitatorUrl: FACILITATOR_URL_ENV,
  friendbotUrl: FRIENDBOT_URL_ENV,
  maxPerCall: "RAIL402_MAX_PER_CALL",
  maxTotal: "RAIL402_MAX_TOTAL",
  assets: "RAIL402_ASSETS",
  session: "RAIL402_SESSION",
  sessionTtl: "RAIL402_SESSION_TTL",
  keyFile: SECRET_KEY_FILE_ENV,
  explorer: "RAIL402_EXPLORER",
  allowedRecipients: "RAIL402_ALLOWED_RECIPIENTS",
  deniedRecipients: "RAIL402_DENIED_RECIPIENTS",
  requireListing: "RAIL402_REQUIRE_LISTING",
  minTrust: "RAIL402_MIN_TRUST",
  schemes: "RAIL402_SCHEMES",
  uptoContracts: "RAIL402_UPTO_CONTRACTS",
  uptoFacilitators: "RAIL402_UPTO_FACILITATORS",
} as const;

type Env = Record<string, string | undefined>;

export interface CliContext {
  readonly agent: AgentConfig;
  readonly network: StellarNetwork;
  readonly json: boolean;
  readonly verbose: boolean;
  /** The facilitator whose signers attribute inspected transactions and that `seller check` asks. */
  readonly facilitatorUrl: string | undefined;
  /** Testnet only. */
  readonly friendbotUrl: string | undefined;
  readonly timeoutMs: number;
  /** Where named keys live. */
  readonly keysDirectory: string;
  /** Where the key for this network is written by default. */
  readonly defaultKeyFile: string;
  /** Where the key in use came from. */
  readonly keySource: "flag" | "env-file" | "env" | "config" | "default" | "none";
}

/** `$XDG_CONFIG_HOME/rail402`, falling back to `~/.config/rail402`. */
export function configDirectory(env: Env): string {
  const base = env["XDG_CONFIG_HOME"];
  return join(base?.startsWith("/") === true ? base : join(homedir(), ".config"), "rail402");
}

/** Whether output is JSON: `--json`, or `RAIL402_OUTPUT=json`. There is no automatic switch on TTYs. */
export function wantsJson(parsed: Pick<ParsedCommand, "flags">, env: Env): boolean {
  return booleanFlag(parsed.flags, "json") || env[OUTPUT_ENV]?.trim().toLowerCase() === "json";
}

/**
 * Resolves the configuration for a command. Removes `RAIL402_SECRET_KEY` from `env` once read, so
 * nothing later (child processes, error reports) can see it.
 */
export function resolveContext(parsed: ParsedCommand, env: Env): CliContext {
  const output = env[OUTPUT_ENV]?.trim().toLowerCase();
  if (output !== undefined && output !== "" && output !== "json" && output !== "text") {
    throw cliError("cli_config_invalid", `${OUTPUT_ENV} is "json" or "text".`);
  }
  const file = readConfigFile(stringFlag(parsed.flags, "config"), env);

  // Precedence: environment over the config file. A key given in the environment, as a file or a
  // seed, wins over a key file named in the config file.
  const merged: Env = { ...env };
  for (const [field, name] of Object.entries(FILE_FIELDS)) {
    const value = file[field];
    if (value === undefined || (merged[name] ?? "").trim() !== "") continue;
    if (name === SECRET_KEY_FILE_ENV && (merged[SECRET_KEY_ENV] ?? "").trim() !== "") continue;
    merged[name] = value;
  }
  const hadSecret = (env[SECRET_KEY_ENV] ?? "").trim() !== "";
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete env[SECRET_KEY_ENV];

  const flags: AgentFlags = {
    network: stringFlag(parsed.flags, "network"),
    rpcUrl: stringFlag(parsed.flags, "rpc-url"),
    bazaarUrl: stringFlag(parsed.flags, "bazaar-url"),
    keyFile: stringFlag(parsed.flags, "key-file"),
    session:
      parsed.command === "session" ? stringFlag(parsed.flags, "name") : stringFlag(parsed.flags, "session"),
    maxTotal: stringFlag(parsed.flags, "max-total"),
    sessionTtl: stringFlag(parsed.flags, "ttl"),
    ...(booleanFlag(parsed.flags, "allow-http") ? { allowHttp: true } : {}),
    ...(booleanFlag(parsed.flags, "allow-private-network") ? { allowPrivateNetwork: true } : {}),
  };
  let agent = resolveAgentConfig(merged, flags);
  const directory = join(configDirectory(env), "keys");
  const defaultKeyFile = join(directory, `${agent.network.replace(":", "-")}.key`);

  let keySource: CliContext["keySource"];
  if (flags.keyFile !== undefined) keySource = "flag";
  else if ((env[SECRET_KEY_FILE_ENV] ?? "").trim() !== "") keySource = "env-file";
  else if (hadSecret) keySource = "env";
  else if (file["keyFile"] !== undefined) keySource = "config";
  else if (existsSync(defaultKeyFile)) {
    keySource = "default";
    agent = { ...agent, key: { secretFile: defaultKeyFile } };
  } else keySource = "none";

  const facilitatorUrl = endpoint(
    "--facilitator-url",
    stringFlag(parsed.flags, "facilitator-url") ?? nonEmpty(merged[FACILITATOR_URL_ENV]) ?? agent.bazaarUrl,
    agent.network,
  );
  const friendbotText = nonEmpty(merged[FRIENDBOT_URL_ENV]);
  const friendbotUrl =
    agent.network === TESTNET
      ? endpoint(FRIENDBOT_URL_ENV, friendbotText ?? TESTNET_FRIENDBOT_URL, agent.network)
      : undefined;

  return {
    agent,
    network: agent.network,
    json: wantsJson(parsed, env),
    verbose: booleanFlag(parsed.flags, "verbose"),
    facilitatorUrl,
    friendbotUrl,
    timeoutMs: timeout(stringFlag(parsed.flags, "timeout")),
    keysDirectory: directory,
    defaultKeyFile,
    keySource,
  };
}

/**
 * Reads the config file. A missing default file is an empty configuration; a missing file named
 * with --config is an error.
 */
export function readConfigFile(path: string | undefined, env: Env): Record<string, string> {
  const explicit = path !== undefined;
  const resolved = explicit ? expandHome(path) : join(configDirectory(env), "config.json");
  let text: string;
  try {
    const info = statSync(resolved);
    if (!info.isFile()) throw cliError("cli_config_invalid", "The configuration path is not a file.");
    if (info.size > MAX_CONFIG_BYTES)
      throw cliError("cli_config_invalid", "The configuration file is too large.");
    text = readFileSync(resolved, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT" && !explicit) return {};
    if (isRail402Error(error)) throw error;
    throw cliError("cli_config_invalid", "The configuration file could not be read.", { path: resolved });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw cliError("cli_config_invalid", "The configuration file is not valid JSON.", { path: resolved });
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw cliError("cli_config_invalid", "The configuration file must hold a JSON object.", {
      path: resolved,
    });
  }
  const config: Record<string, string> = {};
  for (const [field, value] of Object.entries(body)) {
    if (/secret|seed|private/i.test(field) || (typeof value === "string" && containsSeed(value))) {
      throw cliError(
        "cli_config_invalid",
        "The configuration file must not hold a secret key; put it in a key file (rail402 keys import) and name it with keyFile.",
        { path: resolved, field },
      );
    }
    if (!Object.hasOwn(FILE_FIELDS, field)) {
      throw cliError(
        "cli_config_invalid",
        `Unknown configuration field "${field.slice(0, 64)}"; the fields are ${Object.keys(FILE_FIELDS).join(", ")}.`,
        { path: resolved },
      );
    }
    if (typeof value === "boolean" && field === "requireListing") {
      config[field] = String(value);
    } else if (typeof value === "string") {
      config[field] = value;
    } else {
      throw cliError("cli_config_invalid", `Configuration field "${field}" must be a string.`, {
        path: resolved,
      });
    }
  }
  return config;
}

function containsSeed(text: string): boolean {
  return (text.match(/S[A-Z2-7]{55}/g) ?? []).some((candidate) => StrKey.isValidEd25519SecretSeed(candidate));
}

function endpoint(setting: string, value: string | undefined, network: StellarNetwork): string | undefined {
  if (value === undefined) return undefined;
  if (!URL.canParse(value)) throw cliError("cli_config_invalid", `${setting} is not a valid URL.`);
  const { protocol } = new URL(value);
  if (protocol !== "https:" && (network !== TESTNET || protocol !== "http:")) {
    throw cliError("cli_config_invalid", `${setting} must use https.`);
  }
  return value.replace(/\/+$/, "");
}

/** "90", "90s" or "5m": from 1 second to 30 minutes. */
function timeout(text: string | undefined): number {
  if (text === undefined) return DEFAULT_TIMEOUT_MS;
  const match = /^([0-9]{1,4})(s|m)?$/.exec(text);
  const ms = match === null ? NaN : Number(match[1]) * (match[2] === "m" ? 60_000 : 1_000);
  if (!Number.isFinite(ms) || ms < 1_000 || ms > 1_800_000) {
    throw cliError(
      "cli_usage_invalid",
      '--timeout is a number of seconds, or minutes with "m", from 1s to 30m.',
    );
  }
  return ms;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}
