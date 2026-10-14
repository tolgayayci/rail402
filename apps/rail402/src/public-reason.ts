/**
 * What the unauthenticated endpoints (`/health`, `/ready`) say about a failure. A raw error message can
 * carry internal host names and addresses, database user names or a simulation's full diagnostics, so
 * these endpoints show only the kind of failure; the full error goes to the service log.
 */
const KINDS: readonly (readonly [RegExp, (match: RegExpExecArray) => string])[] = [
  [/ECONNREFUSED/, () => "connection refused"],
  [/ENOTFOUND|EAI_AGAIN/, () => "host not found"],
  [/ECONNRESET|socket hang up/i, () => "connection reset"],
  [/ETIMEDOUT|timed out|timeout/i, () => "timed out"],
  [/(?:status code|HTTP) (\d{3})\b/, (match) => `HTTP ${match[1] ?? ""}`],
];

export const LOGGED = "details in the service log";

/** A short, fixed description of a failure: its kind when recognised, never its text. */
export function publicReason(failure: unknown): string {
  const text = failure instanceof Error ? `${failure.name} ${failure.message}` : String(failure);
  for (const [pattern, describe] of KINDS) {
    const match = pattern.exec(text);
    if (match !== null) return `${describe(match)} (${LOGGED})`;
  }
  return `failed (${LOGGED})`;
}
