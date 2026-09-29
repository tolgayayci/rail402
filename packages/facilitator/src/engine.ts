import { createHash, randomUUID } from "node:crypto";
import {
  Address,
  FeeBumpTransaction,
  TransactionBuilder,
  rpc,
  scValToNative,
  type Keypair,
  type xdr,
} from "@stellar/stellar-sdk";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";
import type { FacilitatorStellarSigner } from "@x402/stellar";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import {
  isExactStellarCode,
  type AuthorizationInfo,
  type ExactStellarCode,
  type ExactTransfer,
  type StellarNetwork,
} from "@rail402.dev/stellar";
import type { ChannelPool } from "./channels.ts";
import { explainFailedTransaction, explainSimulation, resultCode } from "./explain.ts";
import { keypairSigner } from "./keys.ts";
import type { FinalState, SettlementLedger, SettlementRecord } from "./ledger.ts";
import { silentLogger, type Logger } from "./logger.ts";
import type { InclusionFeeOracle } from "./fees.ts";
import type { NetworkPolicy } from "./policy.ts";
import { settleFailed, settleSucceeded } from "./responses.ts";

export interface SettlementTiming {
  /** How long a settle request waits for a free channel. */
  readonly channelWaitMs: number;
  /** How long a claim without an envelope stays owned before another worker may take it over. */
  readonly claimTtlMs: number;
  /** How long a settle request waits for confirmation before answering `settlement_pending`. */
  readonly confirmTimeoutMs: number;
  /** How long a duplicate request waits for the original to finish. */
  readonly duplicateWaitMs: number;
  readonly pollIntervalMs: number;
}

export const DEFAULT_TIMING: SettlementTiming = {
  channelWaitMs: 5_000,
  claimTtlMs: 30_000,
  confirmTimeoutMs: 25_000,
  duplicateWaitMs: 25_000,
  pollIntervalMs: 1_000,
};

export interface SettlementEngineOptions {
  readonly network: StellarNetwork;
  readonly passphrase: string;
  readonly rpcUrl: string;
  readonly server: rpc.Server;
  readonly policy: NetworkPolicy;
  readonly ledger: SettlementLedger;
  readonly channels: ChannelPool;
  /** Channel keypairs by address; every address in the pool must be present. */
  readonly channelKeys: ReadonlyMap<string, Keypair>;
  /** Pays every fee through a fee-bump wrapper; never a source of payment funds. */
  readonly sponsor: Keypair;
  readonly timing?: Partial<SettlementTiming>;
  readonly log?: Logger;
  /** Network-tracking inclusion-fee bids; without it the policy's fixed bid is used. */
  readonly inclusionFee?: InclusionFeeOracle;
  /** Refuses new settlements while the sponsor cannot safely pay for them. */
  readonly guard?: SponsorGuard;
}

/** Decides whether the sponsor may take on another settlement right now. */
export interface SponsorGuard {
  admit(): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;
}

export interface PreflightedPayment {
  readonly transfer: ExactTransfer;
  readonly authorization: AuthorizationInfo;
}

/**
 * Idempotent, crash-safe settlement on top of @x402/stellar.
 *
 * Settlement itself is performed by the unmodified upstream `ExactStellarScheme`, constructed per
 * call with the leased channel as its only candidate source and the sponsor as its fee-bump signer.
 * The engine wraps it with what production needs: a settlement ledger keyed by the payer's
 * authorization, an exclusive channel lease, the signed envelope persisted before broadcast, and
 * confirmation that survives timeouts and restarts without ever submitting a different transaction.
 */
export class SettlementEngine {
  private readonly timing: SettlementTiming;
  private readonly log: Logger;
  private readonly signers: ReadonlyMap<string, FacilitatorStellarSigner>;
  private readonly sponsorSigner: FacilitatorStellarSigner;
  private readonly options: SettlementEngineOptions;

  constructor(options: SettlementEngineOptions) {
    this.options = options;
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.log = options.log ?? silentLogger;
    for (const address of options.channels.addresses) {
      if (!options.channelKeys.has(address)) throw new Error(`no key for channel ${address}`);
    }
    this.signers = new Map(
      [...options.channelKeys].map(([address, keypair]) => [
        address,
        keypairSigner(keypair, options.passphrase),
      ]),
    );
    this.sponsorSigner = keypairSigner(options.sponsor, options.passphrase);
  }

  get sponsorAddress(): string {
    return this.sponsorSigner.address;
  }

  get channelAddresses(): readonly string[] {
    return [...this.signers.keys()];
  }

