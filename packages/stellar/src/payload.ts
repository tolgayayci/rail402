import { Address, Transaction, scValToNative, xdr } from "@stellar/stellar-sdk";
import { getAddressCredentials } from "@x402/stellar";
import type { ExactStellarCode } from "./codes.ts";

/** Upper bound on the base64 transaction a client may send. A SAC transfer is about 1 KiB. */
export const MAX_TRANSACTION_XDR_LENGTH = 64 * 1024;

export interface AuthorizationInfo {
  /** Strkey of the address the entry authorizes for (G… or C…). */
  readonly address: string;
  readonly credential: "address" | "address_v2";
  readonly nonce: bigint;
  readonly signatureExpirationLedger: number;
  /** Whether a signature is attached. Its validity is only established by simulation. */
  readonly signed: boolean;
  readonly subInvocations: number;
  /** Whether the root invocation is byte-identical to the operation's contract call. */
  readonly matchesOperation: boolean;
}

/** The decoded contents of an x402 `exact` Stellar payment transaction. */
export interface ExactTransfer {
  readonly transaction: Transaction;
  readonly sourceAccount: string;
  readonly operationSource: string | undefined;
  readonly asset: string;
  readonly functionName: string;
  readonly from: string;
  readonly to: string;
  readonly amount: bigint;
  readonly authorizations: readonly AuthorizationInfo[];
  /** Entries with source-account or delegated credentials, which x402 forbids. */
  readonly otherCredentials: number;
  /** Ledger bounds, sequence conditions or extra signers: settlement re-sources the transaction and cannot honour them. */
  readonly hasUnsupportedPreconditions: boolean;
}

export type Inspection =
  | { readonly ok: true; readonly transfer: ExactTransfer }
  | { readonly ok: false; readonly code: ExactStellarCode; readonly reason?: string };

const fail = (code: ExactStellarCode, reason?: string): Inspection =>
  reason === undefined ? { ok: false, code } : { ok: false, code, reason };

/**
 * Decodes an `exact` payment transaction and extracts everything the verifier checks, without any
 * network access. Structural problems are reported with the same codes @x402/stellar uses.
 */
export function inspectExactTransaction(transactionXdr: unknown, passphrase: string): Inspection {
  if (typeof transactionXdr !== "string" || transactionXdr === "") {
    return fail(
      "invalid_exact_stellar_payload_malformed",
      "payload.transaction must be a base64 XDR string.",
    );
  }
  if (transactionXdr.length > MAX_TRANSACTION_XDR_LENGTH)
    return fail("invalid_exact_stellar_payload_too_large");

  let envelope: xdr.TransactionEnvelope;
  try {
    envelope = xdr.TransactionEnvelope.fromXDR(transactionXdr, "base64");
  } catch {
    return fail("invalid_exact_stellar_payload_malformed");
  }
  if (envelope.switch() !== xdr.EnvelopeType.envelopeTypeTx()) {
    return fail(
      "invalid_exact_stellar_payload_malformed",
      "payload.transaction must be a v1 transaction envelope, not a fee-bump or legacy envelope.",
    );
  }

  let transaction: Transaction;
  try {
    transaction = new Transaction(envelope, passphrase);
  } catch {
    return fail("invalid_exact_stellar_payload_malformed");
  }

  const [operation, ...rest] = transaction.operations;
  if (operation?.type !== "invokeHostFunction" || rest.length > 0) {
    return fail("invalid_exact_stellar_payload_wrong_operation");
  }
  const hostFunction = operation.func;
  if (hostFunction.switch() !== xdr.HostFunctionType.hostFunctionTypeInvokeContract()) {
    return fail("invalid_exact_stellar_payload_wrong_operation");
  }
  const call = hostFunction.invokeContract();
  const functionName = call.functionName().toString();
  const args = call.args();
  const [fromArg, toArg, amountArg] = args;
  if (functionName !== "transfer" || args.length !== 3 || !fromArg || !toArg || !amountArg) {
    return fail("invalid_exact_stellar_payload_wrong_function_name");
  }
  if (
    fromArg.switch() !== xdr.ScValType.scvAddress() ||
    toArg.switch() !== xdr.ScValType.scvAddress() ||
    amountArg.switch() !== xdr.ScValType.scvI128()
  ) {
    return fail(
      "invalid_exact_stellar_payload_wrong_function_name",
      "transfer arguments must be (Address from, Address to, i128 amount).",
    );
  }

  let asset: string, from: string, to: string, amount: bigint;
  try {
    asset = Address.fromScAddress(call.contractAddress()).toString();
    from = scValToNative(fromArg) as string;
    to = scValToNative(toArg) as string;
    amount = scValToNative(amountArg) as bigint;
  } catch {
    return fail("invalid_exact_stellar_payload_malformed", "transfer arguments could not be decoded.");
  }

  const callXdr = call.toXDR("base64");
  const authorizations: AuthorizationInfo[] = [];
  let otherCredentials = 0;
  for (const entry of operation.auth ?? []) {
    const credentials = getAddressCredentials(entry.credentials());
    if (credentials === undefined) {
      otherCredentials++;
      continue;
    }
    const root = entry.rootInvocation();
    const rootFunction = root.function();
    const matchesOperation =
      rootFunction.switch() === xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn() &&
      rootFunction.contractFn().toXDR("base64") === callXdr;
    authorizations.push({
      address: Address.fromScAddress(credentials.address()).toString(),
      credential:
        entry.credentials().switch() === xdr.SorobanCredentialsType.sorobanCredentialsAddressV2()
          ? "address_v2"
          : "address",
      nonce: credentials.nonce().toBigInt(),
      signatureExpirationLedger: credentials.signatureExpirationLedger(),
      signed: credentials.signature().switch() !== xdr.ScValType.scvVoid(),
      subInvocations: root.subInvocations().length,
      matchesOperation,
    });
  }

  return {
    ok: true,
    transfer: {
      transaction,
      sourceAccount: transaction.source,
      operationSource: operation.source,
      asset,
      functionName,
      from,
      to,
      amount,
      authorizations,
      otherCredentials,
      hasUnsupportedPreconditions: hasPreconditions(transaction),
    },
  };
}

function hasPreconditions(transaction: Transaction): boolean {
  const bounds = transaction.ledgerBounds;
  return (
    (bounds !== undefined && (bounds.minLedger > 0 || bounds.maxLedger > 0)) ||
    transaction.minAccountSequence !== undefined ||
    (transaction.minAccountSequenceAge !== undefined && transaction.minAccountSequenceAge > 0n) ||
    (transaction.minAccountSequenceLedgerGap !== undefined && transaction.minAccountSequenceLedgerGap > 0) ||
    (transaction.extraSigners?.length ?? 0) > 0
  );
}

/** The payer's authorization entry: the one whose address is the transfer's `from`. */
export function payerAuthorization(transfer: ExactTransfer): AuthorizationInfo | undefined {
  return transfer.authorizations.find((entry) => entry.address === transfer.from);
}
