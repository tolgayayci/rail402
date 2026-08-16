/**
 * Live proof of the Agents scene against real testnet.
 *
 * Runs the orchestrator directly (the same code the /agent/run route drives), creating a real
 * OpenZeppelin smart account with a budget, paying under it, being refused over it BY THE CHAIN,
 * and getting the unused upto ceiling refunded. Prints every event and asserts the load-bearing
 * beats. Slow (~60-90s, several settlements).
 *
 * Run:  pnpm --filter @rail402.dev/playground exec tsx scripts/agent-e2e.ts
 * Needs .env.testnet with CLIENT_STELLAR_PRIVATE_KEY holding testnet USDC (the dispenser/funder).
 */
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/server/config.js";
import { runAgentScene, type AgentEvent } from "../src/server/agent/orchestrator.js";

const env = readFileSync(new URL("../../../.env.testnet", import.meta.url), "utf8");
const dispenserSecret = env.match(/CLIENT_STELLAR_PRIVATE_KEY=(\S+)/)?.[1];
if (!dispenserSecret) throw new Error("CLIENT_STELLAR_PRIVATE_KEY not in .env.testnet");

const ICON: Record<string, string> = { system: "·", agent: "🤖", seller: "🏪", chain: "⛓" };

async function main() {
  const config = loadConfig({
    PLAYGROUND_DISPENSER_SECRET: dispenserSecret,
    PLAYGROUND_FACILITATOR_URL: process.env["FACILITATOR_URL"] ?? "https://facilitator.rail402.dev",
  } as NodeJS.ProcessEnv);

  // A small budget keeps the demo cheap and the dispenser topped up (0.2 USDC).
  const budgetStroops = 2_000_000n;
  console.log(`Running the Agents scene: budget 0.2 USDC, facilitator ${config.facilitatorUrl}\n`);

  const seen: AgentEvent[] = [];
  const result = await runAgentScene({
    config,
    budgetStroops,
    onEvent: e => {
      seen.push(e);
      const data = e.data ? "  " + JSON.stringify(e.data) : "";
      console.log(`  ${ICON[e.actor]} [${e.phase}] ${e.message}${data}`);
    },
  });

  console.log("");
  const ok = (cond: boolean, label: string) => {
    if (!cond) throw new Error(`ASSERTION FAILED: ${label}`);
    console.log(`  ✓ ${label}`);
  };

  ok(result.ok, "the run completed");
  ok(!!result.account?.startsWith("C"), `a smart account was created: ${result.account}`);
  ok(!!result.transactions["exact"], `paid under budget on-ledger: ${result.transactions["exact"]}`);

  const overBudget = seen.find(e => e.phase === "over-budget" && e.actor === "chain");
  ok(!!overBudget, "the over-budget attempt produced a chain event");
  ok(
    overBudget?.data?.["code"] === "invalid_exact_stellar_payload_account_policy_refused",
    `the chain refused the over-budget payment with the policy code: ${overBudget?.data?.["code"]}`,
  );

  ok(!!result.transactions["upto"], `metered upto payment settled on-ledger: ${result.transactions["upto"]}`);
  const refund = seen.find(e => e.phase === "metering" && e.data?.["refunded"] !== undefined);
  ok(refund?.data?.["refunded"] === true, "the unused upto ceiling was refunded to the budget on-ledger");

  console.log("\n✅ AGENTS SCENE PROVEN LIVE");
  console.log(`   account:  ${result.account}`);
  console.log(`   exact tx: ${result.transactions["exact"]}`);
  console.log(`   upto tx:  ${result.transactions["upto"]}`);
}

main().then(
  () => process.exit(0),
  err => {
    console.error("\n❌", err?.stack ?? err?.message ?? err);
    process.exit(1);
  },
);
