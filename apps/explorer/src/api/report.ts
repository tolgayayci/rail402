import { createHash, type Hash } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import {
  RULES_VERSION,
  type ExclusionReason,
  type FailedAttemptRow,
  type IndexNetwork,
  type RegistrySnapshot,
  type SettlementRow,
} from "@rail402.dev/x402-index";
import type { ExplorerDatabase } from "../db.ts";
import type { Epoch } from "../epoch.ts";
import { Aggregator, canonicalJson, sha256, type Aggregates } from "../rebuild/aggregates.ts";
import {
  MANIFEST_VERSION,
  PartitionLines,
  registryPartitions,
  registrySource,
  type DiscoverySource,
  type Manifest,
  type ManifestFile,
} from "../rebuild/rebuild.ts";
import { discoveredThrough, settlementFromRow, storedRoute, type StoredRoute } from "../store.ts";
import { loadNetworkWindow, type NetworkWindowDocument } from "../window/window.ts";

const distinct = (values: readonly (string | null)[]): string[] =>
  [...new Set(values.filter((value): value is string => value !== null))].sort();

/** Rows read per statement while scanning; each statement stays far below the reader's timeout. */
const CHUNK = 1_000;

/** A candidate ledger as the report reads it. */
export interface CoverageLedger {
  readonly ledger: number;
  readonly status: "pending" | "indexed" | "failed";
  readonly hash: string | null;
  readonly source: "lake" | "rpc" | null;
  /** Rows of the ledger that a registry facilitator settled (0 when it is not indexed yet). */
  readonly attributed?: number;
}

/** The run of ledgers a registry-scope report covers. */
export interface Coverage {
  readonly from: number;
  readonly to: number;
  /** The indexed candidate ledgers inside the range, ascending. */
  readonly ledgers: readonly CoverageLedger[];
  /** The first candidate ledger the report leaves out because it is not indexed yet or failed. */
  readonly detachedFrom: number | null;
  /** Why the coverage stops before `detachedFrom`: a ledger still waiting to be read, or one that failed. */
  readonly stop: "pending" | "failed" | null;
}

/**
 * The range a registry-scope report covers: from the first route's start through the last ledger every
 * route has walked (`discoveredThrough`), cut before the first candidate ledger in it that is not indexed
 * yet or failed, so every candidate inside the range is indexed and a rebuild of its ledger list gives
 * the same result. Undefined before discovery has covered any ledger.
 */
export function coverageOf(
  routes: readonly StoredRoute[],
  ledgers: readonly CoverageLedger[],
): Coverage | undefined {
  const through = discoveredThrough(routes);
  if (through === null) return undefined;
  const from = Math.min(...routes.map((route) => route.from));
  const sorted = [...ledgers].sort((a, b) => a.ledger - b.ledger);
  const blocked = sorted.find((entry) => entry.ledger <= through && entry.status !== "indexed");
  const to = blocked === undefined ? through : Math.min(through, blocked.ledger - 1);
  if (to < from) return undefined;
  return {
    from,
    to,
    ledgers: sorted.filter(
      (entry) => entry.ledger >= from && entry.ledger <= to && entry.status === "indexed",
    ),
    detachedFrom: blocked?.ledger ?? null,
    stop: blocked === undefined ? null : blocked.status === "failed" ? "failed" : "pending",
  };
}

/** How the ledgers of a registry-scope report were selected and read. */
export interface ReportDiscovery {
  readonly source: DiscoverySource;
  /** Discovery routes: one per registry facilitator account and upto contract. */
  readonly routes: number;
  /** The discovery source's index generation and decoder of the routes' last windows (sorted, distinct). */
  readonly generations: readonly string[];
  readonly decoderVersions: readonly string[];
  /** Candidate ledgers in the range, all read, verified and classified. */
  readonly ledgersRead: number;
  /**
   * Of those, the ledgers that held no row a registry facilitator settled: a registry address took part
   * in some other transaction there, or the discovery source listed a ledger it should not have. Their
   * own rows (unattributed `shaped` rows, failed attempts, exclusion counts) are counted like any other
   * ledger's, and the manifest lists them.
   */
  readonly ledgersWithoutAttributedRow: number;
  /** Where their bytes came from (each one verified against its own hashes whatever the source). */
  readonly bytes: { readonly lake: number; readonly rpc: number };
}

