import { randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import {
  encodeStrKey,
  keyFile,
  newKeyPair,
  publicKeyOf,
  seedOfKeyFile,
} from "../../../deploy/stellar-keys.ts";

const SCRIPT = new URL("../../../deploy/stellar-keys.ts", import.meta.url).pathname;
/**
 * The tag line the service requires at the top of a pubnet sponsor key file (<NET>_SPONSOR_SECRET_FILE),
 * as its key-file parser matches it; a seed on the following line.
 */
const SERVICE_TAG = /^#\s*rail402-key\s+network=(\S+)\s*$/;

describe("deploy key generator", () => {
  it("encodes strkeys exactly as the Stellar SDK does", () => {
    for (let i = 0; i < 50; i++) {
      const raw = randomBytes(32);
      expect(encodeStrKey(6 << 3, raw)).toBe(StrKey.encodeEd25519PublicKey(raw));
      expect(encodeStrKey(18 << 3, raw)).toBe(StrKey.encodeEd25519SecretSeed(raw));
    }
  });

  it("makes key pairs whose secret derives their public key", () => {
    for (let i = 0; i < 20; i++) {
      const { publicKey, secret } = newKeyPair();
      expect(Keypair.fromSecret(secret).publicKey()).toBe(publicKey);
    }
  });

  it("prints a public key, a secret and a 32-byte hex cursor secret when run", () => {
    const [publicKey, secret, cursor] = execFileSync(
      "node",
      [new URL("../../../deploy/stellar-keys.ts", import.meta.url).pathname],
      {
        encoding: "utf8",
      },
    )
      .trim()
      .split("\n");
    expect(Keypair.fromSecret(secret ?? "").publicKey()).toBe(publicKey);
    expect(cursor).toMatch(/^[0-9a-f]{64}$/);
  });

  it("writes network-tagged key files in the format the service reads, with the public key apart", () => {
    const run = spawnSync("node", [SCRIPT, "--key-file", "stellar:pubnet"], { encoding: "utf8" });
    expect(run.status).toBe(0);
    const [tag, seed, ...rest] = run.stdout.split("\n");
    expect(SERVICE_TAG.exec(tag ?? "")?.[1]).toBe("stellar:pubnet");
    expect(rest).toEqual([""]);
    const publicKey = /^public key: (G[A-Z2-7]{55})$/m.exec(run.stderr)?.[1];
    expect(Keypair.fromSecret(seed ?? "").publicKey()).toBe(publicKey);
    expect(run.stdout).toBe(keyFile("stellar:pubnet", seed ?? ""));
    expect(spawnSync("node", [SCRIPT, "--key-file", "pubnet"], { encoding: "utf8" }).status).toBe(1);
  });

  it("writes a key file once, readable only by its owner, and reads its public key back", () => {
    const directory = mkdtempSync(join(tmpdir(), "rail402-keys-"));
    try {
      const out = join(directory, "pubnet-sponsor.key");
      const publicKey = execFileSync("node", [SCRIPT, "--key-file", "stellar:pubnet", "--out", out], {
        encoding: "utf8",
      }).trim();
      expect(statSync(out).mode & 0o777).toBe(0o400);
      const { network, secret } = seedOfKeyFile(readFileSync(out, "utf8"));
      expect(network).toBe("stellar:pubnet");
      expect(Keypair.fromSecret(secret).publicKey()).toBe(publicKey);
      expect(execFileSync("node", [SCRIPT, "--public-of", out], { encoding: "utf8" }).trim()).toBe(publicKey);
      // Never replaces an existing key file.
      expect(spawnSync("node", [SCRIPT, "--key-file", "stellar:pubnet", "--out", out]).status).toBe(1);
      expect(seedOfKeyFile(readFileSync(out, "utf8")).secret).toBe(secret);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("derives public keys as the Stellar SDK does and refuses malformed key files", () => {
    for (let i = 0; i < 20; i++) {
      const keypair = Keypair.random();
      expect(publicKeyOf(keypair.secret())).toBe(keypair.publicKey());
    }
    const { secret } = newKeyPair();
    expect(seedOfKeyFile(`${secret}\n`)).toEqual({ network: undefined, secret });
    expect(() => seedOfKeyFile("# rail402-key network=stellar:pubnet\n")).toThrow();
    expect(() => seedOfKeyFile(`${secret}\n${secret}\n`)).toThrow();
    expect(() => publicKeyOf(`${secret.slice(0, -1)}${secret.endsWith("A") ? "B" : "A"}`)).toThrow();
  });
});
