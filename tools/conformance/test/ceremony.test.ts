import { Keypair, Networks, Transaction, type Operation } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { signEnvelope } from "../../../deploy/stellar-keys.ts";
import {
  SIGNER_PLAN,
  buildFreeze,
  buildSignerSetup,
  buildSweep,
  buildTopUp,
  reviewOf,
  reviewSummary,
  seedFromFile,
  signerSetProblems,
} from "../../../deploy/keys/ceremony.ts";

const hot = Keypair.random();
const cold = Keypair.random();
const planned = {
  masterWeight: SIGNER_PLAN.hotWeight,
  low: SIGNER_PLAN.low,
  medium: SIGNER_PLAN.medium,
  high: SIGNER_PLAN.high,
  signers: { [cold.publicKey()]: SIGNER_PLAN.coldWeight },
};

describe("the sponsor's signer set", () => {
  it("leaves high to the cold key alone and medium to the hot key", () => {
    expect(SIGNER_PLAN.hotWeight).toBeGreaterThanOrEqual(SIGNER_PLAN.medium);
    expect(SIGNER_PLAN.hotWeight).toBeLessThan(SIGNER_PLAN.high);
    expect(SIGNER_PLAN.coldWeight).toBeGreaterThanOrEqual(SIGNER_PLAN.high);
    expect(signerSetProblems(planned, cold.publicKey())).toEqual([]);
  });

  it("refuses a pubnet sponsor whose own key meets the high threshold", () => {
    expect(signerSetProblems({ ...planned, masterWeight: 20 }, cold.publicKey())).toEqual([
      "the hot key alone meets the high threshold",
    ]);
    expect(signerSetProblems({ ...planned, signers: {} }, cold.publicKey())).toEqual([
      "the cold treasury key is not a signer",
    ]);
    const other = Keypair.random().publicKey();
    expect(
      signerSetProblems(
        { ...planned, low: 0, signers: { ...planned.signers, [other]: 5 } },
        cold.publicKey(),
      ),
    ).toEqual([
      "the low threshold is 0, so any signer weight passes it",
      `an unexpected signer ${other} holds weight`,
    ]);
    // A low threshold above the hot key's weight would stop it from fee-bumping settlements.
    expect(signerSetProblems({ ...planned, low: 11, medium: 10 }, cold.publicKey())).toEqual([
      "the hot key cannot meet the low threshold it needs to fee-bump",
    ]);
  });

  it("builds the setup as two set-options operations from the sponsor, with a review", () => {
    const tx = buildSignerSetup({ id: hot.publicKey(), sequence: "100" }, cold.publicKey(), "pubnet");
    expect(tx.networkPassphrase).toBe(Networks.PUBLIC);
    expect(tx.source).toBe(hot.publicKey());
    const ops = tx.operations as Operation.SetOptions[];
    expect(ops.map((op) => op.type)).toEqual(["setOptions", "setOptions"]);
    expect(ops[1]).toMatchObject({ masterWeight: 10, lowThreshold: 1, medThreshold: 10, highThreshold: 20 });
    const summary = reviewSummary(reviewOf(tx, "pubnet"));
    expect(summary).toContain(`signer ${cold.publicKey()} weight 20`);
    expect(summary).toContain("network     pubnet (Public Global Stellar Network ; September 2015)");
    expect(summary).toContain(`tx hash     ${tx.hash().toString("hex")}`);
    expect(() => buildSignerSetup({ id: hot.publicKey(), sequence: "1" }, hot.publicKey(), "pubnet")).toThrow(
      /different account/,
    );
  });
});

describe("a top-up from the treasury", () => {
  it("records a cold-to-hot top-up with its reviewed summary", () => {
    const tx = buildTopUp(
      { id: cold.publicKey(), sequence: "7" },
      hot.publicKey(),
      hot.publicKey(),
      "50",
      "pubnet",
    );
    const review = reviewOf(tx, "pubnet");
    expect(review.operations).toEqual([`payment of 50.0000000 XLM to ${hot.publicKey()}`]);
    expect(review.source).toBe(cold.publicKey());
    // The unsigned envelope round-trips to the same hash the device will show.
    expect(new Transaction(tx.toXDR(), Networks.PUBLIC).hash().toString("hex")).toBe(review.hash);
  });

  it("refuses a destination that is not the recorded sponsor, and bad amounts", () => {
    const other = Keypair.random().publicKey();
    expect(() =>
      buildTopUp({ id: cold.publicKey(), sequence: "7" }, other, hot.publicKey(), "50", "pubnet"),
    ).toThrow(/not the recorded sponsor/);
    for (const amount of ["0", "-1", "1.12345678", "abc"]) {
      expect(() =>
        buildTopUp(
          { id: cold.publicKey(), sequence: "7" },
          hot.publicKey(),
          hot.publicKey(),
          amount,
          "pubnet",
        ),
      ).toThrow(/positive XLM amount/);
    }
  });

  it("reads a seed from a plain or a tagged key file, and nothing else", () => {
    expect(seedFromFile(`${hot.secret()}\n`).publicKey()).toBe(hot.publicKey());
    expect(seedFromFile(`# rail402-key network=stellar:pubnet\n${hot.secret()}\n`).publicKey()).toBe(
      hot.publicKey(),
    );
    expect(() => seedFromFile(hot.publicKey())).toThrow(/no S… seed/);
  });
});

