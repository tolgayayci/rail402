/**
 * Offline fixtures for Rail402's `upto` tests: a sponsor with its derived channel and settlement
 * authority, payer authorizations built with the `@rail402.dev/upto` codec, the events a correct
 * settlement simulates to, and a scripted RPC server.
 */
import {
  Account,
  Address,
  Keypair,
  Networks,
  SorobanDataBuilder,
  StrKey,
  hash,
  nativeToScVal,
  type rpc,
  xdr,
  type FeeBumpTransaction,
  type Transaction,
} from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { USDC_TESTNET_ADDRESS } from "@x402/stellar";
import {
  acceptedAsset,
  deriveAuthorityKeypair,
  deriveChannelKeypair,
  type NetworkPolicy,
  type UptoPolicy,
} from "@rail402.dev/facilitator";
import {
  encodeAuthorizationEntry,
  unsignedPayerEntry,
  type UptoCredential,
  type UptoTerms,
} from "@rail402.dev/upto";

export const NETWORK = "stellar:testnet" as const;
export const PASSPHRASE = Networks.TESTNET;
export const LEDGER = 1_000;
export const LEDGER_SECONDS = 5;
export const TOKEN = USDC_TESTNET_ADDRESS;
export const CONTRACT = StrKey.encodeContract(hash(Buffer.from("rail402 upto tests: settlement contract")));
export const CAP = 1_000_000n;

export const sponsor = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 41));
export const authority = deriveAuthorityKeypair(sponsor, NETWORK);
export const channel = deriveChannelKeypair(sponsor, NETWORK, 0);
export const payer = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 42));
export const recipient = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 43));

export const policy: NetworkPolicy = {
  network: NETWORK,
  assets: new Map([
    [TOKEN, acceptedAsset({ contract: TOKEN, symbol: "USDC", decimals: 7 }, { maxAmount: 100_000_000n })],
  ]),
  timeoutSeconds: { min: 10, max: 300 },
  expirationMarginLedgers: 2,
  maxTransactionFeeStroops: 300_000,
  inclusionFeeStroops: 100,
};

export const uptoPolicy: UptoPolicy = {
  contract: CONTRACT,
  contractWasmHash: "ab".repeat(32),
  zeroSettlement: "onchain",
  maxTransactionFeeStroops: 500_000,
  ledgerSeconds: LEDGER_SECONDS,
};

export function requirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "upto",
    network: NETWORK,
    amount: CAP.toString(),
    asset: TOKEN,
    payTo: recipient.publicKey(),
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: true, facilitatorAddress: authority.publicKey() },
    ...overrides,
  };
}

export function terms(overrides: Partial<UptoTerms> = {}): UptoTerms {
  return {
    expirationLedger: LEDGER + 12,
    facilitator: authority.publicKey(),
    maxAmount: CAP,
    recipient: recipient.publicKey(),
    token: TOKEN,
    validAfterLedger: 0,
    ...overrides,
  };
}

let nextNonce = 1n;

/** A fresh nonce for every authorization, so tests never share a settlement key by accident. */
export function freshNonce(): bigint {
  return nextNonce++;
}

/**
 * A payer entry for `settle(terms)` with a placeholder signature. The static rules only check that a
 * signature is present; the network verifies it.
 */
export function entry(
  options: {
    readonly terms?: UptoTerms;
    readonly payer?: string;
    readonly contract?: string;
    readonly nonce?: bigint;
    readonly credential?: UptoCredential;
    readonly signed?: boolean;
  } = {},
): xdr.SorobanAuthorizationEntry {
  const built = unsignedPayerEntry({
    contract: options.contract ?? CONTRACT,
    payer: options.payer ?? payer.publicKey(),
    terms: options.terms ?? terms(),
    nonce: options.nonce ?? freshNonce(),
    credential: options.credential ?? "address",
  });
  if (options.signed !== false) {
    const credentials = built.credentials();
    const address =
      credentials.switch() === xdr.SorobanCredentialsType.sorobanCredentialsAddressV2()
        ? credentials.addressV2()
        : credentials.address();
    address.signature(xdr.ScVal.scvVec([xdr.ScVal.scvMap([])]));
  }
  return built;
}

export function payment(
  options: {
    readonly accepted?: PaymentRequirements;
    readonly authorization?: string | xdr.SorobanAuthorizationEntry;
    readonly signerAuthorizations?: readonly string[];
  } = {},
): PaymentPayload {
  const authorization = options.authorization ?? entry();
  return {
    x402Version: 2,
    resource: { url: "https://seller.example/metered", description: "", mimeType: "application/json" },
    accepted: options.accepted ?? requirements(),
    payload: {
      authorization:
        typeof authorization === "string" ? authorization : encodeAuthorizationEntry(authorization),
      ...(options.signerAuthorizations === undefined
        ? {}
        : { signerAuthorizations: options.signerAuthorizations }),
    },
  };
}

