import { Buffer } from "buffer";
import { authorizeEntry as signEntry, xdr } from "@stellar/stellar-sdk";
import type {
  Network,
  PaymentPayloadContext,
  PaymentPayloadResult,
  PaymentRequirements,
  SchemeNetworkClient,
} from "@x402/core/types";
import {
  findDefaultAsset,
  getNetworkPassphrase,
  getRpcClient,
  isStellarNetwork,
  type ClientStellarSigner,
  type RpcConfig,
} from "@x402/stellar";
import { DEFAULT_MAX_TIMEOUT_SECONDS, MAX_SIGNER_AUTHORIZATIONS, UPTO_SCHEME } from "../constants.ts";
import {
  expirationLedgerFor,
  isAccountAddress,
  isAccountOrContract,
  isContractAddress,
  parseAtomicAmount,
  resolveLedgerSeconds,
  resolveUptoContract,
} from "../shared.ts";
import {
  encodeAuthorizationEntry,
  unsignedPayerEntry,
  type UptoCredential,
  type UptoTerms,
} from "../terms.ts";
import type { LedgerSecondsSource, UptoContractOverride, UptoStellarPayload } from "../types.ts";

/** What an injected signer receives. */
export interface UptoAuthorizeContext {
  readonly network: string;
  readonly networkPassphrase: string;
  /** Inclusive last ledger of the authorization; already set on the entry's credentials. */
  readonly expirationLedger: number;
  readonly terms: UptoTerms;
  readonly contract: string;
}

/** A signed payer entry, and any entries a smart account's delegated signers must add. */
export interface UptoAuthorizeResult {
  readonly authorization: xdr.SorobanAuthorizationEntry;
  readonly signerAuthorizations?: readonly xdr.SorobanAuthorizationEntry[];
}

/**
 * Signs the payer's entry. Contract-account (`C…`) payers must supply one, because their signature
 * format is defined by their own `__check_auth`.
 */
export type UptoAuthorizeEntry = (
  entry: xdr.SorobanAuthorizationEntry,
  context: UptoAuthorizeContext,
) => Promise<xdr.SorobanAuthorizationEntry | UptoAuthorizeResult>;

export interface UptoStellarClientOptions {
  /** RPC URL used to read the latest ledger. */
  readonly rpcConfig?: RpcConfig;
  /** Reads the latest ledger instead of the default RPC client (e.g. a cached value). */
  readonly latestLedger?: (network: string) => Promise<number>;
  /** Sign CAP-71 address-bound V2 credentials instead of the legacy ones (default `false`). */
  readonly authV2?: boolean;
  /** Custom entry signer; required for contract-account payers. */
  readonly authorizeEntry?: UptoAuthorizeEntry;
  /** Settlement contract to use instead of the canonical deployment, e.g. on a local network. */
  readonly contracts?: UptoContractOverride;
  /** Seconds per ledger (default: estimated from Horizon, falling back to 5). */
  readonly ledgerSeconds?: LedgerSecondsSource;
  /**
   * Largest `maxTimeoutSeconds` the client signs for (default 300). The authorization stays settleable
   * until its expiration ledger, so a seller acting as its own settlement authority could otherwise
   * obtain one that lasts for months.
   */
  readonly maxTimeoutSeconds?: number;
}

/**
 * Stellar client for the x402 `upto` scheme. It signs one Soroban authorization entry over the
 * payment terms — recipient, token, cap, expiration and settlement authority — and never the
 * amount finally charged, which the facilitator settles within the cap. No simulation is needed:
 * the entry is built directly from the requirements.
 */
export class UptoStellarScheme implements SchemeNetworkClient {
  readonly scheme = UPTO_SCHEME;
  /** Lets core spend controls convert the cap of a known asset to USD. */
  readonly findDefaultAsset = findDefaultAsset;

  private readonly signer: ClientStellarSigner;
  private readonly options: UptoStellarClientOptions;

  /**
   * Creates the client for one payer.
   *
   * @param signer - The payer; `signAuthEntry` signs `G…` payers' entries
   * @param options - See {@link UptoStellarClientOptions}
   */
  constructor(signer: ClientStellarSigner, options: UptoStellarClientOptions = {}) {
    this.signer = signer;
    this.options = options;
  }

  /**
   * Creates the `upto` payment payload `{ authorization, signerAuthorizations? }`.
   *
   * @param x402Version - The x402 protocol version
   * @param requirements - The payment requirements; `amount` is the cap
   * @param context - Core payment context; its spend cap applies to the requirements' cap
   * @returns The payload
   */
  async createPaymentPayload(
    x402Version: number,
    requirements: PaymentRequirements,
    context?: PaymentPayloadContext,
  ): Promise<PaymentPayloadResult> {
    const { network, maxTimeoutSeconds } = requirements;
    const { cap, facilitator } = this.validate(requirements, context);
    const contract = resolveUptoContract(network, this.options.contracts);
    if (contract === undefined) throw new Error(`no upto settlement contract is known for ${network}`);

    const [latestLedger, ledgerSeconds] = await Promise.all([
      this.latestLedger(network),
      resolveLedgerSeconds(network, this.options.ledgerSeconds),
    ]);
    const terms: UptoTerms = {
      expirationLedger: expirationLedgerFor(latestLedger, maxTimeoutSeconds, ledgerSeconds),
      facilitator,
      maxAmount: cap,
      recipient: requirements.payTo,
      token: requirements.asset,
      validAfterLedger: 0,
    };
    const credential: UptoCredential = this.options.authV2 === true ? "address_v2" : "address";
    const entry = unsignedPayerEntry({
      contract,
      payer: this.signer.address,
      terms,
      nonce: randomNonce(),
      credential,
    });
    const networkPassphrase = getNetworkPassphrase(network);
    const context_: UptoAuthorizeContext = {
      network,
      networkPassphrase,
      expirationLedger: terms.expirationLedger,
      terms,
      contract,
    };

    let result: UptoAuthorizeResult;
    if (this.options.authorizeEntry !== undefined) {
      const signed = await this.options.authorizeEntry(entry, context_);
      result = signed instanceof xdr.SorobanAuthorizationEntry ? { authorization: signed } : signed;
    } else if (isContractAddress(this.signer.address)) {
      throw new Error("a contract-account payer needs an authorizeEntry signer");
    } else {
      result = { authorization: await this.signWithSigner(entry, terms.expirationLedger, networkPassphrase) };
    }

    const signerAuthorizations = result.signerAuthorizations ?? [];
    if (signerAuthorizations.length > MAX_SIGNER_AUTHORIZATIONS) {
      throw new Error(`at most ${MAX_SIGNER_AUTHORIZATIONS} signer authorizations are allowed`);
    }
    const payload: UptoStellarPayload = {
      authorization: encodeAuthorizationEntry(result.authorization),
      ...(signerAuthorizations.length === 0
        ? {}
        : { signerAuthorizations: signerAuthorizations.map(encodeAuthorizationEntry) }),
    };
    return { x402Version, payload: { ...payload } };
  }

