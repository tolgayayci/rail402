import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { X402Error } from "@rail402/errors";
import { ExplorerStore } from "./db.js";
import type { PaymentRow } from "./types.js";

function payment(overrides: Partial<PaymentRow> = {}): PaymentRow {
  return {
    network: "stellar:testnet",
    epoch: "2025-12-17T17:30:12Z",
    ledger: 4124904,
    txHash: "0207d143713d28c5c0bbb1db2ac49b3ad06157510121eb5cd36dbc16dbfbfc80",
    opIndex: 0,
    scheme: "exact",
    buyer: "GA5ENMD2YIO5EPPB44OUH2ICEQBZCLW5SXNIFZHIP6763KYPW5MR6POE",
    seller: "GD72QAP3ZKAKQZVFTQGVKMQXNVKUWXR5P2VL7ZGN5UGQ7ZCFP7XKQXHK",
    amount: "10000",
    assetContract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    asset: "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    txSource: "GAAREO2YVOE3AQ72QYDWU252YVCDXJ236G5JUGPPT7UI3T5YHWT6P4F6",
    confidence: "x402-shaped",
    closedAt: "2026-08-13T18:31:11Z",
    rawEnvelope: '{"status":"SUCCESS"}',
    ingestedAt: "2026-08-13T18:31:15Z",
    ...overrides,
  };
}

describe("ExplorerStore payments", () => {
  it("inserts and dedups on the epoch-keyed primary key", () => {
    const store = new ExplorerStore();
    expect(store.insertPayment(payment())).toBe(true);
    expect(store.insertPayment(payment())).toBe(false);
    expect(store.stats().totalPayments).toBe(1);
  });

  it("keeps the same tx hash in two epochs as two distinct rows — a reset never collides", () => {
    const store = new ExplorerStore();
    expect(store.insertPayment(payment())).toBe(true);
    expect(store.insertPayment(payment({ epoch: "2026-09-01T17:00:00Z", ledger: 12 }))).toBe(true);
    expect(store.stats().totalPayments).toBe(2);
  });

  it("round-trips every optional field", () => {
    const store = new ExplorerStore();
    const full = payment({
      scheme: "upto",
      ceiling: "10000000",
      feeSource: "GA6THKUY2XJZOBRFMEQMMEADSCQLCZ2QMQWAWMMDXBTE7SARKAXVH7TL",
      feeCharged: "23075",
      facilitatorId: "rail402",
      confidence: "rail402",
      sigExpirationLedger: 4124962,
      memo: "hello",
      muxedId: "509288",
      serviceName: "Weather API",
      resource: "https://api.example.com/forecast",
    });
    store.insertPayment(full);
    const got = store.getPaymentByHash(full.txHash);
    expect(got).toEqual(full);
  });

  it("returns undefined for an unknown hash", () => {
    const store = new ExplorerStore();
    expect(store.getPaymentByHash("ab".repeat(32))).toBeUndefined();
  });
});

