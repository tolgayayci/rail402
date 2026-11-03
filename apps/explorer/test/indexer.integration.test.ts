/**
 * The registry-scope indexer over the committed testnet ledgers and a real Postgres: discovery from the
 * recorded Lumeus testnet pages, ledger bytes from the fixture slice (as the data lake and as RPC),
 * checkpoints, registry changes, integrity failures, anchors, epochs and the published report.
 */
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql, type Kysely } from "kysely";
import {
  DATA_LAKE_BASE_URL,
  LedgerSourceError,
  LumeusActivity,
  LumeusError,
  verifyLedger,
  type AnchorSource,
} from "@rail402.dev/ledger-source";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  RULES_VERSION,
  parseRegistry,
  type RegistryDocument,
  type SettlementRow,
} from "@rail402.dev/x402-index";
import { REGISTRIES } from "@rail402.dev/x402-index/registry";
import { ADDRESSES, testnetDocument } from "../../../packages/x402-index/test/helpers.ts";
import {
  BETA_APPROVALS,
  BETA_CONTRACT,
  TEST_KEY,
  fakeActivity,
} from "../../../packages/ledger-source/test/lumeus-fixture.ts";
import { BETA_LEDGERS, ledgerMeta } from "../../../packages/x402-index/test/helpers.ts";
import type { ExplorerDatabase } from "../src/db.ts";
import { LedgerBytes } from "../src/indexer/bytes.ts";
import { discoveryPlan } from "../src/indexer/discovery.ts";
import { Ingester, IndexerStopped, type ActivitySource } from "../src/indexer/ingester.ts";
import { ExplorerMetrics } from "../src/metrics.ts";
import { ExplorerReader, TOTALS_PER_SIDE } from "../src/api/queries.ts";
import { computeReport, loadReport, publishReport, type ComputedReport } from "../src/api/report.ts";
import { EXPLORER_MIGRATIONS, createExplorerDatabase } from "../src/db.ts";
import { ExplorerStore, reconcileRegistry, settlementFromRow, settlementToRow } from "../src/store.ts";
import { admin, count, dropDatabase, freshDatabase, testName, urlFor } from "./database.ts";
import { migrate } from "@rail402.dev/store-postgres";
import { DirectorySource } from "../src/rebuild/directory-source.ts";
import { exportSnapshot } from "../src/snapshot/snapshot.ts";
import { ledgersFromManifest, rebuild, rebuildLedgers } from "../src/rebuild/rebuild.ts";
import { FixtureRpc, RecordedActivity } from "./discovery.ts";
import {
  FIXTURE_LEDGERS,
  FIXTURE_SLICE,
  FixtureSource,
  BETA_SETTLEMENT,
  MetaSource,
  fixtureMeta,
  poisonedBetaLedger,
} from "./sources.ts";

/** Anchors from the fixture headers (the true hashes), with `wrong` ledgers answered falsely. */
function fixtureAnchors(
  options: { wrong?: ReadonlySet<number>; unavailable?: Set<number> } = {},
): AnchorSource & { asked: number[] } {
  const asked: number[] = [];
  return {
    name: "fixture-anchors",
    asked,
    ledgerHash: (sequence) => {
      asked.push(sequence);
      if (options.unavailable?.has(sequence) === true)
        return Promise.reject(new LedgerSourceError("anchor_unavailable", "not ingested yet"));
      if (options.wrong?.has(sequence) === true) return Promise.resolve("ee".repeat(32));
      return Promise.resolve(verifyLedger(fixtureMeta(sequence)).hash);
    },
  };
}

const FROM = 5_330_305;
const TO = 5_330_320;
/** The ledgers the recorded discovery finds: the hosted sponsor's fee rows and the upto contract's event. */
const CANDIDATES = [5_330_305, 5_330_311, 5_330_316];
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
const noSleep = () => Promise.resolve();

let db: Kysely<ExplorerDatabase>;
let opened = false;
beforeEach(async () => {
  if (opened) await db.destroy();
  db = await freshDatabase("indexer");
  opened = true;
});
afterAll(async () => {
  await db.destroy();
  await dropDatabase(testName("indexer"));
});

/** A fresh database for the rest of a test. */
async function restart(): Promise<void> {
  await db.destroy();
  db = await freshDatabase("indexer");
}

interface Setup {
  document?: RegistryDocument;
  epoch?: string;
  activity?: ActivitySource;
  lake?: FixtureSource | MetaSource;
  rpc?: FixtureRpc;
  anchors?: AnchorSource;
  from?: number;
  to?: number | undefined;
  windowLedgers?: number;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  maxCandidatesPerRound?: number;
  slowRouteRounds?: number;
  ledgersPerRound?: number;
  deferSeconds?: number;
  metrics?: ExplorerMetrics;
}

