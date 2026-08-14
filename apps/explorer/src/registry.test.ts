import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { X402Error } from "@rail402/errors";
import { ExplorerStore } from "./db.js";
import { FacilitatorRegistry, parseSupported, slugForUrl } from "./registry.js";
import type { FetchLike } from "./rpc.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
const RAIL402_SUPPORTED = readFileSync(join(FIXTURES, "supported-rail402.json"), "utf8");
const X402ORG_SUPPORTED = readFileSync(join(FIXTURES, "supported-x402org.json"), "utf8");

const logger = pino({ level: "silent" });
const now = (): Date => new Date("2026-08-13T19:00:00.000Z");

function registry(
  store: ExplorerStore,
  fetchImpl: FetchLike,
  seeds: string[] = ["https://facilitator.rail402.dev"],
  allowPrivateHosts = false,
): FacilitatorRegistry {
  return new FacilitatorRegistry({
    store,
    seeds,
    pollIntervalMs: 60_000,
    logger,
    fetchImpl,
    now,
    allowPrivateHosts,
  });
}

const serving =
  (bodyByHost: Record<string, string>): FetchLike =>
  url => {
    const host = new URL(url).hostname;
    const body = bodyByHost[host];
    return Promise.resolve(
      body === undefined
        ? new Response("not found", { status: 404 })
        : new Response(body, { status: 200 }),
    );
  };

describe("parseSupported — against LIVE captured bodies", () => {
  it("extracts our signer, upto contract and network from the rail402 capture", () => {
    const probe = parseSupported(JSON.parse(RAIL402_SUPPORTED));
    expect(probe.signers).toEqual(["GBRVXNCL55KOEB7WU3BPSEL34PSUH63UCIFPZDUBIVJBRRG5ZB7V4YR7"]);
    expect(probe.uptoContracts).toEqual([
      "CCMM3FMGEH7FHRYXZ3WQDQCTIWDXGZBGW7D4UT7NKH34SUQACYC3U54X",
    ]);
    expect(probe.networks).toContain("stellar:testnet");
  });

  it("keeps only Stellar-shaped signers and contracts from the multichain x402.org capture", () => {
    const probe = parseSupported(JSON.parse(X402ORG_SUPPORTED));
    expect(probe.signers).toContain("GC6CSXBV4C6RL3HEDTW57KXYXSSXKAWKGYDEOSATXM3XNKXSR2VRYN3K");
    expect(probe.signers).toContain("GC5OLUZ4WANPN6VT7YGTK2SRMZG762KOVKJXHWIO4K57UBASO2FMNRET");
    // EVM 0x…, Solana base58 AND Algorand base32 signers must not enter the Stellar attribution
    // index. The Algorand one is the trap: uppercase base32 starting with G, refused only by the
    // strkey CHECKSUM.
    expect(probe.signers).toHaveLength(2);
    expect(probe.signers).not.toContain(
      "G7QWRIJODICBDG6JAVXNKHNTCKTBJZBXTSCGQLSMXSCIKEJ5SNFPEJSFQQ",
    );
    expect(probe.networks).toContain("stellar:testnet");
    // x402.org offers upto on Base only — no Stellar upto contract may be inferred from it.
    expect(probe.uptoContracts).toEqual([]);
  });

  it("yields empties for garbage without throwing", () => {
    expect(parseSupported(undefined)).toEqual({ signers: [], uptoContracts: [], networks: [] });
    expect(parseSupported("junk")).toEqual({ signers: [], uptoContracts: [], networks: [] });
  });
});

