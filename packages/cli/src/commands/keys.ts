import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, statSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { KeyHolder, expandHome, paymentError, type Sep43AuthSigner } from "@rail402.dev/sdk";
import { stringFlag } from "../args.ts";
import type { CommandHandler, CommandInput, CommandOutcome } from "../command.ts";
import type { CliContext } from "../config.ts";
import { usage } from "../codes.ts";
import { fields } from "../output.ts";

/**
 * `rail402 keys new|import|show|path`: local signing keys. A key file holds one S… seed, lives in a
 * 0700 directory, is created 0600 and exclusively (an existing file is never overwritten), and only
 * public data is ever printed. There is no flag that takes a seed: `keys import` reads it from stdin.
 */
export const keys: CommandHandler = {
  pays: false,
  run: async (input) => {
    const { subcommand } = input.parsed;
    if (subcommand === "new") return write(input, KeyHolder.random());
    if (subcommand === "import") return write(input, KeyHolder.fromSecret(await input.deps.readSecret()));
    if (subcommand === "show") return show(input);
    return path(input);
  },
};

const KEY_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** The key file a command addresses: --key-file, then --name in the keys directory, then the network default. */
export function keyFileFor(input: Pick<CommandInput, "parsed" | "context">): string {
  const explicit = stringFlag(input.parsed.flags, "key-file");
  const name = stringFlag(input.parsed.flags, "name");
  if (explicit !== undefined && name !== undefined) throw usage("Give --name or --key-file, not both.");
  if (explicit !== undefined) return resolve(expandHome(explicit));
  if (name === undefined) return input.context.defaultKeyFile;
  if (!KEY_NAME.test(name)) throw usage("A key name is 1-64 letters, digits, dots, dashes or underscores.");
  return join(input.context.keysDirectory, `${name}.key`);
}

function write(input: CommandInput, holder: KeyHolder): CommandOutcome {
  const file = keyFileFor(input);
  writeKeyFile(file, holder.exportSecret());
  const result = { address: holder.address, keyFile: file, network: input.context.network };
  return {
    result,
    human: () =>
      `${fields([
        ["address", result.address],
        ["key file", result.keyFile],
      ])}\nThe seed is only in the key file (mode 0600); back it up somewhere safe.`,
  };
}

/**
 * Creates a key file: the directory 0700 (when this creates it), the file 0600 with O_EXCL, synced
 * before it counts as written.
 */
export function writeKeyFile(file: string, secret: string): void {
  const directory = dirname(file);
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  } catch {
    throw paymentError("key_not_found", { reason: "The key directory could not be created." });
  }
  let descriptor: number;
  try {
    descriptor = openSync(file, "wx", 0o600);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw paymentError("key_exists", { details: { keyFile: file } });
    }
    throw paymentError("key_not_found", { reason: "The key file could not be created." });
  }
  try {
    writeSync(descriptor, `${secret}\n`);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  // The mode given to open is filtered by the umask; set it exactly.
  if (process.platform !== "win32") chmodSync(file, 0o600);
}

async function show(input: CommandInput): Promise<CommandOutcome> {
  const explicit =
    stringFlag(input.parsed.flags, "name") !== undefined ||
    stringFlag(input.parsed.flags, "key-file") !== undefined;
  let signer: Sep43AuthSigner;
  let keyFile: string | null;
  let source: string;
  if (explicit) {
    keyFile = keyFileFor(input);
    signer = await KeyHolder.fromFile(keyFile);
    source = "file";
  } else {
    const { agent, keySource } = input.context;
    if (agent.key === undefined) {
      throw paymentError("key_not_found", {
        reason: "No key is configured for this network; create one with rail402 keys new.",
      });
    }
    keyFile = "secretFile" in agent.key ? resolve(agent.key.secretFile) : null;
    signer =
      "secretFile" in agent.key
        ? await KeyHolder.fromFile(agent.key.secretFile)
        : KeyHolder.fromSecret(agent.key.secret);
    source = sourceLabel(keySource);
  }
  const result = { address: signer.address, keyFile, source, network: input.context.network };
  return {
    result,
    human: () =>
      fields([
        ["address", result.address],
        ["key file", result.keyFile ?? undefined],
        ["source", result.source],
      ]),
  };
}

function path(input: CommandInput): CommandOutcome {
  const keyFile = keyFileFor(input);
  let exists: boolean;
  try {
    exists = statSync(keyFile).isFile();
  } catch {
    exists = false;
  }
  return { result: { keyFile, exists }, human: () => keyFile };
}

function sourceLabel(source: CliContext["keySource"]): string {
  switch (source) {
    case "flag":
      return "--key-file";
    case "env-file":
      return "RAIL402_SECRET_KEY_FILE";
    case "env":
      return "RAIL402_SECRET_KEY";
    case "config":
      return "config file";
    case "default":
      return "default key file";
    case "none":
      return "none";
  }
}