function ingester(options: Setup = {}) {
  const registry = parseRegistry(options.document ?? testnetDocument());
  const epoch = registry.document.epochs.find((entry) => entry.id === (options.epoch ?? "2025-12-17"));
  if (epoch === undefined) throw new Error("epoch");
  const metrics = options.metrics ?? new ExplorerMetrics();
  const store = new ExplorerStore(db);
  const run = new Ingester({
    network: "stellar:testnet",
    registry,
    epoch,
    store,
    activity: options.activity ?? new RecordedActivity(),
    bytes: new LedgerBytes({
      lake: options.lake ?? new FixtureSource(FIXTURE_SLICE),
      ...(options.rpc === undefined ? {} : { rpc: options.rpc }),
      retentionMarginLedgers: 0,
      concurrency: 2,
    }),
    ...(options.anchors === undefined ? {} : { anchors: options.anchors }),
    metrics,
    logger: quiet,
    from: options.from ?? FROM,
    to: "to" in options ? options.to : TO,
    windowLedgers: options.windowLedgers ?? 4,
    concurrency: 3,
    pollMs: 1,
    boundedRetries: 2,
    deferSeconds: options.deferSeconds ?? 0,
    slowRouteRounds: options.slowRouteRounds ?? 1,
    ...(options.maxCandidatesPerRound === undefined
      ? {}
      : { maxCandidatesPerRound: options.maxCandidatesPerRound }),
    ...(options.ledgersPerRound === undefined ? {} : { ledgersPerRound: options.ledgersPerRound }),
    sleep: options.sleep ?? noSleep,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return { run, store, metrics };
}

const snapshot = async () => ({
  settlements: await db.selectFrom("settlements").selectAll().orderBy("ledger").orderBy("tx_index").execute(),
  exclusions: await db
    .selectFrom("ledger_exclusions")
    .selectAll()
    .orderBy("ledger")
    .orderBy("reason")
    .execute(),
  aggregates: await db.selectFrom("daily_aggregates").selectAll().orderBy("tier").orderBy("scheme").execute(),
  accounts: await db
    .selectFrom("account_totals")
    .selectAll()
    .orderBy("address")
    .orderBy("role")
    .orderBy("asset_contract")
    .execute(),
});

async function report(document = testnetDocument()): Promise<ComputedReport> {
  const registry = parseRegistry(document);
  const epoch = registry.document.epochs[0];
  if (epoch === undefined) throw new Error("epoch");
  const computed = await computeReport(db, { network: "stellar:testnet", epoch, registry });
  if (computed === undefined) throw new Error("no report");
  return computed;
}

const indexedLedgers = async () =>
  (
    await db.selectFrom("indexed_ledgers").select(["ledger", "status", "source"]).orderBy("ledger").execute()
  ).map((row) => `${row.ledger} ${row.status} ${String(row.source)}`);

const allIndexed = (source = "lake") => CANDIDATES.map((ledger) => `${String(ledger)} indexed ${source}`);

describe("the registry-scope indexer", () => {
  it("indexes only the ledgers the recorded Lumeus discovery selects, through the real Activity client", async () => {
    const fake = fakeActivity();
    const activity = new LumeusActivity({ network: "stellar:testnet", apiKey: TEST_KEY, fetch: fake.fetch });
    // The RPC holds ledgers from 5,330,310: the first candidate comes from the lake, the others from RPC.
    const rpc = new FixtureRpc(FIXTURE_SLICE, 5_330_310);
    // Windows as wide as the recorded range, so each route's first request is the recorded one.
    const { run, metrics } = ingester({ activity, rpc, windowLedgers: 16 });
    await run.run();
    expect(await indexedLedgers()).toEqual([
      "5330305 indexed lake",
      "5330311 indexed rpc",
      "5330316 indexed rpc",
    ]);
    // Every registry route of the range was walked over it; the key went to the Activity host only.
    const routes = await db.selectFrom("discovery_routes").selectAll().execute();
    const plan = discoveryPlan(parseRegistry(testnetDocument()), "2025-12-17", { from: FROM, to: TO });
    expect(routes.map((route) => route.address).sort()).toEqual(plan.map((route) => route.address).sort());
    expect(plan.map((route) => route.address)).toContain(ADDRESSES.x402orgFeeBump);
    expect(routes.every((route) => route.scanned_through === String(TO))).toBe(true);
    expect(new Set(routes.map((route) => route.generation))).toEqual(new Set(["testnet-2025-12-18-v3"]));
    expect(fake.calls.every((call) => call.url.host === "api-testnet.lumeus.dev")).toBe(true);
    const rows = await db
      .selectFrom("settlements")
      .select(["ledger", "scheme", "tier", "tx_hash"])
      .orderBy("ledger")
      .execute();
    expect(rows.map((row) => [row.ledger, row.scheme, row.tier, row.tx_hash.slice(0, 8)])).toEqual([
      ["5330305", "exact", "rail402", "efbd58f2"],
      ["5330311", "exact", "rail402", "2cc59d87"],
      ["5330316", "upto", "rail402", "336ef628"],
    ]);
    expect(await metrics.registry.getSingleMetricAsString("rail402_explorer_ledgers_indexed_total")).toMatch(
      /source="rpc"\} 2/,
    );
  });

  it("finds the attributed rows a full scan of the range finds, and its report rebuilds from the ledger list", async () => {
    await ingester().run.run();
    const registry = parseRegistry(testnetDocument());
    const epoch = registry.document.epochs[0];
    if (epoch === undefined) throw new Error("epoch");
    const scratch = mkdtempSync(join(tmpdir(), "rail402-explorer-registry-"));
    try {
      const source = new DirectorySource(fileURLToPath(FIXTURE_LEDGERS));
      const full = await rebuild({
        network: "stellar:testnet",
        epoch,
        registry,
        source,
        sourceDescription: { kind: "data-lake", uri: `${DATA_LAKE_BASE_URL}${epoch.dataLakeFolder}/` },
        from: FROM,
        to: TO,
        outDir: join(scratch, "full"),
      });
      const stored = (
        await db.selectFrom("settlements").selectAll().orderBy("ledger").orderBy("tx_index").execute()
      ).map(settlementFromRow);
      const attributed = (rows: readonly SettlementRow[]) =>
        rows.filter((row) => row.attribution.tier !== "shaped");
      // The same rows, field for field, for every attributed settlement; every stored row is one the full scan has.
      expect(attributed(stored)).toEqual(attributed(full.rows));
      const fullByHash = new Map(full.rows.map((row) => [row.txHash, row]));
      for (const row of stored) expect(row).toEqual(fullByHash.get(row.txHash));

      const published = await report();
      expect(published.document).toMatchObject({
        scope: "registry",
        headlineScope: "registered-facilitators",
        range: { from: FROM, to: TO },
        coverageStop: null,
        failedLedgers: [],
        reproducible: true,
        discovery: { source: "lumeus", ledgersRead: 3, bytes: { lake: 3, rpc: 0 } },
        rebuildCommand: "pnpm explorer:rebuild --network testnet --ledgers-from manifest.json",
        auditCommand: `pnpm explorer:rebuild --network testnet --from ${String(FROM)} --to ${String(TO)}`,
      });
      expect(published.manifest).toMatchObject({
        scope: "registry",
        source: { kind: "registry", discovery: "lumeus" },
      });
      expect(published.manifest.ledgers?.map((entry) => entry.ledger)).toEqual(CANDIDATES);
      // The manifest's ledger list, read from ledger files with no discovery source, gives the same manifest.
      const listed = ledgersFromManifest(published.manifestText);
      const rebuilt = await rebuildLedgers({
        network: "stellar:testnet",
        epoch,
        registry,
        source,
        range: listed.range,
        ledgers: listed.ledgers,
        discovery: listed.discovery,
        outDir: join(scratch, "listed"),
      });
      expect(rebuilt.manifest).toEqual(published.manifest);
      expect(rebuilt.manifestSha256).toBe(published.document.manifestSha256);
      expect(full.manifest.scope).toBe("full");
      expect(rebuilt.rows.length).toBeLessThanOrEqual(full.rows.length);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("resumes every route from its checkpoint and reads each candidate once", async () => {
    const activity = new RecordedActivity();
    const lake = new FixtureSource(FIXTURE_SLICE);
    await ingester({ activity, lake, to: 5_330_313 }).run.run();
    expect(await indexedLedgers()).toEqual(["5330305 indexed lake", "5330311 indexed lake"]);
    activity.calls.length = 0;
    lake.reads.length = 0;
    await ingester({ activity, lake }).run.run();
    expect(Math.min(...activity.calls.map((call) => call.from))).toBe(5_330_314);
    expect(lake.reads).toEqual([5_330_316]);
    const before = await snapshot();
    // A third run has nothing to walk or read.
    activity.calls.length = 0;
    await ingester({ activity, lake }).run.run();
    expect(activity.calls).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it("follows the head as discovery publishes new ledgers, then stops on request", async () => {
    const activity = new RecordedActivity(undefined, 5_330_308);
    const abort = new AbortController();
    let rounds = 0;
    const { run } = ingester({
      activity,
      to: undefined,
      signal: abort.signal,
      sleep: () => {
        rounds++;
        activity.head = Math.min(TO, activity.head + 4);
        if (activity.head === TO && rounds > 4) abort.abort();
        return Promise.resolve();
      },
    });
    await run.run();
    expect(await indexedLedgers()).toEqual(allIndexed());
    expect(run.status).toMatchObject({ head: TO, lastLedger: TO, mode: "tail" });
    expect((await report()).document.range).toEqual({ from: FROM, to: TO });
  });

  it("keeps a route's checkpoint when discovery fails for now, and fails a bounded run that cannot finish", async () => {
    const activity = new RecordedActivity();
    activity.failNext = new LumeusError("lumeus_unavailable", "busy", {
      retryable: true,
      retryAfterSeconds: 0,
    });
    await ingester({ activity }).run.run();
    expect(await indexedLedgers()).toEqual(allIndexed());

    await restart();
    const behind = new RecordedActivity(undefined, 5_330_310);
    await expect(ingester({ activity: behind }).run.run()).rejects.toMatchObject({
      code: "range_incomplete",
    });

    await restart();
    const refused = new RecordedActivity();
    refused.failNext = new LumeusError("lumeus_unauthorized", "401");
    await expect(ingester({ activity: refused }).run.run()).rejects.toBeInstanceOf(IndexerStopped);
  });

  it("stops at a ledger whose bytes are not the ledger asked for, marks it failed and holds the report before it", async () => {
    const lake = new FixtureSource(FIXTURE_SLICE);
    lake.swap.set(5_330_311, 5_330_310);
    const { run, metrics } = ingester({ lake });
    const error = await run.run().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IndexerStopped);
    expect(error).toMatchObject({ code: "ledger_mismatch" });
    const failed = await db
      .selectFrom("indexed_ledgers")
      .selectAll()
      .where("status", "=", "failed")
      .execute();
    expect(failed.map((row) => [row.ledger, row.error?.slice(0, 15)])).toEqual([
      ["5330311", "ledger_mismatch"],
    ]);
    expect(await metrics.registry.getSingleMetricAsString("rail402_explorer_chain_breaks_total")).toMatch(
      / 1$/m,
    );
    expect((await report()).document).toMatchObject({
      range: { from: FROM, to: 5_330_310 },
      detachedFrom: 5_330_311,
      coverageStop: "failed",
      failedLedgers: [5_330_311],
      reproducible: false,
    });
    // A restart puts the failed ledger back in the queue; with honest bytes it is indexed.
    await reconcileRegistry(
      new ExplorerStore(db),
      "stellar:testnet",
      "2025-12-17",
      parseRegistry(testnetDocument()),
      RULES_VERSION,
    );
    await ingester().run.run();
    expect((await report()).document).toMatchObject({
      coverageStop: null,
      failedLedgers: [],
      reproducible: true,
    });
  });

  it("commits a ledger only after its hash matched the anchor, stops on another hash and waits while it is unavailable", async () => {
    const anchors = fixtureAnchors();
    await ingester({ anchors }).run.run();
    expect([...anchors.asked].sort((a, b) => a - b)).toEqual(CANDIDATES);
    const published = await report();
    expect(published.manifest.anchors.map((anchor) => anchor.ledger)).toEqual(CANDIDATES);
    expect(ledgersFromManifest(published.manifestText).ledgers).toEqual(published.manifest.anchors);
    // A rebuild of the manifest checks the same anchors and so reproduces the manifest hash.
    const registry = parseRegistry(testnetDocument());
    const epoch = registry.document.epochs[0];
    if (epoch === undefined) throw new Error("epoch");
    const scratch = mkdtempSync(join(tmpdir(), "rail402-explorer-anchored-"));
    try {
      const listed = ledgersFromManifest(published.manifestText);
      const rebuilt = await rebuildLedgers({
        network: "stellar:testnet",
        epoch,
        registry,
        source: new DirectorySource(fileURLToPath(FIXTURE_LEDGERS)),
        range: listed.range,
        ledgers: listed.ledgers,
        discovery: listed.discovery,
        anchors: published.manifest.anchors,
        outDir: scratch,
      });
      expect(rebuilt.manifestSha256).toBe(published.document.manifestSha256);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }

    await restart();
    const bogus = ingester({ anchors: fixtureAnchors({ wrong: new Set([5_330_316]) }) });
    await expect(bogus.run.run()).rejects.toMatchObject({ code: "anchor_mismatch" });
    expect(await indexedLedgers()).toContain("5330316 failed null");
    expect(await db.selectFrom("anchors").select("ledger").where("ledger", "=", "5330316").execute()).toEqual(
      [],
    );

    await restart();
    const unavailable = new Set([5_330_311]);
    let rounds = 0;
    const waiting = ingester({
      anchors: fixtureAnchors({ unavailable }),
      sleep: () => {
        if (++rounds === 1) unavailable.clear();
        return Promise.resolve();
      },
    });
    await waiting.run.run();
    expect(await indexedLedgers()).toEqual(allIndexed());
  });

  it("follows registry changes: routes come and go with their ledgers, and re-attribution equals a fresh index", async () => {
    const without = testnetDocument();
    const rail402 = without.facilitators.find((entry) => entry.id === "rail402");
    if (rail402 === undefined) throw new Error("rail402");
    rail402.accounts = rail402.accounts.filter((account) => account.address !== ADDRESSES.sponsor);
    await ingester({ document: without }).run.run();
    // Without the sponsor's route only the upto contract's ledger is a candidate.
    expect(await indexedLedgers()).toEqual(["5330316 indexed lake"]);
    // Back in the registry: the sponsor's route is walked and its ledgers read.
    await ingester().run.run();
    expect(await indexedLedgers()).toEqual(allIndexed());
    // Out again: its ledgers and rows go, and the totals follow.
    await ingester({ document: without }).run.run();
    expect(await indexedLedgers()).toEqual(["5330316 indexed lake"]);
    expect(await count(db, "settlements")).toBe(1);

    // A registry version that changes attribution only re-attributes in place, equal to a fresh index.
    await restart();
    await ingester().run.run();
    const renamed = { ...testnetDocument(), registryVersion: "2026-10-23.1" };
    const store = new ExplorerStore(db);
    const reconcile = () =>
      reconcileRegistry(store, "stellar:testnet", "2025-12-17", parseRegistry(renamed), RULES_VERSION);
    expect(await reconcile()).toEqual({ reattributed: 3, reset: 0 });
    const reattributed = await snapshot();
    expect(new Set(reattributed.settlements.map((row) => row.registry_version))).toEqual(
      new Set(["2026-10-23.1"]),
    );
    expect(await reconcile()).toEqual({ reattributed: 0, reset: 0 });
    await restart();
    await ingester({ document: renamed }).run.run();
    expect(await snapshot()).toEqual(reattributed);
  });

  it("reads the ledgers again when the upto contracts change", async () => {
    await ingester().run.run();
    const document = { ...testnetDocument(), registryVersion: "2026-10-23.1" };
    const [upto] = document.uptoContracts;
    if (upto === undefined) throw new Error("upto");
    document.uptoContracts = [{ ...upto, validFromLedger: 5_330_400 }];
    const store = new ExplorerStore(db);
    const reconciled = await reconcileRegistry(
      store,
      "stellar:testnet",
      "2025-12-17",
      parseRegistry(document),
      RULES_VERSION,
    );
    expect(reconciled.reset).toBe(3);
    expect(await count(db, "settlements")).toBe(0);
    await ingester({ document }).run.run();
    // The contract's route now starts after the range; the sponsor's route still finds the upto ledger.
    expect(await indexedLedgers()).toEqual(allIndexed());
  });

  it("reads the ledgers again when the rules version changes, so no row of older rules stays", async () => {
    await ingester().run.run();
    const current = await snapshot();
    // The table as an indexer under the previous rules version left it.
    await db.updateTable("indexed_ledgers").set({ rules_version: "1" }).execute();
    await db.updateTable("settlements").set({ rules_version: "1" }).execute();
    const store = new ExplorerStore(db);
    const reconciled = await reconcileRegistry(
      store,
      "stellar:testnet",
      "2025-12-17",
      parseRegistry(testnetDocument()),
      RULES_VERSION,
    );
    expect(reconciled).toEqual({ reattributed: 0, reset: CANDIDATES.length });
    expect(await count(db, "settlements")).toBe(0);
    await ingester().run.run();
    expect(await indexedLedgers()).toEqual(allIndexed());
    expect(await snapshot()).toEqual(current);
  });

  it("reads no row, total or report of other rules until the indexer reads their ledgers again", async () => {
    await ingester().run.run();
    const current = await report();
    await publishReport(db, current);
    const network = "stellar:testnet";
    const epoch = "2025-12-17";
    const page = { after: undefined, limit: 100 };
    const reads = async () => {
      // A new reader each time: none of them reuses an earlier answer about the epoch's rules.
      const reader = new ExplorerReader(db);
      const row = (await db.selectFrom("settlements").selectAll().where("scheme", "=", "upto").execute()).map(
        settlementFromRow,
      )[0];
      if (row === undefined) throw new Error("no upto row");
      return {
        byHash: await reader.settlement(network, [epoch], row.txHash),
        hashes: await reader.settlementsByHash(network, [epoch], [row.txHash]),
        payments: (await reader.payments(network, epoch, {}, page)).items,
        shaped: (await reader.payments(network, epoch, { shaped: true }, page)).items,
        payer: (await reader.accountSettlements(network, epoch, row.payer, "any", page)).items,
        facilitator: (await reader.facilitatorSettlements(network, epoch, "rail402", page)).items,
        seller: await reader.sellerSummary(network, epoch, row.payTo),
        upto: await reader.uptoReceived(network, epoch, row.payTo, 10),
        since: await reader.firstLedgerSince(network, epoch, "2000-01-01T00:00:00.000Z"),
        totals: (await reader.accountTotals(network, epoch, row.payer)).items,
        sellerTotals: [...(await reader.sellerTotals(network, epoch, [row.payTo])).values()],
        report: await loadReport(db, network, epoch),
      };
    };
    const shown = await reads();
    expect(shown.byHash).toBeDefined();
    expect(shown.hashes).toHaveLength(1);
    expect(shown.payments.length).toBeGreaterThan(0);
    expect(shown.payer.length).toBeGreaterThan(0);
    expect(shown.facilitator.length).toBeGreaterThan(0);
    expect(shown.seller.upto).toBeGreaterThan(0);
    expect(shown.upto).toHaveLength(1);
    expect(shown.since).not.toBeNull();
    expect(shown.totals.length).toBeGreaterThan(0);
    expect(shown.sellerTotals).toHaveLength(1);
    expect(shown.report?.document.manifestSha256).toBe(current.document.manifestSha256);

    // The tables as an indexer under the previous rules left them, with its report.
    await db.updateTable("indexed_ledgers").set({ rules_version: "1" }).execute();
    await db.updateTable("settlements").set({ rules_version: "1" }).execute();
    await publishReport(db, { ...current, document: { ...current.document, rulesVersion: "1" } });
    expect(await reads()).toEqual({
      byHash: undefined,
      hashes: [],
      payments: [],
      shaped: [],
      payer: [],
      facilitator: [],
      seller: { exact: 0, upto: 0, payers: 0 },
      upto: [],
      since: null,
      totals: [],
      sellerTotals: [],
      report: undefined,
    });
    // Nor is a snapshot exported from them.
    const registry = parseRegistry(testnetDocument());
    const [first] = registry.document.epochs;
    if (first === undefined) throw new Error("epoch");
    const out = mkdtempSync(join(tmpdir(), "rail402-explorer-older-rules-"));
    try {
      await expect(
        exportSnapshot(db, {
          network,
          epoch: first,
          registry,
          outDir: out,
          publicUrl: "https://explorer.example.org",
        }),
      ).rejects.toThrow(/rows of rules versions 1/);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
    // A report stamped with the current rules over rows of other rules is not served either.
    const olderRows = { ...current.manifest, rowVersions: { ...current.manifest.rowVersions, rules: ["1"] } };
    await publishReport(db, {
      ...current,
      manifest: olderRows,
      manifestText: `${JSON.stringify(olderRows)}\n`,
    });
    expect(await loadReport(db, network, epoch)).toBeUndefined();

    // Once the indexer has read the ledgers again, everything is back, as it was.
    await reconcileRegistry(
      new ExplorerStore(db),
      network,
      epoch,
      parseRegistry(testnetDocument()),
      RULES_VERSION,
    );
    await ingester().run.run();
    await publishReport(db, await report());
    const back = await reads();
    expect(back.payments).toEqual(shown.payments);
    expect(back.totals).toEqual(shown.totals);
    expect(back.report?.document.manifestSha256).toBe(current.document.manifestSha256);
  });

  it("keys rows by epoch, and stops when a new discovery generation's head falls behind the indexed ledgers", async () => {
    const document = testnetDocument();
    document.epochs.push({
      id: "2026-06-01",
      passphrase: "Test SDF Network ; September 2015",
      fromLedger: 2,
      dataLakeFolder: "testnet/2026-06-02",
    });
    const rail402 = document.facilitators.find((entry) => entry.id === "rail402");
    const sponsor = rail402?.accounts.find((account) => account.address === ADDRESSES.sponsor);
    if (rail402 === undefined || sponsor === undefined) throw new Error("sponsor");
    rail402.accounts.push({ ...sponsor, epoch: "2026-06-01" });
    await ingester({ document }).run.run();
    // The same ledger numbers in the next epoch: kept apart, never merged. The upto contract is not
    // registered in that epoch, so its settlement is not an R-UPTO row there.
    await ingester({ document, epoch: "2026-06-01" }).run.run();
    const epochs = await db.selectFrom("settlements").select(["epoch", "tx_hash"]).execute();
    expect(epochs.filter((row) => row.epoch === "2025-12-17")).toHaveLength(3);
    expect(
      epochs
        .filter((row) => row.epoch === "2026-06-01")
        .map((row) => row.tx_hash.slice(0, 8))
        .sort(),
    ).toEqual(["2cc59d87", "efbd58f2"]);

    await restart();
    const reset = new RecordedActivity();
    const following = ingester({
      activity: reset,
      to: undefined,
      sleep: () => {
        reset.head = 1_000;
        reset.generation = "testnet-2027-01-01-v1";
        return Promise.resolve();
      },
    });
    // The first round indexes; then a new generation whose head of 1,000 is behind ledger 5,330,316.
    await expect(following.run.run()).rejects.toMatchObject({ code: "epoch_reset" });
    // Nothing of the new network was stored under the old epoch.
    expect(await indexedLedgers()).toEqual(allIndexed());
  });

  it("never takes a lagging or dishonest head for a reset: without a new generation it is only counted", async () => {
    const lagging = new RecordedActivity();
    const abort = new AbortController();
    const metrics = new ExplorerMetrics();
    let rounds = 0;
    const { run } = ingester({
      activity: lagging,
      to: undefined,
      metrics,
      signal: abort.signal,
      sleep: () => {
        rounds++;
        // A replica one ledger behind the newest candidate, then a head far behind with the same generation.
        lagging.head = rounds === 1 ? 5_330_315 : 1_000;
        if (rounds === 3) abort.abort();
        return Promise.resolve();
      },
    });
    await run.run();
    expect(await indexedLedgers()).toEqual(allIndexed());
    expect(await metrics.registry.getSingleMetricAsString("rail402_explorer_head_regressions_total")).toMatch(
      /\} [1-9]/,
    );
  });

  it("finds a beta upto settlement by the approve event that names its contract, through the real Activity client", async () => {
    // Recorded from Lumeus testnet: the beta contract's own activity is empty (it emits no event and
    // moves no funds itself); topic search for approve events naming it finds its settlement.
    const fake = fakeActivity({ head: 5_348_000 });
    const activity = new LumeusActivity({ network: "stellar:testnet", apiKey: TEST_KEY, fetch: fake.fetch });
    await ingester({
      document: REGISTRIES["stellar:testnet"].document,
      activity,
      lake: new MetaSource(new Map([[3_953_878, ledgerMeta(3_953_878, BETA_LEDGERS)]])),
      from: BETA_APPROVALS.since,
      to: BETA_APPROVALS.until - 1,
      windowLedgers: BETA_APPROVALS.until - BETA_APPROVALS.since,
    }).run.run();
    const approvals = fake.calls.filter((call) => call.url.pathname.endsWith("/contract-events"));
    expect(approvals.map((call) => call.url.pathname)).toContain(
      `/accounts/${BETA_CONTRACT}/contract-events`,
    );
    expect(approvals.every((call) => call.url.searchParams.get("name") === "approve")).toBe(true);
    expect(await indexedLedgers()).toEqual(["3953878 indexed lake"]);
    const rows = await db
      .selectFrom("settlements")
      .select(["tx_hash", "scheme", "rule_id", "tier"])
      .execute();
    expect(rows).toEqual([
      { tx_hash: BETA_SETTLEMENT, scheme: "upto", rule_id: "R-UPTO-BETA", tier: "rail402-beta" },
    ]);
    const routes = await db
      .selectFrom("discovery_routes")
      .select(["kind", "address"])
      .where("kind", "=", "approvals")
      .execute();
    expect(routes.map((route) => route.address)).toContain(BETA_CONTRACT);
  });

  it("counts a hostile token's NUL muxed id as an exclusion and keeps indexing", async () => {
    const activity = new RecordedActivity(new Map(), 3_953_878);
    const beta = REGISTRIES["stellar:testnet"].document.uptoContracts.find(
      (entry) =>
        entry.rule === "R-UPTO-BETA" &&
        entry.validFromLedger <= 3_953_878 &&
        (entry.validToLedger ?? Infinity) >= 3_953_878,
    );
    if (beta === undefined) throw new Error("beta contract");
    activity.add(beta.contract, 3_953_878);
    await ingester({
      document: REGISTRIES["stellar:testnet"].document,
      activity,
      lake: new MetaSource(new Map([[3_953_878, poisonedBetaLedger()]])),
      from: 3_953_878,
      to: 3_953_878,
    }).run.run();
    expect(await count(db, "settlements")).toBe(0);
    expect(
      await db
        .selectFrom("ledger_exclusions")
        .select(["reason", "count"])
        .where("reason", "=", "transfer_event_mismatch")
        .execute(),
    ).toEqual([{ reason: "transfer_event_mismatch", count: "1" }]);
    expect(await indexedLedgers()).toEqual(["3953878 indexed lake"]);
  });
});

describe("the upgrade from full-scan indexing", () => {
  it("leaves no full-scan row, total or report behind, and serves no old report", async () => {
    // A row of the registry-scope index, as a template for full-scan rows of ledgers it never lists.
    await ingester().run.run();
    const [template] = (await db.selectFrom("settlements").selectAll().limit(1).execute()).map(
      settlementFromRow,
    );
    if (template === undefined) throw new Error("no row");

    const name = testName("upgrade");
    await dropDatabase(name);
    await admin(async (client) => {
      await client.query(`CREATE DATABASE ${name}`);
    });
    const old = createExplorerDatabase({ connectionString: urlFor(name) });
    const before = mkdtempSync(join(tmpdir(), "rail402-explorer-migrations-"));
    try {
      // The schema as the full scan left it, with its rows.
      for (const file of ["0001_explorer.sql", "0002_anchors.sql"])
        copyFileSync(join(EXPLORER_MIGRATIONS, file), join(before, file));
      await migrate(old, `${before}/`);
      const stray = { ...template, ledger: 5_330_307, txHash: "cd".repeat(32), innerHash: null };
      await old.insertInto("settlements").values(settlementToRow(stray)).execute();
      await old
        .insertInto("failed_attempts")
        .values({
          network: "stellar:testnet",
          epoch: "2025-12-17",
          tx_hash: "ef".repeat(32),
          ledger: 5_330_307,
          tx_index: 1,
          scheme: "exact",
          result_code: "txFAILED",
          fee_payer: ADDRESSES.sponsor,
          fee_charged: "100",
        })
        .execute();
      await old
        .insertInto("anchors")
        .values({
          network: "stellar:testnet",
          epoch: "2025-12-17",
          ledger: 5_330_307,
          hash: "ab".repeat(32),
          source: "horizon:x",
        })
        .execute();
      await sql`INSERT INTO daily_aggregates VALUES ('stellar:testnet', '2025-12-17', '2026-10-21', 'rail402', 'rail402', 'exact', ${template.asset.contract}, false, 1, 100)`.execute(
        old,
      );
      await sql`INSERT INTO account_totals VALUES ('stellar:testnet', '2025-12-17', ${template.payer}, 'payer', ${template.asset.contract}, NULL, NULL, false, 1, 100, now(), now())`.execute(
        old,
      );
      await sql`INSERT INTO reports VALUES ('stellar:testnet', '2025-12-17', now(), '{"scope":"full","range":{"from":5189000,"to":5330320}}', '{"manifestVersion":2,"scope":"full"}', '{}')`.execute(
        old,
      );

      await migrate(old, EXPLORER_MIGRATIONS);
      for (const table of [
        "settlements",
        "failed_attempts",
        "anchors",
        "daily_aggregates",
        "account_totals",
        "reports",
      ] as const)
        expect(await count(old, table), table).toBe(0);

      // A document of the full scan that is still stored is not served: no report until a new one.
      await sql`INSERT INTO reports VALUES ('stellar:testnet', '2025-12-17', now(), '{"scope":"full"}', '{"manifestVersion":2,"scope":"full"}', '{}')`.execute(
        old,
      );
      expect(await loadReport(old, "stellar:testnet", "2025-12-17")).toBeUndefined();
      const current = await report();
      await publishReport(old, current);
      expect((await loadReport(old, "stellar:testnet", "2025-12-17"))?.document.manifestSha256).toBe(
        current.document.manifestSha256,
      );
    } finally {
      await old.destroy();
      await dropDatabase(name);
      rmSync(before, { recursive: true, force: true });
    }

    // Defence in depth: a row of a ledger the report does not list never enters it.
    const listed = await report();
    await db
      .insertInto("settlements")
      .values(settlementToRow({ ...template, ledger: 5_330_307, txHash: "cd".repeat(32), innerHash: null }))
      .execute();
    const again = await report();
    expect(again.document.manifestSha256).toBe(listed.document.manifestSha256);
    expect(again.document.aggregates).toEqual(listed.document.aggregates);
  });
});

describe("discovery that loses nothing", () => {
  it("resumes after a bounded run that ends before ledgers already found, and finds them all again", async () => {
    const activity = new RecordedActivity();
    await ingester({ activity }).run.run();
    expect(await indexedLedgers()).toEqual(allIndexed());
    // A bounded run that stops earlier keeps every route's registry bounds, checkpoint and candidates.
    await ingester({ activity, to: 5_330_310 }).run.run();
    expect(await indexedLedgers()).toEqual(allIndexed());
    const routes = await db.selectFrom("discovery_routes").select(["to_ledger", "scanned_through"]).execute();
    expect(routes.every((route) => route.scanned_through === String(TO))).toBe(true);
    expect(routes.some((route) => route.to_ledger === "5330310")).toBe(false);
    // And a run with a wider bound after it has the full set.
    await ingester({ activity }).run.run();
    expect(await indexedLedgers()).toEqual(allIndexed());
    expect(await count(db, "settlements")).toBe(3);

    // A registry range that ends before the checkpoint, then widens again: the ledgers after its end are
    // walked again, not skipped.
    await restart();
    await ingester({ activity }).run.run();
    const narrowed = testnetDocument();
    const sponsor = narrowed.facilitators
      .find((entry) => entry.id === "rail402")
      ?.accounts.find((account) => account.address === ADDRESSES.sponsor);
    if (sponsor === undefined) throw new Error("sponsor");
    sponsor.validToLedger = 5_330_308;
    await ingester({ document: narrowed, activity }).run.run();
    const [narrow] = await db
      .selectFrom("discovery_routes")
      .select("scanned_through")
      .where("address", "=", ADDRESSES.sponsor)
      .execute();
    expect(narrow?.scanned_through).toBe("5330308");
    await ingester({ activity }).run.run();
    expect(await indexedLedgers()).toEqual(allIndexed());
  });

  it("walks a route again from its first ledger when the discovery source's generation or decoder changes", async () => {
    const activity = new RecordedActivity();
    const metrics = new ExplorerMetrics();
    await ingester({ activity, metrics }).run.run();
    expect(await indexedLedgers()).toEqual(allIndexed());
    // A rebuilt index may add records for ranges already walked: one appears in a walked ledger.
    activity.generation = "testnet-2025-12-18-v4";
    activity.head = 5_330_330;
    activity.add(ADDRESSES.sponsor, 5_330_309);
    activity.calls.length = 0;
    const following = (rounds: number) => {
      const abort = new AbortController();
      let slept = 0;
      return ingester({
        activity,
        metrics,
        to: undefined,
        signal: abort.signal,
        sleep: () => {
          if (++slept === rounds) abort.abort();
          return Promise.resolve();
        },
      }).run.run();
    };
    await following(3);
    expect(activity.calls.filter((call) => call.from === FROM).length).toBeGreaterThan(0);
    expect(await indexedLedgers()).toContain("5330309 indexed lake");
    const routes = await db
      .selectFrom("discovery_routes")
      .select(["generation", "scanned_through"])
      .execute();
    expect(new Set(routes.map((route) => route.generation))).toEqual(new Set(["testnet-2025-12-18-v4"]));
    expect(routes.every((route) => route.scanned_through === "5330330")).toBe(true);
    expect(
      await metrics.registry.getSingleMetricAsString("rail402_explorer_discovery_restarts_total"),
    ).toMatch(/kind="account"\} [1-9]/);
    // A decoder change alone does the same.
    activity.decoderVersion = "activity-test-2";
    activity.calls.length = 0;
    await following(3);
    expect(activity.calls.filter((call) => call.from === FROM).length).toBeGreaterThan(0);
  });

  it("stores every page as it is read, so a failure later in a window loses at most that page", async () => {
    const activity = new RecordedActivity();
    activity.pageSize = 1;
    // The sponsor's route has six records over three ledgers, one per page; its fourth page fails.
    activity.failAfterPages = {
      address: ADDRESSES.sponsor,
      pages: 3,
      error: new LumeusError("lumeus_unavailable", "busy", { retryable: true, retryAfterSeconds: 0 }),
    };
    await ingester({ activity, windowLedgers: 16 }).run.run();
    // The third page vouched for every ledger before 5,330,311: the next walk resumes there.
    const walks = activity.calls.filter((call) => call.address === ADDRESSES.sponsor);
    expect(walks.map((call) => call.from)).toEqual([FROM, 5_330_311]);
    expect(await indexedLedgers()).toEqual(allIndexed());
  });

  it("reads at most a capped number of new candidates per route and round, and reports candidates with no attributed row", async () => {
    const activity = new RecordedActivity();
    activity.pageSize = 1;
    // A ledger the discovery source lists for the sponsor although the sponsor did nothing there.
    activity.add(ADDRESSES.sponsor, 5_330_309);
    const metrics = new ExplorerMetrics();
    await ingester({ activity, metrics, maxCandidatesPerRound: 1, windowLedgers: 16 }).run.run();
    expect(await indexedLedgers()).toEqual([
      "5330305 indexed lake",
      "5330309 indexed lake",
      "5330311 indexed lake",
      "5330316 indexed lake",
    ]);
    expect(
      await metrics.registry.getSingleMetricAsString("rail402_explorer_candidates_capped_total"),
    ).toMatch(/kind="account"\} [1-9]/);
    // The invented ledger adds only its own real rows, listed in the manifest and counted apart.
    const published = await report();
    expect(published.manifest.ledgers?.map((entry) => entry.ledger)).toContain(5_330_309);
    expect(published.document.discovery).toMatchObject({ ledgersRead: 4, ledgersWithoutAttributedRow: 1 });
    expect(published.document.aggregates.headline.payments).toBe(3);
    expect(
      await metrics.registry.getSingleMetricAsString("rail402_explorer_candidates_unattributed_total"),
    ).toMatch(/\} 1$/m);
  });

  it("walks routes of non-fee-paying roles at a slower cadence once they reach the head", async () => {
    const activity = new RecordedActivity();
    const abort = new AbortController();
    let rounds = 0;
    await ingester({
      activity,
      to: undefined,
      slowRouteRounds: 3,
      signal: abort.signal,
      sleep: () => {
        if (++rounds === 6) abort.abort();
        activity.head++;
        return Promise.resolve();
      },
    }).run.run();
    const walks = (address: string) => activity.calls.filter((call) => call.address === address).length;
    // The sponsor every round; a channel in its first round and then every third.
    expect(walks(ADDRESSES.sponsor)).toBe(6);
    expect(walks(ADDRESSES.x402orgChannel)).toBeLessThan(6);
    expect(walks(ADDRESSES.x402orgChannel)).toBeGreaterThanOrEqual(2);
  });

  it("lets a candidate whose bytes are not available yet wait without holding back newer ones", async () => {
    const lake = new FixtureSource(FIXTURE_SLICE.filter((ledger) => ledger !== 5_330_305));
    const abort = new AbortController();
    let rounds = 0;
    await ingester({
      lake,
      to: undefined,
      ledgersPerRound: 1,
      deferSeconds: 60,
      signal: abort.signal,
      sleep: () => {
        if (++rounds === 4) abort.abort();
        return Promise.resolve();
      },
    }).run.run();
    expect(await indexedLedgers()).toEqual([
      "5330305 pending null",
      "5330311 indexed lake",
      "5330316 indexed lake",
    ]);
    // The report still stops before the ledger that waits.
    const registry = parseRegistry(testnetDocument());
    const epoch = registry.document.epochs[0];
    if (epoch === undefined) throw new Error("epoch");
    expect(await computeReport(db, { network: "stellar:testnet", epoch, registry })).toBeUndefined();
  });

  it("pauses every ledger read after a long Retry-After from the RPC", async () => {
    const rpc = new FixtureRpc(FIXTURE_SLICE, 5_330_300);
    let asked = 0;
    rpc.fetchLedgers = () => {
      asked++;
      return Promise.reject(
        new LedgerSourceError("http_status", "rpc answered 429", {
          retryable: true,
          retryAfterSeconds: 3_600,
        }),
      );
    };
    const abort = new AbortController();
    let rounds = 0;
    await ingester({
      rpc,
      to: undefined,
      signal: abort.signal,
      sleep: () => {
        if (++rounds === 4) abort.abort();
        return Promise.resolve();
      },
    }).run.run();
    expect(asked).toBe(1);
    expect(await indexedLedgers()).toEqual(CANDIDATES.map((ledger) => `${String(ledger)} pending null`));
  });
});

describe("commits sharing one database", () => {
  it("refresh shared sellers and days concurrently without colliding on the totals", async () => {
    await ingester({ to: 5_330_305 }).run.run();
    const [template] = (await db.selectFrom("settlements").selectAll().limit(1).execute()).map(
      settlementFromRow,
    );
    if (template === undefined) throw new Error("no row");
    const versions = { rules: RULES_VERSION, registry: "2026-10-22.1", classification: "x" };
    const commit = (ledger: number, txHash: string, payTo: string) =>
      new ExplorerStore(db).commitLedger({
        network: "stellar:testnet",
        epoch: "2025-12-17",
        ledger,
        hash: "bb".repeat(32),
        previousHash: "aa".repeat(32),
        closedAt: template.closedAt,
        source: "lake",
        rows: [{ ...template, ledger, txHash, innerHash: null, payTo } satisfies SettlementRow],
        failed: [],
        excluded: {},
        versions,
      });
    for (let round = 0; round < 20; round++) {
      const a = 6_400_000 + round * 2;
      await db
        .insertInto("indexed_ledgers")
        .values(
          [a, a + 1].map((ledger) => ({
            network: "stellar:testnet",
            epoch: "2025-12-17",
            ledger,
            status: "pending" as const,
          })),
        )
        .execute();
      // Both commits touch the same seller, the same payer and the same UTC day.
      const payTo = `GA${String(round).padStart(54, "A")}`;
      const tx = (side: number) => `${String(round).padStart(4, "0")}${String(side)}`.padEnd(64, "c");
      const results = await Promise.allSettled([commit(a, tx(0), payTo), commit(a + 1, tx(1), payTo)]);
      expect(results.filter((result) => result.status === "rejected")).toEqual([]);
      const totals = await db
        .selectFrom("account_totals")
        .select("payments")
        .where("address", "=", payTo)
        .where("role", "=", "payTo")
        .execute();
      expect(totals).toEqual([{ payments: "2" }]);
    }
    // A ledger that is no longer pending is never written twice.
    expect(await commit(6_400_000, "dd".repeat(32), template.payTo)).toBe(false);
    expect(await count(db, "settlements")).toBe(41);
  });
});

describe("account totals", () => {
  it("list each side apart, verified assets first, and count what they leave out", async () => {
    const victim = "GBSVTVRQ7HV3AEIEBPGDLFDDJ7NIWFQTHDJ4CVBYQHEXHMV5O5EGELYP";
    const row = (role: "payer" | "payTo", contract: string, verified: boolean, payments: number) => ({
      network: "stellar:testnet",
      epoch: "2025-12-17",
      address: victim,
      role,
      asset_contract: contract,
      asset_code: verified ? "USDC" : null,
      asset_issuer: null,
      asset_verified: verified,
      payments,
      volume: payments * 10,
      first_at: "2026-10-01T00:00:00Z",
      last_at: "2026-10-02T00:00:00Z",
    });
    // 150 throwaway tokens received once each, sorting before everything by contract id.
    const spam = Array.from({ length: 150 }, (_, index) =>
      row("payTo", `CA${String(index).padStart(54, "A")}`, false, 1),
    );
    await db
      .insertInto("account_totals")
      .values([
        ...spam,
        row("payTo", "CZUSDC".padEnd(56, "Z"), true, 3),
        row("payer", "CZPAID".padEnd(56, "Z"), true, 2),
        row("payer", "CYPAID".padEnd(56, "Y"), false, 5),
      ])
      .execute();
    const totals = await new ExplorerReader(db).accountTotals("stellar:testnet", "2025-12-17", victim);
    const paid = totals.items.filter((item) => item.role === "payer");
    const received = totals.items.filter((item) => item.role === "payTo");
    expect(paid.map((item) => [item.assetVerified, item.payments])).toEqual([
      [true, 2],
      [false, 5],
    ]);
    expect(received).toHaveLength(TOTALS_PER_SIDE);
    expect(received[0]).toMatchObject({ assetVerified: true, payments: 3 });
    expect(totals.more).toEqual({ payer: 0, payTo: 151 - TOTALS_PER_SIDE });
  });
});
