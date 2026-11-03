/**
 * The sponsor's signer set read from a local Stellar network (docker compose --profile stellar up -d).
 */
import { describe, expect, it } from "vitest";
import { BASE_FEE, Keypair, Operation, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";
import { SignerSetError, assertSignerSet, readSignerSet } from "@rail402.dev/facilitator";
import { LocalNetwork } from "@rail402.dev/testkit";

const net = new LocalNetwork();
const available = await net.available();

async function setOptions(
  account: Keypair,
  options: Parameters<typeof Operation.setOptions>[0],
  signers: Keypair[],
) {
  const source = await net.server.getAccount(account.publicKey());
  const transaction = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: net.passphrase })
    .addOperation(Operation.setOptions(options))
    .setTimeout(60)
    .build();
  transaction.sign(...signers);
  const sent = await net.server.sendTransaction(transaction);
  expect(sent.status).toBe("PENDING");
  const result = await net.server.pollTransaction(sent.hash, { attempts: 30 });
  expect(result.status).toBe("SUCCESS");
}

describe.skipIf(!available)("the sponsor's signer set on a network", () => {
  it("refuses a pubnet sponsor whose own key meets the high threshold", async () => {
    const sponsor = Keypair.random();
    await net.fund(sponsor);
    const cold = Keypair.random();
    const single = await readSignerSet(net.server, sponsor.publicKey());
    expect(() => {
      assertSignerSet(single, sponsor.publicKey(), { coldSigner: cold.publicKey() });
    }).toThrow(SignerSetError);

    // A cold signer of weight 2, the hot key at 1: the hot key meets low and medium, never high.
    await setOptions(sponsor, { signer: { ed25519PublicKey: cold.publicKey(), weight: 2 } }, [sponsor]);
    await setOptions(sponsor, { masterWeight: 1, lowThreshold: 1, medThreshold: 1, highThreshold: 2 }, [
      sponsor,
    ]);
    const split = await readSignerSet(net.server, sponsor.publicKey());
    expect(split).toMatchObject({ masterWeight: 1, thresholds: { low: 1, medium: 1, high: 2 } });
    expect(split.signers).toContainEqual({ key: cold.publicKey(), weight: 2 });
    expect(() => {
      assertSignerSet(split, sponsor.publicKey(), { coldSigner: cold.publicKey() });
    }).not.toThrow();

    // The hot key alone can no longer change the signers.
    const source = await net.server.getAccount(sponsor.publicKey());
    const attempt = new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase: net.passphrase })
      .addOperation(Operation.setOptions({ masterWeight: 2 }))
      .setTimeout(60)
      .build();
    attempt.sign(sponsor);
    const sent = await net.server.sendTransaction(attempt);
    expect(sent.status).toBe("ERROR");
  });

  it("reads hash-x signers and refuses them as the way to reach high", async () => {
    const sponsor = Keypair.random();
    await net.fund(sponsor);
    const cold = Keypair.random();
    const hashX = StrKey.encodeSha256Hash(Buffer.alloc(32, 5));
    await setOptions(sponsor, { signer: { ed25519PublicKey: cold.publicKey(), weight: 2 } }, [sponsor]);
    await setOptions(sponsor, { signer: { sha256Hash: Buffer.alloc(32, 5), weight: 1 } }, [sponsor]);
    await setOptions(sponsor, { masterWeight: 1, lowThreshold: 1, medThreshold: 1, highThreshold: 2 }, [
      sponsor,
    ]);
    const signers = await readSignerSet(net.server, sponsor.publicKey());
    expect(signers.signers).toContainEqual({ key: hashX, weight: 1 });
    // The hot key and the hash-x signer reach high together: its preimage is public once used.
    expect(() => {
      assertSignerSet(signers, sponsor.publicKey(), { coldSigner: cold.publicKey() });
    }).toThrow(/hash-x/);
  });

  it("refuses an account that does not exist", async () => {
    await expect(readSignerSet(net.server, Keypair.random().publicKey())).rejects.toBeInstanceOf(
      SignerSetError,
    );
  });
});
