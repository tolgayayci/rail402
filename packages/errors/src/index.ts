/**
 * Shared machine-readable error registry for the facilitator, Bazaar, and MCP server.
 *
 * Every rejection anywhere in this project carries a machine-readable code AND a non-null
 * human-legible reason. That is a hard acceptance criterion, not a
 * nicety, and it is enforced here rather than by convention.
 *
 * @module
 */

export { ERROR_REGISTRY, ALL_ERROR_CODES, type ErrorCode } from "./registry.js";
export { createError, X402Error, isErrorCode, enrichUpstreamCode } from "./x402Error.js";
export type {
  X402ErrorPayload,
  ErrorDefinition,
  ErrorSurface,
  ErrorProvenance,
} from "./types.js";
