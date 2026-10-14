import { randomBytes } from "node:crypto";
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Operation,
  TransactionBuilder,
  authorizeEntry,
  hash,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type { LocalNetwork } from "./network.ts";
import {
  addressCredentialsOf,
  deployContract,
  entrySignaturePayload,
  fixtureWasm,
  type EntrySigner,
} from "./upto.ts";

/**
 * OpenZeppelin smart accounts (`stellar-accounts`) on a local network, from the committed fixtures:
 * the multisig account example, its ed25519 verifier, and the approve-aware spending-limit policy
 * (see fixtures/README.md). Signers are `External(verifier, ed25519 public key)`.
 *
 * An account's `__check_auth` receives an `AuthPayload { context_rule_ids, signers }`: one rule id per
 * authorized context, in the order the host passes the contexts, and each signer's signature over
 * `sha256(signature_payload ‖ xdr(context_rule_ids))`, which binds the rule selection to the signature.
 * A `Delegated(address)` signer signs nothing in the payload: the account calls
 * `address.require_auth_for_args((auth_digest,))`, so the transaction must also carry that address's own
 * authorization entry for the account's `__check_auth` with the digest as its argument.
 */

/** The rule every account starts with: `Default` context, the owner key, no policy. */
export const OZ_DEFAULT_RULE = 0;

/** A deployed smart account and the verifier its signers use. */
export interface OzSmartAccount {
  readonly address: string;
  readonly verifier: string;
  /** The key of rule 0 (`Default`). */
  readonly owner: Keypair;
}

/** Where a context rule applies. */
export type OzContext =
  { readonly kind: "default" } | { readonly kind: "callContract"; readonly contract: string };

/** `Signer::External(verifier, public_key)` as a contract value. */
export function ozSigner(verifier: string, key: Keypair): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("External"),
    nativeToScVal(verifier, { type: "address" }),
    xdr.ScVal.scvBytes(key.rawPublicKey()),
  ]);
}

/** `Signer::Delegated(address)` as a contract value. */
export function ozDelegatedSigner(address: string): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Delegated"), nativeToScVal(address, { type: "address" })]);
}

/**
 * The digest an account's signers sign: `sha256(signature_payload ‖ xdr(context_rule_ids))`, where
 * `signature_payload` is the entry's SorobanAuthorization payload hash.
 */
export function ozAuthDigest(payload: Buffer, contextRuleIds: readonly number[]): Buffer {
  return hash(Buffer.concat([payload, ruleIdsScVal(contextRuleIds).toXDR()]));
}

/**
 * Signs a smart account's entry with one key, selecting `contextRuleIds` (one per context the host
 * authorizes, e.g. `[settle rule, approve rule]` for an upto payment). The signature is the
 * `AuthPayload` map the account's `__check_auth` decodes.
 */
export function ozSmartAccountSigner(options: {
  readonly verifier: string;
  readonly key: Keypair;
  readonly contextRuleIds: readonly number[];
}): EntrySigner {
  return (entry, passphrase) => {
    const signed = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR());
    const digest = ozAuthDigest(entrySignaturePayload(signed, passphrase), options.contextRuleIds);
    addressCredentialsOf(signed).signature(
      xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("context_rule_ids"),
          val: ruleIdsScVal(options.contextRuleIds),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("signers"),
          val: xdr.ScVal.scvMap([
            new xdr.ScMapEntry({
              key: ozSigner(options.verifier, options.key),
              val: xdr.ScVal.scvBytes(options.key.sign(digest)),
            }),
          ]),
        }),
      ]),
    );
    return Promise.resolve(signed);
  };
}

/** A smart account's entry signed through a delegated signer, and the delegate's own entry it requires. */
export interface OzDelegatedAuthorization {
  readonly authorization: xdr.SorobanAuthorizationEntry;
  readonly signerAuthorizations: readonly xdr.SorobanAuthorizationEntry[];
}

/**
 * Signs a smart account's entry through `Signer::Delegated(delegate)`, selecting `contextRuleIds`.
 * The account's entry carries an `AuthPayload` naming the delegate (with empty signature data), and
 * the delegate, a `G…` account, signs its own entry authorizing `__check_auth(auth_digest)` of the
 * account, with a fresh nonce and the account entry's expiration ledger. `signedBy` signs the
 * delegate's entry in place of the delegate (a forgery, for tests).
 */
