/**
 * Authorization expiry arithmetic shared by buyers, sellers and the facilitator.
 *
 * A Soroban authorization carries `signatureExpirationLedger`; the host accepts the signature through
 * that ledger, inclusive. x402 clients derive it from the payment's `maxTimeoutSeconds` and an
 * estimate of the ledger close time. A signer that must not be tricked into a long-lived authorization
 * bounds it from above, assuming ledgers close no faster than MIN_LEDGER_SECONDS.
 */

/**
 * The fastest ledger close time assumed when bounding an expiry from above. Public Stellar networks
 * close ledgers in about 5-6 seconds; a private network with 1-second ledgers still stays within the
 * bound because clients estimate from the public network's close time.
 */
export const MIN_LEDGER_SECONDS = 2;

/** Extra ledgers allowed on top of the bound, for a ledger closing between reading and signing. */
export const EXPIRATION_TOLERANCE_LEDGERS = 2;

/**
 * The expiration ledger an x402 client asks for: the current ledger plus `maxTimeoutSeconds` in
 * ledgers of `secondsPerLedger`, rounded up.
 */
export function expirationLedgerFor(
  maxTimeoutSeconds: number,
  currentLedger: number,
  secondsPerLedger: number,
): number {
  assertNonNegativeInteger("maxTimeoutSeconds", maxTimeoutSeconds);
  assertNonNegativeInteger("currentLedger", currentLedger);
  if (!Number.isFinite(secondsPerLedger) || secondsPerLedger <= 0) {
    throw new RangeError("secondsPerLedger must be a positive number");
  }
  return currentLedger + Math.ceil(maxTimeoutSeconds / secondsPerLedger);
}

/**
 * The latest expiration ledger a signer should accept for a payment whose `maxTimeoutSeconds` is
 * given, with `latest` read from the network just before signing:
 * `latest + ceil(maxTimeoutSeconds / MIN_LEDGER_SECONDS) + EXPIRATION_TOLERANCE_LEDGERS`.
 */
export function maxAcceptableExpiration(latest: number, maxTimeoutSeconds: number): number {
  assertNonNegativeInteger("latest", latest);
  assertNonNegativeInteger("maxTimeoutSeconds", maxTimeoutSeconds);
  return latest + Math.ceil(maxTimeoutSeconds / MIN_LEDGER_SECONDS) + EXPIRATION_TOLERANCE_LEDGERS;
}

/** Whether an authorization expiring at `expirationLedger` is no longer valid at ledger `current`. */
export function isExpired(expirationLedger: number, current: number): boolean {
  return current > expirationLedger;
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${name} must be a non-negative integer`);
}
