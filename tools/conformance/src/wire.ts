/**
 * Wire assertions for a paid request that crossed a recording forwarder (forwarder.ts): what the buyer
 * signed is what the seller forwarded to `/verify` and `/settle`, byte for byte, in the shape the
 * Stellar scheme defines — `{ transaction }` for `exact`, `{ authorization }` for `upto` — and the
 * seller's `PAYMENT-RESPONSE` reports the settlement.
 */
import { Address, xdr } from "@stellar/stellar-sdk";
import { decodePaymentResponseHeader, decodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, SettleResponse } from "@x402/core/types";
import { decodeBase64Json, exchangesFor, type Exchange } from "./forwarder.ts";

export class WireError extends Error {
  override readonly name = "WireError";
}

function require(condition: boolean, message: string): asserts condition {
  if (!condition) throw new WireError(message);
}

export interface WireCapture {
  /** The `PAYMENT-SIGNATURE` header the buyer sent to the seller. */
  readonly paymentSignature: string | undefined;
  /** The seller's `PAYMENT-RESPONSE` header to the buyer. */
  readonly paymentResponse: string | null;
  /** What crossed the forwarder between the seller and the facilitator. */
  readonly exchanges: readonly Exchange[];
}

/** The one key each scheme's payload carries: the signed transaction, or the signed authorization entry. */
const PAYLOAD_KEY = { exact: "transaction", upto: "authorization" } as const;

export type WireScheme = keyof typeof PAYLOAD_KEY;

export interface WireFacts {
  readonly scheme: WireScheme;
  readonly payload: PaymentPayload;
  /**
   * What the buyer signed, as sent: the transaction envelope (`exact`) or the authorization entry
   * (`upto`), base64 XDR.
   */
  readonly signed: string;
  /** The amount the seller asked `/settle` to settle: the price for `exact`, the charge for `upto`. */
  readonly settledAmount: string;
  readonly settlement: SettleResponse;
  readonly verifyStatus: number;
  readonly settleStatus: number;
  /** The facilitator's `EXTENSION-RESPONSES` on `/settle`, decoded; absent when it sent none. */
  readonly extensionResponses?: unknown;
}

/**
 * Checks one paid request's wire traffic:
 * - the decoded `PAYMENT-SIGNATURE` carries `payload: { transaction }` (`exact`) or
 *   `payload: { authorization }` (`upto`) and nothing else;
 * - the transaction is a v1 envelope with exactly one `invokeHostFunction` operation; the
 *   authorization is one address-credential Soroban authorization entry;
 * - the `/verify` and `/settle` bodies the seller sent carry that value byte-equal, in the same
 *   one-key payload, and both were answered 200;
 * - `PAYMENT-RESPONSE` decodes to the settlement `/settle` answered.
 */
