import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { KeyHolder, type Sep43AuthSigner } from "@rail402.dev/sdk/browser";
import type { AuthorizationView } from "../../src/engine/events.ts";
import { tapSigner } from "../../src/wallet/signer.ts";
import { PAY_TO, UPTO_CONTRACT, USDC_CONTRACT, exactPreimage, uptoPreimage } from "../engine/helpers.ts";

function tapped(key: Sep43AuthSigner, latest: number | null = 1_000) {
  const views: AuthorizationView[] = [];
  const signer = tapSigner(key, {
    network: "stellar:testnet",
    uptoContracts: [UPTO_CONTRACT],
    latestLedger: () => latest,
    onAuthorization: (view) => views.push(view),
  });
  return { signer, views };
}

describe("signer tap", () => {
  it("reports the decoded exact transfer after the key signed, and returns the signature unchanged", async () => {
    const key = KeyHolder.random();
    const preimage = exactPreimage({
      payer: key.address,
      payTo: PAY_TO,
      amount: 10_000n,
      nonce: 42n,
      expiration: 1_012,
    });
    const { signer, views } = tapped(key);
    const signed = await signer.signAuthEntry(preimage);
    expect(signed).toEqual(await key.signAuthEntry(preimage));
    expect(views).toEqual([
      {
        network: "stellar:testnet",
        address: key.address,
        credential: "address",
        nonce: "42",
        expirationLedger: 1_012,
        latestLedger: 1_000,
        expiresInSeconds: 60,
        scheme: "exact",
        transfer: { contract: USDC_CONTRACT, from: key.address, to: PAY_TO, amount: "10000" },
      },
    ]);
    // The view carries decoded facts only: neither the preimage nor the signature.
    const text = JSON.stringify(views);
    expect(text).not.toContain(preimage);
    expect(text).not.toContain(signed.signedAuthEntry);
  });

  it("reports upto terms and the approve the contract may use", async () => {
    const key = KeyHolder.random();
    const facilitator = Keypair.random().publicKey();
    const terms = {
      expirationLedger: 1_100,
      facilitator,
      maxAmount: 100_000n,
      recipient: PAY_TO,
      token: USDC_CONTRACT,
      validAfterLedger: 0,
    };
    const { signer, views } = tapped(key, null);
    await signer.signAuthEntry(uptoPreimage({ payer: key.address, terms, nonce: 7n }));
    expect(views[0]).toMatchObject({
      scheme: "upto",
      contract: UPTO_CONTRACT,
      nonce: "7",
      latestLedger: null,
      expiresInSeconds: null,
      terms: {
        recipient: PAY_TO,
        token: USDC_CONTRACT,
        maxAmount: "100000",
        facilitator,
        expirationLedger: 1_100,
      },
      approve: {
        token: USDC_CONTRACT,
        from: key.address,
        spender: UPTO_CONTRACT,
        amount: "100000",
        expirationLedger: 1_100,
      },
    });
  });

  it("reports nothing when the key refused or failed", async () => {
    const failing: Sep43AuthSigner = {
      address: Keypair.random().publicKey(),
      signAuthEntry: () => Promise.reject(new Error("refused")),
    };
    const { signer, views } = tapped(failing);
    await expect(signer.signAuthEntry("AAAA")).rejects.toThrow("refused");
    const erroring: Sep43AuthSigner = {
      address: failing.address,
      signAuthEntry: () => Promise.resolve({ signedAuthEntry: "", error: { code: -4 } }),
    };
    const second = tapped(erroring);
    await second.signer.signAuthEntry(
      exactPreimage({ payer: failing.address, payTo: PAY_TO, amount: 1n, nonce: 1n, expiration: 9 }),
    );
    expect([...views, ...second.views]).toEqual([]);
  });
});
