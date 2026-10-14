import { Rail402Error, defineCodes, type ErrorOptions } from "@rail402.dev/errors";

/**
 * Codes of the seller helpers. The first group is thrown while a route or tool is declared, so a
 * listing the Bazaar would reject never reaches production. The second group are findings that
 * `validateListing` and `checkSellerOrigin` report; they are never thrown.
 */
export const sellerCodes = defineCodes({
  seller_param_description_required: {
    status: 400,
    retryable: false,
    reason: "Every parameter, at any depth, needs a description of 1-300 characters.",
  },
  seller_declaration_invalid: {
    status: 400,
    retryable: false,
    reason:
      "The route or tool declaration is invalid: a parameter, example, output, path, description or payment option is malformed.",
  },
  seller_price_invalid: {
    status: 400,
    retryable: false,
    reason:
      "The price is malformed, not positive, has more decimals than its asset, or names a custom asset without its decimals.",
  },
  seller_network_unsupported: {
    status: 400,
    retryable: false,
    reason: 'The network must be "stellar:testnet" or "stellar:pubnet".',
  },
  seller_endpoint_invalid: {
    status: 400,
    retryable: false,
    reason:
      "The MCP endpoint must be an absolute https URL (http is accepted on testnet only) without credentials or a fragment.",
  },
  seller_asset_unreadable: {
    status: 502,
    retryable: true,
    reason:
      "The asset's decimals could not be read from the network: it is not a readable token, or the RPC failed.",
  },
  seller_settlement_repeat: {
    status: 409,
    retryable: false,
    reason:
      "This payment was already settled and served once; a repeated payment signature is not served again.",
  },
  seller_asset_not_receivable: {
    status: 400,
    retryable: false,
    reason: "payTo cannot receive the payment asset now: it has no authorized trustline for it.",
  },
  seller_facilitator_unsupported: {
    status: 400,
    retryable: false,
    reason:
      "The facilitator does not advertise this scheme and network with sponsored fees, or does not support the bazaar extension.",
  },
  seller_origin_unreachable: {
    status: 502,
    retryable: true,
    reason: "The resource could not be reached for an unpaid request.",
  },
  seller_origin_not_payment_required: {
    status: 400,
    retryable: false,
    reason: "The resource did not answer an unpaid request with an x402 version 2 payment requirement.",
  },
  seller_discovery_missing: {
    status: 400,
    retryable: false,
    reason:
      "The payment requirement declares no bazaar discovery extension, so its settlements are not cataloged.",
  },
  seller_param_description_missing: {
    status: 400,
    retryable: false,
    reason: "A parameter in the discovery metadata has no description, so agents cannot tell what to send.",
  },
  seller_output_example_missing: {
    status: 400,
    retryable: false,
    reason: "The discovery metadata has no output example, so agents cannot tell what they will receive.",
  },
});

export type SellerCode = keyof typeof sellerCodes;

/** A seller helper refused a declaration or could not complete a check. */
export class SellerError extends Rail402Error<SellerCode> {
  constructor(code: SellerCode, options: ErrorOptions = {}) {
    super(code, sellerCodes[code], options);
  }
}

export function sellerError(
  code: SellerCode,
  reason?: string,
  details?: Record<string, unknown>,
): SellerError {
  return new SellerError(code, {
    ...(reason === undefined ? {} : { reason }),
    ...(details === undefined ? {} : { details }),
  });
}

export function isSellerError(value: unknown): value is SellerError {
  return value instanceof SellerError;
}
