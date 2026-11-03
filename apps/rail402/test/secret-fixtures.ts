import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";

const directory = mkdtempSync(join(tmpdir(), "rail402-secrets-"));
let next = 0;

/** Writes `content` to a fresh file with `mode` (owner-only read by default) and returns its absolute path. */
export function secretFile(content: string, mode = 0o400): string {
  const path = join(directory, `secret-${String(next++)}`);
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, mode);
  return path;
}

/** A sponsor key file tagged for `network`, as the key ceremony writes it. */
export function sponsorKeyFile(seed: string, network = "stellar:pubnet", mode = 0o400): string {
  return secretFile(`# rail402-key network=${network}\n${seed}\n`, mode);
}

/** A pubnet sponsor's cold signer for configurations that never reach the chain. */
export const COLD_SIGNER = Keypair.random().publicKey();
