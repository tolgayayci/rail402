import { describe, expect, it } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { SignerSetError, assertSignerSet, type SignerSet } from "@rail402.dev/facilitator";

const SPONSOR = Keypair.random().publicKey();
const COLD = Keypair.random().publicKey();
const CHANNEL = Keypair.random().publicKey();
const AUTHORITY = Keypair.random().publicKey();
const policy = { coldSigner: COLD, derived: new Set([CHANNEL, AUTHORITY]) };
const HASH_X = StrKey.encodeSha256Hash(Buffer.alloc(32, 7));
const PRE_AUTH = StrKey.encodePreAuthTx(Buffer.alloc(32, 9));

const set = (
  masterWeight: number,
  low: number,
  medium: number,
  high: number,
  signers: SignerSet["signers"] = [{ key: COLD, weight: 2 }],
): SignerSet => ({ masterWeight, thresholds: { low, medium, high }, signers });

describe("assertSignerSet", () => {
  it("accepts a hot key that meets medium but not high, with a cold signer reaching high", () => {
    expect(() => {
      assertSignerSet(set(1, 1, 1, 2), SPONSOR, policy);
    }).not.toThrow();
    // Other signers that stay below high with the hot key are allowed, e.g. an operator's second key.
    const second = set(1, 1, 1, 3, [
      { key: COLD, weight: 3 },
      { key: Keypair.random().publicKey(), weight: 1 },
    ]);
    expect(() => {
      assertSignerSet(second, SPONSOR, policy);
    }).not.toThrow();
  });

  it.each([
    ["the default single-signer account", set(1, 0, 0, 0, []), /alone meets the high threshold/],
    ["a hot key that meets high", set(2, 1, 1, 2), /alone meets the high threshold/],
    [
      "a hot key below medium",
      set(1, 1, 2, 3, [{ key: COLD, weight: 3 }]),
      /does not meet the medium threshold/,
    ],
    [
      "no cold signer on the account",
      set(1, 1, 1, 2, [{ key: Keypair.random().publicKey(), weight: 2 }]),
      /cold signer .* does not reach the high threshold/,
    ],
    [
      "a cold signer below high",
      set(1, 1, 1, 3, [{ key: COLD, weight: 2 }]),
      /does not reach the high threshold/,
    ],
    [
      "another key that reaches high as well",
      set(1, 1, 1, 2, [
        { key: COLD, weight: 2 },
        { key: Keypair.random().publicKey(), weight: 2 },
      ]),
      /reach the high threshold of .* together .*only the cold signer may/,
    ],
    [
      "a channel key derived from the sponsor seed as the high signer",
      set(1, 1, 1, 2, [
        { key: COLD, weight: 2 },
        { key: CHANNEL, weight: 2 },
      ]),
      /derived from the sponsor seed/,
    ],
    [
      "the upto authority as a signer of any weight",
      set(1, 1, 1, 3, [
        { key: COLD, weight: 3 },
        { key: AUTHORITY, weight: 1 },
      ]),
      /derived from the sponsor seed/,
    ],
    [
      "a hash-x signer that reaches high with the hot key",
      set(1, 1, 1, 2, [
        { key: COLD, weight: 2 },
        { key: HASH_X, weight: 1 },
      ]),
      /hash-x and signed-payload signers count too/,
    ],
    [
      "a pre-authorized transaction signer that reaches high",
      set(1, 1, 1, 2, [
        { key: COLD, weight: 2 },
        { key: PRE_AUTH, weight: 2 },
      ]),
      /only the cold signer may/,
    ],
  ])("refuses %s", (_label, signers, pattern) => {
    expect(() => {
      assertSignerSet(signers, SPONSOR, policy);
    }).toThrow(SignerSetError);
    expect(() => {
      assertSignerSet(signers, SPONSOR, policy);
    }).toThrow(pattern);
  });

  it("never lets a derived key or a hash-x signer stand in for the cold signer", () => {
    for (const key of [CHANNEL, AUTHORITY, HASH_X, PRE_AUTH]) {
      // The key reaches high on its own; the configured cold key is missing.
      const signers = set(1, 1, 1, 2, [{ key, weight: 2 }]);
      expect(() => {
        assertSignerSet(signers, SPONSOR, policy);
      }).toThrow(/cold signer .* does not reach the high threshold/);
    }
  });

  it("refuses a configured cold signer that is the sponsor key or derived from its seed", () => {
    for (const coldSigner of [SPONSOR, CHANNEL]) {
      const signers = set(1, 1, 1, 2, [{ key: coldSigner, weight: 2 }]);
      expect(() => {
        assertSignerSet(signers, SPONSOR, { ...policy, coldSigner });
      }).toThrow(/kept off the server/);
    }
  });
});
