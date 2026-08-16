import { createHash, randomBytes } from "node:crypto";
import {
  Address,
  Contract,
  Keypair,
  Operation,
  TransactionBuilder,
  authorizeEntry,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type { Transaction } from "@stellar/stellar-sdk";
import { X402Error } from "@rail402.dev/errors";
import { CanaryRun, type CanaryReport } from "./report.js";
import { NETWORK, NETWORK_PASSPHRASE, RPC_URL, prepareFixtures } from "./testnet.js";
import { callFacilitator } from "./payment.js";
import { assetCodeFor } from "./discovery-loop.js";

/**
 * C-5 — an **OpenZeppelin smart account** pays with both schemes, bounded by a policy we wrote.
 *
 * ## Why this exists alongside the `smart-account` canary
 *
 * `smart-account` proves the facilitator accepts a `__check_auth` payer using our own minimal
 * account. This one proves the production shape: OpenZeppelin's *audited* account and verifier
 * carrying an x402-aware spending policy, which is the only part we own. Their reference
 * `spending_limit` policy cannot serve x402 — it matches `transfer` only and refuses `settle` and
 * `approve` outright — so a custom policy is required, and OZ documents that as a first-class
 * option rather than a workaround.
 *
 * ## The two-rule layout
 *
 * An `upto` payment produces two authorization contexts, and OpenZeppelin requires exactly one
 * context rule per context. So the account carries:
 *
 * | rule | context type | policy | purpose |
 * |---|---|---|---|
 * | 0 | `Default` | **none** | owner administration |
 * | n | `CallContract(uptoContract)` | x402 policy | authorizes `settle` |
 * | n+1 | `CallContract(token)` | x402 policy | authorizes `transfer` and the `approve` sub-call |
 *
 * The administration rule deliberately carries **no** policy. The payment policy fails closed on
 * any function that is not a payment, so an account whose only rule carried it could never call
 * `add_context_rule` and could never be configured. Found by running it, not by reading.
 *
 * `context_type` is what pins the agent key to those contracts, so no policy is needed for scoping.
 */

/** Ledger window the rolling budget applies over. Small, so a canary run is self-contained. */
const PERIOD_LEDGERS = 100;
/** Rolling spend ceiling the policy enforces. */
const SPENDING_LIMIT = 5_000_000n;
/** Inside the budget. */
const PAYMENT = 1_000_000n;
/** `upto` ceiling; the settled amount is deliberately lower, which is the point of the scheme. */
const UPTO_CEILING = 2_000_000n;
const UPTO_ACTUAL = 750_000n;
/**
 * A second `upto` whose ceiling only fits BECAUSE the first reconciled. After the first settles,
 * the settle rule has spent 750,000. This ceiling (4,000,000) brings the reconciled total to
 * 4,750,000 — inside the 5,000,000 limit — but at the un-reconciled ceiling it would be
 * 2,000,000 + 4,000,000 = 6,000,000, past the limit, and be refused. So this payment succeeding is
 * proof that `release()` freed the budget. The Rust suite proves the negative control in-VM
 * (`without_reconciliation_the_ceiling_blocks_the_second_payment`).
 */
const FREED_CEILING = 4_000_000n;
const FREED_ACTUAL = 500_000n;
/** Past the rolling limit once the earlier payments are counted. */
const OVER_BUDGET = 9_000_000n;
/** Payment terms every step quotes. */
const MAX_TIMEOUT_SECONDS = 60;
/**
 * Authorization lifetime in ledgers.
 *
 * `scheme_exact_stellar` bounds it to `currentLedger + ceil(maxTimeoutSeconds / ledgerSeconds)`,
 * which at ~5s ledgers is 12 for a 60s timeout. Signing a longer window is refused by the
 * facilitator with `invalid_exact_stellar_signature_expiration_too_far` — correctly, since a
 * longer-lived authorization is a larger window for replay.
 */
const AUTH_LEDGERS = Math.ceil(MAX_TIMEOUT_SECONDS / 5);

const server = new rpc.Server(RPC_URL);

const setupFailure = (reason: string, details?: Record<string, unknown>): X402Error =>
  new X402Error("canary_setup_failed", { reason, ...(details ? { details } : {}) });

export interface OzAccountOptions {
  readonly facilitatorUrl: string;
  readonly runId: string;
  /** Uploaded wasm hash of OpenZeppelin's smart account. */
  readonly accountWasmHash: string;
  /** Deployed OpenZeppelin ed25519 verifier, shared by every account. */
  readonly verifier: string;
  /** Deployed x402 policy, shared by every account. */
  readonly policy: string;
  /** Deployed `upto` settlement contract. */
  readonly uptoContract: string;
}

/**
 * OpenZeppelin binds the chosen rules into the digest a signer authenticates:
 * `auth_digest = sha256(signature_payload || context_rule_ids.to_xdr())`.
 *
 * Signing the raw `__check_auth` payload — which is what our own account expects — fails with
 * `Error(Auth, InvalidAction)`. This is the sharpest difference between the two designs and the
 * thing most likely to cost an integrator a day.
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
          key: signerScVal(session, ""),
          val: xdr.ScVal.scvBytes(session.sign(digest)),
        }),
      ]),
    }),
  ]);
}

let VERIFIER = "";
const signerScVal = (session: Keypair, verifier: string): xdr.ScVal =>
  xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("External"),
    new Address(verifier || VERIFIER).toScVal(),
    xdr.ScVal.scvBytes(session.rawPublicKey()),
  ]);

/** Submit an operation the source account alone authorizes. */
async function submit(source: Keypair, op: xdr.Operation): Promise<rpc.Api.GetTransactionResponse> {
  const account = await server.getAccount(source.publicKey());
  let tx = new TransactionBuilder(account, {
    fee: "10000000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(60)
    .build();
  tx = await server.prepareTransaction(tx);
  tx.sign(source);
  const sent = await server.sendTransaction(tx);
  return await settled(sent.hash);
}

async function settled(hash: string): Promise<rpc.Api.GetTransactionResponse> {
  let got = await server.getTransaction(hash);
  for (let i = 0; i < 40 && got.status === "NOT_FOUND"; i += 1) {
    await new Promise(r => setTimeout(r, 1000));
    got = await server.getTransaction(hash);
  }
  return got;
}

interface SmartAccountCall {
  readonly source: Keypair;
  readonly account: string;
  readonly session: Keypair;
  readonly op: xdr.Operation;
  readonly ruleIds: number[];
}

/**
 * Run a call the smart account must authorize.
 *
 * Simulate to discover the authorization tree, sign every entry, then **re-cost against a
 * simulation of the signed transaction**: signed entries are larger than the unsigned ones the
 * first simulation priced, and submitting without re-costing fails at the network.
 */
async function signAsAccount(
  args: SmartAccountCall,
): Promise<{ ok: true; xdr: string } | { ok: false; error: string }> {
  const { source, account, session, op, ruleIds } = args;
  const acct = await server.getAccount(source.publicKey());
  const tx = new TransactionBuilder(acct, {
    fee: "10000000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
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

  // Hand the facilitator a transaction carrying signed AUTH ENTRIES but no source signature. It
  // rebuilds with itself as source, re-simulates, and pays the fee — which is what makes the buyer
  // need no XLM. Re-costing here would be wasted work and would fight the facilitator's own
  // assembly.
  const rebuilt = TransactionBuilder.cloneFrom(prepared)
    .clearOperations()
    .addOperation(Operation.invokeHostFunction({ func: op0.func, auth: signed }))
    .build();
  return { ok: true, xdr: rebuilt.toXDR() };
}

/** Submit a smart-account payment the way a real buyer does: through /verify then /settle. */
async function payThroughFacilitator(args: {
  readonly facilitatorUrl: string;
  readonly call: SmartAccountCall;
  readonly accepted: Record<string, unknown>;
  /**
   * `PaymentRequirements` for `/verify`. `scheme_upto` makes `amount` phase-dependent: at
   * verification it is the authorized **maximum**, so the facilitator can check the signature
   * against the ceiling the client actually signed.
   */
  readonly requirements: Record<string, unknown>;
  /**
   * `PaymentRequirements` for `/settle`, when it differs. For `upto` this carries the **actual**
   * metered charge, which the facilitator substitutes into the unsigned argument. Defaults to
   * `requirements`, which is right for `exact` where the amount never changes.
   */
  readonly settleRequirements?: Record<string, unknown>;
  readonly extraPayload?: Record<string, unknown>;
}): Promise<
  | { ok: true; transaction: string }
  | { ok: false; stage: "sign" | "verify" | "settle"; reason: string; code?: string }
> {
  const built = await signAsAccount(args.call);
  if (!built.ok) return { ok: false, stage: "sign", reason: built.error };

  const paymentPayload = {
    x402Version: 2,
    accepted: args.accepted,
    payload: { transaction: built.xdr, ...(args.extraPayload ?? {}) },
  };

  const verified = await callFacilitator(
    args.facilitatorUrl,
    "/verify",
    paymentPayload,
    args.requirements,
  );
  const vb = verified.body as { isValid?: boolean; invalidReason?: string; invalidMessage?: string };
  if (!vb.isValid) {
    return {
      ok: false,
      stage: "verify",
      reason: vb.invalidMessage ?? "verification failed",
      ...(vb.invalidReason ? { code: vb.invalidReason } : {}),
    };
  }

  const settled = await callFacilitator(
    args.facilitatorUrl,
    "/settle",
    paymentPayload,
    args.settleRequirements ?? args.requirements,
  );
  const sb = settled.body as {
    success?: boolean;
    transaction?: string;
    errorReason?: string;
    errorMessage?: string;
  };
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

export async function runOzAccount(options: OzAccountOptions): Promise<CanaryReport> {
  const { runId, accountWasmHash, verifier, policy, uptoContract } = options;
  VERIFIER = verifier;
  const run = new CanaryRun("oz-account", options.facilitatorUrl, runId);
  const session = Keypair.random();

  try {
    const fixtures = await run.step("testnet-fixtures", async () => {
      const f = await prepareFixtures(assetCodeFor(runId));
      return { detail: `asset ${f.assetCode} · seller ${f.seller.publicKey().slice(0, 8)}…`, f };
    });
    const { issuer, seller, assetContractId } = fixtures.f;

    const policyParams = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("period_ledgers"),
        val: nativeToScVal(PERIOD_LEDGERS, { type: "u32" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("spending_limit"),
        val: nativeToScVal(SPENDING_LIMIT.toString(), { type: "i128" }),
      }),
    ]);
    const policiesMap = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({ key: new Address(policy).toScVal(), val: policyParams }),
    ]);

    const account = await run.step("deploy-oz-account", async () => {
      // The default rule is the owner's, and carries NO policy — see the module comment.
      const res = await submit(
        issuer,
        Operation.createCustomContract({
          address: new Address(issuer.publicKey()),
          wasmHash: Buffer.from(accountWasmHash, "hex"),
          salt: randomBytes(32),
          constructorArgs: [
            xdr.ScVal.scvVec([signerScVal(session, verifier)]),
            xdr.ScVal.scvMap([]),
          ],
        }),
      );
      if (res.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
        throw setupFailure("Deploying the OpenZeppelin account failed.");
      }
      const address = Address.fromScVal(res.returnValue!).toString();
      return { detail: `${address.slice(0, 10)}… (admin rule carries no policy)`, address };
    });
    run.observe("accountAddress", account.address);
    run.observe("sessionKey", session.publicKey());

    await run.step("fund-smart-account", async () => {
      const res = await submit(
        issuer,
        new Contract(assetContractId).call(
          "mint",
          new Address(account.address).toScVal(),
          nativeToScVal((SPENDING_LIMIT * 4n).toString(), { type: "i128" }),
        ),
      );
      if (res.status !== "SUCCESS") throw setupFailure("Minting to the smart account failed.");
      return { detail: "asset minted to the contract account (no trustline required)" };
    });

    const addRule = async (target: string, name: string): Promise<number> => {
      const signedRule = await signAsAccount({
        source: issuer,
        account: account.address,
        session,
        ruleIds: [0],
        op: new Contract(account.address).call(
          "add_context_rule",
          xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("CallContract"), new Address(target).toScVal()]),
          nativeToScVal(name, { type: "string" }),
          xdr.ScVal.scvVoid(),
          xdr.ScVal.scvVec([signerScVal(session, verifier)]),
          policiesMap,
        ),
      });
      if (!signedRule.ok) throw setupFailure(`Adding the ${name} rule failed: ${signedRule.error}`);

      // Administration is not a payment, so it is submitted directly. The facilitator only accepts
      // x402 payment payloads, and pushing account management through it would misrepresent what
      // that endpoint is for.
      const acct = await server.getAccount(issuer.publicKey());
      const carried = TransactionBuilder.fromXDR(signedRule.xdr, NETWORK_PASSPHRASE) as Transaction;
      const carriedOp = carried.operations[0] as Operation.InvokeHostFunction;
      const resend = new TransactionBuilder(acct, {
        fee: "10000000",
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(
          Operation.invokeHostFunction({ func: carriedOp.func, auth: carriedOp.auth ?? [] }),
        )
        .setTimeout(60)
        .build();
      const resim = await server.simulateTransaction(resend);
      if (rpc.Api.isSimulationError(resim)) {
        throw setupFailure(`Adding the ${name} rule failed: ${resim.error.split("\n")[0]}`);
      }
      const ready = rpc.assembleTransaction(resend, resim).build();
      ready.sign(issuer);
      const sent = await server.sendTransaction(ready);
      const done = await settled(sent.hash);
      if (done.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
        throw setupFailure(`Adding the ${name} rule did not succeed.`);
      }
      // Rule ids keep incrementing, so read the id the account assigned rather than assuming.
      return Number((scValToNative(done.returnValue!) as { id: number | bigint }).id);
    };

    const rules = await run.step("two-rule-layout", async () => {
      const settleRule = await addRule(uptoContract, "upto-settle");
      const tokenRule = await addRule(assetContractId, "token-payments");
      return {
        detail: `rule ${settleRule} scopes settle, rule ${tokenRule} scopes the token`,
        settleRule,
        tokenRule,
      };
    });
    run.observe("settleRuleId", rules.settleRule);
    run.observe("tokenRuleId", rules.tokenRule);

    const exactAccepted = { scheme: "exact", network: NETWORK };
    const exactRequirements = {
      scheme: "exact",
      network: NETWORK,
      amount: PAYMENT.toString(),
      asset: assetContractId,
      payTo: seller.publicKey(),
      maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      extra: { areFeesSponsored: true },
    };

    const exact = await run.step("exact-payment", async () => {
      const res = await payThroughFacilitator({
        facilitatorUrl: options.facilitatorUrl,
        accepted: exactAccepted,
        requirements: exactRequirements,
        call: {
          source: issuer,
          account: account.address,
          session,
          ruleIds: [rules.tokenRule],
          op: new Contract(assetContractId).call(
            "transfer",
            new Address(account.address).toScVal(),
            new Address(seller.publicKey()).toScVal(),
            nativeToScVal(PAYMENT.toString(), { type: "i128" }),
          ),
        },
      });
      if (!res.ok) {
        throw setupFailure(`exact payment refused at ${res.stage}: ${res.reason}`, res.code ? { code: res.code } : {});
      }
      return {
        detail: `verified and settled ${PAYMENT} · tx ${res.transaction.slice(0, 8)}…`,
        hash: res.transaction,
      };
    });
    run.observe("exactTransaction", exact.hash);

    // One `upto` payment through /verify + /settle: authorize `ceiling`, meter `actual`. The hook is
    // our policy, so the settlement contract reconciles the reserved ceiling down to `actual`.
    const payUpto = (ceiling: bigint, actual: bigint) =>
      server.getLatestLedger().then(({ sequence }) => {
        const expirationLedger = sequence + AUTH_LEDGERS;
        const nonce = randomBytes(32);
        const uptoAccepted = {
          scheme: "upto",
          network: NETWORK,
          amount: ceiling.toString(),
          asset: assetContractId,
          payTo: seller.publicKey(),
          maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
          extra: { uptoContract, areFeesSponsored: true },
        };
        return payThroughFacilitator({
          facilitatorUrl: options.facilitatorUrl,
          accepted: uptoAccepted,
          // Verify against the signed ceiling, settle for the metered amount. Sending one figure to
          // both endpoints is refused, which is the phase-dependent `amount` rule doing its job.
          requirements: uptoAccepted,
          settleRequirements: { ...uptoAccepted, amount: actual.toString() },
          extraPayload: {
            maxAmount: ceiling.toString(),
            expirationLedger,
            nonce: nonce.toString("hex"),
          },
          call: {
            source: issuer,
            account: account.address,
            session,
            // Two contexts, one rule id each: settle on the upto contract, approve on the token.
            ruleIds: [rules.settleRule, rules.tokenRule],
            op: new Contract(uptoContract).call(
              "settle",
              new Address(assetContractId).toScVal(),
              new Address(account.address).toScVal(),
              new Address(seller.publicKey()).toScVal(),
              nativeToScVal(ceiling.toString(), { type: "i128" }),
              nativeToScVal(expirationLedger, { type: "u32" }),
              xdr.ScVal.scvBytes(nonce),
              // Signed with the ceiling here; the facilitator replaces it with the metered amount.
              nativeToScVal(ceiling.toString(), { type: "i128" }),
              // hook: our spending policy. After the transfer the contract calls the policy's release(),
              // which reconciles the budget from the reserved ceiling down to the metered amount.
              new Address(policy).toScVal(),
            ),
          },
        });
      });

    const upto = await run.step("upto-payment", async () => {
      const res = await payUpto(UPTO_CEILING, UPTO_ACTUAL);
      if (!res.ok) {
        throw setupFailure(`upto payment refused at ${res.stage}: ${res.reason}`, res.code ? { code: res.code } : {});
      }
      return {
        detail: `ceiling ${UPTO_CEILING}, settled ${UPTO_ACTUAL} · tx ${res.transaction.slice(0, 8)}…`,
        hash: res.transaction,
      };
    });
    run.observe("uptoTransaction", upto.hash);

    await run.step("policy-refuses-over-budget", async () => {
      const res = await payThroughFacilitator({
        facilitatorUrl: options.facilitatorUrl,
        accepted: exactAccepted,
        requirements: { ...exactRequirements, amount: OVER_BUDGET.toString() },
        call: {
          source: issuer,
          account: account.address,
          session,
          ruleIds: [rules.tokenRule],
          op: new Contract(assetContractId).call(
            "transfer",
            new Address(account.address).toScVal(),
            new Address(seller.publicKey()).toScVal(),
            nativeToScVal(OVER_BUDGET.toString(), { type: "i128" }),
          ),
        },
      });
      if (res.ok) {
        throw setupFailure("An over-budget payment settled; the policy did not hold.");
      }
      run.observe("overBudgetRefusedAt", res.stage);
      if (res.code) run.observe("overBudgetCode", res.code);
      // Refusing is necessary but not sufficient. A generic simulation failure tells an agent
      // nothing it can act on — it cannot tell "your wallet's budget said no" apart from "the
      // network is unwell". Routing through the facilitator is what makes the specific code
      // observable at all; direct submission only yields Error(Auth, InvalidAction).
      if (res.code !== "invalid_exact_stellar_payload_account_policy_refused") {
        throw setupFailure(
          `Refused, but with the unhelpful code ${res.code}. A smart wallet declining its own ` +
            `payment must be reported as such, or a buyer cannot distinguish it from an ` +
            `infrastructure failure.`,
          { code: res.code },
        );
      }
      // The identical rule, signer and token just settled a payment inside budget, so the amount is
      // the only thing that changed. The host reports a policy panic inside __check_auth as an auth
      // error rather than surfacing the contract code.
      return { detail: `refused at ${res.stage}: ${res.code ?? res.reason.slice(0, 50)}` };
    });

    const budgets = await run.step("budget-state", async () => {
      const read = async (ruleId: number): Promise<bigint> => {
        const res = await submit(
          issuer,
          new Contract(policy).call(
            "get_policy_data",
            nativeToScVal(ruleId, { type: "u32" }),
            new Address(account.address).toScVal(),
          ),
        );
        if (res.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
          throw setupFailure("Reading the policy budget failed.");
        }
        return (scValToNative(res.returnValue!) as { total_spent: bigint }).total_spent;
      };
      const settleSpent = await read(rules.settleRule);
      const tokenSpent = await read(rules.tokenRule);

      // Three invariants, all readable from the ledger rather than asserted in prose.
      //
      // 1. The budget reconciles to the metered amount, not the ceiling. At authorization the policy
      //    reserves the signed `max_amount`, because `actual_amount` is not covered by the client's
      //    signature and is unknown at that point. After the transfer the settlement contract calls
      //    the policy's `release`, which refunds the unspent difference so the budget reflects what
      //    was actually charged. Without that hook a 50-per-period cap would admit only 5 calls at a
      //    ceiling of 10 regardless of real usage; with it, a metered agent gets its true remaining
      //    budget back.
      if (settleSpent !== UPTO_ACTUAL) {
        throw setupFailure(
          `upto budgeted ${settleSpent}, expected the reconciled ${UPTO_ACTUAL}. Seeing the ` +
            `${UPTO_CEILING} ceiling here means the settlement hook did not call release; seeing the ` +
            `expiration ledger means the wrong argument index was budgeted.`,
        );
      }
      // 2. The `approve` sub-invocation is not counted a second time. It covers the same money as
      //    its parent `settle`, and counting both would halve the configured cap.
      if (tokenSpent !== PAYMENT) {
        throw setupFailure(
          `token rule budgeted ${tokenSpent}, expected only the ${PAYMENT} exact payment. A larger ` +
            `figure means the approve sub-invocation was double-counted.`,
        );
      }
      return {
        detail: `settle rule ${settleSpent} (reconciled to actual, from a ${UPTO_CEILING} ceiling), token rule ${tokenSpent} (exact only)`,
        settleSpent,
        tokenSpent,
      };
    });
    run.observe("settleRuleSpent", String(budgets.settleSpent));
    run.observe("tokenRuleSpent", String(budgets.tokenSpent));
    run.observe("uptoCeiling", String(UPTO_CEILING));
    run.observe("uptoActualSettled", String(UPTO_ACTUAL));
    run.observe("uptoBudgetReconciled", budgets.settleSpent === UPTO_ACTUAL ? "true" : "false");

    // The consequence that makes reconciliation worth having: a later payment the un-reconciled
    // ceiling would have blocked now fits. The settle rule has spent 750,000 (reconciled). A second
    // upto with a 4,000,000 ceiling brings the total to 4,750,000, inside the 5,000,000 limit — but
    // at the reserved 2,000,000 ceiling it would be 6,000,000 and be refused on-ledger by the policy.
    // So this payment succeeding is the on-ledger proof that release() freed the budget.
    const freed = await run.step("reconciliation-frees-later", async () => {
      const res = await payUpto(FREED_CEILING, FREED_ACTUAL);
      if (!res.ok) {
        throw setupFailure(
          `the freed-budget upto (ceiling ${FREED_CEILING}) was refused at ${res.stage}: ${res.reason}. ` +
            `At the un-reconciled ceiling it should be refused; being refused HERE means release() did ` +
            `not lower the first payment's reservation.`,
          res.code ? { code: res.code } : {},
        );
      }
      return {
        detail: `second upto ceiling ${FREED_CEILING} admitted after the first reconciled to ${UPTO_ACTUAL} · tx ${res.transaction.slice(0, 8)}…`,
        hash: res.transaction,
      };
    });
    run.observe("freedBudgetTransaction", freed.hash);
    run.observe("freedBudgetCeiling", String(FREED_CEILING));

    return run.finish();
  } catch (error) {
    return run.finish(error);
  }
}
