import { defineCodes } from "@rail402.dev/errors";

/**
 * Every code the Explorer's pages and read API return, as `{ error: { code, reason } }` in JSON and on
 * the error page. Nothing the Explorer answers concerns a payment: it only reads public ledgers.
 */
export const explorerCodes = defineCodes({
  explorer_not_found: {
    status: 404,
    retryable: false,
    reason:
      "No x402 transaction, account or page matches this path. Hashes are 64 hex characters; accounts are G… or C… strkeys.",
  },
  explorer_invalid_parameter: {
    status: 400,
    retryable: false,
    reason: "A query parameter is unknown or has an invalid value.",
  },
  explorer_invalid_limit: {
    status: 400,
    retryable: false,
    reason: "limit must be an integer from 1 to 100.",
  },
  explorer_offset_unsupported: {
    status: 400,
    retryable: false,
    reason: "Pages are fetched with the cursor of the previous page; offset is not supported.",
  },
  explorer_invalid_cursor: {
    status: 400,
    retryable: false,
    reason: "The cursor is malformed or does not belong to this list; start again without it.",
  },
  explorer_rate_limited: {
    status: 429,
    retryable: true,
    reason: "Too many requests from this client; retry after the time in Retry-After.",
  },
  explorer_lookup_busy: {
    status: 429,
    retryable: true,
    reason:
      "This hash is not indexed yet and the live lookup budget is used up; retry after the time in Retry-After.",
  },
  explorer_lookup_unavailable: {
    status: 503,
    retryable: true,
    reason: "This hash is not indexed yet and the live lookup could not reach the network's RPC.",
  },
  explorer_report_unavailable: {
    status: 503,
    retryable: true,
    reason:
      "No report is available for this network yet: no ledgers are indexed or the first report is still being computed.",
  },
  explorer_unavailable: {
    status: 503,
    retryable: true,
    reason: "The Explorer's database did not answer in time.",
  },
  explorer_method_not_allowed: {
    status: 405,
    retryable: false,
    reason: "The Explorer is read-only: only GET and HEAD are accepted.",
  },
  explorer_internal_error: {
    status: 500,
    retryable: true,
    reason: "An unexpected error occurred while answering.",
  },
});

export type ExplorerCode = keyof typeof explorerCodes;
