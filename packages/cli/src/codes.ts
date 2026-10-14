import { Rail402Error, defineCodes, mergeCodes, type ErrorOptions } from "@rail402.dev/errors";
import { agentCodes, defaultPaid, type AgentCode, type Paid } from "@rail402.dev/sdk";
import { sellerCodes } from "@rail402.dev/sdk/seller/codes";

/** Failures of the command line itself: arguments, configuration and the command's own limits. */
export const cliCodes = defineCodes({
  cli_usage_invalid: {
    status: 400,
    retryable: false,
    reason: "The command line is invalid; see rail402 --help.",
  },
  cli_config_invalid: {
    status: 400,
    retryable: false,
    reason: "The rail402 configuration file is invalid.",
  },
  cli_command_not_supported_on_network: {
    status: 400,
    retryable: false,
    reason: "This command is not available on the selected network.",
  },
  cli_timeout: {
    status: 504,
    retryable: true,
    reason: "The command did not finish within its time limit (--timeout).",
  },
  cli_internal_error: {
    status: 500,
    retryable: false,
    reason: "rail402 failed unexpectedly.",
  },
});

export type CliCode = keyof typeof cliCodes;

/** Every code a rail402 command can report: the SDK's, the seller helpers' and the command line's. */
export const cliErrorCodes = mergeCodes(agentCodes, sellerCodes, cliCodes);

export type CliErrorCode = keyof typeof cliErrorCodes;

export class CliError extends Rail402Error<CliCode> {
  constructor(code: CliCode, options: ErrorOptions = {}) {
    super(code, cliCodes[code], options);
  }
}

export function cliError(code: CliCode, reason?: string, details?: Record<string, unknown>): CliError {
  return new CliError(code, {
    ...(reason === undefined ? {} : { reason }),
    ...(details === undefined ? {} : { details }),
  });
}

export function usage(reason: string): CliError {
  return cliError("cli_usage_invalid", reason);
}

export function isCliErrorCode(value: unknown): value is CliErrorCode {
  return typeof value === "string" && Object.hasOwn(cliErrorCodes, value);
}

/** The `paid` value a code carries unless the error states otherwise. */
export function defaultPaidOf(code: CliErrorCode): Paid {
  return Object.hasOwn(defaultPaid, code) ? defaultPaid[code as AgentCode] : "none";
}

/**
 * Exit statuses. A script can tell from the status alone whether retrying is safe: 5 means money
 * may have moved, so the same call must not simply be repeated.
 */
export const EXIT = {
  ok: 0,
  internal: 1,
  usage: 2,
  refused: 3,
  rejected: 4,
  paid: 5,
  unavailable: 6,
  notFound: 7,
} as const;

export type ExitStatus = (typeof EXIT)[keyof typeof EXIT];

/** Codes that mean the command line, the configuration or the key must change. */
const USAGE_CODES: ReadonlySet<string> = new Set<CliErrorCode>([
  "cli_usage_invalid",
  "cli_config_invalid",
  "cli_command_not_supported_on_network",
  "key_not_found",
  "key_invalid",
  "key_file_insecure",
  "key_exists",
  "payment_cap_required",
  "payment_cap_invalid",
  "payment_policy_invalid",
  "payment_request_invalid",
  "payment_signer_unavailable",
  "transaction_hash_invalid",
]);

const NOT_FOUND_CODES: ReadonlySet<string> = new Set<CliErrorCode>([
  "listing_not_found",
  "transaction_not_found",
  "mcp_tool_not_found",
  "account_not_found",
]);

/**
 * The exit status of a failure. `paid` decides first, because it is what makes a retry unsafe:
 * settled or unknown is 5, and a signed payment the seller refused is 4. Otherwise usage problems
 * are 2, missing things 7, temporary failures 6, an unexpected failure 1, and any other refusal
 * (nothing was signed) 3.
 */
export function exitStatusFor(failure: {
  readonly code: string;
  readonly paid: Paid;
  readonly retryable: boolean;
}): ExitStatus {
  if (failure.paid === "settled" || failure.paid === "unknown") return EXIT.paid;
  if (failure.paid === "not_settled") return EXIT.rejected;
  if (USAGE_CODES.has(failure.code)) return EXIT.usage;
  if (NOT_FOUND_CODES.has(failure.code)) return EXIT.notFound;
  if (failure.retryable) return EXIT.unavailable;
  if (failure.code === "cli_internal_error") return EXIT.internal;
  // A seller helper refusing a declaration or a URL is an input problem.
  if (failure.code.startsWith("seller_")) return EXIT.usage;
  return EXIT.refused;
}
