/**
 * Byte helpers that behave the same in Node and in browsers. Browser bundles replace Node's `Buffer`
 * with the npm `buffer` package, which lacks some of Node's encodings (`base64url` among them), so
 * code on the buyer's path uses these instead of Buffer-specific encodings.
 */
import { Buffer } from "buffer";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

/** The UTF-8 size of a string, as `Buffer.byteLength(text, "utf8")` counts it. */
export function utf8Length(text: string): number {
  return encoder.encode(text).byteLength;
}

/** Decodes UTF-8, replacing malformed sequences. */
export function utf8Decode(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/** One array holding every chunk in order. */
export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let size = 0;
  for (const chunk of chunks) size += chunk.byteLength;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Standard base64 with padding. */
export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/** URL-safe base64 without padding (RFC 4648 §5), as Node's `base64url` encoding writes it. */
export function toBase64Url(bytes: Uint8Array): string {
  return base64ToBase64Url(toBase64(bytes));
}

/** Rewrites standard base64 in the URL-safe alphabet and drops the padding. */
export function base64ToBase64Url(base64: string): string {
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Lower-case hexadecimal. */
export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength).toString("hex");
}

/** Decodes standard base64 into the `Buffer` stellar-sdk's XDR and hashing functions take. */
export function fromBase64(base64: string): Buffer {
  return Buffer.from(base64, "base64");
}

/** Encodes a string as UTF-8 into the `Buffer` stellar-sdk's hashing functions take. */
export function fromUtf8(text: string): Buffer {
  return Buffer.from(text, "utf8");
}
