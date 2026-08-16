import { Transaction, rpc, scValToNative, Address } from "@stellar/stellar-sdk";
import type { Operation } from "@stellar/stellar-sdk";
import { Api } from "@stellar/stellar-sdk/rpc";
import { ExactStellarScheme as UpstreamExactStellarScheme } from "@x402/stellar/exact/facilitator";
import { getNetworkPassphrase, getRpcClient } from "@x402/stellar";
import { createError, enrichUpstreamCode, type ErrorCode } from "@rail402.dev/errors";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { classifySimulationError, isReplayedAuthorization, isExpiredAuthorization } from "./classify.js";

/**
 * `exact` on Stellar, wrapping the upstream `@x402/stellar` implementation.
 *
 * We do NOT reimplement verify/settle — that is a hard prohibition, and the
 * upstream implementation already covers every MUST in `scheme_exact_stellar.md` @ c4d2de65.
 * This wrapper adds exactly two things upstream does not provide:
 *
 * 1. **A non-null human reason on every rejection**.
 *    Upstream sets `invalidReason`/`errorReason` on every failure but populates the human-readable
 *    `invalidMessage` on only one of roughly twenty call sites.
 *
 * 2. **Actionable classification of simulation failures.** Upstream collapses missing-trustline,
 *    insufficient-balance, replay, and archived-state into a single
 *    `invalid_exact_stellar_payload_simulation_failed`. An agent cannot pick a remediation from
 *    that, and a buyer cannot tell that the *seller* is the misconfigured party.
 *
 * The wire contract is untouched: `invalidReason`/`errorReason` still carry upstream's exact code
 * unless we can *refine* it, and refinements follow upstream's own naming convention.
 */

const GENERIC_SIM_FAILURE: ErrorCode = "invalid_exact_stellar_payload_simulation_failed";

export interface StellarSchemeOptions {
  readonly maxTransactionFeeStroops: number;
  readonly rpcUrlFor: (network: Network) => string | undefined;
}

export class EnrichedExactStellarScheme implements SchemeNetworkFacilitator {
  readonly scheme = "exact";
  readonly caipFamily: string;

  constructor(
    private readonly upstream: UpstreamExactStellarScheme,
    private readonly options: StellarSchemeOptions,
  ) {
    this.caipFamily = upstream.caipFamily;
  }

  getExtra(network: Network): Record<string, unknown> | undefined {
    return this.upstream.getExtra(network);
  }

  getSigners(network: string): string[] {
    return this.upstream.getSigners(network);
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    // Guard the XDR decode before upstream touches it. A base64-valid-but-undecodable transaction
    // ("AAAA") slips past upstream's base64 gate and TypeErrors on an unguarded read inside
    // `@x402/stellar`, which on settle escaped as an HTTP 500 with a raw V8 message and
    // `retryable: true` — an agent honoring that contract loops forever. Return the
    // registered malformed code instead, on both surfaces.
    if (this.isTransactionUndecodable(payload, requirements)) return this.malformedVerify();
    const response = await this.upstream.verify(payload, requirements);
    if (response.isValid) return response;
    return this.enrichVerify(response, payload, requirements);
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    if (this.isTransactionUndecodable(payload, requirements)) return this.malformedSettle(payload);
    const response = await this.upstream.settle(payload, requirements);
    if (response.success) return response;

    const enriched = await this.resolveFailure(
      response.errorReason,
      payload,
      requirements,
      response.payer,
      "unexpected_settle_error",
    );

    return {
      ...response,
      errorReason: enriched.code,
      // `errorMessage` is the field stock consumers actually read on a failed settlement:
      // `x402HTTPResourceServer` surfaces `settleResponse.errorMessage || settleResponse.errorReason`,
      // so leaving it empty means every stock client shows the buyer a bare code string — the exact
      // "reason that merely restates the code" degradation this facilitator exists to prevent, and
      // which we already avoid on verify via `invalidMessage`.
      //
      // Note the spec/SDK divergence: `x402-specification-v2.md` §7.2's settle-response table lists
      // only `errorReason`, while `SettleResponse` in @x402/core has carried `errorMessage` since v2
      // and the HTTP server reads it. Same shape as the `lastUpdated` disagreement — follow what
      // stock clients parse, and raise the spec gap upstream.
      errorMessage: enriched.reason,
      // `retryable` has no field anywhere in the spec or the SDK, so it rides in `extra`. An agent
      // that cannot tell "retry this" from "never retry this" turns one bad request into a loop.
      extra: { ...(response.extra ?? {}), reason: enriched.reason, retryable: enriched.retryable },
    } as SettleResponse;
  }

  /**
   * Whether the payload's transaction cannot be decoded. Upstream throws a bare `TypeError` on this
   * rather than returning a coded rejection, so we detect it up front. Degrades to `false` (let
   * upstream reject the bad network with its own code) if the network passphrase is unusable — that
   * is `invalid_network`, not a malformed transaction.
   */
  private isTransactionUndecodable(payload: PaymentPayload, requirements: PaymentRequirements): boolean {
    const raw = (payload.payload as { transaction?: unknown } | undefined)?.transaction;
    // A missing/non-string transaction is a different concern (the envelope schema and upstream
    // structural validation own it); we only guard a PRESENT string that fails to decode, which is
    // the case that reaches upstream's unguarded read and 500s.
    if (typeof raw !== "string") return false;
    let passphrase: string;
    try {
      passphrase = getNetworkPassphrase(requirements.network);
    } catch {
      return false;
    }
    try {
      // Throws (XdrReaderError) on a base64-valid-but-invalid transaction envelope.
      const decoded = new Transaction(raw, passphrase);
      return decoded == null;
    } catch {
      return true;
    }
  }