export interface ReportDocument {
  readonly network: IndexNetwork;
  readonly epoch: string;
  readonly generatedAt: string;
  /**
   * `registry`: the ledgers discovery selected for the registry's facilitator accounts and upto contracts,
   * not every ledger of the range. The unattributed shaped totals of a full scan are not measured here.
   */
  readonly scope: "registry";
  /**
   * What the attributed totals (`aggregates.headline`) measure: the facilitators in the public registry,
   * Rail402 included, as registry discovery reads them. Never every x402 payment on the network.
   */
  readonly headlineScope: "registered-facilitators";
  readonly range: { readonly from: number; readonly to: number };
  /** The first candidate ledger left out of this report (not indexed yet, or failed). */
  readonly detachedFrom: number | null;
  /** Why the covered range stops before `detachedFrom` (see `Coverage.stop`). */
  readonly coverageStop: Coverage["stop"];
  /** Candidate ledgers of the epoch the indexer marked failed; the report stops before the first. */
  readonly failedLedgers: readonly number[];
  readonly discovery: ReportDiscovery;
  readonly rulesVersion: string;
  readonly registryVersion: string;
  readonly registrySha256: string;
  /** Registry versions the covered rows were attributed under; one entry equal to registryVersion when current. */
  readonly rowRegistryVersions: readonly string[];
  /**
   * Whether every covered row carries the current rules and registry versions, so a rebuild of the
   * manifest's ledger list gives this manifest's totals and files, and no candidate ledger of the epoch
   * failed an integrity check. False while rows are being re-attributed or indexed again, or while a
   * failed ledger holds the report back.
   */
  readonly reproducible: boolean;
  readonly aggregates: Aggregates;
  /** Names of the asset contracts in the totals: a code only for verified Stellar assets. */
  readonly assets: Readonly<
    Record<
      string,
      { readonly code: string | null; readonly issuer: string | null; readonly verified: boolean }
    >
  >;
  readonly manifestSha256: string;
  /** Rebuilds this manifest from the public data lake: the same ledger list, rules and registry. */
  readonly rebuildCommand: string;
  /**
   * The full scan of the same range from the public data lake: every ledger, so it also measures the
   * unattributed shaped totals; its attributed rows must equal this report's.
   */
  readonly auditCommand: string;
  /**
   * The network-wide block: a full-scope rebuild of a recent window of ledgers, counting every
   * facilitator, registered or not. Null when the network window job is off or has not run yet. It is
   * published by its own job and attached when the report is read; it is not part of `manifestSha256`.
   */
  readonly networkWide?: NetworkWindowDocument | null;
}

export interface ComputedReport {
  readonly document: ReportDocument;
  /** The network-wide window's manifest.json, when one is published. */
  readonly networkWindowManifest?: string;
  readonly manifest: Manifest;
  /** manifest.json exactly as a rebuild writes it; its SHA-256 is `document.manifestSha256`. */
  readonly manifestText: string;
  readonly aggregatesText: string;
}

/** Where a snapshot export writes the rows while the report is computed. */
export interface ReportSinks {
  settlement(line: string): void | Promise<void>;
  failedAttempt(line: string): void | Promise<void>;
}

class FileDigest {
  readonly #hash: Hash = createHash("sha256");
  #bytes = 0;
  #lines = 0;

  add(line: string): void {
    this.#hash.update(line);
    this.#bytes += Buffer.byteLength(line);
    this.#lines++;
  }

