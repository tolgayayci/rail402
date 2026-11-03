import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { verifyLedger } from "@rail402.dev/ledger-source";
import { classifyTransaction } from "@rail402.dev/x402-index";
import { REGISTRIES } from "@rail402.dev/x402-index/registry";
import { TRANSACTIONS, contextFor } from "../../../packages/x402-index/test/helpers.ts";
import { detectEpoch } from "../src/epoch.ts";
import { aggregate, canonicalJson, sha256 } from "../src/rebuild/aggregates.ts";
import { DirectorySource } from "../src/rebuild/directory-source.ts";
import {
  checkListedLedgers,
  ledgersFromManifest,
  manifestRegistrySha256,
  rebuild,
  rebuildLedgers,
  type LedgersRebuildOptions,
  type RebuildOptions,
} from "../src/rebuild/rebuild.ts";
import { FIXTURE_LEDGERS, FIXTURE_SLICE, FixtureSource, fixtureMeta } from "./sources.ts";

/** The committed result of rebuilding the fixture slice; refresh with RAIL402_UPDATE_REBUILD=1. */
const EXPECTED = new URL("fixtures/rebuild-testnet-5330305-5330320.json", import.meta.url);
const scratch = mkdtempSync(join(tmpdir(), "rail402-explorer-rebuild-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const registry = REGISTRIES["stellar:testnet"];
const epoch = detectEpoch(registry, { passphrase: "Test SDF Network ; September 2015" });
const options = (name: string, change: Partial<RebuildOptions> = {}): RebuildOptions => ({
  network: "stellar:testnet",
  epoch,
  registry,
  source: new DirectorySource(fileURLToPath(FIXTURE_LEDGERS)),
  sourceDescription: { kind: "directory", uri: null },
  from: 5_330_305,
  to: 5_330_320,
  outDir: join(scratch, name),
  ...change,
});

describe("explorer:rebuild", () => {
  it("rebuilds the fixture slice to the committed manifest hash", async () => {
    const result = await rebuild(options("committed"));
    const actual = { manifestSha256: result.manifestSha256, manifest: result.manifest };
    if (process.env["RAIL402_UPDATE_REBUILD"] === "1") {
      writeFileSync(EXPECTED, `${JSON.stringify(actual, null, 2)}\n`);
    }
    const expected = JSON.parse(readFileSync(EXPECTED, "utf8")) as typeof actual;
    expect(actual).toEqual(expected);
    // The files on disk are the ones the manifest describes.
    for (const [name, file] of Object.entries(result.manifest.files)) {
      expect(sha256(readFileSync(join(scratch, "committed", name))), name).toBe(file.sha256);
    }
    expect(sha256(readFileSync(join(scratch, "committed", "manifest.json")))).toBe(result.manifestSha256);
  });

  it("is byte-identical across runs and request concurrency", async () => {
    const one = await rebuild(options("serial", { concurrency: 1 }));
    const many = await rebuild(options("parallel", { concurrency: 16 }));
    expect(many.manifestSha256).toBe(one.manifestSha256);
    expect(readFileSync(join(scratch, "parallel", "settlements.ndjson"), "utf8")).toBe(
      readFileSync(join(scratch, "serial", "settlements.ndjson"), "utf8"),
    );
    const lines = readFileSync(join(scratch, "serial", "settlements.ndjson"), "utf8")
      .trim()
      .split("\n");
    const positions = lines.map((line) => {
      const row = JSON.parse(line) as { ledger: number; txIndex: number };
      return row.ledger * 10_000 + row.txIndex;
    });
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("streams rows within a byte budget to the same files, keeping none when asked", async () => {
    const expected = JSON.parse(readFileSync(EXPECTED, "utf8")) as { manifestSha256: string };
    const seen: number[] = [];
    const streamed = await rebuild(
      options("streamed", {
        source: new FixtureSource(FIXTURE_SLICE),
        sourceDescription: { kind: "directory", uri: null },
        maxBytesInFlight: 1,
        concurrency: 16,
        retainRows: false,
        onRow: (row) => seen.push(row.ledger),
      }),
    );
    expect(streamed.manifestSha256).toBe(expected.manifestSha256);
    expect(streamed.rows).toEqual([]);
    expect(seen.length).toBe(streamed.manifest.files["settlements.ndjson"].lines);
    expect(readdirSync(join(scratch, "streamed")).sort()).toEqual([
      "aggregates.json",
      "failed_attempts.ndjson",
      "manifest.json",
      "settlements.ndjson",
    ]);
  });

  it("stops on an aborted signal and leaves no partial file", async () => {
    const abort = new AbortController();
    abort.abort(new Error("over the time budget"));
    await expect(rebuild(options("aborted", { signal: abort.signal }))).rejects.toThrow(
      "over the time budget",
    );
    expect(readdirSync(join(scratch, "aborted"))).toEqual([]);
    await expect(rebuild(options("short-files", { to: 5_330_325 }))).rejects.toMatchObject({
      code: "range_incomplete",
    });
    expect(readdirSync(join(scratch, "short-files"))).toEqual([]);
  });

  it("fails rather than shortening a range with a missing ledger", async () => {
    await expect(rebuild(options("short", { to: 5_330_325 }))).rejects.toMatchObject({
      code: "range_incomplete",
    });
    await expect(rebuild(options("before", { from: 1 }))).rejects.toMatchObject({ code: "range_invalid" });
  });

  it("checks an anchor for the ledger before the range, and refuses anchors it cannot check", async () => {
    const previous = verifyLedger(fixtureMeta(5_330_305)).previousHash;
    const anchored = await rebuild(options("before", { anchors: [{ ledger: 5_330_304, hash: previous }] }));
    expect(anchored.manifest.anchors).toEqual([{ ledger: 5_330_304, hash: previous }]);
    await expect(
      rebuild(options("bogus-before", { anchors: [{ ledger: 5_330_304, hash: "cd".repeat(32) }] })),
    ).rejects.toMatchObject({ code: "anchor_mismatch" });
    for (const ledger of [5_330_000, 5_330_303, 5_330_321]) {
      await expect(
        rebuild(options(`outside-${String(ledger)}`, { anchors: [{ ledger, hash: "ab".repeat(32) }] })),
      ).rejects.toMatchObject({ code: "anchor_out_of_range" });
    }
  });

  it("stops when the chain does not pass through an anchor", async () => {
    await expect(
      rebuild(options("anchored", { anchors: [{ ledger: 5_330_310, hash: "0".repeat(64) }] })),
    ).rejects.toMatchObject({ code: "anchor_mismatch" });
  });
});

describe("explorer:rebuild --ledgers-from", () => {
  const hash = (ledger: number) => verifyLedger(fixtureMeta(ledger)).hash;
  const listed = (name: string, change: Partial<LedgersRebuildOptions> = {}): LedgersRebuildOptions => ({
    network: "stellar:testnet",
    epoch,
    registry,
    source: new DirectorySource(fileURLToPath(FIXTURE_LEDGERS)),
    range: { from: 5_330_305, to: 5_330_320 },
    ledgers: [{ ledger: 5_330_305 }, { ledger: 5_330_311 }, { ledger: 5_330_316 }],
    discovery: "lumeus",
    outDir: join(scratch, name),
    ...change,
  });

  it("rebuilds only the listed ledgers, the same across runs and concurrency, and lists them with their hashes", async () => {
    const one = await rebuildLedgers(listed("listed-1", { concurrency: 1 }));
    const many = await rebuildLedgers(listed("listed-16", { concurrency: 16 }));
    expect(many.manifestSha256).toBe(one.manifestSha256);
    expect(one.manifest).toMatchObject({
      scope: "registry",
      source: { kind: "registry", discovery: "lumeus", uri: null, dataLakeFolder: "testnet/2025-12-18" },
      range: { from: 5_330_305, to: 5_330_320 },
      ledgers: [5_330_305, 5_330_311, 5_330_316].map((ledger) => ({ ledger, hash: hash(ledger) })),
    });
    expect(one.manifest.firstLedger).toBeUndefined();
    expect(one.manifest.partitions).toEqual([
      expect.objectContaining({
        start: 5_312_000,
        from: 5_330_305,
        to: 5_330_316,
        lastLedgerHash: hash(5_330_316),
      }),
    ]);
    // Its rows are the full scan's rows of those ledgers, in the same order.
    const full = await rebuild(options("listed-full"));
    expect(one.rows).toEqual(
      full.rows.filter((row) => [5_330_305, 5_330_311, 5_330_316].includes(row.ledger)),
    );
    // A manifest names its list, range and discovery source; read back, it rebuilds to the same hash.
    const text = readFileSync(join(scratch, "listed-1", "manifest.json"), "utf8");
    const again = ledgersFromManifest(text);
    const second = await rebuildLedgers(listed("listed-again", again));
    expect(second.manifestSha256).toBe(one.manifestSha256);
  });

  it("checks every listed hash and anchor, and refuses lists it cannot hold to the range", async () => {
    await expect(
      rebuildLedgers(listed("wrong-hash", { ledgers: [{ ledger: 5_330_311, hash: "cd".repeat(32) }] })),
    ).rejects.toMatchObject({ code: "anchor_mismatch" });
    await expect(
      rebuildLedgers(listed("wrong-anchor", { anchors: [{ ledger: 5_330_311, hash: "cd".repeat(32) }] })),
    ).rejects.toMatchObject({ code: "anchor_mismatch" });
    await expect(
      rebuildLedgers(listed("unlisted-anchor", { anchors: [{ ledger: 5_330_312, hash: hash(5_330_312) }] })),
    ).rejects.toMatchObject({ code: "anchor_out_of_range" });
    await expect(
      rebuildLedgers(listed("outside", { ledgers: [{ ledger: 5_330_321 }] })),
    ).rejects.toMatchObject({ code: "range_invalid" });
    await expect(
      rebuildLedgers(listed("twice", { ledgers: [{ ledger: 5_330_311 }, { ledger: 5_330_311 }] })),
    ).rejects.toMatchObject({ code: "range_invalid" });
    await expect(
      rebuildLedgers(
        listed("missing", { range: { from: 5_330_305, to: 5_330_330 }, ledgers: [{ ledger: 5_330_325 }] }),
      ),
    ).rejects.toMatchObject({ code: "range_incomplete" });
    expect(() => ledgersFromManifest('{"scope":"full","ledgers":[]}')).toThrow(/registry-scope/);
    expect(() =>
      ledgersFromManifest(
        '{"scope":"registry","ledgers":[],"source":{"discovery":"other"},"range":{"from":1,"to":2}}',
      ),
    ).toThrow(/discovery source/);
    expect(() =>
      ledgersFromManifest(
        '{"scope":"registry","ledgers":[{"ledger":1,"hash":"zz"}],"source":{"discovery":"lumeus"},"range":{"from":1,"to":2}}',
      ),
    ).toThrow(/64 hex hash/);
  });
});

describe("explorer:rebuild --ledgers-from --anchor-horizon", () => {
  it("checks every listed ledger's hash against an independent anchor source, without changing the manifest", async () => {
    const ledgers = [5_330_305, 5_330_311, 5_330_316].map((ledger) => ({
      ledger,
      hash: verifyLedger(fixtureMeta(ledger)).hash,
    }));
    const asked: number[][] = [];
    const honest = {
      name: "horizon:test",
      ledgerHash: (sequence: number) => Promise.resolve(verifyLedger(fixtureMeta(sequence)).hash),
      ledgerHashes: (sequences: readonly number[]) => {
        asked.push([...sequences]);
        return Promise.resolve(
          new Map(sequences.map((sequence) => [sequence, verifyLedger(fixtureMeta(sequence)).hash])),
        );
      },
    };
    await expect(checkListedLedgers(ledgers, honest)).resolves.toBe(3);
    expect(asked).toEqual([[5_330_305, 5_330_311, 5_330_316]]);
    const lying = { ...honest, ledgerHashes: undefined, ledgerHash: () => Promise.resolve("cd".repeat(32)) };
    await expect(checkListedLedgers(ledgers, lying)).rejects.toMatchObject({ code: "anchor_mismatch" });
    expect(manifestRegistrySha256('{"registrySha256":"ab"}')).toBe("ab");
    expect(manifestRegistrySha256("{}")).toBeUndefined();
  });
});

describe("aggregates", () => {
  const settlement = (name: keyof typeof TRANSACTIONS) => {
    const outcome = classifyTransaction(TRANSACTIONS[name], contextFor(TRANSACTIONS[name]));
    if (outcome.kind !== "settlement") throw new Error(name);
    return outcome.row;
  };

  it("counts self-payments outside the headline", () => {
    const paid = settlement("rail402-exact");
    const self = { ...settlement("x402org-exact-1"), payTo: settlement("x402org-exact-1").payer };
    const totals = aggregate([paid, self], [], {});
    expect(totals.headline.payments).toBe(1);
    expect(totals.selfPayments.payments).toBe(1);
    expect(totals.byFacilitator["x402-org"]).toBeUndefined();
    expect(totals.byTier["facilitator"]?.payments).toBe(1);
  });

  it("flags shared-relayer rows on the row and totals them on their own line", () => {
    const rail402 = settlement("rail402-exact");
    const relayed = {
      ...settlement("x402org-exact-1"),
      attribution: {
        tier: "facilitator" as const,
        facilitatorId: "built-on-stellar",
        evidenceUrl: null,
        sharedRelayer: true,
      },
    };
    expect(rail402.attribution.sharedRelayer).toBe(false);
    const totals = aggregate([rail402, relayed], [], {});
    expect(totals.headline.payments).toBe(2);
    expect(totals.headlineSharedRelayer.payments).toBe(1);
    expect(canonicalJson(relayed)).toContain('"sharedRelayer":true');
  });

  it("keeps shaped and beta rows out of the headline and never sums different assets", () => {
    const rail402 = settlement("rail402-exact");
    const shaped = {
      ...rail402,
      txHash: "f".repeat(64),
      attribution: { tier: "shaped" as const, facilitatorId: null, evidenceUrl: null, sharedRelayer: false },
    };
    const beta = settlement("beta-exact");
    const totals = aggregate([rail402, shaped, beta], [], { malformed: 2 });
    expect(totals.headline).toMatchObject({ payments: 1, volume: { [rail402.asset.contract]: "10000" } });
    expect(totals.rail402.payments).toBe(1);
    expect(totals.unattributedShaped.payments).toBe(1);
    expect(totals.rail402Beta).toMatchObject({ payments: 1, volume: { [beta.asset.contract]: "100000" } });
    expect(totals.excluded).toEqual({ malformed: 2 });
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe(
      '{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}',
    );
  });
});
