/**
 * Property tests over hostile bytes: random data and bit flips of real settlements. The classifier
 * must return an outcome with a bounded size, or throw only the coded errors that stop an indexer.
 */
import { describe, expect, it } from "vitest";
import {
  EventIntegrityError,
  LedgerDecodeError,
  UnsupportedMetaError,
  classifyLedger,
  classifyTransaction,
} from "../src/index.ts";
import { TRANSACTIONS, contextFor, ledgerMeta, testnet } from "./helpers.ts";

/** A small seeded generator (mulberry32), so a failure reproduces from its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function flip(base64: string, next: () => number, flips: number): string {
  const bytes = Buffer.from(base64, "base64");
  for (let i = 0; i < flips; i++) {
    const at = Math.floor(next() * bytes.length);
    bytes[at] = (bytes[at] ?? 0) ^ (1 << Math.floor(next() * 8));
  }
  return bytes.toString("base64");
}

function noise(next: () => number): string {
  const bytes = Buffer.alloc(Math.floor(next() * 400));
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(next() * 256);
  return bytes.toString("base64");
}

const MAX_OUTCOME_BYTES = 8_192;

describe("fuzzing the classifier", () => {
  it("bounds output on random envelopes and metas, or stops with a coded error", () => {
    const next = random(402);
    const fixtures = Object.values(TRANSACTIONS);
    let outcomes = 0;
    for (let round = 0; round < 1_500; round++) {
      const fixture = fixtures[round % fixtures.length];
      if (fixture === undefined) continue;
      const part = round % 4;
      const input = {
        ...fixture,
        envelopeXdr: part === 0 ? flip(fixture.envelopeXdr, next, 1 + (round % 5)) : fixture.envelopeXdr,
        resultXdr: part === 1 ? flip(fixture.resultXdr, next, 1) : fixture.resultXdr,
        metaXdr: part === 2 ? flip(fixture.metaXdr, next, 1 + (round % 7)) : fixture.metaXdr,
        ...(part === 3 ? { envelopeXdr: noise(next), metaXdr: noise(next), resultXdr: noise(next) } : {}),
      };
      try {
        const outcome = classifyTransaction(input, contextFor(fixture));
        expect(JSON.stringify(outcome).length).toBeLessThan(MAX_OUTCOME_BYTES);
        if (outcome.kind === "settlement") expect(outcome.row.checks.length).toBeLessThanOrEqual(7);
        outcomes++;
      } catch (error) {
        expect(error instanceof UnsupportedMetaError || error instanceof EventIntegrityError).toBe(true);
      }
    }
    expect(outcomes).toBeGreaterThan(900);
  });

  it("either classifies a corrupted ledger or stops with a coded error", () => {
    const next = random(7);
    const original = ledgerMeta(5_330_311).toXDR("base64");
    for (let round = 0; round < 60; round++) {
      try {
        const result = classifyLedger(flip(original, next, 1 + (round % 3)), testnet());
        expect(result.rows.length).toBeLessThanOrEqual(result.txCount);
      } catch (error) {
        expect(
          error instanceof LedgerDecodeError ||
            error instanceof UnsupportedMetaError ||
            error instanceof EventIntegrityError,
        ).toBe(true);
      }
    }
  });
});
