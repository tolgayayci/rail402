/**
 * Text from the chain, the registry or a request is untrusted. Pages render it only through escaping
 * JSX; these helpers also remove characters that make one string look like another.
 */

/**
 * Control characters, zero-width characters, bidirectional overrides and isolates, Hangul fillers and
 * tag characters (U+E0000–E007F), which all render as nothing or as blank space.
 */
const INVISIBLE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u115F\u1160\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2069\u3164\uFEFF\uFFA0\u{E0000}-\u{E007F}]/gu;

/** Strips control, zero-width and bidirectional characters and bounds the length. */
export function displayText(text: string, maxLength = 200): string {
  const clean = text.replace(INVISIBLE, "");
  return clean.length > maxLength ? `${clean.slice(0, maxLength)}…` : clean;
}

/** An https URL, normalised, or undefined: nothing else is ever rendered as a link target. */
export function safeHttpsUrl(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/** A 64-character lower-case hex transaction hash. */
export const HASH = /^[0-9a-f]{64}$/;
