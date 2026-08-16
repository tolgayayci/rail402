/**
 * Live proof for debug-my-payment: settles a REAL testnet payment through the DEPLOYED playground
 * (stock client, deployed dispenser), then decodes that fresh hash through POST /debug/tx — which
 * exercises the whole loop: settlement → explorer ingestion (a few seconds of lag, honest
 * retryable 404 while it ingests) → glass decode. Also analyzes the deployed seller's LIVE 402
 * challenge through POST /debug/challenge.
 *
 * Run:  pnpm --filter @rail402.dev/playground exec tsx scripts/debug-e2e.ts
 * Env:  PLAYGROUND_URL (deployed playground), PLAYGROUND_EXPLORER_API_URL (explorer API)
 */
import { Keypair } from "@stellar/stellar-sdk";
import { loadConfig } from "../src/server/config.js";
import { createApp } from "../src/server/app.js";
import { createSession, bootstrapSession, payExact, type SessionConfig } from "../src/browser/index.js";
import type { DebugTxView, ChallengeAnalysis } from "../src/server/debug.js";

const DEPLOYED = process.env["PLAYGROUND_URL"] ?? "https://playground-api-production-5062.up.railway.app";
const EXPLORER_API = process.env["PLAYGROUND_EXPLORER_API_URL"] ?? "https://explorer-explorer.up.railway.app";

const ok = (cond: boolean, label: string) => {
  if (!cond) throw new Error(`ASSERTION FAILED: ${label}`);
  console.log(`  ✓ ${label}`);
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  console.log(`Proving debug-my-payment: deployed playground ${DEPLOYED}, explorer ${EXPLORER_API}\n`);

  // The local app under test serves only /debug/* here; its dispenser is never touched.
  const config = loadConfig({
    PLAYGROUND_DISPENSER_SECRET: Keypair.random().secret(),
    PLAYGROUND_EXPLORER_API_URL: EXPLORER_API,
  } as NodeJS.ProcessEnv);
  const { app } = createApp({ config });

  console.log("① Settle a fresh payment through the DEPLOYED playground (stock client)");
  const cfg = (await (await fetch(`${DEPLOYED}/session/config`)).json()) as {
    network: string; facilitatorUrl: string; horizonUrl: string; friendbotUrl: string;
    usdc: { code: string; issuer: string; sac: string };
  };
  const sessionConfig: SessionConfig = { ...cfg, playgroundUrl: DEPLOYED };
  const session = createSession();
  await bootstrapSession(session, sessionConfig, s => console.log(`  … ${s.message}`));
  const pay = await payExact({
    session,
    url: `${DEPLOYED}/demo/convert?amount=1&from=USDC`,
    network: cfg.network,
    onStep: s => console.log(`  … ${s.phase}`),
  });
  ok(pay.ok && !!pay.transaction, `settled on-ledger: ${pay.transaction}`);
  const hash = pay.transaction!;

  console.log("\n② Decode that fresh hash through POST /debug/tx (explorer ingest lag is honest)");
  let view: DebugTxView | undefined;
  for (let attempt = 1; attempt <= 15; attempt++) {
    const res = await app.request("/debug/tx", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hash }),
    });
    if (res.status === 200) {
      view = (await res.json()) as DebugTxView;
      break;
    }
    const body = (await res.json()) as { code?: string; retryable?: boolean };
    ok(
      res.status === 404 && body.code === "explorer_tx_not_found" && body.retryable === true,
      `not ingested yet → coded retryable 404 (attempt ${attempt})`,
    );
    await sleep(4000);
  }
  ok(!!view, "the explorer ingested the settlement and /debug/tx decoded it");
  ok(view!.transaction === hash && view!.isX402, "decode matches the settled hash");
  ok(view!.scheme === "exact", `scheme decoded: ${view!.scheme}`);
  ok(view!.confidence === "rail402", `confidence tier: ${view!.confidence}`);
  ok(view!.from === session.address, `buyer is the session wallet ${session.address.slice(0, 6)}…`);
  ok(view!.feeSponsored, "fee sponsorship read off the ledger (buyer ≠ fee payer)");
  ok(view!.steps.length === 4 && view!.steps[3]!.phase === "settled", "glass timeline reconstructed");
  ok(!!view!.sellerUrl, `Bazaar enrichment present → re-execute deep link: ${view!.sellerUrl}`);

  console.log("\n③ Analyze the DEPLOYED seller's live 402 through POST /debug/challenge");
  const unpaid = await fetch(`${DEPLOYED}/demo/convert?amount=1`);
  ok(unpaid.status === 402, "deployed seller answers 402 unpaid");
  const header = unpaid.headers.get("PAYMENT-REQUIRED");
  ok(!!header, "PAYMENT-REQUIRED header present");
  const res = await app.request("/debug/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challenge: header }),
  });
  const analysis = (await res.json()) as ChallengeAnalysis;
  ok(analysis.ok, `challenge analyzed payable: ${analysis.reason}`);
  ok(analysis.accepts[0]!.feesSponsored, "fee sponsorship visible in the challenge");

  console.log("\n✅ DEBUG-MY-PAYMENT PROVEN LIVE");
  console.log(`   settled + decoded: ${hash}`);
  console.log(`   explorer receipt:  ${view!.explorerUrl}`);
}

main().then(
  () => process.exit(0),
  err => {
    console.error("\n❌", err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  },
);
