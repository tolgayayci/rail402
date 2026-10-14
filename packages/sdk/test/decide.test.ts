import { describe, expect, it } from "vitest";
import { Account, Keypair, MuxedAccount, Networks, xdr } from "@stellar/stellar-sdk";
import { MAX_PREIMAGE_BASE64, TESTNET } from "@rail402.dev/stellar";
import { decideSpend, exactScheme, type DecideContext, type SpendExpectation } from "@rail402.dev/sdk";
import { LATEST, invocation, preimage, testPolicy, usdc, type PreimageOptions } from "./helpers.ts";

const payer = Keypair.random().publicKey();
const payTo = Keypair.random().publicKey();

const expectation: SpendExpectation = {
  scheme: "exact",
  network: TESTNET,
  asset: usdc,
  payTo,
  amount: 50_000n,
  maxTimeoutSeconds: 60,
  effectiveCap: 100_000n,
};

async function context(overrides: Partial<DecideContext> = {}): Promise<DecideContext> {
  return {
    network: TESTNET,
    policy: await testPolicy(),
    adapters: [exactScheme()],
    signerAddress: payer,
    latestLedger: LATEST,
    expectation,
    ...overrides,
  };
}

const image = (overrides: Partial<PreimageOptions> = {}) =>
  preimage({ payer, to: payTo, amount: 50_000n, ...overrides });

describe("decideSpend", () => {
  it("accepts the armed payment and describes its intent", async () => {
    const decision = decideSpend(image({ nonce: 42n, expiration: LATEST + 30 }), await context());
    expect(decision).toMatchObject({
      ok: true,
      intent: {
        scheme: "exact",
        network: TESTNET,
        contract: usdc,
        asset: usdc,
        payer,
        recipient: payTo,
        maxAmount: 50_000n,
        nonce: 42n,
        expirationLedger: LATEST + 30,
        credential: "address",
      },
    });
  });

  it("accepts a V2 preimage bound to the signer and refuses one bound to another address", async () => {
    expect(decideSpend(image({ credential: "address_v2" }), await context())).toMatchObject({ ok: true });
    expect(
      decideSpend(
        image({ credential: "address_v2", boundAddress: Keypair.random().publicKey() }),
        await context(),
      ),
    ).toMatchObject({ ok: false, code: "payment_authorization_rejected" });
  });

  it("refuses anything that is not a Soroban authorization preimage", async () => {
    const other = xdr.HashIdPreimage.envelopeTypeContractId(
      new xdr.HashIdPreimageContractId({
        networkId: Buffer.alloc(32),
        contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAsset(xdr.Asset.assetTypeNative()),
      }),
    ).toXDR("base64");
    const ctx = await context();
    for (const bytes of [other, "", "not base64!", image() + "AAAA", "A".repeat(MAX_PREIMAGE_BASE64 + 4)]) {
      expect(decideSpend(bytes, ctx)).toMatchObject({ ok: false, code: "payment_authorization_rejected" });
    }
  });

  it("refuses another network, whether in the preimage or in the requested passphrase", async () => {
    expect(decideSpend(image({ passphrase: Networks.PUBLIC }), await context())).toMatchObject({
      ok: false,
      code: "payment_network_not_permitted",
    });
    expect(
      decideSpend(image(), await context({ requested: { networkPassphrase: Networks.PUBLIC } })),
    ).toMatchObject({ ok: false, code: "payment_network_not_permitted" });
  });

  it("refuses a transfer from an account other than the signer", async () => {
    const decision = decideSpend(image({ payer: Keypair.random().publicKey() }), await context());
    expect(decision).toMatchObject({ ok: false, code: "payment_authorization_rejected" });
  });

  it("fails closed on shapes no enabled scheme understands", async () => {
    const ctx = await context();
    const settle = image({
      fn: "settle",
      subInvocations: [
        invocation({ payer, to: payTo, amount: 1n, fn: "approve" }),
        invocation({ payer, to: payTo, amount: 0n, fn: "approve" }),
      ],
    });
    expect(decideSpend(settle, ctx)).toMatchObject({ ok: false, code: "payment_authorization_rejected" });
    expect(decideSpend(image({ args: [] }), ctx)).toMatchObject({
      ok: false,
      code: "payment_authorization_rejected",
    });
    expect(decideSpend(image(), { ...ctx, adapters: [] })).toMatchObject({
      ok: false,
      code: "payment_authorization_rejected",
    });
  });

  it("compares the armed recipient verbatim: a muxed recipient stays muxed", async () => {
    const muxed = new MuxedAccount(new Account(payTo, "0"), "7").accountId();
    const ctx = await context({ expectation: { ...expectation, payTo: muxed } });
    expect(decideSpend(image({ to: muxed }), ctx)).toMatchObject({ ok: true, intent: { recipient: muxed } });
    expect(decideSpend(image({ to: payTo }), ctx)).toMatchObject({
      ok: false,
      code: "payment_authorization_rejected",
    });
  });

  it("repeats the policy checks on the signed bytes", async () => {
    const policy = await testPolicy({ recipients: { deny: [payTo] } });
    expect(decideSpend(image(), await context({ policy }))).toMatchObject({
      ok: false,
      code: "payment_recipient_not_permitted",
    });
    const self = await context({ expectation: { ...expectation, payTo: payer } });
    expect(decideSpend(image({ to: payer }), self)).toMatchObject({
      ok: false,
      code: "payment_recipient_not_permitted",
    });
    const lowCap = await context({ expectation: { ...expectation, effectiveCap: 49_999n } });
    expect(decideSpend(image(), lowCap)).toMatchObject({ ok: false, code: "payment_per_call_cap_exceeded" });
  });

  it("bounds the expiry by the lower of the option's timeout and the policy's window", async () => {
    // 60 s at the fastest assumed close time (2 s) is 30 ledgers, plus 2 of tolerance.
    const ctx = await context();
    expect(decideSpend(image({ expiration: LATEST + 32 }), ctx)).toMatchObject({ ok: true });
    expect(decideSpend(image({ expiration: LATEST + 33 }), ctx)).toMatchObject({
      ok: false,
      code: "payment_authorization_window_not_permitted",
    });
    expect(decideSpend(image({ expiration: LATEST }), ctx)).toMatchObject({
      ok: false,
      code: "payment_authorization_window_not_permitted",
    });
    const tight = await context({ policy: await testPolicy({ maxAuthorizationSeconds: 10 }) });
    expect(decideSpend(image({ expiration: LATEST + 8 }), tight)).toMatchObject({
      ok: false,
      code: "payment_authorization_window_not_permitted",
    });
  });

  it("in policy-only mode uses the operator ceiling and the policy window", async () => {
    const ctx = await context({ expectation: undefined });
    expect(decideSpend(image({ amount: 1_000_000n, expiration: LATEST + 152 }), ctx)).toMatchObject({
      ok: true,
    });
    expect(decideSpend(image({ amount: 1_000_001n }), ctx)).toMatchObject({
      ok: false,
      code: "payment_per_call_cap_exceeded",
    });
    expect(decideSpend(image({ expiration: LATEST + 153 }), ctx)).toMatchObject({
      ok: false,
      code: "payment_authorization_window_not_permitted",
    });
  });

  it("refuses when the scheme is not enabled in the policy", async () => {
    const policy = await testPolicy({ schemes: ["upto"] });
    expect(decideSpend(image(), await context({ policy }))).toMatchObject({
      ok: false,
      code: "payment_authorization_rejected",
    });
  });
});
