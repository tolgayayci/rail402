import { createHash } from "node:crypto";
import {
  Address,
  Contract,
  Operation,
  TransactionBuilder,
  authorizeEntry,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type { Transaction ,
  Keypair} from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASE } from "../config.js";

/**
 * OpenZeppelin smart-account orchestration for the Agents scene.
 *
 * This is a faithful port of the proven recipe in `packages/canary/src/oz-account.ts` — the same
 * OZ auth-digest binding, the same simulate → sign-auth-entries → hand-to-facilitator flow. It is
 * NOT reimplemented cryptography: the account, the ed25519 verifier and the digest scheme are
 * OpenZeppelin's; only the budget policy is ours. Kept here (rather than shared with the canary)
 * so the monitored nightly canary is untouched; the two copies should be reconciled into one
 * library once both can be live-verified together.
 *
 * Nothing here takes custody: the buyer signs authorization entries, the facilitator re-sources
 * and pays the fee, and a bad signature merely fails to settle.
 */

/** OpenZeppelin `multisig_account_example`, uploaded to testnet. Shared by every account. */
export const OZ_ACCOUNT_WASM_HASH =
  "c09cac4623692cd62f700c5703f5cf48988bdff74074baa702e0fc7e3355b24f";
/** OpenZeppelin ed25519 verifier. Stateless, immutable, shared. */
export const OZ_ED25519_VERIFIER = "CCC4DCEZYW2GLEF2JCASZASC34AH4VHR2KISPODRQDC6D37SBRFSLEWP";
/**
 * Our x402 spending policy (carries `release` for upto reconciliation, plus the `extend_ttl`
 * refresh from audit item S6). This is the CURRENT deployment, matching the canary's
 * `oz-constants.ts` and the `contracts/agent-policy` source; it supersedes the older
 * `CC34LRGI…` build, which lacked the TTL refresh.
 */
export const X402_POLICY = "CC3XJMYTTLQNDHOQHNQPQWLRIABQDUQBNJQKED7D67A3RMLGVQHF7LEC";

const MAX_TIMEOUT_SECONDS = 60;
const AUTH_LEDGERS = Math.ceil(MAX_TIMEOUT_SECONDS / 5);
/** Smart-account payments cross-call a verifier and a policy; the 100k default refuses them. */
const SETUP_FEE = "10000000";

export interface SmartAccountConfig {
  readonly server: rpc.Server;
  readonly verifier: string;
  readonly policy: string;
}

/** The external-ed25519 signer ScVal OZ expects for a session key. */
function signerScVal(session: Keypair, verifier: string): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("External"),
    new Address(verifier).toScVal(),
    xdr.ScVal.scvBytes(session.rawPublicKey()),
  ]);
}

/**
 * OZ binds the chosen context rules into the digest a signer authenticates:
 * `auth_digest = sha256(signature_payload || context_rule_ids.to_xdr())`. Signing the raw
 * `__check_auth` payload instead fails with `Error(Auth, InvalidAction)` — the single sharpest
 * OZ integration trap.
 */
function authPayload(session: Keypair, payload: Buffer, ruleIds: number[], verifier: string): xdr.ScVal {
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
          key: signerScVal(session, verifier),
          val: xdr.ScVal.scvBytes(session.sign(digest)),
        }),
      ]),
    }),
  ]);
}

async function settled(
  server: rpc.Server,
  hash: string,
): Promise<rpc.Api.GetTransactionResponse> {
  let got = await server.getTransaction(hash);
  for (let i = 0; i < 40 && got.status === "NOT_FOUND"; i += 1) {
    await new Promise(r => setTimeout(r, 1000));
    got = await server.getTransaction(hash);
  }
  return got;
}