describe("the leak response", () => {
  it("freezes from the cold account, so the leaked key cannot block it through the sponsor's sequence", () => {
    const tx = buildFreeze({ id: cold.publicKey(), sequence: "40" }, hot.publicKey(), "pubnet");
    // The cold account is the transaction's source and fee payer: the freeze uses its sequence, not
    // the sponsor's, so spending from or bumping the sponsor's sequence first cannot make it fail.
    expect(tx.source).toBe(cold.publicKey());
    expect(tx.sequence).toBe("41");
    expect(tx.fee).toBe("1000");
    const [op] = tx.operations as Operation.SetOptions[];
    expect(tx.operations).toHaveLength(1);
    expect(op).toMatchObject({ type: "setOptions", masterWeight: 0, source: hot.publicKey() });
    const review = reviewOf(tx, "pubnet");
    expect(review.source).toBe(cold.publicKey());
    expect(review.operations).toEqual([`set options: master weight 0 (on account ${hot.publicKey()})`]);
    // Unsigned: the cold key signs it on its device; the hash it shows is the review's.
    expect(tx.signatures).toHaveLength(0);
    expect(new Transaction(tx.toXDR(), Networks.PUBLIC).hash().toString("hex")).toBe(review.hash);
    // After it applies, the hot key (weight 0) meets no threshold; the cold key alone meets every one.
    const frozen = { ...planned, masterWeight: 0 };
    expect(signerSetProblems(frozen, cold.publicKey())).toContain(
      "the hot key cannot meet the medium threshold it needs to sponsor",
    );
    expect(frozen.signers[cold.publicKey()]).toBeGreaterThanOrEqual(frozen.high);
    expect(() => buildFreeze({ id: hot.publicKey(), sequence: "1" }, hot.publicKey(), "pubnet")).toThrow(
      /different account/,
    );
    expect(() => buildFreeze({ id: cold.publicKey(), sequence: "1" }, "G123", "pubnet")).toThrow(
      /G… account address/,
    );
  });

  it("sweeps in a separate cold-sourced transaction after the freeze", () => {
    const tx = buildSweep({ id: cold.publicKey(), sequence: "41" }, hot.publicKey(), "1234.5", "pubnet");
    expect(tx.source).toBe(cold.publicKey());
    expect(tx.operations).toHaveLength(1);
    expect(tx.operations[0]).toMatchObject({ type: "payment", source: hot.publicKey() });
    expect(reviewOf(tx, "pubnet").operations).toEqual([
      `payment of 1234.5000000 XLM to ${cold.publicKey()} (on account ${hot.publicKey()})`,
    ]);
    expect(tx.signatures).toHaveLength(0);
    for (const amount of ["0", "-1", "1.12345678", "abc"]) {
      expect(() =>
        buildSweep({ id: cold.publicKey(), sequence: "1" }, hot.publicKey(), amount, "pubnet"),
      ).toThrow(/positive XLM amount/);
    }
    expect(() =>
      buildSweep({ id: cold.publicKey(), sequence: "1" }, cold.publicKey(), "1", "pubnet"),
    ).toThrow(/different account/);
  });
});

describe("offline signing", () => {
  it("signs an unsigned envelope without the SDK exactly as the SDK does", () => {
    const tx = buildSignerSetup({ id: hot.publicKey(), sequence: "100" }, cold.publicKey(), "pubnet");
    const unsigned = tx.toXDR();
    const offline = signEnvelope(unsigned, "stellar:pubnet", hot.secret());
    expect(offline.source).toBe(hot.publicKey());
    expect(offline.hash).toBe(tx.hash().toString("hex"));
    tx.sign(hot);
    expect(offline.signed).toBe(tx.toXDR());
    const parsed = new Transaction(offline.signed, Networks.PUBLIC);
    expect(parsed.signatures).toHaveLength(1);
    expect(hot.verify(parsed.hash(), parsed.signatures[0]?.signature() ?? Buffer.alloc(0))).toBe(true);
    // The network is part of what is signed: a testnet signature does not verify on pubnet.
    const wrong = new Transaction(
      signEnvelope(unsigned, "stellar:testnet", hot.secret()).signed,
      Networks.PUBLIC,
    );
    expect(hot.verify(wrong.hash(), wrong.signatures[0]?.signature() ?? Buffer.alloc(0))).toBe(false);
    // Already signed, or not a transaction envelope: refused.
    expect(() => signEnvelope(offline.signed, "stellar:pubnet", hot.secret())).toThrow(/already signed/);
    expect(() => signEnvelope("AAAA", "stellar:pubnet", hot.secret())).toThrow();
  });
});
