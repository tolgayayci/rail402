import { Buffer } from "buffer";
import { Address, hash, scValToNative, xdr } from "@stellar/stellar-sdk";
import { networkPassphrase, type StellarNetwork } from "./networks.ts";

/**
 * Soroban authorization payloads, decoded without network access.
 *
 * A wallet asked to sign a Soroban authorization entry receives the base64 `HashIdPreimage` whose
 * SHA-256 it signs. These helpers decode exactly those bytes, so a signer can check what it is about
 * to authorize before it signs: the network, the expiry and the contract call tree.
 */

/**
 * Which address credential the preimage belongs to: `address` is the original
 * `ENVELOPE_TYPE_SOROBAN_AUTHORIZATION`; `address_v2` is CAP-71's `…_WITH_ADDRESS`, which also binds the
 * signing address (ADDRESS_V2 and ADDRESS_WITH_DELEGATES credentials).
 */
export type AuthCredential = "address" | "address_v2";

export interface AuthorizationPreimage {
  readonly credential: AuthCredential;
  /** SHA-256 of the network passphrase. */
  readonly networkId: Uint8Array;
  readonly nonce: bigint;
  /** The last ledger (inclusive) in which the host accepts the signature. */
  readonly signatureExpirationLedger: number;
  /** `address_v2` only: the G… or C… address the signature is bound to. */
  readonly address?: string;
  readonly invocation: xdr.SorobanAuthorizedInvocation;
}

/** Largest base64 preimage accepted. A token transfer's preimage is a few hundred bytes. */
export const MAX_PREIMAGE_BASE64 = 16_384;

/**
 * Decodes a base64 Soroban authorization preimage. Undefined for any other envelope type, for bytes
 * that do not round-trip exactly, and for input larger than MAX_PREIMAGE_BASE64.
 */
export function decodeAuthorizationPreimage(base64: string): AuthorizationPreimage | undefined {
  if (typeof base64 !== "string" || base64 === "" || base64.length > MAX_PREIMAGE_BASE64) return undefined;
  let preimage: xdr.HashIdPreimage;
  try {
    preimage = xdr.HashIdPreimage.fromXDR(base64, "base64");
    // Trailing bytes or a non-canonical encoding mean the signed bytes are not what was decoded.
    if (preimage.toXDR("base64") !== base64) return undefined;
  } catch {
    return undefined;
  }
  try {
    switch (preimage.switch()) {
      case xdr.EnvelopeType.envelopeTypeSorobanAuthorization(): {
        const body = preimage.sorobanAuthorization();
        return {
          credential: "address",
          networkId: new Uint8Array(body.networkId()),
          nonce: body.nonce().toBigInt(),
          signatureExpirationLedger: body.signatureExpirationLedger(),
          invocation: body.invocation(),
        };
      }
      case xdr.EnvelopeType.envelopeTypeSorobanAuthorizationWithAddress(): {
        const body = preimage.sorobanAuthorizationWithAddress();
        const address = strkeyOf(body.address());
        if (address === undefined) return undefined;
        return {
          credential: "address_v2",
          networkId: new Uint8Array(body.networkId()),
          nonce: body.nonce().toBigInt(),
          signatureExpirationLedger: body.signatureExpirationLedger(),
          address,
          invocation: body.invocation(),
        };
      }
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

/** The network id a preimage carries: SHA-256 of the network passphrase. */
export function networkIdFor(network: StellarNetwork): Uint8Array {
  return networkIdForPassphrase(networkPassphrase(network));
}

export function networkIdForPassphrase(passphrase: string): Uint8Array {
  return new Uint8Array(hash(Buffer.from(passphrase, "utf8")));
}

/** Constant-shape byte comparison for network ids and other short digests. */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return difference === 0;
}

/** A contract call inside an authorization tree. */
export interface ContractCall {
  /** C… address of the invoked contract. */
  readonly contract: string;
  readonly fn: string;
  readonly args: readonly xdr.ScVal[];
  readonly subInvocations: readonly xdr.SorobanAuthorizedInvocation[];
}

/** The contract call an invocation authorizes. Undefined for contract-creation functions. */
export function decodeContractCall(invocation: xdr.SorobanAuthorizedInvocation): ContractCall | undefined {
  try {
    const fn = invocation.function();
    if (fn.switch() !== xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn()) {
      return undefined;
    }
    const call = fn.contractFn();
    const contract = strkeyOf(call.contractAddress());
    if (contract?.startsWith("C") !== true) return undefined;
    return {
      contract,
      fn: call.functionName().toString(),
      args: call.args(),
      subInvocations: invocation.subInvocations(),
    };
  } catch {
    return undefined;
  }
}

/** Largest value an i128 can hold. */
export const I128_MAX = (1n << 127n) - 1n;

/**
 * The arguments of a SEP-41 `transfer(from: Address, to: MuxedAddress, amount: i128)`: `from` as a G…
 * or C… strkey, `to` as a G…, C… or M… strkey, and a positive amount. Undefined for any other shape.
 */
export function decodeSacTransferArgs(
  args: readonly xdr.ScVal[],
): { readonly from: string; readonly to: string; readonly amount: bigint } | undefined {
  if (args.length !== 3) return undefined;
  const [fromArg, toArg, amountArg] = args as [xdr.ScVal, xdr.ScVal, xdr.ScVal];
  if (
    fromArg.switch() !== xdr.ScValType.scvAddress() ||
    toArg.switch() !== xdr.ScValType.scvAddress() ||
    amountArg.switch() !== xdr.ScValType.scvI128()
  ) {
    return undefined;
  }
  const from = strkeyOf(fromArg.address());
  const to = strkeyOf(toArg.address());
  if (from === undefined || to === undefined || from.startsWith("M")) return undefined;
  let amount: bigint;
  try {
    amount = scValToNative(amountArg) as bigint;
  } catch {
    return undefined;
  }
  if (typeof amount !== "bigint" || amount <= 0n || amount > I128_MAX) return undefined;
  return { from, to, amount };
}

/** G…, C… or M… strkey of an address; undefined for claimable-balance and liquidity-pool addresses. */
function strkeyOf(address: xdr.ScAddress): string | undefined {
  try {
    const strkey = Address.fromScAddress(address).toString();
    return /^[GCM]/.test(strkey) ? strkey : undefined;
  } catch {
    return undefined;
  }
}
