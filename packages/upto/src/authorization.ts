import { Address, xdr } from "@stellar/stellar-sdk";
import {
  CHECK_AUTH_FUNCTION,
  MAX_AUTHORIZATION_BASE64_LENGTH,
  MAX_SIGNER_AUTHORIZATIONS,
  SETTLE_FUNCTION,
} from "./constants.ts";
import { reject, type UptoRejection } from "./errors.ts";
import { isContractAddress } from "./shared.ts";
import {
  accountOrContractOf,
  approveInvocation,
  decodeAuthorizationEntry,
  termsFromScVal,
  type UptoCredential,
  type UptoTerms,
} from "./terms.ts";

/** The decoded payer authorization of an `upto` payload. */
export interface UptoAuthorization {
  readonly entry: xdr.SorobanAuthorizationEntry;
  /** The payer (`G…` or `C…`): the entry's credential address. */
  readonly payer: string;
  readonly credential: UptoCredential;
  readonly nonce: bigint;
  /** Inclusive last ledger of the signature. */
  readonly signatureExpirationLedger: number;
  /** The signed terms, the root invocation's only argument. */
  readonly terms: UptoTerms;
  /**
   * Whether the tree has exactly one child, XDR-equal to
   * `terms.token.approve(payer, contract, terms.maxAmount, terms.expirationLedger)`, without children.
   */
  readonly treeValid: boolean;
}

export type InspectResult =
  | { readonly ok: true; readonly authorization: UptoAuthorization }
  | { readonly ok: false; readonly rejection: UptoRejection; readonly payer?: string };

/**
 * Decodes and structurally checks a payer authorization for the settlement contract `contract`:
 * size, a single canonical XDR entry, address credentials of a `G…`/`C…` payer, a signature, and a
 * root `contract.settle(terms)` whose one argument is a strictly encoded `UptoTerms`. It does not
 * compare the terms with any requirements, and does not verify the signature, which only the
 * network can do for contract accounts.
 *
 * @param base64 - `payload.authorization`
 * @param contract - The network's settlement contract
 * @returns The decoded authorization, or a refusal
 */
export function inspectUptoAuthorization(base64: unknown, contract: string): InspectResult {
  if (typeof base64 !== "string" || base64 === "") {
    return { ok: false, rejection: reject("invalid_upto_stellar_payload_malformed") };
  }
  if (base64.length > MAX_AUTHORIZATION_BASE64_LENGTH) {
    return {
      ok: false,
      rejection: reject(
        "invalid_upto_stellar_payload_too_large",
        `payload.authorization is ${base64.length} base64 characters; the limit is ${MAX_AUTHORIZATION_BASE64_LENGTH}.`,
      ),
    };
  }
  let entry: xdr.SorobanAuthorizationEntry;
  try {
    entry = decodeAuthorizationEntry(base64);
  } catch {
    return { ok: false, rejection: reject("invalid_upto_stellar_payload_malformed") };
  }

  const credential = credentialOf(entry.credentials());
  if (credential === undefined) {
    return {
      ok: false,
      rejection: reject(
        "invalid_upto_stellar_payload_unsupported_credential_type",
        `The payer's entry uses ${entry.credentials().switch().name} credentials; only address and address V2 credentials are accepted.`,
      ),
    };
  }
  const credentials = addressCredentialsOf(entry.credentials());
  const payer = accountOrContractOf(xdr.ScVal.scvAddress(credentials.address()));
  if (payer === undefined) {
    return {
      ok: false,
      rejection: reject(
        "invalid_upto_stellar_payload_unsupported_credential_type",
        "The payer must be an account (G…) or contract (C…) address.",
      ),
    };
  }
  if (!isSigned(credentials.signature())) {
    return { ok: false, payer, rejection: reject("invalid_upto_stellar_payload_missing_payer_signature") };
  }

  const root = entry.rootInvocation().function();
  if (root.switch() !== xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn()) {
    return {
      ok: false,
      payer,
      rejection: reject(
        "invalid_upto_stellar_payload_wrong_function",
        "The authorization's root must be a contract function call, not a contract creation.",
      ),
    };
  }
  const call = root.contractFn();
  const rootContract = Address.fromScAddress(call.contractAddress()).toString();
  if (rootContract !== contract) {
    return {
      ok: false,
      payer,
      rejection: reject(
        "invalid_upto_stellar_payload_wrong_contract",
        `The authorization is for contract ${rootContract}; this network's upto settlement contract is ${contract}.`,
      ),
    };
  }
  const functionName = call.functionName().toString();
  if (functionName !== SETTLE_FUNCTION || call.args().length !== 1) {
    return {
      ok: false,
      payer,
      rejection: reject(
        "invalid_upto_stellar_payload_wrong_function",
        `The authorization is for ${functionName} with ${call.args().length} argument(s); expected settle(terms).`,
      ),
    };
  }
  const [argument] = call.args();
  const terms = argument === undefined ? undefined : termsFromScVal(argument);
  if (terms === undefined)
    return { ok: false, payer, rejection: reject("invalid_upto_stellar_payload_invalid_terms") };

  return {
    ok: true,
    authorization: {
      entry,
      payer,
      credential,
      nonce: credentials.nonce().toBigInt(),
      signatureExpirationLedger: credentials.signatureExpirationLedger(),
      terms,
      treeValid: treeIsValid(entry.rootInvocation(), contract, payer, terms),
    },
  };
}

/**
 * Checks `signerAuthorizations`: at most four signed entries with address credentials of addresses
 * other than the payer and the facilitator's, each authorizing only
 * `ContractFn{payer, "__check_auth", …}` without children. Requires a contract-account payer.
 *
 * @param value - `payload.signerAuthorizations`
 * @param payer - The payer
 * @param facilitatorAddresses - Every facilitator-controlled address
 * @returns The decoded entries, or a refusal
 */
