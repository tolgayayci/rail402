/**
 * Library surface for embedding the Bazaar in another process (the facilitator co-deploys it).
 * The standalone service entrypoint is `index.ts`.
 */
export { CatalogStore } from "./catalog/store.js";
export { SignalStore } from "./search/signals.js";
export type {
  SignalsReport,
  SearchRecord,
  ZeroResultQuery,
  ConversionRecord,
} from "./search/signals.js";
export { ingest, type CatalogOutcome, type IngestInput } from "./catalog/ingest.js";
export { createBazaarApp, catalogSettledPayment, previewCataloging, encodeExtensionResponses } from "./app.js";
export { entryKey, toPublic } from "./catalog/types.js";
export type {
  CatalogEntry, CatalogAccepts, PublicResource, QualitySignals,
  DiscoveryFilters, ListResponse, SearchResponse, ResourceType,
} from "./catalog/types.js";
export { Bm25Retriever, type Retriever, type ScoredEntry } from "./search/index.js";
export { computeMetrics, formatMetrics, type Metrics, type Judgment } from "./search/metrics.js";

export { DomainVerifier, accountsFrom, type DomainVerdict } from "./catalog/domain.js";
