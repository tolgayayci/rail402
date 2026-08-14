import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyTransaction, parseEventData } from "./classify.js";
import type { ClassificationContext } from "./classify.js";

/**
 * Every fixture is a REAL ledger capture — a fixture that does
 * not match what the host delivers will agree with any implementation. None is hand-built.
 */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const load = (name: string): unknown =>
  (JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as { result: unknown }).result;

const UPTO_CONTRACT = "CCMM3FMGEH7FHRYXZ3WQDQCTIWDXGZBGW7D4UT7NKH34SUQACYC3U54X";
const RAIL402_SIGNER = "GBRVXNCL55KOEB7WU3BPSEL34PSUH63UCIFPZDUBIVJBRRG5ZB7V4YR7";

const baseCtx: ClassificationContext = {
  network: "stellar:testnet",
  epoch: "2025-12-17T17:30:12Z",
  signerIndex: new Map(),
  uptoContracts: new Set([UPTO_CONTRACT]),
};

describe("classifyTransaction — exact scheme", () => {
  it("classifies a live fee-bumped settlement from an UNKNOWN facilitator as x402-shaped", () => {
    const rows = classifyTransaction(load("gettx-exact-candidate.json"), baseCtx);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.scheme).toBe("exact");
    expect(row.buyer).toBe("GA5ENMD2YIO5EPPB44OUH2ICEQBZCLW5SXNIFZHIP6763KYPW5MR6POE");
    expect(row.seller).toMatch(/^G[A-Z2-7]{55}$/);
    expect(row.amount).toBe("10000");
    expect(row.assetContract).toBe("CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA");
    expect(row.asset).toMatch(/^USDC:G/);
    expect(row.txSource).toBe("GAAREO2YVOE3AQ72QYDWU252YVCDXJ236G5JUGPPT7UI3T5YHWT6P4F6");
    expect(row.feeSource).toBe("GA6THKUY2XJZOBRFMEQMMEADSCQLCZ2QMQWAWMMDXBTE7SARKAXVH7TL");
    expect(row.confidence).toBe("x402-shaped");
    expect(row.facilitatorId).toBeUndefined();
    expect(row.sigExpirationLedger).toBe(4124962);
    expect(row.memo).toBeUndefined();
    expect(row.ledger).toBe(4124904);
    expect(row.closedAt).toMatch(/^2026-08-13T/);
    expect(JSON.parse(row.rawEnvelope)).toBeTruthy();
  });

  it("attributes via the FEE-BUMP source when only that is registered (channel accounts rotate)", () => {
    const ctx: ClassificationContext = {
      ...baseCtx,
      signerIndex: new Map([["GA6THKUY2XJZOBRFMEQMMEADSCQLCZ2QMQWAWMMDXBTE7SARKAXVH7TL", "somefac"]]),
    };
    const rows = classifyTransaction(load("gettx-exact-candidate.json"), ctx);
    expect(rows[0]!.facilitatorId).toBe("somefac");
    expect(rows[0]!.confidence).toBe("verified-facilitator");
  });

  it("classifies our own live settlement as rail402 with the observed net fee", () => {
    const ctx: ClassificationContext = {
      ...baseCtx,
      signerIndex: new Map([[RAIL402_SIGNER, "rail402"]]),
    };
    const rows = classifyTransaction(load("gettx-rail402-exact.json"), ctx);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.confidence).toBe("rail402");
    expect(row.facilitatorId).toBe("rail402");
    expect(row.txSource).toBe(RAIL402_SIGNER);
    expect(row.feeSource).toBeUndefined();
    // 33,267 charged, 10,181 refunded — the net the facilitator actually paid.
    expect(row.feeCharged).toBe("23086");
  });

  it("rejects a DeFi call whose inner transfer fired the event (source-credentialed auth)", () => {
    expect(classifyTransaction(load("gettx-caddr-sender.json"), baseCtx)).toEqual([]);
  });
});

