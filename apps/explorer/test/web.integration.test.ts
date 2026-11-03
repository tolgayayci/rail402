/**
 * The web role end to end over a real Postgres: the committed testnet ledgers indexed by the indexer
 * (writer role) from the recorded Lumeus discovery, then served and reported by the reader role. The
 * report's numbers and manifest must be byte-identical to what the rebuild command computes from the
 * ledgers the manifest lists.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@rail402.dev/store-postgres";
import { ExplorerReader } from "../src/api/queries.ts";
import { computeReport, type ComputedReport } from "../src/api/report.ts";
import { EXPLORER_MIGRATIONS, createExplorerDatabase, type ExplorerDatabase } from "../src/db.ts";
import { LedgerBytes } from "../src/indexer/bytes.ts";
import { Ingester } from "../src/indexer/ingester.ts";
import { ExplorerMetrics } from "../src/metrics.ts";
import { DirectorySource } from "../src/rebuild/directory-source.ts";
import { ledgersFromManifest, rebuildLedgers, type RebuildResult } from "../src/rebuild/rebuild.ts";
import { assertReaderRole } from "../src/roles.ts";
import { exportSnapshot } from "../src/snapshot/snapshot.ts";
import { ExplorerStore } from "../src/store.ts";
import { ReportPublisher } from "../src/indexer/report-publisher.ts";
import { ReportCache } from "../src/web/report-cache.ts";
import { admin, statements, template, testNames, urlFor } from "./database.ts";
import { RecordedActivity } from "./discovery.ts";
import { FIXTURE_LEDGERS, FIXTURE_SLICE, FixtureSource } from "./sources.ts";
import { EPOCH, REGISTRY, TRANSACTIONS, liveLookup, testApp } from "./web.ts";

const names = testNames("web");
const DATABASE = names.database;
const FACILITATOR = names.facilitator_database;
const FROM = 5_330_305;
const TO = 5_330_320;
const password = randomBytes(12).toString("hex");
const scratch = mkdtempSync(join(tmpdir(), "rail402-explorer-web-"));
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
let reader: Kysely<ExplorerDatabase>;
let report: ComputedReport;
let rebuilt: RebuildResult;
let recomputed: ComputedReport;

async function cleanup(): Promise<void> {
  await admin(async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    await client.query(`DROP DATABASE IF EXISTS ${FACILITATOR} WITH (FORCE)`);
    for (const role of [names.reader, names.writer, names.owner])
      await client.query(`DROP ROLE IF EXISTS ${role}`);
  });
}

const connect = (name: string) =>
  createExplorerDatabase({ connectionString: urlFor(DATABASE, { name, password }) });

beforeAll(async () => {
  await cleanup();
  await admin(async (client) => {
    await client.query(`CREATE DATABASE ${FACILITATOR}`);
    for (const statement of statements(template("roles.sql", names))) await client.query(statement);
    for (const role of [names.owner, names.writer, names.reader]) {
      await client.query(`ALTER ROLE ${role} PASSWORD '${password}'`);
    }
  });
  const owner = connect(names.owner);
  try {
    await migrate(owner, EXPLORER_MIGRATIONS);
  } finally {
    await owner.destroy();
  }
  await admin(async (client) => {
    await client.query(`SET ROLE ${names.owner}`);
    for (const statement of statements(template("grants.sql", names))) await client.query(statement);
  }, DATABASE);

  const writer = connect(names.writer);
  try {
    await new Ingester({
      network: "stellar:testnet",
      registry: REGISTRY,
      epoch: EPOCH,
      store: new ExplorerStore(writer),
      activity: new RecordedActivity(),
      bytes: new LedgerBytes({ lake: new FixtureSource(FIXTURE_SLICE), concurrency: 2 }),
      metrics: new ExplorerMetrics(),
      logger: quiet,
      from: FROM,
      to: TO,
      concurrency: 2,
      pollMs: 1,
    }).run();
    // The indexer publishes the report; web processes only read it.
    await new ReportPublisher(
      writer,
      { network: "stellar:testnet", epoch: EPOCH, registry: REGISTRY },
      quiet,
    ).publish();
  } finally {
    await writer.destroy();
  }
  reader = connect(names.reader);
  const cache = new ReportCache(reader, [{ network: "stellar:testnet", epoch: EPOCH, registry: REGISTRY }]);
  await cache.refreshAll();
  report = cache.get("stellar:testnet") as ComputedReport;
  recomputed = (await computeReport(reader, {
    network: "stellar:testnet",
    epoch: EPOCH,
    registry: REGISTRY,
  })) as ComputedReport;
  // A third party's rebuild: the published manifest's ledger list, read from ledger files.
  const listed = ledgersFromManifest(report.manifestText);
  rebuilt = await rebuildLedgers({
    network: "stellar:testnet",
    epoch: EPOCH,
    registry: REGISTRY,
    source: new DirectorySource(fileURLToPath(FIXTURE_LEDGERS)),
    range: listed.range,
    ledgers: listed.ledgers,
    discovery: listed.discovery,
    outDir: join(scratch, "rebuild"),
  });
});

afterAll(async () => {
  await reader.destroy();
  await cleanup();
  rmSync(scratch, { recursive: true, force: true });
});

const app = (lookup?: ReturnType<typeof liveLookup>["lookup"]) =>
  testApp({ reader: new ExplorerReader(reader), report, ...(lookup === undefined ? {} : { lookup }) });

describe("the Explorer web role over the indexed testnet slice", () => {
  it("runs as the reader role, whose statement timeout cancels slow queries", async () => {
    await expect(assertReaderRole(reader, { facilitatorDatabase: FACILITATOR })).resolves.toBeUndefined();
    const slow = await sql`SELECT pg_sleep(3)`.execute(reader).catch((error: unknown) => error);
    expect((slow as { code?: string }).code).toBe("57014");
  });

  it("serves the report the indexer published, equal to computing it again", () => {
    expect(report).toBeDefined();
    expect(report.manifestText).toBe(recomputed.manifestText);
    expect(report.aggregatesText).toBe(recomputed.aggregatesText);
    expect({ ...report.document, generatedAt: "" }).toEqual({
      ...recomputed.document,
      generatedAt: "",
      networkWide: null,
    });
  });

  it("reports exactly what the rebuild command computes from the manifest's ledger list", () => {
    expect(report.document.range).toEqual({ from: FROM, to: TO });
    expect(report.document.scope).toBe("registry");
    expect(report.aggregatesText).toBe(readFileSync(join(scratch, "rebuild", "aggregates.json"), "utf8"));
    expect(report.manifestText).toBe(readFileSync(join(scratch, "rebuild", "manifest.json"), "utf8"));
    expect(report.document.manifestSha256).toBe(rebuilt.manifestSha256);
    expect(report.document.rebuildCommand).toBe(
      "pnpm explorer:rebuild --network testnet --ledgers-from manifest.json",
    );
    expect(report.document.auditCommand).toBe(
      `pnpm explorer:rebuild --network testnet --from ${String(FROM)} --to ${String(TO)}`,
    );
    expect(report.document.aggregates.rail402.payments).toBeGreaterThan(0);
    expect(report.document.rowRegistryVersions).toEqual([REGISTRY.registryVersion]);
  });

  it("serves the exact and upto payments, the payer's account and the report from the database", async () => {
    const explorer = app();
    const exact = TRANSACTIONS["rail402-exact"];
    const upto = TRANSACTIONS["rail402-upto"];
    const exactPage = await explorer.request(`/testnet/tx/${exact.hash}`);
    expect(exactPage.status).toBe(200);
    expect(exactPage.headers.get("cache-control")).toBe("public, max-age=3600, no-transform");
    const exactHtml = await exactPage.text();
    expect(exactHtml).toContain("Rail402 hosted");
    expect(exactHtml).not.toContain("Live lookup");
    const uptoHtml = await (await explorer.request(`/testnet/tx/${upto.hash}`)).text();
    expect(uptoHtml).toContain("Cap (upto)");

    const api = (await (await explorer.request(`/api/v1/testnet/transactions/${exact.hash}`)).json()) as {
      source: string;
      settlement: { payer: string; payTo: string; amount: string };
    };
    expect(api.source).toBe("index");
    const account = (await (
      await explorer.request(`/api/v1/testnet/accounts/${api.settlement.payer}`)
    ).json()) as { totals: { role: string; payments: number }[] };
    expect(account.totals.find((total) => total.role === "payer")?.payments).toBeGreaterThan(0);
    const accountHtml = await (await explorer.request(`/testnet/account/${api.settlement.payer}`)).text();
    expect(accountHtml).toContain(exact.hash.slice(0, 6));

    const reportJson = (await (await explorer.request("/api/v1/testnet/report")).json()) as {
      manifestSha256: string;
    };
    expect(reportJson.manifestSha256).toBe(rebuilt.manifestSha256);
    const manifest = await (await explorer.request("/api/v1/testnet/manifest")).text();
    expect(manifest).toBe(report.manifestText);
    const ecosystem = await (await explorer.request("/testnet/ecosystem")).text();
    expect(ecosystem).toContain(report.document.manifestSha256);
    expect(ecosystem).toContain(`>${String(report.document.aggregates.headline.payments)}<`);
    expect(ecosystem).toContain("Unattributed x402-shaped (not counted above)");
    expect(ecosystem).toContain("counted only by a full-scan rebuild");
    expect(ecosystem).toContain(report.document.auditCommand);
    expect(ecosystem).not.toMatch(/57,054|2,620/);

    const facilitator = (await (
      await explorer.request("/api/v1/testnet/facilitators/rail402/settlements?limit=1")
    ).json()) as { items: unknown[]; nextCursor: string | null };
    expect(facilitator.items).toHaveLength(1);
    expect(facilitator.nextCursor).not.toBeNull();
  });

  it("lists, filters and pages payments, and reads what a seller received, from the database", async () => {
    const db = new ExplorerReader(reader);
    const epoch = EPOCH.id;
    const network = "stellar:testnet" as const;
    const all = await db.payments(network, epoch, {}, { after: undefined, limit: 100 });
    expect(all.items.length).toBeGreaterThan(0);
    expect(
      all.items.every((row) => row.attribution.tier === "rail402" || row.attribution.tier === "facilitator"),
    ).toBe(true);
    const upto = await db.payments(network, epoch, { scheme: "upto" }, { after: undefined, limit: 100 });
    expect(upto.items.length).toBeGreaterThan(0);
    expect(upto.items.every((row) => row.scheme === "upto")).toBe(true);
    const rail402 = await db.payments(
      network,
      epoch,
      { facilitator: "rail402" },
      { after: undefined, limit: 1 },
    );
    expect(rail402.items[0]?.attribution.facilitatorId).toBe("rail402");
    expect(rail402.nextCursor).not.toBeNull();
    const asset = all.items[0]?.asset.contract ?? "";
    const byAsset = await db.payments(network, epoch, { asset }, { after: undefined, limit: 100 });
    expect(byAsset.items.every((row) => row.asset.contract === asset)).toBe(true);
    const newest = all.items[0];
    expect(newest).toBeDefined();
    const since = await db.firstLedgerSince(network, epoch, newest?.closedAt ?? "");
    expect(since).toBe(newest?.ledger);
    expect(await db.firstLedgerSince(network, epoch, "2999-01-01T00:00:00Z")).toBeNull();
    const recent = await db.payments(
      network,
      epoch,
      { fromLedger: since ?? 0, window: "24h" },
      { after: undefined, limit: 100 },
    );
    expect(recent.items.every((row) => row.ledger >= (since ?? 0))).toBe(true);

    const exact = TRANSACTIONS["rail402-exact"];
    const found = await db.settlementsByHash(network, [epoch], [exact.hash]);
    expect(found.map((row) => row.txHash)).toEqual([exact.hash]);
    const payTo = found[0]?.payTo ?? "";
    const summary = await db.sellerSummary(network, epoch, payTo);
    const totals = await db.sellerTotals(network, epoch, [payTo]);
    expect(summary.exact + summary.upto).toBe(totals.get(payTo)?.payments);
    expect(summary.payers).toBeGreaterThan(0);
    // A view reads the counts the indexer keeps, never the seller's settlements: a change to the kept
    // row is what the page shows.
    const shift = (by: number) =>
      admin(
        (client) =>
          client.query(
            "UPDATE seller_summaries SET exact = exact + $1 WHERE network = $2 AND epoch = $3 AND pay_to = $4",
            [by, network, epoch, payTo],
          ),
        DATABASE,
      );
    await shift(1000);
    expect((await db.sellerSummary(network, epoch, payTo)).exact).toBe(summary.exact + 1000);
    await shift(-1000);
    const uptoReceived = await db.uptoReceived(network, epoch, payTo, 5);
    expect(uptoReceived.every((row) => row.scheme === "upto" && row.payTo === payTo)).toBe(true);

    const explorer = app();
    for (const path of [
      "/testnet",
      "/testnet/payments",
      "/testnet/payments?scheme=upto",
      "/testnet/facilitators",
      `/testnet/account/${payTo}`,
    ]) {
      expect((await explorer.request(path)).status, path).toBe(200);
    }
    const csv = await (await explorer.request("/testnet/payments.csv")).text();
    expect(csv.split("\r\n").length).toBeGreaterThan(2);
  });

  it("opens a hash the index does not hold through a live lookup", async () => {
    const x402org = TRANSACTIONS["x402org-exact-1"];
    const { lookup } = liveLookup({ [x402org.hash]: x402org });
    const response = await app(lookup).request(`/api/v1/testnet/transactions/${x402org.hash}`);
    expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(await response.json()).toMatchObject({ source: "live", kind: "settlement" });
  });

  it("exports a snapshot whose manifest is the rebuild's", async () => {
    const out = join(scratch, "snapshot");
    const exported = await exportSnapshot(reader, {
      network: "stellar:testnet",
      epoch: EPOCH,
      registry: REGISTRY,
      outDir: out,
      publicUrl: "https://explorer.example.org",
    });
    expect(exported?.document.manifestSha256).toBe(rebuilt.manifestSha256);
    for (const file of ["manifest.json", "aggregates.json", "settlements.ndjson", "failed_attempts.ndjson"]) {
      expect(readFileSync(join(out, file), "utf8"), file).toBe(
        readFileSync(join(scratch, "rebuild", file), "utf8"),
      );
    }
    const html = readFileSync(join(out, "report.html"), "utf8");
    expect(html).not.toMatch(/<script/);
    expect(html).toContain("https://explorer.example.org/api/v1/testnet/manifest");
    expect(JSON.parse(readFileSync(join(out, "report.json"), "utf8"))).toMatchObject({
      range: { from: FROM, to: TO },
    });
  });
});
