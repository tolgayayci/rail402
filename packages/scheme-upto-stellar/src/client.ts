import {
  Address,
  Transaction,
  contract,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import {
  getNetworkPassphrase,
  getRpcClient,
  getRpcUrl,
  type ClientStellarSigner,
  type RpcConfig,
} from "@x402/stellar";
import type { Network, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import { SETTLE_FN, uptoContractFor } from "./constants.js";
import type { UptoStellarExtra, UptoStellarPayloadV2 } from "./types.js";

/**
 * Client side of `upto` on Stellar.
 *
 * The client authorizes a **ceiling** and signs a two-node authorization tree:
 *
 *   root:  <uptoContract>.settle(token, to, max_amount, expiration_ledger, nonce)
 *     └─   <token>.approve(from, <uptoContract>, max_amount, expiration_ledger)
 *
 * Every value in both nodes is known at signing time. `actual_amount` appears in neither — that is
 * what lets the server settle for less afterwards without invalidating the signature.
 *
 * Simulation produces this tree for us, so we sign what the host will actually demand rather than
 * hand-constructing it and hoping. Omitting the `approve` sub-invocation fails with
 * `Error(Auth, InvalidAction)`; letting simulation build the tree avoids the whole class of mistake.
 */
export interface UptoStellarClientOptions {
  rpcConfig?: RpcConfig;
  /** Placeholder for the unsigned `actual_amount` argument. Any value works; it is replaced at settle. */
  placeholderActual?: bigint;
}


export class UptoStellarClientScheme implements SchemeNetworkClient {
  readonly scheme = "upto";

  constructor(
    private readonly signer: ClientStellarSigner,
    private readonly options: UptoStellarClientOptions = {},
  ) {}

  async createPaymentPayload(
    x402Version: number,
    requirements: PaymentRequirements,
  ): Promise<{ x402Version: number; payload: UptoStellarPayloadV2 }> {
    const network = requirements.network as Network;
    const passphrase = getNetworkPassphrase(network);
    const server = getRpcClient(network, this.options.rpcConfig);

    // Never trust the server's contract address blindly — a hostile server naming its own contract
    // would be naming its own settlement rules.
    const advertised = (requirements.extra as unknown as UptoStellarExtra | undefined)?.uptoContract;
    const canonical = uptoContractFor(network);
    if (!canonical) {
      throw new Error(`No canonical upto contract is known for ${network}.`);
    }
    if (advertised && advertised !== canonical) {
      throw new Error(
        `The server advertised upto contract ${advertised}, but the canonical contract for ${network} is ${canonical}. Refusing to sign.`,
      );
    }

    const maxAmount = BigInt(requirements.amount);
    // Web Crypto rather than node:crypto so this scheme bundles for the browser (the playground's
    // buyer signs upto authorizations client-side). `globalThis.crypto` is standard in Node 20+ and
    // every browser; a Uint8Array is byte-identical to the previous Buffer for both the ScVal and
    // the hex encoding, so the on-ledger authorization is unchanged.
    const nonce = new Uint8Array(32);
    globalThis.crypto.getRandomValues(nonce);
    const nonceHex = Array.from(nonce, b => b.toString(16).padStart(2, "0")).join("");

    const { sequence } = await server.getLatestLedger();
    // Same derivation as `exact`: ceil(maxTimeoutSeconds / estimatedLedgerSeconds), fallback 5s.
    const expirationLedger = sequence + Math.ceil((requirements.maxTimeoutSeconds ?? 60) / 5);
    const rpcUrl = getRpcUrl(network, this.options.rpcConfig);

    // Build via AssembledTransaction — exactly as the `exact` scheme does — for two reasons:
    //
    //  1. It builds against a NULL account source, so the payer is never the transaction source.
    //     When the invoker signs and is also the tx source, Soroban emits source-account
    //     credentials, which the facilitator rejects (`unsupported_credential_type`). This is why
    //     the class had never settled end to end. The facilitator re-sources
    //     the transaction to its own account at settle, so the null source never reaches the ledger.
    //
    //  2. `signAuthEntries` drives a SEP-43 `ClientStellarSigner` (the `signAuthEntry` string form
    //     that `createEd25519Signer` and browser wallets both implement). The previous
    //     `authorizeEntry(entry, signer)` call required a raw `Keypair`/callback and threw
    //     `signer.sign is not a function` for the standard signer — the second half of why this
    //     path was never exercised.
    //
    // The signed transaction still carries a placeholder `actual_amount`; the facilitator swaps in
    // the real charge at settle without invalidating the signature (that argument is unsigned).
    const tx = await contract.AssembledTransaction.build({
      contractId: canonical,
      method: SETTLE_FN,
      args: [
        new Address(requirements.asset).toScVal(),
        new Address(this.signer.address).toScVal(),
        new Address(requirements.payTo).toScVal(),
        nativeToScVal(maxAmount, { type: "i128" }),
        nativeToScVal(expirationLedger, { type: "u32" }),
        nativeToScVal(nonce, { type: "bytes" }),
        nativeToScVal(this.options.placeholderActual ?? maxAmount, { type: "i128" }),
        // hook: None. A keypair payer has no spending policy to reconcile, so nothing is called.
        xdr.ScVal.scvVoid(),
      ],
      networkPassphrase: passphrase,
      rpcUrl,
      parseResultXdr: (result: xdr.ScVal) => result,
    });

    if (rpc.Api.isSimulationError(tx.simulation!)) {
      throw new Error(`Could not simulate the upto authorization: ${tx.simulation.error}`);
    }

    await tx.signAuthEntries({
      address: this.signer.address,
      signAuthEntry: this.signer.signAuthEntry,
      expiration: expirationLedger,
    });

    const stillMissing = tx.needsNonInvokerSigningBy();
    if (stillMissing.length > 0) {
      throw new Error(`upto authorization still needs signatures from: [${stillMissing.join(", ")}]`);
    }

    return {
      x402Version,
      payload: {
        transaction: tx.built!.toXDR(),
        maxAmount: maxAmount.toString(),
        expirationLedger,
        nonce: nonceHex,
      },
    };
  }
}

export { Transaction };