  /**
   * Step 1 of the client procedure: refuse anything the scheme cannot pay safely.
   *
   * @param requirements - The payment requirements
   * @param context - Core payment context, with the spend limit per payment
   * @returns The cap and the settlement authority
   */
  private validate(
    requirements: PaymentRequirements,
    context: PaymentPayloadContext | undefined,
  ): { cap: bigint; facilitator: string } {
    const { scheme, network, payTo, asset, amount, maxTimeoutSeconds } = requirements;
    const extra = (requirements.extra as Record<string, unknown> | undefined) ?? {};
    if (scheme !== UPTO_SCHEME) throw new Error(`unsupported scheme: ${scheme}`);
    if (!isStellarNetwork(network)) throw new Error(`unsupported Stellar network: ${network}`);
    const cap = parseAtomicAmount(amount);
    if (cap === undefined || cap === 0n)
      throw new Error(`invalid amount ${amount}: the cap must be a positive integer`);
    if (!isContractAddress(asset))
      throw new Error(`invalid asset ${requirements.asset}: expected a C… token contract`);
    if (!isAccountOrContract(payTo))
      throw new Error(`invalid payTo ${requirements.payTo}: expected a G… or C… address`);
    if (!Number.isInteger(maxTimeoutSeconds) || maxTimeoutSeconds <= 0) {
      throw new Error(`invalid maxTimeoutSeconds ${String(maxTimeoutSeconds)}`);
    }
    const longest = this.options.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS;
    if (maxTimeoutSeconds > longest) {
      throw new Error(
        `maxTimeoutSeconds ${maxTimeoutSeconds} exceeds the ${longest} seconds this client signs for`,
      );
    }
    if (extra["areFeesSponsored"] !== true)
      throw new Error("upto on Stellar requires extra.areFeesSponsored to be true");
    const facilitator = extra["facilitatorAddress"];
    // The settlement authority is the settle operation's source, which only a G… account can be: a
    // C… address could never settle through a facilitator, only through whoever controls it.
    if (!isAccountAddress(facilitator)) {
      throw new Error("extra.facilitatorAddress must be the facilitator's G… settlement authority");
    }
    if (facilitator === this.signer.address || payTo === this.signer.address) {
      throw new Error("the payer cannot be the settlement authority or the recipient");
    }
    const spendCap = parseAtomicAmount(context?.maxAmountPerPayment);
    if (spendCap !== undefined && cap > spendCap) {
      throw new Error(`the cap ${cap} exceeds the spend limit ${spendCap}`);
    }
    return { cap, facilitator };
  }

  /**
   * The latest ledger, from the injected reader or the network's RPC.
   *
   * @param network - CAIP-2 network
   * @returns The ledger sequence
   */
  private async latestLedger(network: string): Promise<number> {
    if (this.options.latestLedger !== undefined) return this.options.latestLedger(network);
    const server = getRpcClient(network as Network, this.options.rpcConfig);
    return (await server.getLatestLedger()).sequence;
  }

  /**
   * Signs a `G…` payer's entry through the SEP-43 `signAuthEntry` of the signer.
   *
   * @param entry - The unsigned entry
   * @param expirationLedger - The signature's expiration ledger
   * @param networkPassphrase - The network passphrase
   * @returns The signed entry
   */
  private async signWithSigner(
    entry: xdr.SorobanAuthorizationEntry,
    expirationLedger: number,
    networkPassphrase: string,
  ): Promise<xdr.SorobanAuthorizationEntry> {
    return signEntry(
      entry,
      async (preimage) => {
        const { signedAuthEntry, error } = await this.signer.signAuthEntry(preimage.toXDR("base64"), {
          networkPassphrase,
          address: this.signer.address,
        });
        if (error !== undefined) throw new Error(`the wallet refused to sign: ${error.message}`);
        return { signature: Buffer.from(signedAuthEntry, "base64"), publicKey: this.signer.address };
      },
      expirationLedger,
      networkPassphrase,
    );
  }
}

/**
 * A uniformly random signed 64-bit nonce from the platform's CSPRNG.
 *
 * @returns The nonce
 */
function randomNonce(): bigint {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return BigInt.asIntN(64, BigInt(`0x${Buffer.from(bytes).toString("hex")}`));
}
