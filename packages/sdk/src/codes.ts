import { Rail402Error, defineCodes, mergeCodes, type ErrorOptions } from "@rail402.dev/errors";
// The codes subpath keeps Node networking modules out of the signing guard's imports.
import { egressCodes } from "@rail402.dev/safe-fetch/codes";
import type { Receipt } from "./flow/receipt.ts";
import { redact, redactDeep } from "./redact.ts";

/**
 * Whether money may have moved when a call failed:
 * - `none`: nothing was signed, or nothing signed left this process towards a seller;
 * - `not_settled`: a signed payment was sent and the seller or facilitator refused it;
 * - `settled`: the payment settled, even though the call itself failed;
 * - `unknown`: a signed payment was sent and the outcome is not known; check the budget before retrying.
 */
export type Paid = "none" | "not_settled" | "settled" | "unknown";

/** Refusals and failures of a buyer's payment flow. */
export const paymentCodes = defineCodes({
  payment_cap_required: {
    status: 400,
    retryable: false,
    reason: "Every payment needs a per-call spending cap (maxAmount).",
  },
  payment_cap_invalid: {
    status: 400,
    retryable: false,
    reason:
      "The spending cap is malformed, has more decimals than its asset, or names an asset outside the spending policy.",
  },
  payment_policy_invalid: {
    status: 400,
    retryable: false,
    reason: "The spending policy or buyer configuration is invalid.",
  },
  payment_request_invalid: {
    status: 400,
    retryable: false,
    reason:
      "The request to pay for is malformed: a header outside the allowlist, a body the method cannot carry, or an invalid path parameter.",
  },
  payment_signer_unavailable: {
    status: 503,
    retryable: false,
    reason: "No signing key is configured, so payments are disabled; search and quotes still work.",
  },
  payment_network_not_permitted: {
    status: 403,
    retryable: false,
    reason: "The payment is for a network other than the one this buyer is configured for.",
  },
  payment_asset_not_permitted: {
    status: 403,
    retryable: false,
    reason: "The payment asset is not in the spending policy, or differs from the cap's asset.",
  },
  payment_scheme_not_permitted: {
    status: 403,
    retryable: false,
    reason: "The payment scheme is not enabled in the spending policy.",
  },
  payment_recipient_not_permitted: {
    status: 403,
    retryable: false,
    reason:
      "The recipient is invalid, is the payer itself, or is excluded by the policy's recipient allow or deny list.",
  },
  payment_amount_not_permitted: {
    status: 403,
    retryable: false,
    reason: "The payment amount must be a positive integer number of base units that fits an i128.",
  },
  payment_per_call_cap_exceeded: {
    status: 402,
    retryable: false,
    reason: "The price is higher than the per-call spending cap.",
  },
  payment_session_cap_exceeded: {
    status: 402,
    retryable: false,
    reason: "Paying would exceed the session budget (spent plus pending plus this payment).",
  },
  payment_session_expired: {
    status: 403,
    retryable: false,
    reason: "The budget session has ended and does not renew; start a new session to pay again.",
  },
  payment_authorization_window_not_permitted: {
    status: 403,
    retryable: false,
    reason: "The authorization would stay valid for longer than the spending policy allows.",
  },
  payment_authorization_rejected: {
    status: 403,
    retryable: false,
    reason: "The signing guard refused the authorization: it does not match the payment this call selected.",
  },
  payment_fees_not_sponsored: {
    status: 402,
    retryable: false,
    reason: "Stellar payments require the seller's facilitator to sponsor fees (areFeesSponsored).",
  },
  payment_facilitator_not_permitted: {
    status: 403,
    retryable: false,
    reason:
      "The upto option's settlement authority (extra.facilitatorAddress) is missing, is the payer or the recipient, or is not among the spending policy's allowed facilitators.",
  },
  payment_requirements_invalid: {
    status: 502,
    retryable: false,
    reason: "The seller's payment requirements are missing, malformed, too large or not x402 version 2.",
  },
  payment_no_acceptable_option: {
    status: 402,
    retryable: false,
    reason: "None of the seller's payment options is acceptable under the spending policy.",
  },
  payment_listing_mismatch: {
    status: 409,
    retryable: false,
    reason: "The live payment requirements do not match the Bazaar listing (recipient or price).",
  },
  payment_listing_required: {
    status: 403,
    retryable: false,
    reason: "The spending policy only pays resources selected from a Bazaar listing.",
  },
  payment_insufficient_funds: {
    status: 402,
    retryable: false,
    reason: "The payer's balance is lower than the price.",
  },
  payment_payer_trustline_missing: {
    status: 402,
    retryable: false,
    reason: "The payer has no authorized trustline for the payment asset.",
  },
  payment_recipient_cannot_receive: {
    status: 402,
    retryable: false,
    reason: "The recipient cannot receive the payment asset (no authorized trustline).",
  },
  payment_simulation_failed: {
    status: 502,
    retryable: true,
    reason: "Building or simulating the payment failed; nothing reached the seller.",
  },
  payment_signing_failed: {
    status: 500,
    retryable: false,
    reason: "The key or wallet failed to sign the authorization; the reserved budget was released.",
  },
  payment_rejected: {
    status: 402,
    retryable: false,
    reason: "The seller or its facilitator refused the signed payment; it did not settle.",
  },
  payment_settlement_unconfirmed: {
    status: 502,
    retryable: false,
    reason:
      "The signed payment was sent but its settlement could not be confirmed; check the budget before retrying.",
  },
  payment_resource_failed: {
    status: 502,
    retryable: false,
    reason: "The payment settled, but the resource answered with an error.",
  },
  payment_redirect_after_payment: {
    status: 502,
    retryable: false,
    reason: "The paid request was answered with a redirect, which is never followed with a payment attached.",
  },
  payment_in_progress: {
    status: 409,
    retryable: true,
    reason: "A call with this idempotency key is still running; wait, then retry to read its result.",
  },
  payment_ledger_unavailable: {
    status: 503,
    retryable: true,
    reason:
      "The budget ledger cannot be opened or stays locked; payments are disabled until it is available.",
  },
});

