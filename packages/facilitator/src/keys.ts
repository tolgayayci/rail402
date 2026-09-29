import { hkdfSync } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { basicNodeSigner } from "@stellar/stellar-sdk/contract";
import type { FacilitatorStellarSigner } from "@x402/stellar";

const CHANNEL_SALT = "rail402/channel-accounts/v1";

/**
 * Derives the keypair of channel `index` from the sponsor's secret (HKDF-SHA256). An operator
 * configures one secret per network; channel accounts are reproducible from it and never need to be
 * stored or backed up separately. Channels hold no funds: the sponsor pays their reserves and fees.
 */
export function deriveChannelKeypair(sponsor: Keypair, network: string, index: number): Keypair {
  if (!Number.isInteger(index) || index < 0) throw new RangeError(`invalid channel index ${index}`);
  const seed = hkdfSync("sha256", sponsor.rawSecretKey(), CHANNEL_SALT, `${network}#${index}`, 32);
  return Keypair.fromRawEd25519Seed(Buffer.from(seed));
}

export function deriveChannelKeypairs(sponsor: Keypair, network: string, count: number): Keypair[] {
  return Array.from({ length: count }, (_, index) => deriveChannelKeypair(sponsor, network, index));
}

/** An @x402/stellar signer backed by a local keypair. */
export function keypairSigner(keypair: Keypair, passphrase: string): FacilitatorStellarSigner {
  const { signAuthEntry, signTransaction } = basicNodeSigner(keypair, passphrase);
  return { address: keypair.publicKey(), signAuthEntry, signTransaction };
}
