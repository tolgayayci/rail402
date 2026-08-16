/**
 * Live proof of the C-Account Policy Lab: deploy a real smart account with a budget, then run the
 * teaching loop against it — pay under budget (allowed), pay over budget (refused BY THE CHAIN),
 * raise the limit on-ledger, retry (now allowed), and an `upto` payment (allowed + refunded).
 * Every step is a real testnet transaction.
 *
 * Run:  pnpm --filter @rail402.dev/playground exec tsx scripts/lab-e2e.ts
 * Needs .env.testnet with a funder secret (CLIENT_STELLAR_PRIVATE_KEY or PLAYGROUND_DISPENSER_SECRET).
 */
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/server/config.js";
import { createLabStore, type LabState } from "../src/server/lab/lab.js";

const env = readFileSync(new URL("../../../.env.testnet", import.meta.url), "utf8");
const funder =
  env.match(/PLAYGROUND_DISPENSER_SECRET=(\S+)/)?.[1] ?? env.match(/CLIENT_STELLAR_PRIVATE_KEY=(\S+)/)?.[1];
if (!funder) throw new Error("No funder secret in .env.testnet");

const ok = (cond: boolean, label: string) => {
  if (!cond) throw new Error(`ASSERTION FAILED: ${label}`);
  console.log(`  ✓ ${label}`);
};
const budget = (r: LabState, scheme: "exact" | "upto") => r.rules.find(x => x.scheme === scheme)!;

async function main() {
  const config = loadConfig({
    PLAYGROUND_DISPENSER_SECRET: funder,
    PLAYGROUND_FACILITATOR_URL: process.env["FACILITATOR_URL"] ?? "https://facilitator.rail402.dev",
  } as NodeJS.ProcessEnv);
  const lab = createLabStore(config);

  console.log("① Deploy a smart account with a 0.1 USDC budget");
  const { labId } = lab.deploy({ limitStroops: 1_000_000n, periodLedgers: 100 });
  let state: LabState | undefined;
  for (let i = 0; i < 60; i++) {
    state = await lab.get(labId);
    if (state?.status === "ready" || state?.status === "failed") break;
    await new Promise(r => setTimeout(r, 2000));
  }
  state!.events.forEach(e => console.log(`  … ${e.message}`));
  ok(state?.status === "ready", `account ready: ${state?.account}`);
  ok(budget(state!, "exact").limitStroops === "1000000", "exact budget is 0.1 USDC");

  console.log("\n② Pay 0.04 USDC — under budget");
  let r = await lab.pay(labId, { scheme: "exact", amountStroops: 400_000n });
  ok(r.allowed, `allowed, settled on-ledger: ${r.transaction}`);
  ok(budget({ rules: r.rules } as LabState, "exact").spentStroops === "400000", "budget shows 0.04 spent");

  console.log("\n③ Pay 0.25 USDC — over budget");
  r = await lab.pay(labId, { scheme: "exact", amountStroops: 2_500_000n });
  ok(!r.allowed, "refused");
  ok(r.code === "invalid_exact_stellar_payload_account_policy_refused", `refused BY THE CHAIN's policy: ${r.code}`);

  console.log("\n④ Raise the exact limit to 0.3 USDC (on-ledger set_spending_limit)");
  state = await lab.setLimit(labId, { scheme: "exact", limitStroops: 3_000_000n });
  ok(budget(state, "exact").limitStroops === "3000000", "limit is now 0.3 USDC");

  console.log("\n⑤ Retry the 0.25 USDC payment — now within the raised budget");
  r = await lab.pay(labId, { scheme: "exact", amountStroops: 2_500_000n });
  ok(r.allowed, `now allowed, settled: ${r.transaction}`);

  console.log("\n⑥ upto: authorize 0.08, use 0.02 — allowed and refunded");
  r = await lab.pay(labId, { scheme: "upto", ceilingStroops: 800_000n, actualStroops: 200_000n });
  ok(r.allowed, `allowed, settled: ${r.transaction}`);
  ok(r.refundStroops === "600000", "0.06 USDC ceiling refunded to the budget");
  ok(budget({ rules: r.rules } as LabState, "upto").spentStroops === "200000", "upto budget reflects 0.02 actual, not the 0.08 ceiling");

  console.log("\n✅ POLICY LAB PROVEN LIVE");
  console.log(`   account: ${state!.account}`);
}

main().then(
  () => process.exit(0),
  err => {
    console.error("\n❌", err?.stack ?? err?.message ?? err);
    process.exit(1);
  },
);
