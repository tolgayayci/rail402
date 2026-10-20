import { Buffer } from "buffer";
import {
  Account,
  Address,
  BASE_FEE,
  FeeBumpTransaction,
  Operation,
  Transaction,
  TransactionBuilder,
  hash,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import {
  STELLAR_WILDCARD_CAIP2,
  getNetworkPassphrase,
  getRpcClient,
  isStellarNetwork,
  type FacilitatorStellarSigner,
  type RpcConfig,
} from "@x402/stellar";
import {
  DEFAULT_EXPIRATION_MARGIN_LEDGERS,
  DEFAULT_MAX_TIMEOUT_SECONDS,
  DEFAULT_MAX_TRANSACTION_FEE_STROOPS,
  UPTO_DEPLOYMENTS,
  UPTO_SCHEME,
  UPTO_X402_VERSION,
} from "../constants.ts";
import { reject, type UptoRejection } from "../errors.ts";
import {
  isAccountAddress,
  minTimeoutSecondsFor,
  parseAtomicAmount,
  resolveLedgerSeconds,
  resolveUptoContract,
} from "../shared.ts";
import { authorityEntry, settleInvokeArgs } from "../terms.ts";
import type { LedgerSecondsSource, UptoContractOverride, ZeroSettlementMode } from "../types.ts";
import { checkUptoPayment, type CheckedUptoPayment, type UptoPhase } from "./rules.ts";
import {
  archivedStateRejection,
  checkSimulationEvents,
  classifySimulationFailure,
  hostErrors,
  hostErrorsFromMessage,
  type SettlementParties,
} from "./simulation.ts";

/** The RPC calls the mechanism makes. `rpc.Server` satisfies it. */
export interface UptoRpc {
  getLatestLedger(): Promise<{ readonly sequence: number }>;
  getAccount(address: string): Promise<Account>;
  simulateTransaction(transaction: Transaction): Promise<rpc.Api.SimulateTransactionResponse>;
  sendTransaction(transaction: Transaction | FeeBumpTransaction): Promise<rpc.Api.SendTransactionResponse>;
  getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse>;
  /**
   * Reads ledger entries; used to read the payer's authorization nonce before a settlement is
   * answered as never included. Without it, that answer rests on the transaction lookups alone.
   */
  getLedgerEntries?(...keys: xdr.LedgerKey[]): Promise<rpc.Api.GetLedgerEntriesResponse>;
}

export interface UptoStellarFacilitatorOptions {
  /** RPC URL for the default client. */
  readonly rpcConfig?: RpcConfig;
  /** Supplies the RPC client per network, replacing the default one built from `rpcConfig`. */
  readonly rpc?: (network: string) => UptoRpc;
  /**
   * The settlement authority `F`: the `G…` account named in the payer's terms and used as the
   * settle operation's source. Defaults to the first signer.
   */
  readonly settlementAuthority?: FacilitatorStellarSigner;
  /**
   * What to do with a zero-amount settlement (default `onchain`). This mechanism records an
   * `offchain` zero in its own memory: use it only when this instance is the only process holding the
   * settlement authority and is not restarted before the authorization expires. A deployment with
   * several processes needs a durable, shared record instead, or `onchain`.
   */
  readonly zeroSettlement?: ZeroSettlementMode;
  /** Settlement contract to use instead of the canonical deployment, e.g. on a local network. */
  readonly contract?: UptoContractOverride;
  /** Hex sha256 of the configured contract's WASM, used to recognise its archived code. */
  readonly contractWasmHash?: string;
  /** Seconds per ledger (default: estimated from Horizon, falling back to 5). */
  readonly ledgerSeconds?: LedgerSecondsSource;
  /** Ceiling on the settlement fee (inclusion + simulated resource fee), in stroops. */
  readonly maxTransactionFeeStroops?: number;
  /** Inclusion fee bid for the settlement transaction and the fee bump (default 100). */
  readonly inclusionFeeStroops?: number;
  /** Picks the transaction source among the signers (default: round-robin). */
  readonly selectSigner?: (addresses: readonly string[]) => string;
  /** Pays the fee through a fee-bump transaction, so signers need no XLM. */
  readonly feeBumpSigner?: FacilitatorStellarSigner;
  /** Largest `maxTimeoutSeconds` accepted (default 300). */
  readonly maxTimeoutSeconds?: number;
  /**
   * Smallest `maxTimeoutSeconds` accepted (default: one ledger more than the expiration margin at
   * 5 s per ledger, 15 s for the default margin). A shorter timeout gives authorizations that expire
   * before they can be settled.
   */
  readonly minTimeoutSeconds?: number;
  /** Minimum ledgers between now and the authorization's expiration (default 2, at least 1). */
  readonly expirationMarginLedgers?: number;
  /** Asset allow-list; every SEP-41 asset is accepted when absent. */
  readonly isAssetAccepted?: (asset: string, network: string) => boolean;
  /** More addresses to treat as facilitator-controlled (never a payer or payee). */
  readonly facilitatorAddresses?: readonly string[];
  /**
   * Times a settlement refused for a stale sequence number (`txBAD_SEQ`, another transaction of the
   * same signer took it) is rebuilt with a fresh sequence and submitted again (default 1). When none
   * is left, the answer is `settle_upto_stellar_channel_unavailable`, which may be retried.
   */
  readonly badSequenceRetries?: number;
  /** Confirmation polling (default 30 attempts, 1 s apart). */
  readonly confirmation?: { readonly attempts?: number; readonly intervalMs?: number };
}

interface Checked {
  readonly payment: CheckedUptoPayment;
  readonly network: string;
  readonly contract: string;
  readonly rpc: UptoRpc;
  readonly parties: SettlementParties;
}

type Checking =
  | { readonly ok: true; readonly checked: Checked }
  | { readonly ok: false; readonly rejection: UptoRejection; readonly payer?: string | undefined };

type Simulating =
  | { readonly ok: true; readonly transaction: Transaction }
  | { readonly ok: false; readonly rejection: UptoRejection };

/** What a settlement repeat and its confirmation need to know, without the request. */
interface SettlementContext {
  readonly network: string;
  readonly payer: string;
  readonly amount: bigint;
  readonly payTo: string;
  readonly asset: string;
  /** The authorization's expiration ledger `E`: the transaction cannot be included after it. */
  readonly expirationLedger: number;
  /** The latest ledger when the settlement was requested: the transaction cannot be in an earlier one. */
  readonly requestedLedger: number;
  /** The payer's authorization nonce. */
  readonly nonce: bigint;
  /**
   * The hash of the transaction inside the fee bump, when one wraps it. Anyone can wrap the public
   * inner transaction in a fee bump of their own, so it can land under another hash.
   */
  innerTransactionHash?: string | undefined;
}

interface SettlementRecord extends SettlementContext {
  readonly payloadHash: string;
  /** `running` until `execute` answers; then `pending` (possibly landed, hash known) or `final`. */
  state: "running" | "pending" | "final";
  /** Kept for repeats while the latest ledger is at most this: `E`, or longer once it was pending. */
  keepUntilLedger: number;
  /** Never rejects. */
  result: Promise<SettleResponse>;
}

/** Rule-7 refusals under which a repeat of a submitted settlement is still answered from its record. */
const LATE_REFUSALS: ReadonlySet<string> = new Set([
  "invalid_upto_stellar_signature_expired",
  "invalid_upto_stellar_signature_expiration_too_soon",
]);

/**
 * How long past its authorization's expiration a settlement whose outcome was pending is kept for
 * repeats: one day of 5-second ledgers, the history a Stellar RPC retains by default. After that a
 * lookup could no longer tell either way.
 */
const PENDING_RETENTION_LEDGERS = 17_280;

/**
 * Stellar facilitator for the x402 `upto` scheme.
 *
 * `verify` checks the payment for its cap and simulates `settle(payer, terms, cap)`; it writes
 * nothing. `settle` re-checks everything for the amount being settled (`requirements.amount`, at
 * most the accepted cap), simulates again, and submits the invocation: the transaction source is
 * one of the signers (its sequence number), the operation source is the settlement authority
 * (whose `SOURCE_ACCOUNT` authorization binds the amount), and an optional fee-bump signer pays the
 * fee. One authorization is submitted at most once: a repeat of the same settlement returns the
 * same result, and a repeat for a different amount is refused with the original transaction.
 *
 * A settlement whose transaction may have been broadcast is never answered as failed without its
 * hash: when `sendTransaction` throws, or confirmation runs out of attempts, the answer is
 * `settlement_pending` with the hash, and a repeat of the same request keeps polling it, also after
 * the authorization's expiration ledger, until the network shows it included or proves it absent.
 * These records live in this process's memory: the at-most-once guarantee and the off-chain zero
 * record hold for one process holding the settlement authority.
 */
export class UptoStellarScheme implements SchemeNetworkFacilitator {
  readonly scheme = UPTO_SCHEME;
  readonly caipFamily = STELLAR_WILDCARD_CAIP2;

  readonly authority: FacilitatorStellarSigner;
  readonly zeroSettlement: ZeroSettlementMode;
  readonly maxTransactionFeeStroops: number;
  readonly inclusionFeeStroops: number;
  readonly maxTimeoutSeconds: number;
  readonly minTimeoutSeconds: number;
  readonly expirationMarginLedgers: number;
  /** Every address this facilitator controls; none may pay, be paid or appear in a client entry. */
  readonly facilitatorAddresses: ReadonlySet<string>;

  private readonly signers: Map<string, FacilitatorStellarSigner>;
  private readonly options: UptoStellarFacilitatorOptions;
  private readonly selectSigner: (addresses: readonly string[]) => string;
  private readonly settlements = new Map<string, SettlementRecord>();
  /** `network:payloadHash` → settlement key, to answer a late repeat that no longer passes rule 7. */
  private readonly byPayload = new Map<string, string>();

  /**
   * Creates the facilitator mechanism.
   *
   * @param signers - Transaction sources for settlements (channel accounts); at least one.
   * @param options - See {@link UptoStellarFacilitatorOptions}.
   */
  constructor(signers: readonly FacilitatorStellarSigner[], options: UptoStellarFacilitatorOptions = {}) {
    const [first] = signers;
    if (first === undefined) throw new Error("at least one signer is required");
    this.signers = new Map(signers.map((signer) => [signer.address, signer]));
    this.authority = options.settlementAuthority ?? first;
    if (!isAccountAddress(this.authority.address)) {
      throw new Error("the settlement authority must be a G… account");
    }
    this.options = options;
    this.zeroSettlement = options.zeroSettlement ?? "onchain";
    this.maxTransactionFeeStroops = options.maxTransactionFeeStroops ?? DEFAULT_MAX_TRANSACTION_FEE_STROOPS;
    this.inclusionFeeStroops = options.inclusionFeeStroops ?? Number(BASE_FEE);
    this.maxTimeoutSeconds = options.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS;
    this.expirationMarginLedgers = options.expirationMarginLedgers ?? DEFAULT_EXPIRATION_MARGIN_LEDGERS;
    if (!Number.isInteger(this.expirationMarginLedgers) || this.expirationMarginLedgers < 1) {
      // An authorization expiring at the current ledger can no longer be included.
      throw new Error("expirationMarginLedgers must be an integer of at least 1");
    }
    this.minTimeoutSeconds = options.minTimeoutSeconds ?? minTimeoutSecondsFor(this.expirationMarginLedgers);
    if (
      !Number.isInteger(this.minTimeoutSeconds) ||
      this.minTimeoutSeconds < 1 ||
      this.minTimeoutSeconds > this.maxTimeoutSeconds
    ) {
      throw new Error("minTimeoutSeconds must be an integer from 1 to maxTimeoutSeconds");
    }
    this.selectSigner = options.selectSigner ?? roundRobin();
    this.facilitatorAddresses = new Set([
      ...this.signers.keys(),
      this.authority.address,
      ...(options.feeBumpSigner === undefined ? [] : [options.feeBumpSigner.address]),
      ...(options.facilitatorAddresses ?? []),
    ]);
  }

  /**
   * `extra` of the `/supported` kind: fees are sponsored, and `facilitatorAddress` is the
   * settlement authority that clients name in their terms.
   *
   * @param _ - The network (the same authority serves every network)
   * @returns The supported-kind extra
   */
  getExtra(_: Network): Record<string, unknown> {
    return { areFeesSponsored: true, facilitatorAddress: this.authority.address };
  }

  /**
   * The addresses this facilitator signs with, for `/supported`.
   *
   * @param _ - The network
   * @returns The signers, the settlement authority and the fee-bump signer
   */
  getSigners(_: string): string[] {
    return [
      ...new Set([
        ...this.signers.keys(),
        this.authority.address,
        ...(this.options.feeBumpSigner === undefined ? [] : [this.options.feeBumpSigner.address]),
      ]),
    ];
  }

  /**
   * Verifies a payment for its cap. Writes nothing.
   *
   * @param payload - The payment payload
   * @param requirements - The payment requirements; `amount` equals the accepted cap
   * @returns The verification response
   */
  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    let payer: string | undefined;
    try {
      const checking = await this.check(payload, requirements, "verify");
      if (!checking.ok) return invalid(checking.rejection, checking.payer);
      const { checked } = checking;
      payer = checked.payment.payer;
      const simulated = await this.simulate(checked, new Account(this.firstSigner().address, "0"));
      if (!simulated.ok) return invalid(simulated.rejection, payer);
      return { isValid: true, payer };
    } catch (error) {
      return invalid(reject("unexpected_verify_error", errorMessage(error)), payer);
    }
  }

  /**
   * Settles `requirements.amount` (zero up to the accepted cap).
   *
   * @param payload - The payment payload
   * @param requirements - The payment requirements; `amount` is the amount to settle
   * @returns The settlement response; `amount` is always set
   */
  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const network = requirements.network;
    const requested = parseAtomicAmount(requirements.amount);
    const amount = requested === undefined ? undefined : requested.toString();
    let payer: string | undefined;
    try {
      const checking = await this.check(payload, requirements, "settle");
      if (!checking.ok) {
        // A repeat of a settlement whose transaction may still have landed is answered from its
        // record, also after the authorization expired.
        const late =
          LATE_REFUSALS.has(checking.rejection.code) && requested !== undefined
            ? await this.lateRecord(network, settlementHash(payload, requested), requirements)
            : undefined;
        if (late !== undefined) return await this.recheck(late);
        return failed(network, checking.rejection, checking.payer, amount);
      }
      const { checked } = checking;
      payer = checked.payment.payer;

      const latest = (await checked.rpc.getLatestLedger()).sequence;
      this.prune(latest);
      const key = `${network}:${payer}:${checked.payment.authorization.nonce.toString()}`;
      const payloadHash = settlementHash(payload, checked.payment.amount);
      const existing = this.settlements.get(key);
      if (existing !== undefined) {
        if (existing.payloadHash !== payloadHash) {
          const original = await existing.result;
          if (!original.success && !isPending(original) && original.transaction === "") {
            // The other request failed before anything reached the network: nothing was settled,
            // so this one is settled on its own.
            if (this.settlements.get(key) === existing) this.forget(key, existing);
            return await this.settle(payload, requirements);
          }
          const state = original.success
            ? "was already settled"
            : isPending(original)
              ? "is being settled"
              : "was already submitted, and failed on chain,";
          return failed(
            network,
            reject(
              "settle_upto_stellar_idempotency_conflict",
              `This authorization ${state} for ${existing.amount}; it cannot be settled again for ${checked.payment.amount}.`,
            ),
            payer,
            amount,
            original.transaction,
          );
        }
        return await this.recheck(existing);
      }

      const record: SettlementRecord = {
        ...contextOf(checked, latest),
        payTo: requirements.payTo,
        asset: requirements.asset,
        payloadHash,
        state: "running",
        keepUntilLedger: checked.payment.authorization.terms.expirationLedger,
        result: Promise.resolve(failed(network, reject("unexpected_settle_error"), payer, amount)),
      };
      record.result = this.execute(checked, record);
      this.settlements.set(key, record);
      this.byPayload.set(`${network}:${payloadHash}`, key);
      const response = await record.result;
      record.state = isPending(response) ? "pending" : "final";
      if (record.state === "pending") record.keepUntilLedger += PENDING_RETENTION_LEDGERS;
      // Nothing reached the network: the same payment may be retried.
      if (!response.success && response.transaction === "" && !isPending(response)) {
        this.forget(key, record);
      }
      return response;
    } catch (error) {
      return failed(network, reject("unexpected_settle_error", errorMessage(error)), payer, amount);
    }
  }

  /**
   * Static rules (rules 1–9), with the current ledger.
   *
   * @param payload - The payment payload
   * @param requirements - The payment requirements
   * @param phase - `verify` (the cap) or `settle` (the amount to settle)
   * @returns The checked payment and its context, or a refusal
   */
  private async check(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    phase: UptoPhase,
  ): Promise<Checking> {
    if (payload.x402Version !== UPTO_X402_VERSION)
      return { ok: false, rejection: reject("invalid_x402_version") };
    const network = requirements.network;
    const contract = resolveUptoContract(network, this.options.contract);
    if (!isStellarNetwork(network) || contract === undefined) {
      return {
        ok: false,
        rejection: reject(
          "invalid_network",
          isStellarNetwork(network)
            ? `No upto settlement contract is configured for ${network}.`
            : `${network} is not a Stellar network.`,
        ),
      };
    }
    const client = this.rpcFor(network);
    const [latest, ledgerSeconds] = await Promise.all([
      client.getLatestLedger(),
      resolveLedgerSeconds(network, this.options.ledgerSeconds),
    ]);
    const result = checkUptoPayment(payload, requirements, {
      phase,
      contract,
      authority: this.authority.address,
      facilitatorAddresses: this.facilitatorAddresses,
      currentLedger: latest.sequence,
      ledgerSeconds,
      maxTimeoutSeconds: this.maxTimeoutSeconds,
      minTimeoutSeconds: this.minTimeoutSeconds,
      expirationMarginLedgers: this.expirationMarginLedgers,
      isAssetAccepted: this.options.isAssetAccepted,
    });
    if (!result.ok) return { ok: false, rejection: result.rejection, payer: result.payer };
    const { payment } = result;
    return {
      ok: true,
      checked: {
        payment,
        network,
        contract,
        rpc: client,
        parties: {
          contract,
          contractWasmHash:
            this.options.contractWasmHash ??
            (this.options.contract === undefined ? UPTO_DEPLOYMENTS[network]?.wasmHash : undefined),
          token: payment.authorization.terms.token,
          payer: payment.payer,
          recipient: payment.authorization.terms.recipient,
          authority: this.authority.address,
          facilitatorAddresses: this.facilitatorAddresses,
        },
      },
    };
  }

  /**
   * Simulation rules (10–12) for the phase amount, returning the assembled transaction.
   *
   * @param checked - The checked payment
   * @param source - The transaction source account
   * @returns The assembled transaction, or a refusal
   */
  private async simulate(checked: Checked, source: Account): Promise<Simulating> {
    const { payment, parties, network } = checked;
    const draft = this.buildTransaction(checked, source);
    const simulation = await checked.rpc.simulateTransaction(draft);

    if (rpc.Api.isSimulationError(simulation)) {
      const errors = hostErrors(simulation.events);
      return {
        ok: false,
        rejection: classifySimulationFailure(
          errors.length > 0 ? errors : hostErrorsFromMessage(simulation.error),
          parties,
          simulation.error,
        ),
      };
    }
    if (!rpc.Api.isSimulationSuccess(simulation)) {
      return { ok: false, rejection: reject("invalid_upto_stellar_payload_simulation_failed") };
    }
    if (rpc.Api.isSimulationRestore(simulation)) {
      return {
        ok: false,
        rejection:
          archivedStateRejection(simulation.restorePreamble.transactionData.build(), parties) ??
          reject("invalid_upto_stellar_payload_archived_state"),
      };
    }
    const data = simulation.transactionData.build();
    const archived = archivedStateRejection(data, parties);
    if (archived !== undefined) return { ok: false, rejection: archived };

    // A fee bump bids the inclusion fee once for itself and once for the transaction it wraps.
    const inclusionBids = this.options.feeBumpSigner === undefined ? 1 : 2;
    const fee = Number(simulation.minResourceFee) + this.inclusionFeeStroops * inclusionBids;
    if (!Number.isFinite(fee) || fee > this.maxTransactionFeeStroops) {
      return {
        ok: false,
        rejection: reject(
          "invalid_upto_stellar_payload_fee_exceeds_maximum",
          `The settlement fee would be ${fee} stroops; the ceiling on ${network} is ${this.maxTransactionFeeStroops}.`,
        ),
      };
    }

    const events = checkSimulationEvents(simulation.events, parties, payment.amount, payment.maxAmount);
    if (events !== undefined) return { ok: false, rejection: events };

    return { ok: true, transaction: rpc.assembleTransaction(draft, simulation).build() };
  }

  /**
   * `settle(payer, terms, amount)` with the authority as operation source, before simulation.
   *
   * @param checked - The checked payment
   * @param source - The transaction source account
   * @returns The unsimulated transaction
   */
  private buildTransaction(checked: Checked, source: Account): Transaction {
    const { payment, contract, network } = checked;
    const { terms, entry } = payment.authorization;
    const operation = Operation.invokeHostFunction({
      func: xdr.HostFunction.hostFunctionTypeInvokeContract(
        settleInvokeArgs(contract, payment.payer, terms, payment.amount),
      ),
      auth: [
        entry,
        ...payment.signerAuthorizations,
        authorityEntry(contract, payment.payer, terms, payment.amount),
      ],
      source: this.authority.address,
    });
    return new TransactionBuilder(source, {
      fee: String(this.inclusionFeeStroops),
      networkPassphrase: getNetworkPassphrase(network as Network),
      // Exclusive bound: the settlement cannot land after the authorization expires.
      ledgerbounds: { minLedger: 0, maxLedger: terms.expirationLedger + 1 },
    })
      .setTimeout(this.maxTimeoutSeconds)
      .addOperation(operation)
      .build();
  }

  /**
   * Simulates for the settle amount, then submits (or, for an off-chain zero, records) it. Never
   * rejects.
   *
   * @param checked - The checked payment
   * @param context - The settlement; its inner transaction hash is set once a fee bump wraps it
   * @returns The settlement response
   */
  private async execute(checked: Checked, context: SettlementContext): Promise<SettleResponse> {
    const { payment, network } = checked;
    try {
      return await this.submit(checked, context);
    } catch (error) {
      // Thrown before anything was broadcast (`submit` answers a failed broadcast itself).
      return failed(
        network,
        reject("unexpected_settle_error", errorMessage(error)),
        payment.payer,
        payment.amount.toString(),
      );
    }
  }

  /**
   * `execute` without the catch-all: a throw means nothing was broadcast.
   *
   * @param checked - The checked payment
   * @param context - The settlement; its inner transaction hash is set once a fee bump wraps it
   * @returns The settlement response
   */
  private async submit(checked: Checked, context: SettlementContext): Promise<SettleResponse> {
    const { payment, network } = checked;
    const amount = payment.amount.toString();
    const payer = payment.payer;

    if (payment.amount === 0n && this.zeroSettlement === "offchain") {
      const simulated = await this.simulate(checked, new Account(this.firstSigner().address, "0"));
      if (!simulated.ok) return failed(network, simulated.rejection, payer, amount);
      return { success: true, transaction: "", network: network as Network, payer, amount };
    }

    const signer = this.signers.get(this.selectSigner([...this.signers.keys()]));
    if (signer === undefined) {
      return failed(network, reject("settle_upto_stellar_signer_selection_failed"), payer, amount);
    }
    const retries = this.options.badSequenceRetries ?? 1;
    for (let attempt = 0; ; attempt++) {
      const submitted = await this.submitOnce(checked, context, signer);
      if (submitted !== "bad_sequence") return submitted;
      if (attempt >= retries) {
        return failed(
          network,
          reject(
            "settle_upto_stellar_channel_unavailable",
            `Another transaction of the settlement account ${signer.address} took its sequence number (txBadSeq); no funds moved, retry.`,
          ),
          payer,
          amount,
        );
      }
    }
  }

  /**
   * Builds the settlement on the signer's current sequence number, signs, fee-bumps and submits it.
   *
   * @param checked - The checked payment
   * @param context - The settlement; its inner transaction hash is set once a fee bump wraps it
   * @param signer - The transaction source
   * @returns The settlement response, or `bad_sequence` when the network refused the sequence number
   */
  private async submitOnce(
    checked: Checked,
    context: SettlementContext,
    signer: FacilitatorStellarSigner,
  ): Promise<SettleResponse | "bad_sequence"> {
    const { payment, network } = checked;
    const amount = payment.amount.toString();
    const payer = payment.payer;
    const account = await checked.rpc.getAccount(signer.address);
    const simulated = await this.simulate(checked, account);
    if (!simulated.ok) return failed(network, simulated.rejection, payer, amount);

    const passphrase = getNetworkPassphrase(network as Network);
    let signed = simulated.transaction.toXDR();
    for (const key of signer.address === this.authority.address ? [signer] : [signer, this.authority]) {
      const result = await key.signTransaction(signed, { networkPassphrase: passphrase });
      if (result.error !== undefined) {
        return failed(network, reject("settle_upto_stellar_transaction_signing_failed"), payer, amount);
      }
      signed = result.signedTxXdr;
    }

    let envelope: Transaction | FeeBumpTransaction = new Transaction(signed, passphrase);
    const feeBumpSigner = this.options.feeBumpSigner;
    if (feeBumpSigner !== undefined) {
      const bump = TransactionBuilder.buildFeeBumpTransaction(
        feeBumpSigner.address,
        String(this.inclusionFeeStroops),
        envelope,
        passphrase,
      );
      const result = await feeBumpSigner.signTransaction(bump.toXDR(), { networkPassphrase: passphrase });
      if (result.error !== undefined) {
        return failed(network, reject("settle_upto_stellar_fee_bump_signing_failed"), payer, amount);
      }
      envelope = new FeeBumpTransaction(result.signedTxXdr, passphrase);
      context.innerTransactionHash = envelope.innerTransaction.hash().toString("hex");
    }

    const transactionHash = envelope.hash().toString("hex");
    let sent: rpc.Api.SendTransactionResponse;
    try {
      sent = await checked.rpc.sendTransaction(envelope);
    } catch {
      // The RPC may have forwarded the transaction before failing to answer: it can still land.
      return failed(network, reject("settlement_pending"), payer, amount, transactionHash);
    }
    if (sent.status === "ERROR" || sent.status === "TRY_AGAIN_LATER") {
      const code = sent.errorResult === undefined ? undefined : resultCode(sent.errorResult);
      if (code === "txBadSeq") return "bad_sequence";
      return failed(
        network,
        reject(
          "settle_upto_stellar_transaction_submission_failed",
          `The network refused the settlement transaction (${sent.status}${code === undefined ? "" : `, ${code}`}); no funds moved.`,
        ),
        payer,
        amount,
      );
    }
    return this.confirm(checked.rpc, context, transactionHash);
  }

  /**
   * Polls a submitted settlement until it succeeds, fails, is proven absent or the polling budget
   * runs out. While its own hash is not found, the transaction inside the fee bump is looked up by
   * its hash too: anyone can wrap that public transaction in a fee bump of their own, and a
   * settlement that landed so is answered from that transaction. Absent is proven by NOT_FOUND for
   * both hashes from an RPC that has ingested a ledger past the authorization's expiration and still
   * retains every ledger since the settlement was requested; when the RPC can read ledger entries,
   * the payer's authorization nonce must also be unused, or the settlement stays pending.
   *
   * @param client - The network's RPC client
   * @param context - The settlement
   * @param transactionHash - The submitted transaction
   * @returns The settlement response
   */
  private async confirm(
    client: UptoRpc,
    context: SettlementContext,
    transactionHash: string,
  ): Promise<SettleResponse> {
    const { network, payer } = context;
    const amount = context.amount.toString();
    const attempts = this.options.confirmation?.attempts ?? 30;
    const intervalMs = this.options.confirmation?.intervalMs ?? 1000;
    const inner = context.innerTransactionHash;
    for (let attempt = 0; attempt < attempts; attempt++) {
      let result = await lookup(client, transactionHash);
      let landedIn = transactionHash;
      if (
        result?.status === rpc.Api.GetTransactionStatus.NOT_FOUND &&
        inner !== undefined &&
        inner !== transactionHash
      ) {
        const wrapped = await lookup(client, inner);
        if (
          wrapped?.status === rpc.Api.GetTransactionStatus.SUCCESS ||
          wrapped?.status === rpc.Api.GetTransactionStatus.FAILED
        ) {
          result = wrapped;
          landedIn = envelopeHash(wrapped, network) ?? inner;
        } else if (wrapped === undefined) {
          // Unknown whether the inner transaction landed: absence is not proven this round.
          result = undefined;
        }
      }
      if (result?.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return { success: true, transaction: landedIn, network: network as Network, payer, amount };
      }
      if (result?.status === rpc.Api.GetTransactionStatus.FAILED) {
        const code = resultCode(result.resultXdr);
        return failed(
          network,
          code === "txTooLate"
            ? reject("settle_upto_stellar_transaction_expired")
            : reject(
                "settle_upto_stellar_transaction_failed",
                `The settlement transaction failed on-chain${code === undefined ? "" : ` (${code})`}; no funds moved.`,
              ),
          payer,
          amount,
          landedIn,
        );
      }
      if (
        result?.status === rpc.Api.GetTransactionStatus.NOT_FOUND &&
        provenAbsent(result, context) &&
        (await nonceUnused(client, context))
      ) {
        return failed(
          network,
          reject("settle_upto_stellar_transaction_expired"),
          payer,
          amount,
          transactionHash,
        );
      }
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return failed(network, reject("settlement_pending"), payer, amount, transactionHash);
  }

  /**
   * A repeat of a recorded settlement: the recorded answer, or, while it is pending, the
   * transaction's current outcome (which becomes the recorded answer once final).
   *
   * @param record - The recorded settlement
   * @returns The settlement response
   */
  private async recheck(record: SettlementRecord): Promise<SettleResponse> {
    const previous = await record.result;
    if (!isPending(previous) || previous.transaction === "") return previous;
    const current = await this.confirm(this.rpcFor(record.network), record, previous.transaction);
    if (!isPending(current)) {
      record.result = Promise.resolve(current);
      record.state = "final";
    }
    return current;
  }

  /**
   * The recorded settlement a request refused by rule 7 repeats exactly (same entries, amount,
   * network, payTo and asset), once expired records are pruned: a pending one, or a final one whose
   * authorization has not expired yet.
   *
   * @param network - CAIP-2 network
   * @param payloadHash - See `settlementHash`
   * @param requirements - The request's requirements
   * @returns The record, or `undefined`
   */
  private async lateRecord(
    network: string,
    payloadHash: string,
    requirements: PaymentRequirements,
  ): Promise<SettlementRecord | undefined> {
    if (!this.byPayload.has(`${network}:${payloadHash}`)) return undefined;
    this.prune((await this.rpcFor(network).getLatestLedger()).sequence);
    const key = this.byPayload.get(`${network}:${payloadHash}`);
    const record = key === undefined ? undefined : this.settlements.get(key);
    if (record === undefined || record.payTo !== requirements.payTo || record.asset !== requirements.asset) {
      return undefined;
    }
    return record;
  }

  /**
   * Forgets settlements that can no longer be submitted or repeated usefully: once their
   * authorization expired, or, for one whose outcome was ever pending, once the RPC no longer retains
   * the ledgers it could have landed in. A settlement that was pending is kept past its expiration,
   * so a repeat still learns whether it landed and gets the same answer afterwards.
   *
   * @param latestLedger - The latest ledger
   */
  private prune(latestLedger: number): void {
    for (const [key, record] of this.settlements) {
      if (record.state !== "running" && record.keepUntilLedger < latestLedger) this.forget(key, record);
    }
  }

  /**
   * Removes a settlement record.
   *
   * @param key - Its key
   * @param record - The record
   */
  private forget(key: string, record: SettlementRecord): void {
    this.settlements.delete(key);
    this.byPayload.delete(`${record.network}:${record.payloadHash}`);
  }

  /**
   * The RPC client for a network.
   *
   * @param network - CAIP-2 network
   * @returns The injected client, or one built from `rpcConfig`
   */
  private rpcFor(network: string): UptoRpc {
    return this.options.rpc?.(network) ?? getRpcClient(network as Network, this.options.rpcConfig);
  }

  /**
   * The first signer, the transaction source used for simulations.
   *
   * @returns The signer
   */
  private firstSigner(): FacilitatorStellarSigner {
    const [signer] = this.signers.values();
    if (signer === undefined) throw new Error("no signer configured");
    return signer;
  }
}

