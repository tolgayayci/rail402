// Stellar keys for the deploy scripts and the key ceremony. It needs only Node 24 (which runs TypeScript
// directly), so it runs without the repository's dependencies, in a container without network or on an
// offline machine. Keys are ed25519 in Stellar's strkey encoding (SEP-23).
//
//   node stellar-keys.ts
//       a new key pair and a cursor secret, one per line: public key (G…), seed (S…), 32 random bytes in hex
//   node stellar-keys.ts --key-file <network> [--out <file>]
//       a new sponsor key file for <network> (stellar:testnet or stellar:pubnet): the tag line
//       "# rail402-key network=<network>" and the seed on the next line, the format the service reads
//       for <NET>_SPONSOR_SECRET_FILE (required on pubnet). With --out it is written to a new file of
//       mode 0400 and the public key is printed; without, the file goes to stdout and the public key to
//       stderr as "public key: G…".
//   node stellar-keys.ts --public-of <file>
//       the public key of a key file, tagged or not
//   node stellar-keys.ts --sign-xdr <file> --with <key file> --network <network>
//       sign an unsigned transaction envelope (base64 XDR, as `deploy/keys/cli.ts … --unsigned` prints it)
//       offline: prints its source account, its hash (compare both with the online review) and the
//       signed envelope. The key file's network tag, when present, must match --network.
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  createPublicKey,
  sign,
} from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

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

export const KEY_NETWORKS = ["stellar:testnet", "stellar:pubnet"] as const;
export type KeyNetwork = (typeof KEY_NETWORKS)[number];

/** A network-tagged sponsor key file: the tag line, then the seed. */
export function keyFile(network: KeyNetwork, secret: string): string {
  return `# rail402-key network=${network}\n${secret}\n`;
}

const TAG = /^#\s*rail402-key\s+network=(\S+)\s*$/;

function decodeStrKey(value: string, version: number): Buffer {
  const bits: number[] = [];
  for (const char of value) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error("not a strkey");
    for (let bit = 4; bit >= 0; bit--) bits.push((index >> bit) & 1);
  }
  const bytes = Buffer.alloc(Math.floor(bits.length / 8));
  for (let i = 0; i < bytes.length; i++) {
    let byte = 0;
    for (let bit = 0; bit < 8; bit++) byte = (byte << 1) | (bits[i * 8 + bit] ?? 0);
    bytes[i] = byte;
  }
  const body = bytes.subarray(0, bytes.length - 2);
  const crc = crc16xmodem(body);
  if (bytes.length !== 35 || body[0] !== version || bytes[33] !== (crc & 0xff) || bytes[34] !== crc >> 8) {
    throw new Error("not a valid strkey");
  }
  return body.subarray(1);
}

/** The public key of a seed (S…). */
export function publicKeyOf(secret: string): string {
  const seed = decodeStrKey(secret, VERSION_SEED);
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const jwk = createPublicKey(createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })).export({
    format: "jwk",
  });
  return encodeStrKey(VERSION_ACCOUNT_ID, Buffer.from(jwk.x ?? "", "base64url"));
}

/** The seed of a key file's content: a tagged file (tag line, then the seed) or a bare seed. */
export function seedOfKeyFile(content: string): { network: string | undefined; secret: string } {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const tag = TAG.exec(lines[0] ?? "");
  const rest = tag === null ? lines : lines.slice(1);
  if (rest.length !== 1 || !/^S[A-Z2-7]{55}$/.test(rest[0] ?? ""))
    throw new Error("the key file holds no single seed");
  return { network: tag?.[1], secret: rest[0] ?? "" };
}

/** Stellar's network passphrases, by CAIP-2 name. */
export const NETWORK_PASSPHRASES: Readonly<Record<KeyNetwork, string>> = {
  "stellar:testnet": "Test SDF Network ; September 2015",
  "stellar:pubnet": "Public Global Stellar Network ; September 2015",
};

const ENVELOPE_TYPE_TX = 2;

/**
 * Signs an unsigned v1 transaction envelope (ENVELOPE_TYPE_TX with no signatures) with a seed, without
 * any XDR library: the transaction is the envelope between its type and its empty signature list, the
 * signed payload is SHA-256(SHA-256(passphrase) ‖ ENVELOPE_TYPE_TX ‖ transaction), and the result is the
 * same envelope with one decorated signature (the key's last 4 bytes as hint).
 */
