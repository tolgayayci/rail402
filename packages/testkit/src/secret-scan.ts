import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import { Keypair, StrKey, TransactionBuilder, hash, xdr } from "@stellar/stellar-sdk";

/**
 * Canary scanning for payment secrets. A test pays with a canary key, registers everything secret the
 * payment produced as needles (the seed, its raw bytes, every signature, preimage, signed
 * authorization entry, payment transaction and payment header), captures every channel a user or an
 * agent can see (outputs, errors, logs, events, files, what other origins received) and asserts that
 * no needle appears in any of them.
 *
 * Each needle is also searched URL-encoded and JSON-escaped, and every 24-character window of it is
 * searched too, so a truncated leak is still found. Independently of the canary, any valid secret
 * seed in a channel is a finding. Public keys and transaction hashes are never needles.
 */

/** Length of the windows searched for partial leaks. */
export const WINDOW = 24;
/** Windows with fewer distinct characters are skipped: runs like `AAAA…` occur in any XDR. */
const MIN_DISTINCT_IN_WINDOW = 10;
/** Every 56-character window that starts with S, overlapping, so a seed glued after an S is found. */
const SEED_CANDIDATE = /(?=(S[A-Z2-7]{55}))/g;

/** A SEP-43 signer, structurally: what `tap` wraps. */
export interface TappableSigner {
  readonly address: string;
  signAuthEntry(
    authEntry: string,
    opts?: { networkPassphrase?: string; address?: string },
  ): Promise<{ signedAuthEntry: string; signerAddress?: string; error?: unknown }>;
}

/** A tapped signer: `signAuthEntry` is an own function property, safe to call unbound. */
export interface TappedSigner {
  readonly address: string;
  readonly signAuthEntry: TappableSigner["signAuthEntry"];
}

export interface SecretFinding {
  readonly channel: string;
  /** The needle's label (never the needle itself). */
  readonly needle: string;
  /** How it matched: `exact`, `url-encoded`, `json-escaped`, `window`, `bytes` or `seed`. */
  readonly match: string;
}

interface Needle {
  readonly label: string;
  readonly value: string;
}

interface Channel {
  readonly name: string;
  readonly text: string;
  readonly bytes?: Buffer;
}

export class SecretScanner {
  readonly #needles: Needle[] = [];
  readonly #byteNeedles: { label: string; value: Buffer }[] = [];
  readonly #windows = new Map<string, string>();
  readonly #channels: Channel[] = [];

  /** Registers the canary seed and its raw 32 bytes (hex, base64, base64url and binary). */
  constructor(canarySeed: string) {
    if (!StrKey.isValidEd25519SecretSeed(canarySeed)) throw new Error("the canary is not a secret seed");
    this.addNeedle("canary seed", canarySeed);
    const raw = Keypair.fromSecret(canarySeed).rawSecretKey();
    this.addBytes("canary key bytes", raw);
  }

  /** Needles registered so far. */
  get needles(): number {
    return this.#needles.length + this.#byteNeedles.length;
  }

  /** Channels captured so far. */
  get channels(): readonly string[] {
    return this.#channels.map((channel) => channel.name);
  }