/**
 * A signer selector that cycles through the addresses.
 *
 * @returns The selector
 */
function roundRobin(): (addresses: readonly string[]) => string {
  let index = 0;
  return (addresses) => addresses[index++ % addresses.length] ?? "";
}

/**
 * Whether a settlement response leaves the outcome open.
 *
 * @param response - The response
 * @returns True for `settlement_pending`
 */
function isPending(response: SettleResponse): boolean {
  return !response.success && response.errorReason === "settlement_pending";
}

/**
 * A transaction lookup; `undefined` when the RPC call failed.
 *
 * @param client - The network's RPC client
 * @param hash - The transaction hash
 * @returns The answer, or `undefined`
 */
async function lookup(client: UptoRpc, hash: string): Promise<rpc.Api.GetTransactionResponse | undefined> {
  try {
    return await client.getTransaction(hash);
  } catch {
    return undefined;
  }
}

/**
 * The hash of the envelope a found transaction was included in: the fee bump that wrapped it.
 *
 * @param result - A SUCCESS or FAILED answer
 * @param network - CAIP-2 network
 * @returns The hash, or `undefined` when the envelope cannot be read
 */
function envelopeHash(
  result: rpc.Api.GetSuccessfulTransactionResponse | rpc.Api.GetFailedTransactionResponse,
  network: string,
): string | undefined {
  try {
    return TransactionBuilder.fromXDR(result.envelopeXdr, getNetworkPassphrase(network as Network))
      .hash()
      .toString("hex");
  } catch {
    return undefined;
  }
}