export function signEnvelope(
  envelopeBase64: string,
  network: KeyNetwork,
  secret: string,
): { readonly source: string; readonly hash: string; readonly signed: string } {
  const envelope = Buffer.from(envelopeBase64.trim(), "base64");
  if (envelope.length < 4 + 36 + 4 || envelope.toString("base64") !== envelopeBase64.trim()) {
    throw new Error("the envelope is not base64 XDR");
  }
  if (envelope.readUInt32BE(0) !== ENVELOPE_TYPE_TX) {
    throw new Error("only an unsigned transaction envelope (not a fee bump or a v0 envelope) is signed here");
  }
  if (envelope.readUInt32BE(envelope.length - 4) !== 0) throw new Error("the envelope is already signed");
  // The source account: a muxed account whose arm is a plain ed25519 key (KEY_TYPE_ED25519 = 0).
  if (envelope.readUInt32BE(4) !== 0) throw new Error("the transaction's source is not a plain G… account");
  const source = encodeStrKey(VERSION_ACCOUNT_ID, envelope.subarray(8, 40));
  const transaction = envelope.subarray(4, envelope.length - 4);
  const networkId = createHash("sha256").update(NETWORK_PASSPHRASES[network]).digest();
  const type = Buffer.alloc(4);
  type.writeUInt32BE(ENVELOPE_TYPE_TX);
  const hash = createHash("sha256")
    .update(Buffer.concat([networkId, type, transaction]))
    .digest();
  const seed = decodeStrKey(secret, VERSION_SEED);
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
    format: "der",
    type: "pkcs8",
  });
  const publicRaw = Buffer.from(createPublicKey(privateKey).export({ format: "jwk" }).x ?? "", "base64url");
  const signature = sign(null, hash, privateKey);
  const count = Buffer.alloc(4);
  count.writeUInt32BE(1);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(signature.length);
  const signed = Buffer.concat([
    envelope.subarray(0, envelope.length - 4),
    count,
    publicRaw.subarray(28, 32),
    length,
    signature,
  ]);
  return { source, hash: hash.toString("hex"), signed: signed.toString("base64") };
}

function main(args: readonly string[]): void {
  const at = (flag: string) => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };
  const network = at("--key-file");
  const publicOf = at("--public-of");
  const signXdr = at("--sign-xdr");
  if (signXdr !== undefined) {
    const target = at("--network");
    const keyPath = at("--with");
    if (target === undefined || !(KEY_NETWORKS as readonly string[]).includes(target)) {
      throw new Error(`--sign-xdr needs --network ${KEY_NETWORKS.join(" or ")}`);
    }
    if (keyPath === undefined) throw new Error("--sign-xdr needs --with <key file>");
    const key = seedOfKeyFile(readFileSync(keyPath, "utf8"));
    if (key.network !== undefined && key.network !== target) {
      throw new Error(`the key file is tagged for ${key.network}, not ${target}`);
    }
    const result = signEnvelope(readFileSync(signXdr, "utf8"), target as KeyNetwork, key.secret);
    process.stdout.write(
      `source ${result.source}\nsigner ${publicKeyOf(key.secret)}\ntx hash ${result.hash}\nxdr ${result.signed}\n`,
    );
    return;
  }
  if (publicOf !== undefined) {
    process.stdout.write(`${publicKeyOf(seedOfKeyFile(readFileSync(publicOf, "utf8")).secret)}\n`);
    return;
  }
  if (network !== undefined) {
    if (!(KEY_NETWORKS as readonly string[]).includes(network)) {
      throw new Error(`--key-file takes ${KEY_NETWORKS.join(" or ")}`);
    }
    const { publicKey, secret } = newKeyPair();
    const content = keyFile(network as KeyNetwork, secret);
    const out = at("--out");
    if (out === undefined) {
      process.stdout.write(content);
      process.stderr.write(`public key: ${publicKey}\n`);
    } else {
      writeFileSync(out, content, { mode: 0o400, flag: "wx" });
      process.stdout.write(`${publicKey}\n`);
    }
    return;
  }
  if (args.length > 0)
    throw new Error(
      "usage: stellar-keys.ts [--key-file <network> [--out <file>] | --public-of <file> | --sign-xdr <file> --with <key file> --network <network>]",
    );
  const { publicKey, secret } = newKeyPair();
  process.stdout.write(`${publicKey}\n${secret}\n${randomBytes(32).toString("hex")}\n`);
}

if (import.meta.url === `file://${process.argv[1] ?? ""}`) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`stellar-keys: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
