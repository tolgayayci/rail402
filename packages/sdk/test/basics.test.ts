import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { Account, Keypair, MuxedAccount, StrKey, hash } from "@stellar/stellar-sdk";
import { httpCodes, mergeCodes } from "@rail402.dev/errors";
import { EgressError } from "@rail402.dev/safe-fetch";
import { PUBNET, TESTNET, exactStellarCodes } from "@rail402.dev/stellar";
import { asPaymentError } from "../src/flow/common.ts";
import {
  KeyHolder,
  PaymentError,
  agentCodes,
  defaultPaid,
  explorerTemplate,
  explorerUrl,
  loadSigner,
  paymentError,
  parseAtomic,
  parseMoney,
  redact,
  redactDeep,
  requireNetwork,
  sanitizeJson,
  sanitizeText,
  toAtomic,
  toDecimal,
} from "@rail402.dev/sdk";

const scratch = mkdtempSync(join(tmpdir(), "rail402-keys-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("codes", () => {
  it("never clashes with the facilitator's codes", () => {
    expect(() => mergeCodes(agentCodes, exactStellarCodes, httpCodes)).not.toThrow();
  });

  it("marks only refusals before sending as retryable with nothing paid", () => {
    for (const [code, spec] of Object.entries(agentCodes)) {
      const paid = defaultPaid[code as keyof typeof agentCodes];
      if (spec.retryable && code !== "payment_in_progress") expect(paid, code).toBe("none");
    }
    expect(defaultPaid.payment_rejected).toBe("not_settled");
    expect(defaultPaid.payment_resource_failed).toBe("settled");
    expect(defaultPaid.payment_settlement_unconfirmed).toBe("unknown");
    expect(defaultPaid.payment_in_progress).toBe("unknown");
  });

  it("carries paid, a call id and a redacted reason", () => {
    const seed = Keypair.random().secret();
    const error = paymentError("payment_simulation_failed", {
      reason: `upstream said ${seed}`,
      details: { upstream: { message: `key ${seed}` } },
      callId: "c-1",
    });
    expect(error).toBeInstanceOf(PaymentError);
    expect(error).toMatchObject({
      code: "payment_simulation_failed",
      paid: "none",
      retryable: true,
      callId: "c-1",
    });
    expect(JSON.stringify([error.reason, error.message, error.details])).not.toContain(seed);
    expect(paymentError("payment_rejected", { paid: "unknown" }).paid).toBe("unknown");
    expect(paymentError("payment_rejected").reason).not.toBe("");
  });
});

describe("money", () => {
  it("converts decimals to base units without rounding", () => {
    expect(toAtomic("0.05", 7)).toBe(500_000n);
    expect(toAtomic("12", 7)).toBe(120_000_000n);
    expect(toAtomic("0.0000001", 7)).toBe(1n);
    expect(toAtomic("1.000000000000000001", 18)).toBe(1_000_000_000_000_000_001n);
    for (const bad of ["0.00000001", "01", "1.", ".5", "-1", "1e2", " 1", "0x10", "", "1,5"]) {
      expect(toAtomic(bad, 7), bad).toBeUndefined();
    }
    expect(toAtomic("1", 39)).toBeUndefined();
    expect(toAtomic("9".repeat(40), 0)).toBeUndefined();
  });

  it("formats base units without trailing zeros", () => {
    expect(toDecimal(500_000n, 7)).toBe("0.05");
    expect(toDecimal(120_000_000n, 7)).toBe("12");
    expect(toDecimal(1n, 7)).toBe("0.0000001");
    expect(toDecimal(0n, 6)).toBe("0");
    expect(toDecimal(-5n, 1)).toBe("-0.5");
  });

  it("parses x402 integer amounts and configured caps strictly", () => {
    expect(parseAtomic("10000")).toBe(10_000n);
    for (const bad of ["1.0", "-1", "01", "", 5, null, (1n << 127n).toString()])
      expect(parseAtomic(bad)).toBeUndefined();
    expect(parseMoney("0.10 USDC")).toEqual({ amount: "0.10", asset: "USDC" });
    expect(parseMoney(" 0.10 ")).toEqual({ amount: "0.10" });
    expect(parseMoney("ten USDC")).toBeUndefined();
    expect(parseMoney("1 USDC extra")).toBeUndefined();
  });
});

