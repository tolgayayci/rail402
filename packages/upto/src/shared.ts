import { StrKey } from "@stellar/stellar-sdk";
import type { Network } from "@x402/core/types";
import { getEstimatedLedgerCloseTimeSeconds, isStellarNetwork } from "@x402/stellar";
import { I128_MAX, NOMINAL_LEDGER_SECONDS, UPTO_DEPLOYMENTS } from "./constants.ts";
import type { LedgerSecondsSource, UptoContractOverride } from "./types.ts";

/**
 * Whether `address` is a valid account strkey (`G…`).
 *
 * @param address - The value to check
 * @returns Whether it is a `G…` address
 */
export function isAccountAddress(address: unknown): address is string {
  return typeof address === "string" && StrKey.isValidEd25519PublicKey(address);
}

/**
 * Whether `address` is a valid contract strkey (`C…`).
 *
 * @param address - The value to check
 * @returns Whether it is a `C…` address
 */
export function isContractAddress(address: unknown): address is string {
  return typeof address === "string" && StrKey.isValidContract(address);
}

/**
 * Whether `address` is a valid muxed-account strkey (`M…`).
 *
 * @param address - The value to check
 * @returns Whether it is an `M…` address
 */
export function isMuxedAddress(address: unknown): address is string {
  return typeof address === "string" && StrKey.isValidMed25519PublicKey(address);
}

/**
 * Whether `address` is a valid account or contract strkey — the addresses `upto` can pay to or from.
 *
 * @param address - The value to check
 * @returns Whether it is a `G…` or `C…` address
 */
export function isAccountOrContract(address: unknown): address is string {
  return isAccountAddress(address) || isContractAddress(address);
}

const INTEGER = /^(?:0|[1-9][0-9]*)$/;

/**
 * Parses an atomic amount: a canonical non-negative integer string that fits a Soroban `i128`.
 * Returns `undefined` for anything else (signs, decimals, leading zeros, exponents, overflow).
 *
 * @param value - The amount string
 * @returns The amount, or `undefined` when it is not a canonical `i128` integer
 */
export function parseAtomicAmount(value: unknown): bigint | undefined {
  if (typeof value !== "string" || !INTEGER.test(value) || value.length > 40) return undefined;
  const amount = BigInt(value);
  return amount <= I128_MAX ? amount : undefined;
}

/**
 * The settlement contract for `network`: the override when one is configured for it, otherwise
 * the canonical deployment. `undefined` when the network has neither.
 *
 * @param network - CAIP-2 network
 * @param override - A contract address, or one per network
 * @returns The contract address, or `undefined`
 */
export function resolveUptoContract(network: string, override?: UptoContractOverride): string | undefined {
  if (typeof override === "string") return override;
  if (override !== undefined && hasOwn(override, network)) return override[network];
  return isStellarNetwork(network as Network) ? UPTO_DEPLOYMENTS[network]?.address : undefined;
}

/**
 * Seconds per ledger for `network`, from a fixed value, a callback or the Horizon estimate.
 *
 * @param network - CAIP-2 network
 * @param source - A fixed value or a callback; the Horizon estimate when absent
 * @returns A positive number of seconds
 */
export async function resolveLedgerSeconds(network: string, source?: LedgerSecondsSource): Promise<number> {
  const seconds =
    source === undefined
      ? await getEstimatedLedgerCloseTimeSeconds(network as Network)
      : typeof source === "number"
        ? source
        : await source(network);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`ledger close time must be a positive number of seconds, got ${String(seconds)}`);
  }
  return seconds;
}

/**
 * Ledgers covering `maxTimeoutSeconds` at `ledgerSeconds` per ledger, rounded up.
 *
 * @param maxTimeoutSeconds - The payment timeout
 * @param ledgerSeconds - Seconds per ledger
 * @returns The number of ledgers
 */
export function ledgersFor(maxTimeoutSeconds: number, ledgerSeconds: number): number {
  return Math.ceil(maxTimeoutSeconds / ledgerSeconds);
}

/**
 * The smallest `maxTimeoutSeconds` a facilitator accepts by default for its expiration margin: one
 * ledger more than the margin, at the nominal ledger time (15 s for the default margin of 2). A
 * shorter timeout gives an authorization that expires before verification and settlement can both
 * pass the margin, so the payment would be refused however the payer signs it.
 *
 * @param expirationMarginLedgers - The facilitator's expiration margin, in ledgers
 * @returns The minimum timeout, in seconds
 */
export function minTimeoutSecondsFor(expirationMarginLedgers: number): number {
  return (expirationMarginLedgers + 1) * NOMINAL_LEDGER_SECONDS;
}

/**
 * The ledger at which a payment signed now expires: `latestLedger + ceil(maxTimeoutSeconds /
 * ledgerSeconds)`. The terms' `expiration_ledger` and the entry's `signatureExpirationLedger` are
 * both set to it; both bounds are inclusive.
 *
 * @param latestLedger - The latest closed ledger
 * @param maxTimeoutSeconds - The payment timeout
 * @param ledgerSeconds - Seconds per ledger
 * @returns The expiration ledger
 */
export function expirationLedgerFor(
  latestLedger: number,
  maxTimeoutSeconds: number,
  ledgerSeconds: number,
): number {
  return latestLedger + ledgersFor(maxTimeoutSeconds, ledgerSeconds);
}

/**
 * Whether `extra` (a subset) agrees with `superset` on every key it sets.
 *
 * @param extra - The subset
 * @param superset - The object it must agree with
 * @returns Whether every key of `extra` has a deeply equal value in `superset`
 */
export function isSubsetOf(extra: Record<string, unknown>, superset: Record<string, unknown>): boolean {
  if (!isRecord(superset)) return false;
  return Object.entries(extra).every(
    ([key, value]) => hasOwn(superset, key) && deepEqual(value, superset[key]),
  );
}

/**
 * Whether `value` is a plain JSON object: not `null`, not an array.
 *
 * @param value - Any value
 * @returns Whether it is a non-null, non-array object
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether `object` has its own property `key`, without `Object.hasOwn` (an ES2022 library API).
 *
 * @param object - The object
 * @param key - The property
 * @returns Whether the property is the object's own
 */
function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/**
 * Structural equality of JSON-like values.
 *
 * @param a - One value
 * @param b - The other value
 * @returns Whether both have the same shape and primitive values
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every(
    (key) =>
      hasOwn(b, key) && deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}
