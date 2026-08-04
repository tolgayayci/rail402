import {
  Address,
  BASE_FEE,
  Contract,
  Operation,
  Transaction,
  TransactionBuilder,
  authorizeEntry,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { getNetworkPassphrase, getRpcClient, type ClientStellarSigner, type RpcConfig } from "@x402/stellar";
import { randomBytes } from "node:crypto";
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
    const nonce = randomBytes(32);

    const { sequence } = await server.getLatestLedger();
    // Same derivation as `exact`: ceil(maxTimeoutSeconds / estimatedLedgerSeconds), fallback 5s.
    const expirationLedger = sequence + Math.ceil((requirements.maxTimeoutSeconds ?? 60) / 5);

    const account = await server.getAccount(this.signer.address);
    const contract = new Contract(canonical);

    const build = (actual: bigint) =>
      new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: passphrase })
        .addOperation(
          contract.call(
            SETTLE_FN,
            new Address(requirements.asset).toScVal(),
            new Address(this.signer.address).toScVal(),
            new Address(requirements.payTo).toScVal(),
            nativeToScVal(maxAmount, { type: "i128" }),
            nativeToScVal(expirationLedger, { type: "u32" }),
            nativeToScVal(nonce, { type: "bytes" }),
            nativeToScVal(actual, { type: "i128" }),
            // hook: None. A keypair payer has no spending policy to reconcile, so nothing is called.
            xdr.ScVal.scvVoid(),
          ),
        )
        .setTimeout(requirements.maxTimeoutSeconds ?? 60)
        .build();

    // Simulate to discover the authorization tree the host will require, then sign exactly that.
    const probe = build(this.options.placeholderActual ?? maxAmount);
    const sim = await server.simulateTransaction(probe);
    if (!rpc.Api.isSimulationSuccess(sim)) {
      const detail = rpc.Api.isSimulationError(sim) ? sim.error : "unknown";
      throw new Error(`Could not simulate the upto authorization: ${detail}`);
    }

    const entries = sim.result?.auth ?? [];
    const signed: xdr.SorobanAuthorizationEntry[] = [];
    for (const entry of entries) {
      signed.push(await authorizeEntry(entry, this.signer as never, expirationLedger, passphrase));
    }

    const op = probe.operations[0] as Operation.InvokeHostFunction;
    const withAuth = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: passphrase })
      .addOperation(Operation.invokeHostFunction({ func: op.func, auth: signed }))
      .setTimeout(requirements.maxTimeoutSeconds ?? 60)
      .build();

    return {
      x402Version,
      payload: {
        transaction: withAuth.toXDR(),
        maxAmount: maxAmount.toString(),
        expirationLedger,
        nonce: nonce.toString("hex"),
      },
    };
  }
}

export { Transaction };
