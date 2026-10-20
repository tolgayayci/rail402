import type { rpc } from "@stellar/stellar-sdk";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import type { FacilitatorStellarSigner } from "@x402/stellar";
import {
  inspectUptoPayload,
  isUptoStellarCode,
  type StellarNetwork,
  type UptoResponseCode,
} from "@rail402.dev/stellar";
import {
  UPTO_SCHEME,
  parseAtomicAmount,
  resolveLedgerSeconds,
  uptoStandardCodes,
  type UptoStandardCode,
} from "@rail402.dev/upto";
import {
  UptoStellarScheme as UptoMechanism,
  type UptoRpc,
  type UptoStellarFacilitatorOptions,
} from "@rail402.dev/upto/facilitator";
import type { SettlementEngine, SubmissionContext } from "./engine.ts";
import { uptoFingerprintOf } from "./fingerprint.ts";
import type { SettlementKey } from "./ledger.ts";
import { LEDGER_FRESH_MS, LatestLedger } from "./latest-ledger.ts";
import { silentLogger, type Logger } from "./logger.ts";
import { uptoTimeoutSeconds, type NetworkPolicy, type UptoPolicy } from "./policy.ts";
import { existingAccounts } from "./provision.ts";
import { reasonFor, settleFailed, verifyAccepted, verifyRejected } from "./responses.ts";
import { uptoPreflight, type UptoPreflight } from "./upto-preflight.ts";

/** See scheme.ts: verify may answer from a ledger reading one ledger close old, settle may not. */
const VERIFY_LEDGER_MAX_AGE_MS = 5_000;
const SETTLE_LEDGER_MAX_AGE_MS = LEDGER_FRESH_MS;

/** Refusals a stale ledger reading can cause by itself: the authorization is ahead of it. */
const AHEAD_OF_THE_LEDGER: ReadonlySet<UptoResponseCode> = new Set([
  "invalid_upto_stellar_signature_expiration_too_far",
  "invalid_upto_stellar_payload_not_yet_valid",
]);

/** Longest human-readable reason a response carries. */
const MAX_REASON_LENGTH = 300;

export interface UptoSchemeOptions {
  readonly network: StellarNetwork;
  readonly passphrase: string;
  readonly server: rpc.Server;
  readonly policy: NetworkPolicy;
  readonly upto: UptoPolicy;
  /** The network's settlement engine; it must hold the `upto` settlement authority. */
  readonly engine: SettlementEngine;
  /** Whether the settlement authority account exists now; see `UptoSetup.authorityReady`. */
  readonly authorityReady?: () => boolean;
  readonly log?: Logger;
}

const AUTHORITY_UNAVAILABLE = "settle_upto_stellar_authority_unavailable";

/** What one verify or settle request decided before the mechanism runs. */
interface Prepared {
  readonly checked: UptoPreflight;
  readonly currentLedger: number;
  readonly ledgerSeconds: number;
}

/**
 * The `upto` scheme for one Stellar network, registered with an upstream `x402Facilitator`.
 *
 * Verification layers three checks, like `exact`: Rail402's preflight (every static rule of the
 * scheme plus the operator's policy, decided without RPC), the `upto` mechanism (the enforcing
 * simulation of `settle(payer, terms, cap)` with its fee and event rules), and a diagnosis that
 * names a missing payer account. Settlement first looks the request up in the settlement ledger: a
 * repeat is answered from its record, and the same authorization for a different amount is refused.
 * Otherwise it repeats the preflight for the amount being settled and hands the payment to the
 * settlement engine, which leases a channel, records the envelope before the mechanism broadcasts
 * it and confirms it from the recorded bytes. The settlement authority is the operation source and
 * the only account that can choose the amount; the sponsor pays the fee through a fee bump. An
 * off-chain zero settlement, when the operator enables it, consumes the authorization in the ledger
 * and answers without a transaction.
 */
export class StellarUptoScheme implements SchemeNetworkFacilitator {
  readonly scheme = UPTO_SCHEME;
  readonly caipFamily = "stellar:*";

  private readonly options: UptoSchemeOptions;
  private readonly log: Logger;
  private readonly authority: FacilitatorStellarSigner;
  private readonly latestLedger: LatestLedger;

