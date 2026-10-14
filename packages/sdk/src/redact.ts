import { StrKey } from "@stellar/stellar-sdk";

/**
 * Removes secrets from text before it leaves the SDK in an error, an event or a log line.
 *
 * Two kinds of runs are replaced with `[redacted]`:
 * - a Stellar secret seed (S…) anywhere in the text, even glued to other characters;
 * - any run of 64 or more base64 or hex characters, which covers seeds in hex or base64, signatures
 *   and signed XDR. Public G…, C… and M… addresses are kept, so reasons can still name recipients.
 */
export const REDACTED = "[redacted]";

const SEED_LENGTH = 56;
const BASE32_RUN = /[A-Z2-7]{56,}/g;
const LONG_RUN = /[A-Za-z0-9+/_-]{64,}={0,2}/g;

export function redact(text: string): string {
  return redactSeeds(text).replace(LONG_RUN, (match) => (isPublicStrkey(match) ? match : REDACTED));
}

/**
 * Replaces every valid secret seed inside each run of base32 characters, trying every position, so a
 * seed glued after other base32 characters (`KEYS…`, `SA…`) is found as well. A run of 64 or more is
 * redacted whole by the long-run rule anyway, unless it is a public muxed address.
 */
function redactSeeds(text: string): string {
  return text.replace(BASE32_RUN, (run) => {
    if (run.length >= 64) return StrKey.isValidMed25519PublicKey(run) ? run : REDACTED;
    let out = "";
    let from = 0;
    for (let start = 0; start + SEED_LENGTH <= run.length; start++) {
      if (run[start] !== "S" || !StrKey.isValidEd25519SecretSeed(run.slice(start, start + SEED_LENGTH))) {
        continue;
      }
      out += run.slice(from, start) + REDACTED;
      from = start + SEED_LENGTH;
      start = from - 1;
    }
    return out + run.slice(from);
  });
}

/** Redacts every string inside a JSON-like value. Other values are copied unchanged. */
export function redactDeep<T>(value: T): T {
  return redactValue(value, 0) as T;
}

const MAX_DEPTH = 16;

function redactValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return redact(value);
  if (depth >= MAX_DEPTH || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) setOwn(copy, key, redactValue(item, depth + 1));
  return copy;
}

/** Sets an own enumerable property, so a `__proto__` key stays data instead of replacing the prototype. */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function isPublicStrkey(value: string): boolean {
  return (
    StrKey.isValidEd25519PublicKey(value) ||
    StrKey.isValidContract(value) ||
    StrKey.isValidMed25519PublicKey(value)
  );
}

/** Characters that must not reach a terminal or an agent's context from untrusted text. */
const CONTROL =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;

/** Strips control and bidirectional-override characters and bounds the length of untrusted text. */
export function sanitizeText(text: string, maxLength: number): string {
  const clean = text.replace(CONTROL, "");
  return clean.length > maxLength ? `${clean.slice(0, maxLength)}…` : clean;
}

/**
 * Untrusted text for a reason string: secrets redacted first, then cleaned and bounded, so a
 * truncation can never cut a secret short enough to escape redaction. A seller may send any JSON value
 * where text is expected; a non-string is rendered as JSON (or its string form) first.
 */
export function untrustedReason(text: unknown, maxLength: number): string {
  return sanitizeText(redact(textOf(text, maxLength)), maxLength);
}

function textOf(value: unknown, maxLength: number): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    const json = JSON.stringify(value) as string | undefined;
    if (json !== undefined) return json.slice(0, maxLength * 4);
  } catch {
    // Not serializable (a bigint or a cycle): its string form is used.
  }
  return typeof value === "bigint" || typeof value === "number" || typeof value === "boolean"
    ? value.toString()
    : "[unreadable value]";
}

/**
 * Untrusted JSON cleaned for an agent's context: every string (and key) has control and
 * bidirectional-override characters removed and is bounded to `maxText`; keys stay own data even when
 * they are `__proto__`. Anything nested deeper than 32 levels is replaced with null.
 */
export function sanitizeJson(value: unknown, maxText: number, depth = 0): unknown {
  if (depth > 32) return null;
  if (typeof value === "string") return sanitizeText(value, maxText);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeJson(item, maxText, depth + 1));
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    setOwn(copy, sanitizeText(key, 256), sanitizeJson(item, maxText, depth + 1));
  }
  return copy;
}
