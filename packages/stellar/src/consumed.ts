import { Address, xdr, type rpc } from "@stellar/stellar-sdk";
import { UnsupportedMetaError } from "./transfers.ts";
import { credentialAddressOf } from "./upto.ts";

/**
 * Proof that a transaction used one particular signed authorization.
 *
 * A transfer event only shows that money moved from a payer to a recipient; it does not say which of
 * the payer's authorizations moved it. An authorization is identified by its address and nonce, and
 * the host records every nonce it accepts in a temporary ledger entry keyed by both. A successful
 * transaction consumed an authorization exactly when its envelope carries the address-credential
 * entry with that nonce and its meta creates that nonce entry. An entry that is only carried along
 * (never required by the invoked contracts) leaves the nonce unconsumed and proves nothing.
 */

/** The payer's address-credential authorization entry with this nonce in the envelope (fee bump unwrapped). */
export function authorizationEntryIn(
  envelope: xdr.TransactionEnvelope,
  payer: string,
  nonce: bigint,
): xdr.SorobanAuthorizationEntry | undefined {
  for (const operation of operationsOf(envelope)) {
    const body = operation.body();
    if (body.switch() !== xdr.OperationType.invokeHostFunction()) continue;
    for (const entry of body.invokeHostFunctionOp().auth()) {
      if (credentialAddressOf(entry) === payer && entryNonce(entry) === nonce) return entry;
    }
  }
  return undefined;
}

/**
 * Whether the transaction's meta creates the payer's nonce entry: the host consumed that nonce in it.
 * Throws `UnsupportedMetaError` for a meta version this package does not read.
 */
export function consumedNonceIn(
  transaction: rpc.Api.GetSuccessfulTransactionResponse,
  payer: string,
  nonce: bigint,
): boolean {
  let owner: xdr.ScAddress;
  try {
    owner = Address.fromString(payer).toScAddress();
  } catch {
    return false;
  }
  const ownerXdr = owner.toXDR("base64");
  for (const change of operationChangesOf(transaction.resultMetaXdr)) {
    if (change.switch() !== xdr.LedgerEntryChangeType.ledgerEntryCreated()) continue;
    const data = change.created().data();
    if (data.switch() !== xdr.LedgerEntryType.contractData()) continue;
    const entry = data.contractData();
    if (entry.durability() !== xdr.ContractDataDurability.temporary()) continue;
    const key = entry.key();
    if (key.switch() !== xdr.ScValType.scvLedgerKeyNonce()) continue;
    if (key.nonceKey().nonce().toBigInt() !== nonce) continue;
    if (entry.contract().toXDR("base64") === ownerXdr) return true;
  }
  return false;
}

/**
 * The payer's authorization entry with this nonce when the transaction both carries it and consumed
 * its nonce, otherwise undefined. The entry is then exactly what the payer signed: the host accepted
 * its signature. Throws `UnsupportedMetaError` when the meta cannot be read, since "not consumed"
 * could then be wrong.
 */
export function consumedAuthorization(
  transaction: rpc.Api.GetSuccessfulTransactionResponse,
  payer: string,
  nonce: bigint,
): xdr.SorobanAuthorizationEntry | undefined {
  let entry: xdr.SorobanAuthorizationEntry | undefined;
  try {
    entry = authorizationEntryIn(transaction.envelopeXdr, payer, nonce);
  } catch {
    return undefined;
  }
  return entry !== undefined && consumedNonceIn(transaction, payer, nonce) ? entry : undefined;
}

function entryNonce(entry: xdr.SorobanAuthorizationEntry): bigint | undefined {
  const credentials = entry.credentials();
  switch (credentials.switch()) {
    case xdr.SorobanCredentialsType.sorobanCredentialsAddress():
      return credentials.address().nonce().toBigInt();
    case xdr.SorobanCredentialsType.sorobanCredentialsAddressV2():
      return credentials.addressV2().nonce().toBigInt();
    default:
      return undefined;
  }
}

function operationsOf(envelope: xdr.TransactionEnvelope): xdr.Operation[] {
  switch (envelope.switch()) {
    case xdr.EnvelopeType.envelopeTypeTx():
      return envelope.v1().tx().operations();
    case xdr.EnvelopeType.envelopeTypeTxFeeBump():
      return envelope.feeBump().tx().innerTx().v1().tx().operations();
    default:
      return [];
  }
}

function operationChangesOf(meta: xdr.TransactionMeta): xdr.LedgerEntryChange[] {
  switch (meta.switch()) {
    case 3:
      return meta
        .v3()
        .operations()
        .flatMap((operation) => operation.changes());
    case 4:
      return meta
        .v4()
        .operations()
        .flatMap((operation) => operation.changes());
    default:
      throw new UnsupportedMetaError(meta.switch());
  }
}
