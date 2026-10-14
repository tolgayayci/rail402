import type { Buffer } from "buffer";
import { Address, buildAuthorizationEntryPreimage, hash, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { APPROVE_FUNCTION, SETTLE_FUNCTION } from "./constants.ts";

/**
 * The terms a payer signs, mirroring the settlement contract's `UptoTerms`. The payer signs every
 * field; the amount actually charged is chosen later by the settlement authority, within
 * `0..=maxAmount`.
 */
export interface UptoTerms {
  /** Last ledger (inclusive) at which the terms can be settled; equals `signatureExpirationLedger`. */
  readonly expirationLedger: number;
  /** The settlement authority (`G…`), `extra.facilitatorAddress`. */
  readonly facilitator: string;
  /** The cap, in atomic units of `token`. */
  readonly maxAmount: bigint;
  /** `payTo` (`G…` or `C…`). */
  readonly recipient: string;
  /** SEP-41 token contract (`C…`), the requirements' `asset`. */
  readonly token: string;
  /** First ledger at which the terms can be settled; clients send 0. */
  readonly validAfterLedger: number;
}

/** Credential arm of the payer's authorization entry. */
export type UptoCredential = "address" | "address_v2";

/**
 * Keys of the terms map in the order the contract encodes them. A Soroban `contracttype` struct is
 * an `ScMap` sorted by field name, and the host rejects any other order or type.
 */
const TERMS_KEYS = [
  "expiration_ledger",
  "facilitator",
  "max_amount",
  "recipient",
  "token",
  "valid_after_ledger",
] as const;

/**
 * Encodes terms as the contract's `UptoTerms` `ScMap`.
 *
 * @param terms - The terms
 * @returns The `ScMap` value
 */
export function termsToScVal(terms: UptoTerms): xdr.ScVal {
  const values: Record<(typeof TERMS_KEYS)[number], xdr.ScVal> = {
    expiration_ledger: xdr.ScVal.scvU32(terms.expirationLedger),
    facilitator: addressScVal(terms.facilitator),
    max_amount: i128ScVal(terms.maxAmount),
    recipient: addressScVal(terms.recipient),
    token: addressScVal(terms.token),
    valid_after_ledger: xdr.ScVal.scvU32(terms.validAfterLedger),
  };
  return xdr.ScVal.scvMap(
    TERMS_KEYS.map((key) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val: values[key] })),
  );
}

/**
 * Decodes the contract's `UptoTerms` `ScMap`, strictly: exactly the six keys in order, `u32`
 * ledgers, an `i128` cap and account or contract addresses. Anything else is `undefined`, and so is
 * a value whose canonical re-encoding differs from its input.
 *
 * @param value - The encoded terms
 * @returns The terms, or `undefined` when the value is not exactly an `UptoTerms`
 */