  describe(): ManifestFile {
    return { sha256: this.#hash.digest("hex"), bytes: this.#bytes, lines: this.#lines };
  }
}

export const networkName = (network: IndexNetwork) => (network === "stellar:pubnet" ? "pubnet" : "testnet");

/**
 * Computes a network's report from the Explorer database: the totals of every settlement in the candidate
 * ledgers of the covered range, by the same `Aggregator` the rebuild command uses, and a registry-scope
 * manifest byte-identical to the one `pnpm explorer:rebuild --ledgers-from` writes for the same ledger
 * list, rules and registry. Everything is read in one repeatable-read transaction, so rows the indexer
 * commits meanwhile never half-enter the report. Returns undefined before discovery covers a ledger.
 */
export async function computeReport(
  db: Kysely<ExplorerDatabase>,
  options: {
    readonly network: IndexNetwork;
    readonly epoch: Epoch;
    readonly registry: RegistrySnapshot;
    readonly now?: () => Date;
    readonly sinks?: ReportSinks;
  },
): Promise<ComputedReport | undefined> {
  const { network, epoch, registry } = options;
  return db
    .transaction()
    .setIsolationLevel("repeatable read")
    .execute(async (trx) => {
      await sql`SET TRANSACTION READ ONLY`.execute(trx);
      const routes = (
        await trx
          .selectFrom("discovery_routes")
          .selectAll()
          .where("network", "=", network)
          .where("epoch", "=", epoch.id)
          .execute()
      ).map(storedRoute);
      const candidates = (
        await trx
          .selectFrom("indexed_ledgers")
          .select(["ledger", "status", "hash", "source", "attributed"])
          .where("network", "=", network)
          .where("epoch", "=", epoch.id)
          .orderBy("ledger")
          .execute()
      ).map((row) => ({
        ledger: Number(row.ledger),
        status: row.status,
        hash: row.hash,
        source: row.source,
        attributed: Number(row.attributed),
      }));
      const coverage = coverageOf(routes, candidates);
      if (coverage === undefined) return undefined;
      const aggregator = new Aggregator();
      const settlements = new FileDigest();
      const failedFile = new FileDigest();
      // Rows are hashed per partition as they stream by; only failed-attempt counts are kept per ledger.
      const partitionLines = new PartitionLines();
      const failedPerLedger = new Map<number, number>();
      const rowVersions = new Set<string>();
      const rowRules = new Set<string>();
      const assets = new Map<string, { code: string | null; issuer: string | null; verified: boolean }>();

      // Only rows of the listed ledgers count, whatever else the tables hold, so the report always equals
      // a rebuild of its manifest's ledger list.
      const read = new Set(coverage.ledgers.map((entry) => entry.ledger));
      for await (const row of scanSettlements(trx, network, epoch.id, coverage)) {
        if (!read.has(row.ledger)) continue;
        const line = `${canonicalJson(row)}\n`;
        aggregator.add(row);
        settlements.add(line);
        rowVersions.add(row.registryVersion);
        rowRules.add(row.rulesVersion);
        if (!assets.has(row.asset.contract)) {
          assets.set(row.asset.contract, {
            code: row.asset.verified ? row.asset.code : null,
            issuer: row.asset.verified ? row.asset.issuer : null,
            verified: row.asset.verified,
          });
        }
        partitionLines.add(row.ledger, line);
        await options.sinks?.settlement(line);
      }
      let failedCount = 0;
      for await (const row of scanFailed(trx, network, epoch.id, coverage)) {
        if (!read.has(row.ledger)) continue;
        const line = `${canonicalJson(row)}\n`;
        failedFile.add(line);
        failedCount++;
        failedPerLedger.set(row.ledger, (failedPerLedger.get(row.ledger) ?? 0) + 1);
        await options.sinks?.failedAttempt(line);
      }
      aggregator.addFailedAttempts(failedCount);
      const excluded = await trx
        .selectFrom("ledger_exclusions")
        .select(["ledger", "reason", sql<string>`sum(count)`.as("count")])
        .where("network", "=", network)
        .where("epoch", "=", epoch.id)
        .where("ledger", ">=", String(coverage.from))
        .where("ledger", "<=", String(coverage.to))
        .groupBy(["ledger", "reason"])
        .execute();
      const exclusions = new Map<string, number>();
      for (const row of excluded) {
        if (!read.has(Number(row.ledger))) continue;
        exclusions.set(row.reason, (exclusions.get(row.reason) ?? 0) + Number(row.count));
      }
      for (const [reason, total] of [...exclusions].sort(([a], [b]) => a.localeCompare(b))) {
        if (total > 0) aggregator.addExcluded(reason as ExclusionReason, total);
      }

      // The independent anchors the indexer checked for the ledgers it read, as a rebuild lists them.
      const anchors = (
        await trx
          .selectFrom("anchors")
          .select(["ledger", "hash"])
          .where("network", "=", network)
          .where("epoch", "=", epoch.id)
          .where("ledger", ">=", String(coverage.from))
          .where("ledger", "<=", String(coverage.to))
          .orderBy("ledger")
          .execute()
      )
        .map((row) => ({ ledger: Number(row.ledger), hash: row.hash }))
        .filter((anchor) => read.has(anchor.ledger));
      const failedLedgers = candidates
        .filter((entry) => entry.status === "failed")
        .map((entry) => entry.ledger);
      const ledgers = coverage.ledgers.map((entry) => ({ ledger: entry.ledger, hash: entry.hash ?? "" }));

      const aggregates = aggregator.result();
      const aggregatesText = `${canonicalJson(aggregates)}\n`;
      const manifest: Manifest = {
        manifestVersion: MANIFEST_VERSION,
        scope: "registry",
        network,
        epoch: epoch.id,
        rulesVersion: RULES_VERSION,
        registryVersion: registry.registryVersion,
        rowVersions: { rules: [...rowRules].sort(), registry: [...rowVersions].sort() },
        registrySha256: sha256(canonicalJson(registry.document)),
        source: registrySource(epoch, "lumeus"),
        range: { from: coverage.from, to: coverage.to },
        ledgers,
        anchors,
        partitions: registryPartitions(ledgers, partitionLines, (ledger) => failedPerLedger.get(ledger) ?? 0),
        files: {
          "settlements.ndjson": settlements.describe(),
          "failed_attempts.ndjson": failedFile.describe(),
          "aggregates.json": {
            sha256: sha256(aggregatesText),
            bytes: Buffer.byteLength(aggregatesText),
            lines: 1,
          },
        },
        totalsSha256: sha256(aggregatesText),
      };
      const manifestText = `${canonicalJson(manifest)}\n`;
      const name = networkName(network);
      const document: ReportDocument = {
        network,
        epoch: epoch.id,
        generatedAt: (options.now?.() ?? new Date()).toISOString(),
        scope: "registry",
        headlineScope: "registered-facilitators",
        range: { from: coverage.from, to: coverage.to },
        detachedFrom: coverage.detachedFrom,
        coverageStop: coverage.stop,
        failedLedgers,
        discovery: {
          source: "lumeus",
          routes: routes.length,
          generations: distinct(routes.map((route) => route.generation)),
          decoderVersions: distinct(routes.map((route) => route.decoderVersion)),
          ledgersRead: coverage.ledgers.length,
          ledgersWithoutAttributedRow: coverage.ledgers.filter((entry) => (entry.attributed ?? 0) === 0)
            .length,
          bytes: {
            lake: coverage.ledgers.filter((entry) => entry.source === "lake").length,
            rpc: coverage.ledgers.filter((entry) => entry.source === "rpc").length,
          },
        },
        rulesVersion: RULES_VERSION,
        registryVersion: registry.registryVersion,
        registrySha256: manifest.registrySha256,
        rowRegistryVersions: [...rowVersions].sort(),
        reproducible:
          [...rowVersions].every((version) => version === registry.registryVersion) &&
          [...rowRules].every((version) => version === RULES_VERSION) &&
          failedLedgers.length === 0,
        aggregates,
        assets: Object.fromEntries([...assets].sort(([a], [b]) => a.localeCompare(b))),
        manifestSha256: sha256(manifestText),
        rebuildCommand: `pnpm explorer:rebuild --network ${name} --ledgers-from manifest.json`,
        auditCommand: `pnpm explorer:rebuild --network ${name} --from ${String(coverage.from)} --to ${String(coverage.to)}`,
      };
      return { document, manifest, manifestText, aggregatesText };
    });
}

async function* scanSettlements(
  trx: Transaction<ExplorerDatabase>,
  network: IndexNetwork,
  epoch: string,
  coverage: Coverage,
): AsyncGenerator<SettlementRow> {
  let after = { ledger: coverage.from - 1, txIndex: Number.MAX_SAFE_INTEGER };
  for (;;) {
    const rows = await trx
      .selectFrom("settlements")
      .selectAll()
      .where("network", "=", network)
      .where("epoch", "=", epoch)
      .where(
        sql<boolean>`(ledger, tx_index) > (${after.ledger}::bigint, ${Math.min(after.txIndex, 2 ** 31 - 1)}::integer)`,
      )
      .where("ledger", "<=", String(coverage.to))
      .orderBy("ledger")
      .orderBy("tx_index")
      .limit(CHUNK)
      .execute();
    for (const row of rows) yield settlementFromRow(row);
    const last = rows.at(-1);
    if (rows.length < CHUNK || last === undefined) return;
    after = { ledger: Number(last.ledger), txIndex: last.tx_index };
  }
}

async function* scanFailed(
  trx: Transaction<ExplorerDatabase>,
  network: IndexNetwork,
  epoch: string,
  coverage: Coverage,
): AsyncGenerator<FailedAttemptRow> {
  let after = { ledger: coverage.from - 1, txIndex: 2 ** 31 - 1 };
  for (;;) {
    const rows = await trx
      .selectFrom("failed_attempts")
      .selectAll()
      .where("network", "=", network)
      .where("epoch", "=", epoch)
      .where(sql<boolean>`(ledger, tx_index) > (${after.ledger}::bigint, ${after.txIndex}::integer)`)
      .where("ledger", "<=", String(coverage.to))
      .orderBy("ledger")
      .orderBy("tx_index")
      .limit(CHUNK)
      .execute();
    for (const row of rows) {
      yield {
        network: row.network as IndexNetwork,
        epoch: row.epoch,
        ledger: Number(row.ledger),
        txIndex: row.tx_index,
        txHash: row.tx_hash,
        scheme: row.scheme,
        resultCode: row.result_code,
        feePayer: row.fee_payer,
        feeChargedStroops: row.fee_charged,
      };
    }
    const last = rows.at(-1);
    if (rows.length < CHUNK || last === undefined) return;
    after = { ledger: Number(last.ledger), txIndex: last.tx_index };
  }
}

/** Stores a computed report as the network's current one (the indexer, as the writer role). */
export async function publishReport(db: Kysely<ExplorerDatabase>, report: ComputedReport): Promise<void> {
  const row = {
    network: report.document.network,
    epoch: report.document.epoch,
    generated_at: report.document.generatedAt,
    document: JSON.stringify(report.document),
    manifest: report.manifestText,
    aggregates: report.aggregatesText,
  };
  await db
    .insertInto("reports")
    .values(row)
    .onConflict((conflict) =>
      conflict.columns(["network", "epoch"]).doUpdateSet({
        generated_at: row.generated_at,
        document: row.document,
        manifest: row.manifest,
        aggregates: row.aggregates,
      }),
    )
    .execute();
}

/**
 * The network's current report as the indexer published it, or undefined before the first one. A stored
 * document of another scope or manifest version (one written before registry-scope indexing) is not
 * served: the web shows no report until the indexer publishes a current one.
 */
export async function loadReport(
  db: Kysely<ExplorerDatabase>,
  network: IndexNetwork,
  epoch: string,
): Promise<ComputedReport | undefined> {
  const row = await db
    .selectFrom("reports")
    .selectAll()
    .where("network", "=", network)
    .where("epoch", "=", epoch)
    .executeTakeFirst();
  if (row === undefined) return undefined;
  const document = JSON.parse(row.document) as Partial<ReportDocument> | null;
  const manifest = JSON.parse(row.manifest) as Partial<Manifest> | null;
  if (
    document?.scope !== "registry" ||
    typeof document.discovery !== "object" ||
    manifest?.manifestVersion !== MANIFEST_VERSION ||
    manifest.scope !== "registry"
  ) {
    return undefined;
  }
  const report: ComputedReport = {
    document: document as ReportDocument,
    manifest: manifest as Manifest,
    manifestText: row.manifest,
    aggregatesText: row.aggregates,
  };
  return underCurrentRules(report) ? withNetworkWindow(db, report) : undefined;
}

/**
 * Whether a report was computed under the rules this build runs, from rows of those rules only. A report
 * of other rules can total payers that these rules never proved, so it is not served; the indexer
 * publishes a current one once it has read the ledgers again.
 */
export function underCurrentRules(report: ComputedReport): boolean {
  if (report.document.rulesVersion !== RULES_VERSION) return false;
  const manifest = report.manifest as Partial<Manifest> | undefined;
  if (manifest === undefined) return true;
  const rows = manifest.rowVersions?.rules;
  return Array.isArray(rows) && rows.every((version) => version === RULES_VERSION);
}

/**
 * The report with the network's published window attached as `networkWide` (null when there is none, or
 * when it was classified under other rules), and the window's manifest for the API.
 */
export async function withNetworkWindow(
  db: Kysely<ExplorerDatabase>,
  report: ComputedReport,
): Promise<ComputedReport> {
  const published = await loadNetworkWindow(db, report.document.network, report.document.epoch);
  const window = published?.document.rulesVersion === RULES_VERSION ? published : undefined;
  return {
    ...report,
    document: { ...report.document, networkWide: window?.document ?? null },
    ...(window === undefined ? {} : { networkWindowManifest: window.manifestText }),
  };
}
