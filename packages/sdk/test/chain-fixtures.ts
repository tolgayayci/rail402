import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  xdr,
  type rpc,
} from "@stellar/stellar-sdk";
import { baseAccount } from "@rail402.dev/stellar";
import { authorityEntry, settleInvokeArgs, unsignedPayerEntry, type UptoTerms } from "@rail402.dev/upto";

/** Synthetic settlement transactions, shaped like the RPC's getTransaction answers. */

const symbol = (value: string) => nativeToScVal(value, { type: "symbol" });
const address = (value: string) => nativeToScVal(value, { type: "address" });
const i128 = (value: bigint) => nativeToScVal(value, { type: "i128" });

export function contractEvent(contract: string, topics: xdr.ScVal[], data: xdr.ScVal): xdr.ContractEvent {
  return new xdr.ContractEvent({
    ext: new xdr.ExtensionPoint(0),
    contractId: Address.fromString(contract).toScAddress().contractId(),
    type: xdr.ContractEventType.contract(),
    body: new xdr.ContractEventBody(0, new xdr.ContractEventV0({ topics, data })),
  });
}

export function transferEvent(asset: string, from: string, to: string, amount: bigint): xdr.ContractEvent {
  return contractEvent(
    asset,
    [symbol("transfer"), address(from), address(baseAccount(to) ?? to)],
    i128(amount),
  );
}

/** The ledger change the host writes when it consumes `payer`'s authorization nonce. */
export function nonceConsumed(payer: string, nonce: bigint): xdr.LedgerEntryChange {
  return xdr.LedgerEntryChange.ledgerEntryCreated(
    new xdr.LedgerEntry({
      lastModifiedLedgerSeq: 1,
      data: xdr.LedgerEntryData.contractData(
        new xdr.ContractDataEntry({
          ext: new xdr.ExtensionPoint(0),
          contract: Address.fromString(payer).toScAddress(),
          key: xdr.ScVal.scvLedgerKeyNonce(
            new xdr.ScNonceKey({ nonce: xdr.Int64.fromString(nonce.toString()) }),
          ),
          durability: xdr.ContractDataDurability.temporary(),
          val: xdr.ScVal.scvVoid(),
        }),
      ),
      ext: new xdr.LedgerEntryExt(0),
    }),
  );
}

/** A successful transaction with one host-function operation, its auth entries, events and changes. */
export function successfulTransaction(options: {
  readonly func: xdr.HostFunction;
  readonly auth: xdr.SorobanAuthorizationEntry[];
  readonly events: xdr.ContractEvent[];
  readonly changes?: xdr.LedgerEntryChange[];
}): rpc.Api.GetSuccessfulTransactionResponse {
  const transaction = new TransactionBuilder(new Account(Keypair.random().publicKey(), "1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .setTimeout(60)
    .addOperation(Operation.invokeHostFunction({ func: options.func, auth: options.auth }))
    .build();
  const meta = new xdr.TransactionMeta(
    4,
    new xdr.TransactionMetaV4({
      ext: new xdr.ExtensionPoint(0),
      txChangesBefore: [],
      operations: [
        new xdr.OperationMetaV2({
          ext: new xdr.ExtensionPoint(0),
          changes: options.changes ?? [],
          events: options.events,
        }),
      ],
      txChangesAfter: [],
      sorobanMeta: null,
      events: [],
      diagnosticEvents: [],
    }),
  );
  return {
    status: "SUCCESS",
    envelopeXdr: transaction.toEnvelope(),
    resultMetaXdr: meta,
  } as unknown as rpc.Api.GetSuccessfulTransactionResponse;
}

/** The payer's signed `transfer(payer, payTo, amount)` authorization entry (the signature is a stub). */
export function transferAuthorization(options: {
  readonly asset: string;
  readonly payer: string;
  readonly payTo: string;
  readonly amount: bigint;
  readonly nonce: bigint;
}): xdr.SorobanAuthorizationEntry {
  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(options.asset).toScAddress(),
        functionName: "transfer",
        args: [address(options.payer), address(options.payTo), i128(options.amount)],
      }),
    ),
    subInvocations: [],
  });
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(options.payer).toScAddress(),
        nonce: xdr.Int64.fromString(options.nonce.toString()),
        signatureExpirationLedger: 1_000,
        signature: xdr.ScVal.scvVec([]),
      }),
    ),
    rootInvocation: invocation,
  });
}

