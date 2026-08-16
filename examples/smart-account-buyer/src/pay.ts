/**
 * Runnable demo: deploy an OpenZeppelin smart account, fund it, and pay a seller from the `C...`
 * address through the Rail402 facilitator.
 *
 * ```
 * pnpm --filter @rail402.dev/example-smart-account-buyer pay
 * ```
 *
 * It is self-contained: it issues its own testnet asset and funds every account from friendbot, so
 * it needs no faucet and no pre-funded secret. Set `FACILITATOR_URL` to point at your own
 * facilitator; it defaults to the hosted testnet one.
 *
 * The seller side is deliberately just a keypair with a trustline. The direct payment path posts the
 * payment requirements straight to `/verify` and `/settle`, so no seller HTTP server is needed to
 * prove that a smart account settles. For the full discover-then-pay shape against a live paywall,
 * pair this account with the `paid-api-agent` example once `@x402/stellar` supports `C...` signing.
 */

import {
  Asset,
  Contract,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  Address,
  nativeToScVal,
  rpc,
} from "@stellar/stellar-sdk";
import type { xdr } from "@stellar/stellar-sdk";
import { HORIZON_URL, RPC_URL } from "./constants.js";
import { addTokenRule, deploySmartAccount, payFromSmartAccount } from "./smart-account.js";

const NETWORK_PASSPHRASE = Networks.TESTNET;
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "https://facilitator.rail402.dev";
const server = new rpc.Server(RPC_URL);

/** 0.5 of the asset, atomic units at 7 decimals. */
const PAYMENT = 5_000_000n;
/** Rolling spend ceiling the on-ledger policy enforces. */
const SPENDING_LIMIT = 50_000_000n;

async function friendbotFund(kp: Keypair): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    if (attempt > 0) await sleep(2500);
    const res = await fetch(`${HORIZON_URL}/friendbot?addr=${kp.publicKey()}`).catch(() => null);
    if (res?.ok || res?.status === 400) break;
    if (attempt === 7) throw new Error(`Friendbot could not fund ${kp.publicKey()}`);
  }
  for (let attempt = 0; attempt < 25; attempt++) {
    const visible = await server.getAccount(kp.publicKey()).then(() => true).catch(() => false);
    if (visible) return;
    await sleep(1000);
  }
  throw new Error(`${kp.publicKey()} never appeared on the Soroban RPC.`);
}

async function submitClassic(kp: Keypair, op: xdr.Operation): Promise<void> {
  const account = await server.getAccount(kp.publicKey());
  const tx = new TransactionBuilder(account, { fee: "1000000", networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(op)
    .setTimeout(60)
    .build();
  tx.sign(kp);
  const sent = await server.sendTransaction(tx);
  await confirm(sent.hash);
}

async function submitSoroban(kp: Keypair, op: xdr.Operation): Promise<void> {
  const account = await server.getAccount(kp.publicKey());
  let tx = new TransactionBuilder(account, { fee: "10000000", networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(op)
    .setTimeout(60)
    .build();
  tx = await server.prepareTransaction(tx);
  tx.sign(kp);
  const sent = await server.sendTransaction(tx);
  await confirm(sent.hash);
}

async function confirm(hash: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const got = await server.getTransaction(hash).catch(() => null);
    if (got?.status === "SUCCESS") return;
    if (got?.status === "FAILED") throw new Error(`Setup tx ${hash} failed on-ledger.`);
    await sleep(1000);
  }
  throw new Error(`Setup tx ${hash} did not confirm.`);
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function main(): Promise<void> {
  const code = `SA${Math.floor(Date.now() / 1000).toString(36).slice(-5).toUpperCase()}`;
  console.log(`Facilitator: ${FACILITATOR_URL}`);
  console.log(`Asset code:  ${code}\n`);

  // 1. Fixtures: an issuer that mints the asset, and a seller with a trustline.
  const issuer = Keypair.random();
  const seller = Keypair.random();
  console.log("Funding issuer and seller from friendbot...");
  await friendbotFund(issuer);
  await friendbotFund(seller);

  const asset = new Asset(code, issuer.publicKey());
  const token = asset.contractId(NETWORK_PASSPHRASE);
  console.log("Deploying the asset contract (SAC)...");
  await submitSoroban(issuer, Operation.createStellarAssetContract({ asset }));
  await submitClassic(seller, Operation.changeTrust({ asset }));

  // 2. Deploy the smart account (the issuer pays the one-time deploy fee here).
  console.log("Deploying the OpenZeppelin smart account...");
  const account = await deploySmartAccount(issuer);
  console.log(`  account:  ${account.address}`);
  console.log(`  session:  ${account.session.publicKey()}`);

  // 3. Fund the smart account by minting the asset to it (a contract account needs no trustline).
  console.log("Minting the asset to the smart account...");
  await submitSoroban(
    issuer,
    new Contract(token).call(
      "mint",
      new Address(account.address).toScVal(),
      nativeToScVal((SPENDING_LIMIT * 2n).toString(), { type: "i128" }),
    ),
  );

  // 4. Scope the session key to pay this token, under the policy's budget.
  console.log("Adding the token payment rule (scoped to the spending policy)...");
  const tokenRuleId = await addTokenRule({ funder: issuer, account, token, spendingLimit: SPENDING_LIMIT });
  console.log(`  rule id:  ${tokenRuleId}\n`);

  // 5. Pay the seller from the C-account, through the facilitator.
  console.log(`Paying ${PAYMENT} to ${seller.publicKey().slice(0, 8)}... from the smart account...`);
  const result = await payFromSmartAccount({
    facilitatorUrl: FACILITATOR_URL,
    simSource: issuer,
    account,
    tokenRuleId,
    token,
    payTo: seller.publicKey(),
    amount: PAYMENT,
  });

  if (!result.ok) {
    console.error(`\nPayment refused at ${result.stage}: ${result.reason}${result.code ? ` (${result.code})` : ""}`);
    process.exit(1);
  }

  console.log(`\nSettled from the smart account.`);
  console.log(`  tx:       ${result.transaction}`);
  console.log(`  explorer: https://stellar.expert/explorer/testnet/tx/${result.transaction}`);
  console.log(`\nThe payment source on-ledger is the C-account, and the fee is charged to the`);
  console.log(`facilitator: sponsored and non-custodial, from a smart contract wallet.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
