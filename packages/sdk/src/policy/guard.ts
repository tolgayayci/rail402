import { Keypair, StrKey, hash } from "@stellar/stellar-sdk";
import type { SignAuthEntry } from "@stellar/stellar-sdk/contract";
import type { StellarNetwork } from "@rail402.dev/stellar";
import { fromBase64 } from "../bytes.ts";
import { isPaymentError, paymentError, type AgentCode, type PaymentError } from "../codes.ts";
import { emit, type PaymentEventListener } from "../events.ts";
import type { Sep43AuthSigner } from "../keys.ts";
import type { SpendIntent, StellarSchemeAdapter } from "../schemes/adapter.ts";
import { decideSpend, type SpendExpectation } from "./decide.ts";
import type { Reservation, SpendLedger, WindowSpec } from "./ledger.ts";
import type { ResolvedPolicy } from "./policy.ts";

/** Reads the network's latest ledger; `LatestLedger` from @rail402.dev/stellar fits. */
export interface LedgerClock {
  read(maxAgeMs: number): Promise<number>;
}

/** A ledger reading older than this is refreshed before deciding on a signature. */
export const GUARD_LEDGER_MAX_AGE_MS = 5_000;

export interface GuardDeps {
  readonly network: StellarNetwork;
  readonly policy: ResolvedPolicy;
  readonly adapters: readonly StellarSchemeAdapter[];
  readonly ledger: SpendLedger;
  /** The budget window every signature reserves in. */
  readonly window: WindowSpec;
  readonly clock: LedgerClock;
  /**
   * The option this call selected. With it, the guard signs at most once and only an authorization
   * that pays exactly this. Without it (policy-only mode), every authorization that passes the
   * policy is signed, and the guard cannot tell whether it is the one the caller meant to pay.
   */
  readonly expectation?: SpendExpectation | undefined;
  /** The call's id; policy-only mode gives each signature its own. */
  readonly callId?: string | undefined;
  readonly resource?: string | undefined;
  readonly idempotencyKey?: string | undefined;
  readonly onEvent?: PaymentEventListener | undefined;
  readonly now?: (() => number) | undefined;
}

/** An authorization the guard let through, with the budget it holds. */
export interface GuardedAuthorization {
  readonly reservationId: string;
  readonly callId: string;
  readonly intent: SpendIntent;
  readonly adapter: StellarSchemeAdapter;
  /** The latest ledger read before signing. */
  readonly signedAtLedger: number;
}

/**
 * A SEP-43 signer for the upstream x402 client whose `signAuthEntry` enforces the spending policy on
 * the exact bytes it signs. It has no `signTransaction`: a payment never needs the buyer to sign a
 * transaction envelope.
 */
export interface GuardedSigner {
  readonly address: string;
  /** An own property, so it works when the upstream client passes it unbound. */
  readonly signAuthEntry: SignAuthEntry;
  /** Authorizations signed through this guard, in order. */
  readonly authorizations: readonly GuardedAuthorization[];
  /** The refusal raised inside `signAuthEntry`, kept in case a caller's library wraps the error. */
  readonly failure: PaymentError | undefined;
}

/**
 * Wraps a signer so that nothing is signed unless it passes `decideSpend` and its amount is reserved
 * in the budget ledger. The decision and the reservation run in the same synchronous step, so
 * concurrent payments can never jointly exceed a cap. A signing failure releases the reservation; a
 * produced signature keeps it until the chain proves what happened.
 */