/** Submit an operation the source account alone authorizes (deploy, mint, budget read). */
export async function submit(
  server: rpc.Server,
  source: Keypair,
  op: xdr.Operation,
): Promise<rpc.Api.GetTransactionResponse> {
  const account = await server.getAccount(source.publicKey());
  let tx = new TransactionBuilder(account, {
    fee: SETUP_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(60)
    .build();
  tx = await server.prepareTransaction(tx);
  tx.sign(source);
  const sent = await server.sendTransaction(tx);
  return settled(server, sent.hash);
}

export interface SmartAccountCall {
  readonly source: Keypair;
  readonly account: string;
  readonly session: Keypair;
  readonly op: xdr.Operation;
  readonly ruleIds: number[];
  /** The account's ed25519 verifier — bound into the signers map of the OZ auth digest. */
  readonly verifier: string;
}

/**
 * Sign a call the smart account must authorize.
 *
 * Simulate to discover the authorization tree, sign every entry with the session key over the OZ
 * digest, and return a transaction carrying signed AUTH ENTRIES but no source signature — the
 * facilitator re-sources it and pays the fee. Signed entries are larger than the unsigned ones the
 * first simulation priced, so the simulate-then-sign order matters.
 */
export async function signAsAccount(
  server: rpc.Server,
  args: SmartAccountCall,
): Promise<{ ok: true; xdr: string } | { ok: false; error: string }> {
  const { source, account, session, op, ruleIds, verifier } = args;
  const acct = await server.getAccount(source.publicKey());
  const tx = new TransactionBuilder(acct, {
    fee: SETUP_FEE,
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
          signatureScVal: authPayload(session, Buffer.from(payload as Uint8Array), ruleIds, verifier),
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

/** Add a scoped context rule carrying the spending policy with a budget. Returns the rule id. */
/**
 * Sign an account-authorized administration call (via the owner rule 0), then submit it directly —
 * NOT through the facilitator, because these are account management, not x402 payments. The session
 * key signs the auth the account requires; the funder sources the transaction and pays the fee.
 * Shared by `addPolicyRule` and `setSpendingLimit`.
 */
async function submitAsAccount(
  config: SmartAccountConfig,
  args: { source: Keypair; account: string; session: Keypair; op: xdr.Operation; label: string },
): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  const { server, verifier } = config;
  const signed = await signAsAccount(server, {
    source: args.source,
    account: args.account,
    session: args.session,
    ruleIds: [0],
    verifier,
    op: args.op,
  });
  if (!signed.ok) throw new Error(`${args.label} failed: ${signed.error}`);

  const acct = await server.getAccount(args.source.publicKey());
  const carried = TransactionBuilder.fromXDR(signed.xdr, NETWORK_PASSPHRASE) as Transaction;
  const carriedOp = carried.operations[0] as Operation.InvokeHostFunction;
  const resend = new TransactionBuilder(acct, { fee: SETUP_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(Operation.invokeHostFunction({ func: carriedOp.func, auth: carriedOp.auth ?? [] }))
    .setTimeout(60)
    .build();
  const resim = await server.simulateTransaction(resend);
  if (rpc.Api.isSimulationError(resim)) {
    throw new Error(`${args.label} failed: ${resim.error.split("\n")[0]}`);
  }
  const ready = rpc.assembleTransaction(resend, resim).build();
  ready.sign(args.source);
  const sent = await server.sendTransaction(ready);
  const done = await settled(server, sent.hash);
  if (done.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`${args.label} did not succeed.`);
  }
  return done;
}

/** Add a scoped context rule carrying the spending policy with a budget. Returns the rule id. */
export async function addPolicyRule(
  config: SmartAccountConfig,
  args: {
    source: Keypair;
    account: string;
    session: Keypair;
    target: string;
    name: string;
    budgetStroops: bigint;
    periodLedgers: number;
  },
): Promise<number> {
  const { verifier, policy } = config;
  const policyParams = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("period_ledgers"),
      val: nativeToScVal(args.periodLedgers, { type: "u32" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("spending_limit"),
      val: nativeToScVal(args.budgetStroops.toString(), { type: "i128" }),
    }),
  ]);
  const policiesMap = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: new Address(policy).toScVal(), val: policyParams }),
  ]);

  const done = await submitAsAccount(config, {
    source: args.source,
    account: args.account,
    session: args.session,
    label: `Adding the ${args.name} rule`,
    op: new Contract(args.account).call(
      "add_context_rule",
      xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("CallContract"), new Address(args.target).toScVal()]),
      nativeToScVal(args.name, { type: "string" }),
      xdr.ScVal.scvVoid(),
      xdr.ScVal.scvVec([signerScVal(args.session, verifier)]),
      policiesMap,
    ),
  });
  // Rule ids keep incrementing; read the id the account assigned rather than assuming.
  return Number((scValToNative(done.returnValue!) as { id: number | bigint }).id);
}

