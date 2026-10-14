import {
  Account,
  Address,
  Keypair,
  Networks,
  SorobanDataBuilder,
  StrKey,
  authorizeEntry,
  hash,
  nativeToScVal,
  rpc,
  xdr,
  type FeeBumpTransaction,
  type Transaction,
} from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { USDC_TESTNET_ADDRESS, createEd25519Signer } from "@x402/stellar";
import { encodeAuthorizationEntry, unsignedPayerEntry, type UptoTerms } from "@rail402.dev/upto";
import type { UptoRpc } from "@rail402.dev/upto/facilitator";

export const PASSPHRASE = Networks.TESTNET;
export const NETWORK = "stellar:testnet" as const;
export const LEDGER = 1_000;
export const LEDGER_SECONDS = 5;
export const TOKEN = USDC_TESTNET_ADDRESS;
export const CONTRACT = StrKey.encodeContract(hash(Buffer.from("upto unit tests: settlement contract")));

export const payer = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 21));
export const authority = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 22));
export const recipient = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 23));
export const channel = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 24));
export const sponsor = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 25));

export const authoritySigner = createEd25519Signer(authority.secret(), NETWORK);
export const channelSigner = createEd25519Signer(channel.secret(), NETWORK);
export const sponsorSigner = createEd25519Signer(sponsor.secret(), NETWORK);

export const CAP = 1_000_000n;

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

export async function signedAuthorization(
  options: { terms?: UptoTerms; key?: Keypair; nonce?: bigint; credential?: "address" | "address_v2" } = {},
): Promise<string> {
  const key = options.key ?? payer;
  const t = options.terms ?? terms();
  const entry = unsignedPayerEntry({
    contract: CONTRACT,
    payer: key.publicKey(),
    terms: t,
    nonce: options.nonce ?? nextNonce++,
    credential: options.credential ?? "address",
  });
  return encodeAuthorizationEntry(await authorizeEntry(entry, key, t.expirationLedger, PASSPHRASE));
}

export async function payment(
  options: {
    requirements?: PaymentRequirements;
    authorization?: string;
    signerAuthorizations?: string[];
  } = {},
): Promise<PaymentPayload> {
  const accepted = options.requirements ?? requirements();
  return {
    x402Version: 2,
    resource: { url: "https://seller.example/metered", description: "", mimeType: "application/json" },
    accepted,
    payload: {
      authorization: options.authorization ?? (await signedAuthorization()),
      ...(options.signerAuthorizations === undefined
        ? {}
        : { signerAuthorizations: options.signerAuthorizations }),
    },
  };
}

function contractId(contract: string): Buffer {
  return Address.fromString(contract).toBuffer();
}

export function contractEvent(
  contract: string,
  topics: xdr.ScVal[],
  data: xdr.ScVal,
  inSuccessfulContractCall = true,
): xdr.DiagnosticEvent {
  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall,
    event: new xdr.ContractEvent({
      ext: new xdr.ExtensionPoint(0),
      contractId: contractId(contract) as unknown as xdr.ContractId,
      type: xdr.ContractEventType.contract(),
      body: new xdr.ContractEventBody(0, new xdr.ContractEventV0({ topics, data })),
    }),
  });
}

export function errorEvent(
  contract: string | undefined,
  error: xdr.ScError,
  message = "error",
): xdr.DiagnosticEvent {
  return new xdr.DiagnosticEvent({
    inSuccessfulContractCall: false,
    event: new xdr.ContractEvent({
      ext: new xdr.ExtensionPoint(0),
      contractId: contract === undefined ? null : (contractId(contract) as unknown as xdr.ContractId),
      type: xdr.ContractEventType.diagnostic(),
      body: new xdr.ContractEventBody(
        0,
        new xdr.ContractEventV0({
          topics: [xdr.ScVal.scvSymbol("error"), xdr.ScVal.scvError(error)],
          data: xdr.ScVal.scvVec([xdr.ScVal.scvString(message)]),
        }),
      ),
    }),
  });
}

export const address = (value: string) => nativeToScVal(value, { type: "address" });
export const i128 = (value: bigint) => nativeToScVal(value, { type: "i128" });
const sym = (value: string) => xdr.ScVal.scvSymbol(value);
const map = (fields: Record<string, xdr.ScVal>) =>
  xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map((key) => new xdr.ScMapEntry({ key: sym(key), val: fields[key] ?? xdr.ScVal.scvVoid() })),
  );