export function ozDelegatedAuthorizer(options: {
  readonly account: string;
  readonly delegate: Keypair;
  readonly contextRuleIds: readonly number[];
  readonly signedBy?: Keypair;
}): (entry: xdr.SorobanAuthorizationEntry, passphrase: string) => Promise<OzDelegatedAuthorization> {
  return async (entry, passphrase) => {
    const signed = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR());
    const credentials = addressCredentialsOf(signed);
    const digest = ozAuthDigest(entrySignaturePayload(signed, passphrase), options.contextRuleIds);
    credentials.signature(
      xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("context_rule_ids"),
          val: ruleIdsScVal(options.contextRuleIds),
        }),
        new xdr.ScMapEntry({
          key: xdr.ScVal.scvSymbol("signers"),
          val: xdr.ScVal.scvMap([
            new xdr.ScMapEntry({
              key: ozDelegatedSigner(options.delegate.publicKey()),
              val: xdr.ScVal.scvBytes(Buffer.alloc(0)),
            }),
          ]),
        }),
      ]),
    );
    const expiration = credentials.signatureExpirationLedger();
    const unsigned = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: Address.fromString(options.delegate.publicKey()).toScAddress(),
          nonce: xdr.Int64.fromString(randomNonce().toString()),
          signatureExpirationLedger: expiration,
          signature: xdr.ScVal.scvVoid(),
        }),
      ),
      rootInvocation: new xdr.SorobanAuthorizedInvocation({
        function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
          new xdr.InvokeContractArgs({
            contractAddress: Address.fromString(options.account).toScAddress(),
            functionName: "__check_auth",
            args: [xdr.ScVal.scvBytes(digest)],
          }),
        ),
        subInvocations: [],
      }),
    });
    const delegateEntry = await authorizeEntry(
      unsigned,
      options.signedBy ?? options.delegate,
      expiration,
      passphrase,
    );
    return { authorization: signed, signerAuthorizations: [delegateEntry] };
  };
}

/**
 * Deploys a verifier and a smart account whose rule 0 lets `owner` authorize anything, from
 * `deployer` (funded by the caller).
 */
export async function deployOzSmartAccount(
  network: LocalNetwork,
  deployer: Keypair,
  owner: Keypair,
): Promise<OzSmartAccount> {
  const verifier = await deployContract(network, deployer, fixtureWasm("oz_ed25519_verifier.wasm"));
  const address = await deployContract(network, deployer, fixtureWasm("oz_smart_account.wasm"), [
    xdr.ScVal.scvVec([ozSigner(verifier, owner)]),
    xdr.ScVal.scvMap([]),
  ]);
  return { address, verifier, owner };
}

/** Deploys the approve-aware spending-limit policy; one instance serves any number of accounts. */
export function deploySpendingLimitPolicy(network: LocalNetwork, deployer: Keypair): Promise<string> {
  return deployContract(network, deployer, fixtureWasm("approve_spending_limit.wasm"));
}

/** Installation parameters of the spending-limit policy. */
export function spendingLimitParams(options: {
  readonly spendingLimit: bigint;
  readonly periodLedgers: number;
  readonly spenders?: readonly string[];
}): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("period_ledgers"),
      val: xdr.ScVal.scvU32(options.periodLedgers),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("spenders"),
      val: xdr.ScVal.scvVec(
        (options.spenders ?? []).map((spender) => nativeToScVal(spender, { type: "address" })),
      ),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("spending_limit"),
      val: nativeToScVal(options.spendingLimit, { type: "i128" }),
    }),
  ]);
}

/**
 * Adds a context rule for `signers` (keys checked by the account's verifier) with `policies`
 * (policy address → installation parameters), authorized by the owner through rule 0 and submitted
 * by `submitter`. Returns the new rule's id.
 */
export async function addOzContextRule(
  network: LocalNetwork,
  account: OzSmartAccount,
  options: {
    readonly submitter: Keypair;
    readonly context: OzContext;
    readonly name: string;
    readonly signers: readonly Keypair[];
    /** `Signer::Delegated` addresses, added after `signers`. */
    readonly delegates?: readonly string[];
    readonly policies?: ReadonlyMap<string, xdr.ScVal>;
  },
): Promise<number> {
  const policies = [...(options.policies ?? new Map<string, xdr.ScVal>())]
    .sort(([a], [b]) => compareAddresses(a, b))
    .map(
      ([policy, params]) =>
        new xdr.ScMapEntry({ key: nativeToScVal(policy, { type: "address" }), val: params }),
    );
  const call = new Contract(account.address).call(
    "add_context_rule",
    contextScVal(options.context),
    nativeToScVal(options.name, { type: "string" }),
    xdr.ScVal.scvVoid(),
    xdr.ScVal.scvVec([
      ...options.signers.map((key) => ozSigner(account.verifier, key)),
      ...(options.delegates ?? []).map(ozDelegatedSigner),
    ]),
    xdr.ScVal.scvMap(policies),
  );
  const result = await invokeAsAccount(network, account, options.submitter, call);
  return (scValToNative(result) as { id: number }).id;
}

