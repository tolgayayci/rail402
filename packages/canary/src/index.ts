/**
 * Nightly canaries.
 *
 * Verification that a property still holds **on a live network**, as opposed to a test asserting
 * that our code agrees with our code. Reports are machine-readable JSON in `docs/status/`, which is
 * the source the published conformance evidence is generated from.
 *
 * @module
 */

export { runDiscoveryLoop, assetCodeFor } from "./discovery-loop.js";
export type { DiscoveryLoopOptions } from "./discovery-loop.js";
export { runRejectionAudit } from "./rejection-audit.js";
export type { RejectionAuditOptions } from "./rejection-audit.js";
export { runSupportedSnapshot, fetchSupported, requireBazaarFacilitator } from "./supported.js";
export { runTimeToDiscoverable, SELLER_SURFACE } from "./time-to-discoverable.js";
export type { TimeToDiscoverableOptions } from "./time-to-discoverable.js";
export type { SupportedSnapshotOptions, SupportedResponse, SupportedKind } from "./supported.js";
export { decodeExtensionResponses, stockBuyer, callFacilitator, reasonOf } from "./payment.js";
export type { BazaarVerdict, StockBuyer } from "./payment.js";
export { CanaryRun, writeReport, toPayload } from "./report.js";
export type { CanaryReport, CanaryStep } from "./report.js";
export { KNOWN_QUERY, PARAMETER_DESCRIPTION, RESOURCE_DESCRIPTION } from "./seller.js";
export { provisionUsdcAccounts, resolveUsdcIssuer } from "./provision.js";
export { NETWORK } from "./testnet.js";
