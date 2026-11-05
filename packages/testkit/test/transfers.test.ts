import { Keypair, Networks, TransactionBuilder, hash, xdr, type Transaction } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { buildTransfer } from "../src/transfers.ts";

/** Whether the transfer's authorization entry is signed by `payer` for the network of `passphrase`. */
function signedFor(transaction: string, payer: Keypair, passphrase: string): boolean {
  const built = TransactionBuilder.fromXDR(transaction, passphrase) as Transaction;
  const operation = built.operations[0] as { auth?: xdr.SorobanAuthorizationEntry[] };
  const entry = operation.auth?.[0];
  if (entry === undefined) throw new Error("no authorization entry");
  const credentials = entry.credentials().address();
  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(Buffer.from(passphrase)),
      nonce: credentials.nonce(),
      signatureExpirationLedger: credentials.signatureExpirationLedger(),
      invocation: entry.rootInvocation(),
    }),
  );
  const signature = credentials.signature().vec()?.[0]?.map()?.[1]?.val().bytes();
  if (signature === undefined) throw new Error("no signature");
  return payer.verify(hash(preimage.toXDR()), signature);
}

describe("an offline transfer", () => {
  it("is signed for testnet by default, and for the network it is given", async () => {
    const payer = Keypair.random();
    const testnet = await buildTransfer({ payer });
    expect(signedFor(testnet.xdr, payer, Networks.TESTNET)).toBe(true);
    expect(signedFor(testnet.xdr, payer, Networks.PUBLIC)).toBe(false);
    const pubnet = await buildTransfer({ payer, passphrase: Networks.PUBLIC });
    expect(signedFor(pubnet.xdr, payer, Networks.PUBLIC)).toBe(true);
    expect(signedFor(pubnet.xdr, payer, Networks.TESTNET)).toBe(false);
  });
});
