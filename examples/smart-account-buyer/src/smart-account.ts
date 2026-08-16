/**
 * A direct-path smart-account (`C...`) buyer for Rail402.
 *
 * ## Why this helper exists
 *
 * The stock `@x402/stellar` client (2.20.0) signs authorization entries the classic-keypair way: it
 * calls `Keypair.fromPublicKey(payer)` and verifies an ed25519 signature. That path throws for a
 * `C...` address, so `payAndFetch` and the other `@x402` client helpers cannot yet pay from a smart
 * account. The upstream fix is x402-foundation/x402#3018, which forwards a custom `authorizeEntry`
 * so a contract account can supply its own structured signature. Once it merges and Rail402 bumps
 * `@x402/stellar`, the SDK's `stellarSigner` seam handles a `C...` account with no extra code.
 *
 * Until then, this helper does the payment the direct way, which the Rail402 facilitator settles
 * today: it builds the transfer, signs each authorization entry with the account's own
 * `__check_auth`, and posts the signed transaction to `/verify` then `/settle`. The facilitator is
 * address-agnostic, so a `C...` account settles through the same endpoints a keypair uses. Nothing
 * here is a workaround for a facilitator limitation; it is a buyer-side helper standing in for a
 * client feature that has not shipped upstream.
 *
 * The account model is OpenZeppelin's audited `__check_auth` account plus a session key and
 * Rail402's on-ledger spending policy. The cryptography and authorization stay audited; only the
 * budget arithmetic is Rail402's. See the `oz-account` canary for the full reference this is lifted
 * from, including the `upto` scheme.
 *
 * Testnet only.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  Address,
  Contract,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  authorizeEntry,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type { Transaction } from "@stellar/stellar-sdk";
import {
  NETWORK,
  OZ_ACCOUNT_WASM_HASH,
  OZ_ED25519_VERIFIER,
  RPC_URL,
  X402_POLICY,
} from "./constants.js";

const NETWORK_PASSPHRASE = Networks.TESTNET;
const server = new rpc.Server(RPC_URL);

/** Generous fee for the setup and simulation transactions; the facilitator pays the real one. */
const SETUP_FEE = "10000000";

/**
 * Authorization lifetime in ledgers. `scheme_exact_stellar` bounds it to
 * `currentLedger + ceil(maxTimeoutSeconds / ledgerSeconds)`, ~12 for a 60s timeout at 5s ledgers.
 * Signing a longer window is refused by the facilitator, correctly, since it is a larger replay
 * window.
 */
const MAX_TIMEOUT_SECONDS = 60;
const AUTH_LEDGERS = Math.ceil(MAX_TIMEOUT_SECONDS / 5);

// --- OpenZeppelin signer plumbing ------------------------------------------------------------

/**
 * OpenZeppelin binds the chosen context rules into the digest the signer authenticates:
 * `auth_digest = sha256(signature_payload || context_rule_ids.to_xdr())`. Signing the raw
 * `__check_auth` payload instead fails with `Error(Auth, InvalidAction)` — the single thing most
 * likely to cost an integrator a day.
 */
function authPayload(session: Keypair, payload: Buffer, ruleIds: number[]): xdr.ScVal {
  const ids = ruleIds.map(r => nativeToScVal(r, { type: "u32" }));
  const digest = createHash("sha256")
    .update(Buffer.concat([payload, Buffer.from(xdr.ScVal.scvVec(ids).toXDR())]))
    .digest();
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("context_rule_ids"), val: xdr.ScVal.scvVec(ids) }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("signers"),
      val: xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: signerScVal(session),
          val: xdr.ScVal.scvBytes(session.sign(digest)),
        }),
      ]),
    }),
  ]);
}

/** The signer descriptor OpenZeppelin stores: (External, verifier, session public key). */
const signerScVal = (session: Keypair): xdr.ScVal =>
  xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("External"),
    new Address(OZ_ED25519_VERIFIER).toScVal(),
    xdr.ScVal.scvBytes(session.rawPublicKey()),
  ]);

// --- transaction plumbing --------------------------------------------------------------------

