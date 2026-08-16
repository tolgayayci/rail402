#!/usr/bin/env node
/**
 * Create a funded Stellar TESTNET wallet ready for x402:
 * keypair → friendbot XLM → USDC trustline → test-USDC drip from the Rail402 playground dispenser.
 *
 * Usage:  node make-wallet.mjs [--no-drip]
 * Needs:  npm i @stellar/stellar-sdk   (nothing else)
 *
 * The printed S… secret is a TESTNET key holding test funds only. Never reuse it for real value.
 */
import {
  Keypair,
  Horizon,
  TransactionBuilder,
  Networks,
  Operation,
  Asset,
  BASE_FEE,
} from "@stellar/stellar-sdk";

const HORIZON = "https://horizon-testnet.stellar.org";
const FRIENDBOT = "https://friendbot.stellar.org";
const PLAYGROUND = process.env.PLAYGROUND_URL ?? "https://playground-api-production-5062.up.railway.app";
// Canonical testnet USDC issuer — the same asset the Rail402 facilitator settles by default.
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

const pair = Keypair.random();
console.log(`address: ${pair.publicKey()}`);

// 1 — XLM via friendbot. Needed only for the trustline reserve; x402 payments themselves are
// fee-sponsored by the facilitator, so paying needs no XLM at all.
const fb = await fetch(`${FRIENDBOT}?addr=${encodeURIComponent(pair.publicKey())}`);
if (!fb.ok) throw new Error(`friendbot answered HTTP ${fb.status} — testnet may be congested; retry`);
console.log("funded with test XLM (friendbot)");

// 2 — USDC trustline. A Stellar account cannot HOLD an asset until it opens a trustline to it;
// without this the dispenser (and any payer) cannot send USDC here.
const horizon = new Horizon.Server(HORIZON);
const account = await horizon.loadAccount(pair.publicKey());
const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
  .addOperation(Operation.changeTrust({ asset: new Asset("USDC", USDC_ISSUER) }))
  .setTimeout(60)
  .build();
tx.sign(pair);
await horizon.submitTransaction(tx);
console.log("USDC trustline open");

// 3 — test USDC from the playground dispenser (rate-limited per IP and per account; a refusal
// carries a machine-readable { code, reason, retryable }).
if (!process.argv.includes("--no-drip")) {
  const res = await fetch(`${PLAYGROUND}/session/fund`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: pair.publicKey() }),
  });
  const body = await res.json();
  if (res.ok) console.log(`dripped ${Number(body.amountStroops) / 1e7} USDC (tx ${body.hash})`);
  else console.log(`drip refused (${body.code}): ${body.reason}`);
}

console.log(`\nsecret: ${pair.secret()}`);
console.log("        ^ TESTNET ONLY. Export as CLIENT_STELLAR_PRIVATE_KEY to pay, or use the");
console.log("          address as SELLER_ADDRESS to receive.");
