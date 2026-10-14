/**
 * A run's export: built from its event log and summary only, so it holds exactly what the page was
 * shown and nothing the events do not carry.
 */
import type { PublicConfig } from "../../../src/shared/public-config.ts";
import type { Run } from "./run.ts";
import type { RunReport } from "./types.ts";

export function runReport(run: Run, config: PublicConfig): RunReport {
  return {
    format: "rail402-playground-run",
    version: 1,
    runId: run.runId,
    network: config.network,
    playgroundVersion: config.version,
    startedAt: run.startedAt,
    summary: run.summary,
    events: [...run.events],
  };
}
