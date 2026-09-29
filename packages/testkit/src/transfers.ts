import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  authorizeEntry,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";

export const PASSPHRASE = Networks.TESTNET;

export function randomContractId(): string {
  return StrKey.encodeContract(Keypair.random().rawPublicKey());
}

export interface TransferOptions {
  readonly payer?: Keypair;
  readonly asset?: string;
  readonly to?: string;
  readonly amount?: bigint;
  readonly nonce?: bigint;
  readonly expirationLedger?: number;
  /** Mutates the authorized invocation after it is copied from the operation, before signing. */
  readonly editAuthorizedCall?: (call: xdr.InvokeContractArgs) => xdr.InvokeContractArgs;
  readonly sign?: boolean;
  readonly credential?: "address" | "address_v2" | "source_account";
  readonly subInvocation?: boolean;
  readonly extraOperation?: boolean;
  readonly ledgerBounds?: { minLedger: number; maxLedger: number };
  /** Transaction source account; the payer by default. */
  readonly source?: string;
  /** Omits every authorization entry. */
  readonly noAuthorization?: boolean;
  /** Appends an address-credential entry for another account over the same invocation. */
  readonly extraAuthorization?: { readonly signer: Keypair; readonly sign: boolean };
}

/** Builds an x402 exact transfer transaction offline, as a stock client would after simulation. */
export async function buildTransfer(options: TransferOptions = {}) {
  const payer = options.payer ?? Keypair.random();
  const asset = options.asset ?? randomContractId();
  const to = options.to ?? Keypair.random().publicKey();
  const amount = options.amount ?? 1_234_567n;

  const call = new xdr.InvokeContractArgs({
    contractAddress: Address.fromString(asset).toScAddress(),
    functionName: "transfer",
    args: [
      nativeToScVal(payer.publicKey(), { type: "address" }),
      nativeToScVal(to, { type: "address" }),
      nativeToScVal(amount, { type: "i128" }),
    ],
  });

  const authorizedCall = options.editAuthorizedCall
    ? options.editAuthorizedCall(xdr.InvokeContractArgs.fromXDR(call.toXDR()))
    : call;
  const rootInvocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(authorizedCall),
    subInvocations: options.subInvocation
      ? [
          new xdr.SorobanAuthorizedInvocation({
            function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(authorizedCall),
            subInvocations: [],
          }),
        ]
      : [],
  });

  const addressCredentials = new xdr.SorobanAddressCredentials({
    address: Address.fromString(payer.publicKey()).toScAddress(),
    nonce: xdr.Int64.fromString(String(options.nonce ?? 42n)),
    signatureExpirationLedger: 0,
    signature: xdr.ScVal.scvVoid(),
  });
  const credentials =
    options.credential === "source_account"
      ? xdr.SorobanCredentials.sorobanCredentialsSourceAccount()
      : options.credential === "address_v2"
        ? xdr.SorobanCredentials.sorobanCredentialsAddressV2(addressCredentials)
        : xdr.SorobanCredentials.sorobanCredentialsAddress(addressCredentials);
  let entry = new xdr.SorobanAuthorizationEntry({ credentials, rootInvocation });

  const expiration = options.expirationLedger ?? 1_000;
  if (options.sign !== false && options.credential !== "source_account") {
    entry = await authorizeEntry(entry, payer, expiration, PASSPHRASE);
  }
  const entries = options.noAuthorization === true ? [] : [entry];
  if (options.extraAuthorization !== undefined) {
    const { signer, sign } = options.extraAuthorization;
    const extra = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: Address.fromString(signer.publicKey()).toScAddress(),
          nonce: xdr.Int64.fromString("7"),
          signatureExpirationLedger: 0,
          signature: xdr.ScVal.scvVoid(),
        }),
      ),
      rootInvocation,
    });
    entries.push(sign ? await authorizeEntry(extra, signer, expiration, PASSPHRASE) : extra);
  }

  const builder = new TransactionBuilder(new Account(options.source ?? payer.publicKey(), "100"), {
    fee: "100",
    networkPassphrase: PASSPHRASE,
    ...(options.ledgerBounds ? { ledgerbounds: options.ledgerBounds } : {}),
  })
    .setTimeout(60)
    .addOperation(
      Operation.invokeHostFunction({
        func: xdr.HostFunction.hostFunctionTypeInvokeContract(call),
        auth: entries,
      }),
    );
  if (options.extraOperation) builder.addOperation(Operation.bumpSequence({ bumpTo: "200" }));

  const transaction = builder.build();
  return { xdr: transaction.toXDR(), payer, asset, to, amount };
}

/** A diagnostic `error` event as the host emits it. */
export function errorEvent(options: {
  contract?: string;
  error: xdr.ScError;
  message?: string;
  args?: xdr.ScVal[];
}): xdr.DiagnosticEvent {
  const data =
    options.message === undefined
      ? xdr.ScVal.scvVoid()
      : options.args === undefined
        ? xdr.ScVal.scvString(options.message)
        : xdr.ScVal.scvVec([xdr.ScVal.scvString(options.message), ...options.args]);
  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: false,
    event: new xdr.ContractEvent({
      ext: new xdr.ExtensionPoint(0),
      contractId: options.contract ? Address.fromString(options.contract).toScAddress().contractId() : null,
      type: xdr.ContractEventType.diagnostic(),
      body: new xdr.ContractEventBody(
        0,
        new xdr.ContractEventV0({
          topics: [xdr.ScVal.scvSymbol("error"), xdr.ScVal.scvError(options.error)],
          data,
        }),
      ),
    }),
  });
}

export const contractError = (code: number) => xdr.ScError.sceContract(code);
export const authError = (code: xdr.ScErrorCode) => xdr.ScError.sceAuth(code);
export const cryptoError = (code: xdr.ScErrorCode) => xdr.ScError.sceCrypto(code);
export const address = (strkey: string) => nativeToScVal(strkey, { type: "address" });