export function createGuardedSigner(base: Sep43AuthSigner, deps: GuardDeps): GuardedSigner {
  const authorizations: GuardedAuthorization[] = [];
  const now = deps.now ?? Date.now;
  const armed = deps.expectation !== undefined;
  let entered = false;
  let failure: PaymentError | undefined;

  const refuse = (callId: string | undefined, code: AgentCode, reason?: string): PaymentError => {
    const error = paymentError(code, { reason, callId });
    failure = error;
    emit(deps.onEvent, { type: "refused", callId, code });
    return error;
  };

  const signAuthEntry = async (
    authEntry: string,
    opts?: { networkPassphrase?: string; address?: string },
  ): Promise<{ signedAuthEntry: string; signerAddress: string }> => {
    const callId = armed ? (deps.callId ?? "unknown") : crypto.randomUUID();
    // One signature per armed call: a second request (another entry, a corrective retry) is refused.
    if (armed && entered) {
      throw refuse(
        callId,
        "payment_authorization_rejected",
        "A second signature was requested within one call.",
      );
    }
    entered = true;

    let latestLedger: number;
    try {
      latestLedger = await deps.clock.read(GUARD_LEDGER_MAX_AGE_MS);
    } catch {
      throw refuse(
        callId,
        "rpc_unavailable",
        "The latest ledger could not be read, so the authorization's expiry cannot be checked.",
      );
    }

    // Decide and reserve in one synchronous step: no await between them.
    const decision = decideSpend(authEntry, {
      network: deps.network,
      policy: deps.policy,
      adapters: deps.adapters,
      signerAddress: base.address,
      requested: { address: opts?.address, networkPassphrase: opts?.networkPassphrase },
      latestLedger,
      expectation: deps.expectation,
    });
    if (!decision.ok) throw refuse(callId, decision.code, decision.reason);
    const { intent, adapter } = decision;
    let reservation: Reservation;
    try {
      reservation = deps.ledger.reserve(
        deps.window,
        {
          callId,
          scheme: intent.scheme,
          asset: intent.asset,
          payTo: intent.recipient,
          resource: deps.resource ?? "",
          amount: intent.maxAmount,
          idempotencyKey: armed ? deps.idempotencyKey : undefined,
        },
        now(),
      );
    } catch (error) {
      if (isPaymentError(error)) {
        failure = error;
        emit(deps.onEvent, { type: "refused", callId, code: error.code });
        throw error;
      }
      throw refuse(callId, "payment_ledger_unavailable");
    }
    emit(deps.onEvent, {
      type: "reserved",
      callId,
      reservation: reservation.id,
      asset: intent.asset,
      amount: intent.maxAmount.toString(),
    });

    let signed: { signedAuthEntry: string; signerAddress?: string; error?: unknown };
    try {
      signed = await base.signAuthEntry(authEntry, { address: base.address });
    } catch {
      throw releaseAndFail(reservation, callId, "The key or wallet threw while signing.");
    }
    if (signed.error !== undefined && signed.error !== null) {
      throw releaseAndFail(reservation, callId, "The wallet returned an error instead of a signature.");
    }
    if (!validSignature(base.address, authEntry, signed.signedAuthEntry)) {
      throw releaseAndFail(
        reservation,
        callId,
        "The wallet's signature does not verify for this authorization.",
      );
    }

    // Recorded before the signature is handed back, so a crash never leaves an unrecorded signature.
    const recorded = deps.ledger.markSigned(
      reservation.id,
      { nonce: intent.nonce, expirationLedger: intent.expirationLedger, signedAtLedger: latestLedger },
      now(),
    );
    if (!recorded) {
      throw refuse(
        callId,
        "payment_authorization_rejected",
        "The budget reservation was released while signing.",
      );
    }
    authorizations.push({
      reservationId: reservation.id,
      callId,
      intent,
      adapter,
      signedAtLedger: latestLedger,
    });
    emit(deps.onEvent, {
      type: "signed",
      callId,
      reservation: reservation.id,
      nonce: intent.nonce.toString(),
      expirationLedger: intent.expirationLedger,
    });
    return { signedAuthEntry: signed.signedAuthEntry, signerAddress: base.address };
  };

  const releaseAndFail = (reservation: Reservation, callId: string, reason: string): PaymentError => {
    // No usable signature exists, so the budget returns at once. Signing is never retried.
    if (deps.ledger.release(reservation.id, "not_signed", now())) {
      emit(deps.onEvent, {
        type: "released",
        callId,
        reservation: reservation.id,
        reason: "not_signed",
        amount: reservation.amount.toString(),
      });
    }
    return refuse(callId, "payment_signing_failed", reason);
  };

  return {
    address: base.address,
    signAuthEntry,
    get authorizations() {
      return authorizations;
    },
    get failure() {
      return failure;
    },
  };
}

/**
 * Checks the payload the upstream client produced against what the guard signed: the transaction
 * must carry exactly the one signed authorization and perform exactly its transfer. On a mismatch the
 * reservation stays pending (the signed entry has already been seen by the RPC during simulation).
 */
export function checkGuardedPayload(
  signer: GuardedSigner,
  payload: Readonly<Record<string, unknown>>,
): GuardedAuthorization {
  const [authorization, ...others] = signer.authorizations;
  if (authorization === undefined || others.length > 0) {
    throw paymentError("payment_authorization_rejected", {
      reason: "The payment must carry exactly one guarded authorization.",
    });
  }
  const mismatch = authorization.adapter.checkPayload(payload, authorization.intent);
  if (mismatch !== undefined) {
    throw paymentError("payment_authorization_rejected", {
      reason: `The payment differs from the signed authorization: ${mismatch}`,
      callId: authorization.callId,
    });
  }
  return authorization;
}

/** Verifies an Ed25519 signature for G… signers; smart-account (C…) signatures are checked on chain. */
function validSignature(address: string, authEntry: string, signature: unknown): boolean {
  if (typeof signature !== "string" || signature === "") return false;
  if (!StrKey.isValidEd25519PublicKey(address)) return true;
  try {
    return Keypair.fromPublicKey(address).verify(hash(fromBase64(authEntry)), fromBase64(signature));
  } catch {
    return false;
  }
}
