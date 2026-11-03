import { FeeBumpTransaction, Networks, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  RULES_VERSION,
  LedgerDecodeError,
  UnsupportedMetaError,
  classifyLedger,
  classifyTransaction,
  parseRegistry,
  type SettlementRow,
} from "../src/index.ts";
import {
  ADDRESSES,
  LEDGER_SLICE,
  TRANSACTIONS,
  contextFor,
  ledgerMeta,
  testnet,
  testnetDocument,
  type FixtureTransaction,
} from "./helpers.ts";

const settlement = (tx: FixtureTransaction): SettlementRow => {
  const outcome = classifyTransaction(tx, contextFor(tx));
  if (outcome.kind !== "settlement") throw new Error(`expected a settlement, got ${JSON.stringify(outcome)}`);
  return outcome.row;
};

describe("golden evidence transactions", () => {
  it("indexes a Rail402 exact settlement with its fee bump, asset and attribution", () => {
    const tx = TRANSACTIONS["rail402-exact"];
    expect(settlement(tx)).toEqual({
      network: "stellar:testnet",
      epoch: "2025-12-17",
      ledger: 5_330_311,
      txIndex: tx.txIndex,
      txHash: tx.hash,
      innerHash: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
      closedAt: tx.closedAt,
      scheme: "exact",
      ruleId: "R-EXACT",
      rulesVersion: RULES_VERSION,
      registryVersion: "2026-10-22.1",
      asset: {
        contract: ADDRESSES.usdcTestnet,
        code: "USDC",
        issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        verified: true,
      },
      payer: "GANVCYEU5N2ZBZVULCCB3TRY2HJMZJPHFSTVKHRA7AM2HPWKL453IHFR",
      payerKind: "G",
      payTo: "GBSVTVRQ4AEFRNGH2MIOOWZSAVLZKOKNKI4UAGSMBZSNRP4I3FL3ELYP",
      payToMuxedId: null,
      amount: "10000",
      maxAmount: null,
      upto: null,
      fee: {
        bump: true,
        payer: ADDRESSES.sponsor,
        innerSource: "GAYEVWAGRDU537EDK7NAWOHW7NSNND4TUCEAOZJDRQX6VK4VXDKKMLNZ",
        opSource: "GAYEVWAGRDU537EDK7NAWOHW7NSNND4TUCEAOZJDRQX6VK4VXDKKMLNZ",
        chargedStroops: "11781",
        sponsored: true,
      },
      attribution: {
        tier: "rail402",
        facilitatorId: "rail402",
        evidenceUrl: "https://example.org/supported",
        sharedRelayer: false,
      },
      checks: ["E1", "E2", "E3", "E4", "E5", "E6", "E7"],
    });
  });

  it("keys a fee-bumped settlement by the hash a settle response returns, and keeps the inner hash", () => {
    // A facilitator submits the fee bump and returns the hash of what it submitted: the outer hash.
    // Receipt links carry that hash, so the index must be keyed by it.
    const tx = TRANSACTIONS["rail402-exact"];
    const submitted = TransactionBuilder.fromXDR(tx.envelopeXdr, Networks.TESTNET);
    expect(submitted).toBeInstanceOf(FeeBumpTransaction);
    const bump = submitted as FeeBumpTransaction;
    const row = settlement(tx);
    expect(row.txHash).toBe(bump.hash().toString("hex"));
    expect(row.txHash).toBe(tx.hash);
    expect(row.innerHash).toBe(bump.innerTransaction.hash().toString("hex"));
  });

  it("indexes a Rail402 upto settlement from the registry contract's event", () => {
    const row = settlement(TRANSACTIONS["rail402-upto"]);
    expect(row).toMatchObject({
      scheme: "upto",
      ruleId: "R-UPTO",
      amount: "21000",
      maxAmount: "100000",
      payer: "GANVCYEU5N2ZBZVULCCB3TRY2HJMZJPHFSTVKHRA7AM2HPWKL453IHFR",
      payTo: "GBSVTVRQ4AEFRNGH2MIOOWZSAVLZKOKNKI4UAGSMBZSNRP4I3FL3ELYP",
      upto: { contract: ADDRESSES.upto, authority: ADDRESSES.authority },
      asset: { contract: ADDRESSES.usdcTestnet, code: "USDC", verified: true },
      fee: { bump: true, payer: ADDRESSES.sponsor, opSource: ADDRESSES.authority, sponsored: true },
      attribution: { tier: "rail402", facilitatorId: "rail402" },
      checks: ["U1", "U2", "U3", "U4", "U5", "U6", "U7"],
    });
  });

  it("attributes a settlement from the previous hosted sponsor by its ledger range", () => {
    expect(settlement(TRANSACTIONS["rail402-exact-previous-sponsor"])).toMatchObject({
      ledger: 5_189_151,
      fee: { payer: ADDRESSES.previousSponsor },
      attribution: { tier: "rail402", facilitatorId: "rail402" },
    });
  });

  it("attributes x402.org settlements to its advertised signers", () => {
    for (const tx of [TRANSACTIONS["x402org-exact-1"], TRANSACTIONS["x402org-exact-2"]]) {
      expect(settlement(tx)).toMatchObject({
        scheme: "exact",
        amount: "100000",
        txHash: tx.hash,
        fee: { payer: ADDRESSES.x402orgFeeBump, innerSource: ADDRESSES.x402orgChannel, bump: true },
        attribution: { tier: "facilitator", facilitatorId: "x402-org" },
      });
    }
  });

  it("labels the concluded beta's settlements, exact without a fee bump and upto by its beta rule", () => {
    expect(settlement(TRANSACTIONS["beta-exact"])).toMatchObject({
      network: "stellar:pubnet",
      epoch: "pubnet",
      scheme: "exact",
      fee: { bump: false, payer: ADDRESSES.beta, sponsored: true },
      asset: { code: "USDC", verified: true },
      attribution: { tier: "rail402-beta", facilitatorId: "rail402-beta" },
    });
    expect(settlement(TRANSACTIONS["beta-upto"])).toMatchObject({
      scheme: "upto",
      ruleId: "R-UPTO-BETA",
      amount: "200000",
      maxAmount: "500000",
      payer: "GCI3DFXRZDX7K366KEOXEOXBRWGEWUTD63MYRZM2IDV3UFAQUNHOZZIY",
      payTo: "GDKNKPD3P7JK2MYAOOIB3GMDX4CH6N55CU27COG5G7AS5ILRSADHWQ7C",
      upto: { contract: ADDRESSES.betaUpto, authority: ADDRESSES.beta },
      attribution: { tier: "rail402-beta" },
      checks: ["B1", "B2", "B3"],
    });
  });

  it("leaves a shaped match unattributed when no registry account paid the fee", () => {
    const empty = testnet({ ...testnetDocument(), facilitators: [] });
    const outcome = classifyTransaction(TRANSACTIONS["x402org-exact-1"], empty);
    expect(outcome).toMatchObject({
      kind: "settlement",
      row: { attribution: { tier: "shaped", facilitatorId: null, evidenceUrl: null } },
    });
  });

  it("does not count the beta upto contract without its registry entry", () => {
    const tx = TRANSACTIONS["beta-upto"];
    const ctx = contextFor(tx);
    const without = { ...ctx.registry.document, uptoContracts: [] };
    expect(classifyTransaction(tx, { ...ctx, registry: parseRegistry(without) })).toEqual({ kind: "none" });
  });
});

