import { randomUUID } from "node:crypto";
import {
  Address,
  FeeBumpTransaction,
  TransactionBuilder,
  rpc,
  Keypair,
  scValToNative,
  xdr,
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
  rpcSimulationReason,
  resultCode,
  type FailureCause,
} from "./explain.ts";
import { fingerprintOf } from "./fingerprint.ts";
import { keypairSigner } from "./keys.ts";
import { PUBLIC_CALLER, currentCaller, type CallerContext } from "./caller.ts";
import {
  ClaimRefusedError,
  DEFAULT_SCHEME,
  FIRST_SEND,
  broadcastMayBePublic,
  sameRequest,
  type Claim,
  type ClaimLimit,
  type FinalState,
  type RequestFingerprint,
  type SettledBy,
  type SettlementKey,
  type SettlementLedger,
  type SettlementRecord,
} from "./ledger.ts";
import { silentLogger, type Logger } from "./logger.ts";
import type { InclusionFeeOracle } from "./fees.ts";
import type { RpcPool } from "./rpc-pool.ts";
import {
  containedObserver,
  silentObserver,
  type SequenceConflictReason,
  type SettlementObserver,
} from "./observer.ts";
import type { NetworkPolicy } from "./policy.ts";
import { attemptOf, markRepeat, settleFailed, settleSucceeded, type FacilitatorCode } from "./responses.ts";
import {
  findThirdPartySettlement,
  nonceLedgerKey,
  signedAuthorizationOf,
  type ThirdPartyMiss,
  type ThirdPartySettlement,
} from "./third-party.ts";

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
  /**
   * How long a channel stays out of rotation after another transaction took its sequence number,
   * doubled for each further conflict in a row (see `ChannelPool.quarantine`).
   */
  readonly channelQuarantineMs: number;
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
  channelQuarantineMs: 60_000,
};

export interface SettlementEngineOptions {
  readonly network: StellarNetwork;
  readonly passphrase: string;
  readonly rpcUrl: string;
  readonly server: rpc.Server;
  /**
   * The network's RPC providers; each settlement pins the active one (`RpcPool.pin`). Without it every
   * settlement uses `rpcUrl` and `server`.
   */
  readonly rpc?: RpcPool;
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

/** What the sponsor guard knows about a settlement it is asked to admit. */
export interface AdmissionContext {
  readonly network: string;
  readonly scheme: string;
  readonly payer: string;
  /** The payment's recipient, when the scheme reports it. */
  readonly payTo?: string;
  /** The caller of the request, when the service set one (`withCaller`). */
  readonly caller?: CallerContext;
}

/** Why a guard refused, and which per-party limit refused it when one did. */
export interface AdmissionRefusal {
  readonly reason: string;
  /** Set when a per-party limit refused (see `SettleLimits`); otherwise the sponsor is unavailable. */
  readonly limit?: "payer_rate" | "payto_rate" | "payer_cooldown";
}

/** Decides whether the sponsor may take on another settlement right now. */
export interface SponsorGuard {
  admit(
    context?: AdmissionContext,
  ): Promise<{ readonly ok: true } | ({ readonly ok: false } & AdmissionRefusal)>;
  /**
   * Hourly fee limits the settlement's claim must stay within. The settlement ledger checks them
   * together with the claim, atomically across replicas, so concurrent admissions cannot overshoot.
   */
  limits?(context: AdmissionContext): readonly ClaimLimit[];
  /** Told when the ledger refused a claim for one of `limits`; returns the refusal's reason. */
  refusedByLedger?(limit: ClaimLimit, context: AdmissionContext): string;
  /**
   * Asked once the payment has proven itself, just before the sponsor signs the fee bump: the
   * scheme's verification and simulation passed, so the payer's authorization is genuinely signed.
   * Quotas keyed by the payer or the payTo belong here, never in `admit`, which runs on bytes anyone
   * can forge: a payload with a garbage signature must not use up another party's quota.
   */
  admitVerified?(
    context: AdmissionContext,
  ): Promise<{ readonly ok: true } | ({ readonly ok: false } & AdmissionRefusal)>;
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
  /**
   * The most the settlement can cost the sponsor, reserved against the hourly budgets from the claim
   * until its envelope is recorded; the network's `exact` fee ceiling when omitted.
   */
  readonly reserveFeeStroops?: bigint;
  /** The payment's recipient, for per-recipient limits. */
  readonly payTo?: string;
  /** The resource server's settle attempt id, recorded with the claim and echoed in repeats. */
  readonly attempt?: string;
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
  /** The RPC provider active when the settlement was claimed; it simulates and submits through it. */
  readonly rpcUrl: string;
  readonly server: rpc.Server;
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
  /** The last sequence-conflict decline reported per settlement, oldest first (see `finishSequenceTaken`). */
  private readonly conflictDecisions = new Map<string, SequenceConflictReason>();
  /**
   * When each unfinished settlement's look first ended undecided on its reads (ms epoch). Only its
   * finishing clears it: a pass that cannot look the settlement up, or that throws, does not.
   */
  private readonly undecidedSince = new Map<string, number>();
  private kinds: AssetKinds | undefined;
  private warnedRecordOnly = false;

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
      ...(typeof requirements.payTo === "string" ? { payTo: requirements.payTo } : {}),
      ...(typeof requirements.amount === "string" && ATOMIC_AMOUNT.test(requirements.amount)
        ? { amount: requirements.amount }
        : {}),
      ...attemptOf(payload),
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