/**
 * Whether the payer's authorization nonce is unused, so no transaction carried the authorization.
 * An RPC that cannot read ledger entries leaves the transaction lookups as the only evidence; a
 * failed read is not evidence.
 *
 * @param client - The network's RPC client
 * @param context - The settlement
 * @returns False when the nonce was consumed or could not be read
 */
async function nonceUnused(client: UptoRpc, context: SettlementContext): Promise<boolean> {
  if (client.getLedgerEntries === undefined) return true;
  try {
    const { entries } = await client.getLedgerEntries(nonceLedgerKey(context.payer, context.nonce));
    return entries.length === 0;
  } catch {
    return false;
  }
}

/**
 * The ledger key of a payer's authorization nonce: a temporary entry of the payer's address.
 *
 * @param payer - The payer (`G…` or `C…`)
 * @param nonce - The authorization's nonce
 * @returns The ledger key
 */
function nonceLedgerKey(payer: string, nonce: bigint): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(payer).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyNonce(new xdr.ScNonceKey({ nonce: xdr.Int64.fromString(nonce.toString()) })),
      durability: xdr.ContractDataDurability.temporary(),
    }),
  );
}

/**
 * Whether a NOT_FOUND answer proves the transaction was never included: the RPC has ingested a
 * ledger after the last one it could be included in (`E`; its ledger bounds end at `E + 1`), and it
 * still retains the ledger in which the settlement was requested.
 *
 * @param result - The NOT_FOUND answer
 * @param context - The settlement
 * @returns True when absent for good
 */
