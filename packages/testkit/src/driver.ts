import { Keypair, hash, xdr } from "@stellar/stellar-sdk";
import { createEd25519Signer, type ClientStellarSigner } from "@x402/stellar";
import { requirementsFor, type LocalNetwork, type PaymentRequirementsLike } from "./network.ts";
import type { TransferEvent } from "./settlements.ts";
import { deploySimpleAccount, smartAccountPayment } from "./smart-account.ts";
import type { TestAsset } from "./tokens.ts";

/**
 * Who pays: a G… account signing with its own key, or a C… smart account whose owner key signs the
 * authorization entry (`fixtures/simple_account.wasm`).
 */
export type Payer =
  | { readonly kind: "G"; readonly address: string; readonly keypair: Keypair }
  | { readonly kind: "C"; readonly address: string; readonly owner: Keypair };

export type PayerKind = Payer["kind"];

/** The payment requirements a driver publishes: `exact`, or `upto` with the settlement authority. */
export interface DriverRequirements {
  readonly scheme: "exact" | "upto";
  readonly network: "stellar:testnet";
  readonly asset: string;
  readonly payTo: string;
  /** The price for `exact`; the cap for `upto`. */
  readonly amount: string;
  readonly maxTimeoutSeconds: number;
  readonly extra: { readonly areFeesSponsored: true; readonly facilitatorAddress?: string };
}

/** An x402 v2 payment payload as a client sends it: `{ transaction }` for exact, `{ authorization }` for upto. */
export interface PaymentPayloadLike {
  readonly x402Version: 2;
  readonly resource: { readonly url: string };
  readonly accepted: DriverRequirements;
  readonly payload: { readonly transaction: string } | { readonly authorization: string };
}

export interface PayOptions {
  /** The authorization's expiration ledger; by default what the client derives from maxTimeoutSeconds. */
  readonly expirationLedger?: number;
}

/**
 * One way of paying: a scheme in one asset. Settlement suites run the same cases over every driver
 * (`describe.each(drivers)`), so each case is written once for scheme × asset × payer kind.
 */
export interface PaymentDriver {
  readonly scheme: "exact" | "upto";
  readonly asset: TestAsset;
  /** A readable label, e.g. "exact TEST6 (6 decimals)". */
  readonly label: string;
  /**
   * The requirements a seller would publish for `amount` base units to `payTo`: the price for
   * `exact`, the cap for `upto`.
   */
  requirements(payTo: string, amount: bigint, options?: { maxTimeoutSeconds?: number }): DriverRequirements;
  /**
   * The requirements the seller settles with once it knows what to charge: `exact` settles what was
   * published; `upto` settles `actual` (at most the cap), which defaults to the cap.
   */
  settleRequirements(requirements: DriverRequirements, actual?: bigint): DriverRequirements;
  /** A funded payer of the given kind holding `balance` base units of the asset (none when 0n). */
  payer(kind: PayerKind, balance: bigint): Promise<Payer>;
  /** An account that can receive the asset: a G… account (with a trustline for a classic asset) or a C… contract. */
  recipient(kind: PayerKind): Promise<string>;
  /** A signed payment of `requirements` by `payer`. */
  pay(payer: Payer, requirements: DriverRequirements, options?: PayOptions): Promise<PaymentPayloadLike>;
  /**
   * The transfer events a successful settlement emits: `requested` for `exact`; `actual` (default the
   * cap `requested`) for `upto`, and none when it settles zero.
   */
  expectedTransfers(payer: string, payTo: string, requested: bigint, actual?: bigint): TransferEvent[];
}

/** Funded payers and recipients in one asset, G… accounts or C… smart accounts, for any scheme. */
interface Accounts {
  payer(kind: PayerKind, balance: bigint): Promise<Payer>;
  recipient(kind: PayerKind): Promise<string>;
  /** A funded account that deploys smart accounts and sources unsigned client transactions; it signs no payment. */
  helper(): Promise<Keypair>;
}

