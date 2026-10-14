import {
  Account,
  Address,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  authorizeEntry,
  hash,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import type { ClientStellarSigner } from "@x402/stellar";
import { TESTNET, USDC } from "@rail402.dev/stellar";
import { randomContractId } from "@rail402.dev/testkit";
import {
  KeyHolder,
  exactScheme,
  type KeyValueStore,
  resolvePolicy,
  windowSpecFor,
  type LedgerClock,
  type ResolvedPolicy,
  type SpendingPolicyInput,
  type StellarSchemeAdapter,
} from "@rail402.dev/sdk";

export const usdc = USDC[TESTNET].contract;
export const LATEST = 10_000;

export const clock = (ledger = LATEST): LedgerClock & { reads: number } => {
  const reader = {
    reads: 0,
    read: () => {
      reader.reads++;
      return Promise.resolve(ledger);
    },
  };
  return reader;
};

export async function testPolicy(input: SpendingPolicyInput = {}): Promise<ResolvedPolicy> {
  return resolvePolicy(TESTNET, input, { requireCaps: true });
}

export const spec = (policy: ResolvedPolicy, payer: string, name = "default") =>
  windowSpecFor(policy, payer, { name });

export function requirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: TESTNET,
    asset: usdc,
    amount: "10000",
    payTo: Keypair.random().publicKey(),
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: true },
    ...overrides,
  };
}

export interface PreimageOptions {
  readonly payer: string;
  readonly asset?: string;
  readonly to: string;
  readonly amount: bigint;
  readonly fn?: string;
  readonly credential?: "address" | "address_v2";
  /** The address a V2 preimage is bound to; the payer by default. */
  readonly boundAddress?: string;
  readonly passphrase?: string;
  readonly expiration?: number;
  readonly nonce?: bigint;
  readonly subInvocations?: xdr.SorobanAuthorizedInvocation[];
  readonly args?: xdr.ScVal[];
}

export function invocation(options: PreimageOptions): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(options.asset ?? usdc).toScAddress(),
        functionName: options.fn ?? "transfer",
        args: options.args ?? [
          nativeToScVal(options.payer, { type: "address" }),
          nativeToScVal(options.to, { type: "address" }),
          nativeToScVal(options.amount, { type: "i128" }),
        ],
      }),
    ),
    subInvocations: options.subInvocations ?? [],
  });
}

/** The base64 preimage a signing library hands a wallet for this authorization. */
export function preimage(options: PreimageOptions): string {
  const networkId = hash(Buffer.from(options.passphrase ?? Networks.TESTNET));
  const nonce = xdr.Int64.fromString(String(options.nonce ?? 7n));
  const expiration = options.expiration ?? LATEST + 20;
  const root = invocation(options);
  const image =
    options.credential === "address_v2"
      ? xdr.HashIdPreimage.envelopeTypeSorobanAuthorizationWithAddress(
          new xdr.HashIdPreimageSorobanAuthorizationWithAddress({
            networkId,
            nonce,
            invocation: root,
            address: Address.fromString(options.boundAddress ?? options.payer).toScAddress(),
            signatureExpirationLedger: expiration,
          }),
        )
      : xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
          new xdr.HashIdPreimageSorobanAuthorization({
            networkId,
            nonce,
            invocation: root,
            signatureExpirationLedger: expiration,
          }),
        );
  return image.toXDR("base64");
}

/** How a test scheme deviates from the requirements it was asked to pay. */
export interface Tampering {
  readonly to?: string;
  readonly amount?: bigint;
  readonly asset?: string;
  readonly passphrase?: string;
  readonly expiration?: number;
  readonly fn?: string;
  readonly subInvocation?: boolean;
  readonly credential?: "address" | "address_v2";
  /** Asks for a second signature over the same entry. */
  readonly signTwice?: boolean;
  /** Puts a different transfer into the transaction than the one signed. */
  readonly transactionTo?: string;
  /** Leaves the signature out of the payload. */
  readonly dropSignature?: boolean;
  /** Calls signAuthEntry with this address option. */
  readonly requestAddress?: string;
}

/**
 * A scheme client that builds an exact payment offline the way the upstream client does (build the
 * authorization entry, have the signer sign its preimage, put it in a transaction) but can tamper with
 * any part. It calls `signAuthEntry` unbound, as the upstream client does.
 */
export function tamperingClient(signer: ClientStellarSigner, tampering: Tampering = {}): SchemeNetworkClient {
  const signAuthEntry = signer.signAuthEntry;
  return {
    scheme: "exact",
    async createPaymentPayload(
      x402Version: number,
      requirements: PaymentRequirements,
    ): Promise<Pick<PaymentPayload, "x402Version" | "payload">> {
      const passphrase = tampering.passphrase ?? Networks.TESTNET;
      const options: PreimageOptions = {
        payer: signer.address,
        asset: tampering.asset ?? requirements.asset,
        to: tampering.to ?? requirements.payTo,
        amount: tampering.amount ?? BigInt(requirements.amount),
        ...(tampering.fn === undefined ? {} : { fn: tampering.fn }),
        ...(tampering.subInvocation === true
          ? {
              subInvocations: [
                invocation({
                  payer: signer.address,
                  to: requirements.payTo,
                  amount: 1n,
                  asset: randomContractId(),
                }),
              ],
            }
          : {}),
      };
      const credentials = new xdr.SorobanAddressCredentials({
        address: Address.fromString(signer.address).toScAddress(),
        nonce: xdr.Int64.fromString("99"),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      });
      const entry = new xdr.SorobanAuthorizationEntry({
        credentials:
          tampering.credential === "address_v2"
            ? xdr.SorobanCredentials.sorobanCredentialsAddressV2(credentials)
            : xdr.SorobanCredentials.sorobanCredentialsAddress(credentials),
        rootInvocation: invocation(options),
      });
      const sign = async (image: xdr.HashIdPreimage) => {
        const { signedAuthEntry } = await signAuthEntry(image.toXDR("base64"), {
          address: tampering.requestAddress ?? signer.address,
        });
        return Buffer.from(signedAuthEntry, "base64");
      };
      let signed = await authorizeEntry(entry, sign, tampering.expiration ?? LATEST + 20, passphrase);
      if (tampering.signTwice === true) {
        signed = await authorizeEntry(entry, sign, tampering.expiration ?? LATEST + 20, passphrase);
      }
      if (tampering.dropSignature === true) signed = entry;

      const call = new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(options.asset ?? usdc).toScAddress(),
        functionName: "transfer",
        args: [
          nativeToScVal(signer.address, { type: "address" }),
          nativeToScVal(tampering.transactionTo ?? options.to, { type: "address" }),
          nativeToScVal(options.amount, { type: "i128" }),
        ],
      });
      const transaction = new TransactionBuilder(new Account(Keypair.random().publicKey(), "1"), {
        fee: "100",
        networkPassphrase: passphrase,
      })
        .setTimeout(60)
        .addOperation(
          Operation.invokeHostFunction({
            func: xdr.HostFunction.hostFunctionTypeInvokeContract(call),
            auth: [signed],
          }),
        )
        .build();
      return { x402Version, payload: { transaction: transaction.toXDR() } };
    },
  };
}

/** The exact adapter with its upstream client replaced by a tampering one. */
export function tamperingAdapter(tampering: Tampering = {}): StellarSchemeAdapter {
  return { ...exactScheme(), createClient: (signer) => tamperingClient(signer, tampering) };
}

export const newKey = () => KeyHolder.random();

/** A `localStorage`-like store in memory; `entries` exposes what it holds. */
export function memoryStore(): KeyValueStore & { readonly entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
  };
}