export function termsFromScVal(value: xdr.ScVal): UptoTerms | undefined {
  try {
    if (value.switch() !== xdr.ScValType.scvMap()) return undefined;
    const entries = value.map() ?? [];
    if (entries.length !== TERMS_KEYS.length) return undefined;
    const field = new Map<string, xdr.ScVal>();
    for (const [index, entry] of entries.entries()) {
      const key = entry.key();
      if (key.switch() !== xdr.ScValType.scvSymbol()) return undefined;
      const name = key.sym().toString();
      if (name !== TERMS_KEYS[index]) return undefined;
      field.set(name, entry.val());
    }
    const expirationLedger = u32Of(field.get("expiration_ledger"));
    const facilitator = accountOrContractOf(field.get("facilitator"));
    const maxAmount = i128Of(field.get("max_amount"));
    const recipient = accountOrContractOf(field.get("recipient"));
    const token = accountOrContractOf(field.get("token"));
    const validAfterLedger = u32Of(field.get("valid_after_ledger"));
    if (
      expirationLedger === undefined ||
      facilitator === undefined ||
      maxAmount === undefined ||
      recipient === undefined ||
      token === undefined ||
      validAfterLedger === undefined
    ) {
      return undefined;
    }
    const terms: UptoTerms = { expirationLedger, facilitator, maxAmount, recipient, token, validAfterLedger };
    return termsToScVal(terms).toXDR("base64") === value.toXDR("base64") ? terms : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The payer's signed child: `token.approve(payer, contract, maxAmount, expirationLedger)`.
 *
 * @param contract - The settlement contract
 * @param payer - The payer
 * @param terms - The terms
 * @returns The `approve` invocation
 */
export function approveInvocation(
  contract: string,
  payer: string,
  terms: UptoTerms,
): xdr.SorobanAuthorizedInvocation {
  return invocation(
    terms.token,
    APPROVE_FUNCTION,
    [
      addressScVal(payer),
      addressScVal(contract),
      i128ScVal(terms.maxAmount),
      xdr.ScVal.scvU32(terms.expirationLedger),
    ],
    [],
  );
}

/**
 * The payer's whole tree: `contract.settle(terms)` with the single `approve` child.
 *
 * @param contract - The settlement contract
 * @param payer - The payer
 * @param terms - The terms
 * @returns The root invocation
 */
export function payerInvocation(
  contract: string,
  payer: string,
  terms: UptoTerms,
): xdr.SorobanAuthorizedInvocation {
  return invocation(
    contract,
    SETTLE_FUNCTION,
    [termsToScVal(terms)],
    [approveInvocation(contract, payer, terms)],
  );
}

/**
 * Arguments of `settle(payer, terms, amount)`.
 *
 * @param payer - The payer
 * @param terms - The terms
 * @param amount - The amount to settle
 * @returns The three arguments
 */
export function settleArgs(payer: string, terms: UptoTerms, amount: bigint): xdr.ScVal[] {
  return [addressScVal(payer), termsToScVal(terms), i128ScVal(amount)];
}

/**
 * The contract call a facilitator submits.
 *
 * @param contract - The settlement contract
 * @param payer - The payer
 * @param terms - The terms
 * @param amount - The amount to settle
 * @returns The `settle` invocation arguments
 */
export function settleInvokeArgs(
  contract: string,
  payer: string,
  terms: UptoTerms,
  amount: bigint,
): xdr.InvokeContractArgs {
  return new xdr.InvokeContractArgs({
    contractAddress: Address.fromString(contract).toScAddress(),
    functionName: SETTLE_FUNCTION,
    args: settleArgs(payer, terms, amount),
  });
}

/**
 * The settlement authority's entry: `SOURCE_ACCOUNT` credentials for `settle(payer, terms, amount)`,
 * satisfied by making the authority the operation's source account. It adds no signature entry
 * and no nonce. Only a facilitator builds this entry; a client entry with these credentials is
 * always refused.
 *
 * @param contract - The settlement contract
 * @param payer - The payer
 * @param terms - The terms
 * @param amount - The amount to settle
 * @returns The authority's entry
 */
export function authorityEntry(
  contract: string,
  payer: string,
  terms: UptoTerms,
  amount: bigint,
): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation: invocation(contract, SETTLE_FUNCTION, settleArgs(payer, terms, amount), []),
  });
}

/**
 * The payer's entry before signing: address credentials carrying `nonce` and
 * `signatureExpirationLedger = terms.expirationLedger`, with an empty (`void`) signature.
 *
 * @param options - What the entry authorizes
 * @param options.contract - The settlement contract
 * @param options.payer - The payer
 * @param options.terms - The terms
 * @param options.nonce - The nonce, random per payment
 * @param options.credential - The credential arm (legacy `address` by default)
 * @returns The unsigned entry
 */
export function unsignedPayerEntry(options: {
  readonly contract: string;
  readonly payer: string;
  readonly terms: UptoTerms;
  readonly nonce: bigint;
  readonly credential?: UptoCredential;
}): xdr.SorobanAuthorizationEntry {
  const addressCredentials = new xdr.SorobanAddressCredentials({
    address: Address.fromString(options.payer).toScAddress(),
    nonce: xdr.Int64.fromString(options.nonce.toString()),
    signatureExpirationLedger: options.terms.expirationLedger,
    signature: xdr.ScVal.scvVoid(),
  });
  return new xdr.SorobanAuthorizationEntry({
    credentials:
      options.credential === "address_v2"
        ? xdr.SorobanCredentials.sorobanCredentialsAddressV2(addressCredentials)
        : xdr.SorobanCredentials.sorobanCredentialsAddress(addressCredentials),
    rootInvocation: payerInvocation(options.contract, options.payer, options.terms),
  });
}