export function inspectSignerAuthorizations(
  value: unknown,
  payer: string,
  facilitatorAddresses: ReadonlySet<string>,
):
  | { readonly ok: true; readonly entries: xdr.SorobanAuthorizationEntry[] }
  | { readonly ok: false; readonly rejection: UptoRejection } {
  if (value === undefined) return { ok: true, entries: [] };
  const invalid = (reason: string) =>
    ({
      ok: false,
      rejection: reject("invalid_upto_stellar_payload_invalid_signer_authorization", reason),
    }) as const;
  if (!Array.isArray(value)) return invalid("signerAuthorizations must be an array of base64 XDR entries.");
  if (value.length === 0) return { ok: true, entries: [] };
  if (!isContractAddress(payer))
    return invalid("signerAuthorizations are only accepted for a smart-account (C…) payer.");
  if (value.length > MAX_SIGNER_AUTHORIZATIONS) {
    return invalid(
      `signerAuthorizations has ${value.length} entries; at most ${MAX_SIGNER_AUTHORIZATIONS} are accepted.`,
    );
  }

  const entries: xdr.SorobanAuthorizationEntry[] = [];
  const seen = new Set<string>();
  for (const [index, item] of (value as unknown[]).entries()) {
    if (typeof item !== "string" || item === "")
      return invalid(`signerAuthorizations[${index}] is not a base64 string.`);
    if (item.length > MAX_AUTHORIZATION_BASE64_LENGTH) {
      return {
        ok: false,
        rejection: reject(
          "invalid_upto_stellar_payload_too_large",
          `signerAuthorizations[${index}] is ${item.length} base64 characters; the limit is ${MAX_AUTHORIZATION_BASE64_LENGTH}.`,
        ),
      };
    }
    let entry: xdr.SorobanAuthorizationEntry;
    try {
      entry = decodeAuthorizationEntry(item);
    } catch {
      return invalid(`signerAuthorizations[${index}] is not a base64 XDR SorobanAuthorizationEntry.`);
    }
    if (credentialOf(entry.credentials()) === undefined) {
      return invalid(`signerAuthorizations[${index}] must use address credentials.`);
    }
    const credentials = addressCredentialsOf(entry.credentials());
    const signer = accountOrContractOf(xdr.ScVal.scvAddress(credentials.address()));
    if (signer === undefined)
      return invalid(`signerAuthorizations[${index}] has an unsupported signer address.`);
    if (signer === payer) return invalid(`signerAuthorizations[${index}] is signed by the payer itself.`);
    if (facilitatorAddresses.has(signer)) {
      return invalid(`signerAuthorizations[${index}] is signed by a facilitator account.`);
    }
    const key = `${signer}:${credentials.nonce().toString()}`;
    if (seen.has(key)) return invalid(`signerAuthorizations[${index}] repeats an earlier entry.`);
    seen.add(key);
    if (!isSigned(credentials.signature()))
      return invalid(`signerAuthorizations[${index}] carries no signature.`);

    const root = entry.rootInvocation();
    const fn = root.function();
    if (
      fn.switch() !== xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn() ||
      Address.fromScAddress(fn.contractFn().contractAddress()).toString() !== payer ||
      fn.contractFn().functionName().toString() !== CHECK_AUTH_FUNCTION ||
      root.subInvocations().length !== 0
    ) {
      return invalid(
        `signerAuthorizations[${index}] must authorize only ${CHECK_AUTH_FUNCTION} of the payer, without sub-invocations.`,
      );
    }
    entries.push(entry);
  }
  return { ok: true, entries };
}

/**
 * Whether the tree is exactly `settle(terms)` with the one expected `approve` child.
 *
 * @param root - The root invocation
 * @param contract - The settlement contract
 * @param payer - The payer
 * @param terms - The signed terms
 * @returns Whether the tree is valid
 */
function treeIsValid(
  root: xdr.SorobanAuthorizedInvocation,
  contract: string,
  payer: string,
  terms: UptoTerms,
): boolean {
  const children = root.subInvocations();
  if (children.length !== 1) return false;
  const [child] = children;
  return (
    child !== undefined && child.toXDR("base64") === approveInvocation(contract, payer, terms).toXDR("base64")
  );
}

/**
 * The credential arm of an entry.
 *
 * @param credentials - The entry's credentials
 * @returns `address` or `address_v2`, or `undefined` for other credentials
 */
function credentialOf(credentials: xdr.SorobanCredentials): UptoCredential | undefined {
  const kind = credentials.switch();
  if (kind === xdr.SorobanCredentialsType.sorobanCredentialsAddress()) return "address";
  if (kind === xdr.SorobanCredentialsType.sorobanCredentialsAddressV2()) return "address_v2";
  return undefined;
}

/**
 * The address credentials of either address arm.
 *
 * @param credentials - Address or address V2 credentials
 * @returns The address credentials
 */
function addressCredentialsOf(credentials: xdr.SorobanCredentials): xdr.SorobanAddressCredentials {
  return credentials.switch() === xdr.SorobanCredentialsType.sorobanCredentialsAddressV2()
    ? credentials.addressV2()
    : credentials.address();
}

/**
 * A signature is present unless it is `void` or an empty vector (the SDK's unsigned placeholders).
 *
 * @param signature - The credentials' signature
 * @returns Whether a signature is present
 */
function isSigned(signature: xdr.ScVal): boolean {
  const kind = signature.switch();
  if (kind === xdr.ScValType.scvVoid()) return false;
  if (kind === xdr.ScValType.scvVec()) return (signature.vec() ?? []).length > 0;
  return true;
}
