import { describe, it, expect } from "vitest";
import type { PaymentPayload } from "@x402/core/types";
import { ATTACKS, runAttack } from "./attacks.js";

/**
 * A real signed-shape payload: the transaction is a genuine invokeHostFunction with one
 * address-credential auth entry (built with @stellar/stellar-sdk), so the XDR-surgery attacks that
 * decode and rebuild it exercise the real code path rather than a stub.
 */
const REAL_TX =
  "AAAAAgAAAACTSUYmrLYo6vHA11HBq57Y1K1oFc9XXRUrszOMwfy9eQAAA+gAAAAAAAAAZQAAAAEAAAAAAAAAAAAAAABqfhFGAAAAAAAAAAEAAAAAAAAAGAAAAAAAAAABmM2VhiH+U8cXzu0BwFNFh3NkJrfHyk/tUffJUgAWBboAAAAIdHJhbnNmZXIAAAABAAAACgAAAAAAAAAAAAAAAAAAAAEAAAABAAAAAQAAAAAAAAAAk0lGJqy2KOrxwNdRwaue2NStaBXPV10VK7MzjMH8vXkAAAAAAAAwOQAPQj8AAAAQAAAAAQAAAAAAAAAAAAAAAZjNlYYh/lPHF87tAcBTRYdzZCa3x8pP7VH3yVIAFgW6AAAACHRyYW5zZmVyAAAAAQAAAAoAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAA";

function signed(): PaymentPayload {
  return {
    x402Version: 2,
    accepted: {
      scheme: "exact",
      network: "stellar:testnet",
      asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      amount: "500000",
      payTo: "GBRVXNCL55KOEB7WU3BPSEL34PSUH63UCIFPZDUBIVJBRRG5ZB7V4YR7",
      maxTimeoutSeconds: 60,
      extra: {},
    },
    payload: { transaction: REAL_TX },
  };
}

describe("attack catalog", () => {
  it("covers the rejection-audit corruptions with expected codes", () => {
    const ids = ATTACKS.map(a => a.id);
    for (const id of [
      "tampered-amount",
      "wrong-recipient",
      "wrong-asset",
      "malformed-transaction",
      "stripped-auth-entries",
      "auth-entry-signature-cleared",
      "unserved-network",
      "unsupported-scheme",
      "replay",
    ]) {
      expect(ids, `missing attack: ${id}`).toContain(id);
    }
    for (const attack of ATTACKS) {
      expect(attack.expectedCodes.length, `${attack.id} has no expected code`).toBeGreaterThan(0);
      expect(attack.title.length).toBeGreaterThan(0);
      expect(attack.description.length).toBeGreaterThan(0);
    }
  });

  it("tampered-amount doubles the requirements amount and leaves the payload signed", () => {
    const req = ATTACKS.find(a => a.id === "tampered-amount")!.build(signed());
    expect(req.paymentRequirements.amount).toBe("1000000");
    expect(req.target).toBe("verify");
    // The payload — the signed part — is untouched.
    expect((req.paymentPayload.payload as { transaction: string }).transaction).toBe(REAL_TX);
  });

  it("wrong-recipient rewrites payTo to a different valid address", () => {
    const req = ATTACKS.find(a => a.id === "wrong-recipient")!.build(signed());
    expect(req.paymentRequirements.payTo).not.toBe(signed().accepted.payTo);
    expect(req.paymentRequirements.payTo).toMatch(/^G/);
  });

  it("malformed-transaction replaces the XDR with garbage", () => {
    const req = ATTACKS.find(a => a.id === "malformed-transaction")!.build(signed());
    expect((req.paymentPayload.payload as { transaction: string }).transaction).toBe("not-base64-xdr");
  });

  it("stripped-auth-entries rebuilds the transaction with no auth, changing the XDR", () => {
    const req = ATTACKS.find(a => a.id === "stripped-auth-entries")!.build(signed());
    const tx = (req.paymentPayload.payload as { transaction: string }).transaction;
    expect(tx).not.toBe(REAL_TX);
    expect(tx.length).toBeGreaterThan(0);
  });

  it("auth-entry-signature-cleared decodes and rebuilds into valid XDR, keeping the auth entry", () => {
    const req = ATTACKS.find(a => a.id === "auth-entry-signature-cleared")!.build(signed());
    const tx = (req.paymentPayload.payload as { transaction: string }).transaction;
    // The transform decodes the auth tree, blanks each signature, and rebuilds — it must yield
    // parseable base64 XDR and keep the payload targeting verify. (The fixture's signature is
    // already empty, so blanking is idempotent here; `stripped-auth-entries` above proves the
    // rebuild path changes the XDR when there is something to remove.)
    expect(() => atob(tx)).not.toThrow();
    expect(tx.length).toBeGreaterThan(0);
    expect(req.target).toBe("verify");
  });

  it("replay targets settle with the payload and requirements unchanged", () => {
    const req = ATTACKS.find(a => a.id === "replay")!.build(signed());
    expect(req.target).toBe("settle");
    expect(req.paymentRequirements.amount).toBe(signed().accepted.amount);
  });
});

describe("runAttack normalizes verify and settle refusals", () => {
  const fakeFetch = (body: unknown, ok = true): typeof fetch =>
    (async () => new Response(JSON.stringify(body), { status: ok ? 200 : 400 })) as typeof fetch;

  it("reads a verify refusal (isValid:false) as refused, matching the expected code", async () => {
    const attack = ATTACKS.find(a => a.id === "tampered-amount")!;
    const outcome = await runAttack(
      "http://pg.test",
      attack,
      signed(),
      fakeFetch({
        isValid: false,
        invalidReason: "invalid_exact_stellar_payload_wrong_amount",
        invalidMessage: "The amount does not match the signed transfer.",
      }),
    );
    expect(outcome.refused).toBe(true);
    expect(outcome.code).toBe("invalid_exact_stellar_payload_wrong_amount");
    expect(outcome.asExpected).toBe(true);
    expect(outcome.reason).toContain("does not match");
  });

  it("reads a settle refusal (success:false) as refused", async () => {
    const attack = ATTACKS.find(a => a.id === "replay")!;
    const outcome = await runAttack(
      "http://pg.test",
      attack,
      signed(),
      fakeFetch({
        success: false,
        errorReason: "invalid_exact_stellar_payload_authorization_replayed",
        errorMessage: "This authorization was already used.",
      }),
    );
    expect(outcome.refused).toBe(true);
    expect(outcome.asExpected).toBe(true);
  });

  it("flags an attack that was NOT refused — the failure the scene exists to catch", async () => {
    const attack = ATTACKS.find(a => a.id === "tampered-amount")!;
    const outcome = await runAttack("http://pg.test", attack, signed(), fakeFetch({ isValid: true }));
    expect(outcome.refused).toBe(false);
    expect(outcome.asExpected).toBe(false);
  });
});
