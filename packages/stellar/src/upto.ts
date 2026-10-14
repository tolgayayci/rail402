import { Address, FeeBumpTransaction, TransactionBuilder, scValToNative, xdr } from "@stellar/stellar-sdk";
import {
  SETTLE_FUNCTION,
  inspectUptoAuthorization,
  termsFromScVal,
  type UptoAuthorization,
  type UptoCode,
  type UptoTerms,
} from "@rail402.dev/upto";
import {
  classifySimulationFailure,
  type HostError,
  type SettlementParties,
} from "@rail402.dev/upto/facilitator";

/**
 * Inspection of x402 `upto` payments on Stellar for Rail402, built on the `@rail402.dev/upto` codec:
 * the payer's authorization in a payload, the settlement recorded in a transaction envelope, and the
 * cause of a failed settlement.
 */

export type UptoInspection =
  | { readonly ok: true; readonly authorization: UptoAuthorization }
  | {
      readonly ok: false;
      readonly code: UptoCode;
      readonly reason: string;
      readonly payer?: string | undefined;
    };

/**
 * Decodes the payer's authorization of an `upto` payload (`payload.payload`) for the settlement
 * contract `contract`, without any network access: one signed entry with address credentials whose
 * root is `contract.settle(terms)`. It names the payer and the nonce, which key the settlement.
 */
export function inspectUptoPayload(body: unknown, contract: string): UptoInspection {
  const authorization =
    typeof body === "object" && body !== null
      ? (body as { authorization?: unknown }).authorization
      : undefined;
  const inspected = inspectUptoAuthorization(authorization, contract);
  if (inspected.ok) return inspected;
  return {
    ok: false,
    code: inspected.rejection.code,
    reason: inspected.rejection.reason,
    payer: inspected.payer,
  };
}

/** The `settle(payer, terms, amount)` invocation of a recorded settlement transaction. */
export interface RecordedUptoSettlement {
  /** The settlement contract. */
  readonly contract: string;
  readonly payer: string;
  readonly terms: UptoTerms;
  readonly amount: bigint;
  /** The payer's authorization entry, exactly as it was submitted. */
  readonly payerEntry: xdr.SorobanAuthorizationEntry | undefined;
}

/**
 * Decodes the settlement a recorded `upto` envelope (fee bump or plain) submits. Returns `undefined`
 * for an envelope that is not a single `settle(payer, terms, amount)` call.
 */
export function recordedUptoSettlement(
  envelopeXdr: string,
  passphrase: string,
): RecordedUptoSettlement | undefined {
  const envelope = TransactionBuilder.fromXDR(envelopeXdr, passphrase);
  const inner = envelope instanceof FeeBumpTransaction ? envelope.innerTransaction : envelope;
  const [operation] = inner.operations;
  if (inner.operations.length !== 1 || operation?.type !== "invokeHostFunction") return undefined;
  if (operation.func.switch() !== xdr.HostFunctionType.hostFunctionTypeInvokeContract()) return undefined;
  const call = operation.func.invokeContract();
  if (call.functionName().toString() !== SETTLE_FUNCTION) return undefined;
  const [payerArg, termsArg, amountArg] = call.args();
  if (payerArg === undefined || termsArg === undefined || amountArg === undefined) return undefined;
  const terms = termsFromScVal(termsArg);
  if (terms === undefined || amountArg.switch() !== xdr.ScValType.scvI128()) return undefined;
  const payer = Address.fromScVal(payerArg).toString();
  const payerEntry = (operation.auth ?? []).find((entry) => credentialAddressOf(entry) === payer);
  return {
    contract: Address.fromScAddress(call.contractAddress()).toString(),
    payer,
    terms,
    amount: scValToNative(amountArg) as bigint,
    payerEntry,
  };
}

/** The address of an entry with address credentials (legacy or V2), otherwise `undefined`. */
export function credentialAddressOf(entry: xdr.SorobanAuthorizationEntry): string | undefined {
  const credentials = entry.credentials();
  switch (credentials.switch()) {
    case xdr.SorobanCredentialsType.sorobanCredentialsAddress():
      return Address.fromScAddress(credentials.address().address()).toString();
    case xdr.SorobanCredentialsType.sorobanCredentialsAddressV2():
      return Address.fromScAddress(credentials.addressV2().address()).toString();
    default:
      return undefined;
  }
}

export interface UptoClassification {
  readonly code: UptoCode;
  /** Specific reason naming the on-chain cause. */
  readonly reason: string;
}

/**
 * Maps the host errors of a failed `upto` settlement, simulated or included, to a stable code. A
 * `G…` payer that does not exist fails authentication on reading its own account entry; that is
 * named as a missing account instead of a bad signature. Everything else is classified by the
 * mechanism, which attributes contract errors to the contract that raised them.
 */
export function classifyUptoFailure(
  errors: readonly HostError[],
  parties: SettlementParties,
  message = "",
): UptoClassification {
  const authFailed = errors.some(
    (e) => e.type === "Auth" && e.message?.includes("failed account authentication") === true,
  );
  const accountMissing = errors.some(
    (e) =>
      e.type === "Storage" &&
      e.code === "MissingValue" &&
      e.message?.includes("non-existing value for account") === true,
  );
  if (authFailed && accountMissing && parties.payer.startsWith("G")) {
    return {
      code: "invalid_upto_stellar_payload_account_missing",
      reason: `The payer account ${parties.payer} does not exist on this network.`,
    };
  }
  return classifySimulationFailure(errors, parties, message);
}