  /**
   * Read-only: the ledger of this network the hold counts from since the settlement ledger was last
   * restored to an earlier state, `null` when nothing is recorded yet (`SettlementLedger.rewindAnchor`),
   * or `undefined` when it never was or cannot be. Requests never record it (`recordRestoreHold` does).
   * A read failure is counted and rethrown.
   */
  async rewindAnchor(): Promise<number | null | undefined> {
    const { ledger, network } = this.options;
    if (ledger.rewindAnchor === undefined) {
      // A ledger that records holds but cannot read them back must not lift one: hold every time.
      if (ledger.rewindLedger === undefined) return undefined;
      if (!this.warnedRecordOnly) {
        this.warnedRecordOnly = true;
        this.log.warn(
          { network },
          "the settlement ledger records restore holds but cannot read them (no rewindAnchor): upto stays held",
        );
      }
      return null;
    }
    try {
      return await ledger.rewindAnchor(network);
    } catch (error) {
      this.observer.ledgerReadFailed(network);
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
    const caller = currentCaller();
    const admissionContext: AdmissionContext = {
      network,
      scheme: intent.scheme,
      payer,
      ...(intent.payTo === undefined ? {} : { payTo: intent.payTo }),
      ...(caller === undefined ? {} : { caller }),
    };
    const sponsored = execution.offchain === undefined;
    // A settlement without a transaction costs the sponsor nothing, so the guard has no say in it.
    if (sponsored) {
      const admission = await this.options.guard?.admit(admissionContext);
      if (admission !== undefined && !admission.ok) return this.refusedByGuard(intent, admission);
    }
    const owner = randomUUID();

    const limits = sponsored ? (this.options.guard?.limits?.(admissionContext) ?? []) : [];
    let claim: Claim;
    try {
      claim = await this.options.ledger.claim(intent.key, intent.fingerprint, owner, this.timing.claimTtlMs, {
        scheme: intent.scheme,
        ...(intent.amount === undefined ? {} : { amount: intent.amount }),
        caller: caller?.subject ?? PUBLIC_CALLER,
        ...(caller?.serviceFeeUsd === undefined ? {} : { serviceFeeUsd: caller.serviceFeeUsd }),
        ...(intent.attempt === undefined ? {} : { attempt: intent.attempt }),
        ...(sponsored && limits.length > 0 ? { reserveFeeStroops: this.reservationOf(intent), limits } : {}),
      });
    } catch (error) {
      if (!(error instanceof ClaimRefusedError)) throw error;
      const reason =
        this.options.guard?.refusedByLedger?.(error.limit, admissionContext) ??
        `The hourly fee budget for ${network} is exhausted; retry later.`;
      this.log.warn({ network, scope: error.limit.scope, reason }, "settlement refused by a fee budget");
      return this.failed(intent.scheme, {
        code:
          error.limit.scope === "caller"
            ? codesOf(intent.scheme).callerBudgetExhausted
            : codesOf(intent.scheme).sponsorUnavailable,
        reason,
        payer,
        amount: intent.amount,
      });
    }
    if (claim.kind === "conflict") return this.conflict(claim.record, intent.scheme, intent.amount);
    if (claim.kind === "existing") return this.answerExisting(claim.record, intent.scheme);

    const record = claim.record;
    this.driving.add(record.id);
    try {
      return execution.offchain === undefined
        ? await this.runClaimed(intent, execution, record, owner, admissionContext)
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

  /** A refusal of the sponsor guard as the scheme's settle response. Nothing was signed. */
  private refusedByGuard(intent: SettlementIntent, refusal: AdmissionRefusal): SettleResponse {
    this.log.warn(
      { network: this.options.network, reason: refusal.reason },
      "settlement refused by the sponsor guard",
    );
    const codes = codesOf(intent.scheme);
    return this.failed(intent.scheme, {
      code:
        refusal.limit === "payer_rate"
          ? codes.payerRateLimited
          : refusal.limit === "payto_rate"
            ? codes.payToRateLimited
            : refusal.limit === "payer_cooldown"
              ? codes.payerCooldown
              : codes.sponsorUnavailable,
      reason: refusal.reason,
      payer: intent.payer,
      amount: intent.amount,
    });
  }

  /** `execute` from a fresh claim on: lease, submission and confirmation. */
  private async runClaimed(
    intent: SettlementIntent,
    execution: SettlementExecution,
    record: SettlementRecord,
    owner: string,
    admissionContext: AdmissionContext,
  ): Promise<SettleResponse> {
    const { network } = this.options;
    const { payer } = intent;
    const waitStarted = Date.now();
    const channel = await this.leaseChannel(waitStarted);
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
    // Set when the guard refused the proven payment at signing time (`SponsorGuard.admitVerified`).
    let verifiedRefusal: AdmissionRefusal | undefined;
    const confirmWindow = deferredTimer();
    // Nothing may be signed once the claim could be taken over or the channel lease could expire: a
    // hung RPC call before signing must not let two settlements build on one channel sequence. The
    // claim TTL is the shorter of the two windows, so signing stops there, and the request stops
    // waiting for an upstream that has not recorded anything by then.
    let signingClosed = false;
    const signWindow = deferredTimer();
    const signWindowMs = Math.max(1, this.timing.claimTtlMs - (Date.now() - waitStarted));
    signWindow.start(signWindowMs);
    void signWindow.elapsed.then(() => {
      if (recordedAt === undefined) signingClosed = true;
    });
    try {
      const pinned = this.options.rpc?.pin();
      const context: SubmissionContext = {
        rpcUrl: pinned?.url ?? this.options.rpcUrl,
        server: pinned?.server ?? this.options.server,
        channel,
        channelSigners: [...this.signers.values()],
        feeBumpSigner: this.recordingSponsor(record.id, owner, {
          maxFeeStroops: this.reservationOf(intent),
          open: () => !signingClosed,
          admit: async () => {
            const verdict = await this.options.guard?.admitVerified?.(admissionContext);
            if (verdict === undefined || verdict.ok) return true;
            verifiedRefusal = verdict;
            return false;
          },
          onRecorded: () => {
            recordedAt = Date.now();
            confirmWindow.start(this.timing.confirmTimeoutMs);
          },
        }),
        inclusionFeeStroops: await this.inclusionFeeBid(),
      };
      const unsignedInTime = signWindow.elapsed.then(() =>
        recordedAt === undefined ? SIGN_WINDOW_ELAPSED : new Promise<never>(() => undefined),
      );
      const raced = await Promise.race([execution.submit(context), confirmWindow.elapsed, unsignedInTime]);
      if (raced === SIGN_WINDOW_ELAPSED) {
        this.log.warn(
          { settlement: record.id, channel, waitedMs: signWindowMs },
          "nothing was signed within the claim window; the settlement stops before signing",
        );
        upstreamResult = this.failed(intent.scheme, {
          code: "unexpected_settle_error",
          reason: "The RPC provider did not answer in time; nothing was signed. Retry the settlement.",
          payer,
          amount: intent.amount,
        });
      } else {
        upstreamResult = raced;
      }
    } catch (error) {
      this.log.error({ err: error, settlement: record.id }, "upstream settle threw");
      upstreamResult = this.failed(intent.scheme, {
        code: "unexpected_settle_error",
        payer,
        amount: intent.amount,
      });
    } finally {
      confirmWindow.cancel();
      signWindow.cancel();
      // From here on nothing more is signed for this attempt, whatever upstream is still doing.
      if (recordedAt === undefined) signingClosed = true;
    }

    let current = await this.options.ledger.get(record.id);
    if (current === undefined || current.owner !== owner) {
      // Our claim was taken over (it outlived claimTtlMs before signing). The new owner finishes it.
      await this.options.channels.release(channel);
      return this.answerExisting(current ?? record, intent.scheme);
    }

    if (current.state === "claimed") {
      // Nothing was signed, so nothing can be on the network: the payment may be retried as-is.
      await this.options.ledger.abandon(record.id, owner);
      // A signature already under way when the window closed may have recorded its envelope between
      // the read and the abandon (which only removes an unrecorded claim): drive it then.
      const after = await this.options.ledger.get(record.id);
      if (after !== undefined && after.state !== "claimed" && after.owner === owner) {
        current = after;
      } else {
        await this.options.channels.release(channel);
        if (verifiedRefusal !== undefined) return this.refusedByGuard(intent, verifiedRefusal);
        return execution.unsigned(
          upstreamResult ??
            this.failed(intent.scheme, { code: "unexpected_settle_error", payer, amount: intent.amount }),
        );
      }
    }

    if (upstreamResult !== undefined) {
      // Upstream reports a transaction hash only once the network accepted the submission.
      this.observer.submission(network, {
        status: upstreamResult.transaction === "" ? "UPSTREAM_ERROR" : "PENDING",
        phase: "submit",
      });
    }
    // The scheme's own send: a reported hash means the network accepted it, a refusal before any hash
    // means it did not. Anything else (no answer within the window, a send that threw) stays in flight,
    // and counts as accepted from then on.
    const firstRefused =
      upstreamResult !== undefined &&
      upstreamResult.transaction === "" &&
      // `exact` reports every refused send as a submission failure, the `upto` mechanism a refused
      // sequence number as an unavailable channel.
      (upstreamResult.errorReason === codesOf(intent.scheme).submissionFailed ||
        (intent.scheme === "upto" &&
          upstreamResult.errorReason === codesOf(intent.scheme).channelUnavailable));
    if (upstreamResult !== undefined && upstreamResult.transaction !== "") {
      await this.endSend(current, FIRST_SEND, true);
    } else if (firstRefused) {
      await this.endSend(current, FIRST_SEND, false);
    }
    if (upstreamResult?.success === true) {
      const hash = current.transactionHash ?? upstreamResult.transaction;
      const status = await this.lookupTransaction(hash);
      return this.complete(current, "succeeded", this.succeeded(current, hash), {
        ...(status === undefined ? {} : { feeChargedStroops: feeCharged(status) }),
      });
    }
    if (firstRefused) {
      const refused = await this.firstSubmissionRefused(current);
      if (refused !== undefined) return refused;
      // It may have given its channel back meanwhile: then its bytes are not sent again.
      current = (await this.options.ledger.get(record.id).catch(() => undefined)) ?? current;
    }
    return this.confirm(current, (recordedAt ?? Date.now()) + this.timing.confirmTimeoutMs);
  }

  /**
   * Leases a channel within the channel wait that started at `waitStarted`. A channel coming back from
   * a quarantine is checked first: when its account's sequence number moved since the conflict,
   * someone still uses the account, so it is quarantined again (for twice as long) and another channel
   * is leased instead. A failed read leases it anyway; a conflict would quarantine it again.
   */
  private async leaseChannel(waitStarted: number): Promise<string | undefined> {
    const { channels } = this.options;
    for (let attempt = 0; ; attempt++) {
      const remaining =
        attempt === 0
          ? this.timing.channelWaitMs
          : Math.max(0, this.timing.channelWaitMs - (Date.now() - waitStarted));
      const channel = await channels.acquire(remaining);
      if (channel === undefined) return undefined;
      const moved = await this.movedSinceQuarantine(channel);
      if (moved === undefined) return channel;
      this.log.warn(
        { channel, quarantinedAt: moved.quarantinedAt, accountSequence: moved.accountSequence },
        "the quarantined channel's sequence number moved again; quarantining it again",
      );
      await channels.quarantine(channel, this.timing.channelQuarantineMs, moved.accountSequence);
      if (Date.now() - waitStarted >= this.timing.channelWaitMs) return undefined;
    }
  }

  /** How a leased channel's sequence number moved since its quarantine; undefined when it did not. */
  private async movedSinceQuarantine(
    channel: string,
  ): Promise<{ readonly quarantinedAt: string; readonly accountSequence: string } | undefined> {
    let quarantinedAt: string | undefined;
    try {
      quarantinedAt = await this.options.channels.takeQuarantineSequence(channel);
    } catch (error) {
      this.log.warn({ err: error, channel }, "could not read the channel's quarantine");
      return undefined;
    }
    if (quarantinedAt === undefined) return undefined;
    try {
      const { entries } = await this.options.server.getLedgerEntries(
        xdr.LedgerKey.account(
          new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(channel).xdrAccountId() }),
        ),
      );
      const entry = entries[0];
      if (entry === undefined) return undefined;
      const accountSequence = entry.val.account().seqNum().toString();
      return BigInt(accountSequence) > BigInt(quarantinedAt) ? { quarantinedAt, accountSequence } : undefined;
    } catch (error) {
      this.log.warn({ err: error, channel }, "could not read the quarantined channel's sequence number");
      return undefined;
    }
  }

  /**
   * Decides a settlement whose first submission the network refused for good. The scheme's own
   * broadcast was not accepted (upstream reports a hash only for an accepted one), so these bytes were
   * never queued anywhere: sending them once more and getting a refusal that is neither a sequence nor
   * a time-bound result (both are checked before signatures and fees, so a refusal past them means the
   * sequence still admits these bytes) proves they never applied. Nothing was charged.
   *
   * An `upto` settlement finishes at once as a submission failure and its channel is released: only the
   * settlement authority can carry its authorization, so a payload the network can never accept holds
   * neither a channel nor fee budget. Anyone who holds an `exact` payment (its payer, the seller, anyone
   * it passed through) can carry its authorization in a transaction of their own until it expires, so
   * `landing` decides it: a copy that landed finishes it as settled elsewhere, and while one may still
   * land it keeps waiting (`confirm`), until the authorization expired unused.
   *
   * A refused sequence number (`txBadSeq`) is decided by `finishSequenceTaken`. Anything else
   * (accepted, a transient refusal, a read or send failure) leaves it to `confirm`.
   */
  private async firstSubmissionRefused(record: SettlementRecord): Promise<SettleResponse | undefined> {
    const hash = record.transactionHash;
    const envelopeXdr = record.envelopeXdr;
    if (hash === undefined || envelopeXdr === undefined) return undefined;
    const status = await this.lookupTransaction(hash);
    if (status?.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) return undefined;
    const sent = await this.broadcast(record);
    if (sent.badSequence) return this.finishSequenceTaken(record, status);
    const rejection = sent.rejection;
    if (rejection === undefined) return undefined;
    if (othersCanCarry(record)) {
      const landing = await this.landing(record, status);
      if (landing.kind === "landed") return landing.response;
      if (landing.kind !== "absent") {
        this.log.warn(
          { settlement: record.id, transaction: hash, rejection, landing: landing.kind },
          "the network refused the settlement's first submission for good, but another transaction can still carry the payer's authorization; waiting until it expires",
        );
        return undefined;
      }
    }
    this.log.warn(
      { settlement: record.id, transaction: hash, rejection },
      "the network refused the settlement's first submission for good",
    );
    return this.complete(
      record,
      "failed",
      this.failed(record.scheme, {
        code: codesOf(record.scheme).submissionFailed,
        reason: `The network rejected the settlement transaction (${rejection}); no funds moved.`,
        payer: record.key.payer,
        transaction: hash,
        amount: uptoAmountOf(record),
      }),
      { feeChargedStroops: 0n },
    );
  }

  /**
   * Finishes a settlement whose channel sequence number another transaction took, once
   * `sequenceTaken` proves its bytes never applied and never will: as a submission failure with
   * nothing charged, its channel quarantined, so neither the settlement nor the channel waits for the
   * transaction's time bound. Answers `undefined`, finishing nothing and logging why, when that is
   * not proven or the payer's authorization may still be carried by another transaction. Which of
   * the two applies is read from the scheme and the recorded sends (`broadcastMayBePublic`), so every
   * replica and the reconciler decide alike:
   * - an `upto` authorization only the settlement authority can carry, in bytes no send ever had
   *   accepted (every answer ERROR or TRY_AGAIN_LATER, none lost), reached no one: only a consumed
   *   nonce stands in the way, and only a transaction identified on-chain finishes the settlement then
   *   (as settled elsewhere);
   * - otherwise `landing` decides: bytes a send may have had accepted (PENDING, DUPLICATE, or an answer
   *   lost) may have exposed the authorization, and anyone who holds an `exact` payment can carry its
   *   authorization whatever became of these bytes. An `upto` authorization is final once its nonce is
   *   unused, an `exact` one waits for its expiration.
   * Once the proof holds, a settlement that keeps waiting gives its channel back (`giveBackChannel`):
   * its bytes can never apply, so only the payment's outcome waits, not the channel.
   */
  private async finishSequenceTaken(
    record: SettlementRecord,
    status: rpc.Api.GetTransactionResponse,
  ): Promise<SettleResponse | undefined> {
    const declined = (
      reason: SequenceConflictReason,
      why: string,
      extra: Record<string, unknown> = {},
    ): SettleResponse | undefined => {
      // Every rebroadcast of a waiting settlement meets the conflict again: report a decline once per
      // settlement, and again only when its reason changes.
      if (this.conflictDecisions.get(record.id) !== reason) {
        this.conflictDecisions.delete(record.id);
        this.conflictDecisions.set(record.id, reason);
        if (this.conflictDecisions.size > CONFLICT_DECISIONS_KEPT) {
          const oldest = this.conflictDecisions.keys().next().value;
          if (oldest !== undefined) this.conflictDecisions.delete(oldest);
        }
        this.log.warn(
          {
            settlement: record.id,
            transaction: record.transactionHash,
            channel: record.channel,
            code: reason,
            reason: why,
            ...extra,
          },
          "sequence conflict not finished early; the settlement keeps waiting",
        );
        this.observer.sequenceConflict(this.options.network, { outcome: "declined", reason });
      }
      return undefined;
    };
    const finished = (reason: SequenceConflictReason, response: SettleResponse): SettleResponse => {
      this.conflictDecisions.delete(record.id);
      this.observer.sequenceConflict(this.options.network, { outcome: "finished_early", reason });
      return response;
    };
    const taken = await this.sequenceTaken(record);
    if (!taken.proven) return declined(taken.code, taken.reason);
    // From here on the recorded bytes can never apply: a settlement whose outcome still waits gives
    // its channel back.
    const waiting = async (
      reason: SequenceConflictReason,
      why: string,
      extra: Record<string, unknown> = {},
    ): Promise<SettleResponse | undefined> => {
      await this.giveBackChannel(record, { accountSequence: taken.accountSequence });
      return declined(reason, why, extra);
    };
    let current: SettlementRecord | undefined;
    try {
      current = await this.options.ledger.get(record.id);
    } catch (error) {
      return waiting("ledger_unreadable", "the settlement's recorded sends could not be read", {
        err: error,
      });
    }
    if (current === undefined) return declined("ledger_unreadable", "the settlement is no longer recorded");
    const sends = { broadcastAccepted: current.broadcastAccepted, sendsInFlight: current.sendsInFlight };
    // Only the sends are read from the fresh record; the envelope never changes once recorded.
    const mayBePublic = broadcastMayBePublic(current);
    if (mayBePublic || othersCanCarry(record)) {
      // Its reads must reach the ledger of the sequence proof, as well as that of the own-hash lookup.
      const floor = Math.max(status.latestLedger, taken.ledger);
      const landing = await this.landing(record, status, floor);
      if (landing.kind === "landed") return finished("landed", landing.response);
      if (landing.kind === "behind") {
        return waiting(
          "rpc_behind",
          "an RPC that read the payer's nonce or looked the transaction up is behind the ledger the sequence proof was read at",
          { ...sends, proofLedger: floor },
        );
      }
      if (landing.kind === "wait") {
        return waiting(
          "may_be_public",
          mayBePublic
            ? "a send may have been accepted, so another transaction can carry the authorization until it expires"
            : "anyone who holds the payment can carry the payer's authorization in another transaction until it expires",
          sends,
        );
      }
      if (landing.kind === "unproven") {
        return waiting(
          "unproven",
          "another transaction may have carried the authorization, and its fate cannot be proven",
          sends,
        );
      }
    } else {
      const signed = safeSignedAuthorization(record, this.options.passphrase);
      if (signed !== undefined) {
        let consumed: boolean;
        let readAt: number;
        try {
          const { entries, latestLedger } = await this.options.server.getLedgerEntries(
            nonceLedgerKey(signed.payer, signed.nonce),
          );
          // The nonce is read where the proof was: an RPC behind the ledger the channel was read at
          // (lagging, or another provider after a failover) could still show a nonce another
          // transaction already consumed as unused.
          if (!(latestLedger >= taken.ledger)) {
            return await waiting(
              "rpc_behind",
              "the RPC that read the payer's nonce is behind the ledger the sequence proof was read at",
              { nonceLedger: latestLedger, proofLedger: taken.ledger },
            );
          }
          consumed = entries.length > 0;
          readAt = latestLedger;
        } catch (error) {
          return waiting("nonce_unreadable", "the payer's authorization nonce could not be read", {
            err: error,
          });
        }
        if (consumed) {
          const elsewhere = await this.finishSettledElsewhere(record, { sponsorPaid: false, floor: readAt });
          if (elsewhere.kind === "finished") return finished("settled_elsewhere", elsewhere.response);
          return elsewhere.kind === "behind"
            ? waiting(
                "rpc_behind",
                "the search for the transaction that consumed the payer's nonce read an RPC behind the ledger the nonce was read at",
              )
            : waiting(
                "unproven",
                "the payer's nonce was consumed by a transaction that could not be identified",
              );
        }
      }
    }
    this.log.warn(
      {
        settlement: record.id,
        transaction: record.transactionHash,
        channel: record.channel,
        sequence: taken.sequence,
        accountSequence: taken.accountSequence,
      },
      "another transaction took the channel's sequence number; the settlement finished and the channel is quarantined",
    );
    const response = await this.complete(
      record,
      "failed",
      this.failed(record.scheme, {
        code: codesOf(record.scheme).submissionFailed,
        reason: othersCanCarry(record)
          ? "Another transaction took the channel account's sequence number (txBadSeq), so the settlement transaction can never apply, and no other transaction used the payer's authorization before it expired; no funds moved. Sign a new payment and retry."
          : "Another transaction took the channel account's sequence number (txBadSeq), so the settlement transaction can never apply; no funds moved. Sign a new payment and retry.",
        payer: record.key.payer,
        transaction: record.transactionHash,
        amount: uptoAmountOf(record),
      }),
      { feeChargedStroops: 0n, quarantine: { sequence: taken.accountSequence } },
    );
    return finished(mayBePublic ? "authorization_unused" : "never_accepted", response);
  }

  /**
   * Gives a waiting settlement's channel back once its recorded bytes can never apply: another
   * transaction took their sequence number (`sequenceTaken` proved it, and `conflict` carries the
   * account's sequence number seen then), or they were included and failed, which used the number
   * themselves. The ledger marks the channel released (`SettlementLedger.releaseChannel`), and only the
   * caller that marked it hands the channel back: quarantined after a conflict, released otherwise.
   * Finishing the settlement later releases nothing. With a ledger that cannot mark it, the settlement
   * keeps its channel until it finishes.
   */
  private async giveBackChannel(
    record: SettlementRecord,
    conflict?: { readonly accountSequence: string },
  ): Promise<void> {
    const { ledger, channels } = this.options;
    const channel = record.channel;
    if (ledger.releaseChannel === undefined || channel === undefined) return;
    let released: boolean;
    try {
      released = await ledger.releaseChannel(record.id);
    } catch (error) {
      this.log.warn(
        { err: error, settlement: record.id, channel },
        "could not give the channel back; the settlement keeps it until it finishes",
      );
      return;
    }
    if (!released) return;
    try {
      if (conflict === undefined) await channels.release(channel);
      else await channels.quarantine(channel, this.timing.channelQuarantineMs, conflict.accountSequence);
    } catch (error) {
      this.log.error({ err: error, settlement: record.id, channel }, "could not hand the channel back");
      return;
    }
    this.log.warn(
      { settlement: record.id, transaction: record.transactionHash, channel, ...conflict },
      conflict === undefined
        ? "the settlement's transaction failed on chain while the payer's authorization can still be carried by another transaction until it expires; the channel is released while the settlement's outcome waits"
        : "another transaction took the channel's sequence number; the channel is quarantined while the settlement's outcome waits",
    );
  }

  /**
   * Proof that a recorded transaction can never apply, because another transaction took its sequence
   * number, and that it did not apply before: the channel account's sequence number is at least the
   * transaction's (a transaction applies only above its source's sequence number, which never goes
   * back), and neither its hash nor its inner hash (any fee bump of it) is found by an RPC that has
   * ingested the ledger the account was read at and retains every ledger since the settlement was
   * claimed. Any read failure, a lagging RPC or a sequence number not yet reached answers `undefined`.
   */
  private async sequenceTaken(record: SettlementRecord): Promise<
    | {
        readonly proven: true;
        readonly sequence: string;
        readonly accountSequence: string;
        /** The latest ledger of the RPC that read the channel account: what the proof holds at. */
        readonly ledger: number;
      }
    | { readonly proven: false; readonly code: SequenceConflictReason; readonly reason: string }
  > {
    const no = (code: SequenceConflictReason, reason: string) => ({ proven: false as const, code, reason });
    try {
      const envelope = TransactionBuilder.fromXDR(record.envelopeXdr ?? "", this.options.passphrase);
      const inner = envelope instanceof FeeBumpTransaction ? envelope.innerTransaction : envelope;
      if (record.channel === undefined || inner.source !== record.channel) {
        return no("check_failed", "the recorded transaction's source is not its channel");
      }
      const sequence = BigInt(inner.sequence);
      const { entries, latestLedger } = await this.options.server.getLedgerEntries(
        xdr.LedgerKey.account(
          new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(record.channel).xdrAccountId() }),
        ),
      );
      const entry = entries[0];
      if (entry === undefined) return no("check_failed", "the channel account was not found");
      const accountSequence = BigInt(entry.val.account().seqNum().toString());
      if (accountSequence < sequence) {
        return no(
          "sequence_not_reached",
          `the channel's sequence number ${accountSequence.toString()} has not reached the transaction's ${sequence.toString()}`,
        );
      }
      const hashes = new Set([record.transactionHash, record.innerTransactionHash]);
      for (const hash of hashes) {
        if (hash === undefined) continue;
        const status = await this.options.server.getTransaction(hash);
        if (status.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) {
          return no("transaction_found", `transaction ${hash} is in a ledger`);
        }
        if (!(status.latestLedger >= latestLedger)) {
          return no("rpc_behind", "the RPC that looked the transaction up is behind the account read");
        }
        if (!historyCovers(record, status.oldestLedgerCloseTime)) {
          return no(
            "history_not_retained",
            "the RPC no longer retains every ledger since the settlement was claimed",
          );
        }
      }
      return {
        proven: true,
        sequence: sequence.toString(),
        accountSequence: accountSequence.toString(),
        ledger: latestLedger,
      };
    } catch (error) {
      this.log.warn({ err: error, settlement: record.id }, "could not check the channel's sequence number");
      return no("check_failed", "the channel's sequence number could not be checked");
    }
  }

