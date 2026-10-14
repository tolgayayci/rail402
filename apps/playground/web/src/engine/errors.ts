/**
 * Errors as the page shows them: a registered code, a non-empty reason, whether retrying can help, and
 * sanitized details. Unknown errors become `playground_unexpected_error` with a generic reason: no
 * stack and no message text reach the page.
 */
import { isRail402Error } from "@rail402.dev/errors";
import { isEgressError } from "@rail402.dev/safe-fetch/shared";
import { isPaymentError, sanitizeJson } from "@rail402.dev/sdk/browser";
import { playgroundError, type PlaygroundClientCode } from "../../../src/shared/codes.ts";
import type { JsonValue, RefusalLayer } from "./events.ts";
import type { CodedError } from "./types.ts";

/** Codes of the buyer's spending policy and option choice: refused before anything was signed. */
const POLICY_CODES: ReadonlySet<string> = new Set([
  "payment_cap_required",
  "payment_cap_invalid",
  "payment_policy_invalid",
  "payment_network_not_permitted",
  "payment_asset_not_permitted",
  "payment_scheme_not_permitted",
  "payment_recipient_not_permitted",
  "payment_amount_not_permitted",
  "payment_per_call_cap_exceeded",
  "payment_session_cap_exceeded",
  "payment_session_expired",
  "payment_authorization_window_not_permitted",
  "payment_fees_not_sponsored",
  "payment_facilitator_not_permitted",
  "payment_no_acceptable_option",
  "payment_listing_mismatch",
  "payment_listing_required",
  "payment_insufficient_funds",
  "payment_payer_trustline_missing",
  "payment_recipient_cannot_receive",
  "payment_in_progress",
  "payment_ledger_unavailable",
  "listing_not_payable",
]);

/** Codes of the signing guard: it refused or failed to sign. */
const GUARD_CODES: ReadonlySet<string> = new Set([
  "payment_authorization_rejected",
  "payment_signing_failed",
  "payment_signer_unavailable",
]);

/** Most characters of a detail string. */
const DETAIL_TEXT = 300;

/** A JSON value from sanitized details: bigints as strings, anything unserializable dropped. */
export function toJsonValue(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  try {
    const json = JSON.stringify(sanitizeJson(value, DETAIL_TEXT), (_key, item: unknown) =>
      typeof item === "bigint" ? item.toString() : item,
    ) as string | undefined;
    return json === undefined ? undefined : (JSON.parse(json) as JsonValue);
  } catch {
    return undefined;
  }
}

/**
 * The relay code an egress error carries when the relay refused the request, also once the SDK has
 * wrapped it into a payment error for the call.
 */
function relayCode(error: unknown): string | undefined {
  if (!isEgressError(error) && !(isPaymentError(error) && error.code.startsWith("egress_"))) return undefined;
  const relay = error.details?.["relay"];
  return typeof relay === "string" && relay.startsWith("playground_") ? relay : undefined;
}

/**
 * A coded error the engine rejects with: the `CodedError` fields, as an `Error` so it can be thrown.
 * Its message is the reason; it carries nothing else.
 */
export class EngineError extends Error implements CodedError {
  override readonly name = "EngineError";
  readonly code: string;
  readonly reason: string;
  readonly retryable: boolean;
  readonly details?: JsonValue;

  constructor(coded: CodedError) {
    super(coded.reason);
    this.code = coded.code;
    this.reason = coded.reason;
    this.retryable = coded.retryable;
    if (coded.details !== undefined) this.details = coded.details;
  }

  toJSON(): CodedError {
    return {
      code: this.code,
      reason: this.reason,
      retryable: this.retryable,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

/** Any error as a throwable coded error. */
export function engineError(error: unknown): EngineError {
  return error instanceof EngineError ? error : new EngineError(codedError(error));
}

/** Any error as a coded error. */
export function codedError(error: unknown): CodedError {
  if (error instanceof EngineError) return error.toJSON();
  if (error instanceof DOMException && error.name === "AbortError") {
    return codedError(playgroundError("playground_run_aborted"));
  }
  if (!isRail402Error(error)) return codedError(playgroundError("playground_unexpected_error"));
  const relay = relayCode(error);
  const details: Record<string, unknown> = { ...error.details };
  if (isEgressError(error)) details["stage"] = error.stage;
  if (relay !== undefined) delete details["relay"];
  if (isPaymentError(error)) {
    details["paid"] = error.paid;
    if (error.callId !== undefined) details["callId"] = error.callId;
  }
  const json = Object.keys(details).length === 0 ? undefined : toJsonValue(details);
  return {
    code: relay ?? error.code,
    reason: error.reason,
    retryable: error.retryable,
    ...(json === undefined ? {} : { details: json }),
  };
}

/** A client code as a coded error, optionally with another reason. */
export function clientError(code: PlaygroundClientCode, reason?: string): CodedError {
  return codedError(playgroundError(code, reason === undefined ? undefined : { reason }));
}

/** Which layer refused: the policy, the guard, the relay, the seller, the facilitator or the page. */
export function refusalLayer(error: unknown): RefusalLayer {
  if (relayCode(error) !== undefined || isEgressError(error)) return "relay";
  if (!isRail402Error(error)) return "playground";
  return layerOfCode(error.code, upstreamCode(error));
}

/**
 * The layer a code belongs to. A `payment_rejected` with an upstream `invalid_*` code was refused by
 * the facilitator; any other upstream refusal is the seller's.
 */
export function layerOfCode(code: string, upstream?: string): RefusalLayer {
  if (code.startsWith("egress_") || code.startsWith("playground_relay")) return "relay";
  if (POLICY_CODES.has(code)) return "policy";
  if (GUARD_CODES.has(code)) return "guard";
  if (code === "payment_rejected")
    return upstream?.startsWith("invalid_") === true ? "facilitator" : "seller";
  if (code.startsWith("payment_") || code.startsWith("mcp_")) return "seller";
  if (code.startsWith("invalid_")) return "facilitator";
  return "playground";
}

/** Whether money may have moved with the failed call: `none` and `not_settled` mean it did not. */
export function nothingPaid(error: unknown): boolean {
  if (!isPaymentError(error)) return !isRail402Error(error) || !error.code.startsWith("payment_");
  return error.paid === "none" || error.paid === "not_settled";
}

/** The upstream refusal code a `payment_rejected` error carries (the facilitator's or seller's). */
export function upstreamCode(error: unknown): string | undefined {
  if (!isPaymentError(error) || error.code !== "payment_rejected") return undefined;
  const upstream = error.details?.["upstream"];
  const code =
    typeof upstream === "object" && upstream !== null
      ? (upstream as Record<string, unknown>)["code"]
      : undefined;
  return typeof code === "string" ? code : undefined;
}
