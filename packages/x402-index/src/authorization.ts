import { Buffer } from "buffer";
import { Keypair, StrKey, hash, xdr } from "@stellar/stellar-sdk";
import { scAddress, type AddressView } from "./xdr.ts";

/** The most signatures the network reads from one Stellar account's authorization. */
const MAX_ACCOUNT_SIGNATURES = 20;

/** The address credentials of an `Address` or `AddressV2` entry; `undefined` for any other kind. */
function addressCredentials(
  entry: xdr.SorobanAuthorizationEntry,
): { readonly credentials: xdr.SorobanAddressCredentials; readonly v2: boolean } | undefined {
  const credentials = entry.credentials();
  const kind = credentials.switch();
  if (kind === xdr.SorobanCredentialsType.sorobanCredentialsAddress()) {
    return { credentials: credentials.address(), v2: false };
  }
  if (kind === xdr.SorobanCredentialsType.sorobanCredentialsAddressV2()) {
    return { credentials: credentials.addressV2(), v2: true };
  }
  return undefined;
}

/**
 * The payload an `Address` or `AddressV2` authorization entry is signed over, as the network computes it:
 * SHA-256 of the entry's `HashIdPreimage` on `network` (the network id, SHA-256 of the passphrase).
 * `Address` credentials use `ENVELOPE_TYPE_SOROBAN_AUTHORIZATION`; `AddressV2` credentials also bind the
 * address, with `ENVELOPE_TYPE_SOROBAN_AUTHORIZATION_WITH_ADDRESS` (CAP-71). `undefined` for other
 * credentials.
 */
export function authorizationPayload(
  entry: xdr.SorobanAuthorizationEntry,
  network: Buffer,
): Buffer | undefined {
  const address = addressCredentials(entry);
  if (address === undefined) return undefined;
  const { credentials, v2 } = address;
  const preimage = v2
    ? xdr.HashIdPreimage.envelopeTypeSorobanAuthorizationWithAddress(
        new xdr.HashIdPreimageSorobanAuthorizationWithAddress({
          networkId: network,
          nonce: credentials.nonce(),
          signatureExpirationLedger: credentials.signatureExpirationLedger(),
          address: credentials.address(),
          invocation: entry.rootInvocation(),
        }),
      )
    : xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
        new xdr.HashIdPreimageSorobanAuthorization({
          networkId: network,
          nonce: credentials.nonce(),
          signatureExpirationLedger: credentials.signatureExpirationLedger(),
          invocation: entry.rootInvocation(),
        }),
      );
  return Buffer.from(hash(preimage.toXDR()));
}

/** One `{ public_key: BytesN<32>, signature: BytesN<64> }` element, exactly as the network reads it. */
function accountSignature(
  value: xdr.ScVal,
): { readonly key: Buffer; readonly signature: Buffer } | undefined {
  if (value.switch() !== xdr.ScValType.scvMap()) return undefined;
  const fields = value.map() ?? [];
  const [first, second] = fields;
  if (fields.length !== 2 || first === undefined || second === undefined) return undefined;
  const bytes = (field: xdr.ScMapEntry, name: string, length: number) =>
    field.key().switch() === xdr.ScValType.scvSymbol() &&
    field.key().sym().toString() === name &&
    field.val().switch() === xdr.ScValType.scvBytes() &&
    field.val().bytes().length === length
      ? Buffer.from(field.val().bytes())
      : undefined;
  const key = bytes(first, "public_key", 32);
  const signature = bytes(second, "signature", 64);
  return key === undefined || signature === undefined ? undefined : { key, signature };
}

/**
 * Whether the `G…` account `payer` signed `entry` with its own key, in the form the network checks for a
 * Stellar account: `Address` or `AddressV2` credentials for `payer`, valid through `ledger` (the ledger of
 * the transaction is not after the signature expiration ledger); a signature vector of 1 to 20
 * `{ public_key, signature }` maps with strictly ascending keys, `payer`'s own key among them; and that
 * key's signature a valid ed25519 signature of the entry's payload on `network`.
 *
 * Only the payer's own signature is verified: it is the proof, and the others add nothing to it, so one
 * candidate costs at most one signature check whatever it carries. The account's other signers, their
 * weights and its thresholds are ledger state that a transaction does not carry. So signatures by other
 * signers alone never prove the payer, and the weight of the payer's own key is not checked. A contract
 * (`C…`) payer is never proven here: its own `__check_auth` code decides. Never throws.
 */
export function signedByPayer(
  entry: xdr.SorobanAuthorizationEntry,
  payer: AddressView,
  network: Buffer,
  ledger: number,
): boolean {
  try {
    if (payer.kind !== "G" || payer.muxedId !== null) return false;
    const address = addressCredentials(entry);
    if (address === undefined) return false;
    const { credentials } = address;
    const signer = scAddress(credentials.address());
    if (signer?.kind !== "G" || signer.base !== payer.base) return false;
    if (ledger > credentials.signatureExpirationLedger()) return false;
    const signature = credentials.signature();
    if (signature.switch() !== xdr.ScValType.scvVec()) return false;
    const elements = signature.vec() ?? [];
    if (elements.length === 0 || elements.length > MAX_ACCOUNT_SIGNATURES) return false;
    const own = Buffer.from(StrKey.decodeEd25519PublicKey(payer.base));
    let previous: Buffer | undefined;
    let ownSignature: Buffer | undefined;
    for (const element of elements) {
      const parsed = accountSignature(element);
      if (parsed === undefined) return false;
      if (previous !== undefined && Buffer.compare(previous, parsed.key) >= 0) return false;
      previous = parsed.key;
      if (parsed.key.equals(own)) ownSignature = parsed.signature;
    }
    if (ownSignature === undefined) return false;
    const payload = authorizationPayload(entry, network);
    return payload !== undefined && Keypair.fromPublicKey(payer.base).verify(payload, ownSignature);
  } catch {
    return false;
  }
}
