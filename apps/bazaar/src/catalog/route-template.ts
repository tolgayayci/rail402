/**
 * Stricter routeTemplate safety check — closes upstream x402-foundation/x402#3169.
 *
 * A client-supplied `routeTemplate` becomes part of the catalog key (`origin + routeTemplate`), so it
 * is attacker-controlled input. The SDK's `isValidRouteTemplate` percent-decodes **once** before its
 * traversal/scheme checks, so a **double**-encoded traversal (`%252e%252e` -> one decode -> `%2e%2e`,
 * which contains no `..`) slips past it. Anything that later decodes the value a second time — or any
 * consumer that treats the stored key as a path — then sees `..`.
 *
 * Our exposure is bounded: we never use the decoded template for filesystem or network access, and
 * settlement-gated ownership blocks the takeover this would otherwise enable. But a hostile template
 * still poisons the catalog key, so we decode to a fixed point and re-run the checks. A template that
 * fails here is **soft-dropped** by the caller (the listing keys on its concrete path instead) — the
 * spec's behaviour for an invalid template — never a listing rejection.
 *
 * Mirrors the approach the field's better implementations already ship (Periplo/Walras/StellarSight):
 * bounded repeated decode, then traversal / scheme / protocol-relative / control-char / backslash
 * checks against the fully-decoded form.
 */

/** Decode passes before we give up and treat the value as hostile. 8 is well past any real nesting. */
const MAX_DECODE_PASSES = 8;

/** A control character (NUL..US or DEL) enables path/log/header injection and never belongs in a template. */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/**
 * True if a **provided** routeTemplate hides a traversal/scheme/injection payload behind one or more
 * layers of percent-encoding (or is otherwise malformed). Returns false for an absent/empty template
 * — there is nothing to make unsafe — so callers can pass the raw value straight through.
 */
export function routeTemplateHasHiddenTraversal(raw: unknown): boolean {
  if (typeof raw !== "string" || raw.length === 0) return false;

  // Decode to a fixed point. Malformed encoding (`%zz`, a bare `%`) throws — treat as hostile rather
  // than guessing intent. A value still changing after the cap is pathological — also hostile.
  let cur = raw;
  let stabilized = false;
  for (let i = 0; i < MAX_DECODE_PASSES; i++) {
    let next: string;
    try {
      next = decodeURIComponent(cur);
    } catch {
      return true;
    }
    if (next === cur) {
      stabilized = true;
      break;
    }
    cur = next;
  }
  if (!stabilized) return true;

  // Reveal a backslash-based traversal (literal or once-encoded) before the `..` check.
  const normalized = cur.replace(/\\/g, "/");
  if (normalized.includes("..")) return true; // path traversal
  if (normalized.includes("://")) return true; // scheme smuggling (http://evil, javascript://…)
  if (normalized.startsWith("//")) return true; // protocol-relative -> //evil.example
  if (hasControlChar(normalized)) return true; // NUL / CR / LF / other control chars
  return false;
}

/**
 * The safety half of routeTemplate validation, to AND with the SDK's `isValidRouteTemplate`. Safe when
 * no template was provided, or when the fully-decoded template hides nothing.
 */
export function isRouteTemplateSafe(raw: unknown): boolean {
  return !routeTemplateHasHiddenTraversal(raw);
}
