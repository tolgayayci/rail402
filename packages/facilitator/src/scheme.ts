import type { rpc } from "@stellar/stellar-sdk";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import type { StellarNetwork } from "@rail402.dev/stellar";
import type { SettlementEngine } from "./engine.ts";
import { explainSimulation } from "./explain.ts";
import { LEDGER_FRESH_MS, LatestLedger } from "./latest-ledger.ts";
import { silentLogger, type Logger } from "./logger.ts";
import type { NetworkPolicy } from "./policy.ts";
import { preflight, type Preflight } from "./preflight.ts";
import { normalizeVerify, settleFailed, verifyRejected } from "./responses.ts";

/**
 * Verify may answer from a ledger reading up to one ledger close old: it is advisory, and the upstream
 * verifier's simulation checks expiry against the live ledger anyway. Settle commits the sponsor's
 * fee, so it waits for a reading no older than LEDGER_FRESH_MS.
 */
const VERIFY_LEDGER_MAX_AGE_MS = 5_000;
const SETTLE_LEDGER_MAX_AGE_MS = LEDGER_FRESH_MS;

export interface ExactSchemeOptions {
  readonly network: StellarNetwork;
  readonly passphrase: string;
  readonly rpcUrl: string;
  readonly server: rpc.Server;
  readonly policy: NetworkPolicy;
  readonly engine: SettlementEngine;
  readonly log?: Logger;
}

/**
 * The `exact` scheme for one Stellar network, registered with an upstream `x402Facilitator`.
 *
 * Verification layers three checks: Rail402's preflight (policy, structure, authorization expiry,
 * decided without RPC), the unmodified upstream verifier (every MUST in scheme_exact_stellar.md,
 * including the enforcing simulation), and a diagnosis of any simulation failure into a specific code.
 * Settlement repeats the preflight — `/settle` never assumes a prior `/verify` — and then hands the
 * payment to the settlement engine.
 */
export class StellarExactScheme implements SchemeNetworkFacilitator {
  readonly scheme = "exact";
  readonly caipFamily = "stellar:*";

  private verifier: { readonly bid: number; readonly scheme: ExactStellarScheme } | undefined;
  private readonly log: Logger;
  private readonly facilitatorAddresses: ReadonlySet<string>;
  private readonly latestLedger: LatestLedger;
  private readonly options: ExactSchemeOptions;

  constructor(options: ExactSchemeOptions) {
    this.options = options;
    this.log = options.log ?? silentLogger;
    this.facilitatorAddresses = options.engine.facilitatorAddresses;
    this.latestLedger = new LatestLedger(options.server, this.log);
  }

  getExtra(_network: Network): Record<string, unknown> {
    return { areFeesSponsored: true };
  }

  getSigners(_network: string): string[] {
    return [...this.facilitatorAddresses];
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    try {
      const checked = await this.preflight(payload, requirements, VERIFY_LEDGER_MAX_AGE_MS);
      if (!checked.ok) return verifyRejected(checked.code, checked.reason, checked.payer);

      const verifier = this.verifierFor(await this.options.engine.inclusionFeeBid());
      const upstream = normalizeVerify(await verifier.verify(payload, requirements));
      if (upstream.isValid || upstream.invalidReason !== "invalid_exact_stellar_payload_simulation_failed") {
        return upstream;
      }
      const cause = await explainSimulation(this.options.server, checked.transfer);
      return cause === undefined ? upstream : verifyRejected(cause.code, cause.reason, checked.transfer.from);
    } catch (error) {
      this.log.error({ err: error, network: this.options.network }, "verify failed unexpectedly");
      return verifyRejected("unexpected_verify_error");
    }
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    try {
      const checked = await this.preflight(payload, requirements, SETTLE_LEDGER_MAX_AGE_MS);
      if (!checked.ok) {
        return settleFailed({
          code: checked.code,
          reason: checked.reason,
          network: requirements.network,
          payer: checked.payer,
        });
      }
      return await this.options.engine.settle(payload, requirements, checked);
    } catch (error) {
      this.log.error({ err: error, network: this.options.network }, "settle failed unexpectedly");
      return settleFailed({ code: "unexpected_settle_error", network: requirements.network });
    }
  }

  private async preflight(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    ledgerMaxAgeMs: number,
  ): Promise<Preflight> {
    return preflight(payload, requirements, {
      policy: this.options.policy,
      passphrase: this.options.passphrase,
      facilitatorAddresses: this.facilitatorAddresses,
      currentLedger: await this.currentLedger(ledgerMaxAgeMs),
    });
  }

  /**
   * The upstream verifier, built for the inclusion fee settlement would bid now, so a payment passes
   * verify's fee ceiling only if settle's bid fits too. Used for verification only: its signers are
   * never asked to sign; they exist so upstream's safety checks treat every channel and the sponsor
   * as facilitator accounts.
   */
  private verifierFor(bid: number): ExactStellarScheme {
    if (this.verifier?.bid !== bid) {
      const { engine, policy, rpcUrl } = this.options;
      this.verifier = {
        bid,
        scheme: new ExactStellarScheme(engine.channelAddresses.map(verificationOnlySigner), {
          rpcConfig: { url: rpcUrl },
          areFeesSponsored: true,
          maxTransactionFeeStroops: policy.maxTransactionFeeStroops,
          inclusionFeeStroops: bid,
          feeBumpSigner: verificationOnlySigner(engine.sponsorAddress),
        }),
      };
    }
    return this.verifier.scheme;
  }

  private currentLedger(maxAgeMs: number): Promise<number> {
    return this.latestLedger.read(maxAgeMs);
  }
}

/** A signer that refuses to sign: verification never needs a signature. */
function verificationOnlySigner(address: string) {
  const refuse = () => Promise.reject(new Error("verification signers never sign"));
  return { address, signAuthEntry: refuse, signTransaction: refuse };
}