describe("FacilitatorRegistry", () => {
  it("seeds idempotently and verifies via a real /supported probe", async () => {
    const store = new ExplorerStore();
    const r = registry(store, serving({ "facilitator.rail402.dev": RAIL402_SUPPORTED }));
    r.seed();
    r.seed();
    expect(store.listFacilitators()).toHaveLength(1);
    expect(store.getFacilitator("rail402")!.verified).toBe(false);

    await r.refreshAll();
    const row = store.getFacilitator("rail402")!;
    expect(row.verified).toBe(true);
    expect(row.displayName).toBe("Rail402");
    expect(row.signers).toEqual(["GBRVXNCL55KOEB7WU3BPSEL34PSUH63UCIFPZDUBIVJBRRG5ZB7V4YR7"]);
    expect(store.signerIndex().get("GBRVXNCL55KOEB7WU3BPSEL34PSUH63UCIFPZDUBIVJBRRG5ZB7V4YR7")).toBe(
      "rail402",
    );
  });

  it("keeps last-known signers when a later probe fails, and records the failure", async () => {
    const store = new ExplorerStore();
    let up = true;
    const flaky: FetchLike = url =>
      up
        ? serving({ "facilitator.rail402.dev": RAIL402_SUPPORTED })(url)
        : Promise.reject(new Error("ECONNREFUSED"));
    const r = registry(store, flaky);
    r.seed();
    await r.refreshAll();
    up = false;
    await r.refreshAll();
    const row = store.getFacilitator("rail402")!;
    expect(row.verified).toBe(true);
    expect(row.signers).toHaveLength(1);
    expect(row.lastError).toContain("ECONNREFUSED");
  });

  it("an announce claiming a seed's signer cannot hijack its attribution (review C1)", async () => {
    const store = new ExplorerStore();
    const seed = registry(store, serving({ "facilitator.rail402.dev": RAIL402_SUPPORTED }));
    seed.seed();
    await seed.refreshAll();
    // Attacker announces a reachable host whose /supported echoes rail402's real signer.
    const hostile = JSON.stringify({
      x402Version: 2,
      kinds: [{ scheme: "exact", network: "stellar:testnet", extra: {} }],
      signers: { "stellar:*": ["GBRVXNCL55KOEB7WU3BPSEL34PSUH63UCIFPZDUBIVJBRRG5ZB7V4YR7"] },
    });
    const attacker = registry(store, serving({ "evil.example": hostile }), []);
    await attacker.announce("https://evil.example");
    // The signer stays with the seed; the attacker is registered but owns nothing it claimed falsely.
    expect(store.signerIndex().get("GBRVXNCL55KOEB7WU3BPSEL34PSUH63UCIFPZDUBIVJBRRG5ZB7V4YR7")).toBe(
      "rail402",
    );
  });

  it("retroactively attributes stored x402-shaped rows when a facilitator becomes known", async () => {
    const store = new ExplorerStore();
    // A payment ingested BEFORE the facilitator was known: unattributed, tx source = its signer.
    const SIGNER = "GBRVXNCL55KOEB7WU3BPSEL34PSUH63UCIFPZDUBIVJBRRG5ZB7V4YR7";
    store.insertPayment({
      network: "stellar:testnet",
      epoch: "E1",
      ledger: 1,
      txHash: "f".repeat(64),
      opIndex: 0,
      scheme: "exact",
      buyer: "GBUYER",
      seller: "GSELLER",
      amount: "10000",
      assetContract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      txSource: SIGNER,
      confidence: "x402-shaped",
      closedAt: "2026-08-14T18:00:00Z",
      rawEnvelope: "{}",
      ingestedAt: "2026-08-14T18:00:01Z",
    });
    expect(store.getPaymentByHash("f".repeat(64))!.confidence).toBe("x402-shaped");

    const r = registry(store, serving({ "facilitator.rail402.dev": RAIL402_SUPPORTED }));
    r.seed();
    await r.refreshAll();

    const row = store.getPaymentByHash("f".repeat(64))!;
    expect(row.confidence).toBe("rail402");
    expect(row.facilitatorId).toBe("rail402");
  });

  it("re-attributes on EVERY refresh, so backfilled history converges even after verify", async () => {
    const store = new ExplorerStore();
    const r = registry(store, serving({ "facilitator.rail402.dev": RAIL402_SUPPORTED }));
    r.seed();
    await r.refreshAll(); // facilitator now verified & known; nothing to flip yet

    // A row arrives LATER (as the history backfill walks further back), stored x402-shaped with a
    // source matching the already-known signer. The next periodic refresh must still flip it.
    store.insertPayment({
      network: "stellar:testnet",
      epoch: "E1",
      ledger: 2,
      txHash: "e".repeat(64),
      opIndex: 0,
      scheme: "exact",
      buyer: "GBUYER",
      seller: "GSELLER",
      amount: "10000",
      assetContract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      txSource: "GBRVXNCL55KOEB7WU3BPSEL34PSUH63UCIFPZDUBIVJBRRG5ZB7V4YR7",
      confidence: "x402-shaped",
      closedAt: "2026-08-13T00:00:00Z",
      rawEnvelope: "{}",
      ingestedAt: "2026-08-14T18:00:01Z",
    });
    await r.refreshAll();
    expect(store.getPaymentByHash("e".repeat(64))!.confidence).toBe("rail402");
  });

  it("caps signers/contracts a single /supported can contribute (review M7)", () => {
    const many = Array.from({ length: 500 }, () => "GBRVXNCL55KOEB7WU3BPSEL34PSUH63UCIFPZDUBIVJBRRG5ZB7V4YR7");
    const probe = parseSupported({ signers: { "stellar:*": many } });
    expect(probe.signers.length).toBeLessThanOrEqual(64);
  });

  it("registers an announced facilitator only after probing it itself", async () => {
    const store = new ExplorerStore();
    const r = registry(store, serving({ "x402.org": X402ORG_SUPPORTED }), []);
    const row = await r.announce("https://x402.org/facilitator");
    expect(row.id).toBe("x402-org");
    expect(row.verified).toBe(true);
    expect(row.source).toBe("announce");
    expect(row.signers).toHaveLength(2);
  });

  it("refuses an invalid announce URL with a coded reason and NO outbound request", async () => {
    const store = new ExplorerStore();
    let requests = 0;
    const counting: FetchLike = () => {
      requests += 1;
      return Promise.resolve(new Response("{}", { status: 200 }));
    };
    const r = registry(store, counting, []);
    for (const bad of [
      "http://example.org",
      "https://127.0.0.1:4022",
      "https://localhost",
      "https://169.254.169.254",
      "ftp://example.org",
      "not a url",
    ]) {
      await expect(r.announce(bad)).rejects.toSatisfy(
        e => e instanceof X402Error && e.payload.code === "explorer_announce_invalid_url",
      );
    }
    expect(requests).toBe(0);
    expect(store.listFacilitators()).toHaveLength(0);
  });

  it("refuses an unreachable announce target with a retryable coded reason", async () => {
    const store = new ExplorerStore();
    const r = registry(store, () => Promise.reject(new Error("ETIMEDOUT")), []);
    await expect(r.announce("https://facilitator.example.org")).rejects.toSatisfy(
      e =>
        e instanceof X402Error &&
        e.payload.code === "explorer_announce_unreachable" &&
        e.payload.retryable === true,
    );
    expect(store.listFacilitators()).toHaveLength(0);
  });

  it("never lets a hostname collision capture another facilitator's row", async () => {
    const store = new ExplorerStore();
    const r = registry(
      store,
      serving({ "facilitator.example.org": RAIL402_SUPPORTED }),
      [],
    );
    await r.announce("https://facilitator.example.org/a");
    await r.announce("https://facilitator.example.org/b");
    const all = store.listFacilitators();
    expect(all).toHaveLength(2);
    expect(new Set(all.map(f => f.id)).size).toBe(2);
    expect(new Set(all.map(f => f.baseUrl)).size).toBe(2);
  });
});

describe("slugForUrl", () => {
  it("maps well-known hosts to curated ids and everything else to hostname slugs", () => {
    expect(slugForUrl("https://facilitator.rail402.dev")).toBe("rail402");
    expect(slugForUrl("https://x402.org/facilitator")).toBe("x402-org");
    expect(slugForUrl("https://my.cool-facilitator.example")).toBe("my-cool-facilitator-example");
  });
});
