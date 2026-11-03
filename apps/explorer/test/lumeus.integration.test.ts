/**
 * The registry-scope indexer live against Lumeus testnet and the public data lake, compared with a full
 * scan of the same ledgers. Runs only when RAIL402_LUMEUS_TESTNET_KEY_FILE names a file holding a Lumeus
 * testnet key (the key itself, or a JSON object whose `testnet` field is the key); the key is passed to
 * the clients in memory and never written anywhere. Testnet only: a mainnet key is refused.
 */
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kysely } from "kysely";
import { afterAll, describe, expect, it } from "vitest";
import {
  DATA_LAKE_BASE_URL,
  DataLakeSource,
  Limiter,
  LumeusActivity,
  RpcLedgerSource,
  lumeusUrl,
} from "@rail402.dev/ledger-source";
import type { SettlementRow } from "@rail402.dev/x402-index";
import { REGISTRIES } from "@rail402.dev/x402-index/registry";
import type { ExplorerDatabase } from "../src/db.ts";
import { LedgerBytes } from "../src/indexer/bytes.ts";
import { Ingester } from "../src/indexer/ingester.ts";
import { ExplorerMetrics } from "../src/metrics.ts";
import { computeReport } from "../src/api/report.ts";
import { rebuild, rebuildLedgers, ledgersFromManifest } from "../src/rebuild/rebuild.ts";
import { ExplorerStore, settlementFromRow } from "../src/store.ts";
import { dropDatabase, freshDatabase, testName } from "./database.ts";

function testnetKey(): string | undefined {
  const file = process.env["RAIL402_LUMEUS_TESTNET_KEY_FILE"];
  if (file === undefined || file === "") return undefined;
  const text = readFileSync(file, "utf8").trim();
  if (!text.startsWith("{")) return text;
  const field = (JSON.parse(text) as { testnet?: unknown }).testnet;
  return typeof field === "string" ? field : undefined;
}

const key = testnetKey();
const registry = REGISTRIES["stellar:testnet"];
const epoch =
  registry.document.epochs.at(-1) ??
  (() => {
    throw new Error("no epoch");
  })();
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** Known Rail402 testnet payments, each with the ledger window indexed around it. */
const KNOWN = [
  {
    from: 5_330_305,
    to: 5_330_320,
    payments: [
      { hash: "2cc59d87", scheme: "exact" },
      { hash: "336ef628", scheme: "upto" },
    ],
  },
  {
    from: 5_346_955,
    to: 5_346_970,
    payments: [{ hash: "b502a355208f684d59f05b2c675847722845bbdc8429b1b44cee50d38eebd8bf", scheme: "exact" }],
  },
] as const;

let db: Kysely<ExplorerDatabase> | undefined;
const scratch = mkdtempSync(join(tmpdir(), "rail402-explorer-lumeus-"));
afterAll(async () => {
  await db?.destroy();
  if (db !== undefined) await dropDatabase(testName("lumeus"));
  rmSync(scratch, { recursive: true, force: true });
});