/** Failures of the Bazaar discovery client. */
export const discoveryClientCodes = defineCodes({
  discovery_unavailable: {
    status: 503,
    retryable: true,
    reason: "The Bazaar is unreachable or failed; retry shortly.",
  },
  discovery_rejected: {
    status: 502,
    retryable: false,
    reason: "The Bazaar refused the request.",
  },
  listing_not_found: { status: 404, retryable: false, reason: "No listing has this id." },
  listing_not_payable: {
    status: 409,
    retryable: false,
    reason:
      "The listing cannot be paid: it is not published, below the required trust, not callable, or has no option on this network.",
  },
});

/** Failures specific to paid MCP tool calls. */
export const mcpTargetCodes = defineCodes({
  mcp_endpoint_unresolvable: {
    status: 400,
    retryable: false,
    reason: "The MCP endpoint is not an http(s) URL, so it cannot be called.",
  },
  mcp_tool_not_found: { status: 404, retryable: false, reason: "The seller's MCP server has no such tool." },
  mcp_protocol_error: {
    status: 502,
    retryable: true,
    reason: "The seller's MCP server failed at the transport or protocol level before any payment.",
  },
  mcp_input_required_unsupported: {
    status: 501,
    retryable: false,
    reason: "The seller's tool asked for interactive input, which paid calls do not support.",
  },
});

/** Failures reading the Stellar network. */
export const networkCodes = defineCodes({
  rpc_unavailable: {
    status: 503,
    retryable: true,
    reason: "The Stellar RPC is unreachable or failed; retry shortly.",
  },
  transaction_hash_invalid: {
    status: 400,
    retryable: false,
    reason: "A transaction hash is 64 hexadecimal characters.",
  },
  transaction_not_found: {
    status: 404,
    retryable: false,
    reason: "The RPC has no such transaction within its retention window.",
  },
});

