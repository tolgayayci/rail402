import { hash, xdr } from "@stellar/stellar-sdk";
import type { PaymentPayload } from "@x402/core/types";
import { networkPassphrase, type StellarNetwork } from "@rail402.dev/stellar";
import { base64ToBase64Url, fromUtf8, toBase64, toBase64Url, toHex } from "../bytes.ts";
import { REDACTED } from "../redact.ts";
import type { HttpOutcome, McpOutcome } from "./types.ts";

/**
 * Removes a call's own payment from the seller's answer. A seller that echoes the request it received
 * (a debugging endpoint, a tool that returns its input) would otherwise hand the signed payment back
 * into the call's result, where an agent, a terminal or the budget ledger keeps it. Only this call's
 * material is removed, so the rest of the seller's content is returned as sent.
 *
 * The material is the PAYMENT-SIGNATURE value, the payment JSON, every string of its scheme payload
 * (the transaction or authorization XDR) and, for each signed authorization entry inside them, the
 * entry's XDR, its signature values (a delegate's too), the signature bytes and the preimage that was
 * signed. Each is matched verbatim, JSON-escaped, URL-encoded and in base64url form, and a truncated
 * copy at the end of a text is removed too.
 */
export interface PaymentMaterial {
  /** Every form searched, longest first. */
  readonly needles: readonly string[];
}

/** Values shorter than this are never material: they could match ordinary content. */
const MIN_NEEDLE = 16;
/** The shortest truncated copy removed at the end of a text. */
const MIN_TAIL = 16;
const MAX_DEPTH = 64;

/** The material of one payment, as sent in `header` (HTTP) or in `_meta` (MCP, no header). */
export function paymentMaterial(
  payload: PaymentPayload,
  network: StellarNetwork,
  header?: string,
): PaymentMaterial {
  const values = new Set<string>();
  const add = (value: string) => {
    if (value.length >= MIN_NEEDLE) values.add(value);
  };
  const addBytes = (bytes: Uint8Array) => {
    add(toHex(bytes));
    add(toHex(bytes).toUpperCase());
    add(toBase64(bytes));
    add(toBase64Url(bytes));
  };
  if (header !== undefined) add(header);
  add(JSON.stringify(payload));
  add(toBase64(fromUtf8(JSON.stringify(payload))));
  add(JSON.stringify(payload.payload));
  const passphrase = networkPassphrase(network);
  for (const leaf of stringLeaves(payload.payload, 0)) {
    add(leaf);
    for (const entry of authorizationEntries(leaf)) {
      add(entry.toXDR("base64"));
      for (const signature of signaturesOf(entry)) {
        add(signature.toXDR("base64"));
        for (const bytes of signatureBytes(signature, 0)) addBytes(bytes);
      }
      const signed = preimageOf(entry, passphrase);
      if (signed !== undefined) add(signed.toXDR("base64"));
    }
  }
  const needles = new Set<string>();
  for (const value of values) {
    for (const form of forms(value)) if (form.length >= MIN_NEEDLE) needles.add(form);
  }
  return { needles: [...needles].sort((a, b) => b.length - a.length) };
}

/** The seller's answer with this call's payment material replaced by `[redacted]`. */
export function scrubOutcome<T extends HttpOutcome | McpOutcome>(outcome: T, material: PaymentMaterial): T {
  if (material.needles.length === 0) return outcome;
  if (outcome.kind === "http") {
    return {
      ...outcome,
      ...(outcome.text === undefined ? {} : { text: scrubText(outcome.text, material) }),
      ...(outcome.json === undefined ? {} : { json: scrubJson(outcome.json, material, 0) }),
    };
  }
  return {
    ...outcome,
    content: outcome.content.map((item) => ({ ...item, text: scrubText(item.text, material) })),
    ...(outcome.structuredContent === undefined
      ? {}
      : { structuredContent: scrubJson(outcome.structuredContent, material, 0) }),
  };
}

/** Text with every form of the material replaced, and a truncated copy at its end removed. */
export function scrubText(text: string, material: PaymentMaterial): string {
  if (text.length < MIN_TAIL) return text;
  let out = text;
  for (const needle of material.needles) {
    if (out.includes(needle)) out = out.split(needle).join(REDACTED);
  }
  return scrubTail(out, material);
}

