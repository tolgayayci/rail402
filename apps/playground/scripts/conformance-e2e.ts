/**
 * Live proof for the conformance panel: boots the playground app pointed at the LIVE facilitator
 * and asserts that GET /conformance reports both schemes with fees sponsored, renders the recorded
 * e2e verdict honestly (never "met" for a regression), publishes settled hashes for both schemes,
 * and that GET /conformance/errors is the complete registry. Read-only — no payment, no drip.
 *
 * Run:  pnpm --filter @rail402.dev/playground exec tsx scripts/conformance-e2e.ts
 * (set PLAYGROUND_FACILITATOR_URL to point elsewhere; defaults to the prod facilitator)
 */
import { Keypair } from "@stellar/stellar-sdk";
import { ALL_ERROR_CODES } from "@rail402.dev/errors";
import { loadConfig } from "../src/server/config.js";
import { createApp } from "../src/server/app.js";
import { loadStatusEvidence, DEFAULT_STATUS_DIR, type ConformanceReport } from "../src/server/conformance.js";

const ok = (cond: boolean, label: string) => {
  if (!cond) throw new Error(`ASSERTION FAILED: ${label}`);
  console.log(`  ✓ ${label}`);
};

async function main() {
  // The dispenser is never touched by /conformance; a throwaway key satisfies config validation.
  const config = loadConfig({
    PLAYGROUND_DISPENSER_SECRET: Keypair.random().secret(),
    ...(process.env["PLAYGROUND_FACILITATOR_URL"]
      ? { PLAYGROUND_FACILITATOR_URL: process.env["PLAYGROUND_FACILITATOR_URL"] }
      : {}),
  } as NodeJS.ProcessEnv);
  console.log(`Proving the conformance panel against LIVE facilitator ${config.facilitatorUrl}\n`);
  const { app } = createApp({ config });

  console.log("① GET /conformance");
  const res = await app.request("/conformance");
  ok(res.status === 200, `responds 200 (got ${res.status})`);
  const report = (await res.json()) as ConformanceReport;

  const kinds = (report.supported as { kinds: { scheme: string; network: string; extra?: { areFeesSponsored?: boolean } }[] }).kinds;
  const schemes = kinds.filter(k => k.network === "stellar:testnet").map(k => k.scheme);
  ok(schemes.includes("exact") && schemes.includes("upto"), `live /supported advertises both schemes (${schemes.join(", ")})`);
  ok(
    kinds.filter(k => k.network.startsWith("stellar:")).every(k => k.extra?.areFeesSponsored === true),
    "areFeesSponsored is true on every live Stellar kind",
  );

  ok(report.acceptance.length === 6, "all six §3.6 criteria are present");
  const byId = Object.fromEntries(report.acceptance.map(a => [a.id, a]));
  ok(byId["supported-extra"]!.status === "met", "supported-extra judged met from the live body");

  // The honesty gate: the e2e row must say exactly what the recorded run says.
  const dual = loadStatusEvidence(DEFAULT_STATUS_DIR).dual;
  const e2e = byId["e2e-suite"]!;
  if (dual?.verdict === "regression") {
    ok(e2e.status === "failing", `e2e-suite renders the recorded regression as failing (status: ${e2e.status})`);
  } else {
    ok(e2e.status !== "unknown" === (dual !== null), `e2e-suite status (${e2e.status}) tracks the recorded verdict (${dual?.verdict ?? "none"})`);
  }

  ok((report.settledHashes["exact"] ?? []).length > 0, `settled exact hashes published (${report.settledHashes["exact"]?.length})`);
  ok((report.settledHashes["upto"] ?? []).length > 0, `settled upto hashes published (${report.settledHashes["upto"]?.length})`);
  ok(report.errorRegistry.total === ALL_ERROR_CODES.length, `error registry total ${report.errorRegistry.total} matches the package`);

  console.log("\n② GET /conformance/errors");
  const errRes = await app.request("/conformance/errors");
  ok(errRes.status === 200, "responds 200");
  const errBody = (await errRes.json()) as { total: number; errors: { code: string; reason: string }[] };
  ok(errBody.errors.length === errBody.total && errBody.total === ALL_ERROR_CODES.length, `all ${errBody.total} codes served`);
  ok(errBody.errors.every(e => e.reason.length > 0), "every code carries a non-empty reason");

  console.log("\n✅ CONFORMANCE PANEL PROVEN AGAINST THE LIVE FACILITATOR");
  console.log(`   e2e-suite: ${e2e.status} — ${String(e2e.evidence["note"])}`);
  console.log(`   registry: ${report.errorRegistry.total} codes, ${report.errorRegistry.retryable} retryable`);
}

main().then(
  () => process.exit(0),
  err => {
    console.error("\n❌", err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  },
);