  /**
   * The most an `exact` settlement can cost the sponsor; nothing when the policy sets no ceiling.
   * Upstream holds the inner transaction to `resource fee + one inclusion bid <= ceiling`, and the fee
   * bump pays the inclusion bid once more (`2 x bid + resource fee`), so the worst case is the ceiling
   * plus the highest bid this network can make.
   */
  private exactReserveStroops(): bigint {
    const ceiling = this.options.policy.maxTransactionFeeStroops;
    if (!Number.isSafeInteger(ceiling)) return 0n;
    const highestBid = this.options.inclusionFee?.cap ?? this.options.policy.inclusionFeeStroops;
    return BigInt(ceiling) + (Number.isSafeInteger(highestBid) ? BigInt(highestBid) : 0n);
  }

  /** What a settlement reserves against the hourly budgets, and the most its fee bump may cost. */
  private reservationOf(intent: SettlementIntent): bigint {
    return intent.reserveFeeStroops ?? this.exactReserveStroops();
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
   * could not be identified). Such a record stays `submitted` for an operator to resolve. `undecided`
   * tells that its last look ended waiting on reads that came from an RPC behind the ledger they must
   * cover, or failed: a later pass decides it, and `reconcile` reports one that stays so.
   */
  private async drive(record: SettlementRecord, deadline: number): Promise<Driven> {
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
    const pending = (undecided?: Undecided): Driven => ({
      response: this.failed(record.scheme, { code: "settlement_pending", payer, transaction: hash, amount }),
      unresolvable: false,
      ...(undecided === undefined ? {} : { undecided }),
    });

    let lastBroadcast = 0;
    // Whether the settlement gave its channel back (`giveBackChannel`), on an earlier look or this one.
    let channelGivenBack = record.channelReleased === true;
    for (;;) {
      let undecided: Undecided | undefined;
      const status = await this.lookupTransaction(hash);
      if (status?.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        return settled(
          await this.complete(record, "succeeded", this.succeeded(record, hash), {
            feeChargedStroops: feeCharged(status),
          }),
        );
      }
      if (status?.status === rpc.Api.GetTransactionStatus.FAILED) {
        const failed = await this.finishFailed(record, status, hash);
        if (failed.kind === "finished") return settled(failed.response);
        if (failed.kind === "unresolvable") return { ...pending(), unresolvable: true };
        // `wait`: the payer's authorization outlives the failure, and another transaction can still
        // carry it until it expires; the failure gave the channel back. Otherwise whether another
        // transaction settled the payment cannot be decided from these reads. Either way the next look
        // reads the failure again and searches anew.
        if (failed.kind === "wait") channelGivenBack ||= await this.gaveChannelBack(record);
        else undecided = { reason: failed.kind };
        if (Date.now() >= deadline) return pending(undecided);
        await sleep(this.timing.pollIntervalMs);
        continue;
      }
      const expired = status !== undefined && pastBounds(status, validUntil, maxLedger);
      if (expired) {
        // A ledger closed after the transaction's upper time or ledger bound: it can never be included
        // from now on. Whether it was included before is decided by proof only (see `landing`).
        const landing = await this.landing(record, status);
        if (landing.kind === "landed") return settled(landing.response);
        if (landing.kind === "unproven") return { ...pending(), unresolvable: true };
        if (landing.kind === "behind") undecided = { reason: "behind" };
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
        // `wait`: another transaction may still carry the authorization until it expires. `behind`: a
        // read that would decide it came from an RPC behind the ledger the bounds were seen to pass at.
      }

      if (!expired && status !== undefined && Date.now() - lastBroadcast >= 3 * this.timing.pollIntervalMs) {
        lastBroadcast = Date.now();
        if (channelGivenBack) {
          // Bytes that gave their channel back can never apply (another transaction took their sequence
          // number, or they were included and failed): they are not sent again, and only the payment's
          // outcome is looked at. Once nothing carried the authorization and nothing can, a conflict's
          // proof finishes the settlement.
          const landing = await this.landing(record, status);
          if (landing.kind === "landed") return settled(landing.response);
          if (landing.kind === "behind") undecided = { reason: "behind" };
          if (landing.kind === "absent") {
            const finished = await this.finishSequenceTaken(record, status);
            if (finished !== undefined) return settled(finished);
          }
          if (Date.now() >= deadline) return pending(undecided);
          await sleep(this.timing.pollIntervalMs);
          continue;
        }
        const sent = await this.broadcast(record);
        if (sent.badSequence) {
          // Whether the payer's authorization may be public is decided from the recorded sends.
          const finished = await this.finishSequenceTaken(record, status);
          if (finished !== undefined) return settled(finished);
          channelGivenBack ||= await this.gaveChannelBack(record);
        }
        const rejection = sent.rejection;
        if (rejection !== undefined) {
          // The network refused these bytes for good; they may still have landed before (through a
          // lagging RPC, or wrapped in someone else's fee bump). Finish only on proof either way.
          const landing = await this.landing(record, status);
          if (landing.kind === "landed") return settled(landing.response);
          if (landing.kind === "behind") undecided = { reason: "behind" };
          // A wait may come from the inner transaction failing inside someone else's fee bump, which
          // gave the channel back (see `finishFailed`): its bytes are then not sent again.
          if (landing.kind === "wait") channelGivenBack ||= await this.gaveChannelBack(record);
          // An `upto` absence covers only the ledgers read so far, and the refusal only this fee bump:
          // the inner transaction a send may have exposed can still land in someone else's fee bump
          // while a later ledger can include it. Such a settlement waits until none can (as `exact`
          // waits for its authorization's expiration).
          const mayBePublic = landing.kind === "absent" && (await this.sendsMayBePublic(record));
          const stillIncludable =
            mayBePublic && record.scheme === "upto" && includableAfter(status, validUntil, maxLedger);
          if (landing.kind === "absent" && !stillIncludable) {
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
                // Bytes no send ever had accepted were never queued, so nothing was charged for them.
                mayBePublic ? {} : { feeChargedStroops: 0n },
              ),
            );
          }
          this.log.warn(
            {
              settlement: record.id,
              transaction: hash,
              rejection,
              ...(stillIncludable ? { mayBePublic: true } : {}),
            },
            stillIncludable
              ? "rebroadcast refused, but an earlier send may have been accepted and someone else's fee bump can still include it; waiting for its bounds"
              : "rebroadcast refused, but the settlement's absence is not proven; waiting for its bounds",
          );
        }
      }

