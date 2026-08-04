/**
 * The `upto` scheme for Stellar — authorize a ceiling, settle the actual usage.
 *
 * Network spec: `specs/scheme_upto_stellar.md` (drafted for upstream contribution).
 * Settlement contract: `contracts/upto-stellar`, deployed to testnet.
 *
 * @module
 */
export { UptoStellarClientScheme, type UptoStellarClientOptions } from "./client.js";
export { UptoStellarServerScheme } from "./server.js";
export { UptoStellarFacilitatorScheme, type UptoStellarFacilitatorOptions } from "./facilitator.js";
export { UPTO_CONTRACTS, uptoContractFor, ARG, SETTLE_FN, SETTLE_ARG_COUNT } from "./constants.js";
export type { UptoStellarPayloadV2, UptoStellarExtra } from "./types.js";