export function checkWire(capture: WireCapture, scheme: WireScheme = "exact"): WireFacts {
  const key = PAYLOAD_KEY[scheme];
  require(capture.paymentSignature !== undefined, "the buyer sent no PAYMENT-SIGNATURE header");
  const payload = decodePaymentSignatureHeader(capture.paymentSignature);
  require(payload.accepted.scheme === scheme, `the buyer paid ${payload.accepted.scheme}, not ${scheme}`);
  const inner = payload.payload;
  require(JSON.stringify(Object.keys(inner)) ===
    JSON.stringify([key]), `payload keys are ${JSON.stringify(Object.keys(inner))}, not ["${key}"]`);
  const signed = inner[key];
  require(typeof signed === "string" && signed !== "", `payload.${key} is not a string`);
  if (scheme === "exact") checkEnvelope(signed);
  else checkAuthorizationEntry(signed);

  const forwarded = (path: string) => {
    const [exchange, ...more] = exchangesFor(capture.exchanges, path);
    require(exchange !== undefined, `the seller never called ${path}`);
    require(more.length === 0, `the seller called ${path} ${String(more.length + 1)} times`);
    require(exchange.status === 200, `${path} answered HTTP ${String(exchange.status)}`);
    const body = exchange.requestBody as
      { paymentPayload?: { payload?: Record<string, unknown> } } | undefined;
    const sent = body?.paymentPayload?.payload;
    require(sent !== undefined, `${path}: the request carries no paymentPayload.payload`);
    require(JSON.stringify(Object.keys(sent)) ===
      JSON.stringify([key]), `${path}: forwarded payload keys are ${JSON.stringify(Object.keys(sent))}`);
    require(sent[key] === signed, `${path}: the forwarded ${key} differs from the signed one`);
    return exchange;
  };
  const verify = forwarded("/verify");
  const settle = forwarded("/settle");

  require(capture.paymentResponse !== null, "the seller sent no PAYMENT-RESPONSE header");
  const settlement = decodePaymentResponseHeader(capture.paymentResponse);
  const answered = settle.responseBody as Partial<SettleResponse>;
  require(settlement.success, `PAYMENT-RESPONSE reports a failure: ${JSON.stringify(settlement)}`);
  require(answered.success === true &&
    answered.transaction === settlement.transaction &&
    answered.network === settlement.network &&
    answered.payer === settlement.payer, "PAYMENT-RESPONSE does not match the facilitator's /settle answer");
  const extensionResponses = decodeBase64Json(settle.responseHeaders["extension-responses"]);
  const settledAmount = (settle.requestBody as { paymentRequirements?: { amount?: unknown } } | undefined)
    ?.paymentRequirements?.amount;
  require(typeof settledAmount === "string", "/settle: the request carries no paymentRequirements.amount");
  return {
    scheme,
    payload,
    signed,
    settledAmount,
    settlement,
    verifyStatus: verify.status,
    settleStatus: settle.status,
    ...(extensionResponses === undefined ? {} : { extensionResponses }),
  };
}

/** Throws unless `transaction` is a v1 envelope with exactly one `invokeHostFunction` operation. */
export function checkEnvelope(transaction: string): void {
  let envelope: xdr.TransactionEnvelope;
  try {
    envelope = xdr.TransactionEnvelope.fromXDR(transaction, "base64");
  } catch {
    throw new WireError("payload.transaction is not a transaction envelope");
  }
  require(envelope.switch() ===
    xdr.EnvelopeType.envelopeTypeTx(), "payload.transaction is not a v1 envelope");
  const operations = envelope.v1().tx().operations();
  require(operations.length === 1 &&
    operations[0]?.body().switch() ===
      xdr.OperationType.invokeHostFunction(), "payload.transaction is not a single invokeHostFunction operation");
}

/** Throws unless `authorization` is one Soroban authorization entry with address credentials. */
export function checkAuthorizationEntry(authorization: string): void {
  let entry: xdr.SorobanAuthorizationEntry;
  try {
    entry = xdr.SorobanAuthorizationEntry.fromXDR(authorization, "base64");
  } catch {
    throw new WireError("payload.authorization is not a Soroban authorization entry");
  }
  const kind = entry.credentials().switch();
  require(kind === xdr.SorobanCredentialsType.sorobanCredentialsAddress() ||
    kind ===
      xdr.SorobanCredentialsType.sorobanCredentialsAddressV2(), "payload.authorization does not carry address credentials");
}

/**
 * The address-credential authorization entries of `address` in an envelope (fee bump unwrapped), as
 * base64 XDR, so a settled transaction's entry can be compared byte for byte with the signed one.
 */
export function authorizationEntries(envelope: xdr.TransactionEnvelope, address: string): string[] {
  const operations =
    envelope.switch() === xdr.EnvelopeType.envelopeTypeTxFeeBump()
      ? envelope.feeBump().tx().innerTx().v1().tx().operations()
      : envelope.v1().tx().operations();
  const entries: string[] = [];
  for (const operation of operations) {
    if (operation.body().switch() !== xdr.OperationType.invokeHostFunction()) continue;
    for (const entry of operation.body().invokeHostFunctionOp().auth()) {
      const credentials = entry.credentials();
      const kind = credentials.switch();
      const addressCredentials =
        kind === xdr.SorobanCredentialsType.sorobanCredentialsAddress()
          ? credentials.address()
          : kind === xdr.SorobanCredentialsType.sorobanCredentialsAddressV2()
            ? credentials.addressV2()
            : undefined;
      if (addressCredentials === undefined) continue;
      if (Address.fromScAddress(addressCredentials.address()).toString() === address) {
        entries.push(entry.toXDR("base64"));
      }
    }
  }
  return entries;
}