  /** Every account the facilitator signs or pays with. */
  get facilitatorAddresses(): ReadonlySet<string> {
    return new Set([this.sponsorAddress, ...this.channelAddresses]);
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    payment: PreflightedPayment,
  ): Promise<SettleResponse> {
    const { network } = this.options;
    const payer = payment.transfer.from;
    const admission = await this.options.guard?.admit();
    if (admission !== undefined && !admission.ok) {
      this.log.warn({ network, reason: admission.reason }, "settlement refused by the sponsor guard");
      return settleFailed({
        code: "settle_exact_stellar_sponsor_unavailable",
        reason: admission.reason,
        network,
        payer,
      });
    }
    const key = { network, payer, nonce: payment.authorization.nonce.toString() };
    const payloadHash = sha256((payload.payload as { transaction: string }).transaction);
    const owner = randomUUID();

    const claim = await this.options.ledger.claim(key, payloadHash, owner, this.timing.claimTtlMs);
    if (claim.kind === "conflict") {
      return settleFailed({ code: "settle_exact_stellar_idempotency_conflict", network, payer });
    }
    if (claim.kind === "existing") return this.awaitExisting(claim.record, payer);

    const record = claim.record;
    const channel = await this.options.channels.acquire(this.timing.channelWaitMs);
    if (channel === undefined) {
      await this.options.ledger.abandon(record.id, owner);
      return settleFailed({ code: "settle_exact_stellar_channel_unavailable", network, payer });
    }

    // Upstream polls for confirmation for up to maxTimeoutSeconds. Once the envelope is recorded the
    // outcome no longer depends on upstream, so the request waits at most confirmTimeoutMs from then;
    // confirm() and the reconciler decide the rest from the recorded bytes.
    let recordedAt: number | undefined;
    let upstreamResult: SettleResponse | undefined;
    const confirmWindow = deferredTimer();
    try {
      const scheme = this.upstreamScheme(record.id, owner, channel, await this.inclusionFeeBid(), () => {
        recordedAt = Date.now();
        confirmWindow.start(this.timing.confirmTimeoutMs);
      });
      upstreamResult = await Promise.race([scheme.settle(payload, requirements), confirmWindow.elapsed]);
    } catch (error) {
      this.log.error({ err: error, settlement: record.id }, "upstream settle threw");
      upstreamResult = settleFailed({ code: "unexpected_settle_error", network, payer });
    } finally {
      confirmWindow.cancel();
    }

    const current = await this.options.ledger.get(record.id);
    if (current === undefined || current.owner !== owner) {
      // Our claim was taken over (it outlived claimTtlMs before signing). The new owner finishes it.
      await this.options.channels.release(channel);
      return this.awaitExisting(current ?? record, payer);
    }

    if (current.state === "claimed") {
      // Nothing was signed, so nothing can be on the network: the payment may be retried as-is.
      await this.options.ledger.abandon(record.id, owner);
      await this.options.channels.release(channel);
      return this.explainRejection(
        upstreamResult ?? settleFailed({ code: "unexpected_settle_error", network, payer }),
        payment.transfer,
      );
    }

    if (upstreamResult?.success === true) {
      return this.complete(
        current,
        "succeeded",
        settleSucceeded(network, current.transactionHash ?? upstreamResult.transaction, payer),
      );
    }
    return this.confirm(current, (recordedAt ?? Date.now()) + this.timing.confirmTimeoutMs);
  }

  /** The inclusion-fee bid in stroops: the network-tracking oracle's, or the policy's fixed bid. */
  async inclusionFeeBid(): Promise<number> {
    return (await this.options.inclusionFee?.bid()) ?? this.options.policy.inclusionFeeStroops;
  }