describe("failed attempts", () => {
  it("records a failed exact attempt with its codes and fee, never as a settlement", () => {
    const tx = TRANSACTIONS["rail402-exact"];
    const result = xdr.TransactionResult.fromXDR(tx.resultXdr, "base64");
    const failed = new xdr.TransactionResult({
      feeCharged: result.feeCharged(),
      result: xdr.TransactionResultResult.txFailed([
        xdr.OperationResult.opInner(
          xdr.OperationResultTr.invokeHostFunction(xdr.InvokeHostFunctionResult.invokeHostFunctionTrapped()),
        ),
      ]),
      ext: new xdr.TransactionResultExt(0),
    });
    const outcome = classifyTransaction({ ...tx, resultXdr: failed.toXDR("base64") }, contextFor(tx));
    expect(outcome).toEqual({
      kind: "failed_attempt",
      row: {
        network: "stellar:testnet",
        epoch: "2025-12-17",
        ledger: tx.ledger,
        txIndex: tx.txIndex,
        txHash: tx.hash,
        scheme: "exact",
        resultCode: "txFailed:invokeHostFunctionTrapped",
        feePayer: ADDRESSES.sponsor,
        feeChargedStroops: "11781",
      },
    });
  });
});

describe("ledgers", () => {
  it("classifies the committed testnet slice and finds every evidence settlement", () => {
    const ctx = testnet();
    const rows = LEDGER_SLICE.flatMap((sequence) => classifyLedger(ledgerMeta(sequence), ctx).rows);
    const hashes = rows.map((row) => row.txHash);
    for (const tx of [
      TRANSACTIONS["rail402-exact"],
      TRANSACTIONS["rail402-upto"],
      TRANSACTIONS["x402org-exact-1"],
      TRANSACTIONS["x402org-exact-2"],
    ]) {
      expect(hashes).toContain(tx.hash);
    }
    expect(rows.map((row) => `${String(row.ledger)} ${row.scheme} ${row.attribution.tier}`)).toEqual([
      "5330305 exact rail402",
      "5330310 exact shaped",
      "5330311 exact rail402",
      "5330315 exact shaped",
      "5330316 upto rail402",
      "5330319 exact shaped",
      "5330787 exact facilitator",
      "5330791 exact facilitator",
    ]);
  });

  it("reports the header fields for the hash chain and counts exclusions", () => {
    const result = classifyLedger(ledgerMeta(5_330_309), testnet());
    expect(result).toMatchObject({ ledger: 5_330_309, txCount: 19, rows: [], failed: [] });
    expect(result.ledgerHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.excluded).toEqual({ self_paid_fee: 1, malformed: 1 });
    const next = classifyLedger(ledgerMeta(5_330_310), testnet());
    expect(next.previousLedgerHash).toBe(result.ledgerHash);
  });

  it("accepts base64 and decoded ledgers alike and is deterministic", () => {
    const meta = ledgerMeta(5_330_311);
    const first = classifyLedger(meta, testnet());
    expect(classifyLedger(meta.toXDR("base64"), testnet())).toEqual(first);
    expect(JSON.stringify(classifyLedger(meta, testnet()))).toBe(JSON.stringify(first));
  });

  it("stops on a ledger that does not decode instead of skipping it", () => {
    expect(() => classifyLedger("AAAACQAAAAA=", testnet())).toThrow(LedgerDecodeError);
  });
});

describe("unknown data", () => {
  it("stops on an unknown meta version", () => {
    const tx = TRANSACTIONS["rail402-exact"];
    const bytes = Buffer.from(tx.metaXdr, "base64");
    bytes.writeInt32BE(9, 0);
    expect(() => classifyTransaction({ ...tx, metaXdr: bytes.toString("base64") }, contextFor(tx))).toThrow(
      UnsupportedMetaError,
    );
  });

  it("returns malformed for envelopes and results that do not decode", () => {
    const tx = TRANSACTIONS["rail402-exact"];
    expect(classifyTransaction({ ...tx, envelopeXdr: "AAAA" }, contextFor(tx))).toEqual({
      kind: "excluded",
      reason: "malformed",
    });
    expect(classifyTransaction({ ...tx, resultXdr: "" }, contextFor(tx))).toEqual({
      kind: "excluded",
      reason: "malformed",
    });
  });
});
