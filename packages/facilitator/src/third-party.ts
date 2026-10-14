import {
  Address,
  FeeBumpTransaction,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import { getAddressCredentials } from "@x402/stellar";
import { SETTLED_EVENT } from "@rail402.dev/upto";
import { recordedUptoSettlement } from "@rail402.dev/stellar";
import type { SettlementRecord } from "./ledger.ts";

/**
 * Front-running reconciliation.
 *
 * A payer's signed authorization is visible to anyone who sees the settlement transaction before it
 * lands, and nothing stops them from copying the authorization entry into a transaction of their
 * own. If that copy lands first, the payment still happens exactly as the payer signed it — the
 * same transfer, the same nonce — but Rail402's own transaction then fails on the consumed nonce.
 * The payment did settle, so answering "failed" would make the seller refuse a buyer who paid.
 *
 * `findThirdPartySettlement` proves such a landing from the chain alone:
 * 1. the payer's nonce entry exists, and the ledger that last modified it (the one that consumed the
 *    nonce) closed no earlier than Rail402 was asked to settle, so the authorization was not already
 *    spent before the request arrived;
 * 2. a successful transaction in that ledger carries an address-credential authorization entry for
 *    the payer with the same nonce and expiration ledger, and a root invocation byte-equal to the
 *    one the payer signed;
 * 3. that transaction emitted the matching `transfer` event from the asset contract (`exact`), or
 *    the settlement contract's `upto_settled` event for the payer, payTo and asset (`upto`).
 * Anything short of all three leaves the settlement failed.
 *
 * An `upto` authorization leaves the amount to the settlement authority, so the transaction found may
 * have settled a different amount than Rail402's own; the amount it settled is reported.
 */

/** The payer's signed authorization and the transfer it covers, from a recorded settlement envelope. */
export interface SignedAuthorization {
  readonly payer: string;
  readonly nonce: bigint;
  readonly signatureExpirationLedger: number;
  /** XDR of the authorized root invocation: exactly what the payer signed. */
  readonly rootInvocation: Buffer;
  readonly asset: string;
  readonly to: string;
  /** The amount the recorded settlement moves. */
  readonly amount: bigint;
  /** The `upto` settlement contract, for an `upto` authorization. */
  readonly settlementContract?: string;
}

export interface ThirdPartySettlement {
  readonly hash: string;
  readonly ledger: number;
  /** The amount that transaction moved from the payer to payTo. */
  readonly amount: bigint;
}

/** Why no third-party settlement was accepted, for logs. */
export type ThirdPartyMiss =
  | "no_authorization"
  | "nonce_not_consumed"
  | "consumed_before_request"
  | "ledger_not_retained"
  | "no_matching_transaction";

export type ThirdPartyResult =
  | { readonly found: true; readonly settlement: ThirdPartySettlement }
  | { readonly found: false; readonly miss: ThirdPartyMiss };

/** Transactions requested per `getTransactions` page while scanning one ledger. */
const PAGE_LIMIT = 200;
/** Pages scanned at most; a ledger never holds more transactions than this covers. */
const MAX_PAGES = 25;

/** The payer's authorization entry inside a recorded settlement envelope. */
export function signedAuthorizationOf(
  record: SettlementRecord,
  passphrase: string,
): SignedAuthorization | undefined {
  if (record.envelopeXdr === undefined) return undefined;
  const envelope = TransactionBuilder.fromXDR(record.envelopeXdr, passphrase);
  const inner: Transaction = envelope instanceof FeeBumpTransaction ? envelope.innerTransaction : envelope;
  const operation = inner.operations[0];
  if (operation?.type !== "invokeHostFunction") return undefined;
  const payer = record.key.payer;
  const nonce = BigInt(record.key.nonce);
  const upto = record.scheme === "upto" ? recordedUptoSettlement(record.envelopeXdr, passphrase) : undefined;
  if (record.scheme === "upto" && upto === undefined) return undefined;
  for (const entry of operation.auth ?? []) {
    const credentials = getAddressCredentials(entry.credentials());
    if (credentials === undefined) continue;
    if (Address.fromScAddress(credentials.address()).toString() !== payer) continue;
    if (credentials.nonce().toBigInt() !== nonce) continue;
    const root = entry.rootInvocation();
    const fn = root.function();
    if (fn.switch() !== xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn()) {
      return undefined;
    }
    const call = fn.contractFn();
    if (upto !== undefined) {
      return {
        payer,
        nonce,
        signatureExpirationLedger: credentials.signatureExpirationLedger(),
        rootInvocation: root.toXDR(),
        asset: upto.terms.token,
        to: upto.terms.recipient,
        amount: upto.amount,
        settlementContract: upto.contract,
      };
    }
    const [, to, amount] = call.args();
    if (call.functionName().toString() !== "transfer" || to === undefined || amount === undefined) {
      return undefined;
    }
    return {
      payer,
      nonce,
      signatureExpirationLedger: credentials.signatureExpirationLedger(),
      rootInvocation: root.toXDR(),
      asset: Address.fromScAddress(call.contractAddress()).toString(),
      to: String(scValToNative(to)),
      amount: scValToNative(amount) as bigint,
    };
  }
  return undefined;
}

/** The ledger key of the temporary entry that marks a payer's authorization nonce as consumed. */
export function nonceLedgerKey(payer: string, nonce: bigint): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(payer).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyNonce(new xdr.ScNonceKey({ nonce: xdr.Int64.fromString(nonce.toString()) })),
      durability: xdr.ContractDataDurability.temporary(),
    }),
  );
}

/**
 * Looks for the successful transaction that consumed the payer's authorization of `record`, exactly
 * as signed. See the module comment for what counts as proof. It can be Rail402's own envelope
 * (`record.transactionHash`) when the RPC that answered NOT_FOUND for it lagged: callers tell the two
 * apart.
 */
