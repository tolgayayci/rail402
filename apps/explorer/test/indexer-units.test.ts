import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LedgerSourceError, type FetchedLedger, type SourcedLedger } from "@rail402.dev/ledger-source";
import { parseRegistry } from "@rail402.dev/x402-index";
import { REGISTRIES } from "@rail402.dev/x402-index/registry";
import { testnetDocument, ADDRESSES } from "../../../packages/x402-index/test/helpers.ts";
import { ExplorerConfigError, indexerConfig, PUBNET_DEFAULT_FROM } from "../src/config.ts";
import { healthOf } from "../src/health.ts";
import { coverageOf, type CoverageLedger } from "../src/api/report.ts";
import { EpochError, RESET_MARGIN_LEDGERS, detectEpoch, isReset } from "../src/epoch.ts";
import { LedgerBytes, runs } from "../src/indexer/bytes.ts";
import { discoveryPlan } from "../src/indexer/discovery.ts";
import { partitionsBetween } from "../src/rebuild/partitions.ts";
import { discoveredThrough, type StoredRoute } from "../src/store.ts";
import { FixtureRpc } from "./discovery.ts";
import { FIXTURE_SLICE, FixtureSource, fixtureMeta } from "./sources.ts";

const TESTNET = "Test SDF Network ; September 2015";
const scratch = mkdtempSync(join(tmpdir(), "rail402-explorer-units-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A key file as a deployment mounts one; no such key exists. */
function keyFile(name: string, key: string): string {
  const path = join(scratch, name);
  writeFileSync(path, `${key}\n`, { mode: 0o600 });
  return path;
}
const TEST_KEY = `lum_test_${"0".repeat(32)}`;
const LIVE_KEY = `lum_live_${"1".repeat(32)}`;

describe("partitions", () => {
  it("cover a range with data lake partitions, clipped to it", () => {
    expect(partitionsBetween(5_330_305, 5_330_311)).toEqual([
      { start: 5_312_000, end: 5_375_999, from: 5_330_305, to: 5_330_311 },
    ]);
    expect(partitionsBetween(63_990, 128_010).map((range) => [range.start, range.from, range.to])).toEqual([
      [0, 63_990, 63_999],
      [64_000, 64_000, 127_999],
      [128_000, 128_000, 128_010],
    ]);
  });
});

describe("discovery plan", () => {
  it("has one route per registry account and upto contract, over the union of its ranges, clipped to the scope", () => {
    const document = testnetDocument();
    const rail402 = document.facilitators.find((entry) => entry.id === "rail402");
    // The same sponsor listed twice: one route over both ranges.
    const listed = rail402?.accounts.find((account) => account.address === ADDRESSES.sponsor);
    if (rail402 === undefined || listed === undefined) throw new Error("sponsor");
    rail402.accounts.push({ ...listed, validFromLedger: 1_000, validToLedger: 2_000 });
    const plan = discoveryPlan(parseRegistry(document), "2025-12-17", { from: 3_000_000 });
    const sponsor = plan.find((route) => route.address === ADDRESSES.sponsor);
    expect(sponsor).toEqual({
      kind: "account",
      address: ADDRESSES.sponsor,
      from: 3_000_000,
      to: null,
      cadence: "every",
    });
    const previous = plan.find((route) => route.address === ADDRESSES.previousSponsor);
    expect(previous).toMatchObject({ from: 4_912_912, to: 5_315_307 });
    expect(plan.filter((route) => route.kind === "contract").map((route) => route.address)).toContain(
      ADDRESSES.upto,
    );
    // Bounded by `to`; a range that ends before the scope starts has no route.
    const bounded = discoveryPlan(parseRegistry(document), "2025-12-17", { from: 5_320_000, to: 5_330_320 });
    expect(bounded.find((route) => route.address === ADDRESSES.sponsor)).toMatchObject({
      from: 5_320_000,
      to: 5_330_320,
    });
    expect(bounded.find((route) => route.address === ADDRESSES.previousSponsor)).toBeUndefined();
    expect(discoveryPlan(parseRegistry(document), "2026-06-01", { from: 2 })).toEqual([]);
  });

  it("walks beta upto contracts by the approve events naming them, and channels at a slow cadence", () => {
    const registry = REGISTRIES["stellar:testnet"];
    const plan = discoveryPlan(registry, "2025-12-17", { from: 2 });
    for (const entry of registry.document.uptoContracts) {
      const route = plan.find((candidate) => candidate.address === entry.contract);
      expect(route?.kind, entry.contract).toBe(entry.rule === "R-UPTO-BETA" ? "approvals" : "contract");
      expect(route?.cadence).toBe("every");
    }
    const role = new Map(
      registry.document.facilitators.flatMap((facilitator) =>
        facilitator.accounts.map((account) => [account.address, account.role] as const),
      ),
    );
    for (const route of plan.filter((candidate) => candidate.kind === "account")) {
      const expected = ["sponsor", "fee-bump", "relayer"].includes(role.get(route.address) ?? "")
        ? "every"
        : "slow";
      expect(route.cadence, route.address).toBe(expected);
    }
    expect(plan.some((route) => route.cadence === "slow")).toBe(true);
  });

  it("covers the whole published registry of both networks", () => {
    for (const registry of Object.values(REGISTRIES)) {
      const epoch = registry.document.epochs.at(-1)?.id ?? "";
      const plan = discoveryPlan(registry, epoch, { from: 1 });
      const addresses = new Set(plan.map((route) => route.address));
      for (const facilitator of registry.document.facilitators)
        for (const account of facilitator.accounts)
          if (account.epoch === epoch) expect(addresses.has(account.address)).toBe(true);
      for (const entry of registry.document.uptoContracts)
        if (entry.epoch === epoch) expect(addresses.has(entry.contract)).toBe(true);
    }
  });
});

describe("report coverage", () => {
  const route = (from: number, to: number | null, scanned: number | null): StoredRoute => ({
    kind: "account",
    address: "G",
    from,
    to,
    scannedThrough: scanned,
    generation: null,
    decoderVersion: null,
    snapshotLedger: null,
  });
  const ledger = (at: number, status: CoverageLedger["status"] = "indexed"): CoverageLedger => ({
    ledger: at,
    status,
    hash: "aa".repeat(32),
    source: "lake",
  });

  it("runs to the ledger every open route has walked; a closed route walked to its end holds nothing back", () => {
    expect(discoveredThrough([route(10, null, 500), route(20, null, 400), route(10, 300, 300)])).toBe(400);
    expect(discoveredThrough([route(10, 300, 300)])).toBe(300);
    expect(discoveredThrough([route(10, null, null)])).toBeNull();
    expect(discoveredThrough([route(10, null, 500)], 450)).toBe(450);
  });

  it("stops before the first candidate that is pending or failed", () => {
    const routes = [route(10, null, 500)];
    expect(coverageOf(routes, [ledger(12), ledger(400)])).toMatchObject({ from: 10, to: 500, stop: null });
    expect(coverageOf(routes, [ledger(12), ledger(100, "pending"), ledger(400)])).toMatchObject({
      to: 99,
      stop: "pending",
      detachedFrom: 100,
    });
    const failed = coverageOf(routes, [ledger(12), ledger(100, "failed"), ledger(400)]);
    expect(failed).toMatchObject({ to: 99, stop: "failed", detachedFrom: 100 });
    expect(failed?.ledgers.map((entry) => entry.ledger)).toEqual([12]);
    expect(coverageOf(routes, [ledger(10, "failed")])).toBeUndefined();
    // A candidate beyond what discovery covered waits outside the range without holding it back.
    expect(coverageOf(routes, [ledger(12), ledger(600, "pending")])).toMatchObject({ to: 500, stop: null });
  });
});

describe("ledger bytes", () => {
  it("groups nearby ledgers into getLedgers pages within the page limit", () => {
    expect(runs([1, 2, 3, 10, 12, 30], 5).map((run) => [run.start, run.end, run.members.length])).toEqual([
      [1, 3, 3],
      [10, 12, 2],
      [30, 30, 1],
    ]);
    expect(runs([1, 2, 3, 4, 5, 6], 4).map((run) => [run.start, run.end])).toEqual([
      [1, 4],
      [5, 6],
    ]);
  });

  it("reads ledgers inside the RPC retention from RPC and older ones from the lake", async () => {
    const lake = new FixtureSource(FIXTURE_SLICE);
    const rpc = new FixtureRpc(FIXTURE_SLICE, 5_330_310);
    const reads: string[] = [];
    const bytes = new LedgerBytes({
      lake,
      rpc,
      retentionMarginLedgers: 2,
      onRead: (source, count) => reads.push(`${source}:${String(count)}`),
    });
    const got = await read(bytes, [5_330_316, 5_330_305, 5_330_311, 5_330_312]);
    expect(got.map((ledger) => [ledger?.sequence, ledger?.source])).toEqual([
      [5_330_316, "rpc"],
      [5_330_305, "lake"],
      [5_330_311, "lake"],
      [5_330_312, "rpc"],
    ]);
    expect(lake.reads.sort()).toEqual([5_330_305, 5_330_311]);
    // A ledger that leaves the retention while it is asked for is read from the lake instead.
    const pruned = {
      retention: () => Promise.resolve({ oldestLedger: 5_330_300, latestLedger: 5_330_320 }),
      fetchLedgers: (): Promise<FetchedLedger[]> =>
        Promise.reject(
          new LedgerSourceError("rpc_error", "ledger 5330305 is older than the RPC's retention (5330306)"),
        ),
    };
    const fallback = await read(
      new LedgerBytes({ lake, rpc: pruned, retentionMarginLedgers: 0 }),
      [5_330_305],
    );
    expect(fallback[0]?.source).toBe("lake");
    // Any other RPC failure is the caller's to handle.
    const broken = {
      ...pruned,
      fetchLedgers: () => Promise.reject(new LedgerSourceError("http_status", "503", { retryable: true })),
    };
    await expect(
      read(new LedgerBytes({ lake, rpc: broken, retentionMarginLedgers: 0 }), [5_330_305]),
    ).rejects.toMatchObject({
      code: "http_status",
    });
    // Not held anywhere yet: undefined, so the ledger stays pending.
    expect(await read(new LedgerBytes({ lake }), [5_330_400])).toEqual([undefined]);
  });

  it("holds at most the byte limit of fetched ledgers and decodes each one when it is taken", async () => {
    const decoded: number[] = [];
    let fetches = 0;
    const size = 1_000;
    const lake = {
      fetchLedger: (sequence: number): Promise<FetchedLedger> => {
        fetches++;
        return Promise.resolve({
          sequence,
          bytes: size,
          decode: () => {
            decoded.push(sequence);
            return { sequence, meta: fixtureMeta(5_330_305), source: "lake" as const, uri: "test" };
          },
        });
      },
    };
    const held: number[] = [];
    const bytes = new LedgerBytes({
      lake,
      concurrency: 4,
      maxBytesInFlight: 3 * size,
      onBytesInFlight: (total) => held.push(total),
    });
    const sequences = Array.from({ length: 40 }, (_, index) => 100 + index);
    let taken = 0;
    for await (const item of bytes.stream(sequences)) {
      taken++;
      // Only the ledger just taken is decoded, and fetching never runs far ahead of the caller.
      expect(decoded).toHaveLength(taken);
      expect(decoded.at(-1)).toBe(item.sequence);
      expect(fetches - taken).toBeLessThanOrEqual(3 + 4);
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(taken).toBe(40);
    // The limit, plus at most the requests already under way when it was reached.
    expect(Math.max(...held)).toBeLessThanOrEqual((3 + 4) * size);
    expect(held.at(-1)).toBe(0);
  });

  it("sizes getLedgers pages to the byte limit and stops fetching when the caller stops", async () => {
    const asked: [number, number][] = [];
    const rpc = {
      retention: () => Promise.resolve({ oldestLedger: 1, latestLedger: 10_000 }),
      fetchLedgers: (start: number, limit: number): Promise<FetchedLedger[]> => {
        asked.push([start, limit]);
        return Promise.resolve(
          Array.from({ length: limit }, (_, index) => ({
            sequence: start + index,
            bytes: 100,
            decode: () => ({
              sequence: start + index,
              meta: fixtureMeta(5_330_305),
              source: "rpc" as const,
              uri: "test",
            }),
          })),
        );
      },
    };
    const bytes = new LedgerBytes({
      lake: { fetchLedger: () => Promise.resolve(undefined) },
      rpc,
      retentionMarginLedgers: 0,
      pageLimit: 100,
      maxBytesInFlight: 2_000,
    });
    const sequences = Array.from({ length: 300 }, (_, index) => 1_000 + index);
    let taken = 0;
    for await (const _ of bytes.stream(sequences)) if (++taken === 150) break;
    // The first page has the page limit; once ledgers are known to be 100 bytes, a page is 1,000 bytes.
    expect(asked[0]).toEqual([1_000, 100]);
    expect(asked.slice(1).every(([, limit]) => limit === 10)).toBe(true);
    // Stopped early: no page beyond what was taken plus the limit was asked for.
    expect(asked.reduce((total, [, limit]) => total + limit, 0)).toBeLessThanOrEqual(150 + 20 + 100);
  });
});

/** Every ledger of `sequences`, in that order, as the stream yields them. */
async function read(
  bytes: LedgerBytes,
  sequences: readonly number[],
): Promise<(SourcedLedger | undefined)[]> {
  const found = new Map<number, SourcedLedger | undefined>();
  for await (const { sequence, ledger } of bytes.stream(sequences)) found.set(sequence, ledger);
  return sequences.map((sequence) => found.get(sequence));
}

describe("epochs", () => {
  const registry = REGISTRIES["stellar:testnet"];

  it("finds the epoch of a data lake folder and refuses another network's", () => {
    expect(detectEpoch(registry, { passphrase: TESTNET, folder: "testnet/2025-12-18" }).id).toBe(
      "2025-12-17",
    );
    expect(() => detectEpoch(registry, { passphrase: TESTNET, folder: "testnet/2030-01-01" })).toThrow(
      EpochError,
    );
    expect(() =>
      detectEpoch(registry, { passphrase: "Public Global Stellar Network ; September 2015" }),
    ).toThrow(EpochError);
  });

  it("sees a testnet reset only in a new generation whose head is far behind what was indexed", () => {
    const at = { network: "stellar:testnet", generationChanged: true, head: 1_200, newestIndexed: 5_330_311 };
    expect(isReset(at)).toBe(true);
    // A replica a ledger behind, a head behind without a new generation, or pubnet: never a reset.
    expect(isReset({ ...at, head: 5_330_310 })).toBe(false);
    expect(isReset({ ...at, head: 5_330_311 - RESET_MARGIN_LEDGERS })).toBe(false);
    expect(isReset({ ...at, generationChanged: false })).toBe(false);
    expect(isReset({ ...at, network: "stellar:pubnet" })).toBe(false);
    expect(isReset({ ...at, newestIndexed: null })).toBe(false);
  });

  it("picks the newest epoch when several are listed", () => {
    const document = structuredClone(registry.document);
    document.epochs.push({
      id: "2026-06-01",
      passphrase: TESTNET,
      fromLedger: 2,
      dataLakeFolder: "testnet/2026-06-02",
    });
    expect(detectEpoch(parseRegistry(document), { passphrase: TESTNET }).id).toBe("2026-06-01");
  });
});

describe("indexer settings", () => {
  const base = {
    EXPLORER_NETWORK: "testnet",
    EXPLORER_DATABASE_URL: "postgres://writer@db/rail402_explorer",
    EXPLORER_LUMEUS_KEY_FILE: keyFile("testnet.key", TEST_KEY),
  };

  it("default to Lumeus on testnet, the testnet Horizon and the epoch start", () => {
    const config = indexerConfig(base);
    expect(config).toMatchObject({
      network: "stellar:testnet",
      lumeusKey: TEST_KEY,
      activityUrl: "https://api-testnet.lumeus.dev",
      rpcUrl: "https://rpc-testnet.lumeus.dev/",
      rpcIsLumeus: true,
      rpcPageLedgers: 100,
      concurrency: 8,
      anchorHorizonUrl: "https://horizon-testnet.stellar.org/",
      fromLedger: undefined,
      allowUnsafeRole: false,
      healthHost: "127.0.0.1",
      maxCandidatesPerRound: 20_000,
      slowRouteRounds: 20,
    });
    expect(
      indexerConfig({ ...base, EXPLORER_MAX_CANDIDATES_PER_ROUND: "500", EXPLORER_SLOW_ROUTE_ROUNDS: "4" }),
    ).toMatchObject({ maxCandidatesPerRound: 500, slowRouteRounds: 4 });
  });

  it("read the Lumeus key from a file only, and pair it with its network's hosts", () => {
    expect(() => indexerConfig({ ...base, EXPLORER_LUMEUS_KEY_FILE: "" })).toThrow(
      /EXPLORER_LUMEUS_KEY_FILE/,
    );
    expect(() => indexerConfig({ ...base, EXPLORER_LUMEUS_KEY: TEST_KEY })).toThrow(/is refused/);
    expect(() => indexerConfig({ ...base, EXPLORER_LUMEUS_KEY_FILE: join(scratch, "missing") })).toThrow(
      ExplorerConfigError,
    );
    const messages: string[] = [];
    for (const env of [
      { ...base, EXPLORER_LUMEUS_KEY_FILE: keyFile("live.key", LIVE_KEY) },
      // A publishable key is for the web role's lookups, never the indexer.
      { ...base, EXPLORER_LUMEUS_KEY_FILE: keyFile("pub.key", `lum_pub_test_${"2".repeat(32)}`) },
      { ...base, EXPLORER_LUMEUS_API_URL: "https://api.lumeus.dev" },
      { ...base, EXPLORER_LUMEUS_API_URL: "https://lumeus.example" },
      { ...base, EXPLORER_RPC_URL: "https://rpc.lumeus.dev" },
    ]) {
      try {
        indexerConfig(env);
      } catch (error) {
        expect(error).toBeInstanceOf(ExplorerConfigError);
        messages.push((error as Error).message);
      }
    }
    expect(messages).toHaveLength(5);
    for (const message of messages) {
      expect(message).not.toContain(TEST_KEY);
      expect(message).not.toContain(LIVE_KEY);
    }
    // Another RPC is allowed, and never gets the key.
    expect(indexerConfig({ ...base, EXPLORER_RPC_URL: "https://soroban-testnet.stellar.org" })).toMatchObject(
      {
        rpcIsLumeus: false,
      },
    );
  });

  it("fail closed on pubnet: a mainnet key and anchors are required, and unsafe roles are refused", () => {
    const pubnet = {
      ...base,
      EXPLORER_NETWORK: "pubnet",
      EXPLORER_LUMEUS_KEY_FILE: keyFile("live2.key", LIVE_KEY),
    };
    expect(() =>
      indexerConfig({ ...pubnet, EXPLORER_LUMEUS_KEY_FILE: base.EXPLORER_LUMEUS_KEY_FILE }),
    ).toThrow(/belongs to stellar:testnet/);
    expect(() => indexerConfig(pubnet)).toThrow(/EXPLORER_ANCHOR_HORIZON_URL/);
    expect(() => indexerConfig({ ...pubnet, EXPLORER_ANCHOR_HORIZON_URL: "off" })).toThrow(
      ExplorerConfigError,
    );
    const configured = indexerConfig({ ...pubnet, EXPLORER_ANCHOR_HORIZON_URL: "https://horizon.example" });
    expect(configured).toMatchObject({
      fromLedger: PUBNET_DEFAULT_FROM,
      anchorHorizonUrl: "https://horizon.example/",
      activityUrl: "https://api.lumeus.dev",
      rpcUrl: "https://rpc.lumeus.dev/",
      rpcPageLedgers: 20,
    });
    expect(() =>
      indexerConfig({
        ...pubnet,
        EXPLORER_ANCHOR_HORIZON_URL: "https://horizon.example",
        EXPLORER_ALLOW_UNSAFE_ROLE: "true",
      }),
    ).toThrow(/refused on pubnet/);
    expect(() =>
      indexerConfig({
        ...pubnet,
        EXPLORER_ANCHOR_HORIZON_URL: "https://horizon.example",
        EXPLORER_RPC_PAGE_LEDGERS: "21",
      }),
    ).toThrow(/at most 20/);
  });

  it("refuse invalid values", () => {
    for (const env of [
      { ...base, EXPLORER_NETWORK: "mainnet" },
      { EXPLORER_NETWORK: "testnet", EXPLORER_LUMEUS_KEY_FILE: base.EXPLORER_LUMEUS_KEY_FILE },
      { ...base, EXPLORER_RPC_URL: "http://rpc.example" },
      { ...base, EXPLORER_FROM_LEDGER: "-1" },
      { ...base, EXPLORER_FROM_LEDGER: "10", EXPLORER_TO_LEDGER: "5" },
      { ...base, EXPLORER_ALLOW_UNSAFE_ROLE: "yes" },
      { ...base, EXPLORER_CONCURRENCY: "9" },
      { ...base, EXPLORER_RPC_PAGE_LEDGERS: "200" },
      { ...base, EXPLORER_MAX_CANDIDATES_PER_ROUND: "0" },
      { ...base, EXPLORER_SLOW_ROUTE_ROUNDS: "0" },
    ]) {
      expect(() => indexerConfig(env)).toThrow(ExplorerConfigError);
    }
  });
});

describe("health", () => {
  const snapshot = {
    network: "stellar:testnet",
    epoch: "2025-12-17",
    mode: "tail" as const,
    error: null,
    stopped: false,
  };

  it("is ok in the tail within the lag limit, degraded behind it, stopped after a failure", () => {
    expect(healthOf({ ...snapshot, lastLedger: 100, head: 110 }, 120)).toMatchObject({
      status: "ok",
      lagLedgers: 10,
    });
    expect(healthOf({ ...snapshot, lastLedger: 100, head: 1_000 }, 120)).toMatchObject({
      status: "degraded",
    });
    expect(healthOf({ ...snapshot, lastLedger: null, head: null }, 120)).toMatchObject({
      status: "degraded",
    });
    expect(healthOf({ ...snapshot, lastLedger: 100, head: 100, stopped: true }, 120).status).toBe("stopped");
  });
});