  /**
   * A secret string: searched verbatim, URL-encoded, JSON-escaped and, unless `windows` is false, by
   * 24-character windows. Structured text that embeds public fields (JSON) is searched whole only.
   */
  addNeedle(label: string, value: string, options: { readonly windows?: boolean } = {}): void {
    if (value.length < 16 || this.#needles.some((needle) => needle.value === value)) return;
    this.#needles.push({ label, value });
    if (options.windows === false) return;
    for (let start = 0; start + WINDOW <= value.length; start++) {
      const window = value.slice(start, start + WINDOW);
      if (new Set(window).size >= MIN_DISTINCT_IN_WINDOW && !this.#windows.has(window)) {
        this.#windows.set(window, label);
      }
    }
  }

  /** Secret bytes: searched as binary and as hex (both cases), base64 and base64url text. */
  addBytes(label: string, bytes: Uint8Array): void {
    const buffer = Buffer.from(bytes);
    this.#byteNeedles.push({ label, value: buffer });
    this.addNeedle(`${label} (hex)`, buffer.toString("hex"));
    this.addNeedle(`${label} (HEX)`, buffer.toString("hex").toUpperCase());
    this.addNeedle(`${label} (base64)`, buffer.toString("base64"));
    this.addNeedle(`${label} (base64url)`, buffer.toString("base64url"));
  }

  /**
   * Wraps a signer so every preimage it is handed and every signature it returns become needles.
   * The wrapper keeps `signAuthEntry` an own property, so it works unbound.
   */
  tap(signer: TappableSigner): TappedSigner {
    const inner = signer.signAuthEntry.bind(signer);
    return {
      address: signer.address,
      signAuthEntry: async (authEntry, opts) => {
        this.addNeedle("authorization preimage", authEntry);
        const signed = await inner(authEntry, opts);
        if (typeof signed.signedAuthEntry === "string" && signed.signedAuthEntry !== "") {
          this.addNeedle("signature", signed.signedAuthEntry);
          this.addBytes("signature", Buffer.from(signed.signedAuthEntry, "base64"));
        }
        return signed;
      },
    };
  }

  /**
   * Registers everything secret in an x402 PAYMENT-SIGNATURE header: the header, the payload JSON,
   * its transaction XDR and, per signed authorization entry, the entry XDR, its preimage and its
   * signature bytes.
   */
  addPaymentHeader(header: string, networkPassphrase: string): void {
    this.addNeedle("PAYMENT-SIGNATURE header", header);
    const payload = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Record<string, unknown>;
    this.addPayment(payload, networkPassphrase);
  }

  /**
   * Registers an x402 payment payload (as carried in MCP `_meta["x402/payment"]`): its JSON, its
   * transaction (exact) and any other signed authorization it carries (upto's `authorization`).
   */
  addPayment(payment: Record<string, unknown>, networkPassphrase: string): void {
    this.addNeedle("x402 payment JSON", JSON.stringify(payment), { windows: false });
    const inner = payment["payload"];
    if (typeof inner !== "object" || inner === null) return;
    for (const [key, value] of Object.entries(inner as Record<string, unknown>)) {
      if (key === "transaction" && typeof value === "string") {
        this.addTransaction(value, networkPassphrase);
      } else if (typeof value === "string") {
        this.addAuthorization(value, networkPassphrase);
      }
    }
  }

  /** Registers a payment transaction's XDR and its signed authorization entries. */
  addTransaction(transactionXdr: string, networkPassphrase: string): void {
    this.addNeedle("payment transaction XDR", transactionXdr);
    for (const entry of transactionEntries(transactionXdr, networkPassphrase)) {
      this.#addEntry(entry, networkPassphrase);
    }
  }

  /** Registers a signed authorization entry sent on its own (base64 XDR), with its signature. */
  addAuthorization(entryXdr: string, networkPassphrase: string): void {
    this.addNeedle("signed authorization XDR", entryXdr);
    let entry: xdr.SorobanAuthorizationEntry;
    try {
      entry = xdr.SorobanAuthorizationEntry.fromXDR(entryXdr, "base64");
    } catch {
      return;
    }
    this.#addEntry(entry, networkPassphrase);
  }

  #addEntry(entry: xdr.SorobanAuthorizationEntry, networkPassphrase: string): void {
    this.addNeedle("signed authorization entry XDR", entry.toXDR("base64"));
    const signed = signedEntry(entry, networkPassphrase);
    if (signed === undefined) return;
    this.addNeedle("signed authorization signature ScVal", signed.signature.toXDR("base64"));
    for (const signature of signatureBytes(signed.signature)) this.addBytes("signature", signature);
    this.addNeedle("authorization preimage", signed.preimage.toXDR("base64"));
  }