function provenAbsent(result: rpc.Api.GetTransactionResponse, context: SettlementContext): boolean {
  const { latestLedger, oldestLedger } = result;
  return (
    Number.isInteger(latestLedger) &&
    Number.isInteger(oldestLedger) &&
    latestLedger > context.expirationLedger &&
    oldestLedger <= context.requestedLedger
  );
}

/**
 * The part of a checked settlement a later repeat needs.
 *
 * @param checked - The checked payment
 * @param requestedLedger - The latest ledger when the settlement was requested
 * @returns The context
 */
function contextOf(checked: Checked, requestedLedger: number): SettlementContext {
  const { payment, network } = checked;
  return {
    network,
    payer: payment.payer,
    amount: payment.amount,
    payTo: payment.authorization.terms.recipient,
    asset: payment.authorization.terms.token,
    expirationLedger: payment.authorization.terms.expirationLedger,
    requestedLedger,
    nonce: payment.authorization.nonce,
  };
}

/**
 * A negative verification response.
 *
 * @param rejection - The refusal
 * @param payer - The payer, when known
 * @returns The response
 */
function invalid(rejection: UptoRejection, payer: string | undefined): VerifyResponse {
  return { isValid: false, invalidReason: rejection.code, invalidMessage: rejection.reason, payer };
}

