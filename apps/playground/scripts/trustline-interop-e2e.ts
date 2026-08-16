/**
 * Live proof for P5: the trustline pre-flight against REAL Horizon, and the interop indicator
 * against the LIVE Bazaar catalog. Read-only — no payment, no drip.
 *
 * Run:  pnpm --filter @rail402.dev/playground exec tsx scripts/trustline-interop-e2e.ts
 */
import { Keypair } from "@stellar/stellar-sdk";
import { loadConfig } from "../src/server/config.js";
import { createApp } from "../src/server/app.js";
import type { InteropCheckResult } from "../src/server/interop.js";

// The deployed playground's own demo seller — cataloged by real settlements.
const LISTED = "https://playground-api-production-5062.up.railway.app/demo/convert";
// The dispenser account: known funded, known USDC trustline.
const FUNDED_ACCOUNT = "GDGD7PG25A45FXKJPPYBICT7BOOA2PETF6JDCUTNR77KGMXFPJ7ZUR5Q";

const ok = (cond: boolean, label: string) => {
  if (!cond) throw new Error(`ASSERTION FAILED: ${label}`);
  console.log(`  ✓ ${label}`);
};

async function main() {
  const config = loadConfig({
    PLAYGROUND_DISPENSER_SECRET: Keypair.random().secret(),
  } as NodeJS.ProcessEnv);
  console.log(`Proving trustline + interop against live Horizon and ${config.facilitatorUrl}\n`);
  const { app } = createApp({ config });

  console.log("① GET /session/trustline — real Horizon");
  const funded = (await (
    await app.request(`/session/trustline?account=${FUNDED_ACCOUNT}`)
  ).json()) as { state: string; checkedAt: string };
  ok(funded.state === "ok", `funded account with trustline → ok (checked ${funded.checkedAt})`);

  const fresh = Keypair.random().publicKey();
  const absent = (await (
    await app.request(`/session/trustline?account=${fresh}`)
  ).json()) as { state: string; reason?: string };
  ok(absent.state === "missing", `never-funded account → missing (${absent.reason?.slice(0, 60)}…)`);

  const contract = await app.request(`/session/trustline?account=${config.usdc.sac}`);
  ok(contract.status === 400, "contract address → 400 with the contract-storage teaching reason");

  console.log("\n② GET /bazaar/interop-check — live catalog");
  const listed = (await (
    await app.request(`/bazaar/interop-check?url=${encodeURIComponent(LISTED)}`)
  ).json()) as InteropCheckResult;
  ok(listed.listed, `the deployed demo seller is in the live catalog`);
  ok(listed.ok, `all wire-shape checks pass: ${listed.checks.map(c => c.name).join(", ")}`);

  const unlisted = (await (
    await app.request(`/bazaar/interop-check?url=${encodeURIComponent("https://never-paid.example/api")}`)
  ).json()) as InteropCheckResult;
  ok(!unlisted.ok && !unlisted.listed, "an unlisted URL reports listed:false honestly");
  ok(
    unlisted.checks.filter(c => c.name.endsWith("envelope")).every(c => c.ok),
    "the LIVE facilitator's list and search envelopes pass the stock-shape checks",
  );

  console.log("\n✅ TRUSTLINE + INTEROP PROVEN LIVE");
  console.log(`   ${listed.reason}`);
}

main().then(
  () => process.exit(0),
  err => {
    console.error("\n❌", err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  },
);