  /**
   * Captures one channel. Strings are taken as is, buffers as bytes, and any other value in every
   * form a program might print it: `JSON.stringify`, `util.inspect` at full depth with hidden
   * properties, and, for errors, the message, stack, every own property and the whole cause chain.
   */
  capture(channel: string, value: unknown): void {
    if (typeof value === "string") {
      this.#channels.push({ name: channel, text: value });
      return;
    }
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      const bytes = Buffer.from(value);
      this.#channels.push({ name: channel, text: bytes.toString("latin1"), bytes });
      return;
    }
    this.#channels.push({ name: channel, text: renderings(value).join("\n") });
  }

  /** Every needle found in every channel. */
  findings(): SecretFinding[] {
    const findings: SecretFinding[] = [];
    const found = (channel: string, needle: string, match: string) => {
      if (!findings.some((f) => f.channel === channel && f.needle === needle && f.match === match)) {
        findings.push({ channel, needle, match });
      }
    };
    for (const channel of this.#channels) {
      const { text } = channel;
      for (const needle of this.#needles) {
        if (text.includes(needle.value)) found(channel.name, needle.label, "exact");
        const encoded = encodeURIComponent(needle.value);
        if (encoded !== needle.value && text.includes(encoded))
          found(channel.name, needle.label, "url-encoded");
        const escaped = JSON.stringify(needle.value).slice(1, -1);
        if (escaped !== needle.value && text.includes(escaped)) {
          found(channel.name, needle.label, "json-escaped");
        }
      }
      // Windows catch truncated leaks; a channel that already leaked whole needles needs no more.
      const whole = findings.some((f) => f.channel === channel.name);
      for (let start = 0; !whole && start + WINDOW <= text.length; start++) {
        const label = this.#windows.get(text.slice(start, start + WINDOW));
        if (label !== undefined) {
          found(channel.name, label, "window");
          break;
        }
      }
      if (channel.bytes !== undefined) {
        for (const needle of this.#byteNeedles) {
          if (channel.bytes.includes(needle.value)) found(channel.name, needle.label, "bytes");
        }
      }
      for (const [, candidate] of text.matchAll(SEED_CANDIDATE)) {
        if (candidate !== undefined && StrKey.isValidEd25519SecretSeed(candidate)) {
          found(channel.name, "a secret seed", "seed");
        }
      }
    }
    return findings;
  }

  /** Throws when anything leaked, naming channels and needle labels but never the secrets. */
  assertClean(): void {
    if (this.#channels.length === 0) throw new Error("secret scan: no channel was captured");
    const findings = this.findings();
    if (findings.length === 0) return;
    const lines = findings.map((f) => `  ${f.channel}: ${f.needle} (${f.match})`);
    throw new Error(`secret scan: ${String(findings.length)} leak(s)\n${lines.join("\n")}`);
  }
}

/** The signed authorization entries of a payment transaction. */
function transactionEntries(
  transactionXdr: string,
  networkPassphrase: string,
): xdr.SorobanAuthorizationEntry[] {
  const envelope = TransactionBuilder.fromXDR(transactionXdr, networkPassphrase);
  const operations = "innerTransaction" in envelope ? [] : envelope.operations;
  return operations.flatMap((operation) =>
    operation.type === "invokeHostFunction" ? (operation.auth ?? []) : [],
  );
}

/** An address-credential entry's signature and the preimage it signs. */
function signedEntry(
  entry: xdr.SorobanAuthorizationEntry,
  networkPassphrase: string,
): { readonly signature: xdr.ScVal; readonly preimage: xdr.HashIdPreimage } | undefined {
  const credentials = entry.credentials();
  const kind = credentials.switch().name;
  if (kind !== "sorobanCredentialsAddress" && kind !== "sorobanCredentialsAddressV2") return undefined;
  const address = kind === "sorobanCredentialsAddress" ? credentials.address() : credentials.addressV2();
  const networkId = hash(Buffer.from(networkPassphrase));
  const preimage =
    kind === "sorobanCredentialsAddress"
      ? xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
          new xdr.HashIdPreimageSorobanAuthorization({
            networkId,
            nonce: address.nonce(),
            signatureExpirationLedger: address.signatureExpirationLedger(),
            invocation: entry.rootInvocation(),
          }),
        )
      : xdr.HashIdPreimage.envelopeTypeSorobanAuthorizationWithAddress(
          new xdr.HashIdPreimageSorobanAuthorizationWithAddress({
            networkId,
            nonce: address.nonce(),
            signatureExpirationLedger: address.signatureExpirationLedger(),
            invocation: entry.rootInvocation(),
            address: address.address(),
          }),
        );
  return { signature: address.signature(), preimage };
}

/**
 * What a seller that echoes its request answers on a paid route: the PAYMENT-SIGNATURE value (when
 * given) and the payment it carries, as an object, as JSON, JSON-escaped inside a string and
 * URL-encoded, with every signed authorization entry, its signature (the value, and its bytes in hex
 * and base64) and the preimage it signs. Suites serve it to prove that a buyer never hands its own payment back to its
 * caller, even when the seller does.
 */