/**
 * Removes context rule `id` from the account, authorized by the owner through rule 0 and submitted by
 * `submitter` straight to the network. A payment already signed under that rule then fails the
 * account's `__check_auth`.
 */
export async function removeOzContextRule(
  network: LocalNetwork,
  account: OzSmartAccount,
  submitter: Keypair,
  id: number,
): Promise<void> {
  await invokeAsAccount(
    network,
    account,
    submitter,
    new Contract(account.address).call("remove_context_rule", xdr.ScVal.scvU32(id)),
  );
}

/** What the spending-limit policy has recorded against an account's rule in the current window. */
export async function spentInWindow(
  network: LocalNetwork,
  policy: string,
  contextRuleId: number,
  account: string,
): Promise<bigint> {
  const call = new Contract(policy).call(
    "budget",
    xdr.ScVal.scvU32(contextRuleId),
    nativeToScVal(account, { type: "address" }),
  );
  const transaction = new TransactionBuilder(new Account(Keypair.random().publicKey(), "0"), {
    fee: BASE_FEE,
    networkPassphrase: network.passphrase,
  })
    .addOperation(call)
    .setTimeout(60)
    .build();
  const simulation = await network.server.simulateTransaction(transaction);
  if (!rpc.Api.isSimulationSuccess(simulation) || simulation.result === undefined) {
    throw new Error(`budget read failed: ${"error" in simulation ? simulation.error : "no result"}`);
  }
  return (scValToNative(simulation.result.retval) as { spent: bigint }).spent;
}

/**
 * Invokes `call` with the account's authorization, signed by the owner under rule 0 for every
 * context in the recorded tree, and returns the call's result.
 */
async function invokeAsAccount(
  network: LocalNetwork,
  account: OzSmartAccount,
  submitter: Keypair,
  call: xdr.Operation,
): Promise<xdr.ScVal> {
  const source = await network.server.getAccount(submitter.publicKey());
  const draft = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: network.passphrase })
    .addOperation(call)
    .setTimeout(60)
    .build();
  const recorded = await network.server.simulateTransaction(draft);
  if (!rpc.Api.isSimulationSuccess(recorded) || recorded.result === undefined) {
    throw new Error(
      `smart-account call simulation failed: ${"error" in recorded ? recorded.error : "no result"}`,
    );
  }
  const expiration = (await network.latestLedger()) + 100;
  const auth = await Promise.all(
    recorded.result.auth.map(async (entry) => {
      const credentials = addressCredentialsOf(entry);
      if (Address.fromScAddress(credentials.address()).toString() !== account.address) return entry;
      credentials.signatureExpirationLedger(expiration);
      const contexts = countInvocations(entry.rootInvocation());
      const sign = ozSmartAccountSigner({
        verifier: account.verifier,
        key: account.owner,
        contextRuleIds: Array.from({ length: contexts }, () => OZ_DEFAULT_RULE),
      });
      return sign(entry, network.passphrase);
    }),
  );
  const operation = draft.operations[0];
  if (operation?.type !== "invokeHostFunction") throw new Error("unexpected operation");
  const signed = new TransactionBuilder(await network.server.getAccount(submitter.publicKey()), {
    fee: BASE_FEE,
    networkPassphrase: network.passphrase,
  })
    .addOperation(Operation.invokeHostFunction({ func: operation.func, auth }))
    .setTimeout(60)
    .build();
  const prepared = await network.server.prepareTransaction(signed);
  prepared.sign(submitter);
  const result = await network.submit(prepared);
  return result.returnValue ?? xdr.ScVal.scvVoid();
}

function contextScVal(context: OzContext): xdr.ScVal {
  return context.kind === "default"
    ? xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Default")])
    : xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol("CallContract"),
        nativeToScVal(context.contract, { type: "address" }),
      ]);
}

/** A random non-negative int64 nonce. */
function randomNonce(): bigint {
  return BigInt.asIntN(64, randomBytes(8).readBigUInt64BE()) & 0x7fff_ffff_ffff_ffffn;
}

function ruleIdsScVal(ids: readonly number[]): xdr.ScVal {
  return xdr.ScVal.scvVec(ids.map((id) => xdr.ScVal.scvU32(id)));
}

function countInvocations(invocation: xdr.SorobanAuthorizedInvocation): number {
  return 1 + invocation.subInvocations().reduce((sum, child) => sum + countInvocations(child), 0);
}

/** Map keys must be sorted as the host orders them; contract addresses order by their 32-byte id. */
function compareAddresses(a: string, b: string): number {
  return Buffer.compare(
    Address.fromString(a).toScAddress().toXDR(),
    Address.fromString(b).toScAddress().toXDR(),
  );
}
