/**
 * Every rejection Rail402 returns carries a stable, machine-readable `code` and a non-empty,
 * human-readable `reason`. Codes are declared once in a code set, and the set is validated when it
 * is defined, so a missing reason or a malformed code fails at startup instead of on the wire.
 */

export interface CodeSpec {
  /** HTTP status used when the code is returned as a transport-level error. */
  readonly status: number;
  /** Whether repeating the same request unchanged can succeed later. */
  readonly retryable: boolean;
  /** Default reason. Specific errors may replace it with more detail, never with an empty string. */
  readonly reason: string;
}

export type CodeSet = Readonly<Record<string, CodeSpec>>;

const CODE_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/** Declares a code set and validates it eagerly. */
export function defineCodes<const T extends Record<string, CodeSpec>>(codes: T): Readonly<T> {
  for (const [code, spec] of Object.entries(codes)) {
    if (!CODE_PATTERN.test(code)) {
      throw new TypeError(`error code "${code}" must be lower snake_case`);
    }
    if (spec.reason.trim() === "") {
      throw new TypeError(`error code "${code}" has an empty default reason`);
    }
    if (!Number.isInteger(spec.status) || spec.status < 400 || spec.status > 599) {
      throw new TypeError(`error code "${code}" has non-error HTTP status ${spec.status}`);
    }
  }
  return Object.freeze(codes);
}

/** Merges code sets, refusing duplicate codes so one code never means two things. */
export function mergeCodes<const T extends readonly CodeSet[]>(
  ...sets: T
): Readonly<UnionToIntersection<T[number]>> {
  const merged: Record<string, CodeSpec> = {};
  for (const set of sets) {
    for (const [code, spec] of Object.entries(set)) {
      if (code in merged) throw new TypeError(`error code "${code}" is defined more than once`);
      merged[code] = spec;
    }
  }
  return Object.freeze(merged) as Readonly<UnionToIntersection<T[number]>>;
}

type UnionToIntersection<U> = (U extends unknown ? (u: U) => void : never) extends (i: infer I) => void
  ? I
  : never;

export interface ErrorOptions {
  /** Replaces the default reason. Blank values fall back to the default. */
  readonly reason?: string | undefined;
  /** Structured, non-sensitive context safe to return to the caller. */
  readonly details?: Readonly<Record<string, unknown>> | undefined;
  readonly cause?: unknown;
}

export class Rail402Error<C extends string = string> extends Error {
  override readonly name = "Rail402Error";
  readonly code: C;
  readonly reason: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: C, spec: CodeSpec, options: ErrorOptions = {}) {
    const reason = nonEmpty(options.reason) ?? spec.reason;
    super(`${code}: ${reason}`, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.reason = reason;
    this.status = spec.status;
    this.retryable = spec.retryable;
    this.details = options.details;
  }
}

/** Returns a constructor bound to one code set, so only declared codes can be raised. */
export function errorFactory<T extends CodeSet>(codes: T) {
  return (code: keyof T & string, options?: ErrorOptions): Rail402Error<keyof T & string> =>
    new Rail402Error(code, codes[code] as CodeSpec, options);
}

export function isRail402Error(value: unknown): value is Rail402Error {
  return value instanceof Rail402Error;
}

/** Body shape for transport-level errors on Rail402's own endpoints. */
export interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly reason: string;
    readonly retryable: boolean;
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

export function toErrorBody(error: Rail402Error): ErrorBody {
  return {
    error: {
      code: error.code,
      reason: error.reason,
      retryable: error.retryable,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  };
}

/** Codes for failures of the HTTP transport itself, shared by every endpoint. */
export const httpCodes = defineCodes({
  bad_request: { status: 400, retryable: false, reason: "The request is malformed." },
  unauthorized: { status: 401, retryable: false, reason: "A valid API key is required for this endpoint." },
  forbidden: { status: 403, retryable: false, reason: "The API key is not allowed to use this endpoint." },
  not_found: { status: 404, retryable: false, reason: "No route matches this path." },
  method_not_allowed: { status: 405, retryable: false, reason: "This method is not allowed on this path." },
  payload_too_large: { status: 413, retryable: false, reason: "The request body exceeds the size limit." },
  unsupported_media_type: {
    status: 415,
    retryable: false,
    reason: "The request body must be JSON (Content-Type: application/json).",
  },
  rate_limited: {
    status: 429,
    retryable: true,
    reason: "Too many requests; retry after the indicated delay.",
  },
  internal_error: { status: 500, retryable: true, reason: "An unexpected internal error occurred." },
  service_unavailable: {
    status: 503,
    retryable: true,
    reason: "The service is temporarily unavailable; retry shortly.",
  },
});

export const httpError = errorFactory(httpCodes);

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? value : undefined;
}
