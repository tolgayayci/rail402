import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { encodeStrKey, newKeyPair } from "../../../deploy/stellar-keys.ts";

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
});
