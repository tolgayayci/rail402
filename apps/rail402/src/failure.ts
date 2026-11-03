/**
 * Readable descriptions of anything code can throw. Libraries do not always throw `Error`s: a Stellar
 * RPC answering with a JSON-RPC error makes the SDK throw the plain `{ code, message }` object, and
 * other code may throw a string or nothing at all. A description is one line, bounded, and never
 * carries a URL (RPC and database URLs often embed credentials) or a Stellar secret seed.
 */

/** The longest description returned; longer ones are cut. */
const MAX_LENGTH = 300;

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const SEED_PATTERN = /\bS[A-Z2-7]{55}\b/g;

/** A secret-free, one-line description of `failure`, whatever was thrown. */
export function describeFailure(failure: unknown): string {
  return redact(rawDescription(failure, 0));
}

function rawDescription(failure: unknown, depth: number): string {
  if (failure === undefined || failure === null) return `no error value was thrown (${String(failure)})`;
  if (failure instanceof Error) {
    const message = failure.message.trim() === "" ? failure.name : failure.message;
    const cause: unknown = (failure as { cause?: unknown }).cause;
    return cause === undefined || depth > 1
      ? message
      : `${message} (cause: ${rawDescription(cause, depth + 1)})`;
  }
  if (typeof failure === "string") return failure.trim() === "" ? "an empty error message" : failure;
  if (typeof failure === "object") {
    const { code, message } = failure as { code?: unknown; message?: unknown };
    if (typeof message === "string" && message.trim() !== "") {
      return typeof code === "number" || typeof code === "string"
        ? `error ${String(code)}: ${message}`
        : message;
    }
    try {
      const json = JSON.stringify(failure);
      if (json !== "{}") return `a non-error value was thrown: ${json}`;
    } catch {
      // Circular or otherwise unserialisable: described by its kind below.
    }
    return "a non-error object was thrown";
  }
  if (typeof failure === "number" || typeof failure === "bigint" || typeof failure === "boolean") {
    return `a non-error value was thrown: ${String(failure)}`;
  }
  return `a ${typeof failure} was thrown`;
}

function redact(text: string): string {
  const line = text
    .replace(URL_PATTERN, "<url>")
    .replace(SEED_PATTERN, "<secret>")
    .replace(/\s+/g, " ")
    .trim();
  return line.length <= MAX_LENGTH ? line : `${line.slice(0, MAX_LENGTH - 1)}…`;
}

/** Why startup stopped when it was not a configuration error (those are `ConfigError`s, exit 78). */
export class StartupError extends Error {
  override readonly name = "StartupError";
  /** Always `startup_failed`; the message says what failed. */
  readonly code = "startup_failed";
}

/**
 * The line `main` prints before exiting 1 on an unexpected startup failure:
 * `rail402: startup_failed: <description>`, then the stack frames of an `Error` (code locations only,
 * never its message again).
 */
export function startupFailureLines(failure: unknown): string {
  const error = new StartupError(describeFailure(failure));
  const frames =
    failure instanceof Error && failure.stack !== undefined
      ? failure.stack.split("\n").filter((line) => /^\s+at /.test(line))
      : [];
  return [`rail402: ${error.code}: ${error.message}`, ...frames].join("\n") + "\n";
}
