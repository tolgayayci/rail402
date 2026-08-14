/**
 * Presentation helpers for the playground UI. Money math stays in `shared/amounts.ts`; this file
 * adds only the browser-facing concerns: human display and explorer links.
 */
export { decimalToStroops, stroopsToDecimal, stroopsToDisplay } from "../shared/amounts.js";

const EXPLORER = "https://stellar.expert/explorer/testnet";

/** stellar.expert link for a settled transaction — every success moment ends in one of these. */
export function txUrl(hash: string): string {
  return `${EXPLORER}/tx/${hash}`;
}

/** stellar.expert link for an account. */
export function accountUrl(address: string): string {
  return `${EXPLORER}/account/${address}`;
}

/** stellar.expert link for a Soroban contract (the upto settlement contract, the SAC). */
export function contractUrl(contractId: string): string {
  return `${EXPLORER}/contract/${contractId}`;
}

/** "GABC…WXYZ" — the standard truncation for an address or hash in the UI. */
export function truncate(value: string, lead = 4, tail = 4): string {
  if (value.length <= lead + tail + 1) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}
