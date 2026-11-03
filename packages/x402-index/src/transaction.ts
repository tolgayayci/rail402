import { xdr } from "@stellar/stellar-sdk";
import { muxedAccount, scAddress, type AddressView } from "./xdr.ts";

/** The credential kind of a Soroban authorization entry. */
export type CredentialKind = "source_account" | "address" | "address_v2" | "address_with_delegates";

/** A contract function invocation: the contract, the function and its raw arguments. */
export interface InvocationView {
  readonly contract: string;
  readonly fn: string;
  readonly args: readonly xdr.ScVal[];
}

export interface AuthorizationView {
  readonly credential: CredentialKind;
  /** The authorizing address; `null` for source-account credentials. */
  readonly address: AddressView | null;
  readonly nonce: string | null;
  readonly expirationLedger: number | null;
  /** Whether the entry carries a signature value at all; says nothing about whether it is valid. */
  readonly signed: boolean;
  /** The root invocation when it is a contract function; `null` for contract creation. */
  readonly root: InvocationView | null;
  readonly subInvocations: number;
  /** The entry as the envelope carries it, for checking its signature. */
  readonly entry: xdr.SorobanAuthorizationEntry;
}

export interface OperationView {
  /** The XDR operation type name, e.g. "invokeHostFunction" or "payment". */
  readonly type: string;
  /** The operation's own source account, when it sets one. */
  readonly source: AddressView | null;
  /** The host function type name for an invokeHostFunction that is not a contract call. */
  readonly hostFunction: string | null;
  readonly invocation: InvocationView | null;
  readonly authorizations: readonly AuthorizationView[];
}

/** A transaction envelope read into the fields the rules use. */
export interface TransactionView {
  readonly feeBump: boolean;
  /** The fee-bump fee source, otherwise the inner source. */
  readonly feePayer: AddressView;
  readonly innerSource: AddressView;
  readonly operations: readonly OperationView[];
}

/**
 * Reads an envelope (v0, v1 or fee bump; hashes come from `envelopeHashes`). `undefined` when an
 * account or address in it does not encode. Never throws.
 */
export function readEnvelope(envelope: xdr.TransactionEnvelope): TransactionView | undefined {
  try {
    const type = envelope.switch();
    let source: xdr.MuxedAccount;
    let operationList: xdr.Operation[];
    let feeSource: xdr.MuxedAccount | null = null;
    if (type === xdr.EnvelopeType.envelopeTypeTx()) {
      const tx = envelope.v1().tx();
      source = tx.sourceAccount();
      operationList = tx.operations();
    } else if (type === xdr.EnvelopeType.envelopeTypeTxFeeBump()) {
      const feeBump = envelope.feeBump().tx();
      const tx = feeBump.innerTx().v1().tx();
      source = tx.sourceAccount();
      operationList = tx.operations();
      feeSource = feeBump.feeSource();
    } else if (type === xdr.EnvelopeType.envelopeTypeTxV0()) {
      const tx = envelope.v0().tx();
      source = xdr.MuxedAccount.keyTypeEd25519(tx.sourceAccountEd25519());
      operationList = tx.operations();
    } else return undefined;
    const innerSource = muxedAccount(source);
    const feePayer = feeSource === null ? innerSource : muxedAccount(feeSource);
    if (innerSource === undefined || feePayer === undefined) return undefined;
    const operations: OperationView[] = [];
    for (const operation of operationList) {
      const view = readOperation(operation);
      if (view === undefined) return undefined;
      operations.push(view);
    }
    return { feeBump: feeSource !== null, feePayer, innerSource, operations };
  } catch {
    return undefined;
  }
}

function readOperation(operation: xdr.Operation): OperationView | undefined {
  // The XDR library returns undefined (not null) for an absent optional source.
  const sourceAccount = operation.sourceAccount() as xdr.MuxedAccount | null | undefined;
  const source = sourceAccount === null || sourceAccount === undefined ? null : muxedAccount(sourceAccount);
  if (source === undefined) return undefined;
  const body = operation.body();
  const type = body.switch().name;
  if (body.switch() !== xdr.OperationType.invokeHostFunction()) {
    return { type, source, hostFunction: null, invocation: null, authorizations: [] };
  }
  const op = body.invokeHostFunctionOp();
  const func = op.hostFunction();
  const authorizations: AuthorizationView[] = [];
  for (const entry of op.auth()) {
    const view = readAuthorization(entry);
    if (view === undefined) return undefined;
    authorizations.push(view);
  }
  if (func.switch() !== xdr.HostFunctionType.hostFunctionTypeInvokeContract()) {
    return { type, source, hostFunction: func.switch().name, invocation: null, authorizations };
  }
  const invocation = readInvocation(func.invokeContract());
  if (invocation === undefined) return undefined;
  return { type, source, hostFunction: null, invocation, authorizations };
}

function readInvocation(args: xdr.InvokeContractArgs): InvocationView | undefined {
  const contract = scAddress(args.contractAddress());
  if (contract?.kind !== "C") return undefined;
  return { contract: contract.base, fn: args.functionName().toString("latin1"), args: args.args() };
}

function readAuthorization(entry: xdr.SorobanAuthorizationEntry): AuthorizationView | undefined {
  const credentials = entry.credentials();
  const rootInvocation = entry.rootInvocation();
  const fn = rootInvocation.function();
  let root: InvocationView | null = null;
  if (fn.switch() === xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn()) {
    root = readInvocation(fn.contractFn()) ?? null;
    if (root === null) return undefined;
  }
  const subInvocations = rootInvocation.subInvocations().length;
  const kind = credentials.switch();
  if (kind === xdr.SorobanCredentialsType.sorobanCredentialsSourceAccount()) {
    return {
      credential: "source_account",
      address: null,
      nonce: null,
      expirationLedger: null,
      signed: false,
      root,
      subInvocations,
      entry,
    };
  }
  let address: xdr.SorobanAddressCredentials;
  let credential: CredentialKind;
  if (kind === xdr.SorobanCredentialsType.sorobanCredentialsAddress()) {
    address = credentials.address();
    credential = "address";
  } else if (kind === xdr.SorobanCredentialsType.sorobanCredentialsAddressV2()) {
    address = credentials.addressV2();
    credential = "address_v2";
  } else if (kind === xdr.SorobanCredentialsType.sorobanCredentialsAddressWithDelegates()) {
    address = credentials.addressWithDelegates().addressCredentials();
    credential = "address_with_delegates";
  } else return undefined;
  const who = scAddress(address.address());
  if (who === undefined) return undefined;
  return {
    credential,
    address: who,
    nonce: address.nonce().toString(),
    expirationLedger: address.signatureExpirationLedger(),
    signed: address.signature().switch() !== xdr.ScValType.scvVoid(),
    root,
    subInvocations,
    entry,
  };
}