/** Key handling. Reasons never contain key material. */
export const keyCodes = defineCodes({
  key_not_found: { status: 400, retryable: false, reason: "No signing key was found at the given location." },
  key_invalid: {
    status: 400,
    retryable: false,
    reason: "The signing key is not a valid Stellar secret seed.",
  },
  key_file_insecure: {
    status: 400,
    retryable: false,
    reason: "The key file is readable by other users; restrict it to its owner (chmod 600).",
  },
  key_exists: {
    status: 409,
    retryable: false,
    reason: "A key already exists at this location; it is never overwritten.",
  },
});

/** Account onboarding. */
export const accountCodes = defineCodes({
  account_not_found: {
    status: 404,
    retryable: false,
    reason: "The account does not exist on this network; fund it first.",
  },
  account_friendbot_failed: {
    status: 502,
    retryable: true,
    reason: "Friendbot did not fund the account; retry shortly.",
  },
  account_trustline_failed: {
    status: 502,
    retryable: false,
    reason: "Adding the trustline failed.",
  },
  account_funding_failed: {
    status: 502,
    retryable: false,
    reason: "Buying the asset with XLM on the network's exchange failed; nothing else changed.",
  },
});

/** Every code the SDK can raise, including the egress codes of @rail402.dev/safe-fetch. */
export const agentCodes = mergeCodes(
  egressCodes,
  paymentCodes,
  discoveryClientCodes,
  mcpTargetCodes,
  networkCodes,
  keyCodes,
  accountCodes,
);

export type AgentCode = keyof typeof agentCodes;

/**
 * The `paid` value each code carries unless the error states otherwise. A refusal before signing is
 * `none`; codes raised after a signed payment was sent say what is known about the money.
 */
export const defaultPaid: Readonly<Record<AgentCode, Paid>> = Object.freeze(
  Object.fromEntries(Object.keys(agentCodes).map((code) => [code, defaultPaidOf(code)])) as Record<
    AgentCode,
    Paid
  >,
);

function defaultPaidOf(code: string): Paid {
  switch (code) {
    case "payment_rejected":
      return "not_settled";
    case "payment_resource_failed":
      return "settled";
    case "payment_settlement_unconfirmed":
    case "payment_redirect_after_payment":
    case "payment_in_progress":
      return "unknown";
    default:
      return "none";
  }
}

export function isAgentCode(value: unknown): value is AgentCode {
  return typeof value === "string" && Object.hasOwn(agentCodes, value);
}

export interface PaymentErrorOptions extends ErrorOptions {
  /** Overrides the code's default `paid`. */
  readonly paid?: Paid | undefined;
  readonly callId?: string | undefined;
  readonly receipt?: Receipt | undefined;
}

/**
 * An SDK failure: a registered code, a non-empty reason, whether retrying can help, and whether money
 * may have moved. Reasons and detail strings are redacted, so an upstream message that quoted a
 * secret or signed XDR never reaches the caller.
 */
export class PaymentError extends Rail402Error<AgentCode> {
  readonly paid: Paid;
  readonly callId: string | undefined;
  readonly receipt: Receipt | undefined;

  constructor(code: AgentCode, options: PaymentErrorOptions = {}) {
    super(code, agentCodes[code], {
      reason: options.reason === undefined ? undefined : redact(options.reason),
      details: options.details === undefined ? undefined : redactDeep(options.details),
      cause: options.cause,
    });
    this.paid = options.paid ?? defaultPaid[code];
    this.callId = options.callId;
    this.receipt = options.receipt;
  }
}

export function paymentError(code: AgentCode, options?: PaymentErrorOptions): PaymentError {
  return new PaymentError(code, options);
}

export function isPaymentError(value: unknown): value is PaymentError {
  return value instanceof PaymentError;
}
