import { Buffer } from "buffer";
import { StrKey, hash, xdr } from "@stellar/stellar-sdk";

/** A G… account or C… contract, with the muxed id of an M… address kept apart. */
export interface AddressView {
  /** The G… account (the base account of a muxed address) or C… contract. */
  readonly base: string;
  readonly kind: "G" | "C";
  readonly muxedId: string | null;
}

/** Decodes base64 XDR, or `undefined` when it does not decode. Never throws. */
export function decodeXdr<T>(
  type: { fromXDR(input: string, format: "base64"): T },
  base64: string,
): T | undefined {
  if (typeof base64 !== "string" || base64.length === 0) return undefined;
  try {
    return type.fromXDR(base64, "base64");
  } catch {
    return undefined;
  }
}

/**
 * The union discriminant at the start of an XDR value: the version of a TransactionMeta or a
 * LedgerCloseMeta. `undefined` when the input is not base64 of at least four bytes.
 */
export function leadingVersion(base64: string): number | undefined {
  if (typeof base64 !== "string" || base64.length < 8) return undefined;
  try {
    const bytes = Buffer.from(base64.slice(0, 8), "base64");
    if (bytes.length < 4) return undefined;
    return bytes.readInt32BE(0);
  } catch {
    return undefined;
  }
}

/** The account behind a transaction or operation source. */
export function muxedAccount(account: xdr.MuxedAccount): AddressView | undefined {
  try {
    switch (account.switch()) {
      case xdr.CryptoKeyType.keyTypeEd25519():
        return { base: StrKey.encodeEd25519PublicKey(account.ed25519()), kind: "G", muxedId: null };
      case xdr.CryptoKeyType.keyTypeMuxedEd25519(): {
        const muxed = account.med25519();
        return {
          base: StrKey.encodeEd25519PublicKey(muxed.ed25519()),
          kind: "G",
          muxedId: muxed.id().toString(),
        };
      }
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

/** A G…, C… or muxed Soroban address; claimable balances and liquidity pools are `undefined`. */
export function scAddress(address: xdr.ScAddress): AddressView | undefined {
  try {
    switch (address.switch()) {
      case xdr.ScAddressType.scAddressTypeAccount():
        return {
          base: StrKey.encodeEd25519PublicKey(address.accountId().ed25519()),
          kind: "G",
          muxedId: null,
        };
      case xdr.ScAddressType.scAddressTypeContract():
        return { base: contractStrkey(address.contractId()), kind: "C", muxedId: null };
      case xdr.ScAddressType.scAddressTypeMuxedAccount(): {
        const muxed = address.muxedAccount();
        return {
          base: StrKey.encodeEd25519PublicKey(muxed.ed25519()),
          kind: "G",
          muxedId: muxed.id().toString(),
        };
      }
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

/** An `Address` ScVal as an address, or `undefined` for any other value. */
export function addressOf(value: xdr.ScVal | undefined): AddressView | undefined {
  if (value?.switch() !== xdr.ScValType.scvAddress()) return undefined;
  return scAddress(value.address());
}

/** An `i128` ScVal as a bigint, or `undefined` for any other value. */
export function i128Of(value: xdr.ScVal | undefined): bigint | undefined {
  if (value?.switch() !== xdr.ScValType.scvI128()) return undefined;
  try {
    const parts = value.i128();
    const hi = BigInt.asIntN(64, BigInt(parts.hi().toString()));
    const lo = BigInt.asUintN(64, BigInt(parts.lo().toString()));
    return (hi << 64n) | lo;
  } catch {
    return undefined;
  }
}

/** A `Symbol` ScVal as a string, or `undefined`. */
export function symbolOf(value: xdr.ScVal | undefined): string | undefined {
  if (value?.switch() !== xdr.ScValType.scvSymbol()) return undefined;
  try {
    return value.sym().toString("latin1");
  } catch {
    return undefined;
  }
}

/** A `String` ScVal as text (bytes read as latin1, so nothing is lost), or `undefined`. */
export function stringOf(value: xdr.ScVal | undefined): string | undefined {
  if (value?.switch() !== xdr.ScValType.scvString()) return undefined;
  try {
    const raw = value.str();
    return typeof raw === "string" ? raw : Buffer.from(raw).toString("latin1");
  } catch {
    return undefined;
  }
}

/** The entries of a `Map` ScVal whose keys are symbols, or `undefined` for any other value. */
export function symbolMapOf(value: xdr.ScVal | undefined): Map<string, xdr.ScVal> | undefined {
  if (value?.switch() !== xdr.ScValType.scvMap()) return undefined;
  const entries = value.map();
  if (entries === null) return undefined;
  const map = new Map<string, xdr.ScVal>();
  for (const entry of entries) {
    const key = symbolOf(entry.key());
    if (key === undefined || map.has(key)) return undefined;
    map.set(key, entry.val());
  }
  return map;
}

/** The network id: SHA-256 of the passphrase. */
export function networkId(passphrase: string): Buffer {
  return hash(Buffer.from(passphrase, "utf8"));
}

/** The hashes of an envelope as the network computes them: outer, and inner for a fee bump. */
export function envelopeHashes(
  envelope: xdr.TransactionEnvelope,
  network: Buffer,
): { readonly hash: string; readonly innerHash: string | null } {
  const tagged = xdr.TransactionSignaturePayloadTaggedTransaction;
  const digest = (transaction: xdr.TransactionSignaturePayloadTaggedTransaction) =>
    hash(
      new xdr.TransactionSignaturePayload({ networkId: network, taggedTransaction: transaction }).toXDR(),
    ).toString("hex");
  switch (envelope.switch()) {
    case xdr.EnvelopeType.envelopeTypeTx():
      return { hash: digest(tagged.envelopeTypeTx(envelope.v1().tx())), innerHash: null };
    case xdr.EnvelopeType.envelopeTypeTxFeeBump(): {
      const feeBump = envelope.feeBump().tx();
      const inner = feeBump.innerTx().v1().tx();
      return {
        hash: digest(tagged.envelopeTypeTxFeeBump(feeBump)),
        innerHash: digest(tagged.envelopeTypeTx(inner)),
      };
    }
    case xdr.EnvelopeType.envelopeTypeTxV0(): {
      // A v0 transaction hashes as the v1 transaction it converts to.
      const v0 = envelope.v0().tx();
      const timeBounds = v0.timeBounds();
      const tx = new xdr.Transaction({
        sourceAccount: xdr.MuxedAccount.keyTypeEd25519(v0.sourceAccountEd25519()),
        fee: v0.fee(),
        seqNum: v0.seqNum(),
        cond:
          timeBounds === null ? xdr.Preconditions.precondNone() : xdr.Preconditions.precondTime(timeBounds),
        memo: v0.memo(),
        operations: v0.operations(),
        ext: new xdr.TransactionExt(0),
      });
      return { hash: digest(tagged.envelopeTypeTx(tx)), innerHash: null };
    }
    default:
      throw new RangeError(`unknown envelope type ${String(envelope.switch().value)}`);
  }
}

/** A contract id (an XDR Hash, a Buffer at runtime) as a C… strkey. */
export function contractStrkey(id: xdr.Hash): string {
  return StrKey.encodeContract(id as unknown as Buffer);
}