describe("ExplorerStore feed", () => {
  function seeded(): ExplorerStore {
    const store = new ExplorerStore();
    for (let i = 0; i < 7; i++) {
      store.insertPayment(
        payment({
          txHash: `${i}`.repeat(64).slice(0, 64),
          closedAt: `2026-08-13T18:3${i}:00Z`,
          scheme: i % 2 === 0 ? "exact" : "upto",
          seller: i < 4 ? "GSELLERA" : "GSELLERB",
        }),
      );
    }
    return store;
  }

  it("orders newest first and paginates with a stable keyset cursor", () => {
    const store = seeded();
    const page1 = store.feed({ limit: 3 });
    expect(page1.items).toHaveLength(3);
    expect(page1.items[0]!.closedAt).toBe("2026-08-13T18:36:00Z");
    expect(page1.nextCursor).toBeDefined();
    const page2 = store.feed({ limit: 3, cursor: page1.nextCursor! });
    expect(page2.items).toHaveLength(3);
    const page3 = store.feed({ limit: 3, cursor: page2.nextCursor! });
    expect(page3.items).toHaveLength(1);
    expect(page3.nextCursor).toBeUndefined();
    const all = [...page1.items, ...page2.items, ...page3.items].map(p => p.txHash);
    expect(new Set(all).size).toBe(7);
  });

  it("paginates a multi-op transaction across a page boundary without dropping ops (review M1)", () => {
    const store = new ExplorerStore();
    // One tx, three ops, all sharing closed_at — the case that dropped rows before op_index
    // entered the cursor.
    for (const op of [0, 1, 2]) {
      store.insertPayment(
        payment({ txHash: "a".repeat(64), opIndex: op, closedAt: "2026-08-13T18:30:00Z" }),
      );
    }
    store.insertPayment(payment({ txHash: "b".repeat(64), closedAt: "2026-08-13T18:29:00Z" }));
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = store.feed({ limit: 2, ...(cursor ? { cursor } : {}) });
      for (const p of page.items) seen.push(`${p.txHash.slice(0, 1)}#${p.opIndex}`);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(["a#2", "a#1", "a#0", "b#0"]);
  });

  it("getPaymentsByHash returns every op of a multi-payment tx (review M5)", () => {
    const store = new ExplorerStore();
    for (const op of [0, 1]) store.insertPayment(payment({ txHash: "c".repeat(64), opIndex: op }));
    expect(store.getPaymentsByHash("c".repeat(64))).toHaveLength(2);
    expect(store.getPaymentByHash("c".repeat(64))).toBeDefined();
  });

  it("filters by scheme and seller", () => {
    const store = seeded();
    expect(store.feed({ scheme: "upto" }).items).toHaveLength(3);
    expect(store.feed({ seller: "GSELLERB" }).items).toHaveLength(3);
    expect(store.feed({ scheme: "exact", seller: "GSELLERA" }).items).toHaveLength(2);
  });

  it("refuses a malformed cursor with a coded reason", () => {
    const store = seeded();
    expect.assertions(2);
    try {
      store.feed({ cursor: "not-a-cursor" });
    } catch (error) {
      expect(error).toBeInstanceOf(X402Error);
      expect((error as X402Error).payload.code).toBe("explorer_invalid_query");
    }
  });
});

describe("ExplorerStore stats", () => {
  it("sums amounts in BigInt so an i128-scale amount cannot overflow or lose precision", () => {
    const store = new ExplorerStore();
    // 2^63 stroops — larger than SQLite's INTEGER can hold; a SQL SUM would corrupt it.
    const huge = "9223372036854775808";
    store.insertPayment(payment({ txHash: "a".repeat(64), amount: huge }));
    store.insertPayment(payment({ txHash: "b".repeat(64), amount: "1" }));
    const stats = store.stats();
    expect(stats.byAsset[0]!.total).toBe("9223372036854775809");
    expect(stats.totalPayments).toBe(2);
  });

  it("breaks down by scheme and confidence and tracks distinct participants", () => {
    const store = new ExplorerStore();
    store.insertPayment(payment({ txHash: "a".repeat(64), scheme: "exact" }));
    store.insertPayment(
      payment({ txHash: "b".repeat(64), scheme: "upto", confidence: "rail402", buyer: "GOTHER" }),
    );
    const stats = store.stats();
    expect(stats.byScheme).toEqual({ exact: 1, upto: 1 });
    expect(stats.byConfidence).toEqual({ "x402-shaped": 1, rail402: 1 });
    expect(stats.uniqueBuyers).toBe(2);
    expect(stats.uniqueSellers).toBe(1);
    expect(stats.lastPaymentAt).toBe("2026-08-13T18:31:11Z");
  });
});