function scrubJson(value: unknown, material: PaymentMaterial, depth: number): unknown {
  if (typeof value === "string") return scrubText(value, material);
  if (depth >= MAX_DEPTH || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => scrubJson(item, material, depth + 1));
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(copy, scrubText(key, material), {
      value: scrubJson(item, material, depth + 1),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy;
}

/**
 * Removes a copy of the material cut short at the end of a text (content beyond the inline limit is
 * left out, so an echo can be cut anywhere), before a trailing ellipsis if there is one.
 */
function scrubTail(text: string, material: PaymentMaterial): string {
  const ellipsis = text.endsWith("…") ? "…" : "";
  const body = ellipsis === "" ? text : text.slice(0, -1);
  for (const needle of material.needles) {
    const head = needle.slice(0, MIN_TAIL);
    const floor = body.length - needle.length;
    for (let at = body.lastIndexOf(head); at >= 0 && at > floor; at = body.lastIndexOf(head, at - 1)) {
      if (needle.startsWith(body.slice(at))) return `${body.slice(0, at)}${REDACTED}${ellipsis}`;
      if (at === 0) break;
    }
  }
  return text;
}

/** The forms a value takes when a seller quotes it: verbatim, JSON-escaped, URL-encoded, base64url. */
function forms(value: string): string[] {
  const escaped = JSON.stringify(value).slice(1, -1);
  const encoded = encodeURIComponent(value);
  const out = [
    value,
    escaped,
    JSON.stringify(escaped).slice(1, -1),
    encoded,
    encoded.replace(/%[0-9A-F]{2}/g, (match) => match.toLowerCase()),
    encodeURIComponent(escaped),
  ];
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    out.push(base64ToBase64Url(value));
  }
  return out;
}

function stringLeaves(value: unknown, depth: number): string[] {
  if (typeof value === "string") return [value];
  if (depth >= 8 || value === null || typeof value !== "object") return [];
  return Object.values(value).flatMap((item) => stringLeaves(item, depth + 1));
}

/** The authorization entries a payload string carries: a transaction's, or an entry itself. */
function authorizationEntries(value: string): xdr.SorobanAuthorizationEntry[] {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return [];
  try {
    const envelope = xdr.TransactionEnvelope.fromXDR(value, "base64");
    const kind = envelope.switch().name;
    const transaction =
      kind === "envelopeTypeTx"
        ? envelope.v1().tx()
        : kind === "envelopeTypeTxFeeBump"
          ? envelope.feeBump().tx().innerTx().v1().tx()
          : undefined;
    if (transaction === undefined) return [];
    return transaction.operations().flatMap((operation) => {
      const body = operation.body();
      return body.switch().name === "invokeHostFunction" ? body.invokeHostFunctionOp().auth() : [];
    });
  } catch {
    // Not a transaction: perhaps an authorization entry.
  }
  try {
    return [xdr.SorobanAuthorizationEntry.fromXDR(value, "base64")];
  } catch {
    return [];
  }
}

/** The signature values of an entry: its address credentials' and any delegate's. */
function signaturesOf(entry: xdr.SorobanAuthorizationEntry): xdr.ScVal[] {
  const credentials = entry.credentials();
  const kind = credentials.switch().name;
  if (kind === "sorobanCredentialsAddress") return [credentials.address().signature()];
  if (kind === "sorobanCredentialsAddressV2") return [credentials.addressV2().signature()];
  if (kind === "sorobanCredentialsAddressWithDelegates") {
    const withDelegates = credentials.addressWithDelegates();
    return [
      withDelegates.addressCredentials().signature(),
      ...delegateSignatures(withDelegates.delegates(), 0),
    ];
  }
  return [];
}

function delegateSignatures(delegates: readonly xdr.SorobanDelegateSignature[], depth: number): xdr.ScVal[] {
  if (depth > 8) return [];
  return delegates.flatMap((delegate) => [
    delegate.signature(),
    ...delegateSignatures(delegate.nestedDelegates(), depth + 1),
  ]);
}

/** The preimage an address-credential entry's signature signs (the kinds a buyer's key signs). */
function preimageOf(
  entry: xdr.SorobanAuthorizationEntry,
  passphrase: string,
): xdr.HashIdPreimage | undefined {
  const credentials = entry.credentials();
  const kind = credentials.switch().name;
  const networkId = hash(fromUtf8(passphrase));
  if (kind === "sorobanCredentialsAddress") {
    const address = credentials.address();
    return xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId,
        nonce: address.nonce(),
        signatureExpirationLedger: address.signatureExpirationLedger(),
        invocation: entry.rootInvocation(),
      }),
    );
  }
  if (kind === "sorobanCredentialsAddressV2") {
    const address = credentials.addressV2();
    return xdr.HashIdPreimage.envelopeTypeSorobanAuthorizationWithAddress(
      new xdr.HashIdPreimageSorobanAuthorizationWithAddress({
        networkId,
        nonce: address.nonce(),
        signatureExpirationLedger: address.signatureExpirationLedger(),
        invocation: entry.rootInvocation(),
        address: address.address(),
      }),
    );
  }
  return undefined;
}

/** Every byte string of 64 bytes or more inside a signature value (an account signature is a vector of maps). */
function signatureBytes(value: xdr.ScVal, depth: number): Uint8Array[] {
  if (depth > 8) return [];
  const kind = value.switch().name;
  if (kind === "scvBytes") {
    const bytes = value.bytes();
    return bytes.length >= 64 ? [bytes] : [];
  }
  if (kind === "scvVec") return (value.vec() ?? []).flatMap((item) => signatureBytes(item, depth + 1));
  if (kind === "scvMap") {
    return (value.map() ?? []).flatMap((entry) => [
      ...signatureBytes(entry.key(), depth + 1),
      ...signatureBytes(entry.val(), depth + 1),
    ]);
  }
  return [];
}
