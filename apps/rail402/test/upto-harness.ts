/**
 * Shared fixtures for the `upto` suites that run the whole Rail402 service (in-process app, Postgres,
 * the private Stellar network): the service configured for a per-run settlement contract, payers of
 * every kind (`G…`, a simple custom account, an OpenZeppelin smart account), payments signed through
 * the `@rail402.dev/upto` client or built by hand, tampering that keeps the original signature, the
 * HTTP calls, and the balance and event assertions that prove the facilitator never holds funds.
 */
import { randomBytes } from "node:crypto";
import { expect } from "vitest";
import { Address, type Keypair, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { createEd25519Signer, type ClientStellarSigner } from "@x402/stellar";
import { deriveAuthorityKeypair, deriveChannelKeypairs } from "@rail402.dev/facilitator";
import {
  decodeAuthorizationEntry,
  encodeAuthorizationEntry,
  expirationLedgerFor,
  termsFromScVal,
  unsignedPayerEntry,
  type UptoCredential,
  type UptoTerms,
} from "@rail402.dev/upto";
import { UptoStellarScheme as UptoClient } from "@rail402.dev/upto/client";
import {
  accountSigner,
  addressCredentialsOf,
  type EntrySigner,
  type IssuedAsset,
  type LocalNetwork,
  type LocalUptoContract,
} from "@rail402.dev/testkit";
import { startService, type RunningService, type ServiceOptions } from "./service-harness.ts";

export const NETWORK = "stellar:testnet" as const;
/** The cap of most payments in these suites, in base units. */
export const CAP = 1_000_000n;
/** Seconds per ledger the clients assume; suites pin the service's Horizon estimate to the same. */
export const LEDGER_SECONDS = 5;
/** Channels the service runs (service-harness default). */
export const CHANNELS = 4;

export interface UptoService extends RunningService {
  readonly contract: LocalUptoContract;
  /** The settlement authority derived from the service's sponsor. */
  readonly authority: Keypair;
  readonly channels: readonly Keypair[];
}

/** The service's `upto` settings for a contract deployed by the suite. */
export function uptoEnv(contract: LocalUptoContract): Record<string, string> {
  return {
    TESTNET_UPTO_ENABLED: "true",
    TESTNET_UPTO_CONTRACT: contract.address,
    TESTNET_UPTO_WASM_HASH: contract.wasmHash,
    TESTNET_UPTO_TTL_KEEPER: "false",
    // The public networks' ledger time, which the buyers in these tests assume too.
    TESTNET_UPTO_LEDGER_SECONDS: String(LEDGER_SECONDS),
    BAZAAR_ENABLED: "false",
    SEARCH_EMBEDDINGS: "false",
  };
}

/** Starts the service with `upto` on for `contract`. */
export async function startUptoService(
  net: LocalNetwork,
  usdc: IssuedAsset,
  contract: LocalUptoContract,
  env: Record<string, string> = {},
  options: ServiceOptions = {},
): Promise<UptoService> {
  const service = await startService(net, usdc, { ...uptoEnv(contract), ...env }, options);
  // Startup provisions the authority before the service listens.
  const authority = deriveAuthorityKeypair(service.sponsor, NETWORK);
  return {
    ...service,
    contract,
    authority,
    channels: deriveChannelKeypairs(service.sponsor, NETWORK, CHANNELS),
  };
}

/** Someone who pays: an address and how its entries are signed. */
export interface Payer {
  readonly address: string;
  readonly sign: EntrySigner;
  /** The stock client signer of a `G…` payer; contract accounts sign through `sign`. */
  readonly clientSigner?: ClientStellarSigner;
  /** Signs in place of `sign` when the account also needs its delegated signers' entries. */
  readonly authorize?: (
    entry: xdr.SorobanAuthorizationEntry,
    passphrase: string,
  ) => Promise<{
    readonly authorization: xdr.SorobanAuthorizationEntry;
    readonly signerAuthorizations: readonly xdr.SorobanAuthorizationEntry[];
  }>;
}

export function accountPayer(keypair: Keypair): Payer {
  return {
    address: keypair.publicKey(),
    sign: accountSigner(keypair),
    clientSigner: createEd25519Signer(keypair.secret(), NETWORK),
  };
}

export function contractPayer(address: string, sign: EntrySigner): Payer {
  return { address, sign };
}

export function uptoRequirements(options: {
  readonly asset: string;
  readonly payTo: string;
  readonly authority: string;
  readonly amount?: bigint;
  readonly maxTimeoutSeconds?: number;
}): PaymentRequirements {
  return {
    scheme: "upto",
    network: NETWORK,
    amount: (options.amount ?? CAP).toString(),
    asset: options.asset,
    payTo: options.payTo,
    maxTimeoutSeconds: options.maxTimeoutSeconds ?? 120,
    extra: { areFeesSponsored: true, facilitatorAddress: options.authority },
  };
}

/** The same requirements for a different amount: the settle-time amount, or a different cap. */
export function withAmount(requirements: PaymentRequirements, amount: bigint): PaymentRequirements {
  return { ...requirements, amount: amount.toString() };
}

/**
 * A payment through the `@rail402.dev/upto` client, as a buyer makes one: `G…` payers with the stock
 * ed25519 signer, contract accounts through their entry signer.
 */
export async function uptoPayment(
  net: LocalNetwork,
  options: {
    readonly contract: string;
    readonly payer: Payer;
    readonly accepted: PaymentRequirements;
    readonly authV2?: boolean;
    readonly ledgerSeconds?: number;
    readonly resource?: PaymentPayload["resource"];
  },
): Promise<PaymentPayload> {
  const { payer, accepted } = options;
  const signer: ClientStellarSigner = payer.clientSigner ?? {
    address: payer.address,
    signAuthEntry: () => Promise.reject(new Error("contract accounts sign through authorizeEntry")),
  };
  const client = new UptoClient(signer, {
    rpcConfig: { url: net.rpcUrl },
    contracts: options.contract,
    ledgerSeconds: options.ledgerSeconds ?? LEDGER_SECONDS,
    authV2: options.authV2 ?? false,
    ...(payer.clientSigner === undefined
      ? {
          authorizeEntry: (entry, context) =>
            payer.authorize === undefined
              ? payer.sign(entry, context.networkPassphrase)
              : payer.authorize(entry, context.networkPassphrase),
        }
      : {}),
  });
  const created = await client.createPaymentPayload(2, accepted);
  return {
    x402Version: 2,
    resource: options.resource ?? { url: "https://seller.example/metered" },
    accepted,
    payload: created.payload,
  };
}

/**
 * A payment whose terms the test chooses (e.g. a start ledger, or an expiration outside what the
 * client would pick), signed properly by the payer.
 */
export async function signedPayment(
  net: LocalNetwork,
  options: {
    readonly contract: string;
    readonly payer: Payer;
    readonly accepted: PaymentRequirements;
    readonly terms?: Partial<UptoTerms>;
    readonly nonce?: bigint;
    readonly credential?: UptoCredential;
  },
): Promise<PaymentPayload> {
  const { accepted } = options;
  const extra = accepted.extra as { facilitatorAddress: string };
  const latest = await net.latestLedger();
  const terms: UptoTerms = {
    expirationLedger: expirationLedgerFor(latest, accepted.maxTimeoutSeconds, LEDGER_SECONDS),
    facilitator: extra.facilitatorAddress,
    maxAmount: BigInt(accepted.amount),
    recipient: accepted.payTo,
    token: accepted.asset,
    validAfterLedger: 0,
    ...options.terms,
  };
  const entry = unsignedPayerEntry({
    contract: options.contract,
    payer: options.payer.address,
    terms,
    nonce: options.nonce ?? randomNonce(),
    credential: options.credential ?? "address",
  });
  const signed = await options.payer.sign(entry, net.passphrase);
  return {
    x402Version: 2,
    resource: { url: "https://seller.example/metered" },
    accepted,
    payload: { authorization: encodeAuthorizationEntry(signed) },
  };
}

export function authorizationOf(payload: PaymentPayload): xdr.SorobanAuthorizationEntry {
  return decodeAuthorizationEntry((payload.payload as { authorization: string }).authorization);
}

/** The signed terms of a payment. */
export function termsOf(payload: PaymentPayload): UptoTerms {
  const [argument] = authorizationOf(payload).rootInvocation().function().contractFn().args();
  const terms = argument === undefined ? undefined : termsFromScVal(argument);
  if (terms === undefined) throw new Error("not an upto authorization");
  return terms;
}

/** A copy of `payload` whose entry `edit` changed in place (the signature stays as it was). */
export function editEntry(
  payload: PaymentPayload,
  edit: (entry: xdr.SorobanAuthorizationEntry) => void,
  accepted: PaymentRequirements = payload.accepted,
): PaymentPayload {
  const entry = authorizationOf(payload);
  edit(entry);
  return { ...payload, accepted, payload: { authorization: encodeAuthorizationEntry(entry) } };
}

/**
 * A consistent forgery: the entry rebuilt for `edit(terms)` — root, `approve` child and credential
 * expiration all agreeing — with the original nonce and signature, and the requirements the payer
 * accepted changed to match. Only the signature can tell it apart from a genuine payment.
 */
export function forgeTerms(
  payload: PaymentPayload,
  contract: string,
  edit: (terms: UptoTerms) => UptoTerms,
  accepted: PaymentRequirements = payload.accepted,
): PaymentPayload {
  const original = authorizationOf(payload);
  const credentials = addressCredentialsOf(original);
  const forged = unsignedPayerEntry({
    contract,
    payer: Address.fromScAddress(credentials.address()).toString(),
    terms: edit(termsOf(payload)),
    nonce: credentials.nonce().toBigInt(),
    credential:
      original.credentials().switch() === xdr.SorobanCredentialsType.sorobanCredentialsAddressV2()
        ? "address_v2"
        : "address",
  });
  addressCredentialsOf(forged).signature(credentials.signature());
  return { ...payload, accepted, payload: { authorization: encodeAuthorizationEntry(forged) } };
}

export interface Posted {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/** POSTs `/verify` or `/settle` with `requirements` (the cap at verify, the amount at settle). */
export async function post(
  url: string,
  path: "/verify" | "/settle",
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): Promise<Posted> {
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: requirements }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** The rejection code of a verify or settle answer, whichever field carries it. */
export function codeOf(posted: Posted): unknown {
  return posted.body["invalidReason"] ?? posted.body["errorReason"];
}

/** Token and XLM balances of everyone a settlement could touch. */
export interface Custody {
  readonly payer: bigint;
  readonly recipient: bigint;
  /** Token balances of the sponsor, the authority, every channel and the settlement contract. */
  readonly facilitatorTokens: readonly bigint[];
  readonly authorityXlm: bigint;
  readonly channelXlm: readonly bigint[];
  readonly sponsorXlm: bigint;
}

export async function custody(
  net: LocalNetwork,
  service: UptoService,
  token: string,
  payer: string,
  recipient: string,
): Promise<Custody> {
  const balance = (address: string) => net.tokenBalance(token, address);
  const facilitator = [service.sponsor, service.authority, ...service.channels].map((keypair) =>
    keypair.publicKey(),
  );
  return {
    payer: await balance(payer),
    recipient: await balance(recipient),
    facilitatorTokens: await Promise.all([...facilitator, service.contract.address].map(balance)),
    authorityXlm: await net.nativeBalance(service.authority.publicKey()),
    channelXlm: await Promise.all(service.channels.map((channel) => net.nativeBalance(channel.publicKey()))),
    sponsorXlm: await net.nativeBalance(service.sponsor.publicKey()),
  };
}

/** A contract event of a settlement transaction, decoded. */
export interface SettlementEvent {
  readonly contract: string;
  readonly name: string;
  readonly topics: readonly unknown[];
  readonly data: unknown;
}

/** The outcome of a settlement transaction on the network: its fee and its contract events. */
export async function settlementOnChain(
  net: LocalNetwork,
  transaction: string,
): Promise<{ readonly feeCharged: bigint; readonly events: readonly SettlementEvent[] }> {
  const result = await net.server.getTransaction(transaction);
  if (result.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`transaction ${transaction} is ${result.status}`);
  }
  const events = result.events.contractEventsXdr.flat().map((event) => {
    const body = event.body().v0();
    const [name, ...topics] = body.topics().map((topic) => scValToNative(topic) as unknown);
    const id = event.contractId();
    return {
      contract: id === null ? "" : Address.contract(id as unknown as Buffer).toString(),
      name: String(name),
      topics,
      data: scValToNative(body.data()) as unknown,
    };
  });
  return { feeCharged: result.resultXdr.feeCharged().toBigInt(), events };
}

const BALANCE_EVENTS = new Set(["transfer", "mint", "burn", "clawback"]);

/**
 * Asserts one settlement of `amount` from `payer` to `recipient` in `token`, and nothing else: the
 * payer lost exactly `amount`, the recipient gained it, no facilitator account or the contract holds
 * any token, the authority's and the channels' XLM did not move, and the sponsor paid exactly the fee
 * the network charged. On-chain, the only balance change is `transfer(payer → recipient, amount)`
 * (none for zero) and exactly one `upto_settled` names the payment. Returns the fee.
 */
export async function expectSettledOnce(
  net: LocalNetwork,
  options: {
    readonly service: UptoService;
    readonly token: string;
    readonly payer: string;
    readonly recipient: string;
    readonly amount: bigint;
    readonly cap: bigint;
    readonly transaction: string;
    readonly before: Custody;
  },
): Promise<bigint> {
  const { service, token, payer, recipient, amount, before } = options;
  const after = await custody(net, service, token, payer, recipient);
  const { feeCharged, events } = await settlementOnChain(net, options.transaction);

  expect(after.payer).toBe(before.payer - amount);
  expect(after.recipient).toBe(before.recipient + amount);
  expect(after.facilitatorTokens.every((balance) => balance === 0n)).toBe(true);
  expect(after.authorityXlm).toBe(before.authorityXlm);
  expect(after.channelXlm).toEqual(before.channelXlm);
  expect(before.sponsorXlm - after.sponsorXlm).toBe(feeCharged);

  const balanceChanges = events.filter((event) => BALANCE_EVENTS.has(event.name));
  if (amount === 0n) {
    expect(balanceChanges).toEqual([]);
  } else {
    expect(balanceChanges).toHaveLength(1);
    const [transfer] = balanceChanges;
    expect(transfer?.contract).toBe(token);
    expect(transfer?.name).toBe("transfer");
    expect(transfer?.topics.slice(0, 2)).toEqual([payer, recipient]);
    expect(amountOf(transfer?.data)).toBe(amount);
  }
  const settled = events.filter((event) => event.name === "upto_settled");
  expect(settled).toHaveLength(1);
  expect(settled[0]).toMatchObject({
    contract: service.contract.address,
    topics: [payer, recipient],
    data: {
      amount,
      max_amount: options.cap,
      token,
      facilitator: service.authority.publicKey(),
    },
  });
  return feeCharged;
}

/** A transfer event's amount: an `i128`, or `{ amount, to_muxed_id }`. */
function amountOf(data: unknown): bigint | undefined {
  if (typeof data === "bigint") return data;
  if (typeof data === "object" && data !== null && "amount" in data) return data.amount as bigint;
  return undefined;
}

function randomNonce(): bigint {
  return BigInt.asIntN(64, randomBytes(8).readBigUInt64BE());
}
