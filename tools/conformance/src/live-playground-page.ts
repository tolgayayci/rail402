/**
 * What the live Playground run reads besides the page itself: the run reports the Lab saves (the event
 * log the page drew from), and a poll for conditions outside the browser. Driving the page (the
 * wallet, a Lab run, a refusal, a Bazaar payment) is shared with the browser tests, in
 * apps/playground/e2e/page.ts.
 */

/** A Playground run report, as the Lab's "Save the run report" button saves it. */
export interface RunReport {
  readonly format: string;
  readonly runId: string;
  readonly summary: { readonly status: string; readonly code?: string; readonly reason?: string } | null;
  readonly events: readonly ReportEvent[];
}

/** The parts of a run event this run reads. */
export interface ReportEvent {
  readonly kind: string;
  readonly phase?: string;
  readonly event?: { readonly type?: string };
  readonly layer?: string;
  readonly code?: string;
  readonly reason?: string;
  readonly view?: { readonly hash?: string; readonly explorerUrl?: string };
  readonly top?: readonly { readonly id?: string }[];
  readonly query?: string;
}

/** Parses a saved run report. */
export function parseReport(text: string): RunReport {
  const report = JSON.parse(text) as RunReport;
  if (report.format !== "rail402-playground-run") throw new Error("the download is not a run report");
  return report;
}

/** Waits until `probe` returns a value other than undefined, or throws `message` after `timeoutMs`. */
export async function until<T>(
  probe: () => Promise<T | undefined>,
  message: string,
  timeoutMs = 60_000,
  intervalMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`timed out after ${String(timeoutMs)} ms: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** How many SDK events of a type a run reported (`reserved`, `signed`, `settled`, …). */
export function sdkEventCount(report: RunReport, type: string): number {
  return report.events.filter((event) => event.kind === "sdk" && event.event?.type === type).length;
}

/** The last refusal a run reported, with the layer that refused. */
export function lastRefusal(report: RunReport): { layer: string; code: string; reason: string } | undefined {
  const refusal = report.events.filter((event) => event.kind === "refusal").at(-1);
  return refusal === undefined
    ? undefined
    : { layer: refusal.layer ?? "", code: refusal.code ?? "", reason: refusal.reason ?? "" };
}

/** The transactions a run read from the chain, by hash. */
export function reportedTransactions(report: RunReport): string[] {
  return report.events.flatMap((event) =>
    event.kind === "chain" && event.phase === "tx" && typeof event.view?.hash === "string"
      ? [event.view.hash]
      : [],
  );
}