/**
 * An `exact` settlement: the transfer of `amount` from payer to payTo made with the payer's
 * authorization carrying `nonce`. `consumed: false` carries the entry without the host consuming it.
 */
export function exactSettlement(options: {
  readonly asset: string;
  readonly payer: string;
  readonly payTo: string;
  readonly amount: bigint;
  readonly nonce: bigint;
  readonly consumed?: boolean;
}): rpc.Api.GetSuccessfulTransactionResponse {
  const entry = transferAuthorization(options);
  return successfulTransaction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(options.asset).toScAddress(),
        functionName: "transfer",
        args: [address(options.payer), address(options.payTo), i128(options.amount)],
      }),
    ),
    auth: [entry],
    events: [transferEvent(options.asset, options.payer, options.payTo, options.amount)],
    changes: options.consumed === false ? [] : [nonceConsumed(options.payer, options.nonce)],
  });
}

/**
 * An `upto` settlement of `amount` under the payer's authorization `entry` (default: an unsigned
 * entry for `terms` with `nonce`), with the transfer and `upto_settled` events a settlement emits.
 */
export function uptoSettlement(options: {
  readonly contract: string;
  readonly payer: string;
  readonly terms: UptoTerms;
  readonly amount: bigint;
  readonly nonce: bigint;
  readonly entry?: xdr.SorobanAuthorizationEntry;
  readonly events?: "none" | "wrong_amount";
  readonly transfer?: boolean;
  readonly consumed?: boolean;
}): rpc.Api.GetSuccessfulTransactionResponse {
  const { contract, payer, terms, amount } = options;
  const entry = options.entry ?? unsignedPayerEntry({ contract, payer, terms, nonce: options.nonce });
  const events: xdr.ContractEvent[] = [];
  if (amount > 0n && options.transfer !== false) {
    events.push(transferEvent(terms.token, payer, terms.recipient, amount));
  }
  if (options.events !== "none") {
    const reported = options.events === "wrong_amount" ? amount + 1n : amount;
    events.push(
      contractEvent(
        contract,
        [symbol("upto_settled"), address(payer), address(terms.recipient)],
        xdr.ScVal.scvMap([
          new xdr.ScMapEntry({ key: symbol("amount"), val: i128(reported) }),
          new xdr.ScMapEntry({ key: symbol("facilitator"), val: address(terms.facilitator) }),
          new xdr.ScMapEntry({ key: symbol("max_amount"), val: i128(terms.maxAmount) }),
          new xdr.ScMapEntry({ key: symbol("token"), val: address(terms.token) }),
        ]),
      ),
    );
  }
  return successfulTransaction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(settleInvokeArgs(contract, payer, terms, amount)),
    auth: [entry, authorityEntry(contract, payer, terms, amount)],
    events,
    changes: options.consumed === false ? [] : [nonceConsumed(payer, options.nonce)],
  });
}

/**
 * One transaction that makes all of `settlements` from inside another contract's call (a wrapper,
 * router or batch): the payers' entries, events and consumed nonces of each, and a top-level call to
 * `wrapper` instead of the settlement itself.
 */
export function wrappedSettlements(
  wrapper: string,
  settlements: readonly rpc.Api.GetSuccessfulTransactionResponse[],
): rpc.Api.GetSuccessfulTransactionResponse {
  const auth: xdr.SorobanAuthorizationEntry[] = [];
  const events: xdr.ContractEvent[] = [];
  const changes: xdr.LedgerEntryChange[] = [];
  for (const settlement of settlements) {
    const operation = settlement.envelopeXdr.v1().tx().operations()[0];
    auth.push(...(operation?.body().invokeHostFunctionOp().auth() ?? []));
    for (const meta of settlement.resultMetaXdr.v4().operations()) {
      events.push(...meta.events());
      changes.push(...meta.changes());
    }
  }
  return successfulTransaction({
    func: xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(wrapper).toScAddress(),
        functionName: "forward",
        args: [],
      }),
    ),
    auth,
    events,
    changes,
  });
}