function accountsIn(net: LocalNetwork, asset: TestAsset): Accounts {
  let helper: Promise<Keypair> | undefined;
  const helperAccount = () => {
    helper ??= (async () => {
      const keypair = Keypair.random();
      await net.fund(keypair);
      return keypair;
    })();
    return helper;
  };
  // Deployments share the helper's sequence number, so they run one at a time.
  let deploying: Promise<unknown> = Promise.resolve();
  const deploy = (owner: Keypair) => {
    const deployed = deploying.then(async () => deploySimpleAccount(net, await helperAccount(), owner));
    deploying = deployed.catch(() => undefined);
    return deployed;
  };
  return {
    helper: helperAccount,

    async payer(kind, balance) {
      if (kind === "G") {
        const keypair = Keypair.random();
        await net.fund(keypair);
        await asset.prepare(keypair);
        if (balance > 0n) await asset.mint(keypair.publicKey(), balance);
        return { kind, address: keypair.publicKey(), keypair };
      }
      const owner = Keypair.random();
      const address = await deploy(owner);
      if (balance > 0n) await asset.mint(address, balance);
      return { kind, address, owner };
    },

    async recipient(kind) {
      if (kind === "C") return deploy(Keypair.random());
      const keypair = Keypair.random();
      await net.fund(keypair);
      await asset.prepare(keypair);
      return keypair.publicKey();
    },
  };
}

/**
 * The `exact` scheme in `asset`. A G… payer's payment is built the way the stock client builds it
 * (`LocalNetwork.payment`); a C… payer's by `smartAccountPayment`.
 */
export function exactDriver(net: LocalNetwork, asset: TestAsset): PaymentDriver {
  const accounts = accountsIn(net, asset);
  return {
    scheme: "exact",
    asset,
    label: `exact ${asset.symbol} (${String(asset.decimals)} decimals)`,

    requirements: (payTo, amount, options = {}) =>
      requirementsFor(asset.contract, payTo, amount, options.maxTimeoutSeconds ?? 60),

    settleRequirements: (requirements) => requirements,

    payer: (kind, balance) => accounts.payer(kind, balance),
    recipient: (kind) => accounts.recipient(kind),

    async pay(payer, requirements, options = {}) {
      if (requirements.scheme !== "exact")
        throw new Error(`the exact driver cannot pay ${requirements.scheme}`);
      const terms = requirements as PaymentRequirementsLike;
      if (payer.kind === "G") return net.payment(payer.keypair, terms, options);
      return smartAccountPayment(net, {
        account: payer.address,
        owner: payer.owner,
        source: await accounts.helper(),
        requirements: terms,
        ...(options.expirationLedger === undefined ? {} : { expirationLedger: options.expirationLedger }),
      });
    },

    expectedTransfers: (payer, payTo, requested) => [
      { contract: asset.contract, from: payer, to: payTo, amount: requested },
    ],
  };
}

/** What the `upto` client needs, as `@rail402.dev/upto/client`'s `UptoStellarScheme` takes it. */
export interface UptoClientOptions {
  readonly latestLedger: (network: string) => Promise<number>;
  readonly contracts: string;
  readonly ledgerSeconds: number;
  readonly authorizeEntry?: (
    entry: xdr.SorobanAuthorizationEntry,
    context: { readonly expirationLedger: number; readonly networkPassphrase: string },
  ) => Promise<xdr.SorobanAuthorizationEntry>;
}

/** An `upto` client: `new UptoStellarScheme(signer, options)` from `@rail402.dev/upto/client`. */
export type UptoClientFactory = (
  signer: ClientStellarSigner,
  options: UptoClientOptions,
) => {
  createPaymentPayload(
    x402Version: number,
    requirements: never,
  ): Promise<{ readonly payload: Record<string, unknown> }>;
};

export interface UptoDriverOptions {
  /** The settlement contract the client authorizes. */
  readonly contract: string;
  /** The facilitator's settlement authority, `extra.facilitatorAddress` in the requirements. */
  readonly authority: string;
  /** Builds the scheme's client; injected so the test kit does not depend on the scheme package. */
  readonly client: UptoClientFactory;
  /** Seconds per ledger both client and facilitator assume (default 5). */
  readonly ledgerSeconds?: number;
}

