/**
 * Observations for the operational test report. A test that proves an operational exercise calls
 * `recordOps(id, observed)` with what it measured (transaction hashes, fees, metric deltas, ledgers);
 * when `RAIL402_OPS_RECORD` names a file, each call appends one JSON line to it, and
 * `tools/conformance/src/ops.ts` joins those lines with the test results. Without the variable the
 * call does nothing, so ordinary test runs write no files.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const OPS_RECORD_ENV = "RAIL402_OPS_RECORD";

export interface OpsObservation {
  /** The exercise id, for example `balance-race`. */
  readonly id: string;
  readonly at: string;
  readonly observed: Record<string, unknown>;
}

/** Appends one observation for exercise `id` when recording is on. */
export function recordOps(id: string, observed: Record<string, unknown>): void {
  const file = process.env[OPS_RECORD_ENV];
  if (file === undefined || file === "") return;
  const line: OpsObservation = { id, at: new Date().toISOString(), observed };
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(
    file,
    `${JSON.stringify(line, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value))}\n`,
  );
}