/**
 * Signature payload of an address-credential entry: V1 or the address-bound V2 preimage.
 *
 * @param entry - An entry with address credentials
 * @param networkPassphrase - The network passphrase
 * @returns The preimage
 */
export function authorizationPreimage(
  entry: xdr.SorobanAuthorizationEntry,
  networkPassphrase: string,
): xdr.HashIdPreimage {
  const credentials = entry.credentials();
  const expiration =
    credentials.switch() === xdr.SorobanCredentialsType.sorobanCredentialsAddressV2()
      ? credentials.addressV2().signatureExpirationLedger()
      : credentials.address().signatureExpirationLedger();
  return buildAuthorizationEntryPreimage(entry, expiration, networkPassphrase);
}

/**
 * sha256 of the preimage: the 32 bytes an ed25519 key signs.
 *
 * @param entry - An entry with address credentials
 * @param networkPassphrase - The network passphrase
 * @returns The 32-byte payload
 */
export function authorizationPayload(
  entry: xdr.SorobanAuthorizationEntry,
  networkPassphrase: string,
): Buffer {
  return hash(authorizationPreimage(entry, networkPassphrase).toXDR());
}

/**
 * Encodes an entry as base64 XDR, the form payloads carry.
 *
 * @param entry - The entry
 * @returns Base64 XDR
 */
export function encodeAuthorizationEntry(entry: xdr.SorobanAuthorizationEntry): string {
  return entry.toXDR("base64");
}

/**
 * Decodes one base64 XDR entry; throws on malformed input or trailing bytes.
 *
 * @param base64 - Base64 XDR of one `SorobanAuthorizationEntry`
 * @returns The entry
 */
export function decodeAuthorizationEntry(base64: string): xdr.SorobanAuthorizationEntry {
  const entry = xdr.SorobanAuthorizationEntry.fromXDR(base64, "base64");
  if (entry.toXDR("base64") !== base64) {
    throw new Error("authorization entry is not canonical base64 XDR");
  }
  return entry;
}

/**
 * An address as an `ScVal`.
 *
 * @param address - A `G…` or `C…` address
 * @returns The `ScVal`
 */
export function addressScVal(address: string): xdr.ScVal {
  return nativeToScVal(address, { type: "address" });
}

/**
 * An amount as an `i128` `ScVal`.
 *
 * @param value - The amount
 * @returns The `ScVal`
 */
export function i128ScVal(value: bigint): xdr.ScVal {
  return nativeToScVal(value, { type: "i128" });
}

/**
 * A contract-function invocation node of an authorization tree.
 *
 * @param contract - The contract
 * @param functionName - The function
 * @param args - Its arguments
 * @param subInvocations - Its children
 * @returns The invocation
 */
function invocation(
  contract: string,
  functionName: string,
  args: xdr.ScVal[],
  subInvocations: xdr.SorobanAuthorizedInvocation[],
): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(contract).toScAddress(),
        functionName,
        args,
      }),
    ),
    subInvocations,
  });
}

/**
 * A `u32` `ScVal`'s value.
 *
 * @param value - The value
 * @returns The number, or `undefined` for any other type
 */
function u32Of(value: xdr.ScVal | undefined): number | undefined {
  return value?.switch() === xdr.ScValType.scvU32() ? value.u32() : undefined;
}

/**
 * An `i128` `ScVal`'s value.
 *
 * @param value - The value
 * @returns The amount, or `undefined` for any other type
 */
function i128Of(value: xdr.ScVal | undefined): bigint | undefined {
  if (value?.switch() !== xdr.ScValType.scvI128()) return undefined;
  const parts = value.i128();
  return (parts.hi().toBigInt() << 64n) | parts.lo().toBigInt();
}

/**
 * Strkey of an account (`G…`) or contract (`C…`) address; other address kinds are refused.
 *
 * @param value - An address `ScVal`
 * @returns The strkey, or `undefined` for any other value
 */
export function accountOrContractOf(value: xdr.ScVal | undefined): string | undefined {
  if (value?.switch() !== xdr.ScValType.scvAddress()) return undefined;
  const address = value.address();
  const kind = address.switch();
  if (
    kind !== xdr.ScAddressType.scAddressTypeAccount() &&
    kind !== xdr.ScAddressType.scAddressTypeContract()
  ) {
    return undefined;
  }
  return Address.fromScAddress(address).toString();
}
