import { xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  HashChain,
  LedgerSourceError,
  verifyHashChain,
  verifyLedger,
  type VerifiedLedger,
} from "../src/index.ts";
import { ledgerMeta } from "./helpers.ts";

const RUN = [5_330_305, 5_330_306, 5_330_307, 5_330_308, 5_330_309, 5_330_310, 5_330_311];
const verified = (sequence: number) => verifyLedger(ledgerMeta(sequence));

const codeOf = (action: () => unknown) => {
  try {
    action();
    return undefined;
  } catch (error) {
    if (error instanceof LedgerSourceError) return error.code;
    throw error;
  }
};

/** Re-decodes a ledger so a test can edit one part of it. */
const copy = (sequence: number) => xdr.LedgerCloseMeta.fromXDR(ledgerMeta(sequence).toXDR());

describe("verifyLedger", () => {
  it("accepts real ledgers: header, transaction set and results agree with the ledger hash", () => {
    const ledger = verified(5_330_311);
    expect(ledger).toMatchObject({ ledger: 5_330_311, closedAt: expect.stringMatching(/^2026-/) as unknown });
    expect(ledger.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a tampered header, transaction set or result", () => {
    const header = copy(5_330_311);
    header.v2().ledgerHeader().header().feePool(xdr.Int64.fromString("1"));
    expect(codeOf(() => verifyLedger(header))).toBe("ledger_hash_invalid");

    const envelope = copy(5_330_311);
    const phase = envelope.v2().txSet().v1TxSet().phases()[0];
    const component = phase?.v0Components()[0];
    component?.txsMaybeDiscountedFee().txes().pop();
    expect(codeOf(() => verifyLedger(envelope))).toBe("tx_set_hash_mismatch");

    const result = copy(5_330_311);
    result.v2().txProcessing()[0]?.result().result().feeCharged(xdr.Int64.fromString("999"));
    expect(codeOf(() => verifyLedger(result))).toBe("result_set_hash_mismatch");
  });
});

describe("verifyHashChain", () => {
  it("accepts consecutive real ledgers", () => {
    expect(() => {
      verifyHashChain(RUN.map(verified));
    }).not.toThrow();
  });

  it("stops at a ledger whose previous hash does not match", () => {
    const ledgers = RUN.map(verified);
    const forged: VerifiedLedger[] = ledgers.map((ledger, index) =>
      index === 3 ? { ...ledger, previousHash: "0".repeat(64) } : ledger,
    );
    expect(
      codeOf(() => {
        verifyHashChain(forged);
      }),
    ).toBe("ledger_hash_mismatch");
    const [first] = ledgers;
    if (first === undefined) throw new Error("fixture");
    expect(
      codeOf(() => {
        verifyHashChain(ledgers.slice(1), { ledger: first.ledger, hash: "f".repeat(64) });
      }),
    ).toBe("ledger_hash_mismatch");
  });

  it("stops at a gap instead of skipping it", () => {
    const ledgers = RUN.map(verified);
    expect(
      codeOf(() => {
        verifyHashChain([...ledgers.slice(0, 2), ...ledgers.slice(3)]);
      }),
    ).toBe("ledger_gap");
    const chain = new HashChain();
    chain.append(verified(5_330_305));
    expect(
      codeOf(() => {
        chain.append(verified(5_330_307));
      }),
    ).toBe("ledger_gap");
    expect(chain.last?.ledger).toBe(5_330_305);
  });

  it("checks independently known anchors", () => {
    const last = verified(5_330_311);
    const chain = new HashChain(undefined, [{ ledger: 5_330_311, hash: "e".repeat(64) }]);
    expect(
      codeOf(() => {
        chain.append(last);
      }),
    ).toBe("anchor_mismatch");
    const good = new HashChain(undefined, [{ ledger: 5_330_311, hash: last.hash }]);
    good.append(last);
    expect(good.last).toEqual({ ledger: 5_330_311, hash: last.hash });
  });
});
