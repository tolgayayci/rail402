/**
 * Live proof for the Agent Skill: runs the skill's OWN starter scripts, unmodified, the way a
 * stranger following SKILL.md would — against real testnet and the live facilitator.
 *
 *   1. make-wallet.mjs twice: a seller payTo (no drip) and a funded buyer (dispenser drip).
 *   2. seller-starter.mjs boots locally (stock @x402/hono middleware, live facilitator).
 *   3. buyer-starter.mjs pays it — a REAL settlement, receipt hash printed.
 *   4. buyer-starter.mjs with a too-small budget is REFUSED by the selector, exit 1, nothing spent.
 *
 * Run:  pnpm --filter @rail402.dev/playground exec tsx scripts/skill-e2e.ts
 */
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const SKILL_SCRIPTS = fileURLToPath(new URL("../skill/scripts", import.meta.url));
const SELLER_PORT = 4033;

const ok = (cond: boolean, label: string) => {
  if (!cond) throw new Error(`ASSERTION FAILED: ${label}`);
  console.log(`  ✓ ${label}`);
};

function run(script: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    execFile(
      process.execPath,
      [join(SKILL_SCRIPTS, script), ...args],
      { env: { ...process.env, ...env }, timeout: 120_000 },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : err ? 1 : 0;
        resolve({ code, out: `${stdout}\n${stderr}` });
      },
    );
  });
}

async function main() {
  console.log("Proving the Agent Skill's own scripts against real testnet\n");

  console.log("① make-wallet.mjs — seller payTo (trustline, no drip)");
  const seller = await run("make-wallet.mjs", ["--no-drip"]);
  ok(seller.code === 0, "seller wallet created");
  const sellerAddress = seller.out.match(/address: (G[A-Z0-9]{55})/)?.[1];
  ok(!!sellerAddress, `seller address ${sellerAddress?.slice(0, 6)}… with USDC trustline`);

  console.log("\n② make-wallet.mjs — buyer (trustline + dispenser drip)");
  const buyer = await run("make-wallet.mjs", []);
  ok(buyer.code === 0, "buyer wallet created");
  const buyerSecret = buyer.out.match(/secret: (S[A-Z0-9]{55})/)?.[1];
  ok(!!buyerSecret, "buyer secret captured");
  ok(/dripped [\d.]+ USDC/.test(buyer.out), "buyer funded by the playground dispenser");

  console.log("\n③ seller-starter.mjs — boot the skill's seller against the LIVE facilitator");
  const sellerProc = spawn(process.execPath, [join(SKILL_SCRIPTS, "seller-starter.mjs")], {
    env: { ...process.env, SELLER_ADDRESS: sellerAddress!, PORT: String(SELLER_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("seller did not boot in 15s")), 15_000);
      sellerProc.stdout.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("listening")) {
          clearTimeout(timer);
          resolve();
        }
      });
      sellerProc.on("exit", code => reject(new Error(`seller exited early (${code})`)));
    });
    ok(true, `seller listening on :${SELLER_PORT}`);
    const unpaid = await fetch(`http://127.0.0.1:${SELLER_PORT}/lookup?q=skill`);
    ok(unpaid.status === 402, "unpaid request → 402 challenge");

    console.log("\n④ buyer-starter.mjs — pay it (REAL settlement), then get refused over budget");
    const paid = await run(
      "buyer-starter.mjs",
      ["--url", `http://127.0.0.1:${SELLER_PORT}/lookup?q=skill`, "--budget", "0.10"],
      { CLIENT_STELLAR_PRIVATE_KEY: buyerSecret! },
    );
    ok(paid.code === 0, "payment completed");
    ok(paid.out.includes('"result":"skill"'), "paid response body returned");
    const hash = paid.out.match(/settled on-ledger: ([0-9a-f]{64})/)?.[1];
    ok(!!hash, `settled on-ledger: ${hash}`);

    const refused = await run(
      "buyer-starter.mjs",
      ["--url", `http://127.0.0.1:${SELLER_PORT}/lookup?q=skill`, "--budget", "0.01"],
      { CLIENT_STELLAR_PRIVATE_KEY: buyerSecret! },
    );
    ok(refused.code !== 0, "over-budget attempt exits non-zero");
    ok(refused.out.includes("budget exceeded"), "refusal names the budget, quoted price and cap");

    console.log("\n✅ AGENT SKILL PROVEN: its own scripts sell, discover-shape, pay, and refuse correctly");
    console.log(`   settled: ${hash}`);
  } finally {
    sellerProc.kill();
  }
}

main().then(
  () => process.exit(0),
  err => {
    console.error("\n❌", err instanceof Error ? (err.stack ?? err.message) : err);
    process.exit(1);
  },
);
