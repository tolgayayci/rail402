/**
 * Live end-to-end proof of the playground's browser signing paths against real testnet.
 *
 * Not a unit test and not in CI: it starts the playground server in-process (with a funded
 * dispenser), then drives the BROWSER library exactly as the UI will — createSession →
 * bootstrapSession → payExact → meter open/call/close → an attack — and asserts real on-ledger
 * settlements and coded refusals. Every tx hash it prints is verifiable on stellar.expert.
 *
 * Run:  pnpm --filter @rail402/playground exec tsx scripts/live-e2e.ts
 * Needs .env.testnet at the repo root with CLIENT_STELLAR_PRIVATE_KEY holding testnet USDC.
 */
import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { loadConfig, NETWORK, HORIZON_URL, FRIENDBOT_URL } from "../src/server/config.js";
import { createApp } from "../src/server/app.js";
import {
  createSession,
  bootstrapSession,
  fetchBalances,
  payExact,
  openMeterTab,
  callMeter,
  closeMeter,
  ATTACKS,
  runAttack,
  stroopsToDisplay,
  type SessionConfig,
} from "../src/browser/index.js";

const env = readFileSync(new URL("../../../.env.testnet", import.meta.url), "utf8");
const dispenserSecret = env.match(/CLIENT_STELLAR_PRIVATE_KEY=(\S+)/)?.[1];
if (!dispenserSecret) throw new Error("CLIENT_STELLAR_PRIVATE_KEY not in .env.testnet");

const log = (msg: string) => console.log(msg);
const ok = (cond: boolean, label: string) => {
  if (!cond) throw new Error(`ASSERTION FAILED: ${label}`);
  console.log(`  ✓ ${label}`);
};

async function main() {
  const config = loadConfig({
    PLAYGROUND_DISPENSER_SECRET: dispenserSecret,
    PLAYGROUND_FACILITATOR_URL: process.env["FACILITATOR_URL"] ?? "https://facilitator.rail402.dev",
    PLAYGROUND_DRIP_STROOPS: "5000000",
  } as NodeJS.ProcessEnv);

  const { app } = createApp({ config });
  const server = await new Promise<{ port: number; close: () => void }>(resolve => {
    const s = serve({ fetch: app.fetch, port: 0 }, info =>
      resolve({ port: info.port, close: () => s.close() }),
    );
  });
  const playgroundUrl = `http://127.0.0.1:${server.port}`;
  log(`playground listening on ${playgroundUrl}, facilitator ${config.facilitatorUrl}\n`);

  const sessionConfig: SessionConfig = {
    network: NETWORK,
    facilitatorUrl: config.facilitatorUrl,
    horizonUrl: HORIZON_URL,
    friendbotUrl: FRIENDBOT_URL,
    usdc: config.usdc,
    playgroundUrl,
  };

  try {
    // 1 — session bootstrap
    log("① Session bootstrap");
    const session = createSession();
    log(`  wallet ${session.address}`);
    await bootstrapSession(session, sessionConfig, s => log(`  … ${s.message}`));
    const funded = await fetchBalances(session, sessionConfig);
    ok(BigInt(funded.usdcStroops) >= config.dripStroops, `session funded with USDC (${stroopsToDisplay(BigInt(funded.usdcStroops))})`);
    ok(funded.xlmStroops !== "0", "session holds XLM for its own trustline tx only");

    // 2 — glass exact payment
    log("\n② Glass exact payment (/demo/convert)");
    const phases: string[] = [];
    const pay = await payExact({
      session,
      url: `${playgroundUrl}/demo/convert?amount=1&from=USDC`,
      network: NETWORK,
      onStep: s => {
        phases.push(s.phase);
        log(`  … ${s.phase}: ${s.message}`);
      },
    });
    ok(pay.ok, "payment succeeded");
    ok(!!pay.transaction, `settled on-ledger: ${pay.transaction}`);
    ok(phases.includes("challenged") && phases.includes("settled"), "timeline emitted challenged→settled");
    ok((pay.body as { stroops?: string })?.stroops === "10000000", "resource returned the converted value");

    const afterPay = await fetchBalances(session, sessionConfig);
    ok(
      BigInt(funded.usdcStroops) - BigInt(afterPay.usdcStroops) === config.exactPriceStroops,
      `exactly ${stroopsToDisplay(config.exactPriceStroops)} USDC left the wallet`,
    );

    // 3 — upto meter
    log("\n③ Upto meter (open / call×2 / close)");
    const tab = await openMeterTab({
      session,
      playgroundUrl,
      network: NETWORK,
      ceilingStroops: "1000000",
      onStep: s => log(`  … ${s.phase}: ${s.message}`),
    });
    ok(tab.ceilingStroops === "1000000", `tab opened at ceiling ${stroopsToDisplay(1000000n)} USDC`);
    const c1 = await callMeter(playgroundUrl, tab.tabId);
    const c2 = await callMeter(playgroundUrl, tab.tabId);
    ok(c2.call === 2, "two metered calls accrued");
    const close = await closeMeter(playgroundUrl, tab.tabId);
    ok(!!close.transaction, `meter settled on-ledger: ${close.transaction}`);
    ok(
      close.settledStroops === (BigInt(config.meterUnitStroops) * 2n).toString(),
      `settled ACTUAL usage ${stroopsToDisplay(BigInt(close.settledStroops))} USDC, not the ${stroopsToDisplay(1000000n)} ceiling`,
    );
    ok(
      BigInt(close.unspentStroops) === 1000000n - BigInt(config.meterUnitStroops) * 2n,
      `${stroopsToDisplay(BigInt(close.unspentStroops))} USDC of the ceiling never left the wallet`,
    );

    // 4 — attack bench
    log("\n④ Attack bench");
    const tampered = ATTACKS.find(a => a.id === "tampered-amount")!;
    // Rebuild a fresh signed exact payload to attack (the previous one settled).
    const attackPhases: string[] = [];
    const forAttack = await payExact({
      session,
      url: `${playgroundUrl}/demo/convert?amount=2&from=USDC`,
      network: NETWORK,
      onStep: s => attackPhasesPush(attackPhases, s.phase),
    });
    ok(forAttack.ok, "second payment for attack material succeeded");
    const authorization = forAttack.steps.find(s => s.authorization)?.authorization;
    ok(!!authorization, "captured the signed payload to attack");
    const outcome = await runAttack(playgroundUrl, tampered, authorization!);
    ok(outcome.refused, "tampered amount was REFUSED");
    ok(
      outcome.code === "invalid_exact_stellar_payload_wrong_amount",
      `refusal carried the expected coded reason: ${outcome.code}`,
    );
    ok(outcome.reason.length > 20, `and a human reason: "${outcome.reason}"`);

    log("\n✅ ALL LIVE ASSERTIONS PASSED");
    log(`   exact tx:  ${pay.transaction}`);
    log(`   meter tx:  ${close.transaction}`);
  } finally {
    server.close();
  }
}

function attackPhasesPush(arr: string[], phase: string) {
  arr.push(phase);
}

main().then(
  () => process.exit(0),
  err => {
    console.error("\n❌", err?.stack ?? err?.message ?? err);
    process.exit(1);
  },
);