      if (Date.now() >= deadline) return pending(undecided);
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
   *    carried it so far. For `upto` that is `absent`: only the settlement authority can settle, so
   *    only the recorded transaction could still carry it, and a caller finishes on it only once that
   *    transaction can no longer be included (its bounds passed, or another transaction took its
   *    sequence number) or no send of it was ever accepted (see `drive`). An `exact` authorization
   *    can still be carried by another transaction until it expires, so its record `waits` for the
   *    expiration ledger;
   * 3. otherwise NOT_FOUND proves absence only while every RPC that answered it still retains every
   *    ledger since the settlement was claimed.
   * Absence is proven only up to the ledger of each read, so every read taken as proof of absence
   * (the inner-hash NOT_FOUND, the unconsumed nonce) must come from an RPC at or past `floor`: the
   * ledger the caller's proof holds at, by default the latest ledger of the RPC that read the own hash
   * NOT_FOUND (for an expiry, the ledger at which the bounds were seen to pass). An RPC behind it
   * (lagging, a backend behind a balancer, or another provider after a failover) may not have ingested
   * the ledger the transaction landed in; such a read answers `behind` and finishes nothing, so a later
   * read decides. A transaction found by either path, from any RPC, is proof of inclusion; one that is
   * Rail402's own envelope finishes as Rail402's settlement. `unproven` leaves the record `submitted`;
   * a read failure is `unproven`.
   */
  private async landing(
    record: SettlementRecord,
    status: rpc.Api.GetTransactionResponse,
    floor: number = status.latestLedger,
  ): Promise<
    | { readonly kind: "landed"; readonly response: SettleResponse }
    | { readonly kind: "absent" }
    | { readonly kind: "wait" }
    | { readonly kind: "behind" }
    | { readonly kind: "unproven" }
  > {
    const behind = (read: "inner_hash" | "nonce", ledger: number) => {
      this.log.info(
        { settlement: record.id, transaction: record.transactionHash, read, readLedger: ledger, floor },
        "a read that would prove the settlement absent came from an RPC behind the ledger its proof holds at; the settlement keeps waiting",
      );
      return { kind: "behind" as const };
    };
    // An included failure is finished only on a search that decided (see `finishFailed`).
    const failedLanding = (failed: FailedFinish) =>
      failed.kind === "finished"
        ? { kind: "landed" as const, response: failed.response }
        : failed.kind === "behind" || failed.kind === "wait"
          ? { kind: failed.kind }
          : { kind: "unproven" as const };
    // Whether every RPC that answered NOT_FOUND retains the ledgers the settlement could be in.
    let retained = historyCovers(record, status.oldestLedgerCloseTime);
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
          if (wrapped.status === rpc.Api.GetTransactionStatus.FAILED) {
            return failedLanding(await this.finishFailed(record, wrapped, landedIn));
          }
          const response = await this.complete(record, "succeeded", this.succeeded(record, landedIn), {
            feeChargedStroops: feeCharged(wrapped),
          });
          return { kind: "landed", response };
        }
        this.log.warn(
          { settlement: record.id, transaction: record.transactionHash, landedIn },
          "the settlement transaction landed inside another party's fee bump",
        );
        if (wrapped.status === rpc.Api.GetTransactionStatus.FAILED) {
          return failedLanding(await this.finishFailed(record, wrapped, landedIn, { sponsorPaid: false }));
        }
        const response = await this.complete(record, "succeeded", this.succeeded(record, landedIn), {
          settledBy: "third_party",
        });
        return { kind: "landed", response };
      }
      if (!(wrapped.latestLedger >= floor)) return behind("inner_hash", wrapped.latestLedger);
      retained &&= historyCovers(record, wrapped.oldestLedgerCloseTime);
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
        // The search reads the nonce again: from an RPC at or past this read, it sees it consumed too.
        const elsewhere = await this.finishSettledElsewhere(record, { sponsorPaid: false, floor: readAt });
        if (elsewhere.kind === "finished") return { kind: "landed", response: elsewhere.response };
        if (elsewhere.kind === "behind") return { kind: "behind" };
        if (elsewhere.kind === "none") {
          this.log.warn(
            { settlement: record.id, transaction: record.transactionHash },
            "the payer's authorization was consumed by a transaction that could not be identified",
          );
        }
        return { kind: "unproven" };
      }
      // Unconsumed at this read's ledger says nothing about the ledgers after it.
      if (!(readAt >= floor)) return behind("nonce", readAt);
      // A consumed nonce's entry lives at least until the authorization's expiration ledger: absent at
      // a ledger up to then (the ledger of this read, not of an earlier one), it was never consumed so far.
      if (readAt <= signed.signatureExpirationLedger) {
        return record.scheme === "upto" ? { kind: "absent" } : { kind: "wait" };
      }
    }
    return retained ? { kind: "absent" } : { kind: "unproven" };
  }

  /**
   * Finishes a settlement whose transaction was included and failed. When the failure means the
   * payer's authorization was consumed first, or may hide that (`thirdPartyCauses`: an authorization
   * that expired before inclusion, a failure without diagnostics), it looks for the transaction that
   * consumed it: one that carried the authorization exactly as signed settled the payment, and the
   * settlement succeeded there. An `upto` authorization settled elsewhere for a different amount is
   * not this request's settlement, and is answered as such. The failure is kept only when the search
   * decided that no such transaction exists, from reads at or past the ledger the transaction failed
   * in (the nonce was consumed by then, if at all); a search that read an RPC behind that ledger
   * (`behind`) or could not be read (`unreadable`) finishes nothing, and the settlement is looked at
   * again. A failure on the used nonce proves it was consumed by that ledger, so a nonce read there as
   * unused means its entry lapsed (Soroban keeps it until the later of the authorization's expiration
   * and the consuming ledger plus the network's minimum temporary entry lifetime): such a settlement
   * is `unresolvable` from the RPC, never kept as failed. A failure on an expired authorization does
   * not prove the nonce was consumed: past the payer's own expiration ledger, a nonce read unused keeps
   * that failure; before it, the error came from elsewhere in the call path and waits like any other.
   *
   * The host rolls a failed transaction back, the payer's nonce included. Unless the failure proves the
   * authorization consumed or expired (`endsAuthorization`: a balance spent, a trustline removed or
   * deauthorized, a smart account's rules changed and every other cause can pass), anyone who holds an
   * `exact` payment can still carry the authorization in a transaction of their own until it expires.
   * Such a failure is searched as above, and while the nonce reads unused at a ledger up to the
   * expiration it `wait`s: the failed transaction consumed its channel's sequence number, so the
   * channel is given back at once (`giveBackChannel`), and once the nonce reads unused past the
   * expiration the failure is kept with its on-chain cause and the fee the sponsor was charged.
   */
  private async finishFailed(
    record: SettlementRecord,
    status: rpc.Api.GetFailedTransactionResponse,
    hash: string,
    options: { readonly sponsorPaid: boolean } = { sponsorPaid: true },
  ): Promise<FailedFinish> {
    const payer = record.key.payer;
    const cause = await this.explainFailure(record, status);
    const fee = options.sponsorPaid ? feeCharged(status) : undefined;
    const amount = uptoAmountOf(record);
    const codes = codesOf(record.scheme);
    const expiration = safeSignedAuthorization(record, this.options.passphrase)?.signatureExpirationLedger;
    const authorizationLives =
      othersCanCarry(record) && !endsAuthorization(codes, cause.code, status.ledger, expiration);
    if (codes.thirdPartyCauses.has(cause.code) || authorizationLives) {
      const elsewhere = await this.finishSettledElsewhere(record, {
        sponsorPaid: options.sponsorPaid,
        feeChargedStroops: fee,
        ownHash: hash,
        floor: status.ledger,
      });
      if (elsewhere.kind !== "none") return elsewhere;
      if (cause.code === codes.nonceUsed && elsewhere.miss === "nonce_not_consumed") {
        this.log.warn(
          { settlement: record.id, transaction: hash, failedIn: status.ledger },
          "the settlement failed on its used nonce, but the nonce reads unused: its entry lapsed, and the transaction that consumed it cannot be searched from the RPC",
        );
        return { kind: "unresolvable" };
      }
      if (authorizationLives && elsewhere.miss === "nonce_not_consumed") {
        const readAt = elsewhere.nonceReadLedger;
        if (expiration !== undefined && (readAt === undefined || readAt <= expiration)) {
          await this.giveBackChannel(record);
          return { kind: "wait" };
        }
      }
    }
    const response = await this.complete(
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
    return { kind: "finished", response };
  }

  /**
   * Finishes a settlement whose authorization another transaction consumed, when that transaction is
   * identified on-chain: a success for the same amount, `settled_elsewhere` for another `upto`
   * amount. Nothing is finished otherwise: `none` when the search decided there is no such
   * transaction, `behind` or `unreadable` when it could not decide (see `settledElsewhere`).
   */
  private async finishSettledElsewhere(
    record: SettlementRecord,
    details: {
      readonly sponsorPaid: boolean;
      readonly feeChargedStroops?: bigint | undefined;
      readonly ownHash?: string;
      /** The ledger by which the nonce was consumed, if at all; see `findThirdPartySettlement`. */
      readonly floor?: number;
    },
  ): Promise<
    | FailedFinish
    | { readonly kind: "none"; readonly miss?: ThirdPartyMiss; readonly nonceReadLedger?: number }
  > {
    const search = await this.settledElsewhere(record, details.floor);
    if (search.kind !== "found") return search;
    const elsewhere = search.settlement;
    const amount = uptoAmountOf(record);
    if (elsewhere.hash === record.transactionHash) {
      // Rail402's own envelope, which a lagging RPC answered NOT_FOUND for by its hash.
      const own = await this.lookupTransaction(elsewhere.hash);
      const response = await this.complete(record, "succeeded", this.succeeded(record, elsewhere.hash), {
        ...(own === undefined ? {} : { feeChargedStroops: feeCharged(own) }),
      });
      return { kind: "finished", response };
    }
    const finish = {
      feeChargedStroops: details.feeChargedStroops,
      onChainFailure: details.sponsorPaid,
      settledBy: "third_party" as const,
    };
    if (amount === undefined || elsewhere.amount === BigInt(amount)) {
      const response = await this.complete(
        record,
        "succeeded",
        this.succeeded(record, elsewhere.hash),
        finish,
      );
      return { kind: "finished", response };
    }
    const ours = details.ownHash ?? record.transactionHash ?? "";
    const response = await this.complete(
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
    return { kind: "finished", response };
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
   *
   * A settlement whose look keeps ending undecided on its reads (an RPC behind the ledger they must
   * cover, or failing reads) is reported as unresolvable once `UNDECIDED_REPORT_AFTER_MS` passed since
   * its first undecided look in this process, whatever the passes in between ended with; it stays
   * `submitted`, and a pass whose reads decide it still finishes it.
   */
  async reconcile(): Promise<number> {
    const { network } = this.options;
    const unfinished = await this.options.ledger.unfinished(network, {
      idleForMs: this.timing.reconcileIdleMs,
    });
    let finished = 0;
    let unresolvable = 0;
    // Settlements no longer unfinished were finished elsewhere: their undecided time goes with them.
    const open = new Set(unfinished.map((record) => record.id));
    for (const id of this.undecidedSince.keys()) if (!open.has(id)) this.undecidedSince.delete(id);
    for (const record of unfinished) {
      if (this.driving.has(record.id)) continue;
      try {
        const driven = await this.drive(record, 0);
        const undecided = driven.undecided;
        if (undecided !== undefined) {
          const since = this.undecidedSince.get(record.id) ?? Date.now();
          this.undecidedSince.set(record.id, since);
          const undecidedMs = Date.now() - since;
          if (undecidedMs >= UNDECIDED_REPORT_AFTER_MS) {
            unresolvable++;
            this.observer.reconciled(network, "unresolvable");
            this.log.warn(
              {
                settlement: record.id,
                transaction: record.transactionHash,
                reason: undecided.reason,
                undecidedMs,
              },
              "settlement undecided: the reads that would decide it keep coming from an RPC behind the ledger " +
                "they must cover, or failing; compare the RPC providers' latest ledgers, or look the transaction " +
                "and the payer's nonce up in Horizon or a history archive",
            );
            continue;
          }
        }
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
        if (outcome !== "pending") {
          finished++;
          this.undecidedSince.delete(record.id);
        }
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
      rpcConfig: { url: context.rpcUrl },
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
    hooks: {
      /** The most the fee bump may cost (its reservation); 0 = no bound. */
      readonly maxFeeStroops: bigint;
      /** False once the settlement's signing window closed: nothing more is signed. */
      readonly open: () => boolean;
      /** Admits the proven payment (see `SponsorGuard.admitVerified`); false refuses to sign. */
      readonly admit: () => Promise<boolean>;
      readonly onRecorded: () => void;
    },
  ): FacilitatorStellarSigner {
    const { passphrase, ledger } = this.options;
    const base = this.sponsorSigner;
    let admitted: Promise<boolean> | undefined;
    const refuse = (message: string) => ({ signedTxXdr: "", error: { code: -1, message } });
    return {
      address: base.address,
      signAuthEntry: base.signAuthEntry,
      signTransaction: async (xdrToSign, opts) => {
        if (!hooks.open()) {
          this.log.warn({ settlement: recordId }, "the signing window closed before the fee bump was ready");
          return refuse("the settlement's signing window closed");
        }
        try {
          const draft = TransactionBuilder.fromXDR(xdrToSign, passphrase);
          if (!(draft instanceof FeeBumpTransaction))
            throw new Error("sponsor asked to sign a non-fee-bump transaction");
          if (hooks.maxFeeStroops > 0n && BigInt(draft.fee) > hooks.maxFeeStroops) {
            this.log.error(
              { settlement: recordId, fee: draft.fee, reserved: String(hooks.maxFeeStroops) },
              "the fee bump costs more than the settlement reserved",
            );
            return refuse("the fee bump costs more than the settlement reserved");
          }
        } catch (error) {
          this.log.error({ err: error, settlement: recordId }, "could not read the fee bump to sign");
          return refuse("the fee bump could not be read");
        }
        // Upstream asks for the fee bump only after its verification and simulation passed; a fee bump
        // refused above never reaches the guard, so it uses no party quota.
        admitted ??= hooks.admit().catch((error: unknown) => {
          this.log.error({ err: error, settlement: recordId }, "the sponsor guard threw");
          return false;
        });
        if (!(await admitted)) return refuse("settlement refused by the sponsor guard");
        if (!hooks.open()) return refuse("the settlement's signing window closed");
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
          hooks.onRecorded();
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
      /**
       * Another transaction took the channel's sequence number: quarantine it instead of releasing it,
       * with the account's sequence number seen at the conflict.
       */
      quarantine?: { readonly sequence: string };
    },
  ) {
    const settledBy = details.settledBy ?? "rail402";
    const { record: finished, transitioned } = await this.options.ledger.finish(record.id, state, response, {
      settledBy,
      ...(details.feeChargedStroops === undefined ? {} : { feeChargedStroops: details.feeChargedStroops }),
    });
    // A settlement that gave its channel back earlier (`giveBackChannel`) releases nothing: the channel
    // may already serve another settlement.
    if (transitioned && record.channel !== undefined && finished.channelReleased !== true) {
      if (details.quarantine !== undefined) {
        await this.options.channels.quarantine(
          record.channel,
          this.timing.channelQuarantineMs,
          details.quarantine.sequence,
        );
      } else {
        await this.options.channels.release(record.channel);
      }
    }
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
   * The transaction that settled this payment exactly as the payer signed it, when Rail402's own
   * transaction failed on the consumed authorization or the payer's nonce reads as consumed: another
   * party's, or Rail402's own envelope. Nothing is claimed that was not proven, and nothing is ruled
   * out that was not read: `none` (with the search's miss) only when the search decided from reads at
   * or past `floor`; `behind` when a read that fell short came from an RPC behind it, and `unreadable`
   * on a read failure or when the RPC that scanned no longer holds the consuming ledger (another RPC
   * may). Both leave the decision to a later look.
   */
  private async settledElsewhere(
    record: SettlementRecord,
    floor?: number,
  ): Promise<
    | { readonly kind: "found"; readonly settlement: ThirdPartySettlement }
    | { readonly kind: "none"; readonly miss?: ThirdPartyMiss; readonly nonceReadLedger?: number }
    | { readonly kind: "behind" }
    | { readonly kind: "unreadable" }
  > {
    if (this.options.reconcileThirdParty === false) return { kind: "none" };
    try {
      const result = await findThirdPartySettlement(
        this.options.server,
        record,
        this.options.passphrase,
        floor,
      );
      if (!result.found) {
        // Retention is a claim of the one RPC that answered: another may still hold the consuming ledger.
        const undecided =
          result.miss === "rpc_behind"
            ? "behind"
            : result.miss === "ledger_not_retained"
              ? "unreadable"
              : undefined;
        this.log.info(
          { settlement: record.id, transaction: record.transactionHash, miss: result.miss, floor },
          undecided === undefined
            ? "no other transaction settled this authorization as signed"
            : "the search for another transaction that settled this authorization could not read the ledgers it must cover; deciding later",
        );
        if (undecided !== undefined) return { kind: undecided };
        return {
          kind: "none",
          miss: result.miss,
          ...(result.nonceReadLedger === undefined ? {} : { nonceReadLedger: result.nonceReadLedger }),
        };
      }
      if (result.settlement.hash === record.transactionHash) {
        return { kind: "found", settlement: result.settlement };
      }
      this.log.warn(
        {
          settlement: record.id,
          transaction: record.transactionHash,
          settledIn: result.settlement.hash,
          ledger: result.settlement.ledger,
        },
        "another transaction settled this payment first; the sponsor fee of ours was wasted",
      );
      return { kind: "found", settlement: result.settlement };
    } catch (error) {
      this.log.warn(
        { err: error, settlement: record.id },
        "could not look for a third-party settlement; deciding later",
      );
      return { kind: "unreadable" };
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

  /**
   * Answers a repeat from the existing settlement, waiting for it if it is still in flight. The marker
   * echoes the attempt id of the record as it was answered from: a claim taken over during the wait
   * belongs to the request that took it over, never to the one that gave it up.
   */
  private async answerExisting(record: SettlementRecord, scheme: string): Promise<SettleResponse> {
    this.observer.repeat(this.options.network, scheme);
    const { response, settledBy, attempt } = await this.awaitExisting(record, scheme);
    return markRepeat(response, settledBy, attempt);
  }

  private async awaitExisting(
    record: SettlementRecord,
    scheme: string,
  ): Promise<{
    response: SettleResponse;
    settledBy: "rail402" | "third_party";
    attempt: string | undefined;
  }> {
    const payer = record.key.payer;
    const deadline = Date.now() + this.timing.duplicateWaitMs;
    let current: SettlementRecord | undefined = record;
    // The last version read: what a repeat that times out is answered from.
    let latest = record;
    for (;;) {
      if (current?.response !== undefined) {
        return {
          response: current.response,
          settledBy: current.settledBy ?? "rail402",
          attempt: current.attempt,
        };
      }
      if (current === undefined || Date.now() >= deadline) break;
      await sleep(Math.min(250, this.timing.pollIntervalMs));
      current = await this.options.ledger.get(record.id);
      if (current !== undefined) latest = current;
    }
    const hash = latest.transactionHash;
    const amount = uptoAmountOf(latest);
    const response =
      hash === undefined
        ? this.failed(scheme, { code: codesOf(scheme).settlementInProgress, payer, amount })
        : this.failed(scheme, { code: "settlement_pending", payer, transaction: hash, amount });
    return { response, settledBy: "rail402", attempt: latest.attempt };
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
      // Nothing named a fault of the payment: the RPC failed, or the payment simulates cleanly now.
      // Nothing was signed, so the same payment may be retried.
      return settleFailed({
        code: "unexpected_settle_error",
        reason: rpcSimulationReason(result.errorMessage),
        network,
        payer: transfer.from,
      });
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
   * Broadcasts the recorded envelope. `rejection` describes the refusal only when these bytes can
   * never be applied; anything ambiguous or transient leaves it unset, polling continues and the
   * transaction's time bound decides. `badSequence` reports a refused sequence number (`txBadSeq`),
   * which is transient by itself: the caller may prove with `sequenceTaken` that it is final.
   */
  private async broadcast(
    record: SettlementRecord,
  ): Promise<{ readonly rejection?: string; readonly badSequence: boolean }> {
    const hash = record.transactionHash;
    // Each send of a tracked record is marked before it is made and answered after, so a lost
    // answer keeps counting as accepted. A record whose bytes may be public already needs no tracking.
    const tracked = record.broadcastAccepted === false;
    const send = randomUUID();
    if (tracked) {
      try {
        await this.options.ledger.beginSend(record.id, send);
      } catch (error) {
        // Unmarked, a lost answer could pass for a refusal: do not send this time.
        this.log.warn({ err: error, settlement: record.id }, "could not mark a rebroadcast; skipping it");
        return { badSequence: false };
      }
    }
    try {
      const envelope = TransactionBuilder.fromXDR(record.envelopeXdr ?? "", this.options.passphrase);
      const sent = await this.options.server.sendTransaction(envelope);
      if (tracked) {
        // PENDING and DUPLICATE: the network holds the bytes. ERROR and TRY_AGAIN_LATER: it does not.
        await this.endSend(record, send, sent.status === "PENDING" || sent.status === "DUPLICATE");
      }
      if (sent.status !== "ERROR") {
        this.observer.submission(this.options.network, { status: sent.status, phase: "rebroadcast" });
        return { badSequence: false };
      }
      const code = resultCode(sent.errorResult);
      this.observer.submission(this.options.network, {
        status: "ERROR",
        resultCode: code,
        phase: "rebroadcast",
      });
      // A bad sequence can mean these very bytes were already applied, and a fee or balance shortfall
      // can pass (surge pricing, a sponsor top-up) while an earlier broadcast may still be queued.
      const badSequence = code.includes("txBadSeq");
      if (TRANSIENT_SUBMISSION_RESULTS.some((transient) => code.includes(transient))) return { badSequence };
      return { rejection: code, badSequence };
    } catch (error) {
      // The answer is lost: the send stays in flight, so the bytes count as possibly accepted.
      this.log.warn({ err: error, transaction: hash }, "broadcast failed");
      return { badSequence: false };
    }
  }

  /**
   * Whether a send of the recorded bytes may have been accepted (`broadcastMayBePublic`), read from the
   * settlement's current record rather than the copy a look started from, so a send made since counts
   * too. A failed read, or a record no longer found, counts as possibly accepted.
   */
  private async sendsMayBePublic(record: SettlementRecord): Promise<boolean> {
    try {
      const current = await this.options.ledger.get(record.id);
      return current === undefined || broadcastMayBePublic(current);
    } catch (error) {
      this.log.warn({ err: error, settlement: record.id }, "could not read the settlement's recorded sends");
      return true;
    }
  }

  /** Whether the settlement's current record says it gave its channel back; a failed read says no. */
  private async gaveChannelBack(record: SettlementRecord): Promise<boolean> {
    try {
      return (await this.options.ledger.get(record.id))?.channelReleased === true;
    } catch {
      return false;
    }
  }

  /** Records a send's answer; a failure leaves the send in flight, which only counts as accepted. */
  private async endSend(record: SettlementRecord, send: string, accepted: boolean): Promise<void> {
    try {
      await this.options.ledger.endSend(record.id, send, accepted);
    } catch (error) {
      this.log.warn({ err: error, settlement: record.id, send }, "could not record a send's answer");
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
  readonly callerBudgetExhausted: FacilitatorCode;
  readonly payerRateLimited: FacilitatorCode;
  readonly payToRateLimited: FacilitatorCode;
  readonly payerCooldown: FacilitatorCode;
  readonly idempotencyConflict: FacilitatorCode;
  readonly settlementInProgress: FacilitatorCode;
  /** An included settlement failed because the payer's nonce had been consumed by then. */
  readonly nonceUsed: FacilitatorCode;
  /**
   * Causes of an included, failed settlement after which the payment may have landed in someone
   * else's transaction: the consumed nonce, an `exact` authorization applied after its expiration
   * ledger (the transaction's time bound can outlast it, and the host checks the expiration before
   * the nonce, so a copy that consumed the nonce earlier reads as an expiry), or a failure the
   * diagnostics could not name (an RPC without diagnostic events). The search itself decides; these
   * only bound when it runs. An `upto` transaction's ledger bounds end at its authorization's
   * expiration, so it is never applied after it.
   */
  readonly thirdPartyCauses: ReadonlySet<string>;
  /** An included settlement failed because an authorization in it had expired by then. */
  readonly signatureExpired: FacilitatorCode;
}

const EXACT_CODES: SchemeCodes = {
  sponsorUnavailable: "settle_exact_stellar_sponsor_unavailable",
  channelUnavailable: "settle_exact_stellar_channel_unavailable",
  transactionExpired: "settle_exact_stellar_transaction_expired",
  submissionFailed: "settle_exact_stellar_transaction_submission_failed",
  callerBudgetExhausted: "settle_exact_stellar_caller_budget_exhausted",
  payerRateLimited: "settle_exact_stellar_payer_rate_limited",
  payToRateLimited: "settle_exact_stellar_payto_rate_limited",
  payerCooldown: "settle_exact_stellar_payer_cooldown",
  idempotencyConflict: "settle_exact_stellar_idempotency_conflict",
  settlementInProgress: "settle_exact_stellar_settlement_in_progress",
  nonceUsed: "invalid_exact_stellar_payload_nonce_already_used",
  thirdPartyCauses: new Set([
    "invalid_exact_stellar_payload_nonce_already_used",
    "invalid_exact_stellar_signature_expired",
    "invalid_transaction_state",
  ]),
  signatureExpired: "invalid_exact_stellar_signature_expired",
};

const UPTO_CODES: SchemeCodes = {
  sponsorUnavailable: "settle_upto_stellar_sponsor_unavailable",
  channelUnavailable: "settle_upto_stellar_channel_unavailable",
  transactionExpired: "settle_upto_stellar_transaction_expired",
  submissionFailed: "settle_upto_stellar_transaction_submission_failed",
  callerBudgetExhausted: "settle_upto_stellar_caller_budget_exhausted",
  payerRateLimited: "settle_upto_stellar_payer_rate_limited",
  payToRateLimited: "settle_upto_stellar_payto_rate_limited",
  payerCooldown: "settle_upto_stellar_payer_cooldown",
  idempotencyConflict: "settle_upto_stellar_idempotency_conflict",
  settlementInProgress: "settle_upto_stellar_settlement_in_progress",
  nonceUsed: "invalid_upto_stellar_payload_nonce_already_used",
  thirdPartyCauses: new Set([
    "invalid_upto_stellar_payload_nonce_already_used",
    "settle_upto_stellar_transaction_failed",
  ]),
  signatureExpired: "invalid_upto_stellar_signature_expired",
};

/**
 * Whether an included, failed settlement proves that the payer's authorization can no longer move
 * funds, from the failure's cause, the ledger it failed in and the authorization's own expiration
 * ledger. A consumed nonce does: any copy fails on it too. An expiry does only once that ledger is past
 * the payer's expiration, since the cause is named from the diagnostic events, and a contract in the
 * call path (a smart account's check, a policy, a token) or another, shorter-lived authorization entry
 * can raise an expired-authorization error of its own. The host rolls every other failure back, the
 * nonce included, and leaves the authorization usable until it expires (see `finishFailed`).
 */
function endsAuthorization(
  codes: SchemeCodes,
  cause: string,
  failedIn: number,
  expiration: number | undefined,
): boolean {
  if (cause === codes.nonceUsed) return true;
  return cause === codes.signatureExpired && expiration !== undefined && failedIn > expiration;
}

/** The engine's codes for `scheme`; records written before schemes were recorded are `exact`. */
function codesOf(scheme: string | undefined): SchemeCodes {
  return (scheme ?? DEFAULT_SCHEME) === "upto" ? UPTO_CODES : EXACT_CODES;
}

/**
 * Whether anyone besides Rail402 can carry a recorded settlement's authorization in a transaction of
 * their own: anyone who holds an `exact` payment can, until it expires. An `upto` settlement also needs
 * the settlement authority, whose authorization only Rail402's own transaction carries.
 */
function othersCanCarry(record: SettlementRecord): boolean {
  return record.scheme !== "upto";
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

/**
 * Whether a ledger closed after the one an RPC answered at (`status.latestLedger`) can still include a
 * recorded transaction. The ledger bound is exclusive, and the network has closed at least that ledger,
 * so once it is the last one the bound admits no later ledger can; the time bound is read as
 * `pastBounds` reads it.
 */
function includableAfter(
  status: rpc.Api.GetTransactionResponse,
  validUntil: number,
  maxLedger: number | undefined,
): boolean {
  if (ledgerCloseSeconds(status.latestLedgerCloseTime) > validUntil) return false;
  return maxLedger === undefined || status.latestLedger + 1 < maxLedger;
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

/** What one look at a recorded settlement ended with (see `drive`). */
interface Driven {
  readonly response: SettleResponse;
  readonly unresolvable: boolean;
  readonly undecided?: Undecided;
}

/**
 * A look that ended waiting on reads that came from an RPC behind the ledger they must cover
 * (`behind`), or that failed or found the ledgers no longer held by the RPC that answered
 * (`unreadable`).
 */
interface Undecided {
  readonly reason: "behind" | "unreadable";
}

/** How an included, failed settlement was finished, or why it was not yet (see `finishFailed`). */
type FailedFinish =
  | { readonly kind: "finished"; readonly response: SettleResponse }
  /** The payer's authorization outlives the failure until it expires (see `finishFailed`). */
  | { readonly kind: "wait" }
  | { readonly kind: "behind" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "unresolvable" };

function settled(response: SettleResponse): Driven {
  return { response, unresolvable: false };
}

/**
 * How long a settlement may stay undecided on its reads, from its first undecided look in this
 * process, before it is reported as unresolvable: a lagging RPC catches up within a few ledgers.
 */
const UNDECIDED_REPORT_AFTER_MS = 60_000;

/** Settlements whose last sequence-conflict decline is remembered, so a decline is reported once. */
const CONFLICT_DECISIONS_KEPT = 1_024;

/** What the race in `runClaimed` resolves with when nothing was signed within the claim window. */
const SIGN_WINDOW_ELAPSED = Symbol("sign window elapsed");

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
