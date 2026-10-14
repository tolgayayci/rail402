import { describe, expect, it } from "vitest";
import { FeeBumpTransaction, Keypair, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { encodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import { PASSPHRASE, buildTransfer, requirementsFor } from "@rail402.dev/testkit";
import { encodeAuthorizationEntry, unsignedPayerEntry } from "@rail402.dev/upto";
import type { Exchange } from "../src/forwarder.ts";
import { WireError, authorizationEntries, checkEnvelope, checkWire } from "../src/wire.ts";

const payer = Keypair.random();
const payTo = Keypair.random().publicKey();
const built = await buildTransfer({ payer, to: payTo, amount: 10_000n, expirationLedger: 500 });
const requirements = requirementsFor(built.asset, payTo, 10_000n);
const hash = "b".repeat(64);
const settlement = {
  success: true,
  transaction: hash,
  network: "stellar:testnet",
  payer: payer.publicKey(),
} as const;

const uptoRequirements = {
  ...requirements,
  scheme: "upto",
  amount: "50000",
  extra: { areFeesSponsored: true, facilitatorAddress: Keypair.random().publicKey() },
};
const authorization = encodeAuthorizationEntry(
  unsignedPayerEntry({
    contract: built.asset,
    payer: payer.publicKey(),
    nonce: 7n,
    terms: {
      expirationLedger: 500,
      facilitator: uptoRequirements.extra.facilitatorAddress,
      maxAmount: 50_000n,
      recipient: payTo,
      token: built.asset,
      validAfterLedger: 0,
    },
  }),
);

function payloadWith(inner: Record<string, unknown>, accepted: object = requirements): PaymentPayload {
  return {
    x402Version: 2,
    resource: { url: "https://seller.example/weather" },
    accepted: accepted as PaymentPayload["accepted"],
    payload: inner,
  };
}

function exchange(
  path: string,
  signed: string,
  responseBody: unknown,
  scheme: "exact" | "upto" = "exact",
  status = 200,
): Exchange {
  const accepted = scheme === "exact" ? requirements : uptoRequirements;
  return {
    method: "POST",
    path,
    requestHeaders: {},
    requestBody: {
      x402Version: 2,
      paymentPayload: payloadWith(
        scheme === "exact" ? { transaction: signed } : { authorization: signed },
        accepted,
      ),
      paymentRequirements: scheme === "exact" ? requirements : { ...uptoRequirements, amount: "20000" },
    },
    requestBytes: "",
    status,
    responseHeaders: {
      "content-type": "application/json",
      ...(path === "/settle"
        ? {
            "extension-responses": Buffer.from('{"rail402":{"settlement":{"repeat":true}}}').toString(
              "base64",
            ),
          }
        : {}),
    },
    responseBody,
    route: "forwarded",
    elapsedMs: 1,
  };
}

const capture = (overrides: { signature?: PaymentPayload; forwarded?: string; response?: unknown } = {}) => ({
  paymentSignature: encodePaymentSignatureHeader(
    overrides.signature ?? payloadWith({ transaction: built.xdr }),
  ),
  paymentResponse: encodePaymentResponseHeader(settlement),
  exchanges: [
    exchange("/verify", overrides.forwarded ?? built.xdr, { isValid: true, payer: payer.publicKey() }),
    exchange("/settle", overrides.forwarded ?? built.xdr, overrides.response ?? settlement),
  ],
});

describe("checkWire", () => {
  it("accepts a payment forwarded byte-equal, in the { transaction } shape", () => {
    const facts = checkWire(capture());
    expect(facts.signed).toBe(built.xdr);
    expect(facts.settledAmount).toBe("10000");
    expect(facts.settlement).toMatchObject(settlement);
    expect(facts.extensionResponses).toEqual({ rail402: { settlement: { repeat: true } } });
    expect([facts.verifyStatus, facts.settleStatus]).toEqual([200, 200]);
  });

  it("refuses a payload with any key besides transaction", () => {
    expect(() =>
      checkWire(capture({ signature: payloadWith({ transaction: built.xdr, memo: "x" }) })),
    ).toThrow(/payload keys/);
    expect(() => checkWire(capture({ signature: payloadWith({ tx: built.xdr }) }))).toThrow(WireError);
  });

  it("refuses a forwarded transaction that differs from the signed one", () => {
    const other = TransactionBuilder.fromXDR(built.xdr, PASSPHRASE).toEnvelope();
    other.v1().tx().fee(101);
    expect(() => checkWire(capture({ forwarded: other.toXDR("base64") }))).toThrow(
      /differs from the signed one/,
    );
  });

  it("refuses a PAYMENT-RESPONSE that is not what /settle answered", () => {
    expect(() => checkWire(capture({ response: { ...settlement, transaction: "c".repeat(64) } }))).toThrow(
      /does not match/,
    );
  });

  it("accepts an upto payment in the { authorization } shape, with the amount the seller settled", () => {
    const upto = {
      paymentSignature: encodePaymentSignatureHeader(payloadWith({ authorization }, uptoRequirements)),
      paymentResponse: encodePaymentResponseHeader({ ...settlement, amount: "20000" }),
      exchanges: [
        exchange("/verify", authorization, { isValid: true, payer: payer.publicKey() }, "upto"),
        exchange("/settle", authorization, { ...settlement, amount: "20000" }, "upto"),
      ],
    };
    const facts = checkWire(upto, "upto");
    expect(facts).toMatchObject({ scheme: "upto", signed: authorization, settledAmount: "20000" });
    // An exact check of the same traffic fails on the scheme, and a transaction is no authorization.
    expect(() => checkWire(upto)).toThrow(/paid upto, not exact/);
    expect(() =>
      checkWire(
        {
          ...upto,
          paymentSignature: encodePaymentSignatureHeader(
            payloadWith({ authorization: built.xdr }, uptoRequirements),
          ),
        },
        "upto",
      ),
    ).toThrow(/not a Soroban authorization entry/);
  });

  it("refuses a fee bump or a multi-operation transaction", async () => {
    const inner = TransactionBuilder.fromXDR(built.xdr, PASSPHRASE);
    if (inner instanceof FeeBumpTransaction) throw new Error("fixture");
    const bump = TransactionBuilder.buildFeeBumpTransaction(payer, "200", inner, PASSPHRASE);
    expect(() => {
      checkEnvelope(bump.toXDR());
    }).toThrow(/not a v1 envelope/);
    const multi = await buildTransfer({ payer, to: payTo, extraOperation: true });
    expect(() => {
      checkEnvelope(multi.xdr);
    }).toThrow(/single invokeHostFunction/);
  });
});

describe("authorizationEntries", () => {
  it("finds the payer's entry in a plain and in a fee-bumped envelope, byte for byte", () => {
    const envelope = xdr.TransactionEnvelope.fromXDR(built.xdr, "base64");
    const entries = authorizationEntries(envelope, payer.publicKey());
    expect(entries).toHaveLength(1);
    const inner = TransactionBuilder.fromXDR(built.xdr, PASSPHRASE);
    if (inner instanceof FeeBumpTransaction) throw new Error("fixture");
    const bump = TransactionBuilder.buildFeeBumpTransaction(Keypair.random(), "200", inner, PASSPHRASE);
    expect(authorizationEntries(bump.toEnvelope(), payer.publicKey())).toEqual(entries);
    expect(authorizationEntries(envelope, payTo)).toEqual([]);
  });
});