  /**
   * Drives a recorded settlement toward a final state until `deadline` (ms epoch). Answers
   * `settlement_pending` if the transaction is neither final nor expired by then; the reconciler
   * finishes it later. Only ever resubmits the recorded bytes.
   */
  async confirm(record: SettlementRecord, deadline: number): Promise<SettleResponse> {
    const { network } = this.options;
    const payer = record.key.payer;
    const hash = record.transactionHash;
    const envelopeXdr = record.envelopeXdr;
    const validUntil = record.validUntil;
    if (hash === undefined || envelopeXdr === undefined || validUntil === undefined) {
      throw new Error(`settlement ${record.id} has no recorded envelope`);
    }

    let lastBroadcast = 0;
    for (;;) {
      const status = await this.lookup(hash);
      if (status?.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return this.complete(record, "succeeded", settleSucceeded(network, hash, payer));
      }
      if (status?.status === rpc.Api.GetTransactionStatus.FAILED) {
        const transfer = await this.transferOf(record);
        const cause = explainFailedTransaction(status, transfer);
        return this.complete(
          record,
          "failed",
          settleFailed({ code: cause.code, reason: cause.reason, network, payer, transaction: hash }),
        );
      }
      if (status !== undefined && status.latestLedgerCloseTime > validUntil) {
        // A ledger closed after the transaction's upper time bound: it can never be included.
        return this.complete(
          record,
          "expired",
          settleFailed({
            code: "settle_exact_stellar_transaction_expired",
            network,
            payer,
            transaction: hash,
          }),
        );
      }

      if (status !== undefined && Date.now() - lastBroadcast >= 3 * this.timing.pollIntervalMs) {
        lastBroadcast = Date.now();
        const rejection = await this.broadcast(envelopeXdr, hash);
        if (rejection !== undefined) {
          return this.complete(
            record,
            "failed",
            settleFailed({
              code: "settle_exact_stellar_transaction_submission_failed",
              reason: `The network rejected the settlement transaction (${rejection}); no funds moved.`,
              network,
              payer,
              transaction: hash,
            }),
          );
        }
      }

      if (Date.now() >= deadline) {
        return settleFailed({ code: "settlement_pending", network, payer, transaction: hash });
      }
      await sleep(this.timing.pollIntervalMs);
    }
  }

  /** Finishes every recorded, unfinished settlement it can decide now. Safe to run concurrently. */
  async reconcile(): Promise<number> {
    const unfinished = await this.options.ledger.unfinished(this.options.network);
    let finished = 0;
    for (const record of unfinished) {
      try {
        const response = await this.confirm(record, 0);
        if (response.errorReason !== "settlement_pending") finished++;
      } catch (error) {
        this.log.error({ err: error, settlement: record.id }, "reconcile failed");
      }
    }
    return finished;
  }

  private upstreamScheme(
    recordId: string,
    owner: string,
    channel: string,
    inclusionFee: number,
    onRecorded: () => void,
  ): ExactStellarScheme {
    const { policy } = this.options;
    return new ExactStellarScheme([...this.signers.values()], {
      rpcConfig: { url: this.options.rpcUrl },
      areFeesSponsored: true,
      maxTransactionFeeStroops: policy.maxTransactionFeeStroops,
      inclusionFeeStroops: inclusionFee,
      selectSigner: () => channel,
      feeBumpSigner: this.recordingSponsor(recordId, owner, onRecorded),
    });
  }

  /**
   * The sponsor's fee-bump signer, instrumented to persist the signed envelope before upstream can
   * broadcast it. If the write fails, signing fails and upstream submits nothing.
   */
  private recordingSponsor(
    recordId: string,
    owner: string,
    onRecorded: () => void,
  ): FacilitatorStellarSigner {
    const { passphrase, ledger } = this.options;
    const base = this.sponsorSigner;
    return {
      address: base.address,
      signAuthEntry: base.signAuthEntry,
      signTransaction: async (xdrToSign, opts) => {
        const signed = await base.signTransaction(xdrToSign, opts);
        if (signed.error !== undefined) return signed;
        try {
          const bump = TransactionBuilder.fromXDR(signed.signedTxXdr, passphrase);
          if (!(bump instanceof FeeBumpTransaction))
            throw new Error("sponsor signed a non-fee-bump transaction");
          const inner = bump.innerTransaction;
          const maxTime = Number(inner.timeBounds?.maxTime ?? 0);
          if (maxTime <= 0) throw new Error("settlement transaction has no upper time bound");
          await ledger.recordEnvelope(recordId, owner, {
            channel: inner.source,
            transactionHash: bump.hash().toString("hex"),
            innerTransactionHash: inner.hash().toString("hex"),
            envelopeXdr: signed.signedTxXdr,
            validUntil: maxTime,
            maxFeeStroops: bump.fee,
          });
          onRecorded();
          return signed;
        } catch (error) {
          this.log.error({ err: error, settlement: recordId }, "could not record settlement envelope");
          return {
            signedTxXdr: "",
            error: { code: -1, message: "settlement envelope could not be recorded" },
          };
        }
      },
    };
  }

  /** Terminal transition; releases the channel only if this call made the transition. */
  private async complete(record: SettlementRecord, state: FinalState, response: SettleResponse) {
    const { record: finished, transitioned } = await this.options.ledger.finish(record.id, state, response);
    if (transitioned && record.channel !== undefined) await this.options.channels.release(record.channel);
    if (transitioned) {
      this.log.info(
        { settlement: record.id, state, transaction: record.transactionHash, reason: response.errorReason },
        "settlement finished",
      );
    }
    return finished.response ?? response;
  }