const sym = (value: string) => xdr.ScVal.scvSymbol(value);
const address = (value: string) => nativeToScVal(value, { type: "address" });
const i128 = (value: bigint) => nativeToScVal(value, { type: "i128" });
const map = (fields: Record<string, xdr.ScVal>) =>
  xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map((key) => new xdr.ScMapEntry({ key: sym(key), val: fields[key] ?? xdr.ScVal.scvVoid() })),
  );

export function contractEvent(contract: string, topics: xdr.ScVal[], data: xdr.ScVal): xdr.DiagnosticEvent {
  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: true,
    event: new xdr.ContractEvent({
      ext: new xdr.ExtensionPoint(0),
      contractId: Address.fromString(contract).toBuffer() as unknown as xdr.ContractId,
      type: xdr.ContractEventType.contract(),
      body: new xdr.ContractEventBody(0, new xdr.ContractEventV0({ topics, data })),
    }),
  });
}

/** A host error as a diagnostic event, e.g. `Error(Auth, ExistingValue)`, raised by `contract` if given. */
export function errorEvent(error: xdr.ScError, message = "error", contract?: string): xdr.DiagnosticEvent {
  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: false,
    event: new xdr.ContractEvent({
      ext: new xdr.ExtensionPoint(0),
      contractId:
        contract === undefined
          ? null
          : (Address.fromString(contract).toBuffer() as unknown as xdr.ContractId),
      type: xdr.ContractEventType.diagnostic(),
      body: new xdr.ContractEventBody(
        0,
        new xdr.ContractEventV0({
          topics: [sym("error"), xdr.ScVal.scvError(error)],
          data: xdr.ScVal.scvVec([xdr.ScVal.scvString(message)]),
        }),
      ),
    }),
  });
}

/** The events a correct settlement of `amount` by `from` simulates to (Stellar Asset Contract shape). */
export function settlementEvents(amount: bigint, from = payer.publicKey()): xdr.DiagnosticEvent[] {
  const events: xdr.DiagnosticEvent[] = [];
  if (amount > 0n) {
    events.push(
      contractEvent(
        TOKEN,
        [sym("transfer"), address(from), address(recipient.publicKey()), xdr.ScVal.scvString("USDC:ISSUER")],
        i128(amount),
      ),
    );
  }
  events.push(
    contractEvent(
      CONTRACT,
      [sym("upto_settled"), address(from), address(recipient.publicKey())],
      map({
        amount: i128(amount),
        facilitator: address(authority.publicKey()),
        max_amount: i128(CAP),
        token: address(TOKEN),
      }),
    ),
  );
  return events;
}

export function successSimulation(
  events: xdr.DiagnosticEvent[],
  options: { readonly minResourceFee?: number; readonly data?: xdr.SorobanTransactionData } = {},
): rpc.Api.SimulateTransactionSuccessResponse {
  const fee = options.minResourceFee ?? 150_000;
  return {
    id: "1",
    latestLedger: LEDGER,
    events,
    _parsed: true,
    transactionData:
      options.data === undefined
        ? new SorobanDataBuilder().setResourceFee(fee)
        : new SorobanDataBuilder(options.data),
    minResourceFee: String(fee),
    result: { auth: [], retval: xdr.ScVal.scvVoid() },
  };
}

export function errorSimulation(events: xdr.DiagnosticEvent[]): rpc.Api.SimulateTransactionErrorResponse {
  return { id: "1", latestLedger: LEDGER, events, _parsed: true, error: "HostError" };
}

/** The amount a simulated `settle(payer, terms, amount)` transaction settles. */
export function settledAmountOf(transaction: Transaction): bigint {
  const operation = transaction.operations[0];
  if (operation?.type !== "invokeHostFunction") throw new Error("not a settlement");
  const amount = operation.func.invokeContract().args()[2];
  if (amount === undefined) throw new Error("no amount");
  const parts = amount.i128();
  return (parts.hi().toBigInt() << 64n) | parts.lo().toBigInt();
}

/**
 * A scripted RPC server: every simulation answers with the events a correct settlement of the
 * simulated amount emits unless `simulate` says otherwise; submissions are accepted and succeed.
 */
