import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyTransaction } from "./classify.js";
import type { ClassificationContext } from "./classify.js";
import { adaptHorizonRecord, type HorizonTxRecord } from "./xdr-adapter.js";

/**
 * The decisive property: the SAME real transaction classified through the Horizon-XDR path and
 * through the RPC-JSON path must agree on every classification-bearing field. Both fixtures are
 * live captures of the same two transactions (fixtures/README.md).
 */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const loadHorizon = (name: string): HorizonTxRecord =>
  JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as HorizonTxRecord;
const loadRpc = (name: string): unknown =>
  (JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as { result: unknown }).result;

const UPTO_CONTRACT = "CCMM3FMGEH7FHRYXZ3WQDQCTIWDXGZBGW7D4UT7NKH34SUQACYC3U54X";
const RAIL402_SIGNER = "GBRVXNCL55KOEB7WU3BPSEL34PSUH63UCIFPZDUBIVJBRRG5ZB7V4YR7";

const ctx: ClassificationContext = {
  network: "stellar:testnet",
  epoch: "E1",
  signerIndex: new Map([[RAIL402_SIGNER, "rail402"]]),
  uptoContracts: new Set([UPTO_CONTRACT]),
};

const CLASSIFICATION_FIELDS = [
  "scheme",
  "buyer",
  "seller",
  "amount",
  "assetContract",
  "txSource",
  "feeSource",
  "facilitatorId",
  "confidence",
  "sigExpirationLedger",
  "memo",
  "ledger",
  "closedAt",
  "txHash",
] as const;

function pick(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(CLASSIFICATION_FIELDS.map(f => [f, row[f]]));
}

describe("adaptHorizonRecord — equivalence with the RPC path on REAL transactions", () => {
  it("classifies our plain-envelope settlement identically through both paths", () => {
    const viaHorizon = classifyTransaction(
      adaptHorizonRecord(loadHorizon("horizon-tx-rail402-exact.json")),
      ctx,
    );
    const viaRpc = classifyTransaction(loadRpc("gettx-rail402-exact.json"), ctx);
    expect(viaHorizon).toHaveLength(1);
    expect(viaRpc).toHaveLength(1);
    expect(pick(viaHorizon[0] as never)).toEqual(pick(viaRpc[0] as never));
    expect(viaHorizon[0]!.confidence).toBe("rail402");
  });

  it("classifies the FEE-BUMPED third-party settlement identically through both paths", () => {
    const viaHorizon = classifyTransaction(
      adaptHorizonRecord(loadHorizon("horizon-tx-exact-candidate.json")),
      ctx,
    );
    const viaRpc = classifyTransaction(loadRpc("gettx-exact-candidate.json"), ctx);
    expect(viaHorizon).toHaveLength(1);
    expect(pick(viaHorizon[0] as never)).toEqual(pick(viaRpc[0] as never));
    expect(viaHorizon[0]!.feeSource).toBe(
      "GA6THKUY2XJZOBRFMEQMMEADSCQLCZ2QMQWAWMMDXBTE7SARKAXVH7TL",
    );
  });

  it("returns undefined for garbage XDR instead of throwing", () => {
    expect(
      adaptHorizonRecord({
        hash: "00".repeat(32),
        ledger: 1,
        created_at: "2026-01-01T00:00:00Z",
        successful: true,
        envelope_xdr: "not base64 xdr",
      }),
    ).toBeUndefined();
  });
});
