import { randomUUID } from "node:crypto";
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
import { AssetKinds } from "./asset-kinds.ts";
import type { ChannelPool } from "./channels.ts";
import {
  explainFailedTransaction,
  explainFailedUptoTransaction,
  explainSimulation,
  resultCode,
  type FailureCause,
} from "./explain.ts";
import { fingerprintOf } from "./fingerprint.ts";
import { keypairSigner } from "./keys.ts";
import {
  DEFAULT_SCHEME,
  sameRequest,
  type FinalState,
  type RequestFingerprint,
  type SettledBy,
  type SettlementKey,
  type SettlementLedger,
  type SettlementRecord,
} from "./ledger.ts";
import { silentLogger, type Logger } from "./logger.ts";
import type { InclusionFeeOracle } from "./fees.ts";
import { containedObserver, silentObserver, type SettlementObserver } from "./observer.ts";
import type { NetworkPolicy } from "./policy.ts";
import { markRepeat, settleFailed, settleSucceeded, type FacilitatorCode } from "./responses.ts";
import { findThirdPartySettlement, nonceLedgerKey, signedAuthorizationOf } from "./third-party.ts";

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
  /**
   * How long after its envelope was recorded a settlement is left to the request that recorded it,
   * on whichever replica that request runs; the reconciler drives it only after that. Defaults to
   * `confirmTimeoutMs` plus 5 seconds, the longest that request keeps confirming it.
   */
  readonly reconcileIdleMs: number;
}

/** Margin over `confirmTimeoutMs` before the reconciler takes over a settlement a request recorded. */
export const RECONCILE_MARGIN_MS = 5_000;

export const DEFAULT_TIMING: SettlementTiming = {
  channelWaitMs: 5_000,
  claimTtlMs: 30_000,
  confirmTimeoutMs: 25_000,
  duplicateWaitMs: 25_000,
  pollIntervalMs: 1_000,
  reconcileIdleMs: 25_000 + RECONCILE_MARGIN_MS,
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
  /**
   * The `upto` settlement authority, when the network settles `upto`: the settle operation's source.
   * It signs settlement transactions only and never holds funds.
   */
  readonly authority?: Keypair;
  readonly timing?: Partial<SettlementTiming>;
  readonly log?: Logger;
  /** Network-tracking inclusion-fee bids; without it the policy's fixed bid is used. */
  readonly inclusionFee?: InclusionFeeOracle;
  /** Refuses new settlements while the sponsor cannot safely pay for them. */
  readonly guard?: SponsorGuard;
  /** Receives lease, submission, final-state, reconciliation and repeat events. */
  readonly observer?: SettlementObserver;
  /**
   * When Rail402's own transaction fails because the payer's authorization was already consumed,
   * look for the transaction that consumed it; if it carried the payer's authorization exactly as
   * signed, the payment settled and is answered as a success with that hash. Default true.
   */
  readonly reconcileThirdParty?: boolean;
}

/** Decides whether the sponsor may take on another settlement right now. */
export interface SponsorGuard {
  admit(): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;
}

export interface PreflightedPayment {
  readonly transfer: ExactTransfer;
  readonly authorization: AuthorizationInfo;
}

/** One settle request as the engine sees it, whatever its scheme. */
export interface SettlementIntent {
  readonly scheme: string;
  readonly key: SettlementKey;
  readonly fingerprint: RequestFingerprint;
  readonly payer: string;
  /** The settle-time amount in base units. Recorded, and echoed on every `upto` response. */
  readonly amount?: string;
}

/** What the engine gives a scheme to build, sign and submit its settlement transaction with. */
export interface SubmissionContext {
  /** The leased channel account: the transaction's source, and its only candidate source. */
  readonly channel: string;
  /** Signers of every channel account; only the leased one may be used. */
  readonly channelSigners: readonly FacilitatorStellarSigner[];
  /**
   * The sponsor's fee-bump signer. It records the signed envelope in the ledger before returning the
   * signature, so nothing can be broadcast that the engine could not find again.
   */
  readonly feeBumpSigner: FacilitatorStellarSigner;
  readonly inclusionFeeStroops: number;
}

/** A scheme's part of a settlement; the engine does the rest (see `SettlementEngine.execute`). */
export interface SettlementExecution {
  /** Builds, signs through `context.feeBumpSigner` and submits the settlement transaction. */
  submit(context: SubmissionContext): Promise<SettleResponse>;
  /** Refines a result reached before anything was signed, so nothing can be on the network. */
  unsigned(result: SettleResponse): Promise<SettleResponse>;
  /**
   * Settles without a transaction, when the scheme allows it (an `upto` zero settled off-chain).
   * When present, the engine claims the authorization and calls this instead of leasing a channel
   * and submitting: a success is recorded as final, which consumes the authorization in the ledger;
   * a failure drops the claim, like any result reached before signing.
   */
  offchain?(): Promise<SettleResponse>;
}

