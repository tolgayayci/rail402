import { describe, expect, it } from "vitest";
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
import {
  UnsupportedMetaError,
  authorizationEntryIn,
  consumedAuthorization,
  consumedNonceIn,
} from "@rail402.dev/stellar";
import { randomContractId } from "@rail402.dev/testkit";

const token = randomContractId();
const payer = Keypair.random().publicKey();
const payTo = Keypair.random().publicKey();
const address = (value: string) => nativeToScVal(value, { type: "address" });

function entry(nonce: bigint): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(payer).toScAddress(),
        nonce: xdr.Int64.fromString(nonce.toString()),
        signatureExpirationLedger: 100,
        signature: xdr.ScVal.scvVec([]),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(token).toScAddress(),
          functionName: "transfer",
          args: [address(payer), address(payTo), nativeToScVal(5n, { type: "i128" })],
        }),
      ),
      subInvocations: [],
    }),
  });
}

function nonceCreated(owner: string, nonce: bigint, durability = xdr.ContractDataDurability.temporary()) {
  return xdr.LedgerEntryChange.ledgerEntryCreated(
    new xdr.LedgerEntry({
      lastModifiedLedgerSeq: 1,
      data: xdr.LedgerEntryData.contractData(
        new xdr.ContractDataEntry({
          ext: new xdr.ExtensionPoint(0),
          contract: Address.fromString(owner).toScAddress(),
          key: xdr.ScVal.scvLedgerKeyNonce(
            new xdr.ScNonceKey({ nonce: xdr.Int64.fromString(nonce.toString()) }),
          ),
          durability,
          val: xdr.ScVal.scvVoid(),
        }),
      ),
      ext: new xdr.LedgerEntryExt(0),
    }),
  );
}

function transaction(
  auth: xdr.SorobanAuthorizationEntry[],
  changes: xdr.LedgerEntryChange[],
  feeBump = false,
): rpc.Api.GetSuccessfulTransactionResponse {
  const source = Keypair.random();
  const inner = new TransactionBuilder(new Account(source.publicKey(), "1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .setTimeout(60)
    .addOperation(
      Operation.invokeHostFunction({
        func: xdr.HostFunction.hostFunctionTypeInvokeContract(
          new xdr.InvokeContractArgs({
            contractAddress: Address.fromString(token).toScAddress(),
            functionName: "transfer",
            args: [],
          }),
        ),
        auth,
      }),
    )
    .build();
  inner.sign(source);
  const envelope = feeBump
    ? TransactionBuilder.buildFeeBumpTransaction(source, "200", inner, Networks.TESTNET).toEnvelope()
    : inner.toEnvelope();
  const meta = new xdr.TransactionMeta(
    4,
    new xdr.TransactionMetaV4({
      ext: new xdr.ExtensionPoint(0),
      txChangesBefore: [],
      operations: [new xdr.OperationMetaV2({ ext: new xdr.ExtensionPoint(0), changes, events: [] })],
      txChangesAfter: [],
      sorobanMeta: null,
      events: [],
      diagnosticEvents: [],
    }),
  );
  return { envelopeXdr: envelope, resultMetaXdr: meta } as rpc.Api.GetSuccessfulTransactionResponse;
}

describe("consumedAuthorization", () => {
  it("finds the payer's entry only when the transaction consumed its nonce", () => {
    const consumed = transaction([entry(7n)], [nonceCreated(payer, 7n)]);
    expect(consumedAuthorization(consumed, payer, 7n)?.toXDR("base64")).toBe(entry(7n).toXDR("base64"));
    // Carried along without the host consuming it.
    expect(consumedAuthorization(transaction([entry(7n)], []), payer, 7n)).toBeUndefined();
    // Another nonce, another owner, or a persistent entry are not this authorization's nonce.
    expect(
      consumedAuthorization(transaction([entry(7n)], [nonceCreated(payer, 8n)]), payer, 7n),
    ).toBeUndefined();
    expect(consumedNonceIn(transaction([], [nonceCreated(payTo, 7n)]), payer, 7n)).toBe(false);
    expect(
      consumedNonceIn(
        transaction([], [nonceCreated(payer, 7n, xdr.ContractDataDurability.persistent())]),
        payer,
        7n,
      ),
    ).toBe(false);
    // The nonce consumed, but by an entry the envelope does not carry.
    expect(
      consumedAuthorization(transaction([entry(8n)], [nonceCreated(payer, 7n)]), payer, 7n),
    ).toBeUndefined();
  });

  it("reads a fee-bump envelope", () => {
    const bumped = transaction([entry(9n)], [nonceCreated(payer, 9n)], true);
    expect(authorizationEntryIn(bumped.envelopeXdr, payer, 9n)).toBeDefined();
    expect(consumedAuthorization(bumped, payer, 9n)).toBeDefined();
  });

  it("refuses to read a meta version it does not know as 'not consumed'", () => {
    const known = transaction([entry(7n)], [nonceCreated(payer, 7n)]);
    const future = {
      ...known,
      resultMetaXdr: { switch: () => 5 } as unknown as xdr.TransactionMeta,
    } as rpc.Api.GetSuccessfulTransactionResponse;
    expect(() => consumedNonceIn(future, payer, 7n)).toThrow(UnsupportedMetaError);
    expect(() => consumedAuthorization(future, payer, 7n)).toThrow(UnsupportedMetaError);
  });
});
