import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  authorizeEntry,
  buildAuthorizationEntryPreimage,
  hash,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import type { LocalNetwork } from "./network.ts";

/** A committed contract build from `packages/testkit/fixtures` (see its README for provenance). */
export function fixtureWasm(name: string): Buffer {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url));
}

/** The committed `upto` settlement contract build (`fixtures/x402_upto_stellar.wasm`). */
export function uptoWasm(): Buffer {
  return fixtureWasm("x402_upto_stellar.wasm");
}

/** A settlement contract deployed on a local network. */
export interface LocalUptoContract {
  readonly address: string;
  /** Hex sha256 of the installed WASM. */
  readonly wasmHash: string;
}

/**
 * Uploads `wasm` (a no-op when the network already has it) and creates an instance from `deployer`,
 * which must be funded, with a random salt and `constructorArgs`. Returns the new `C…` address.
 */
export async function deployContract(
  network: LocalNetwork,
  deployer: Keypair,
  wasm: Buffer,
  constructorArgs: xdr.ScVal[] = [],
): Promise<string> {
  await invoke(network, deployer, Operation.uploadContractWasm({ wasm }));
  const created = await invoke(
    network,
    deployer,
    Operation.createCustomContract({
      address: Address.fromString(deployer.publicKey()),
      wasmHash: hash(wasm),
      salt: randomBytes(32),
      constructorArgs,
    }),
  );
  if (created.returnValue === undefined) throw new Error("contract creation returned no address");
  return Address.fromScVal(created.returnValue).toString();
}

/** Calls `method` on `contract` in a transaction of `source`, which signs and pays; returns its result. */
export async function callContract(
  network: LocalNetwork,
  source: Keypair,
  contract: string,
  method: string,
  args: xdr.ScVal[] = [],
): Promise<xdr.ScVal | undefined> {
  return (await invoke(network, source, new Contract(contract).call(method, ...args))).returnValue;
}

/**
 * Uploads the committed settlement contract and deploys an instance from `deployer` (funded here)
 * with a random salt, so every test run gets its own contract address.
 */
export async function deployUpto(
  network: LocalNetwork,
  deployer = Keypair.random(),
): Promise<LocalUptoContract> {
  await network.fund(deployer);
  const wasm = uptoWasm();
  return { address: await deployContract(network, deployer, wasm), wasmHash: hash(wasm).toString("hex") };
}

/**
 * Creates `account` with a zero balance and its reserve paid by `sponsor`, the way Rail402 creates
 * channel accounts and the settlement authority.
 */
export async function sponsoredAccount(
  network: LocalNetwork,
  sponsor: Keypair,
  account = Keypair.random(),
): Promise<Keypair> {
  await network.classic(
    sponsor,
    [
      Operation.beginSponsoringFutureReserves({ sponsoredId: account.publicKey() }),
      Operation.createAccount({ destination: account.publicKey(), startingBalance: "0" }),
      Operation.endSponsoringFutureReserves({ source: account.publicKey() }),
    ],
    [account],
  );
  return account;
}

/** Signs an authorization entry's address credentials for the network with `passphrase`. */
export type EntrySigner = (
  entry: xdr.SorobanAuthorizationEntry,
  passphrase: string,
) => Promise<xdr.SorobanAuthorizationEntry>;

/** The address credentials of an ADDRESS or ADDRESS_V2 entry. */
export function addressCredentialsOf(entry: xdr.SorobanAuthorizationEntry): xdr.SorobanAddressCredentials {
  const credentials = entry.credentials();
  switch (credentials.switch()) {
    case xdr.SorobanCredentialsType.sorobanCredentialsAddress():
      return credentials.address();
    case xdr.SorobanCredentialsType.sorobanCredentialsAddressV2():
      return credentials.addressV2();
    default:
      throw new Error(`no address credentials: ${credentials.switch().name}`);
  }
}

/**
 * The 32 bytes a signer of `entry` signs: sha256 of its SorobanAuthorization preimage (the V2
 * preimage for ADDRESS_V2 credentials), with the expiration ledger the entry already carries.
 */
export function entrySignaturePayload(entry: xdr.SorobanAuthorizationEntry, passphrase: string): Buffer {
  const expiration = addressCredentialsOf(entry).signatureExpirationLedger();
  return hash(buildAuthorizationEntryPreimage(entry, expiration, passphrase).toXDR());
}

/** Signs as a `G…` account with its ed25519 key, the standard account signature format. */
export function accountSigner(keypair: Keypair): EntrySigner {
  return (entry, passphrase) =>
    authorizeEntry(entry, keypair, addressCredentialsOf(entry).signatureExpirationLedger(), passphrase);
}