  constructor(options: UptoSchemeOptions) {
    const authority = options.engine.authoritySigner;
    if (authority === undefined) throw new Error(`${options.network}: upto needs a settlement authority`);
    this.options = options;
    this.authority = authority;
    this.log = options.log ?? silentLogger;
    this.latestLedger = new LatestLedger(options.server, this.log);
  }

  /** The settlement authority clients name in their terms. */
  get authorityAddress(): string {
    return this.authority.address;
  }

  getExtra(_network: Network): Record<string, unknown> {
    return { areFeesSponsored: true, facilitatorAddress: this.authority.address };
  }

  getSigners(_network: string): string[] {
    return [...this.options.engine.facilitatorAddresses];
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    let payer: string | undefined;
    try {
      const prepared = await this.prepare(payload, requirements, "verify", VERIFY_LEDGER_MAX_AGE_MS);
      const { checked } = prepared;
      if (!checked.ok) return verifyRejected(checked.code, checked.reason, checked.payer);
      payer = checked.payment.payer;
      if (!this.authorityReady()) return verifyRejected(AUTHORITY_UNAVAILABLE, undefined, payer);
      const submitted = await this.alreadySubmitted(
        this.options.engine.keyOf(payer, checked.payment.authorization.nonce),
      );
      if (submitted !== undefined) return submitted;

      const mechanism = this.mechanism(prepared, await this.options.engine.inclusionFeeBid());
      const result = await mechanism.verify(payload, requirements);
      if (result.isValid) return verifyAccepted(payer);
      const cause = await this.diagnose(
        result.invalidReason,
        result.invalidMessage,
        payer,
        "unexpected_verify_error",
      );
      return verifyRejected(cause.code, cause.reason, payer);
    } catch (error) {
      this.log.error({ err: error, network: this.options.network }, "upto verify failed unexpectedly");
      return verifyRejected("unexpected_verify_error", undefined, payer);
    }
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const { engine, network } = this.options;
    const amount = parseAtomicAmount(requirements.amount)?.toString();
    let payer: string | undefined;
    try {
      const repeat = await this.answerRepeat(payload, requirements, amount);
      if (repeat !== undefined) return repeat;
      const prepared = await this.prepare(payload, requirements, "settle", SETTLE_LEDGER_MAX_AGE_MS);
      const { checked } = prepared;
      if (!checked.ok) {
        return settleFailed({
          code: checked.code,
          reason: checked.reason,
          network: requirements.network,
          payer: checked.payer,
          amount,
        });
      }
      const { payment } = checked;
      payer = payment.payer;
      const settled = payment.amount.toString();
      const offchainZero = payment.amount === 0n && this.options.upto.zeroSettlement === "offchain";
      // Only an on-chain settlement needs the authority's account.
      if (!offchainZero && !this.authorityReady()) {
        return settleFailed({
          code: AUTHORITY_UNAVAILABLE,
          network: requirements.network,
          payer: payment.payer,
          amount,
        });
      }

      return await engine.execute(
        {
          scheme: UPTO_SCHEME,
          key: engine.keyOf(payment.payer, payment.authorization.nonce),
          fingerprint: uptoFingerprintOf(payload, requirements),
          payer: payment.payer,
          amount: settled,
        },
        {
          submit: async (context) =>
            this.normalize(
              await this.mechanism(prepared, context.inclusionFeeStroops, context).settle(
                payload,
                requirements,
              ),
              payment.payer,
              settled,
            ),
          unsigned: async (result) => this.unsigned(result, payment.payer, settled),
          ...(offchainZero
            ? {
                offchain: async () =>
                  this.normalize(
                    await this.mechanism(
                      prepared,
                      await engine.inclusionFeeBid(),
                      undefined,
                      "offchain",
                    ).settle(payload, requirements),
                    payment.payer,
                    settled,
                  ),
              }
            : {}),
        },
      );
    } catch (error) {
      this.log.error({ err: error, network }, "upto settle failed unexpectedly");
      return settleFailed({ code: "unexpected_settle_error", network: requirements.network, payer, amount });
    }
  }

  private authorityReady(): boolean {
    return this.options.authorityReady?.() ?? true;
  }

  /**
   * The ledger's answer to a settle request whose authorization it already holds, before the
   * preflight, the sponsor guard and the expiry checks. A payload that does not decode is left to
   * the preflight to reject.
   */
  private async answerRepeat(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    amount: string | undefined,
  ): Promise<SettleResponse | undefined> {
    const inspection = inspectUptoPayload(payload.payload, this.options.upto.contract);
    if (!inspection.ok) return undefined;
    const { engine } = this.options;
    const { payer, nonce } = inspection.authorization;
    return engine.answerRepeat(
      UPTO_SCHEME,
      engine.keyOf(payer, nonce),
      uptoFingerprintOf(payload, requirements),
      amount,
    );
  }

