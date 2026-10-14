import { createHash } from "node:crypto";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { RequestFingerprint } from "./ledger.ts";

/**
 * Request fingerprints for settlement idempotency.
 *
 * A settlement is keyed by the payer's authorization (network, payer, nonce). A repeat of the same
 * key is answered from the ledger only when it is the same request: the same signed transaction
 * settled under the same terms. The terms are part of the fingerprint because a scheme can settle
 * one authorization for an amount chosen at settle time, and because a stored success must never
 * answer a request for a different recipient, asset or amount.
 */

/** The request terms a fingerprint covers. Every scheme settles a signed transaction under these. */
export interface SettlementTerms {
  readonly scheme: string;
  readonly network: string;
  readonly asset: string;
  readonly payTo: string;
  /** The settle-time amount in base units, as a decimal string. */
  readonly amount: string;
  /** The payment payload's signed transaction, base64 XDR, exactly as received. */
  readonly transaction: string;
}

/** SHA-256 hex of the signed transaction XDR: the pre-fingerprint identity of a payment. */
export function payloadHash(transaction: string): string {
  return sha256(transaction);
}

/** `sha256(canonicalJSON({scheme, network, asset, payTo, amount, transaction}))`, hex. */
export function requestHash(terms: SettlementTerms): string {
  return sha256(
    canonicalJson({
      scheme: terms.scheme,
      network: terms.network,
      asset: terms.asset,
      payTo: terms.payTo,
      amount: terms.amount,
      transaction: terms.transaction,
    }),
  );
}

/** The fingerprint of a settle request whose payload carries `{ transaction }`. */
export function fingerprintOf(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): RequestFingerprint {
  const transaction = stringOf((payload.payload as { transaction?: unknown } | undefined)?.transaction);
  return {
    payloadHash: payloadHash(transaction),
    requestHash: requestHash({
      scheme: stringOf(requirements.scheme),
      network: stringOf(requirements.network),
      asset: stringOf(requirements.asset),
      payTo: stringOf(requirements.payTo),
      amount: stringOf(requirements.amount),
      transaction,
    }),
  };
}

/**
 * The fingerprint of an `upto` settle request, whose payload carries the payer's signed
 * authorization entries instead of a transaction. The settle-time amount is part of both hashes:
 * the same authorization settled for another amount is a different request.
 */
export function uptoFingerprintOf(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): RequestFingerprint {
  const body = payload.payload as { authorization?: unknown; signerAuthorizations?: unknown } | undefined;
  const authorization = stringOf(body?.authorization);
  const signerAuthorizations = Array.isArray(body?.signerAuthorizations)
    ? body.signerAuthorizations.map(stringOf)
    : [];
  const amount = stringOf(requirements.amount);
  return {
    payloadHash: sha256([authorization, ...signerAuthorizations, `amount:${amount}`].join("\n")),
    requestHash: sha256(
      canonicalJson({
        scheme: stringOf(requirements.scheme),
        network: stringOf(requirements.network),
        asset: stringOf(requirements.asset),
        payTo: stringOf(requirements.payTo),
        amount,
        authorization,
        signerAuthorizations,
      }),
    ),
  };
}

/** JSON with object keys sorted at every level, so equal values always serialise to equal bytes. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** Requirements come off the wire: a missing or non-string field fingerprints as its JSON form. */
function stringOf(value: unknown): string {
  if (typeof value === "string") return value;
  return value === undefined ? "" : JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