export async function findThirdPartySettlement(
  server: rpc.Server,
  record: SettlementRecord,
  passphrase: string,
): Promise<ThirdPartyResult> {
  const signed = signedAuthorizationOf(record, passphrase);
  if (signed === undefined) return { found: false, miss: "no_authorization" };

  const { entries } = await server.getLedgerEntries(nonceLedgerKey(signed.payer, signed.nonce));
  const consumedIn = entries[0]?.lastModifiedLedgerSeq;
  if (consumedIn === undefined) return { found: false, miss: "nonce_not_consumed" };

  const requestedAt = Math.floor(record.createdAt / 1_000);
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    let response: rpc.Api.GetTransactionsResponse;
    try {
      response = await server.getTransactions(
        cursor === undefined
          ? { startLedger: consumedIn, pagination: { limit: PAGE_LIMIT } }
          : { pagination: { cursor, limit: PAGE_LIMIT } },
      );
    } catch (error) {
      if (consumedIn < (await oldestLedger(server))) return { found: false, miss: "ledger_not_retained" };
      throw error;
    }
    for (const transaction of response.transactions) {
      if (transaction.ledger > consumedIn) return { found: false, miss: "no_matching_transaction" };
      if (transaction.ledger < consumedIn) continue;
      if (closeSeconds(transaction.createdAt) < requestedAt) {
        return { found: false, miss: "consumed_before_request" };
      }
      if (transaction.status !== rpc.Api.GetTransactionStatus.SUCCESS) continue;
      if (!carriesAuthorization(transaction.envelopeXdr, signed)) continue;
      const amount = settledAmount(transaction, signed);
      if (amount !== undefined) {
        return { found: true, settlement: { hash: transaction.txHash, ledger: transaction.ledger, amount } };
      }
    }
    if (response.transactions.length < PAGE_LIMIT || response.cursor === "") break;
    cursor = response.cursor;
  }
  return { found: false, miss: "no_matching_transaction" };
}

/** A close time in seconds; RPC answers can carry it as a decimal string despite the SDK's `number` type. */
function closeSeconds(value: number | string): number {
  return Number(value);
}

async function oldestLedger(server: rpc.Server): Promise<number> {
  return (await server.getHealth()).oldestLedger;
}

/** Whether an envelope (fee bump unwrapped) carries the payer's signed authorization entry verbatim. */
function carriesAuthorization(envelope: xdr.TransactionEnvelope, signed: SignedAuthorization): boolean {
  for (const operation of operationsOf(envelope)) {
    const body = operation.body();
    if (body.switch() !== xdr.OperationType.invokeHostFunction()) continue;
    for (const entry of body.invokeHostFunctionOp().auth()) {
      const credentials = getAddressCredentials(entry.credentials());
      if (credentials === undefined) continue;
      if (
        Address.fromScAddress(credentials.address()).toString() === signed.payer &&
        credentials.nonce().toBigInt() === signed.nonce &&
        credentials.signatureExpirationLedger() === signed.signatureExpirationLedger &&
        entry.rootInvocation().toXDR().equals(signed.rootInvocation)
      ) {
        return true;
      }
    }
  }
  return false;
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

/**
 * The amount the transaction settled for the payer's authorization: the `upto_settled` event's amount
 * for an `upto` authorization, the recorded amount when an `exact` transfer event matches it, else
 * `undefined`.
 */
function settledAmount(
  transaction: rpc.Api.TransactionInfo,
  signed: SignedAuthorization,
): bigint | undefined {
  if (signed.settlementContract === undefined) {
    return emitsTransfer(transaction, signed) ? signed.amount : undefined;
  }
  for (const event of transaction.events.contractEventsXdr.flat()) {
    try {
      const contractId = event.contractId();
      if (contractId === null) continue;
      const contract = Address.fromScAddress(xdr.ScAddress.scAddressTypeContract(contractId)).toString();
      if (contract !== signed.settlementContract) continue;
      const body = event.body().v0();
      const [name, payer, recipient] = body.topics();
      if (name?.switch() !== xdr.ScValType.scvSymbol() || name.sym().toString() !== SETTLED_EVENT) continue;
      if (payer === undefined || recipient === undefined) continue;
      if (String(scValToNative(payer)) !== signed.payer || String(scValToNative(recipient)) !== signed.to)
        continue;
      const data = scValToNative(body.data()) as { token?: unknown; amount?: unknown };
      if (String(data.token) !== signed.asset || typeof data.amount !== "bigint") continue;
      return data.amount;
    } catch {
      // An event that does not decode proves nothing.
    }
  }
  return undefined;
}

/** Whether the transaction emitted `transfer(payer → to, amount)` from the signed asset contract. */
function emitsTransfer(transaction: rpc.Api.TransactionInfo, signed: SignedAuthorization): boolean {
  const events = transaction.events.contractEventsXdr.flat();
  return events.some((event) => {
    try {
      const contractId = event.contractId();
      if (contractId === null) return false;
      const contract = Address.fromScAddress(xdr.ScAddress.scAddressTypeContract(contractId)).toString();
      if (contract !== signed.asset) return false;
      const body = event.body().v0();
      const [name, from, to] = body.topics();
      if (name?.switch() !== xdr.ScValType.scvSymbol() || name.sym().toString() !== "transfer") return false;
      if (from === undefined || to === undefined) return false;
      if (String(scValToNative(from)) !== signed.payer || String(scValToNative(to)) !== signed.to)
        return false;
      const data = scValToNative(body.data()) as bigint | { amount?: bigint };
      const amount = typeof data === "bigint" ? data : data.amount;
      return amount === signed.amount;
    } catch {
      return false;
    }
  });
}