  /**
   * Verify's read of the settlement ledger: an authorization that is being settled, or was, is not
   * valid for another payment. A ledger that cannot be read skips the check; the network's nonce
   * check still refuses a consumed authorization.
   */
  private async alreadySubmitted(key: SettlementKey): Promise<VerifyResponse | undefined> {
    let record;
    try {
      record = await this.options.engine.findSettlement(key);
    } catch (error) {
      this.log.warn(
        { err: error, network: this.options.network },
        "verify could not read the settlement ledger",
      );
      return undefined;
    }
    if (record === undefined) return undefined;
    const payer = record.key.payer;
    if (record.state === "claimed" || record.state === "submitted") {
      return verifyRejected("settle_upto_stellar_settlement_in_progress", undefined, payer);
    }
    if (record.state === "succeeded") {
      const hash = record.response?.transaction ?? record.transactionHash ?? "";
      return verifyRejected(
        "invalid_upto_stellar_payload_nonce_already_used",
        hash === ""
          ? "This authorization was already settled."
          : `This authorization was already settled in transaction ${hash}.`,
        payer,
      );
    }
    const code = record.response?.errorReason ?? "";
    const reason = `This authorization was already submitted for settlement: ${record.response?.errorMessage ?? code}`;
    return verifyRejected(
      isUptoStellarCode(code) ? code : "invalid_upto_stellar_payload_nonce_already_used",
      reason.length <= MAX_REASON_LENGTH ? reason : `${reason.slice(0, MAX_REASON_LENGTH - 1)}…`,
      payer,
    );
  }

  /**
   * The ledger reading and ledger close time for this request, and the preflight on them. A reading
   * that may be a few ledgers old only ever makes the lower bounds more lenient (the simulation still
   * enforces them), but it can make an authorization look too far in the future: an expiration past
   * the window or a start ledger not reached. Those two are decided again on a fresh reading before
   * the payment is refused.
   */
  private async prepare(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    phase: "verify" | "settle",
    ledgerMaxAgeMs: number,
  ): Promise<Prepared> {
    const { network, upto } = this.options;
    const [currentLedger, ledgerSeconds] = await Promise.all([
      this.latestLedger.read(ledgerMaxAgeMs),
      resolveLedgerSeconds(network, upto.ledgerSeconds),
    ]);
    const checked = this.preflight(payload, requirements, phase, currentLedger, ledgerSeconds);
    if (!checked.ok && AHEAD_OF_THE_LEDGER.has(checked.code) && ledgerMaxAgeMs > LEDGER_FRESH_MS) {
      const fresh = await this.latestLedger.read(LEDGER_FRESH_MS);
      if (fresh > currentLedger) {
        return {
          checked: this.preflight(payload, requirements, phase, fresh, ledgerSeconds),
          currentLedger: fresh,
          ledgerSeconds,
        };
      }
    }
    return { checked, currentLedger, ledgerSeconds };
  }

  private preflight(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    phase: "verify" | "settle",
    currentLedger: number,
    ledgerSeconds: number,
  ): UptoPreflight {
    const { engine, policy, upto } = this.options;
    return uptoPreflight(payload, requirements, {
      phase,
      policy,
      upto,
      authority: this.authority.address,
      facilitatorAddresses: engine.facilitatorAddresses,
      currentLedger,
      ledgerSeconds,
    });
  }

