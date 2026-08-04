import { ERROR_REGISTRY, type ErrorCode } from "./registry.js";
import type { ErrorDefinition, X402ErrorPayload } from "./types.js";

/**
 * Build a rejection payload from a registered code.
 *
 * There is no overload that lets you pass an unregistered code or omit the reason. That is the
 * whole point of this module: the "non null reason on every rejection" rule is enforced by the
 * type system and by the registry, not by reviewer diligence.
 *
 * @param code - a registered error code
 * @param options.reason - overrides the registry default when a more specific explanation is known
 * @param options.details - structured context. MUST NOT contain secrets, keys, or full payloads.
 */
export function createError(
  code: ErrorCode,
  options: { reason?: string; details?: Record<string, unknown> } = {},
): X402ErrorPayload<ErrorCode> {
  const definition: ErrorDefinition = ERROR_REGISTRY[code];
  const reason = options.reason?.trim() || definition.reason;

  // Defence in depth: a caller passing an empty/whitespace override must not be able to produce a
  // null-equivalent reason on the wire.
  /* c8 ignore next 3 */
  if (!reason) {
    throw new Error(`error registry corruption: code "${code}" resolved to an empty reason`);
  }

  return options.details === undefined
    ? { code, reason, retryable: definition.retryable }
    : { code, reason, retryable: definition.retryable, details: options.details };
}

/**
 * Throwable form, for paths where an exception is the natural control flow (config validation at
 * startup, for instance). Carries the same payload so nothing is lost when it is caught and
 * serialized at a boundary.
 */
export class X402Error extends Error {
  readonly payload: X402ErrorPayload<ErrorCode>;

  constructor(code: ErrorCode, options: { reason?: string; details?: Record<string, unknown> } = {}) {
    const payload = createError(code, options);
    super(`${payload.code}: ${payload.reason}`);
    this.name = "X402Error";
    this.payload = payload;
  }

  get code(): ErrorCode {
    return this.payload.code;
  }

  get reason(): string {
    return this.payload.reason;
  }

  get retryable(): boolean {
    return this.payload.retryable;
  }
}

/** Type guard for values that came back from an untrusted boundary. */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && Object.hasOwn(ERROR_REGISTRY, value);
}

/**
 * Resolve a code emitted by @x402/stellar (or any upstream) into a full payload.
 *
 * The upstream library sets `invalidReason`/`errorReason` but almost never a human message. This is
 * the enrichment seam: an unrecognized code still yields a non-null reason rather than propagating
 * a bare identifier to the client, which the registry exists to prevent.
 */
export function enrichUpstreamCode(
  upstreamCode: string | undefined,
  fallback: ErrorCode,
  details?: Record<string, unknown>,
): X402ErrorPayload<ErrorCode> {
  if (isErrorCode(upstreamCode)) {
    return createError(upstreamCode, details === undefined ? {} : { details });
  }
  return createError(fallback, {
    reason: upstreamCode
      ? `Upstream rejected the payment with an unrecognized code "${upstreamCode}". ${ERROR_REGISTRY[fallback].reason}`
      : ERROR_REGISTRY[fallback].reason,
    ...(details === undefined ? {} : { details }),
  });
}
