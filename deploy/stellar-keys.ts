// Prints a new Stellar key pair and a cursor secret, one per line: public key (G…), secret seed (S…),
// then 32 random bytes in hex. It needs only Node 24 (which runs TypeScript directly), so the deploy scripts run without installing the
// repository's dependencies. Keys are ed25519 in Stellar's strkey encoding (SEP-23).
import { generateKeyPairSync, randomBytes } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const VERSION_ACCOUNT_ID = 6 << 3; // G…
const VERSION_SEED = 18 << 3; // S…

function crc16xmodem(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++)
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32.charAt((value << (5 - bits)) & 31);
  return out;
}

export function encodeStrKey(version: number, payload: Uint8Array): string {
  const body = Buffer.concat([Buffer.from([version]), payload]);
  const crc = crc16xmodem(body);
  return base32(Buffer.concat([body, Buffer.from([crc & 0xff, crc >> 8])]));
}

/** A new key pair: the ed25519 seed and public key, both strkey-encoded. */
export function newKeyPair(): { publicKey: string; secret: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d ?? "", "base64url");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x ?? "", "base64url");
  return { publicKey: encodeStrKey(VERSION_ACCOUNT_ID, raw), secret: encodeStrKey(VERSION_SEED, seed) };
}

if (import.meta.url === `file://${process.argv[1] ?? ""}`) {
  const { publicKey, secret } = newKeyPair();
  process.stdout.write(`${publicKey}\n${secret}\n${randomBytes(32).toString("hex")}\n`);
}