/** How a settle request relates to the settlement ledger. */
export type SettlementLookup =
  /** No settlement holds this key, or only a claim that has not signed anything: start one. */
  | { readonly kind: "none" }
  /** The same request was already submitted: answer from its record. */
  | { readonly kind: "existing"; readonly record: SettlementRecord }
  /** The key is held by a different request: refuse. */
  | { readonly kind: "conflict"; readonly record: SettlementRecord };

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
  private readonly authority: FacilitatorStellarSigner | undefined;
  private readonly options: SettlementEngineOptions;
  private readonly observer: SettlementObserver;
  /**
   * Settlements a request in this process is driving right now. The reconciler leaves them to it, so
   * it does not rebroadcast bytes the request is already confirming.
   */
  private readonly driving = new Set<string>();
  private kinds: AssetKinds | undefined;

  constructor(options: SettlementEngineOptions) {
    this.options = options;
    const confirmTimeoutMs = options.timing?.confirmTimeoutMs ?? DEFAULT_TIMING.confirmTimeoutMs;
    this.timing = {
      ...DEFAULT_TIMING,
      reconcileIdleMs: confirmTimeoutMs + RECONCILE_MARGIN_MS,
      ...options.timing,
    };
    this.log = options.log ?? silentLogger;
    this.observer = containedObserver(options.observer ?? silentObserver, this.log);
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
    this.authority =
      options.authority === undefined ? undefined : keypairSigner(options.authority, options.passphrase);
    if (this.authority !== undefined && this.signers.has(this.authority.address)) {
      throw new Error("the upto settlement authority must not be a channel account");
    }
  }

  /** Whether each accepted token is a Stellar Asset Contract, for naming its errors. */
  get assetKinds(): AssetKinds {
    this.kinds ??= new AssetKinds(this.options.server, this.options.policy.assets.values());
    return this.kinds;
  }

  get sponsorAddress(): string {
    return this.sponsorSigner.address;
  }

  get channelAddresses(): readonly string[] {
    return [...this.signers.keys()];
  }

  /** The `upto` settlement authority's signer, when this network settles `upto`. */
  get authoritySigner(): FacilitatorStellarSigner | undefined {
    return this.authority;
  }

  /** Every account the facilitator signs or pays with: sponsor, channels and the `upto` authority. */
  get facilitatorAddresses(): ReadonlySet<string> {
    return new Set([
      this.sponsorAddress,
      ...this.channelAddresses,
      ...(this.authority === undefined ? [] : [this.authority.address]),
    ]);
  }

  get network(): StellarNetwork {
    return this.options.network;
  }

  /** Settles an `exact` payment that passed preflight. */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    payment: PreflightedPayment,
  ): Promise<SettleResponse> {
    const payer = payment.transfer.from;
    const intent: SettlementIntent = {
      scheme: "exact",
      key: this.keyOf(payer, payment.authorization.nonce),
      fingerprint: fingerprintOf(payload, requirements),
      payer,
      ...(typeof requirements.amount === "string" && ATOMIC_AMOUNT.test(requirements.amount)
        ? { amount: requirements.amount }
        : {}),
    };
    return this.execute(intent, {
      submit: (context) => this.exactScheme(context).settle(payload, requirements),
      unsigned: (result) => this.explainRejection(result, payment.transfer),
    });
  }

  /** The settlement key of a payer's authorization on this engine's network. */
  keyOf(payer: string, nonce: bigint): SettlementKey {
    return { network: this.options.network, payer, nonce: nonce.toString() };
  }

  /**
   * Looks the request up in the ledger before anything else is decided. A request whose settlement
   * was already submitted is answered from its record — however late, whatever the sponsor guard or
   * the authorization's expiry say now — and a different request for the same key is refused.
   * A claim that has not signed anything is not an answer yet: such requests take the full path.
   */
  async lookup(key: SettlementKey, fingerprint: RequestFingerprint): Promise<SettlementLookup> {
    const record = await this.options.ledger.find(key);
    if (record === undefined) return { kind: "none" };
    if (!sameRequest(record, fingerprint)) return { kind: "conflict", record };
    if (record.state === "claimed") return { kind: "none" };
    return { kind: "existing", record };
  }

  /** The ledger's record for a settlement key, read-only. A read failure is counted and rethrown. */
  async findSettlement(key: SettlementKey): Promise<SettlementRecord | undefined> {
    try {
      return await this.options.ledger.find(key);
    } catch (error) {
      this.observer.ledgerReadFailed(this.options.network);
      throw error;
    }
  }

  /** The answer to a request already in the ledger, or `undefined` when a settlement must start. */
  async answerRepeat(
    scheme: string,
    key: SettlementKey,
    fingerprint: RequestFingerprint,
    amount?: string,
  ): Promise<SettleResponse | undefined> {
    const found = await this.lookup(key, fingerprint);
    if (found.kind === "none") return undefined;
    if (found.kind === "conflict") return this.conflict(found.record, scheme, amount);
    return this.answerExisting(found.record, scheme);
  }

  /**
   * Runs one settlement: sponsor guard, claim, channel lease, the scheme's submission with the
   * envelope recorded before broadcast, and confirmation from the recorded bytes. Every scheme
   * settles through here, so each gets the same idempotency, crash safety and instrumentation.
   */
  async execute(intent: SettlementIntent, execution: SettlementExecution): Promise<SettleResponse> {
    const { network } = this.options;
    const { payer } = intent;
    // A settlement without a transaction costs the sponsor nothing, so the guard has no say in it.
    if (execution.offchain === undefined) {
      const admission = await this.options.guard?.admit();
      if (admission !== undefined && !admission.ok) {
        this.log.warn({ network, reason: admission.reason }, "settlement refused by the sponsor guard");
        return this.failed(intent.scheme, {
          code: codesOf(intent.scheme).sponsorUnavailable,
          reason: admission.reason,
          payer,
          amount: intent.amount,
        });
      }
    }
    const owner = randomUUID();

    const claim = await this.options.ledger.claim(
      intent.key,
      intent.fingerprint,
      owner,
      this.timing.claimTtlMs,
      { scheme: intent.scheme, ...(intent.amount === undefined ? {} : { amount: intent.amount }) },
    );
    if (claim.kind === "conflict") return this.conflict(claim.record, intent.scheme, intent.amount);
    if (claim.kind === "existing") return this.answerExisting(claim.record, intent.scheme);

    const record = claim.record;
    this.driving.add(record.id);
    try {
      return execution.offchain === undefined
        ? await this.runClaimed(intent, execution, record, owner)
        : await this.runOffchain(intent, execution, record, owner);
    } finally {
      this.driving.delete(record.id);
    }
  }

  /**
   * `execute` for a settlement without a transaction: no channel, no envelope. A success finishes the
   * claim as `succeeded`, so the authorization is never settled again through this ledger; anything
   * else drops the claim, and the same request may be retried.
   */
  private async runOffchain(
    intent: SettlementIntent,
    execution: SettlementExecution,
    record: SettlementRecord,
    owner: string,
  ): Promise<SettleResponse> {
    let result: SettleResponse | undefined;
    try {
      result = await execution.offchain?.();
    } catch (error) {
      this.log.error({ err: error, settlement: record.id }, "off-chain settlement threw");
    }
    if (result === undefined) {
      result = this.failed(intent.scheme, {
        code: "unexpected_settle_error",
        payer: intent.payer,
        amount: intent.amount,
      });
    }
    if (!result.success) {
      await this.options.ledger.abandon(record.id, owner);
      return execution.unsigned(result);
    }
    const { record: finished, transitioned } = await this.options.ledger.finish(
      record.id,
      "succeeded",
      result,
      {
        settledBy: "rail402",
        claimedBy: owner,
      },
    );
    if (!transitioned) return this.answerExisting(finished, intent.scheme);
    this.log.info({ settlement: record.id, state: "succeeded", offchain: true }, "settlement finished");
    this.observer.finalized({
      network: this.options.network,
      scheme: intent.scheme,
      state: "succeeded",
      durationMs: Math.max(0, Date.now() - record.createdAt),
      onChainFailure: false,
      settledBy: "rail402",
    });
    return finished.response ?? result;
  }

  /** `execute` from a fresh claim on: lease, submission and confirmation. */
  private async runClaimed(
    intent: SettlementIntent,
    execution: SettlementExecution,
    record: SettlementRecord,
    owner: string,
  ): Promise<SettleResponse> {
    const { network } = this.options;
    const { payer } = intent;
    const waitStarted = Date.now();
    const channel = await this.options.channels.acquire(this.timing.channelWaitMs);
    this.observer.leaseWait(network, Date.now() - waitStarted, channel !== undefined);
    if (channel === undefined) {
      await this.options.ledger.abandon(record.id, owner);
      return this.failed(intent.scheme, {
        code: codesOf(intent.scheme).channelUnavailable,
        payer,
        amount: intent.amount,
      });
    }

    // Upstream polls for confirmation for up to maxTimeoutSeconds. Once the envelope is recorded the
    // outcome no longer depends on upstream, so the request waits at most confirmTimeoutMs from then;
    // confirm() and the reconciler decide the rest from the recorded bytes.
    let recordedAt: number | undefined;
    let upstreamResult: SettleResponse | undefined;
    const confirmWindow = deferredTimer();
    try {
      const context: SubmissionContext = {
        channel,
        channelSigners: [...this.signers.values()],
        feeBumpSigner: this.recordingSponsor(record.id, owner, () => {
          recordedAt = Date.now();
          confirmWindow.start(this.timing.confirmTimeoutMs);
        }),
        inclusionFeeStroops: await this.inclusionFeeBid(),
      };
      upstreamResult = await Promise.race([execution.submit(context), confirmWindow.elapsed]);
    } catch (error) {
      this.log.error({ err: error, settlement: record.id }, "upstream settle threw");
      upstreamResult = this.failed(intent.scheme, {
        code: "unexpected_settle_error",
        payer,
        amount: intent.amount,
      });
    } finally {
      confirmWindow.cancel();
    }

    const current = await this.options.ledger.get(record.id);
    if (current === undefined || current.owner !== owner) {
      // Our claim was taken over (it outlived claimTtlMs before signing). The new owner finishes it.
      await this.options.channels.release(channel);
      return this.answerExisting(current ?? record, intent.scheme);
    }

    if (current.state === "claimed") {
      // Nothing was signed, so nothing can be on the network: the payment may be retried as-is.
      await this.options.ledger.abandon(record.id, owner);
      await this.options.channels.release(channel);
      return execution.unsigned(
        upstreamResult ??
          this.failed(intent.scheme, { code: "unexpected_settle_error", payer, amount: intent.amount }),
      );
    }

    if (upstreamResult !== undefined) {
      // Upstream reports a transaction hash only once the network accepted the submission.
      this.observer.submission(network, {
        status: upstreamResult.transaction === "" ? "UPSTREAM_ERROR" : "PENDING",
        phase: "submit",
      });
    }
    if (upstreamResult?.success === true) {
      const hash = current.transactionHash ?? upstreamResult.transaction;
      const status = await this.lookupTransaction(hash);
      return this.complete(current, "succeeded", this.succeeded(current, hash), {
        ...(status === undefined ? {} : { feeChargedStroops: feeCharged(status) }),
      });
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
    return (await this.drive(record, deadline)).response;
  }

  /**
   * `confirm`, also telling whether the settlement is unresolvable: it can no longer be included, but
   * neither its inclusion nor its absence can be proven from here (the RPC no longer retains the
   * ledgers it could have landed in, or the payer's authorization was consumed by a transaction that
   * could not be identified). Such a record stays `submitted` for an operator to resolve.
   */
  private async drive(
    record: SettlementRecord,
    deadline: number,
  ): Promise<{ response: SettleResponse; unresolvable: boolean }> {
    const payer = record.key.payer;
    const codes = codesOf(record.scheme);
    const amount = uptoAmountOf(record);
    const hash = record.transactionHash;
    const envelopeXdr = record.envelopeXdr;
    const validUntil = record.validUntil;
    if (hash === undefined || envelopeXdr === undefined || validUntil === undefined) {
      throw new Error(`settlement ${record.id} has no recorded envelope`);
    }
    const maxLedger = recordedMaxLedger(envelopeXdr, this.options.passphrase);

    let lastBroadcast = 0;
    for (;;) {
      const status = await this.lookupTransaction(hash);
      if (status?.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return settled(
          await this.complete(record, "succeeded", this.succeeded(record, hash), {
            feeChargedStroops: feeCharged(status),
          }),
        );
      }
      if (status?.status === rpc.Api.GetTransactionStatus.FAILED) {
        return settled(await this.finishFailed(record, status, hash));
      }
      const expired = status !== undefined && pastBounds(status, validUntil, maxLedger);
      if (expired) {
        // A ledger closed after the transaction's upper time or ledger bound: it can never be included
        // from now on. Whether it was included before is decided by proof only (see `landing`).
        const landing = await this.landing(record, status);
        if (landing.kind === "landed") return settled(landing.response);
        if (landing.kind === "unproven") {
          return {
            response: this.failed(record.scheme, {
              code: "settlement_pending",
              payer,
              transaction: hash,
              amount,
            }),
            unresolvable: true,
          };
        }
        if (landing.kind === "absent") {
          return settled(
            await this.complete(
              record,
              "expired",
              this.failed(record.scheme, {
                code: codes.transactionExpired,
                payer,
                transaction: hash,
                amount,
              }),
              {},
            ),
          );
        }
        // `wait`: another transaction may still carry the authorization until it expires.
      }

      if (!expired && status !== undefined && Date.now() - lastBroadcast >= 3 * this.timing.pollIntervalMs) {
        lastBroadcast = Date.now();
        const rejection = await this.broadcast(envelopeXdr, hash);
        if (rejection !== undefined) {
          // The network refused these bytes for good; they may still have landed before (through a
          // lagging RPC, or wrapped in someone else's fee bump). Finish only on proof either way.
          const landing = await this.landing(record, status);
          if (landing.kind === "landed") return settled(landing.response);
          if (landing.kind === "absent") {
            return settled(
              await this.complete(
                record,
                "failed",
                this.failed(record.scheme, {
                  code: codes.submissionFailed,
                  reason: `The network rejected the settlement transaction (${rejection}); no funds moved.`,
                  payer,
                  transaction: hash,
                  amount,
                }),
                {},
              ),
            );
          }
          this.log.warn(
            { settlement: record.id, transaction: hash, rejection },
            "rebroadcast refused, but the settlement's absence is not proven; waiting for its bounds",
          );
        }
      }

      if (Date.now() >= deadline) {
        return settled(
          this.failed(record.scheme, { code: "settlement_pending", payer, transaction: hash, amount }),
        );
      }
      await sleep(this.timing.pollIntervalMs);
    }
  }

  /**
   * Whether a recorded settlement whose own hash reads NOT_FOUND landed anyway, before it is finished
   * as expired or failed:
   * 1. its inner transaction, wrapped in someone else's fee bump, is looked up by the inner hash
   *    (Stellar RPC indexes both); an inclusion there is finished from that result;
   * 2. the payer's authorization nonce is read: a consumed nonce means some transaction carried the
   *    authorization, and only a transaction identified on-chain (see `findThirdPartySettlement`)
   *    finishes the settlement; an unconsumed nonce, read at a ledger up to the authorization's
   *    expiration (the entry of a consumed nonce lives at least that long), proves that nothing
   *    carried it so far. For `upto` that is final: only the settlement authority can settle, and its
   *    own transaction can no longer be included. An `exact` authorization can still be carried by
   *    another transaction until it expires, so its record `waits` for the expiration ledger;
   * 3. otherwise NOT_FOUND proves absence only while the RPC still retains every ledger since the
   *    settlement was claimed.
   * A transaction found by either path that is Rail402's own envelope finishes as Rail402's
   * settlement. `unproven` leaves the record `submitted`; a read failure is `unproven`.
   */
  private async landing(
    record: SettlementRecord,
    status: rpc.Api.GetTransactionResponse,
  ): Promise<
    | { readonly kind: "landed"; readonly response: SettleResponse }
    | { readonly kind: "absent" }
    | { readonly kind: "wait" }
    | { readonly kind: "unproven" }
  > {
    const inner = record.innerTransactionHash;
    if (inner !== undefined && inner !== record.transactionHash) {
      const wrapped = await this.lookupTransaction(inner);
      if (wrapped === undefined) return { kind: "unproven" };
      if (
        wrapped.status === rpc.Api.GetTransactionStatus.SUCCESS ||
        wrapped.status === rpc.Api.GetTransactionStatus.FAILED
      ) {
        const landedIn = outerHashOf(wrapped, this.options.passphrase) ?? inner;
        if (landedIn === record.transactionHash) {
          // A lagging RPC answered NOT_FOUND for the fee bump that it indexes under the inner hash.
          const response =
            wrapped.status === rpc.Api.GetTransactionStatus.SUCCESS
              ? await this.complete(record, "succeeded", this.succeeded(record, landedIn), {
                  feeChargedStroops: feeCharged(wrapped),
                })
              : await this.finishFailed(record, wrapped, landedIn);
          return { kind: "landed", response };
        }
        this.log.warn(
          { settlement: record.id, transaction: record.transactionHash, landedIn },
          "the settlement transaction landed inside another party's fee bump",
        );
        const response =
          wrapped.status === rpc.Api.GetTransactionStatus.SUCCESS
            ? await this.complete(record, "succeeded", this.succeeded(record, landedIn), {
                settledBy: "third_party",
              })
            : await this.finishFailed(record, wrapped, landedIn, { sponsorPaid: false });
        return { kind: "landed", response };
      }
    }

    const signed = safeSignedAuthorization(record, this.options.passphrase);
    if (signed !== undefined) {
      let consumed: boolean;
      let readAt: number;
      try {
        const { entries, latestLedger } = await this.options.server.getLedgerEntries(
          nonceLedgerKey(signed.payer, signed.nonce),
        );
        consumed = entries.length > 0;
        readAt = latestLedger;
      } catch (error) {
        this.log.warn(
          { err: error, settlement: record.id },
          "could not read the payer's authorization nonce",
        );
        return { kind: "unproven" };
      }
      if (consumed) {
        const elsewhere = await this.finishSettledElsewhere(record, { sponsorPaid: false });
        if (elsewhere !== undefined) return { kind: "landed", response: elsewhere };
        this.log.warn(
          { settlement: record.id, transaction: record.transactionHash },
          "the payer's authorization was consumed by a transaction that could not be identified",
        );
        return { kind: "unproven" };
      }
      // The nonce entry lives until the authorization's expiration ledger: absent at a ledger up to
      // then (the ledger of this read, not of an earlier one), it was never consumed so far.
      if (readAt <= signed.signatureExpirationLedger) {
        return record.scheme === "upto" ? { kind: "absent" } : { kind: "wait" };
      }
    }
    return historyCovers(record, status.oldestLedgerCloseTime) ? { kind: "absent" } : { kind: "unproven" };
  }

  /**
   * Finishes a settlement whose transaction was included and failed. When the failure means the
   * payer's authorization was consumed first, it looks for the transaction that consumed it: one that
   * carried the authorization exactly as signed settled the payment, and the settlement succeeded
   * there. An `upto` authorization settled elsewhere for a different amount is not this request's
   * settlement, and is answered as such.
   */
  private async finishFailed(
    record: SettlementRecord,
    status: rpc.Api.GetFailedTransactionResponse,
    hash: string,
    options: { readonly sponsorPaid: boolean } = { sponsorPaid: true },
  ): Promise<SettleResponse> {
    const payer = record.key.payer;
    const cause = await this.explainFailure(record, status);
    const fee = options.sponsorPaid ? feeCharged(status) : undefined;
    const amount = uptoAmountOf(record);
    if (codesOf(record.scheme).thirdPartyCauses.has(cause.code)) {
      const elsewhere = await this.finishSettledElsewhere(record, {
        sponsorPaid: options.sponsorPaid,
        feeChargedStroops: fee,
        ownHash: hash,
      });
      if (elsewhere !== undefined) return elsewhere;
    }
    return this.complete(
      record,
      "failed",
      this.failed(record.scheme, {
        code: cause.code,
        reason: cause.reason,
        payer,
        transaction: hash,
        amount,
      }),
      { feeChargedStroops: fee, onChainFailure: true },
    );
  }

  /**
   * Finishes a settlement whose authorization another transaction consumed, when that transaction is
   * identified on-chain: a success for the same amount, `settled_elsewhere` for another `upto`
   * amount. `undefined` when none is identified, and nothing is finished.
   */
  private async finishSettledElsewhere(
    record: SettlementRecord,
    details: {
      readonly sponsorPaid: boolean;
      readonly feeChargedStroops?: bigint | undefined;
      readonly ownHash?: string;
    },
  ): Promise<SettleResponse | undefined> {
    const elsewhere = await this.settledElsewhere(record);
    if (elsewhere === undefined) return undefined;
    const amount = uptoAmountOf(record);
    if (elsewhere.hash === record.transactionHash) {
      // Rail402's own envelope, which a lagging RPC answered NOT_FOUND for by its hash.
      const own = await this.lookupTransaction(elsewhere.hash);
      return this.complete(record, "succeeded", this.succeeded(record, elsewhere.hash), {
        ...(own === undefined ? {} : { feeChargedStroops: feeCharged(own) }),
      });
    }
    const finish = {
      feeChargedStroops: details.feeChargedStroops,
      onChainFailure: details.sponsorPaid,
      settledBy: "third_party" as const,
    };
    if (amount === undefined || elsewhere.amount === BigInt(amount)) {
      return this.complete(record, "succeeded", this.succeeded(record, elsewhere.hash), finish);
    }
    const ours = details.ownHash ?? record.transactionHash ?? "";
    return this.complete(
      record,
      "failed",
      this.failed(record.scheme, {
        code: "settle_upto_stellar_settled_elsewhere",
        reason: `Transaction ${elsewhere.hash} settled this authorization for ${String(elsewhere.amount)} before ours (${ours}) could settle ${amount}.`,
        payer: record.key.payer,
        transaction: elsewhere.hash,
        amount,
      }),
      finish,
    );
  }

  /** The on-chain cause of an included, failed settlement transaction, by the record's scheme. */
  private async explainFailure(
    record: SettlementRecord,
    status: rpc.Api.GetFailedTransactionResponse,
  ): Promise<FailureCause> {
    if (record.scheme === "upto") {
      return explainFailedUptoTransaction(status, record, {
        passphrase: this.options.passphrase,
        facilitatorAddresses: this.facilitatorAddresses,
      });
    }
    const transfer = this.transferOf(record);
    return explainFailedTransaction(status, transfer, await this.assetKinds.of(transfer.asset));
  }

  /**
   * Finishes every recorded, unfinished settlement it can decide now. Safe to run concurrently.
   *
   * A settlement recorded less than `reconcileIdleMs` ago is left alone: the request that recorded it
   * is still confirming it, on this replica or another one, and rebroadcasting its bytes meanwhile
   * would only be answered `DUPLICATE`, or `txBadSeq` once they applied. After a crash the settlement
   * is driven once that time has passed.
   */
  async reconcile(): Promise<number> {
    const { network } = this.options;
    const unfinished = await this.options.ledger.unfinished(network, {
      idleForMs: this.timing.reconcileIdleMs,
    });
    let finished = 0;
    let unresolvable = 0;
    for (const record of unfinished) {
      if (this.driving.has(record.id)) continue;
      try {
        const driven = await this.drive(record, 0);
        if (driven.unresolvable) {
          unresolvable++;
          this.observer.reconciled(network, "unresolvable");
          this.log.warn(
            { settlement: record.id, transaction: record.transactionHash, validUntil: record.validUntil },
            "settlement unresolvable: its bounds passed, and neither its inclusion nor its absence can be " +
              "proven from the RPC; look the transaction and the payer's nonce up in Horizon or a history archive",
          );
          continue;
        }
        const { response } = driven;
        const outcome = response.errorReason === "settlement_pending" ? "pending" : stateOf(response);
        this.observer.reconciled(network, outcome);
        if (outcome !== "pending") finished++;
      } catch (error) {
        this.log.error({ err: error, settlement: record.id }, "reconcile failed");
      }
    }
    this.observer.unresolvable(network, unresolvable);
    return finished;
  }

  /** The unmodified upstream `exact` scheme, settling from the leased channel only. */
  private exactScheme(context: SubmissionContext): ExactStellarScheme {
    const { policy } = this.options;
    return new ExactStellarScheme([...context.channelSigners], {
      rpcConfig: { url: this.options.rpcUrl },
      areFeesSponsored: true,
      maxTransactionFeeStroops: policy.maxTransactionFeeStroops,
      inclusionFeeStroops: context.inclusionFeeStroops,
      selectSigner: () => context.channel,
      feeBumpSigner: context.feeBumpSigner,
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
  private async complete(
    record: SettlementRecord,
    state: FinalState,
    response: SettleResponse,
    details: {
      feeChargedStroops?: bigint | undefined;
      onChainFailure?: boolean;
      settledBy?: SettledBy;
    },
  ) {
    const settledBy = details.settledBy ?? "rail402";
    const { record: finished, transitioned } = await this.options.ledger.finish(record.id, state, response, {
      settledBy,
      ...(details.feeChargedStroops === undefined ? {} : { feeChargedStroops: details.feeChargedStroops }),
    });
    if (transitioned && record.channel !== undefined) await this.options.channels.release(record.channel);
    if (transitioned) {
      this.log.info(
        {
          settlement: record.id,
          state,
          transaction: record.transactionHash,
          reason: response.errorReason,
          ...(settledBy === "third_party" ? { settledBy, settledIn: response.transaction } : {}),
        },
        "settlement finished",
      );
      this.observer.finalized({
        network: this.options.network,
        scheme: record.scheme,
        state,
        ...(response.errorReason === undefined ? {} : { reason: response.errorReason }),
        ...(details.feeChargedStroops === undefined ? {} : { feeChargedStroops: details.feeChargedStroops }),
        durationMs: Math.max(0, Date.now() - record.createdAt),
        onChainFailure: details.onChainFailure ?? false,
        settledBy,
      });
    }
    return finished.response ?? response;
  }

  /**
   * The hash of another party's transaction that settled this payment exactly as the payer signed it,
   * when Rail402's own transaction failed on the consumed authorization. Any read failure answers
   * `undefined`, so the settlement keeps its failure: nothing is claimed that was not proven.
   */
  private async settledElsewhere(
    record: SettlementRecord,
  ): Promise<{ readonly hash: string; readonly amount: bigint } | undefined> {
    if (this.options.reconcileThirdParty === false) return undefined;
    try {
      const result = await findThirdPartySettlement(this.options.server, record, this.options.passphrase);
      if (!result.found) {
        this.log.info(
          { settlement: record.id, transaction: record.transactionHash, miss: result.miss },
          "no other transaction settled this authorization as signed",
        );
        return undefined;
      }
      if (result.settlement.hash === record.transactionHash) return result.settlement;
      this.log.warn(
        {
          settlement: record.id,
          transaction: record.transactionHash,
          settledIn: result.settlement.hash,
          ledger: result.settlement.ledger,
        },
        "another transaction settled this payment first; the sponsor fee of ours was wasted",
      );
      return result.settlement;
    } catch (error) {
      this.log.warn({ err: error, settlement: record.id }, "could not look for a third-party settlement");
      return undefined;
    }
  }

  /**
   * Refuses a request whose settlement key another request holds. An `upto` refusal names the amount
   * the authorization is held for and carries the recorded transaction, if one was submitted.
   */
  private conflict(record: SettlementRecord, scheme: string, amount?: string): SettleResponse {
    const held =
      record.transactionHash === undefined
        ? "another request is settling it"
        : `it was submitted in transaction ${record.transactionHash}`;
    if (scheme === "upto") {
      const recorded = record.amount === undefined ? "" : ` for ${record.amount}`;
      return this.failed(scheme, {
        code: codesOf(scheme).idempotencyConflict,
        reason: `This authorization was already submitted for settlement${recorded} with different payment terms; ${held}.`,
        payer: record.key.payer,
        transaction: record.transactionHash,
        amount,
      });
    }
    return this.failed(scheme, {
      code: codesOf(scheme).idempotencyConflict,
      reason: `This authorization was already submitted for settlement with a different transaction or different payment terms; ${held}.`,
      payer: record.key.payer,
    });
  }

  /** Answers a repeat from the existing settlement, waiting for it if it is still in flight. */
  private async answerExisting(record: SettlementRecord, scheme: string): Promise<SettleResponse> {
    this.observer.repeat(this.options.network, scheme);
    const { response, settledBy } = await this.awaitExisting(record, scheme);
    return markRepeat(response, settledBy);
  }

  private async awaitExisting(
    record: SettlementRecord,
    scheme: string,
  ): Promise<{ response: SettleResponse; settledBy: "rail402" | "third_party" }> {
    const payer = record.key.payer;
    const deadline = Date.now() + this.timing.duplicateWaitMs;
    let current: SettlementRecord | undefined = record;
    for (;;) {
      if (current?.response !== undefined) {
        return { response: current.response, settledBy: current.settledBy ?? "rail402" };
      }
      if (current === undefined || Date.now() >= deadline) break;
      await sleep(Math.min(250, this.timing.pollIntervalMs));
      current = await this.options.ledger.get(record.id);
    }
    const hash = current?.transactionHash;
    const amount = uptoAmountOf(current ?? record);
    const response =
      hash === undefined
        ? this.failed(scheme, { code: codesOf(scheme).settlementInProgress, payer, amount })
        : this.failed(scheme, { code: "settlement_pending", payer, transaction: hash, amount });
    return { response, settledBy: "rail402" };
  }

  /** Upstream failed before signing: return its code, refined to the on-chain cause where possible. */
  private async explainRejection(result: SettleResponse, transfer: ExactTransfer): Promise<SettleResponse> {
    const { network } = this.options;
    const code = result.errorReason ?? "unexpected_settle_error";
    if (code === "invalid_exact_stellar_payload_simulation_failed") {
      try {
        const cause = await explainSimulation(
          this.options.server,
          transfer,
          await this.assetKinds.of(transfer.asset),
        );
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

  private async lookupTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse | undefined> {
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
      if (sent.status !== "ERROR") {
        this.observer.submission(this.options.network, { status: sent.status, phase: "rebroadcast" });
        return undefined;
      }
      const code = resultCode(sent.errorResult);
      this.observer.submission(this.options.network, {
        status: "ERROR",
        resultCode: code,
        phase: "rebroadcast",
      });
      // A bad sequence can mean these very bytes were already applied, and a fee or balance shortfall
      // can pass (surge pricing, a sponsor top-up) while an earlier broadcast may still be queued.
      if (TRANSIENT_SUBMISSION_RESULTS.some((transient) => code.includes(transient))) return undefined;
      return code;
    } catch (error) {
      this.log.warn({ err: error, transaction: hash }, "broadcast failed");
      return undefined;
    }
  }

  private transferOf(record: SettlementRecord): { asset: string; from: string; to: string } {
    // The recorded envelope carries the payer's original operation byte-for-byte.
    const envelope = TransactionBuilder.fromXDR(record.envelopeXdr ?? "", this.options.passphrase);
    const inner = envelope instanceof FeeBumpTransaction ? envelope.innerTransaction : envelope;
    const operation = inner.operations[0];
    if (operation?.type !== "invokeHostFunction") throw new Error("recorded envelope is not a transfer");
    const call = operation.func.invokeContract();
    const [, to] = call.args();
    return {
      asset: addressOf(call.contractAddress()),
      from: record.key.payer,
      to: to === undefined ? "" : addressOfScVal(to),
    };
  }

  /** A success response for a record: `upto` responses always carry the amount settled. */
  private succeeded(record: SettlementRecord, transaction: string): SettleResponse {
    return settleSucceeded(this.options.network, transaction, record.key.payer, uptoAmountOf(record));
  }

  /** A failure response on this engine's network; `amount` is kept on `upto` responses only. */
  private failed(
    scheme: string,
    failure: {
      readonly code: FacilitatorCode;
      readonly reason?: string | undefined;
      readonly payer?: string | undefined;
      readonly transaction?: string | undefined;
      readonly amount?: string | undefined;
    },
  ): SettleResponse {
    return settleFailed({
      code: failure.code,
      reason: failure.reason,
      network: this.options.network,
      payer: failure.payer,
      transaction: failure.transaction,
      amount: scheme === "upto" ? failure.amount : undefined,
    });
  }
}

/** The codes the engine answers with, per scheme. */
interface SchemeCodes {
  readonly sponsorUnavailable: FacilitatorCode;
  readonly channelUnavailable: FacilitatorCode;
  readonly transactionExpired: FacilitatorCode;
  readonly submissionFailed: FacilitatorCode;
  readonly idempotencyConflict: FacilitatorCode;
  readonly settlementInProgress: FacilitatorCode;
  /**
   * Causes of an included, failed settlement after which the payment may have landed in someone
   * else's transaction: the consumed nonce, or a failure the diagnostics could not name (an RPC
   * without diagnostic events). The search itself decides; these only bound when it runs.
   */
  readonly thirdPartyCauses: ReadonlySet<string>;
}

const EXACT_CODES: SchemeCodes = {
  sponsorUnavailable: "settle_exact_stellar_sponsor_unavailable",
  channelUnavailable: "settle_exact_stellar_channel_unavailable",
  transactionExpired: "settle_exact_stellar_transaction_expired",
  submissionFailed: "settle_exact_stellar_transaction_submission_failed",
  idempotencyConflict: "settle_exact_stellar_idempotency_conflict",
  settlementInProgress: "settle_exact_stellar_settlement_in_progress",
  thirdPartyCauses: new Set([
    "invalid_exact_stellar_payload_nonce_already_used",
    "invalid_transaction_state",
  ]),
};

const UPTO_CODES: SchemeCodes = {
  sponsorUnavailable: "settle_upto_stellar_sponsor_unavailable",
  channelUnavailable: "settle_upto_stellar_channel_unavailable",
  transactionExpired: "settle_upto_stellar_transaction_expired",
  submissionFailed: "settle_upto_stellar_transaction_submission_failed",
  idempotencyConflict: "settle_upto_stellar_idempotency_conflict",
  settlementInProgress: "settle_upto_stellar_settlement_in_progress",
  thirdPartyCauses: new Set([
    "invalid_upto_stellar_payload_nonce_already_used",
    "settle_upto_stellar_transaction_failed",
  ]),
};

/** The engine's codes for `scheme`; records written before schemes were recorded are `exact`. */
function codesOf(scheme: string | undefined): SchemeCodes {
  return (scheme ?? DEFAULT_SCHEME) === "upto" ? UPTO_CODES : EXACT_CODES;
}

/** The amount an `upto` record settles, for its responses; `undefined` for other schemes. */
function uptoAmountOf(record: SettlementRecord): string | undefined {
  return record.scheme === "upto" ? record.amount : undefined;
}

/**
 * How far before a settlement's claim the RPC's retained history must reach for a NOT_FOUND to prove
 * the transaction absent. The margin absorbs clock skew between this host and the network.
 */
export const HISTORY_MARGIN_SECONDS = 60;

/**
 * Whether an RPC whose oldest retained ledger closed at `oldestLedgerCloseTime` (seconds) still holds
 * every ledger a recorded settlement could have been included in. Its transaction was signed after
 * the claim, so history from before the claim covers the whole validity window.
 */
export function historyCovers(record: SettlementRecord, oldestLedgerCloseTime: number | string): boolean {
  return (
    ledgerCloseSeconds(oldestLedgerCloseTime) <= Math.floor(record.createdAt / 1_000) - HISTORY_MARGIN_SECONDS
  );
}

/** A ledger close time in seconds. RPC answers carry it as a decimal string despite the SDK's `number` type. */
export function ledgerCloseSeconds(closeTime: number | string): number {
  return Number(closeTime);
}

/**
 * Whether the network has closed a ledger past a recorded transaction's bounds: its upper time bound
 * (`validUntil`, unix seconds) or its exclusive upper ledger bound, when it has one.
 */
function pastBounds(
  status: rpc.Api.GetTransactionResponse,
  validUntil: number,
  maxLedger: number | undefined,
): boolean {
  if (ledgerCloseSeconds(status.latestLedgerCloseTime) > validUntil) return true;
  return maxLedger !== undefined && status.latestLedger >= maxLedger;
}

/** The inner transaction's exclusive upper ledger bound, when the recorded envelope sets one. */
function recordedMaxLedger(envelopeXdr: string, passphrase: string): number | undefined {
  try {
    const envelope = TransactionBuilder.fromXDR(envelopeXdr, passphrase);
    const inner = envelope instanceof FeeBumpTransaction ? envelope.innerTransaction : envelope;
    const maxLedger = inner.ledgerBounds?.maxLedger ?? 0;
    return maxLedger > 0 ? maxLedger : undefined;
  } catch {
    return undefined;
  }
}

/** The payer's signed authorization in a recorded envelope; `undefined` when it cannot be read. */
function safeSignedAuthorization(record: SettlementRecord, passphrase: string) {
  try {
    return signedAuthorizationOf(record, passphrase);
  } catch {
    return undefined;
  }
}

/** The hash of the envelope an included transaction was found in: the outer hash of a fee bump. */
function outerHashOf(status: rpc.Api.GetTransactionResponse, passphrase: string): string | undefined {
  if (
    status.status !== rpc.Api.GetTransactionStatus.SUCCESS &&
    status.status !== rpc.Api.GetTransactionStatus.FAILED
  ) {
    return undefined;
  }
  try {
    return TransactionBuilder.fromXDR(status.envelopeXdr, passphrase).hash().toString("hex");
  } catch {
    return undefined;
  }
}

function settled(response: SettleResponse): { response: SettleResponse; unresolvable: false } {
  return { response, unresolvable: false };
}

/** A canonical non-negative integer amount in base units, as the ledger records it. */
const ATOMIC_AMOUNT = /^(?:0|[1-9][0-9]*)$/;

/** Submission results after which the same bytes may still be applied later. */
const TRANSIENT_SUBMISSION_RESULTS = [
  "txBadSeq",
  // Bounds are checked before the sequence number: bytes that already landed answer too-late once
  // their bounds pass. Expiry is decided from the network's ledgers instead (see `drive`).
  "txTooLate",
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

/** The final state a terminal response records. */
function stateOf(response: SettleResponse): FinalState {
  if (response.success) return "succeeded";
  return response.errorReason === EXACT_CODES.transactionExpired ||
    response.errorReason === UPTO_CODES.transactionExpired
    ? "expired"
    : "failed";
}

/** What the fee source paid for an included transaction, from its (fee-bump) result. */
function feeCharged(status: rpc.Api.GetTransactionResponse): bigint | undefined {
  if (
    status.status !== rpc.Api.GetTransactionStatus.SUCCESS &&
    status.status !== rpc.Api.GetTransactionStatus.FAILED
  ) {
    return undefined;
  }
  try {
    return BigInt(status.resultXdr.feeCharged().toString());
  } catch {
    return undefined;
  }
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
