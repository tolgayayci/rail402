#!/usr/bin/env node
/**
 * An x402 buyer on Stellar testnet: optionally search the Bazaar, then pay a resource with the
 * STOCK client (@x402/fetch + x402Client + @x402/stellar) under a HARD spend cap, and print the
 * on-ledger receipt.
 *
 * Usage:
 *   node buyer-starter.mjs --query "convert currency"                 # search only
 *   node buyer-starter.mjs --url "https://…/lookup?q=hi" --budget 0.10   # pay (budget REQUIRED)
 * Needs:
 *   npm i @x402/core@2.20.0 @x402/fetch@2.20.0 @x402/stellar@2.20.0
 *   export CLIENT_STELLAR_PRIVATE_KEY=S…   (make-wallet.mjs mints a funded one)
 *
 * The spend cap is enforced in the payment client's requirements SELECTOR — the code path that
 * runs on the request actually being paid, immediately before signing. Enforcing it against an
 * earlier unpaid quote instead is a known vulnerability (a seller can quote cheap on the probe
 * and expensive on the paid request).
 */
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { createEd25519Signer, ExactStellarScheme } from "@x402/stellar";

const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "https://facilitator.rail402.dev";

const arg = name => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

const query = arg("query");
if (query) {
  const res = await fetch(`${FACILITATOR_URL}/discovery/search?query=${encodeURIComponent(query)}`);
  const { resources = [] } = await res.json();
  if (resources.length === 0) console.log("No resources matched.");
  for (const r of resources.slice(0, 5)) {
    const opt = (r.accepts ?? [])[0] ?? {};
    console.log(`- ${r.resource}`);
    console.log(`    ${r.metadata?.description ?? r.description ?? "(no description)"}`);
    console.log(`    ${opt.scheme} on ${opt.network}, ${Number(opt.amount ?? 0) / 1e7} USDC → ${opt.payTo}`);
  }
  if (!arg("url")) process.exit(0);
}

const url = arg("url");
const budgetDecimal = arg("budget");
if (!url || !budgetDecimal) {
  console.error('Usage: node buyer-starter.mjs --url "https://…" --budget 0.10   (budget is required — never pay uncapped)');
  process.exit(1);
}
const secret = process.env.CLIENT_STELLAR_PRIVATE_KEY;
if (!secret || !secret.startsWith("S")) {
  console.error("Export CLIENT_STELLAR_PRIVATE_KEY=S… (a funded testnet key — run make-wallet.mjs).");
  process.exit(1);
}

// 7-decimal integer math only. "0.10" USDC → 1000000n stroops. No floats near money.
const [whole = "0", frac = ""] = budgetDecimal.split(".");
const BUDGET_STROOPS = BigInt(whole + frac.padEnd(7, "0").slice(0, 7));

// The one correct enforcement point. Throwing here means NOTHING was signed and nothing spent.
// Note: @x402/fetch rethrows selector failures as a plain Error keeping only the message text —
// record anything you need to branch on in a closure variable before throwing.
let refusedQuote;
const budgetSelector = (_x402Version, requirements) => {
  const payable = requirements
    .filter(r => typeof r.network === "string" && r.network.startsWith("stellar:"))
    .filter(r => typeof r.amount === "string" && /^\d+$/.test(r.amount))
    .filter(r => r.extra?.areFeesSponsored === true) // stock clients cannot pay without sponsorship
    .filter(r => BigInt(r.amount) <= BUDGET_STROOPS)
    .sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? -1 : 1));
  if (payable.length === 0) {
    refusedQuote = requirements.map(r => r.amount).join(", ");
    throw new Error(`budget exceeded: quoted [${refusedQuote}] stroops, cap ${BUDGET_STROOPS}`);
  }
  return payable[0];
};

const signer = createEd25519Signer(secret, "stellar:testnet");
const client = new x402Client(budgetSelector);
client.register("stellar:*", new ExactStellarScheme(signer));
const paidFetch = wrapFetchWithPayment(fetch, client);

console.log(`paying ${url} (cap ${budgetDecimal} USDC)…`);
const res = await paidFetch(url);
if (!res.ok) {
  // Coded refusal: { code, reason, retryable }. Retry only when retryable is true.
  const body = await res.json().catch(() => ({}));
  console.error(`refused (HTTP ${res.status}) code=${body.code ?? "?"}: ${body.reason ?? body.error ?? "?"}`);
  process.exit(1);
}

const data = await res.json();
console.log("response:", JSON.stringify(data));

const receiptHeader = res.headers.get("PAYMENT-RESPONSE");
if (receiptHeader) {
  const receipt = decodePaymentResponseHeader(receiptHeader);
  console.log(`settled on-ledger: ${receipt.transaction}`);
  console.log(`  https://stellar.expert/explorer/testnet/tx/${receipt.transaction}`);
  console.log(`  x402 receipt: POST https://playground-api-production-5062.up.railway.app/debug/tx {"hash":"${receipt.transaction}"}`);
}
