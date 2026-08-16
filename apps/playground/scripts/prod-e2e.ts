/**
 * Proof that the DEPLOYED playground works end to end: drives the browser library against the live
 * prod URL, so the session is funded by the deployed dispenser and the payment settles through the
 * deployed API + the public facilitator. Settles a real testnet transaction.
 *
 * Run:  PLAYGROUND_URL=https://… pnpm --filter @rail402.dev/playground exec tsx scripts/prod-e2e.ts
 */
import {
  createSession,
  bootstrapSession,
  fetchBalances,
  payExact,
  openMeterTab,
  callMeter,
  closeMeter,
  stroopsToDisplay,
  type SessionConfig,
} from "../src/browser/index.js";

const BASE = process.env["PLAYGROUND_URL"] ?? "https://playground-api-production-5062.up.railway.app";

const ok = (cond: boolean, label: string) => {
  if (!cond) throw new Error(`ASSERTION FAILED: ${label}`);
  console.log(`  ✓ ${label}`);
};

async function main() {
  console.log(`Proving the DEPLOYED playground at ${BASE}\n`);
  const cfg = (await (await fetch(`${BASE}/session/config`)).json()) as {
    network: string;
    facilitatorUrl: string;
    horizonUrl: string;
    friendbotUrl: string;
    usdc: { code: string; issuer: string; sac: string };
  };
  const sessionConfig: SessionConfig = {
    network: cfg.network,
    facilitatorUrl: cfg.facilitatorUrl,
    horizonUrl: cfg.horizonUrl,
    friendbotUrl: cfg.friendbotUrl,
    usdc: cfg.usdc,
    playgroundUrl: BASE,
  };

  console.log("① Session bootstrap (funded by the DEPLOYED dispenser)");
  const session = createSession();
  console.log(`  wallet ${session.address}`);
  await bootstrapSession(session, sessionConfig, s => console.log(`  … ${s.message}`));
  const funded = await fetchBalances(session, sessionConfig);
  ok(BigInt(funded.usdcStroops) > 0n, `session funded with USDC (${stroopsToDisplay(BigInt(funded.usdcStroops))}) via prod`);

  console.log("\n② Glass exact payment through the DEPLOYED /demo/convert");
  const pay = await payExact({
    session,
    url: `${BASE}/demo/convert?amount=1&from=USDC`,
    network: cfg.network,
    onStep: s => console.log(`  … ${s.phase}`),
  });
  ok(pay.ok, "payment succeeded on prod");
  ok(!!pay.transaction, `settled on-ledger via prod: ${pay.transaction}`);

  console.log("\n③ Upto meter through the DEPLOYED endpoints");
  const tab = await openMeterTab({ session, playgroundUrl: BASE, network: cfg.network, ceilingStroops: "1000000" });
  await callMeter(BASE, tab.tabId);
  await callMeter(BASE, tab.tabId);
  const close = await closeMeter(BASE, tab.tabId);
  ok(!!close.transaction, `meter settled on-ledger via prod: ${close.transaction}`);
  ok(close.settledStroops === "140000", `settled actual 0.014, not the ${stroopsToDisplay(BigInt(close.ceilingStroops))} ceiling`);

  console.log("\n✅ DEPLOYED PLAYGROUND PROVEN LIVE ON PROD");
  console.log(`   exact tx: ${pay.transaction}`);
  console.log(`   meter tx: ${close.transaction}`);
}

main().then(
  () => process.exit(0),
  err => {
    console.error("\n❌", err?.stack ?? err?.message ?? err);
    process.exit(1);
  },
);