export function paymentEcho(
  payment: Record<string, unknown>,
  networkPassphrase: string,
  header?: string,
): Record<string, unknown> {
  const inner = (payment["payload"] ?? {}) as Record<string, unknown>;
  const entries: xdr.SorobanAuthorizationEntry[] = [];
  for (const [key, value] of Object.entries(inner)) {
    if (typeof value !== "string") continue;
    try {
      entries.push(
        ...(key === "transaction"
          ? transactionEntries(value, networkPassphrase)
          : [xdr.SorobanAuthorizationEntry.fromXDR(value, "base64")]),
      );
    } catch {
      // Not XDR: echoed as it is.
    }
  }
  const signed = entries.flatMap((entry) => {
    const found = signedEntry(entry, networkPassphrase);
    return found === undefined ? [] : [found];
  });
  const json = JSON.stringify(payment);
  return {
    echo: "the request as received",
    ...(header === undefined
      ? {}
      : { header, headerInQuery: `/receipt?payment=${encodeURIComponent(header)}` }),
    payment,
    paymentJson: json,
    nested: JSON.stringify({ request: { payment: json } }),
    payload: inner,
    entries: entries.map((entry) => entry.toXDR("base64")),
    signatureValues: signed.map(({ signature }) => signature.toXDR("base64")),
    signatures: signed.flatMap(({ signature }) =>
      signatureBytes(signature).flatMap((bytes) => [bytes.toString("hex"), bytes.toString("base64")]),
    ),
    preimages: signed.map(({ preimage }) => preimage.toXDR("base64")),
  };
}

/** Every 64-byte value inside a signature ScVal (an account signature is a vector of maps). */
function signatureBytes(value: xdr.ScVal): Buffer[] {
  const kind = value.switch().name;
  if (kind === "scvBytes") {
    const bytes = value.bytes();
    return bytes.length === 64 ? [bytes] : [];
  }
  if (kind === "scvVec") return (value.vec() ?? []).flatMap(signatureBytes);
  if (kind === "scvMap") {
    return (value.map() ?? []).flatMap((entry) => [
      ...signatureBytes(entry.key()),
      ...signatureBytes(entry.val()),
    ]);
  }
  return [];
}

const MAX_CAUSES = 16;

/** The ways a program might print a value. */
function renderings(value: unknown): string[] {
  const out: string[] = [];
  try {
    out.push(
      JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? String(item) : item)),
    );
  } catch {
    // Circular or otherwise not JSON: the inspection below still covers it.
  }
  out.push(inspect(value, { depth: Infinity, showHidden: true, getters: false, maxStringLength: Infinity }));
  let current: unknown = value;
  for (let depth = 0; depth < MAX_CAUSES && current instanceof Error; depth++) {
    out.push(current.message, current.stack ?? "");
    for (const key of Reflect.ownKeys(current)) {
      const item = (current as unknown as Record<PropertyKey, unknown>)[key];
      out.push(typeof item === "string" ? item : inspect(item, { depth: Infinity, showHidden: true }));
      try {
        const json = JSON.stringify(item) as string | undefined;
        if (json !== undefined) out.push(json);
      } catch {
        // Not JSON.
      }
    }
    current = current.cause;
  }
  return out;
}

/**
 * Structural findings in published tool schemas: secret-like property names and `x-mcp-header`.
 * `allow` names properties that match the pattern without carrying a secret (a duration named after
 * authorizations, say); it is meant for output schemas, which an agent reads but never fills in.
 */
export function schemaFindings(
  schema: unknown,
  options: { readonly allow?: readonly string[] } = {},
  path = "$",
): string[] {
  const findings: string[] = [];
  if (Array.isArray(schema)) {
    schema.forEach((item, index) =>
      findings.push(...schemaFindings(item, options, `${path}[${String(index)}]`)),
    );
    return findings;
  }
  if (typeof schema !== "object" || schema === null) return findings;
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (/^x-mcp-header$/i.test(key)) findings.push(`${path}: ${key}`);
    if (key === "properties" && typeof value === "object" && value !== null) {
      for (const name of Object.keys(value)) {
        if (SECRET_LIKE.test(name) && options.allow?.includes(name) !== true) {
          findings.push(`${path}.properties.${name}`);
        }
      }
    }
    findings.push(...schemaFindings(value, options, `${path}.${key}`));
  }
  return findings;
}

/** Property names a tool schema must never have: they invite an agent to pass a secret. */
export const SECRET_LIKE = /secret|seed|private|mnemonic|passphrase|signature|token|authorization/i;

export interface DecoyRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/** A second origin that records every request it receives and answers 200 with a small JSON body. */
export interface DecoyOrigin {
  readonly url: string;
  readonly port: number;
  readonly requests: readonly DecoyRequest[];
  close(): Promise<void>;
}

export async function startDecoyOrigin(): Promise<DecoyOrigin> {
  const requests: DecoyRequest[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        method: request.method ?? "GET",
        url: request.url ?? "/",
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(200, { "content-type": "application/json" }).end('{"decoy":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