  /**
   * The `upto` mechanism for one request. It sees the ledger the preflight saw, so its static rules
   * agree with the preflight's. For verification its signers never sign. For a settlement it signs
   * with the leased channel (the transaction source) and the authority (the operation source), and
   * the engine's recording sponsor fee-bumps it, which records the envelope before broadcast.
   */
  private mechanism(
    prepared: Prepared,
    inclusionFeeStroops: number,
    context?: SubmissionContext,
    zeroSettlement: "onchain" | "offchain" = "onchain",
  ): UptoMechanism {
    const { engine, policy, upto, server } = this.options;
    const client: UptoRpc = {
      getLatestLedger: () => Promise.resolve({ sequence: prepared.currentLedger }),
      getAccount: (address) => server.getAccount(address),
      simulateTransaction: (transaction) => server.simulateTransaction(transaction),
      sendTransaction: (transaction) => server.sendTransaction(transaction),
      getTransaction: (hash) => server.getTransaction(hash),
      getLedgerEntries: (...keys) => server.getLedgerEntries(...keys),
    };
    const options: UptoStellarFacilitatorOptions = {
      rpc: () => client,
      settlementAuthority:
        context === undefined ? verificationOnlySigner(this.authority.address) : this.authority,
      zeroSettlement,
      contract: upto.contract,
      contractWasmHash: upto.contractWasmHash,
      ledgerSeconds: prepared.ledgerSeconds,
      maxTransactionFeeStroops: upto.maxTransactionFeeStroops,
      inclusionFeeStroops,
      maxTimeoutSeconds: uptoTimeoutSeconds(policy).max,
      minTimeoutSeconds: uptoTimeoutSeconds(policy).min,
      expirationMarginLedgers: policy.expirationMarginLedgers,
      isAssetAccepted: (asset) => policy.assets.has(asset),
      facilitatorAddresses: [...engine.facilitatorAddresses],
      feeBumpSigner: context?.feeBumpSigner ?? verificationOnlySigner(engine.sponsorAddress),
      // The engine records every envelope before broadcast and answers a refused one itself; a
      // rebuilt envelope would be a second record.
      badSequenceRetries: 0,
      ...(context === undefined ? {} : { selectSigner: () => context.channel }),
    };
    const signers =
      context === undefined ? engine.channelAddresses.map(verificationOnlySigner) : context.channelSigners;
    return new UptoMechanism([...signers], options);
  }

  /** A mechanism result with a registered code, a non-empty reason and the requested amount. */
  private normalize(result: SettleResponse, payer: string, amount: string): SettleResponse {
    if (result.success) return { ...result, amount };
    const code = registeredCode(result.errorReason);
    return settleFailed({
      code,
      reason: code === result.errorReason ? result.errorMessage : undefined,
      network: this.options.network,
      payer,
      transaction: result.transaction,
      amount,
    });
  }

  /** A result reached before anything was signed, with a missing payer account named. */
  private async unsigned(result: SettleResponse, payer: string, amount: string): Promise<SettleResponse> {
    if (result.success) return result;
    const cause = await this.diagnose(
      result.errorReason,
      result.errorMessage,
      payer,
      "unexpected_settle_error",
    );
    return settleFailed({
      code: cause.code,
      reason: cause.reason,
      network: this.options.network,
      payer,
      transaction: result.transaction,
      amount,
    });
  }

  /**
   * Names the cause of a refusal more precisely where the mechanism cannot: a `G…` payer whose
   * signature fails because its account does not exist on this network.
   */
  private async diagnose(
    code: string | undefined,
    reason: string | undefined,
    payer: string,
    fallback: "unexpected_verify_error" | "unexpected_settle_error",
  ): Promise<{ code: UptoResponseCode; reason: string | undefined }> {
    const registered = registeredCode(code, fallback);
    if (registered === "invalid_upto_stellar_payload_invalid_signature" && payer.startsWith("G")) {
      try {
        const existing = await existingAccounts(this.options.server, [payer]);
        if (!existing.has(payer)) {
          return {
            code: "invalid_upto_stellar_payload_account_missing",
            reason: `The payer account ${payer} does not exist on this network.`,
          };
        }
      } catch (error) {
        this.log.warn({ err: error, network: this.options.network }, "could not look up the payer account");
      }
    }
    return { code: registered, reason: registered === code ? reason : reasonFor(registered) };
  }
}

/** A code from the mechanism when it is registered, otherwise the phase's unexpected-error code. */
function registeredCode(
  code: string | undefined,
  fallback: "unexpected_verify_error" | "unexpected_settle_error" = "unexpected_settle_error",
): UptoResponseCode {
  if (isUptoStellarCode(code)) return code;
  if (code !== undefined && Object.hasOwn(uptoStandardCodes, code)) return code as UptoStandardCode;
  return fallback;
}

/** A signer that refuses to sign: verification never needs a signature. */
function verificationOnlySigner(address: string): FacilitatorStellarSigner {
  const refuse = () => Promise.reject(new Error("verification signers never sign"));
  return { address, signAuthEntry: refuse, signTransaction: refuse };
}
