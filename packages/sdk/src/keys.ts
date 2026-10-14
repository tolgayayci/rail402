import { Keypair, StrKey, hash } from "@stellar/stellar-sdk";
import { fromBase64 } from "./bytes.ts";
import { paymentError } from "./codes.ts";
import { nodeBuiltin, nodePlatform } from "./node.ts";

/** The parts of `node:fs/promises` and `node:os` key files need. */
interface FsPromises {
  stat(path: string): Promise<{ isFile(): boolean; readonly mode: number; readonly size: number }>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
}
interface Os {
  homedir(): string;
}

/**
 * The SEP-43 subset a payment needs: an address and `signAuthEntry`. Wallets, hardware signers and
 * KeyHolder all fit it. `signAuthEntry` receives the base64 `HashIdPreimage` and returns the base64
 * Ed25519 signature of its SHA-256 (or a SEP-43 `error`).
 */
export interface Sep43AuthSigner {
  readonly address: string;
  signAuthEntry(
    authEntry: string,
    opts?: { networkPassphrase?: string; address?: string },
  ): Promise<{ signedAuthEntry: string; signerAddress?: string; error?: unknown }>;
}

/** Where a secret seed comes from. A file is preferred: it never appears in a process list. */
export type KeySource = { readonly secretFile: string } | { readonly secret: string };

/** Environment variable holding a secret seed; it is removed from the environment once read. */
export const SECRET_KEY_ENV = "RAIL402_SECRET_KEY";
/** Environment variable naming a key file. */
export const SECRET_KEY_FILE_ENV = "RAIL402_SECRET_KEY_FILE";

const MAX_KEY_FILE_BYTES = 1024;
const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/**
 * Holds an Ed25519 secret seed in a private field and exposes only its address and a signing
 * function. Serializing or inspecting it shows the address alone, so a holder that ends up in a log
 * line or an error never leaks the seed.
 */
export class KeyHolder implements Sep43AuthSigner {
  readonly #keypair: Keypair;
  readonly address: string;

  private constructor(keypair: Keypair) {
    this.#keypair = keypair;
    this.address = keypair.publicKey();
  }

  /** From an S… seed. The seed is never echoed in errors. */
  static fromSecret(secret: string): KeyHolder {
    const seed = typeof secret === "string" ? secret.trim() : "";
    if (!StrKey.isValidEd25519SecretSeed(seed)) throw paymentError("key_invalid");
    return new KeyHolder(Keypair.fromSecret(seed));
  }

  /**
   * From a file holding an S… seed. On POSIX systems the file must not be readable or writable by
   * group or others (`key_file_insecure`). A leading `~/` is expanded, since MCP hosts pass paths
   * verbatim. Node only: elsewhere it is `key_not_found`.
   */
  static async fromFile(path: string): Promise<KeyHolder> {
    const fs = nodeBuiltin("node:fs/promises") as FsPromises | undefined;
    if (fs === undefined) {
      throw paymentError("key_not_found", { reason: "Key files can only be read in Node.js." });
    }
    const resolved = expandHome(path);
    let info;
    try {
      info = await fs.stat(resolved);
    } catch {
      throw paymentError("key_not_found", { reason: "No key file exists at the configured path." });
    }
    if (!info.isFile()) {
      throw paymentError("key_not_found", { reason: "The configured key path is not a regular file." });
    }
    if (nodePlatform() !== "win32" && (info.mode & 0o077) !== 0) throw paymentError("key_file_insecure");
    if (info.size > MAX_KEY_FILE_BYTES) throw paymentError("key_invalid");
    let content: string;
    try {
      content = await fs.readFile(resolved, "utf8");
    } catch {
      throw paymentError("key_not_found", { reason: "The key file could not be read." });
    }
    return KeyHolder.fromSecret(content);
  }

  /**
   * From `RAIL402_SECRET_KEY`, which is deleted from `env` once read so child processes and later
   * code never see it. Undefined when it is not set.
   */
  static fromEnv(env: Record<string, string | undefined>): KeyHolder | undefined {
    const secret = env[SECRET_KEY_ENV];
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete env[SECRET_KEY_ENV];
    if (secret === undefined || secret.trim() === "") return undefined;
    return KeyHolder.fromSecret(secret);
  }

  /** A fresh random key, for tests and `keys new`. */
  static random(): KeyHolder {
    return new KeyHolder(Keypair.random());
  }

  /** Signs a Soroban authorization preimage. An own property, so it works when passed unbound. */
  readonly signAuthEntry = (
    authEntry: string,
  ): Promise<{ signedAuthEntry: string; signerAddress: string }> => {
    try {
      const signature = this.#keypair.sign(hash(fromBase64(authEntry)));
      return Promise.resolve({ signedAuthEntry: signature.toString("base64"), signerAddress: this.address });
    } catch {
      return Promise.reject(paymentError("payment_signing_failed"));
    }
  };

  /** The seed, for writing a new key file. Only key-management code calls this. */
  exportSecret(): string {
    return this.#keypair.secret();
  }

  toJSON(): { address: string } {
    return { address: this.address };
  }

  [INSPECT](): string {
    return `KeyHolder { address: '${this.address}' }`;
  }

  toString(): string {
    return `KeyHolder(${this.address})`;
  }
}

/**
 * A key source holding a seed, as configuration keeps it: the seed is a non-enumerable property, and
 * serializing or inspecting the source shows `[redacted]`, so a configuration object that reaches a
 * log line or an error report never carries the seed.
 */
export function secretKeySource(secret: string): KeySource {
  const hidden = { value: "[redacted]" } as const;
  const source = {};
  Object.defineProperties(source, {
    secret: { value: secret, enumerable: false },
    toJSON: { value: () => ({ secret: hidden.value }), enumerable: false },
    [INSPECT]: { value: () => `{ secret: '${hidden.value}' }`, enumerable: false },
  });
  return source as KeySource;
}

/** Resolves a key source to a signer; an existing SEP-43 signer is used as is. */
export async function loadSigner(source: KeySource | Sep43AuthSigner): Promise<Sep43AuthSigner> {
  if ("signAuthEntry" in source) return source;
  if ("secretFile" in source) return KeyHolder.fromFile(source.secretFile);
  return KeyHolder.fromSecret(source.secret);
}

/** Expands a leading `~/` to the user's home directory (Node only; elsewhere paths are kept). */
export function expandHome(path: string): string {
  const home = (nodeBuiltin("node:os") as Os | undefined)?.homedir();
  return home !== undefined && (path === "~" || path.startsWith("~/")) ? home + path.slice(1) : path;
}