/**
 * The `upto` scheme in `asset`: the payer signs one authorization for the cap, and the seller settles
 * any amount up to it. Payments are built by the scheme's own client; a C… payer's entry is signed
 * the way `fixtures/simple_account.wasm` checks it, an ed25519 signature by its owner over the
 * authorization preimage hash. An `expirationLedger` option sets the client's view of the latest
 * ledger so the terms and the credential expire exactly there.
 */
export function uptoDriver(net: LocalNetwork, asset: TestAsset, options: UptoDriverOptions): PaymentDriver {
  const accounts = accountsIn(net, asset);
  const ledgerSeconds = options.ledgerSeconds ?? 5;
  return {
    scheme: "upto",
    asset,
    label: `upto ${asset.symbol} (${String(asset.decimals)} decimals)`,

    requirements: (payTo, amount, requirementOptions = {}) => ({
      scheme: "upto",
      network: "stellar:testnet",
      asset: asset.contract,
      payTo,
      amount: amount.toString(),
      maxTimeoutSeconds: requirementOptions.maxTimeoutSeconds ?? 60,
      extra: { areFeesSponsored: true, facilitatorAddress: options.authority },
    }),

    settleRequirements: (requirements, actual) =>
      actual === undefined ? requirements : { ...requirements, amount: actual.toString() },

    payer: (kind, balance) => accounts.payer(kind, balance),
    recipient: (kind) => accounts.recipient(kind),

    async pay(payer, requirements, payOptions = {}) {
      if (requirements.scheme !== "upto")
        throw new Error(`the upto driver cannot pay ${requirements.scheme}`);
      const ledgers = Math.ceil(requirements.maxTimeoutSeconds / ledgerSeconds);
      const expiration = payOptions.expirationLedger;
      const signer: ClientStellarSigner =
        payer.kind === "G"
          ? createEd25519Signer(payer.keypair.secret(), "stellar:testnet")
          : { address: payer.address, signAuthEntry: () => Promise.reject(new Error("signed by its owner")) };
      const client = options.client(signer, {
        latestLedger: async () => (expiration === undefined ? net.latestLedger() : expiration - ledgers),
        contracts: options.contract,
        ledgerSeconds,
        ...(payer.kind === "C"
          ? {
              authorizeEntry: (entry, context) =>
                Promise.resolve(
                  signContractAccountEntry(
                    entry,
                    payer.owner,
                    context.expirationLedger,
                    context.networkPassphrase,
                  ),
                ),
            }
          : {}),
      });
      const created = await client.createPaymentPayload(2, requirements as never);
      return {
        x402Version: 2,
        resource: { url: "https://seller.example/metered" },
        accepted: requirements,
        payload: created.payload as { readonly authorization: string },
      };
    },

    expectedTransfers: (payer, payTo, requested, actual = requested) =>
      actual === 0n ? [] : [{ contract: asset.contract, from: payer, to: payTo, amount: actual }],
  };
}

/**
 * Signs a smart account's address credential the way `fixtures/simple_account.wasm`'s `__check_auth`
 * expects: the owner's ed25519 signature over the authorization preimage hash, as a bytes value.
 */
export function signContractAccountEntry(
  entry: xdr.SorobanAuthorizationEntry,
  owner: Keypair,
  expirationLedger: number,
  networkPassphrase: string,
): xdr.SorobanAuthorizationEntry {
  const signed = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR());
  const credentials = signed.credentials();
  if (credentials.switch() !== xdr.SorobanCredentialsType.sorobanCredentialsAddress()) {
    throw new Error("not an address credential");
  }
  const address = credentials.address();
  address.signatureExpirationLedger(expirationLedger);
  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(Buffer.from(networkPassphrase)),
      nonce: address.nonce(),
      signatureExpirationLedger: expirationLedger,
      invocation: signed.rootInvocation(),
    }),
  );
  address.signature(xdr.ScVal.scvBytes(owner.sign(hash(preimage.toXDR()))));
  return signed;
}
