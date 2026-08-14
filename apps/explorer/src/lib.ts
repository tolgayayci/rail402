/**
 * Programmatic surface of the explorer, for tests, tooling and embedding.
 * The runnable server lives in `./index.js` (the package's `./server` export).
 */

export { createExplorerApp, toDecimal, assetCode } from "./app.js";
export { loadConfig, describeConfig } from "./config.js";
export type { ExplorerConfig, ExplorerNetworkConfig } from "./config.js";
export { ExplorerStore } from "./db.js";
export type { FeedFilter, FeedPage, ExplorerStats, AssetTotal } from "./db.js";
export { classifyTransaction, parseEventData } from "./classify.js";
export type { ClassificationContext, ClassifiedPayment } from "./classify.js";
export { IngestWorker } from "./ingest.js";
export type { IngestCounters, NetworkIngestHealth } from "./ingest.js";
export { createBazaarEnricher } from "./enrich.js";
export type { Enricher } from "./enrich.js";
export { FacilitatorRegistry, parseSupported, slugForUrl } from "./registry.js";
export { HorizonBackfill } from "./horizon.js";
export { adaptHorizonRecord } from "./xdr-adapter.js";
export type { HorizonTxRecord } from "./xdr-adapter.js";
export { rpcCall } from "./rpc.js";
export type {
  PaymentRow,
  FacilitatorRow,
  SellerMeta,
  CursorState,
  Scheme,
  Confidence,
} from "./types.js";
