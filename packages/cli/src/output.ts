import { isRail402Error } from "@rail402.dev/errors";
import { isPaymentError, redact, redactDeep, sanitizeText, type Paid } from "@rail402.dev/sdk";
import { EXIT, defaultPaidOf, exitStatusFor, isCliErrorCode, type ExitStatus } from "./codes.ts";

/**
 * The output contract. With --json, stdout carries exactly one JSON document:
 *
 *   {"v":1,"ok":true,"command":"pay","network":"stellar:testnet","result":{…}}
 *   {"v":1,"ok":false,"command":"pay","error":{"code":…,"reason":…,"retryable":…,"paid":…,"details":…}}
 *
 * Progress and logs go to stderr only. Human output shows the same data as text: results on stdout,
 * errors on stderr.
 */

export const OUTPUT_VERSION = 1;

export interface CliFailure {
  readonly code: string;
  readonly reason: string;
  readonly retryable: boolean;
  readonly paid: Paid;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

/** Characters JSON leaves raw that a terminal may act on: C1 controls and bidirectional overrides. */
const UNSAFE_IN_JSON = /[\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g;

/**
 * JSON with bigints as decimal strings. C0 controls are escaped by JSON itself; C1 controls and
 * bidirectional overrides are escaped here too, so seller text printed to a terminal is inert and the
 * document still parses to the same value.
 */
export function toJson(value: unknown, indent?: number): string {
  return JSON.stringify(
    value,
    (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item),
    indent,
  ).replace(UNSAFE_IN_JSON, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function successDocument(command: string, network: string | undefined, result: unknown): string {
  return toJson({
    v: OUTPUT_VERSION,
    ok: true,
    command,
    ...(network === undefined ? {} : { network }),
    result,
  });
}

export function failureDocument(command: string, failure: CliFailure): string {
  return toJson({ v: OUTPUT_VERSION, ok: false, command, error: failure });
}

/**
 * Anything a command threw, as a coded failure. SDK errors keep their code, reason and `paid`; their
 * details were redacted by the SDK, and a receipt's transaction hash must stay readable. Other coded
 * errors are redacted here. An abort is a timeout; anything else is an internal error, which during
 * a payment means the outcome is unknown.
 */
export function failureFrom(error: unknown, duringPayment: boolean): CliFailure {
  if (isPaymentError(error)) {
    const details: Record<string, unknown> = { ...error.details };
    if (error.callId !== undefined) details["callId"] = error.callId;
    if (error.receipt !== undefined) details["receipt"] = error.receipt;
    return {
      code: error.code,
      reason: error.reason,
      retryable: error.retryable,
      paid: error.paid,
      ...(Object.keys(details).length === 0 ? {} : { details }),
    };
  }
  if (isRail402Error(error)) {
    const stage = (error as { stage?: unknown }).stage;
    const details = {
      ...(error.details === undefined ? {} : redactDeep({ ...error.details })),
      ...(typeof stage === "string" ? { stage } : {}),
    };
    return {
      code: error.code,
      reason: redact(error.reason),
      retryable: error.retryable,
      paid: isCliErrorCode(error.code) ? defaultPaidOf(error.code) : "none",
      ...(Object.keys(details).length === 0 ? {} : { details }),
    };
  }
  const paid: Paid = duringPayment ? "unknown" : "none";
  if (isAbort(error)) {
    return {
      code: "cli_timeout",
      reason: duringPayment
        ? "The command timed out during a payment; check the budget (rail402 session show) before retrying."
        : "The command did not finish within its time limit (--timeout).",
      retryable: !duringPayment,
      paid,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const reason = sanitizeText(redact(message), 300).trim();
  return {
    code: "cli_internal_error",
    reason: reason === "" ? "rail402 failed unexpectedly." : `rail402 failed unexpectedly: ${reason}`,
    retryable: false,
    paid,
  };
}

export function isAbort(error: unknown): boolean {
  return (
    (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) ||
    (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
  );
}

/** Writes a failure in the selected format and returns the exit status. */
export function reportFailure(io: CliIo, json: boolean, command: string, failure: CliFailure): ExitStatus {
  const status = exitStatusFor(failure);
  if (json) {
    io.stdout(`${failureDocument(command, failure)}\n`);
    return status;
  }
  const lines = [`error: ${failure.code}: ${clean(failure.reason)}`];
  if (failure.paid !== "none") lines.push(`paid: ${failure.paid}${PAID_HINT[failure.paid]}`);
  const receipt = failure.details?.["receipt"] as
    { transaction?: unknown; explorerUrl?: unknown } | undefined;
  if (typeof receipt?.transaction === "string") lines.push(`transaction: ${receipt.transaction}`);
  if (typeof receipt?.explorerUrl === "string") lines.push(`explorer: ${receipt.explorerUrl}`);
  if (failure.retryable && failure.paid === "none") lines.push("This can be retried.");
  io.stderr(`${lines.join("\n")}\n`);
  return status;
}

const PAID_HINT: Readonly<Record<Paid, string>> = {
  none: "",
  not_settled: " (a signed payment was refused; it did not settle)",
  settled: " (the payment settled; do not retry)",
  unknown: " (money may have moved; check rail402 session show before retrying)",
};

export function reportSuccess(
  io: CliIo,
  json: boolean,
  command: string,
  network: string | undefined,
  result: unknown,
  human: () => string,
): typeof EXIT.ok {
  io.stdout(json ? `${successDocument(command, network, result)}\n` : ensureNewline(human()));
  return EXIT.ok;
}

function ensureNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

/** Text safe for a terminal: control and bidirectional characters removed. */
export function clean(text: string, max = 2_000): string {
  return sanitizeText(text, max);
}

/** Aligned "key: value" lines; undefined and null values are left out. */
export function fields(entries: readonly (readonly [string, unknown])[]): string {
  const shown = entries.filter(([, value]) => value !== undefined && value !== null);
  const width = Math.max(0, ...shown.map(([key]) => key.length));
  return shown
    .map(
      ([key, value]) =>
        `${`${key}:`.padEnd(width + 2)}${clean(typeof value === "string" ? value : toJson(value))}`,
    )
    .join("\n");
}

/** Seller content for a terminal: JSON, indented. */
export function pretty(value: unknown): string {
  return toJson(value, 2);
}
