import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import { PUBNET, isStellarNetwork, type StellarNetwork } from "@rail402.dev/stellar";
import { ConfigError } from "./config-error.ts";

/** The largest secret file read; a seed, a database URL or a hex secret is far smaller. */
export const SECRET_FILE_MAX_BYTES = 4_096;

/**
 * The tag line a network-tagged key file starts with, e.g. `# rail402-key network=stellar:pubnet`,
 * followed by the `S…` seed on the next line. Key ceremonies write it so a seed generated for one
 * network cannot be mounted as another network's sponsor by mistake.
 */
const TAG = /^#\s*rail402-key\s+network=(\S+)\s*$/;

export interface SecretFileOptions {
  /** Refuse a file that anyone but its owner can read: mode 0400 or 0600 (the pubnet sponsor seeds). */
  readonly privateToOwner?: boolean;
  /**
   * Refuse a file that others (outside its owner and group) can read: mode 0440 at most. For secrets
   * mounted for a service's group, such as database URLs.
   */
  readonly notWorldReadable?: boolean;
}

/**
 * Reads one secret from the file `path` names, for the variable `variable` (e.g.
 * `PUBNET_SPONSOR_SECRET_FILE`). The file must be a regular file of at most 4 KiB that neither its
 * group nor others can write; with `privateToOwner`, neither may read it either, and with
 * `notWorldReadable` others may not read it. The value is the
 * file's trimmed content. Errors name the variable and the path, never the content.
 */
export function readSecretFile(variable: string, path: string, options: SecretFileOptions = {}): string {
  if (!isAbsolute(path)) {
    throw new ConfigError(`${variable} must be an absolute path`, "config_secret_file_unreadable");
  }
  let descriptor: number;
  try {
    descriptor = openSync(path, "r");
  } catch {
    throw new ConfigError(`${variable}: ${path} cannot be read`, "config_secret_file_unreadable");
  }
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new ConfigError(`${variable}: ${path} is not a regular file`, "config_secret_file_unreadable");
    }
    if (stat.size > SECRET_FILE_MAX_BYTES) {
      throw new ConfigError(
        `${variable}: ${path} is larger than ${String(SECRET_FILE_MAX_BYTES)} bytes`,
        "config_secret_file_unreadable",
      );
    }
    if ((stat.mode & 0o022) !== 0) {
      throw new ConfigError(
        `${variable}: ${path} is writable by its group or by others; make it writable by its owner only (chmod 0400 or 0600)`,
        "config_secret_file_insecure",
      );
    }
    if (options.privateToOwner === true && (stat.mode & 0o044) !== 0) {
      throw new ConfigError(
        `${variable}: ${path} is readable by its group or by others; make it readable by its owner only (chmod 0400 or 0600)`,
        "config_secret_file_insecure",
      );
    }
    if (options.notWorldReadable === true && (stat.mode & 0o004) !== 0) {
      throw new ConfigError(
        `${variable}: ${path} is readable by others; make it readable by its owner and group only (chmod 0440 or 0400)`,
        "config_secret_file_insecure",
      );
    }
    const buffer = Buffer.alloc(SECRET_FILE_MAX_BYTES + 1);
    const length = readSync(descriptor, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, length).toString("utf8").trim();
    if (text === "") throw new ConfigError(`${variable}: ${path} is empty`, "config_secret_file_unreadable");
    return text;
  } finally {
    closeSync(descriptor);
  }
}

/**
 * The seed in a sponsor key file's content, checked against the network it is configured for. A
 * tagged file must be tagged for that network; on pubnet the tag is required, so a seed handled
 * with testnet care cannot become the mainnet sponsor without someone writing the tag on purpose.
 */
export function sponsorSeedFrom(variable: string, content: string, network: StellarNetwork): string {
  const lines = content.split(/\r?\n/).map((line) => line.trim());
  const match = TAG.exec(lines[0] ?? "");
  if (match === null) {
    if (network === PUBNET) {
      throw new ConfigError(
        `${variable}: the pubnet sponsor key file must start with "# rail402-key network=${PUBNET}"`,
        "config_secret_file_untagged",
      );
    }
    return content;
  }
  const tagged = match[1] ?? "";
  if (!isStellarNetwork(tagged) || tagged !== network) {
    throw new ConfigError(
      `${variable}: the key file is tagged for ${tagged}, not ${network}`,
      "config_secret_network_mismatch",
    );
  }
  return lines
    .slice(1)
    .filter((line) => line !== "")
    .join("\n");
}

/** A secret variable that may come from the environment or from a file (`<name>_FILE`). */
export interface SecretSource {
  /** The variable holding the value directly, e.g. `DATABASE_URL`. */
  readonly name: string;
  /** Refuse the environment form: the value must come from `<name>_FILE`. */
  readonly fileOnly: boolean;
  readonly options?: SecretFileOptions;
  /** Turns the file's content into the value, e.g. checks a key file's network tag. */
  readonly fromFile?: (content: string) => string;
}

/**
 * The value of a secret variable: from `<name>_FILE` when set, else from `<name>`. Both set is a
 * conflict; the environment form is refused where only a file is allowed (`fileOnly`).
 */
export function resolveSecret(
  env: Readonly<Record<string, string | undefined>>,
  source: SecretSource,
): string | undefined {
  const fileVariable = `${source.name}_FILE`;
  const direct = present(env[source.name]);
  const file = present(env[fileVariable]);
  if (direct !== undefined && file !== undefined) {
    throw new ConfigError(`set ${source.name} or ${fileVariable}, not both`, "config_secret_conflict");
  }
  if (direct !== undefined && source.fileOnly) {
    throw new ConfigError(
      `${source.name} must not be set in the environment when pubnet is enabled; put it in a file and set ${fileVariable}`,
      "config_secret_in_env",
    );
  }
  if (file === undefined) return direct;
  const content = readSecretFile(fileVariable, file, source.options);
  return source.fromFile === undefined ? content : source.fromFile(content);
}

function present(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}
