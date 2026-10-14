import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Keypair, hash, xdr } from "@stellar/stellar-sdk";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  authorizationPreimage,
  decodeAuthorizationEntry,
  inspectUptoAuthorization,
  termsFromScVal,
  termsToScVal,
} from "@rail402.dev/upto";
import { checkUptoPayment } from "@rail402.dev/upto/facilitator";
import { VECTORS_PATH, renderUptoVectors, type UptoVectors } from "../scripts/vectors.ts";

const vectors = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as UptoVectors;

describe("upto test vectors", () => {
  it("are up to date with the generator", async () => {
    expect(readFileSync(VECTORS_PATH, "utf8")).toBe(await renderUptoVectors());
  });

  it("derive the parties from the published seeds", () => {
    const key = (seed: string) => Keypair.fromRawEd25519Seed(Buffer.from(seed, "hex")).publicKey();
    expect(key(vectors.seeds.payer)).toBe(vectors.payer);
    expect(key(vectors.seeds.authority)).toBe(vectors.authority);
    expect(key(vectors.seeds.recipient)).toBe(vectors.recipient);
    expect(vectors.networkId).toBe(hash(Buffer.from(vectors.networkPassphrase)).toString("hex"));
  });

  it("encode the terms as a sorted six-key map", () => {
    const value = xdr.ScVal.fromXDR(vectors.termsXdr, "base64");
    expect(value.map()?.map((entry) => entry.key().sym().toString())).toEqual([
      "expiration_ledger",
      "facilitator",
      "max_amount",
      "recipient",
      "token",
      "valid_after_ledger",
    ]);
    const terms = termsFromScVal(value);
    expect(terms).toEqual({
      ...vectors.terms,
      maxAmount: BigInt(vectors.terms.maxAmount),
    });
    if (terms === undefined) throw new Error("terms did not decode");
    expect(termsToScVal(terms).toXDR("base64")).toBe(vectors.termsXdr);
  });

  for (const credential of ["address", "address_v2"] as const) {
    it(`sign the ${credential} preimage deterministically`, () => {
      const arm = vectors.credentials[credential];
      const entry = decodeAuthorizationEntry(arm.authorization);
      const preimage = authorizationPreimage(entry, vectors.networkPassphrase);
      expect(preimage.toXDR("base64")).toBe(arm.preimageXdr);
      expect(hash(preimage.toXDR()).toString("hex")).toBe(arm.payloadSha256);
      const payer = Keypair.fromPublicKey(vectors.payer);
      expect(payer.verify(Buffer.from(arm.payloadSha256, "hex"), Buffer.from(arm.signature, "hex"))).toBe(
        true,
      );
      expect(entry.rootInvocation().toXDR("base64")).toBe(vectors.rootInvocationXdr);
      expect(entry.rootInvocation().subInvocations()[0]?.toXDR("base64")).toBe(vectors.approveInvocationXdr);

      const inspected = inspectUptoAuthorization(arm.authorization, vectors.contract);
      if (!inspected.ok) throw new Error(inspected.rejection.code);
      expect(inspected.authorization).toMatchObject({
        payer: vectors.payer,
        credential,
        nonce: BigInt(vectors.nonce),
        signatureExpirationLedger: vectors.terms.expirationLedger,
        treeValid: true,
      });
    });
  }

  it("give the settle invocation and the authority entry per amount", () => {
    for (const settle of vectors.settle) {
      const args = xdr.InvokeContractArgs.fromXDR(settle.invokeContractArgsXdr, "base64");
      expect(args.functionName().toString()).toBe("settle");
      expect(args.args()[1]?.toXDR("base64")).toBe(vectors.termsXdr);
      const entry = xdr.SorobanAuthorizationEntry.fromXDR(settle.authorityEntryXdr, "base64");
      expect(entry.credentials().switch()).toBe(xdr.SorobanCredentialsType.sorobanCredentialsSourceAccount());
      expect(entry.rootInvocation().function().contractFn().toXDR("base64")).toBe(
        settle.invokeContractArgsXdr,
      );
      expect(entry.rootInvocation().subInvocations()).toHaveLength(0);
    }
    expect(vectors.settle.map((settle) => settle.amount)).toEqual(["300000", "0"]);
  });

  it("sign the contract-account payer's entry with a raw ed25519 signature", () => {
    const arm = vectors.contractPayer;
    const entry = decodeAuthorizationEntry(arm.authorization);
    const signature = entry.credentials().address().signature();
    expect(signature.switch()).toBe(xdr.ScValType.scvBytes());
    const key = Keypair.fromRawEd25519Seed(Buffer.from(vectors.seeds.payer, "hex"));
    expect(key.rawPublicKey().toString("hex")).toBe(arm.publicKey);
    expect(key.verify(Buffer.from(arm.payloadSha256, "hex"), signature.bytes())).toBe(true);
    expect(hash(authorizationPreimage(entry, vectors.networkPassphrase).toXDR()).toString("hex")).toBe(
      arm.payloadSha256,
    );
  });

  describe("negative vectors", () => {
    const facilitatorAddresses = new Set([vectors.authority]);
    it("cover every bound field and tree shape", () => {
      expect(vectors.negatives.length).toBeGreaterThanOrEqual(30);
      expect(new Set(vectors.negatives.map((negative) => negative.name)).size).toBe(vectors.negatives.length);
    });

    for (const negative of vectors.negatives) {
      it(`${negative.name} → ${negative.expectedCode}`, () => {
        const payload: PaymentPayload = {
          x402Version: 2,
          accepted: negative.accepted as PaymentRequirements,
          payload: negative.payload,
        };
        const result = checkUptoPayment(payload, negative.requirements as PaymentRequirements, {
          phase: negative.phase,
          contract: vectors.contract,
          authority: vectors.authority,
          facilitatorAddresses,
          currentLedger: vectors.check.currentLedger,
          ledgerSeconds: vectors.check.ledgerSeconds,
          maxTimeoutSeconds: 300,
          expirationMarginLedgers: 2,
        });
        expect(result.ok ? "accepted" : result.rejection.code).toBe(negative.expectedCode);
        if (!result.ok) expect(result.rejection.reason.trim()).not.toBe("");
      });
    }

    it("accept the unmodified payment at both phases", () => {
      const requirements = vectors.check.requirements as PaymentRequirements;
      for (const phase of ["verify", "settle"] as const) {
        const result = checkUptoPayment(
          {
            x402Version: 2,
            accepted: requirements,
            payload: { authorization: vectors.credentials.address.authorization },
          },
          phase === "verify" ? requirements : { ...requirements, amount: "300000" },
          {
            phase,
            contract: vectors.contract,
            authority: vectors.authority,
            facilitatorAddresses,
            currentLedger: vectors.check.currentLedger,
            ledgerSeconds: vectors.check.ledgerSeconds,
            maxTimeoutSeconds: 300,
            expirationMarginLedgers: 2,
          },
        );
        if (!result.ok) throw new Error(result.rejection.code);
        expect(result.payment.amount).toBe(phase === "verify" ? 1_000_000n : 300_000n);
        expect(result.payment.maxAmount).toBe(1_000_000n);
      }
    });
  });
});