describe("ExplorerStore facilitators + attribution indexes", () => {
  it("upserts and indexes signers of VERIFIED facilitators only", () => {
    const store = new ExplorerStore();
    store.upsertFacilitator({
      id: "rail402",
      baseUrl: "https://facilitator.rail402.dev",
      verified: true,
      signers: ["GBRVXNCL55KOEB7WU3BPSEL34PSUH63UCIFPZDUBIVJBRRG5ZB7V4YR7"],
      uptoContracts: ["CCMM3FMGEH7FHRYXZ3WQDQCTIWDXGZBGW7D4UT7NKH34SUQACYC3U54X"],
      networks: ["stellar:testnet"],
      source: "seed",
      createdAt: "2026-08-13T00:00:00Z",
    });
    store.upsertFacilitator({
      id: "announced-unverified",
      baseUrl: "https://example.org",
      verified: false,
      signers: ["GFAKE"],
      uptoContracts: ["CFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAK"],
      networks: [],
      source: "announce",
      createdAt: "2026-08-13T00:00:00Z",
    });
    const signers = store.signerIndex();
    expect(signers.get("GBRVXNCL55KOEB7WU3BPSEL34PSUH63UCIFPZDUBIVJBRRG5ZB7V4YR7")).toBe("rail402");
    expect(signers.has("GFAKE")).toBe(false);
    expect(store.uptoContractIndex().has("CCMM3FMGEH7FHRYXZ3WQDQCTIWDXGZBGW7D4UT7NKH34SUQACYC3U54X")).toBe(true);
    expect(store.uptoContractIndex().size).toBe(1);
  });

  it("first-claim-wins: an announced facilitator cannot steal a seed's signer (review C1)", () => {
    const store = new ExplorerStore();
    const SIGNER = "GBRVXNCL55KOEB7WU3BPSEL34PSUH63UCIFPZDUBIVJBRRG5ZB7V4YR7";
    store.upsertFacilitator({
      id: "rail402",
      baseUrl: "https://facilitator.rail402.dev",
      verified: true,
      signers: [SIGNER],
      uptoContracts: [],
      networks: ["stellar:testnet"],
      source: "seed",
      createdAt: "2026-08-13T00:00:00Z",
    });
    // Attacker announces LATER, self-reporting rail402's real signer.
    store.upsertFacilitator({
      id: "evil",
      baseUrl: "https://evil.example",
      verified: true,
      signers: [SIGNER],
      uptoContracts: [],
      networks: ["stellar:testnet"],
      source: "announce",
      createdAt: "2026-08-14T00:00:00Z",
    });
    expect(store.signerIndex().get(SIGNER)).toBe("rail402");
  });

  it("a seed always wins a signer even if an announce was created first (review C1)", () => {
    const store = new ExplorerStore();
    const SIGNER = "GC6CSXBV4C6RL3HEDTW57KXYXSSXKAWKGYDEOSATXM3XNKXSR2VRYN3K";
    store.upsertFacilitator({
      id: "evil",
      baseUrl: "https://evil.example",
      verified: true,
      signers: [SIGNER],
      uptoContracts: [],
      networks: [],
      source: "announce",
      createdAt: "2026-08-13T00:00:00Z",
    });
    store.upsertFacilitator({
      id: "x402-org",
      baseUrl: "https://x402.org/facilitator",
      verified: true,
      signers: [SIGNER],
      uptoContracts: [],
      networks: ["stellar:testnet"],
      source: "seed",
      createdAt: "2026-08-14T00:00:00Z",
    });
    expect(store.signerIndex().get(SIGNER)).toBe("x402-org");
  });

  it("updates in place on re-probe without clobbering createdAt", () => {
    const store = new ExplorerStore();
    const seed = {
      id: "rail402",
      baseUrl: "https://facilitator.rail402.dev",
      verified: false,
      signers: [] as string[],
      uptoContracts: [] as string[],
      networks: [] as string[],
      source: "seed" as const,
      createdAt: "2026-08-13T00:00:00Z",
    };
    store.upsertFacilitator(seed);
    store.upsertFacilitator({
      ...seed,
      verified: true,
      signers: ["GNEW"],
      lastSeenAt: "2026-08-13T12:00:00Z",
    });
    const got = store.getFacilitator("rail402")!;
    expect(got.verified).toBe(true);
    expect(got.signers).toEqual(["GNEW"]);
    expect(got.createdAt).toBe("2026-08-13T00:00:00Z");
    expect(store.listFacilitators()).toHaveLength(1);
  });
});

describe("ExplorerStore durability", () => {
  it("survives close and reopen on the same file — cursor, payments and registry intact", () => {
    const dir = mkdtempSync(join(tmpdir(), "explorer-db-"));
    const path = join(dir, "explorer.db");
    const first = new ExplorerStore(path);
    first.insertPayment(payment());
    first.setCursor({
      network: "stellar:testnet",
      epoch: "2025-12-17T17:30:12Z",
      cursor: "0017716332074131456-0000000000",
      lastLedger: 4125114,
      updatedAt: "2026-08-13T18:31:15Z",
    });
    first.setSellerMeta({
      network: "stellar:testnet",
      payTo: payment().seller,
      serviceName: "Weather API",
      fetchedAt: "2026-08-13T18:31:15Z",
    });
    first.close();

    const second = new ExplorerStore(path);
    expect(second.stats().totalPayments).toBe(1);
    expect(second.getCursor("stellar:testnet")?.cursor).toBe("0017716332074131456-0000000000");
    expect(second.getCursor("stellar:testnet")?.lastLedger).toBe(4125114);
    expect(second.getSellerMeta("stellar:testnet", payment().seller)?.serviceName).toBe(
      "Weather API",
    );
    second.close();
  });
});