/**
 * Signs for the `simple_account.wasm` fixture (a custom account whose `__check_auth` verifies one
 * ed25519 signature by its owner over the payload): the signature is the 64 raw bytes.
 */
export function simpleAccountSigner(owner: Keypair): EntrySigner {
  return (entry, passphrase) => {
    const signed = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR());
    addressCredentialsOf(signed).signature(
      xdr.ScVal.scvBytes(owner.sign(entrySignaturePayload(signed, passphrase))),
    );
    return Promise.resolve(signed);
  };
}

/** A Soroban invocation: the host function, its authorization entries and the operation's source. */
export interface Invocation {
  readonly func: xdr.HostFunction;
  readonly auth: readonly xdr.SorobanAuthorizationEntry[];
  /** Operation source; the transaction source (the submitter) when absent. */
  readonly source?: string;
}

/** What the network did with a submitted invocation. */
export interface InvocationOutcome {
  /** Hex hash of the transaction. */
  readonly hash: string;
  readonly status: "SUCCESS" | "FAILED";
  readonly ledger: number;
  /** Fee the network charged the submitter, in stroops. */
  readonly feeCharged: bigint;
  /** Diagnostic events of a failed transaction (errors included). */
  readonly diagnosticEvents: readonly xdr.DiagnosticEvent[];
}

/**
 * Submits `invocation` in a transaction of `submitter`, signed also by `signers` (e.g. an operation
 * source), without the safety net of simulating it: the footprint and resources come from simulating
 * `resourcesOf` (by default the invocation itself), which must succeed. This lands transactions that
 * fail on the network — an amount the contract refuses, an authorization the host refuses, a nonce
 * already used by a transaction in the same ledger — so tests can prove what the chain enforces, not
 * only what a facilitator checks.
 */
export async function submitInvocation(
  network: LocalNetwork,
  options: {
    readonly submitter: Keypair;
    readonly invocation: Invocation;
    readonly signers?: readonly Keypair[];
    readonly resourcesOf?: Invocation;
  },
): Promise<InvocationOutcome> {
  const { submitter, invocation } = options;
  const template = options.resourcesOf ?? invocation;
  const account = await network.server.getAccount(submitter.publicKey());
  const draft = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: network.passphrase })
    .addOperation(operationOf(template))
    .setTimeout(60)
    .build();
  const simulation = await network.server.simulateTransaction(draft);
  if (!rpc.Api.isSimulationSuccess(simulation)) {
    throw new Error(
      `the resource template does not simulate: ${"error" in simulation ? simulation.error : "unknown"}`,
    );
  }
  // Room for the extra work of the submitted invocation (e.g. a different signature check).
  const resourceFee = BigInt(simulation.minResourceFee) * 2n;
  const data = new SorobanDataBuilder(simulation.transactionData.build()).setResourceFee(resourceFee).build();
  data.resources().instructions(Math.ceil(data.resources().instructions() * 1.5));
  const transaction = new TransactionBuilder(await network.server.getAccount(submitter.publicKey()), {
    fee: (resourceFee + 10_000n).toString(),
    networkPassphrase: network.passphrase,
  })
    .addOperation(operationOf(invocation))
    .setSorobanData(data)
    .setTimeout(60)
    .build();
  transaction.sign(submitter, ...(options.signers ?? []));

  const sent = await network.server.sendTransaction(transaction);
  if (sent.status !== "PENDING") {
    throw new Error(`sendTransaction ${sent.status}: ${sent.errorResult?.result().switch().name ?? ""}`);
  }
  const result = await network.server.pollTransaction(sent.hash, { attempts: 60 });
  if (result.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
    throw new Error(`transaction ${sent.hash} was not included`);
  }
  return {
    hash: sent.hash,
    status: result.status === rpc.Api.GetTransactionStatus.SUCCESS ? "SUCCESS" : "FAILED",
    ledger: result.ledger,
    feeCharged: result.resultXdr.feeCharged().toBigInt(),
    diagnosticEvents: result.diagnosticEventsXdr ?? [],
  };
}

function operationOf(invocation: Invocation): xdr.Operation {
  return Operation.invokeHostFunction({
    func: invocation.func,
    auth: [...invocation.auth],
    ...(invocation.source === undefined ? {} : { source: invocation.source }),
  });
}

async function invoke(network: LocalNetwork, source: Keypair, operation: xdr.Operation) {
  const account = await network.server.getAccount(source.publicKey());
  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: network.passphrase,
  })
    .addOperation(operation)
    .setTimeout(60)
    .build();
  const prepared = await network.server.prepareTransaction(transaction);
  prepared.sign(source);
  return network.submit(prepared);
}