describe("classifyTransaction — upto scheme", () => {
  const ctx: ClassificationContext = {
    ...baseCtx,
    signerIndex: new Map([[RAIL402_SIGNER, "rail402"]]),
  };

  it("reads ceiling and actual from the INVOCATION args of a live partial settlement", () => {
    const rows = classifyTransaction(load("gettx-upto-partial.json"), ctx);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.scheme).toBe("upto");
    expect(row.buyer).toBe("GCC4T2TIEY56LXWCOHZMBJKAPQD3KTDGVHLCZ4VB3VXP2NRK6RJT5LGF");
    expect(row.seller).toBe("GBQXGC5CDGYITXTJ5ZKH66WMAMBMGL345WYV4EKPUH23NTRZVUKK6747");
    expect(row.ceiling).toBe("10000000");
    expect(row.amount).toBe("3500000");
    expect(row.assetContract).toBe("CBWBWWDFU3HZ4LKIAQFH2CTSFQFUOJUJFSNSFYHURWTKMQI72QPQSRU5");
    expect(row.asset).toMatch(/^UPTO:G/);
    expect(row.confidence).toBe("rail402");
  });

  it("classifies a full-ceiling settlement (actual == ceiling)", () => {
    const rows = classifyTransaction(load("gettx-upto-full.json"), ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount).toBe("10000000");
    expect(rows[0]!.ceiling).toBe("10000000");
  });

  it("keeps the zero-amount nonce burn as a row even though it emits NO events", () => {
    const rows = classifyTransaction(load("gettx-upto-zero.json"), ctx);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.amount).toBe("0");
    expect(row.ceiling).toBe("10000000");
    expect(row.asset).toBeUndefined();
    expect(row.muxedId).toBeUndefined();
  });

  it("ignores an upto-shaped call on an UNKNOWN settlement contract", () => {
    const rows = classifyTransaction(load("gettx-upto-partial.json"), {
      ...ctx,
      uptoContracts: new Set(),
    });
    expect(rows).toEqual([]);
  });
});

describe("parseEventData — muxed destinations", () => {
  it("parses the live muxed transfer event captured from getEvents", () => {
    // The real `{map: [{amount}, {to_muxed_id}]}` event observed on 2026-08-13 (tx 2bb3f8a4…).
    const raw = JSON.parse(
      readFileSync(join(FIXTURES, "getevents-raw.json"), "utf8"),
    ) as { result: { events: { valueJson: unknown }[] } };
    // Tx 2bb3f8a4… carried muxed transfers on TWO SACs (XLM and USDC) to the same muxed id.
    const muxed = raw.result.events
      .map(e => parseEventData(e.valueJson))
      .filter(p => p?.muxedId === "509288")
      .map(p => p!.amount)
      .sort((a, b) => (a < b ? -1 : 1));
    expect(muxed).toEqual([500000000n, 1000000000n]);
    // CAP-27 muxed info can also be TEXT — live-captured as "Attestra Tx".
    const textMuxed = raw.result.events
      .map(e => parseEventData(e.valueJson))
      .find(p => p?.muxedId === "Attestra Tx");
    expect(textMuxed).toBeDefined();
    expect(textMuxed!.amount).toBe(10000000n);
  });

  it("parses SAC-shaped values and REFUSES custom-contract 'transfer' events", () => {
    // Discovery from this very capture: custom contracts reuse the `transfer` topic symbol with
    // their own data shapes (maps keyed `b_aud_s` etc.). Those are NOT SAC transfers and must
    // parse to undefined, never to a fabricated amount — a third false-positive source beyond
    // classic-op events and non-transfer invocations.
    const raw = JSON.parse(
      readFileSync(join(FIXTURES, "getevents-raw.json"), "utf8"),
    ) as { result: { events: { valueJson: Record<string, unknown> }[] } };
    let parsed = 0;
    let refused = 0;
    for (const e of raw.result.events) {
      const result = parseEventData(e.valueJson);
      if (result === undefined) {
        refused += 1;
      } else {
        expect(typeof result.amount).toBe("bigint");
        parsed += 1;
      }
    }
    // The 2026-08-13 capture holds 18 SAC-shaped values and 12 custom-shaped ones.
    expect(parsed).toBe(18);
    expect(refused).toBe(12);
  });
});

describe("classifyTransaction — refusals", () => {
  it("returns [] for a failed or malformed result instead of throwing", () => {
    expect(classifyTransaction({ status: "FAILED" }, baseCtx)).toEqual([]);
    expect(classifyTransaction(undefined, baseCtx)).toEqual([]);
    expect(classifyTransaction("garbage", baseCtx)).toEqual([]);
    expect(classifyTransaction({ status: "SUCCESS" }, baseCtx)).toEqual([]);
  });
});
