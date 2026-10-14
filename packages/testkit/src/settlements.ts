import {
  Address,
  FeeBumpTransaction,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";

export interface TransferEvent {
  /** The token contract that emitted the event. */
  readonly contract: string;
  readonly from: string;
  readonly to: string;
  readonly amount: bigint;
}

/** What a settlement transaction did on chain, read back from the RPC. */
export interface OnChainSettlement {
  readonly hash: string;
  readonly ledger: number;
  /** The fee-bump payer, or the transaction source when there is no fee bump. */
  readonly feeSource: string;
  /** Source account and sequence number of the inner transaction. */
  readonly innerSource: string;
  readonly innerSequence: string;
  readonly feeChargedStroops: bigint;
  readonly transfers: readonly TransferEvent[];
}

/** Reads a successful settlement transaction: who paid the fee, its inner source and sequence, its transfers. */
export async function onChainSettlement(
  server: rpc.Server,
  passphrase: string,
  hash: string,
): Promise<OnChainSettlement> {
  const response = await server.getTransaction(hash);
  if (response.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`transaction ${hash} is ${response.status}`);
  }
  const envelope = TransactionBuilder.fromXDR(response.envelopeXdr.toXDR("base64"), passphrase);
  const inner: Transaction = envelope instanceof FeeBumpTransaction ? envelope.innerTransaction : envelope;
  return {
    hash,
    ledger: response.ledger,
    feeSource: envelope instanceof FeeBumpTransaction ? envelope.feeSource : inner.source,
    innerSource: inner.source,
    innerSequence: inner.sequence,
    feeChargedStroops: response.resultXdr.feeCharged().toBigInt(),
    transfers: transferEvents(response),
  };
}

/** The SEP-41 `transfer` events a successful transaction emitted. */
export function transferEvents(response: rpc.Api.GetSuccessfulTransactionResponse): TransferEvent[] {
  const meta = response.resultMetaXdr;
  const events =
    meta.switch() === 4
      ? meta
          .v4()
          .operations()
          .flatMap((operation) => operation.events())
      : [];
  return events
    .filter((event) => event.body().v0().topics()[0]?.sym().toString() === "transfer")
    .map((event) => {
      const topics = event.body().v0().topics();
      const data = scValToNative(event.body().v0().data()) as bigint | { amount: bigint };
      const contractId = event.contractId();
      return {
        contract:
          contractId === null
            ? ""
            : Address.fromScAddress(xdr.ScAddress.scAddressTypeContract(contractId)).toString(),
        from: String(scValToNative(topics[1] as xdr.ScVal)),
        to: String(scValToNative(topics[2] as xdr.ScVal)),
        amount: typeof data === "bigint" ? data : data.amount,
      };
    });
}