  private async awaitExisting(record: SettlementRecord, payer: string): Promise<SettleResponse> {
    const deadline = Date.now() + this.timing.duplicateWaitMs;
    let current: SettlementRecord | undefined = record;
    for (;;) {
      if (current?.response !== undefined) return current.response;
      if (current === undefined || Date.now() >= deadline) break;
      await sleep(Math.min(250, this.timing.pollIntervalMs));
      current = await this.options.ledger.get(record.id);
    }
    const hash = current?.transactionHash;
    return hash === undefined
      ? settleFailed({
          code: "settle_exact_stellar_settlement_in_progress",
          network: this.options.network,
          payer,
        })
      : settleFailed({ code: "settlement_pending", network: this.options.network, payer, transaction: hash });
  }

  /** Upstream failed before signing: return its code, refined to the on-chain cause where possible. */
  private async explainRejection(result: SettleResponse, transfer: ExactTransfer): Promise<SettleResponse> {
    const { network } = this.options;
    const code = result.errorReason ?? "unexpected_settle_error";
    if (code === "invalid_exact_stellar_payload_simulation_failed") {
      try {
        const cause = await explainSimulation(this.options.server, transfer);
        if (cause !== undefined) {
          return settleFailed({ code: cause.code, reason: cause.reason, network, payer: transfer.from });
        }
      } catch (error) {
        this.log.warn({ err: error }, "could not explain simulation failure");
      }
    }
    return settleFailed({
      code: isKnown(code) ? code : "unexpected_settle_error",
      reason: result.errorMessage,
      network,
      payer: transfer.from,
    });
  }

  private async lookup(hash: string): Promise<rpc.Api.GetTransactionResponse | undefined> {
    try {
      return await this.options.server.getTransaction(hash);
    } catch (error) {
      this.log.warn({ err: error, transaction: hash }, "getTransaction failed");
      return undefined;
    }
  }

  /**
   * Broadcasts the recorded envelope. Returns a rejection description only when these bytes can never
   * be applied; anything ambiguous or transient returns `undefined`, polling continues and the
   * transaction's time bound decides.
   */
  private async broadcast(envelopeXdr: string, hash: string): Promise<string | undefined> {
    try {
      const envelope = TransactionBuilder.fromXDR(envelopeXdr, this.options.passphrase);
      const sent = await this.options.server.sendTransaction(envelope);
      if (sent.status !== "ERROR") return undefined;
      const code = resultCode(sent.errorResult);
      // A bad sequence can mean these very bytes were already applied, and a fee or balance shortfall
      // can pass (surge pricing, a sponsor top-up) while an earlier broadcast may still be queued.
      if (TRANSIENT_SUBMISSION_RESULTS.some((transient) => code.includes(transient))) return undefined;
      return code;
    } catch (error) {
      this.log.warn({ err: error, transaction: hash }, "broadcast failed");
      return undefined;
    }
  }

  private transferOf(record: SettlementRecord): Promise<{ asset: string; from: string; to: string }> {
    // The recorded envelope carries the payer's original operation byte-for-byte.
    const envelope = TransactionBuilder.fromXDR(record.envelopeXdr ?? "", this.options.passphrase);
    const inner = envelope instanceof FeeBumpTransaction ? envelope.innerTransaction : envelope;
    const operation = inner.operations[0];
    if (operation?.type !== "invokeHostFunction") throw new Error("recorded envelope is not a transfer");
    const call = operation.func.invokeContract();
    const [, to] = call.args();
    return Promise.resolve({
      asset: addressOf(call.contractAddress()),
      from: record.key.payer,
      to: to === undefined ? "" : addressOfScVal(to),
    });
  }
}

/** Submission results after which the same bytes may still be applied later. */
const TRANSIENT_SUBMISSION_RESULTS = [
  "txBadSeq",
  "txInsufficientFee",
  "txInsufficientBalance",
  "txTooEarly",
  "txInternalError",
];

/** A timer that can be started later, raced against, and cancelled. Resolves `undefined`. */
function deferredTimer() {
  let resolve: (value: undefined) => void = () => undefined;
  let handle: NodeJS.Timeout | undefined;
  const elapsed = new Promise<undefined>((done) => {
    resolve = done;
  });
  return {
    elapsed,
    start(ms: number) {
      handle ??= setTimeout(() => {
        resolve(undefined);
      }, ms);
    },
    cancel() {
      clearTimeout(handle);
    },
  };
}

function isKnown(code: string): code is ExactStellarCode {
  return isExactStellarCode(code);
}

function addressOf(address: xdr.ScAddress): string {
  return Address.fromScAddress(address).toString();
}

function addressOfScVal(value: xdr.ScVal): string {
  return scValToNative(value) as string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