/** The events a successful settlement of `amount` emits, in the Stellar Asset Contract shape. */
export function settlementEvents(
  amount: bigint,
  options: { payer?: string; cap?: bigint; shape?: "sac" | "sep41" } = {},
): xdr.DiagnosticEvent[] {
  const from = options.payer ?? payer.publicKey();
  const cap = options.cap ?? CAP;
  const events: xdr.DiagnosticEvent[] = [];
  if (amount > 0n) {
    if (options.shape === "sep41") {
      events.push(
        contractEvent(
          TOKEN,
          [sym("approve"), address(from), address(CONTRACT)],
          map({ amount: i128(cap), live_until_ledger: xdr.ScVal.scvU32(LEDGER + 12) }),
        ),
        contractEvent(
          TOKEN,
          [sym("transfer"), address(from), address(recipient.publicKey())],
          map({ amount: i128(amount), to_muxed_id: xdr.ScVal.scvVoid() }),
        ),
      );
    } else {
      events.push(
        contractEvent(
          TOKEN,
          [sym("approve"), address(from), address(CONTRACT), xdr.ScVal.scvString("USDC:ISSUER")],
          xdr.ScVal.scvVec([i128(cap), xdr.ScVal.scvU32(LEDGER + 12)]),
        ),
        contractEvent(
          TOKEN,
          [
            sym("transfer"),
            address(from),
            address(recipient.publicKey()),
            xdr.ScVal.scvString("USDC:ISSUER"),
          ],
          i128(amount),
        ),
      );
    }
  }
  events.push(settledEvent(amount, { payer: from, cap }));
  return events;
}

export function settledEvent(
  amount: bigint,
  options: { payer?: string; cap?: bigint; facilitator?: string; token?: string } = {},
): xdr.DiagnosticEvent {
  return contractEvent(
    CONTRACT,
    [sym("upto_settled"), address(options.payer ?? payer.publicKey()), address(recipient.publicKey())],
    map({
      amount: i128(amount),
      facilitator: address(options.facilitator ?? authority.publicKey()),
      max_amount: i128(options.cap ?? CAP),
      token: address(options.token ?? TOKEN),
    }),
  );
}

export function successSimulation(
  events: xdr.DiagnosticEvent[],
  options: { minResourceFee?: number; data?: xdr.SorobanTransactionData } = {},
): rpc.Api.SimulateTransactionSuccessResponse {
  const fee = options.minResourceFee ?? 150_000;
  const builder =
    options.data === undefined
      ? new SorobanDataBuilder().setResourceFee(fee)
      : new SorobanDataBuilder(options.data);
  return {
    id: "1",
    latestLedger: LEDGER,
    events,
    _parsed: true,
    transactionData: builder,
    minResourceFee: String(fee),
    result: { auth: [], retval: xdr.ScVal.scvVoid() },
  };
}

export function errorSimulation(
  events: xdr.DiagnosticEvent[],
  error = "HostError",
): rpc.Api.SimulateTransactionErrorResponse {
  return { id: "1", latestLedger: LEDGER, events, _parsed: true, error };
}

/** A scripted RPC: records what the mechanism sends and answers from queues. */
export class FakeRpc implements UptoRpc {
  ledger = LEDGER;
  simulations: rpc.Api.SimulateTransactionResponse[] = [];
  defaultSimulation: ((transaction: Transaction) => rpc.Api.SimulateTransactionResponse) | undefined;
  simulated: Transaction[] = [];
  sent: (Transaction | FeeBumpTransaction)[] = [];
  sendStatus: rpc.Api.SendTransactionStatus = "PENDING";
  statuses: rpc.Api.GetTransactionResponse["status"][] = [];
  failedResult: xdr.TransactionResult | undefined;
  /** The oldest ledger the RPC retains, as `getTransaction` reports it. */
  oldestLedger = 1;

  getLatestLedger() {
    return Promise.resolve({ id: "x", sequence: this.ledger, protocolVersion: 28 });
  }

  getAccount(address: string) {
    return Promise.resolve(new Account(address, "100"));
  }

  simulateTransaction(transaction: Transaction) {
    this.simulated.push(transaction);
    const next = this.simulations.shift() ?? this.defaultSimulation?.(transaction);
    if (next === undefined) throw new Error("no simulation scripted");
    return Promise.resolve(next);
  }

  sendTransaction(transaction: Transaction | FeeBumpTransaction) {
    this.sent.push(transaction);
    return Promise.resolve({
      status: this.sendStatus,
      hash: transaction.hash().toString("hex"),
      latestLedger: this.ledger,
      latestLedgerCloseTime: 0,
    } as rpc.Api.SendTransactionResponse);
  }

  getTransaction(_hash: string) {
    const status = this.statuses.shift() ?? rpc.Api.GetTransactionStatus.SUCCESS;
    return Promise.resolve({
      status,
      latestLedger: this.ledger,
      oldestLedger: this.oldestLedger,
      resultXdr: this.failedResult,
    } as unknown as rpc.Api.GetTransactionResponse);
  }
}
