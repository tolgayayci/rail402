import type { ErrorCode } from "@rail402/errors";

/**
 * Classify a Soroban simulation failure into an actionable error code.
 *
 * `@x402/stellar` reports every simulation failure as
 * `invalid_exact_stellar_payload_simulation_failed`. That single code covers "you have no
 * trustline", "you're broke", "this payment was already used", and "ledger state is archived" —
 * an agent cannot choose a remediation from it, and the error contract requires a reason it can act on.
 *
 * Every signature below was captured from live testnet simulations, not inferred.
 *
 * ## Conservatism is the design
 *
 * A *wrong* classification is worse than none: telling a buyer "you have no trustline" when they
 * are actually out of funds sends them down the wrong path, and telling a buyer it is their fault
 * when the seller is misconfigured is worse still. So anything that does not match a known
 * signature falls back to the generic library code, unchanged.
 */

/** Stellar Asset Contract error ordinals, confirmed on testnet 2026-07-30. */
const SAC_ERR_NEGATIVE_AMOUNT = 8;
const SAC_ERR_BALANCE_OUT_OF_RANGE = 10;
const SAC_ERR_MISSING_TRUSTLINE = 13;

/** `HostError: Error(Contract, #13)` — captures the ordinal. */
const CONTRACT_ERROR_RE = /Error\(Contract,\s*#(\d+)\)/;
/**
 * A contract account's `__check_auth` refused the authorization.
 *
 * Captured from a live testnet refusal, not inferred. The host emits:
 *
 *   topics:[error, Error(Auth, InvalidAction)],
 *   data:["failed account authentication with error", C…(the payer), Error(Contract, #3)]
 *
 * Match on the phrase rather than on `Error(Auth, InvalidAction)`, which also covers unrelated
 * cases such as an auth tree missing a required sub-invocation.
 */
const ACCOUNT_AUTH_REFUSED = "failed account authentication with error";
/** A Soroban contract address, for confirming the refusal names the payer. */
const CONTRACT_ADDRESS_RE = /\bC[A-Z2-7]{55}\b/g;
/** `Error(Storage, MissingValue)` — the asset contract is not instantiated. */
const STORAGE_MISSING_VALUE_RE = /Error\(Storage,\s*MissingValue\)/;
/** A Stellar G-address appearing in the diagnostic event data payload. */
const STELLAR_ADDRESS_RE = /\bG[A-Z2-7]{55}\b/g;

export interface ClassifyInput {
  /** The `error` string from a failed `simulateTransaction`. */
  readonly simulationError: string;
  /** The transfer sender, from the decoded payload. */
  readonly payer: string;
  /** The transfer recipient, i.e. `requirements.payTo`. */
  readonly recipient: string;
}

export interface Classification {
  readonly code: ErrorCode;
  /** True when we narrowed the generic failure to a specific cause. */
  readonly refined: boolean;
  /** Extra context for the error payload. Never contains secrets or full payloads. */
  readonly details?: Record<string, unknown>;
}

const GENERIC: Classification = {
  code: "invalid_exact_stellar_payload_simulation_failed",
  refined: false,
};

/**
 * Extract the account a `#13` diagnostic is complaining about.
 *
 * The captured shape is:
 *   topics:[error, Error(Contract, #13)], data:["trustline entry is missing for account", G...]
 *
 * The failing account appears in the error event's own data. The subsequent `fn_call` event also
 * lists payer and recipient, so we must read the address that appears *before* the `fn_call`
 * marker — otherwise we would match the payer every time simply because it is the first argument.
 */
function offendingTrustlineAccount(simulationError: string): string | undefined {
  const marker = "trustline entry is missing for account";
  const at = simulationError.indexOf(marker);
  if (at === -1) return undefined;

  // Bound the search to the error event: stop at the next diagnostic event, whose data would
  // otherwise contribute the transfer's own from/to arguments.
  const rest = simulationError.slice(at);
  const nextEvent = rest.indexOf("[Diagnostic Event]");
  const window = nextEvent === -1 ? rest : rest.slice(0, nextEvent);

  const matches = window.match(STELLAR_ADDRESS_RE);
  return matches?.[0];
}

/**
 * Map a Soroban simulation error to a refined code where the cause is unambiguous.
 *
 * @param input - the simulation error plus the payer/recipient it was produced for
 * @returns the refined classification, or the generic simulation-failed code
 */
export function classifySimulationError(input: ClassifyInput): Classification {
  const { simulationError, payer, recipient } = input;

  if (!simulationError) return GENERIC;

  // A smart-wallet payer refusing its own payment. Checked first: the host reports it as an
  // auth failure wrapping the account's own contract error, so an ordinal-based rule below would
  // otherwise read the ACCOUNT's error taxonomy as if it were the asset contract's — the exact
  // wrong-classification failure this module is built to avoid. A `#3` from a smart wallet means
  // whatever its author decided; a `#3` from the SAC means something else entirely.
  //
  // Deliberately says nothing about WHY the account refused. The ordinal belongs to the account's
  // private taxonomy and we cannot read it, but we do not need to: "your own wallet declined this"
  // is already actionable, and it is the same remedy whichever policy fired.
  if (simulationError.includes(ACCOUNT_AUTH_REFUSED)) {
    const named: readonly string[] = simulationError.match(CONTRACT_ADDRESS_RE) ?? [];
    // Only attribute when the refusal names the payer. If it names some other contract account in
    // the tree, staying generic is the honest answer.
    if (named.includes(payer)) {
      return {
        code: "invalid_exact_stellar_payload_account_policy_refused",
        refined: true,
        details: { account: payer, side: "payer" },
      };
    }
    return GENERIC;
  }

  if (STORAGE_MISSING_VALUE_RE.test(simulationError)) {
    return {
      code: "invalid_exact_stellar_ledger_entry_restore_required",
      refined: true,
      details: { hint: "asset contract instance or ledger entry is not available" },
    };
  }

  const ordinal = Number(CONTRACT_ERROR_RE.exec(simulationError)?.[1]);
  if (!Number.isFinite(ordinal)) return GENERIC;

  switch (ordinal) {
    case SAC_ERR_MISSING_TRUSTLINE: {
      const account = offendingTrustlineAccount(simulationError);

      // Only attribute fault when the address unambiguously matches one side. If the diagnostic
      // names neither (or we could not parse it), stay generic rather than guess wrong.
      if (account === recipient) {
        return {
          code: "invalid_exact_stellar_payload_missing_trustline_recipient",
          refined: true,
          details: { account, side: "recipient" },
        };
      }
      if (account === payer) {
        return {
          code: "invalid_exact_stellar_payload_missing_trustline_payer",
          refined: true,
          details: { account, side: "payer" },
        };
      }
      return GENERIC;
    }

    case SAC_ERR_BALANCE_OUT_OF_RANGE:
      return {
        code: "invalid_exact_stellar_payload_insufficient_balance",
        refined: true,
        details: { account: payer },
      };

    case SAC_ERR_NEGATIVE_AMOUNT:
      // Structural validation rejects a mismatched amount long before simulation, so reaching
      // here means the declared amount itself was negative.
      return {
        code: "invalid_exact_stellar_payload_wrong_amount",
        refined: true,
        details: { hint: "negative amount is not allowed" },
      };

    default:
      return GENERIC;
  }
}

/**
 * Detect a replayed authorization.
 *
 * Soroban consumes an auth entry's nonce on use, so replaying a settled payload fails at
 * simulation. This IS captured from live replays now — the `exact` and `upto` e2e flows both replay
 * a settled payload and prove it is refused (e.g. `invalid_exact_stellar_payload_authorization_replayed`
 * on 2026-08-03). The host raises `Error(Auth, ExistingValue)` with the text "nonce already exists
 * for address"; the contract body never runs.
 *
 * Two independent tokens are matched, so a rewording of either half still classifies:
 *   1. `Error(Auth, ExistingValue)` — the structured host error, matched verbatim like the `upto`
 *      scheme's own detector (`isReplay` in `packages/scheme-upto-stellar`). This is the strongest
 *      signal and was the half missing here while `upto` carried it.
 *   2. the nonce-collision wording, kept as a belt-and-braces fallback.
 *
 * `Error(Auth, ExistingValue)` fires only on a nonce that already exists in the ledger, which is a
 * replay by definition — so there is no false-positive risk. The unrelated `Error(Auth,
 * InvalidAction)` (missing sub-invocation, or a smart account declining) is a different token and is
 * deliberately NOT matched here.
 *
 * @param simulationError - the `error` string from a failed simulation
 * @returns true when the failure is unambiguously a consumed/duplicate nonce
 */
export function isReplayedAuthorization(simulationError: string): boolean {
  if (!simulationError) return false;
  return (
    /Error\(Auth,\s*ExistingValue\)/.test(simulationError) ||
    /existing entry (?:for|with) nonce/i.test(simulationError) ||
    /nonce.{0,40}(?:already|exists|used|consumed|duplicate)/i.test(simulationError) ||
    /(?:already|duplicate).{0,20}nonce/i.test(simulationError)
  );
}

/**
 * Detect an authorization whose signature has EXPIRED — the verify→settle race,
 * where the ~12-ledger (~60s) window elapses between an agent's `/verify` and
 * `/settle`.
 *
 * Captured from a real testnet expiry, NOT
 * guessed: the host raises `HostError: Error(Auth, InvalidInput)` carrying the diagnostic phrase
 * `"signature has expired"` with the current and expiration ledgers. We match the **phrase**, not the
 * bare `Error(Auth, InvalidInput)` — that token also covers unrelated malformed-input auth failures,
 * so matching it alone would mislabel them. The phrase fires only on an elapsed
 * `signatureExpirationLedger`.
 *
 * Without this, an expiry surfaced as the generic `…simulation_failed` (no actionable "re-sign"
 * remedy) and, if it reached submission, as a **retryable** code an agent would loop on. The refined
 * `settle_exact_stellar_authorization_expired` is non-retryable.
 *
 * @param simulationError - the `error` string from a failed simulation
 * @returns true when the failure is unambiguously an expired authorization signature
 */
export function isExpiredAuthorization(simulationError: string): boolean {
  if (!simulationError) return false;
  return /signature has expired/i.test(simulationError);
}