describe("redaction", () => {
  it("removes seeds, even glued to other text, and long base64 or hex runs", () => {
    const seed = Keypair.random().secret();
    const hex = Buffer.from(StrKey.decodeEd25519SecretSeed(seed)).toString("hex");
    const base64 = Buffer.alloc(48, 7).toString("base64");
    const text = `a ${seed} b key=${seed}x c ${hex} d ${base64} e ${hash(Buffer.from("x")).toString("hex")}`;
    const clean = redact(text);
    expect(clean).not.toContain(seed);
    expect(clean).not.toContain(hex);
    expect(clean).not.toContain(base64);
    expect(clean.match(/\[redacted\]/g)).toHaveLength(5);
  });

  it("removes a seed glued after other base32 characters", () => {
    for (const prefix of ["S", "SA", "KEYS", "SS2"]) {
      const seed = Keypair.random().secret();
      const clean = redact(`x ${prefix}${seed} y`);
      expect(clean).not.toContain(seed);
      expect(clean).toBe(`x ${prefix}[redacted] y`);
    }
    const [first, second] = [Keypair.random().secret(), Keypair.random().secret()];
    expect(redact(first.slice(0, 3) + second)).toBe(`${first.slice(0, 3)}[redacted]`);
  });

  it("keeps public addresses", () => {
    const account = Keypair.random().publicKey();
    const muxed = new MuxedAccount(new Account(account, "0"), "7").accountId();
    const contract = StrKey.encodeContract(Buffer.alloc(32, 3));
    const text = `pay ${account} ${muxed} via ${contract}`;
    expect(redact(text)).toBe(text);
  });

  it("redacts nested values and strips control characters from untrusted text", () => {
    const seed = Keypair.random().secret();
    expect(JSON.stringify(redactDeep({ a: [{ b: seed }], n: 5 }))).toBe('{"a":[{"b":"[redacted]"}],"n":5}');
    expect(sanitizeText("ok\u0007‮good\u0000", 100)).toBe("okgood");
    expect(sanitizeText("abcdef", 3)).toBe("abc…");
  });

  it("drops seller JSON nested deeper than it cleans", () => {
    let deep: unknown = "a\u202Eb";
    for (let level = 0; level < 40; level++) deep = { next: deep };
    const clean = JSON.stringify(sanitizeJson(deep, 100));
    expect(clean).not.toContain("\u202E");
    expect(clean).not.toContain("\u202e");
    expect(clean).toContain("null");
    expect(sanitizeJson({ a: ["x\u200By"] }, 100)).toEqual({ a: ["xy"] });
  });
});

