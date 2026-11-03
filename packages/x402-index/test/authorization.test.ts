/**
 * The payer signature check of E7 against two references: the payload the Stellar SDK builds and signs,
 * and the signatures real wallets made on settlements that the network authenticated.
 */
import {
  Keypair,
  Networks,
  authorizeEntry,
  buildAuthorizationEntryPreimage,
  hash,
  xdr,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { authorizationPayload, signedByPayer } from "../src/authorization.ts";
import { networkId, readEnvelope } from "../src/index.ts";
import { TRANSACTIONS, addressCredentials, payAs, type FixtureTransaction } from "./helpers.ts";

const EXACT = [
  "rail402-exact",
  "rail402-exact-previous-sponsor",
  "x402org-exact-1",
  "x402org-exact-2",
  "beta-exact",
] as const;

const passphraseOf = (tx: FixtureTransaction) =>
  tx.network === "stellar:pubnet" ? Networks.PUBLIC : Networks.TESTNET;

/** The fixture's only operation and its authorization entry. */
function partsOf(tx: FixtureTransaction) {
  const envelope = xdr.TransactionEnvelope.fromXDR(tx.envelopeXdr, "base64");
  const view = readEnvelope(envelope);
  const [operation] = view?.operations ?? [];
  const [authorization] = operation?.authorizations ?? [];
  if (operation === undefined || authorization === undefined || authorization.address === null) {
    throw new Error("not an exact transfer");
  }
  return { envelope, authorization, payer: authorization.address };
}

function asV2(entry: xdr.SorobanAuthorizationEntry): xdr.SorobanAuthorizationEntry {
  const copy = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR());
  copy.credentials(xdr.SorobanCredentials.sorobanCredentialsAddressV2(addressCredentials(copy)));
  return copy;
}

describe("the payer signature check", () => {
  it("verifies the signatures wallets made on every exact settlement in the fixtures", () => {
    for (const name of EXACT) {
      const tx = TRANSACTIONS[name];
      const { authorization, payer } = partsOf(tx);
      expect(payer.kind, name).toBe("G");
      expect(signedByPayer(authorization.entry, payer, networkId(passphraseOf(tx)), tx.ledger), name).toBe(
        true,
      );
      // The same signature never proves anything on the other network.
      const other = tx.network === "stellar:pubnet" ? Networks.TESTNET : Networks.PUBLIC;
      expect(signedByPayer(authorization.entry, payer, networkId(other), tx.ledger), name).toBe(false);
    }
  });

  it("builds the payload the SDK signs, for Address and AddressV2 credentials", () => {
    for (const name of EXACT) {
      const tx = TRANSACTIONS[name];
      const passphrase = passphraseOf(tx);
      const { authorization } = partsOf(tx);
      for (const entry of [authorization.entry, asV2(authorization.entry)]) {
        const expiration = addressCredentials(entry).signatureExpirationLedger();
        const sdk = hash(buildAuthorizationEntryPreimage(entry, expiration, passphrase).toXDR());
        expect(authorizationPayload(entry, networkId(passphrase))?.toString("hex"), name).toBe(
          sdk.toString("hex"),
        );
      }
      expect(
        authorizationPayload(asV2(authorization.entry), networkId(passphrase))?.equals(
          authorizationPayload(authorization.entry, networkId(passphrase)) ?? Buffer.alloc(0),
        ),
      ).toBe(false);
    }
  });

  it("accepts what the SDK's authorizeEntry signs for the payer, and only for that payer", async () => {
    const payer = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x31));
    const tx = TRANSACTIONS["x402org-exact-1"];
    const { envelope } = partsOf(tx);
    const op = envelope.feeBump().tx().innerTx().v1().tx().operations()[0]?.body().invokeHostFunctionOp();
    if (op === undefined) throw new Error("no operation");
    payAs(op, [], payer.publicKey());
    const [unsigned] = op.auth();
    if (unsigned === undefined) throw new Error("no authorization entry");
    const expiration = tx.ledger + 10;
    for (const entry of [unsigned, asV2(unsigned)]) {
      const signed = await authorizeEntry(entry, payer, expiration, Networks.TESTNET);
      const view = { kind: "G", base: payer.publicKey(), muxedId: null } as const;
      expect(signedByPayer(signed, view, networkId(Networks.TESTNET), tx.ledger)).toBe(true);
      expect(signedByPayer(signed, view, networkId(Networks.TESTNET), expiration)).toBe(true);
      expect(signedByPayer(signed, view, networkId(Networks.TESTNET), expiration + 1)).toBe(false);
      const victim = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x33)).publicKey();
      expect(signedByPayer(signed, { ...view, base: victim }, networkId(Networks.TESTNET), tx.ledger)).toBe(
        false,
      );
    }
  });
});