/**
 * A failed settlement response. It carries `amount` whenever the requested amount is valid.
 *
 * @param network - CAIP-2 network
 * @param rejection - The refusal
 * @param payer - The payer, when known
 * @param amount - The requested amount, when valid
 * @param transaction - The transaction hash, when one was submitted
 * @returns The response
 */
function failed(
  network: string,
  rejection: UptoRejection,
  payer: string | undefined,
  amount: string | undefined,
  transaction = "",
): SettleResponse {
  return {
    success: false,
    errorReason: rejection.code,
    errorMessage: rejection.reason,
    transaction,
    network: network as Network,
    payer,
    ...(amount === undefined ? {} : { amount }),
  };
}

/**
 * Binds a settlement request to the signed entries and the amount.
 *
 * @param payload - The payment payload
 * @param amount - The amount to settle
 * @returns Hex sha256 over the entries and the amount
 */
function settlementHash(payload: PaymentPayload, amount: bigint): string {
  const body = payload.payload as { authorization?: unknown; signerAuthorizations?: unknown };
  const parts = [
    String(body.authorization),
    ...(Array.isArray(body.signerAuthorizations) ? body.signerAuthorizations.map(String) : []),
    `amount:${amount.toString()}`,
  ];
  return hash(Buffer.from(parts.join("\n"))).toString("hex");
}

/**
 * The result code of a transaction, looking inside a fee bump.
 *
 * @param result - The transaction result
 * @returns The result code's name, or `undefined`
 */
function resultCode(result: xdr.TransactionResult): string | undefined {
  try {
    const outer = result.result();
    if (outer.switch() === xdr.TransactionResultCode.txFeeBumpInnerFailed()) {
      return outer.innerResultPair().result().result().switch().name;
    }
    return outer.switch().name;
  } catch {
    return undefined;
  }
}

/**
 * A readable message for a thrown value.
 *
 * @param error - The thrown value
 * @returns Its message
 */
function errorMessage(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : String(error);
}