/** Submit an operation the source account alone authorizes (deploy, mint, and the like). */
async function submit(source: Keypair, op: xdr.Operation): Promise<rpc.Api.GetTransactionResponse> {
  const account = await server.getAccount(source.publicKey());
  let tx = new TransactionBuilder(account, { fee: SETUP_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(op)
    .setTimeout(60)
    .build();
  tx = await server.prepareTransaction(tx);
  tx.sign(source);
  const sent = await server.sendTransaction(tx);
  return await confirmed(sent.hash);
}

async function confirmed(hash: string): Promise<rpc.Api.GetTransactionResponse> {
  let got = await server.getTransaction(hash);
  for (let i = 0; i < 40 && got.status === "NOT_FOUND"; i += 1) {
    await new Promise(r => setTimeout(r, 1000));
    got = await server.getTransaction(hash);
  }
  return got;
}

/**
 * Simulate a call the smart account must authorize, sign every authorization entry with the session
 * key, and return the transaction XDR carrying **signed auth entries but no source signature**. The
 * facilitator re-sources it, sponsors the fee, and submits, which is what lets the buyer hold no XLM.
 */
async function signAsAccount(args: {
  simSource: Keypair;
  account: string;
  session: Keypair;
  op: xdr.Operation;
  ruleIds: number[];
}): Promise<{ ok: true; xdr: string } | { ok: false; error: string }> {
  const { simSource, account, session, op, ruleIds } = args;
  const acct = await server.getAccount(simSource.publicKey());
  const tx = new TransactionBuilder(acct, { fee: SETUP_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(op)
    .setTimeout(60)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) return { ok: false, error: sim.error.split("\n")[0] ?? sim.error };

  const prepared = rpc.assembleTransaction(tx, sim).build();
  const op0 = prepared.operations[0] as Operation.InvokeHostFunction;
  const { sequence } = await server.getLatestLedger();
  const signed = await Promise.all(
    (op0.auth ?? []).map(entry =>
      authorizeEntry(
        entry,
        async (_preimage, payload) => ({
          signatureScVal: authPayload(session, Buffer.from(payload), ruleIds),
          address: account,
        }),
        sequence + AUTH_LEDGERS,
        NETWORK_PASSPHRASE,
      ),
    ),
  );

  const rebuilt = TransactionBuilder.cloneFrom(prepared)
    .clearOperations()
    .addOperation(Operation.invokeHostFunction({ func: op0.func, auth: signed }))
    .build();
  return { ok: true, xdr: rebuilt.toXDR() };
}

async function callFacilitator(
  base: string,
  path: "/verify" | "/settle",
  paymentPayload: unknown,
  paymentRequirements: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, body };
}

// --- public API ------------------------------------------------------------------------------

export interface SmartAccount {
  /** The `C...` contract address. */
  readonly address: string;
  /** The ed25519 session key scoped to payments. Keep it; it signs every payment. */
  readonly session: Keypair;
}

/**
 * Deploy an OpenZeppelin smart account with a fresh session key.
 *
 * The default (owner) rule carries **no** policy: the payment policy fails closed on any function
 * that is not a payment, so an account whose only rule carried it could never be configured.
 *
 * @param funder A funded testnet `G...` keypair. It pays the one-time deploy fee only; it is never
 *   the payment source.
 */
export async function deploySmartAccount(funder: Keypair): Promise<SmartAccount> {
  const session = Keypair.random();
  const res = await submit(
    funder,
    Operation.createCustomContract({
      address: new Address(funder.publicKey()),
      wasmHash: Buffer.from(OZ_ACCOUNT_WASM_HASH, "hex"),
      salt: randomBytes(32),
      constructorArgs: [xdr.ScVal.scvVec([signerScVal(session)]), xdr.ScVal.scvMap([])],
    }),
  );
  if (res.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error("Deploying the OpenZeppelin account failed.");
  }
  return { address: Address.fromScVal(res.returnValue!).toString(), session };
}

/**
 * Add a `CallContract(token)` context rule scoped to Rail402's spending policy, so the session key
 * may authorize `transfer` on that token up to the account's budget. Returns the assigned rule id.
 *
 * Adding a rule needs both the account's own authorization (via the session key) and submission by
 * a source account, so it is signed as the account and then resubmitted by the funder.
 *
 * @param periodLedgers Ledger window the rolling budget applies over.
 * @param spendingLimit Rolling spend ceiling the policy enforces, in atomic units.
 */
export async function addTokenRule(args: {
  funder: Keypair;
  account: SmartAccount;
  token: string;
  periodLedgers?: number;
  spendingLimit: bigint;
}): Promise<number> {
  const { funder, account, token } = args;
  const policyParams = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("period_ledgers"),
      val: nativeToScVal(args.periodLedgers ?? 100, { type: "u32" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("spending_limit"),
      val: nativeToScVal(args.spendingLimit.toString(), { type: "i128" }),
    }),
  ]);
  const policiesMap = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: new Address(X402_POLICY).toScVal(), val: policyParams }),
  ]);

  const signedRule = await signAsAccount({
    simSource: funder,
    account: account.address,
    session: account.session,
    ruleIds: [0],
    op: new Contract(account.address).call(
      "add_context_rule",
      xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("CallContract"), new Address(token).toScVal()]),
      nativeToScVal("token-payments", { type: "string" }),
      xdr.ScVal.scvVoid(),
      xdr.ScVal.scvVec([signerScVal(account.session)]),
      policiesMap,
    ),
  });
  if (!signedRule.ok) throw new Error(`Adding the token rule failed: ${signedRule.error}`);

  // Administration is not a payment, so it is submitted directly rather than through the facilitator.
  const acct = await server.getAccount(funder.publicKey());
  const carried = TransactionBuilder.fromXDR(signedRule.xdr, NETWORK_PASSPHRASE) as Transaction;
  const carriedOp = carried.operations[0] as Operation.InvokeHostFunction;
  const resend = new TransactionBuilder(acct, { fee: SETUP_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.invokeHostFunction({ func: carriedOp.func, auth: carriedOp.auth ?? [] }))
    .setTimeout(60)
    .build();
  const resim = await server.simulateTransaction(resend);
  if (rpc.Api.isSimulationError(resim)) throw new Error(`Adding the token rule failed: ${resim.error.split("\n")[0]}`);
  const ready = rpc.assembleTransaction(resend, resim).build();
  ready.sign(funder);
  const sent = await server.sendTransaction(ready);
  const done = await confirmed(sent.hash);
  if (done.status !== rpc.Api.GetTransactionStatus.SUCCESS) throw new Error("Adding the token rule did not succeed.");
  // Rule ids keep incrementing, so read the id the account assigned rather than assuming.
  return Number((scValToNative(done.returnValue!) as { id: number | bigint }).id);
}

