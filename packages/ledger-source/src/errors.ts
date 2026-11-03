/** Stable codes for every way reading or verifying a ledger can fail. */
export type LedgerSourceCode =
  | "source_config_invalid"
  | "lake_config_mismatch"
  | "http_status"
  | "http_redirect_refused"
  | "http_timeout"
  | "http_failed"
  | "object_too_large"
  | "object_undecodable"
  | "ledger_mismatch"
  | "rpc_error"
  | "ledger_gap"
  | "ledger_hash_invalid"
  | "ledger_hash_mismatch"
  | "tx_set_hash_mismatch"
  | "result_set_hash_mismatch"
  | "anchor_mismatch"
  | "anchor_unavailable"
  | "anchor_out_of_range"
  | "lumeus_key_invalid"
  | "lumeus_unauthorized"
  | "lumeus_rate_limited"
  | "lumeus_unavailable"
  | "lumeus_query_timeout"
  | "lumeus_generation_changed"
  | "lumeus_request_refused"
  | "lumeus_response_invalid";

/**
 * A ledger could not be read or did not verify. `retryable` marks transient transport failures; every
 * integrity failure (a broken chain, a hash that does not match) is final and must stop the indexer.
 */
export class LedgerSourceError extends Error {
  readonly code: LedgerSourceCode;
  readonly retryable: boolean;
  /** The server's `Retry-After`, in seconds, when it sent one. */
  readonly retryAfterSeconds: number | undefined;
  constructor(
    code: LedgerSourceCode,
    message: string,
    options: { retryable?: boolean; cause?: unknown; retryAfterSeconds?: number } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LedgerSourceError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}
