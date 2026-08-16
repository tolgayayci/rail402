/**
 * Rendering. Command handlers stay pure — they return a `CmdResult`, and this module turns it into
 * either human lines or one JSON object. Keeping I/O here (not in the handlers) is what makes every
 * command unit-testable without a terminal or a network.
 */

export interface CmdError {
  code: string;
  reason: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface CmdResult {
  /** Machine payload, emitted verbatim under --json on success. */
  data?: unknown;
  /** Human-readable lines, printed when --json is off. */
  lines?: string[];
  /** Present on failure. Always carries a non-null reason. */
  error?: CmdError;
  /** Overrides the default exit code (0 on success, 1 on error). */
  exitCode?: number;
}

export function ok(data: unknown, lines: string[] = []): CmdResult {
  return { data, lines };
}

export function err(error: CmdError, exitCode = 1): CmdResult {
  return { error, exitCode };
}

/** Redact a secret for display: keep enough to recognize it, never enough to use it. */
export function redactSecret(secret?: string): string {
  if (!secret) return "(none)";
  if (secret.length <= 8) return "****";
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}

/** Render a result to the console and return the process exit code. */
export function render(result: CmdResult, json: boolean): number {
  const exitCode = result.exitCode ?? (result.error ? 1 : 0);
  if (json) {
    const payload = result.error
      ? { ok: false, error: result.error }
      : { ok: true, data: result.data ?? null };
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    return exitCode;
  }
  if (result.error) {
    process.stderr.write(`✗ ${result.error.code}: ${result.error.reason}\n`);
    if (result.error.retryable) process.stderr.write("  (retryable)\n");
    return exitCode;
  }
  for (const line of result.lines ?? []) process.stdout.write(line + "\n");
  return exitCode;
}