export type PayResult =
  | { ok: true; transaction: string }
  | { ok: false; stage: "sign" | "verify" | "settle"; reason: string; code?: string };

/**
 * Pay an `exact` payment from a smart account through the facilitator's `/verify` and `/settle`
 * endpoints. Builds the `transfer(from = account, to = payTo, amount)` call, signs it with the
 * session key, and posts it. The facilitator sponsors the fee and submits.
 *
 * The payment requirements (`asset`, `payTo`, `amount`) come from the seller's 402 challenge. Fetch
 * the resource once without payment to read them, or take them from a Bazaar listing.
 */
export async function payFromSmartAccount(args: {
  facilitatorUrl: string;
  /** A funded `G...` keypair used only to simulate and build. It is never the payment source. */
  simSource: Keypair;
  account: SmartAccount;
  /** The rule id returned by {@link addTokenRule}. */
  tokenRuleId: number;
  /** The SAC contract id from the challenge's `accepts.asset`. */
  token: string;
  /** The seller's `G...` address from `accepts.payTo`. */
  payTo: string;
  /** Atomic units, as a string or bigint. */
  amount: bigint | string;
  network?: string;
}): Promise<PayResult> {
  const { facilitatorUrl, simSource, account, tokenRuleId, token, payTo } = args;
  const amount = BigInt(args.amount).toString();
  const network = args.network ?? NETWORK;

  const built = await signAsAccount({
    simSource,
    account: account.address,
    session: account.session,
    ruleIds: [tokenRuleId],
    op: new Contract(token).call(
      "transfer",
      new Address(account.address).toScVal(),
      new Address(payTo).toScVal(),
      nativeToScVal(amount, { type: "i128" }),
    ),
  });
  if (!built.ok) return { ok: false, stage: "sign", reason: built.error };

  const paymentPayload = {
    x402Version: 2,
    accepted: { scheme: "exact", network },
    payload: { transaction: built.xdr },
  };
  const requirements = {
    scheme: "exact",
    network,
    amount,
    asset: token,
    payTo,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: { areFeesSponsored: true },
  };

  const verified = await callFacilitator(facilitatorUrl, "/verify", paymentPayload, requirements);
  const vb = verified.body as { isValid?: boolean; invalidReason?: string; invalidMessage?: string };
  if (!vb.isValid) {
    return {
      ok: false,
      stage: "verify",
      reason: vb.invalidMessage ?? "verification failed",
      ...(vb.invalidReason ? { code: vb.invalidReason } : {}),
    };
  }

  const settled = await callFacilitator(facilitatorUrl, "/settle", paymentPayload, requirements);
  const sb = settled.body as { success?: boolean; transaction?: string; errorReason?: string; errorMessage?: string };
  if (!sb.success) {
    return {
      ok: false,
      stage: "settle",
      reason: sb.errorMessage ?? "settlement failed",
      ...(sb.errorReason ? { code: sb.errorReason } : {}),
    };
  }
  return { ok: true, transaction: sb.transaction! };
}