/**
 * Change a rule's spending limit on-ledger. The policy requires the SMART ACCOUNT's own
 * authorization (owner rule 0), so an agent holding only a scoped session key cannot raise its own
 * budget — that authority stays with the account owner. This is what makes "raise the budget and
 * retry" a real, on-ledger change in the lab, not a server-side fiction.
 */
export async function setSpendingLimit(
  config: SmartAccountConfig,
  args: {
    source: Keypair;
    account: string;
    session: Keypair;
    ruleId: number;
    spendingLimitStroops: bigint;
  },
): Promise<void> {
  await submitAsAccount(config, {
    source: args.source,
    account: args.account,
    session: args.session,
    label: "Changing the spending limit",
    op: new Contract(config.policy).call(
      "set_spending_limit",
      nativeToScVal(args.ruleId, { type: "u32" }),
      new Address(args.account).toScVal(),
      nativeToScVal(args.spendingLimitStroops.toString(), { type: "i128" }),
    ),
  });
}

/** Deploy a fresh OZ smart account whose only signer is `session`. Returns its C-address. */
export async function deployAccount(
  config: SmartAccountConfig,
  args: { source: Keypair; session: Keypair },
): Promise<string> {
  const res = await submit(
    config.server,
    args.source,
    Operation.createCustomContract({
      address: new Address(args.source.publicKey()),
      wasmHash: Buffer.from(OZ_ACCOUNT_WASM_HASH, "hex"),
      salt: randomSalt(),
      // constructor: signers vec (the session key), empty initial policies map (owner rule).
      constructorArgs: [xdr.ScVal.scvVec([signerScVal(args.session, config.verifier)]), xdr.ScVal.scvMap([])],
    }),
  );
  if (res.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error("Deploying the OpenZeppelin account failed.");
  }
  return Address.fromScVal(res.returnValue!).toString();
}

/**
 * Read a rule's committed spend from the on-ledger policy by SIMULATING `get_policy_data` — a
 * read-only call that returns the value without sending a transaction. Simulation (not `submit`)
 * matters here: `submit` consumes the source account's sequence number, so two reads in parallel
 * from the same funder collide; simulations send nothing and are safely concurrent, and they cost
 * no fee.
 */
export async function readBudgetSpent(
  config: SmartAccountConfig,
  args: { source: Keypair; account: string; ruleId: number },
): Promise<{ totalSpent: bigint; spendingLimit: bigint }> {
  const { server } = config;
  const source = await server.getAccount(args.source.publicKey());
  const tx = new TransactionBuilder(source, { fee: SETUP_FEE, networkPassphrase: NETWORK_PASSPHRASE })
    .addOperation(
      new Contract(config.policy).call(
        "get_policy_data",
        nativeToScVal(args.ruleId, { type: "u32" }),
        new Address(args.account).toScVal(),
      ),
    )
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim) || !sim.result) {
    throw new Error("Reading the policy budget failed.");
  }
  const data = scValToNative(sim.result.retval) as { total_spent: bigint; spending_limit: bigint };
  return { totalSpent: BigInt(data.total_spent), spendingLimit: BigInt(data.spending_limit) };
}

function randomSalt(): Buffer {
  const salt = new Uint8Array(32);
  globalThis.crypto.getRandomValues(salt);
  return Buffer.from(salt);
}
