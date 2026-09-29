import { Address, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { ExactStellarCode } from "./codes.ts";

/** A host error recorded as a diagnostic event: `topics = ["error", ScError]`, `data = message [, args…]`. */
export interface HostError {
  /** Contract that raised the error, when the event is contract-scoped. */
  readonly contract: string | undefined;
  /** Error type as the host names it: Contract, Auth, Crypto, Budget, Storage, Value, … */
  readonly type: string;
  /** Contract error number (e.g. 13) for Contract errors, otherwise the ScErrorCode name (e.g. ExistingValue). */
  readonly code: number | string;
  readonly message: string | undefined;
  readonly args: readonly unknown[];
}

/** Extracts the host errors from simulation or transaction diagnostic events, oldest first. */
export function hostErrors(events: readonly xdr.DiagnosticEvent[]): HostError[] {
  const errors: HostError[] = [];
  for (const diagnostic of events) {
    try {
      const event = diagnostic.event();
      const body = event.body().v0();
      const [topic, errorTopic] = body.topics();
      if (topic?.switch() !== xdr.ScValType.scvSymbol() || topic.sym().toString() !== "error") continue;
      if (errorTopic?.switch() !== xdr.ScValType.scvError()) continue;

      const scError = errorTopic.error();
      const type = scError.switch().name.replace(/^sce/, "");
      const code =
        scError.switch() === xdr.ScErrorType.sceContract()
          ? scError.contractCode()
          : scError.code().name.replace(/^scec/, "");

      const data = body.data();
      let message: string | undefined;
      let args: unknown[] = [];
      if (data.switch() === xdr.ScValType.scvVec()) {
        const [first, ...restArgs] = data.vec() ?? [];
        message = first?.switch() === xdr.ScValType.scvString() ? first.str().toString() : undefined;
        args = restArgs.map(safeNative);
      } else if (data.switch() === xdr.ScValType.scvString()) {
        message = data.str().toString();
      }

      const contractId = event.contractId();
      errors.push({
        contract: contractId
          ? Address.fromScAddress(xdr.ScAddress.scAddressTypeContract(contractId)).toString()
          : undefined,
        type,
        code,
        message,
        args,
      });
    } catch {
      // A malformed or unfamiliar event carries no classification signal.
    }
  }
  return errors;
}

export interface TransferContext {
  readonly asset: string;
  readonly from: string;
  readonly to: string;
}

export interface Classification {
  readonly code: ExactStellarCode;
  /** Specific reason naming the on-chain cause. */
  readonly reason: string;
}

/**
 * Maps the host errors of a failed simulation of `transfer(from, to, amount)` to a stable code.
 * Error numbers for the Stellar Asset Contract come from soroban-env-host `contract_error.rs`;
 * messages and structure were captured from protocol 28 simulations.
 */
export function classifyTransferFailure(
  errors: readonly HostError[],
  context: TransferContext,
): Classification {
  // Signature failures surface as Crypto errors beneath the Auth error.
  if (errors.some((e) => e.type === "Crypto")) {
    return {
      code: "invalid_exact_stellar_payload_invalid_signature",
      reason: "The payer's authorization signature failed verification for this transfer.",
    };
  }

  for (const error of errors) {
    if (error.type === "Auth" && error.code === "ExistingValue") {
      return {
        code: "invalid_exact_stellar_payload_nonce_already_used",
        reason: "This authorization's nonce has already been consumed on-chain.",
      };
    }
    if (error.type === "Auth" && error.message?.includes("expired") === true) {
      return {
        code: "invalid_exact_stellar_signature_expired",
        reason: "The payer's authorization has expired on-chain; sign a new payment.",
      };
    }
  }

  // A C-account payer rejecting inside __check_auth raises a contract error from its own address.
  const fromContract = errors.find((e) => e.type === "Contract" && e.contract === context.from);
  if (fromContract !== undefined) {
    return {
      code: "invalid_exact_stellar_payload_smart_account_rejected",
      reason: `The payer's smart account rejected the authorization with contract error #${String(fromContract.code)}.`,
    };
  }

  const assetError = errors.find((e) => e.type === "Contract" && e.contract === context.asset);
  if (assetError !== undefined) {
    const subject = typeof assetError.args[0] === "string" ? assetError.args[0] : undefined;
    switch (assetError.code) {
      case 13:
        return subject === context.to
          ? {
              code: "invalid_exact_stellar_payload_recipient_trustline_missing",
              reason: `payTo ${context.to} has no trustline for this asset and cannot receive it.`,
            }
          : {
              code: "invalid_exact_stellar_payload_payer_trustline_missing",
              reason: `The payer ${context.from} has no trustline for this asset.`,
            };
      case 10:
        return {
          code: "insufficient_funds",
          reason:
            "The transfer would take a balance outside its allowed range (insufficient funds or limit exceeded).",
        };
      case 6:
        return {
          code: "invalid_exact_stellar_payload_account_missing",
          reason: `Account ${subject ?? "in the transfer"} does not exist on this network.`,
        };
      case 11:
        return {
          code: "invalid_exact_stellar_payload_trustline_not_authorized",
          reason: `The trustline of ${subject ?? "an account in the transfer"} is not authorized by the asset issuer.`,
        };
      default:
        break;
    }
  }

  const unauthorized = errors.find((e) => e.type === "Auth" && e.code === "InvalidAction");
  if (unauthorized !== undefined) {
    if (unauthorized.message?.includes("failed account authentication") === true) {
      return {
        code: context.from.startsWith("C")
          ? "invalid_exact_stellar_payload_smart_account_rejected"
          : "invalid_exact_stellar_payload_invalid_signature",
        reason: "The payer's account rejected the authorization.",
      };
    }
    return {
      code: "invalid_exact_stellar_payload_unauthorized_invocation",
      reason: "The transfer performed differs from what the payer's authorization covers.",
    };
  }

  const first = errors[0];
  return {
    code: "invalid_exact_stellar_payload_simulation_failed",
    reason:
      first === undefined
        ? "Simulating the payment failed without a host error."
        : `Simulating the payment failed with Error(${first.type}, ${String(first.code)})${
            first.message === undefined ? "" : `: ${first.message}`
          }.`,
  };
}

function safeNative(value: xdr.ScVal): unknown {
  try {
    return scValToNative(value);
  } catch {
    return undefined;
  }
}
