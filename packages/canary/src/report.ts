import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { X402Error, type ErrorCode, type X402ErrorPayload } from "@rail402/errors";

/**
 * Canary reporting.
 *
 * Two rules shape this module:
 *
 * 1. **A failure names itself.** Every way a canary can fail resolves to a registered code and a
 *    non-null reason. A monitoring check that fails with a stack trace tells an
 *    operator that something broke; it does not tell them *what property* broke.
 * 2. **The evidence is machine-readable first.** Everything published about conformance is
 *    generated from these JSON documents, so the README badge and the operator's
 *    dashboard cannot disagree with each other or drift from what was actually observed. Nobody
 *    else in the ecosystem publishes conformance evidence at all
 *    so it is close to free differentiation —
 *    but only if it is true, which means generated rather than written.
 */

/** One observable step of a canary run. `detail` is always populated, pass or fail. */
export interface CanaryStep {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly ms: number;
}

export interface CanaryReport {
  /** Stable identifier for this check, e.g. `discovery-loop`. Used as the status filename. */
  readonly check: string;
  readonly status: "pass" | "fail";
  /** ISO-8601, matching `lastUpdated` on the wire — see apps/bazaar/src/catalog/types.ts. */
  readonly observedAt: string;
  readonly network: string;
  readonly facilitator: string;
  readonly durationMs: number;
  readonly steps: readonly CanaryStep[];
  /** Null on success; a full `{ code, reason, retryable, details? }` payload on failure. */
  readonly failure: X402ErrorPayload<ErrorCode> | null;
  /** Check-specific measurements — the numbers we publish (indexing lag, search rank, tx hash). */
  readonly observations: Readonly<Record<string, unknown>>;
}

/**
 * Runs and times the steps of a canary, converting any throw into a coded failure.
 *
 * A step that throws ends the run: canary steps are sequential preconditions for one another
 * (you cannot measure indexing lag for a payment that did not settle), so continuing past a
 * failure would publish a number derived from a broken run.
 */
export class CanaryRun {
  private readonly steps: CanaryStep[] = [];
  private readonly observations: Record<string, unknown> = {};
  private readonly startedAt = Date.now();

  constructor(
    private readonly check: string,
    private readonly network: string,
    private readonly facilitator: string,
    /** Progress sink. Defaults to stderr so stdout stays parseable. */
    private readonly log: (line: string) => void = line => console.error(line),
  ) {}

  /**
   * Execute one named step.
   *
   * @param name - short step identifier, stable across runs so a diff between two reports is legible
   * @param fn - the work. Returns `{ detail, ...observations }`; `detail` is the human line.
   * @throws X402Error - rethrown unchanged so the caller records the code the step chose
   */
  async step<T extends { detail: string }>(name: string, fn: () => Promise<T>): Promise<T> {
    const began = Date.now();
    try {
      const result = await fn();
      const ms = Date.now() - began;
      this.steps.push({ name, ok: true, detail: result.detail, ms });
      this.log(`  ok   ${name.padEnd(28)} ${result.detail} (${ms}ms)`);
      return result;
    } catch (error) {
      const ms = Date.now() - began;
      const detail = error instanceof X402Error ? error.reason : describe(error);
      this.steps.push({ name, ok: false, detail, ms });
      this.log(`  FAIL ${name.padEnd(28)} ${detail} (${ms}ms)`);
      throw error;
    }
  }

  /** Record a published measurement. Kept separate from steps: steps are the trace, these are data. */
  observe(key: string, value: unknown): void {
    this.observations[key] = value;
  }

  finish(failure?: unknown): CanaryReport {
    return {
      check: this.check,
      status: failure === undefined ? "pass" : "fail",
      observedAt: new Date().toISOString(),
      network: this.network,
      facilitator: this.facilitator,
      durationMs: Date.now() - this.startedAt,
      steps: [...this.steps],
      failure: failure === undefined ? null : toPayload(failure),
      observations: { ...this.observations },
    };
  }
}

/**
 * Coerce anything thrown into a coded payload.
 *
 * The fallback matters more than it looks: an unregistered throw (a TypeError, a fetch failure)
 * must still produce a code and a non-null reason, or the canary would itself violate the
 * criterion it exists to police.
 */
export function toPayload(error: unknown): X402ErrorPayload<ErrorCode> {
  if (error instanceof X402Error) return error.payload;
  return {
    code: "canary_setup_failed",
    reason: `The canary aborted with an unclassified error: ${describe(error)}`,
    retryable: true,
  };
}

function describe(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return typeof error === "string" && error ? error : "an error with no message";
}

/** Write a report to `docs/status/<check>.json`, creating the directory if needed. */
export function writeReport(path: string, report: CanaryReport): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
