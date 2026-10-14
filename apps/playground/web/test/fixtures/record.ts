/**
 * Records run reports from the browser and integration suites as projection fixtures: with
 * `PLAYGROUND_RECORD_FIXTURES=1`, each report is written to `recorded/<name>.json`, its local stack's
 * URLs and accounts replaced by the fixture identities (ids.ts), so the recorded events read like
 * the hosted Playground's while every other value (hashes, amounts, timings, codes) stays as the run
 * produced it.
 *
 *   PLAYGROUND_RECORD_FIXTURES=1 pnpm --filter @rail402.dev/playground test:e2e
 *   PLAYGROUND_RECORD_FIXTURES=1 pnpm vitest run --project integration apps/playground/web/test/integration
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { IDS, URLS } from "./ids.ts";

/** The local stack's own identities, each replaced by its fixture counterpart. */
export interface StackIdentities {
  readonly publicUrl: string;
  readonly demoSellerUrl: string;
  readonly facilitatorUrl: string;
  readonly payer: string;
  readonly demoPayTo: string;
  readonly labPayTo: string;
  readonly sponsor: string;
  readonly asset: string;
  readonly assetIssuer: string;
  readonly uptoContract: string;
}

export const recording = (): boolean => process.env["PLAYGROUND_RECORD_FIXTURES"] === "1";

/** The report's text with the stack's identities replaced. */
export function normalizeRun(text: string, stack: StackIdentities): string {
  const pairs: [string, string][] = [
    [stack.publicUrl, URLS.public],
    [stack.demoSellerUrl, URLS.demoSeller],
    [stack.facilitatorUrl, URLS.facilitator],
    [stack.payer, IDS.buyer],
    [stack.demoPayTo, IDS.demoPayTo],
    [stack.labPayTo, IDS.playgroundPayTo],
    [stack.sponsor, IDS.feeSigner],
    [stack.asset, IDS.usdc],
    [stack.assetIssuer, IDS.usdcIssuer],
    [stack.uptoContract, IDS.uptoContract],
  ];
  // Longest first, so a URL is replaced before an origin it starts with.
  pairs.sort(([a], [b]) => b.length - a.length);
  let normalized = text;
  for (const [local, fixture] of pairs) normalized = normalized.replaceAll(local, fixture);
  // Hosts as the page shows them (`127.0.0.1:port`).
  for (const [local, fixture] of [
    [stack.publicUrl, URLS.public],
    [stack.demoSellerUrl, URLS.demoSeller],
  ] as const) {
    normalized = normalized.replaceAll(new URL(local).host, new URL(fixture).host);
  }
  return normalized;
}

/** Writes the report as fixture `name` when recording is on. */
export function recordRun(name: string, report: unknown, stack: StackIdentities): void {
  if (!recording()) return;
  const directory = fileURLToPath(new URL("./recorded/", import.meta.url));
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${name}.json`);
  writeFileSync(file, `${normalizeRun(JSON.stringify(report, null, 2), stack)}\n`);
}
