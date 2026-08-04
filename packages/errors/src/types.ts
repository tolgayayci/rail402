/**
 * Core error shape, fixed as `{ code, reason, retryable, details? }`.
 *
 * The single hardest acceptance criterion is "a non null reason on every
 * rejection". `reason` is therefore NON-OPTIONAL at the type level: it is not possible to construct
 * a rejection in this codebase without a human-legible explanation. That is deliberate — the
 * upstream library sets a machine code on every rejection but a human message on only one of them
 * and we must not inherit that gap.
 */
export interface X402ErrorPayload<TCode extends string = string> {
  /** Stable machine-readable identifier. Agents branch on this; never parse `reason`. */
  readonly code: TCode;
  /** Non-null human-legible explanation, always required. */
  readonly reason: string;
  /** Whether an identical retry could plausibly succeed. Lets agents back off instead of guessing. */
  readonly retryable: boolean;
  /** Optional structured context. MUST NOT contain secrets, keys, or full payloads. */
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * Which surface a code belongs to. Used for metrics dimensions and to keep the registry navigable
 * as it grows; not part of the wire format.
 *
 * `canary` is the one surface that never appears on the wire: those codes name the ways a
 * monitoring check can fail. They live in this registry anyway because the registry convention allows exactly
 * one place where a machine-readable code may be defined, and a check that fails without a code and
 * a reason is the same defect the registry screens for — just pointed inward.
 */
export type ErrorSurface =
  | "protocol"
  | "facilitator"
  | "settlement"
  | "bazaar"
  | "mcp"
  | "config"
  | "canary";

/**
 * Provenance of a code — the property that keeps us interoperable.
 *
 * Inventing or renaming spec-defined error shapes is forbidden. So every code is tagged
 * with where it comes from, and `spec`/`library` codes are frozen: their string value is a wire
 * contract we do not control and must reproduce byte-for-byte.
 *
 * - `spec`    — defined in the x402 v2 specification (§9) or a scheme spec.
 * - `library` — emitted by @x402/stellar today. We must reproduce these verbatim or stock clients
 *               and the upstream e2e suite will see different strings than they expect.
 * - `local`   — ours, for failure modes that have no spec or library code. These follow the existing
 *               `invalid_exact_stellar_*` / `settle_exact_stellar_*` naming convention on purpose,
 *               so each one is directly proposable upstream rather than being a private dialect.
 */
export type ErrorProvenance = "spec" | "library" | "local";

export interface ErrorDefinition {
  /** Default human-legible reason. Callers may override with something more specific. */
  readonly reason: string;
  readonly retryable: boolean;
  readonly surface: ErrorSurface;
  readonly provenance: ErrorProvenance;
  /**
   * For `local` codes: what the upstream library reports today instead. Documents exactly what we
   * are refining and gives us the list of upstream contributions to propose.
   */
  readonly refines?: string;
  /** Operator/developer-facing note: what to actually do about it. */
  readonly remediation?: string;
}