describe("KeyHolder", () => {
  it("signs a preimage and never shows its seed", async () => {
    const pair = Keypair.random();
    const holder = KeyHolder.fromSecret(pair.secret());
    const image = Buffer.from("preimage bytes").toString("base64");
    const { signedAuthEntry, signerAddress } = await holder.signAuthEntry(image);
    expect(signerAddress).toBe(pair.publicKey());
    expect(pair.verify(hash(Buffer.from(image, "base64")), Buffer.from(signedAuthEntry, "base64"))).toBe(
      true,
    );
    for (const shown of [
      JSON.stringify(holder),
      inspect(holder),
      String(holder),
      inspect({ holder }, { depth: 5 }),
    ]) {
      expect(shown).toContain(pair.publicKey());
      expect(shown).not.toContain(pair.secret());
    }
    // Works unbound, as the upstream client calls it.
    const { signAuthEntry } = holder;
    await expect(signAuthEntry(image)).resolves.toMatchObject({ signerAddress: pair.publicKey() });
  });

  it("reads a private key file and refuses a shared one", async () => {
    const pair = Keypair.random();
    const path = join(scratch, "buyer.key");
    writeFileSync(path, `${pair.secret()}\n`, { mode: 0o600 });
    expect((await KeyHolder.fromFile(path)).address).toBe(pair.publicKey());
    expect((await loadSigner({ secretFile: path })).address).toBe(pair.publicKey());
    if (process.platform !== "win32") {
      chmodSync(path, 0o644);
      await expect(KeyHolder.fromFile(path)).rejects.toMatchObject({ code: "key_file_insecure" });
    }
    await expect(KeyHolder.fromFile(join(scratch, "missing.key"))).rejects.toMatchObject({
      code: "key_not_found",
    });
    await expect(KeyHolder.fromFile(scratch)).rejects.toMatchObject({ code: "key_not_found" });
    const garbage = join(scratch, "garbage.key");
    writeFileSync(garbage, "SNOTAKEY", { mode: 0o600 });
    const refused = await KeyHolder.fromFile(garbage).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: "key_invalid" });
    expect(JSON.stringify(refused)).not.toContain("SNOTAKEY");
  });

  it("takes the seed from the environment and removes it", () => {
    const pair = Keypair.random();
    const env: Record<string, string | undefined> = { RAIL402_SECRET_KEY: pair.secret(), OTHER: "1" };
    expect(KeyHolder.fromEnv(env)?.address).toBe(pair.publicKey());
    expect(env).toEqual({ OTHER: "1" });
    expect(KeyHolder.fromEnv(env)).toBeUndefined();
    expect(() => KeyHolder.fromEnv({ RAIL402_SECRET_KEY: "nope" })).toThrow(
      expect.objectContaining({ code: "key_invalid" }),
    );
  });
});

describe("networks and explorer links", () => {
  it("has no default network", () => {
    expect(requireNetwork(TESTNET)).toBe(TESTNET);
    expect(() => requireNetwork(undefined)).toThrow(
      expect.objectContaining({ code: "payment_policy_invalid" }),
    );
    expect(() => requireNetwork("stellar:futurenet")).toThrow(
      expect.objectContaining({ code: "payment_policy_invalid" }),
    );
  });

  it("links transactions on stellar.expert or a template", () => {
    const tx = "AB".repeat(32);
    expect(explorerUrl(TESTNET, tx)).toBe(`https://stellar.expert/explorer/testnet/tx/${"ab".repeat(32)}`);
    expect(explorerUrl(PUBNET, tx)).toBe(`https://stellar.expert/explorer/public/tx/${"ab".repeat(32)}`);
    const template = explorerTemplate("https://explorer.example/{network}/tx/{hash}");
    expect(explorerUrl(TESTNET, tx, template)).toBe(`https://explorer.example/testnet/tx/${"ab".repeat(32)}`);
    expect(() => explorerUrl(TESTNET, "abc")).toThrow(
      expect.objectContaining({ code: "transaction_hash_invalid" }),
    );
    expect(() => explorerTemplate("http://explorer.example/{hash}")).toThrow();
    expect(() => explorerTemplate("https://explorer.example/tx")).toThrow();
  });
});

describe("transport errors", () => {
  it("keep their code, stage and details when they become a payment error", () => {
    const egress = new EgressError("egress_connection_failed", "connect", {
      reason: "The relay refused the request: rate limited.",
      details: { relay: "playground_rate_limited" },
    });
    const wrapped = asPaymentError(egress, "call-1");
    expect(wrapped).toBeInstanceOf(PaymentError);
    expect(wrapped).toMatchObject({
      code: "egress_connection_failed",
      callId: "call-1",
      details: { relay: "playground_rate_limited", stage: "connect" },
    });
  });
});
