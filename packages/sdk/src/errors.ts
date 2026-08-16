/**
 * Shared error surface — re-exports `@rail402.dev/errors` verbatim.
 *
 * One machine-readable registry used by the facilitator, the Bazaar and the MCP server. Every
 * rejection carries a code AND a non-null reason. `X402Error`, `ErrorCode`, `createError`,
 * `isErrorCode`, `ERROR_REGISTRY`.
 *
 * @module
 */
export * from "@rail402.dev/errors";