export class FakeServer {
  ledger = LEDGER;
  simulate: (transaction: Transaction) => rpc.Api.SimulateTransactionResponse = (transaction) =>
    successSimulation(settlementEvents(settledAmountOf(transaction)));
  readonly simulated: Transaction[] = [];
  readonly sent: (Transaction | FeeBumpTransaction)[] = [];
  /** Accounts that exist, for `getLedgerEntries`; every account exists when undefined. */
  accounts: Set<string> | undefined;
  status: "SUCCESS" | "FAILED" | "NOT_FOUND" = "SUCCESS";
  /** Diagnostic events of a FAILED transaction. */
  failureEvents: xdr.DiagnosticEvent[] = [];
  /** Close time (unix seconds) of the latest ledger, as `getTransaction` reports it. */
  latestLedgerCloseTime = 0;
  /** The ledger that consumed payer nonces, for `getLedgerEntries` on a nonce key. */
  nonceConsumedIn: number | undefined;
  /** The latest ledger `getLedgerEntries` reports; `ledger` when undefined (an RPC behind a balancer can differ). */
  entriesLedger: number | undefined;
  /** What `getTransactions` lists. */
  transactions: rpc.Api.TransactionInfo[] = [];
  /** `getTransaction` answers for particular hashes; every other hash answers from `status`. */
  readonly byHash = new Map<string, rpc.Api.GetTransactionResponse>();
  /** Close time (unix seconds) of the oldest ledger the RPC retains, as `getTransaction` reports it. */
  oldestLedgerCloseTime = 0;
  /** What `sendTransaction` answers; `PENDING` when undefined. */
  sendResult: rpc.Api.SendTransactionResponse | undefined;

  getHealth() {
    return Promise.resolve({
      status: "healthy",
      latestLedger: this.ledger,
      oldestLedger: 1,
      ledgerRetentionWindow: 17_280,
    });
  }

  getAccount(address: string) {
    return Promise.resolve(new Account(address, "100"));
  }

  simulateTransaction(transaction: Transaction) {
    this.simulated.push(transaction);
    return Promise.resolve(this.simulate(transaction));
  }

  sendTransaction(transaction: Transaction | FeeBumpTransaction) {
    this.sent.push(transaction);
    if (this.sendResult !== undefined) return Promise.resolve(this.sendResult);
    return Promise.resolve({
      status: "PENDING",
      hash: transaction.hash().toString("hex"),
      latestLedger: this.ledger,
      latestLedgerCloseTime: 0,
    } as rpc.Api.SendTransactionResponse);
  }

  getTransaction(hash: string) {
    const answer = this.byHash.get(hash);
    if (answer !== undefined) return Promise.resolve(answer);
    return Promise.resolve({
      status: this.status,
      ledger: this.ledger,
      latestLedger: this.ledger,
      latestLedgerCloseTime: this.latestLedgerCloseTime,
      oldestLedger: 1,
      oldestLedgerCloseTime: this.oldestLedgerCloseTime,
      ...(this.status === "FAILED" ? { diagnosticEventsXdr: this.failureEvents } : {}),
    } as unknown as rpc.Api.GetTransactionResponse);
  }

  getTransactions(_request: unknown) {
    return Promise.resolve({
      transactions: this.transactions,
      latestLedger: this.ledger,
      latestLedgerCloseTimestamp: 0,
      oldestLedger: 1,
      oldestLedgerCloseTimestamp: 0,
      cursor: "",
    });
  }

  getLedgerEntries(...keys: xdr.LedgerKey[]) {
    const nonces = keys
      .filter(
        (key) => key.switch() === xdr.LedgerEntryType.contractData() && this.nonceConsumedIn !== undefined,
      )
      .map((key) => ({
        key,
        val: xdr.LedgerEntryData.contractData(
          new xdr.ContractDataEntry({
            ext: new xdr.ExtensionPoint(0),
            contract: key.contractData().contract(),
            key: key.contractData().key(),
            durability: key.contractData().durability(),
            val: xdr.ScVal.scvVoid(),
          }),
        ),
        lastModifiedLedgerSeq: this.nonceConsumedIn,
      }));
    const entries = keys
      .filter((key) => key.switch() === xdr.LedgerEntryType.account())
      .map((key) => StrKey.encodeEd25519PublicKey(key.account().accountId().ed25519()))
      .filter((account) => this.accounts === undefined || this.accounts.has(account))
      .map((account) => ({
        key: xdr.LedgerKey.account(
          new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(account).xdrAccountId() }),
        ),
        val: xdr.LedgerEntryData.account(
          new xdr.AccountEntry({
            accountId: Keypair.fromPublicKey(account).xdrAccountId(),
            balance: xdr.Int64.fromString("0"),
            seqNum: xdr.Int64.fromString("1"),
            numSubEntries: 0,
            inflationDest: null,
            flags: 0,
            homeDomain: "",
            thresholds: Buffer.from([1, 0, 0, 0]),
            signers: [],
            ext: new xdr.AccountEntryExt(0),
          }),
        ),
      }));
    return Promise.resolve({
      entries: [...nonces, ...entries],
      latestLedger: this.entriesLedger ?? this.ledger,
    });
  }

  asServer(): rpc.Server {
    return this as unknown as rpc.Server;
  }
}
