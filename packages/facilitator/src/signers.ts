import { Keypair, StrKey, xdr, type rpc } from "@stellar/stellar-sdk";

/** The sponsor account's signer set as the network holds it. */
export interface SignerSet {
  readonly masterWeight: number;
  readonly thresholds: { readonly low: number; readonly medium: number; readonly high: number };
  /**
   * Other signers by their StrKey: `G…` for an ed25519 key, `T…` for a pre-authorized transaction,
   * `X…` for a hash-x preimage, `P…` for a signed payload.
   */
  readonly signers: readonly { readonly key: string; readonly weight: number }[];
}

/** What the signer set must hold besides the hot key (`assertSignerSet`). */
export interface SignerPolicy {
  /** The cold key kept off the server: the one signer that may reach the high threshold. */
  readonly coldSigner: string;
  /**
   * Keys the service derives from the sponsor seed (channels, the upto authority): a leaked seed
   * controls them too, so none of them may be a signer of the account.
   */
  readonly derived?: ReadonlySet<string>;
}

/** The sponsor's signer set is unsafe for a key that lives on a server. */
export class SignerSetError extends Error {
  override readonly name = "SignerSetError";
}

/** Reads the signer set of `account`; throws when the account does not exist. */
export async function readSignerSet(server: rpc.Server, account: string): Promise<SignerSet> {
  const key = xdr.LedgerKey.account(
    new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(account).xdrAccountId() }),
  );
  const { entries } = await server.getLedgerEntries(key);
  const entry = entries[0];
  if (entry === undefined) throw new SignerSetError(`the sponsor account ${account} does not exist`);
  const data = entry.val.account();
  const raw = data.thresholds();
  return {
    masterWeight: raw[0] ?? 0,
    thresholds: { low: raw[1] ?? 0, medium: raw[2] ?? 0, high: raw[3] ?? 0 },
    signers: data.signers().map((signer) => ({ key: signerKey(signer.key()), weight: signer.weight() })),
  };
}

function signerKey(key: xdr.SignerKey): string {
  switch (key.switch()) {
    case xdr.SignerKeyType.signerKeyTypeEd25519():
      return StrKey.encodeEd25519PublicKey(key.ed25519());
    case xdr.SignerKeyType.signerKeyTypePreAuthTx():
      return StrKey.encodePreAuthTx(key.preAuthTx());
    case xdr.SignerKeyType.signerKeyTypeHashX():
      return StrKey.encodeSha256Hash(key.hashX());
    default:
      return StrKey.encodeSignedPayload(key.ed25519SignedPayload().toXDR());
  }
}

/**
 * Checks that the hot sponsor key (the account's master key, which the service holds) can do what the
 * service needs and nothing more: it must meet the medium threshold (fee bumps need low; channel and
 * authority provisioning and the TTL keeper need medium), but not the high one, so whoever steals it
 * cannot change the signers or merge the account. The configured cold signer must reach the high
 * threshold on its own, so the operator can recover the account, and it must be the only way to: the
 * hot key and every other signer together stay below high. No key derived from the sponsor seed may be
 * a signer, and a pre-authorized transaction, hash-x or signed-payload signer never counts toward the
 * recovery. Throws `SignerSetError` otherwise.
 */
export function assertSignerSet(set: SignerSet, account: string, policy: SignerPolicy): void {
  const { masterWeight, thresholds } = set;
  const { coldSigner } = policy;
  const derived = policy.derived ?? new Set<string>();
  // A threshold of 0 is met by any signature with weight, as the network treats it.
  const high = Math.max(1, thresholds.high);
  const meets = (weight: number, threshold: number) => weight > 0 && weight >= Math.max(1, threshold);
  if (meets(masterWeight, thresholds.high)) {
    throw new SignerSetError(
      `the sponsor key alone meets the high threshold of ${account}: whoever holds it can change its signers or merge it; add a cold signer and raise the high threshold above the key's weight`,
    );
  }
  if (!meets(masterWeight, thresholds.medium)) {
    throw new SignerSetError(
      `the sponsor key does not meet the medium threshold of ${account}: channel provisioning and contract upkeep would fail`,
    );
  }
  if (coldSigner === account || derived.has(coldSigner)) {
    throw new SignerSetError(
      `the configured cold signer ${coldSigner} is the sponsor key or derived from its seed: it must be a key kept off the server`,
    );
  }
  const cold = set.signers.find((signer) => signer.key === coldSigner);
  if (cold === undefined || cold.weight < high) {
    throw new SignerSetError(
      `the configured cold signer ${coldSigner} does not reach the high threshold of ${account} (${String(high)}): the account could not be recovered`,
    );
  }
  const others = set.signers.filter((signer) => signer.key !== coldSigner && signer.weight > 0);
  const leaked = others.find((signer) => derived.has(signer.key));
  if (leaked !== undefined) {
    throw new SignerSetError(
      `${leaked.key}, a key derived from the sponsor seed (a channel or the upto authority), is a signer of ${account}: whoever holds the seed holds it too; remove it`,
    );
  }
  const rest = others.reduce((sum, signer) => sum + signer.weight, masterWeight);
  if (rest >= high) {
    const kinds = others.some((signer) => !signer.key.startsWith("G"))
      ? " (pre-authorized transaction, hash-x and signed-payload signers count too)"
      : "";
    throw new SignerSetError(
      `the sponsor key and the signers other than the cold signer reach the high threshold of ${account} together (weight ${String(rest)} of ${String(high)})${kinds}: only the cold signer may`,
    );
  }
}