describe.skipIf(key === undefined)("the registry-scope indexer against Lumeus testnet", () => {
  for (const window of KNOWN) {
    it(
      `finds and classifies the known payments in ledgers ${String(window.from)}-${String(window.to)} as a full scan does`,
      { timeout: 300_000 },
      async () => {
        if (key === undefined) return;
        await db?.destroy();
        db = await freshDatabase("lumeus");
        const limiter = new Limiter(4);
        const metrics = new ExplorerMetrics();
        const rpc = new RpcLedgerSource({
          url: lumeusUrl("stellar:testnet", "rpc"),
          network: "stellar:testnet",
          apiKey: key,
          limiter,
          pageLimit: 100,
        });
        const lake = new DataLakeSource({ folder: epoch.dataLakeFolder, passphrase: epoch.passphrase });
        const store = new ExplorerStore(db);
        await store.loadRegistry(registry);
        await new Ingester({
          network: "stellar:testnet",
          registry,
          epoch,
          store,
          activity: new LumeusActivity({ network: "stellar:testnet", apiKey: key, limiter }),
          bytes: new LedgerBytes({ lake, rpc, pageLimit: 100, concurrency: 4 }),
          metrics,
          logger: quiet,
          from: window.from,
          to: window.to,
          concurrency: 4,
          pollMs: 5_000,
        }).run();

        const stored = (
          await db.selectFrom("settlements").selectAll().orderBy("ledger").orderBy("tx_index").execute()
        ).map(settlementFromRow);
        const sources = await db
          .selectFrom("indexed_ledgers")
          .select(["ledger", "status", "source"])
          .execute();
        expect(sources.length).toBeGreaterThan(0);
        expect(sources.every((entry) => entry.status === "indexed")).toBe(true);
        // Inside the RPC retention: the bytes came from Lumeus RPC.
        expect(sources.some((entry) => entry.source === "rpc")).toBe(true);
        for (const payment of window.payments) {
          const row = stored.find((entry) => entry.txHash.startsWith(payment.hash));
          expect(row, payment.hash).toBeDefined();
          expect(row).toMatchObject({
            scheme: payment.scheme,
            attribution: { tier: "rail402", facilitatorId: "rail402" },
          });
        }

        // The full scan of the same range from the public data lake: the same row for every transaction
        // found, and the same attributed rows.
        const full = await rebuild({
          network: "stellar:testnet",
          epoch,
          registry,
          source: lake,
          sourceDescription: { kind: "data-lake", uri: `${DATA_LAKE_BASE_URL}${epoch.dataLakeFolder}/` },
          from: window.from,
          to: window.to,
          outDir: join(scratch, `full-${String(window.from)}`),
        });
        const attributed = (rows: readonly SettlementRow[]) =>
          rows.filter((row) => row.attribution.tier !== "shaped");
        expect(attributed(stored)).toEqual(attributed(full.rows));
        const fullByHash = new Map(full.rows.map((row) => [row.txHash, row]));
        for (const row of stored) expect(row).toEqual(fullByHash.get(row.txHash));

        // The published manifest rebuilds from the data lake alone, whatever source served the bytes.
        const report = await computeReport(db, { network: "stellar:testnet", epoch, registry });
        expect(report?.document.range).toEqual({ from: window.from, to: window.to });
        expect(report?.document.discovery.bytes.rpc).toBeGreaterThan(0);
        const listed = ledgersFromManifest(report?.manifestText ?? "");
        const rebuilt = await rebuildLedgers({
          network: "stellar:testnet",
          epoch,
          registry,
          source: lake,
          range: listed.range,
          ledgers: listed.ledgers,
          discovery: listed.discovery,
          outDir: join(scratch, `listed-${String(window.from)}`),
        });
        expect(rebuilt.manifestSha256).toBe(report?.document.manifestSha256);
        expect(
          await metrics.registry.getSingleMetricAsString("rail402_explorer_ledgers_indexed_total"),
        ).toContain('source="rpc"');
      },
    );
  }

  it(
    "finds a concluded beta upto settlement through topic search, as a full scan does",
    { timeout: 300_000 },
    async () => {
      if (key === undefined) return;
      await db?.destroy();
      db = await freshDatabase("lumeus");
      const limiter = new Limiter(4);
      const lake = new DataLakeSource({ folder: epoch.dataLakeFolder, passphrase: epoch.passphrase });
      const store = new ExplorerStore(db);
      await store.loadRegistry(registry);
      // Ledgers around the beta settlement b38c1add… (contract CCMM3FMG…), long out of RPC retention.
      const from = 3_953_870;
      const to = 3_953_890;
      await new Ingester({
        network: "stellar:testnet",
        registry,
        epoch,
        store,
        activity: new LumeusActivity({ network: "stellar:testnet", apiKey: key, limiter }),
        bytes: new LedgerBytes({ lake, concurrency: 4 }),
        metrics: new ExplorerMetrics(),
        logger: quiet,
        from,
        to,
        concurrency: 4,
        pollMs: 5_000,
      }).run();
      const routes = await db.selectFrom("discovery_routes").select(["kind", "address"]).execute();
      expect(routes.filter((route) => route.kind === "approvals").length).toBeGreaterThan(0);
      const stored = (
        await db.selectFrom("settlements").selectAll().orderBy("ledger").orderBy("tx_index").execute()
      ).map(settlementFromRow);
      const beta = stored.find((row) => row.txHash.startsWith("b38c1add"));
      expect(beta).toMatchObject({
        scheme: "upto",
        ruleId: "R-UPTO-BETA",
        attribution: { tier: "rail402-beta" },
      });
      const full = await rebuild({
        network: "stellar:testnet",
        epoch,
        registry,
        source: lake,
        sourceDescription: { kind: "data-lake", uri: `${DATA_LAKE_BASE_URL}${epoch.dataLakeFolder}/` },
        from,
        to,
        outDir: join(scratch, `full-${String(from)}`),
      });
      const attributed = (rows: readonly SettlementRow[]) =>
        rows.filter((row) => row.attribution.tier !== "shaped");
      expect(attributed(stored)).toEqual(attributed(full.rows));
    },
  );
});
