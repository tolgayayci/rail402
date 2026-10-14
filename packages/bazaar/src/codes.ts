import { defineCodes, errorFactory } from "@rail402.dev/errors";

/**
 * Cataloging outcomes, reported to the seller through the `EXTENSION-RESPONSES` sidechannel under the
 * `bazaar` key, and discovery API errors. A cataloging rejection never affects the payment itself.
 */
export const bazaarCodes = defineCodes({
  // --- cataloging: rejections (status "rejected") ------------------------------------------------
  bazaar_extension_malformed: {
    status: 400,
    retryable: false,
    reason: "The bazaar extension must be an object with `info` and `schema`.",
  },
  bazaar_schema_invalid: {
    status: 400,
    retryable: false,
    reason: "The bazaar `schema` is not a valid JSON Schema (Draft 2020-12).",
  },
  bazaar_schema_external_reference: {
    status: 400,
    retryable: false,
    reason:
      "The bazaar `schema` uses an external $ref or $id; only same-document references (#…) are allowed.",
  },
  bazaar_schema_too_large: {
    status: 400,
    retryable: false,
    reason: "The bazaar `schema` or `info` exceeds the size or nesting limit.",
  },
  bazaar_schema_timeout: {
    status: 400,
    retryable: false,
    reason: "Validating `info` against the bazaar `schema` exceeded the time budget.",
  },
  bazaar_info_invalid: {
    status: 400,
    retryable: false,
    reason: "The bazaar `info` does not satisfy its `schema`.",
  },
  bazaar_info_unsupported: {
    status: 400,
    retryable: false,
    reason: "The bazaar `info.input` is not a valid HTTP or MCP discovery description.",
  },
  bazaar_resource_invalid: {
    status: 400,
    retryable: false,
    reason: "The payment's resource URL is missing or not a valid absolute URL.",
  },
  bazaar_resource_unsafe: {
    status: 400,
    retryable: false,
    reason: "The resource URL points to a private, loopback or otherwise non-public host.",
  },
  bazaar_owner_conflict: {
    status: 409,
    retryable: false,
    reason: "This resource is cataloged for a different payTo; only the listing's owner can update it.",
  },
  bazaar_self_payment: {
    status: 400,
    retryable: false,
    reason: "The payer and payTo are the same account; self-payments do not catalog resources.",
  },
  bazaar_settlement_offchain: {
    status: 400,
    retryable: false,
    reason:
      "The payment settled without a transaction (an off-chain zero `upto` settlement); only on-chain settlements catalog resources.",
  },
  bazaar_settlement_zero: {
    status: 400,
    retryable: false,
    reason: "The payment settled an amount of zero; only settlements that move value catalog resources.",
  },
  bazaar_settlement_reused: {
    status: 409,
    retryable: false,
    reason: "This settlement already cataloged another resource; one payment catalogs at most one resource.",
  },
  bazaar_unsupported_version: {
    status: 400,
    retryable: false,
    reason: "Only x402 version 2 payments are cataloged.",
  },
  bazaar_rate_limited: {
    status: 429,
    retryable: true,
    reason:
      "This payTo has created too many new listings recently; the resource will be cataloged on a later settlement.",
  },
  bazaar_catalog_unavailable: {
    status: 503,
    retryable: true,
    reason: "The catalog could not record this resource right now; a later settlement will catalog it.",
  },

  // --- discovery API ----------------------------------------------------------------------------
  discovery_invalid_parameter: {
    status: 400,
    retryable: false,
    reason: "A discovery query parameter is malformed.",
  },
  discovery_listing_not_found: {
    status: 404,
    retryable: false,
    reason: "No listing has this identifier.",
  },
});

export type BazaarCode = keyof typeof bazaarCodes;

export const bazaarError = errorFactory(bazaarCodes);

/** Codes carried in a successful or pending cataloging outcome. */
export const catalogResultCodes = [
  /** A new MCP tool listing under an `mcp://` URL, which has no origin to check, was published. */
  "cataloged",
  /** The listing already existed; the settlement was recorded against it. */
  "recorded",
  /** Verified at /verify, or still being checked; the resource is cataloged once the payment settles. */
  "awaiting_settlement",
  /** At /settle: the payment settled and cataloging continues in the background. */
  "cataloging_in_progress",
  /**
   * Recorded; a new HTTP or MCP listing, or a change to one, is published once the resource's own 402
   * response (an MCP tool's unpaid call) confirms it.
   */
  "awaiting_origin_verification",
] as const;

export type CatalogResultCode = (typeof catalogResultCodes)[number];

/** Codes of the catalog's background work, reported to its observer only (never on the wire). */
export const catalogBackgroundCodes = [
  /** The resource's own 402 confirmed the listing (published, updated or unchanged). */
  "origin_confirmed",
  /** The resource no longer sells what is listed: the listing was quarantined. */
  "origin_withdrawn",
  /** The resource could not be reached; the check is retried later. */
  "origin_retry",
  /** A listing's Stellar facts were read again. */
  "facts_refreshed",
  /** A listing's Stellar facts could not be read; it keeps its old facts and is tried again. */
  "facts_unavailable",
] as const;

export type CatalogBackgroundCode = (typeof catalogBackgroundCodes)[number];

/** Why an origin check quarantined a listing; recorded on the listing's `quarantine` version. */
export const quarantineReasons = [
  /** The resource could not be reached through every retry. */
  "origin_unreachable",
  /** The resource answered without asking for payment: an HTTP status other than 402, or a tool result. */
  "origin_not_payment_required",
  /** The MCP server does not declare the tool in `tools/list`. */
  "origin_tool_not_listed",
  /** The resource's payment options do not pay the listing's owner. */
  "origin_owner_mismatch",
  /** The resource no longer declares a valid bazaar extension for this resource or tool. */
  "origin_metadata_mismatch",
  /**
   * The MCP tool does not offer the payment that created or changed its listing: no option with the
   * settled scheme, network, asset, payTo and price (the cap, for upto).
   */
  "origin_payment_mismatch",
] as const;

export type QuarantineReason = (typeof quarantineReasons)[number];