  private malformedVerify(): VerifyResponse {
    const e = createError("invalid_exact_stellar_payload_malformed");
    return { isValid: false, invalidReason: e.code, invalidMessage: e.reason };
  }

  private malformedSettle(payload: PaymentPayload): SettleResponse {
    const e = createError("invalid_exact_stellar_payload_malformed");
    return {
      success: false,
      network: payload.accepted.network,
      transaction: "",
      errorReason: e.code,
      errorMessage: e.reason,
      extra: { reason: e.reason, retryable: e.retryable },
    } as SettleResponse;
  }

  /**
   * Attach a human reason to a failed verification, refining the code when we can prove a cause.
   */
  private async enrichVerify(
    response: VerifyResponse,
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const enriched = await this.resolveFailure(
      response.invalidReason,
      payload,
      requirements,
      response.payer,
      "unexpected_verify_error",
    );

    return {
      ...response,
      invalidReason: enriched.code,
      invalidMessage: enriched.reason,
    };
  }

  /**
   * Turn an upstream code into `{ code, reason, retryable }`, re-simulating only when upstream
   * gave us the generic simulation failure and a refinement is therefore possible.
   */
  private async resolveFailure(
    upstreamCode: string | undefined,
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    payer: string | undefined,
    // Surface-appropriate fallback for an unrecognized upstream code, so a settle-time failure is
    // never mislabeled as a verify error. All known codes are registered, so this only bites a
    // genuinely unknown upstream string — but the label should still match the endpoint it came from.
    fallback: ErrorCode,
  ): Promise<{ code: ErrorCode; reason: string; retryable: boolean }> {
    if (upstreamCode === GENERIC_SIM_FAILURE) {
      const refined = await this.refineSimulationFailure(payload, requirements, payer);
      if (refined) return refined;
    }

    const enriched = enrichUpstreamCode(upstreamCode, fallback);
    return { code: enriched.code, reason: enriched.reason, retryable: enriched.retryable };
  }

  /**
   * Re-simulate the payment to recover the host error string upstream discarded, then classify it.
   *
   * This costs one extra RPC round trip, but only on a path that has already failed — precisely
   * where the extra detail is worth paying for. Any problem here degrades to `undefined`, which
   * leaves upstream's original code and a generic reason intact: diagnostics must never be able to
   * turn a clean rejection into a 500.
   */
  private async refineSimulationFailure(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    payerFromUpstream: string | undefined,
  ): Promise<{ code: ErrorCode; reason: string; retryable: boolean } | undefined> {
    try {
      const network = requirements.network;
      const rpcUrl = this.options.rpcUrlFor(network);
      const server = getRpcClient(network, rpcUrl ? { url: rpcUrl } : undefined);
      const passphrase = getNetworkPassphrase(network);

      const raw = (payload.payload as { transaction?: unknown } | undefined)?.transaction;
      if (typeof raw !== "string") return undefined;

      const transaction = new Transaction(raw, passphrase);
      const payer = payerFromUpstream ?? extractPayer(transaction);
      if (!payer) return undefined;

      const sim = await server.simulateTransaction(transaction);
      if (!Api.isSimulationError(sim)) return undefined;

      const simulationError = sim.error ?? "";

      if (isReplayedAuthorization(simulationError)) {
        const e = createError("invalid_exact_stellar_payload_authorization_replayed", {
          details: { payer },
        });
        return { code: e.code, reason: e.reason, retryable: e.retryable };
      }

      // The verify→settle expiration race. Mapped to the specific, non-retryable expired code so an
      // agent re-signs a fresh authorization instead of looping on a doomed one. Previously this code
      // was dead and the failure showed as a generic simulation error.
      if (isExpiredAuthorization(simulationError)) {
        const e = createError("settle_exact_stellar_authorization_expired", { details: { payer } });
        return { code: e.code, reason: e.reason, retryable: e.retryable };
      }

      const classified = classifySimulationError({
        simulationError,
        payer,
        recipient: requirements.payTo,
      });
      if (!classified.refined) return undefined;

      const e = createError(
        classified.code,
        classified.details === undefined ? {} : { details: classified.details },
      );
      return { code: e.code, reason: e.reason, retryable: e.retryable };
    } catch {
      // Never let diagnostics change the outcome.
      return undefined;
    }
  }
}

/**
 * Recover the transfer sender from a decoded transaction, for the case where upstream rejected
 * before it identified a payer.
 */
function extractPayer(transaction: Transaction): string | undefined {
  try {
    const op = transaction.operations[0];
    if (!op || op.type !== "invokeHostFunction") return undefined;
    const args = (op as Operation.InvokeHostFunction).func.invokeContract().args();
    const from = args[0];
    if (!from) return undefined;
    const native = scValToNative(from) as unknown;
    return typeof native === "string" ? native : undefined;
  } catch {
    return undefined;
  }
}

export { UpstreamExactStellarScheme, rpc, Address };
