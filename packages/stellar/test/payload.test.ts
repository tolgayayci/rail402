import { describe, expect, it } from "vitest";
import { Keypair, Transaction, TransactionBuilder, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { inspectExactTransaction, payerAuthorization } from "@rail402.dev/stellar";
import { PASSPHRASE, buildTransfer } from "@rail402.dev/testkit";

describe("inspectExactTransaction", () => {
  it("decodes a well-formed transfer and the payer's authorization", async () => {
    const built = await buildTransfer({ nonce: 7n, expirationLedger: 5_000 });
    const result = inspectExactTransaction(built.xdr, PASSPHRASE);
    if (!result.ok) throw new Error(result.code);

    const { transfer } = result;
    expect(transfer.asset).toBe(built.asset);
    expect(transfer.from).toBe(built.payer.publicKey());
    expect(transfer.to).toBe(built.to);
    expect(transfer.amount).toBe(built.amount);
    expect(transfer.otherCredentials).toBe(0);
    expect(transfer.hasUnsupportedPreconditions).toBe(false);
    expect(payerAuthorization(transfer)).toEqual({
      address: built.payer.publicKey(),
      credential: "address",
      nonce: 7n,
      signatureExpirationLedger: 5_000,
      signed: true,
      subInvocations: 0,
      matchesOperation: true,
    });
  });

  it("recognises CAP-71 V2 address credentials", async () => {
    const built = await buildTransfer({ credential: "address_v2", sign: false });
    const result = inspectExactTransaction(built.xdr, PASSPHRASE);
    if (!result.ok) throw new Error(result.code);
    expect(result.transfer.authorizations[0]?.credential).toBe("address_v2");
    expect(result.transfer.authorizations[0]?.signed).toBe(false);
  });

  it("counts source-account credentials separately", async () => {
    const built = await buildTransfer({ credential: "source_account" });
    const result = inspectExactTransaction(built.xdr, PASSPHRASE);
    if (!result.ok) throw new Error(result.code);
    expect(result.transfer.authorizations).toHaveLength(0);
    expect(result.transfer.otherCredentials).toBe(1);
  });

  it("flags an authorization whose invocation differs from the operation", async () => {
    const built = await buildTransfer({
      editAuthorizedCall: (call) => {
        call.args()[2] = nativeToScVal(1n, { type: "i128" });
        return call;
      },
    });
    const result = inspectExactTransaction(built.xdr, PASSPHRASE);
    if (!result.ok) throw new Error(result.code);
    expect(payerAuthorization(result.transfer)?.matchesOperation).toBe(false);
  });

  it("reports sub-invocations and preconditions", async () => {
    const built = await buildTransfer({ subInvocation: true, ledgerBounds: { minLedger: 1, maxLedger: 0 } });
    const result = inspectExactTransaction(built.xdr, PASSPHRASE);
    if (!result.ok) throw new Error(result.code);
    expect(payerAuthorization(result.transfer)?.subInvocations).toBe(1);
    expect(result.transfer.hasUnsupportedPreconditions).toBe(true);
  });

  it.each([
    ["an empty string", ""],
    ["a non-string", 42],
    ["garbage", "not-xdr"],
  ])("rejects %s as malformed", (_label, value) => {
    expect(inspectExactTransaction(value, PASSPHRASE)).toMatchObject({
      ok: false,
      code: "invalid_exact_stellar_payload_malformed",
    });
  });

  it("rejects an oversized payload before decoding it", () => {
    expect(inspectExactTransaction("A".repeat(64 * 1024 + 4), PASSPHRASE)).toEqual({
      ok: false,
      code: "invalid_exact_stellar_payload_too_large",
    });
  });

  it("rejects a fee-bump envelope", async () => {
    const built = await buildTransfer();
    const inner = new Transaction(built.xdr, PASSPHRASE);
    const sponsor = Keypair.random();
    const bump = TransactionBuilder.buildFeeBumpTransaction(sponsor, "200", inner, PASSPHRASE);
    expect(inspectExactTransaction(bump.toXDR(), PASSPHRASE)).toMatchObject({
      ok: false,
      code: "invalid_exact_stellar_payload_malformed",
    });
  });

  it("rejects more than one operation", async () => {
    const built = await buildTransfer({ extraOperation: true });
    expect(inspectExactTransaction(built.xdr, PASSPHRASE)).toMatchObject({
      ok: false,
      code: "invalid_exact_stellar_payload_wrong_operation",
    });
  });

  it("rejects a transfer whose amount is not an i128", async () => {
    const built = await buildTransfer();
    const envelope = xdr.TransactionEnvelope.fromXDR(built.xdr, "base64");
    const call = envelope
      .v1()
      .tx()
      .operations()[0]
      ?.body()
      .invokeHostFunctionOp()
      .hostFunction()
      .invokeContract();
    if (!call) throw new Error("fixture");
    call.args()[2] = nativeToScVal(5, { type: "u64" });
    expect(inspectExactTransaction(envelope.toXDR("base64"), PASSPHRASE)).toMatchObject({
      ok: false,
      code: "invalid_exact_stellar_payload_wrong_function_name",
    });
  });

  it("rejects a call to a function other than transfer", async () => {
    const built = await buildTransfer();
    const envelope = xdr.TransactionEnvelope.fromXDR(built.xdr, "base64");
    const call = envelope
      .v1()
      .tx()
      .operations()[0]
      ?.body()
      .invokeHostFunctionOp()
      .hostFunction()
      .invokeContract();
    if (!call) throw new Error("fixture");
    call.functionName("approve");
    expect(inspectExactTransaction(envelope.toXDR("base64"), PASSPHRASE)).toMatchObject({
      ok: false,
      code: "invalid_exact_stellar_payload_wrong_function_name",
    });
  });
});
