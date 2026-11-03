import { sql, type ColumnType, type Kysely, type Transaction } from "kysely";
import {
  attributeSettlement,
  classificationFingerprint,
  type ExclusionReason,
  type FailedAttemptRow,
  type IndexNetwork,
  type RegistrySnapshot,
  type SettlementRow,
} from "@rail402.dev/x402-index";
import type { ExplorerDatabase, RouteKind, SettlementsTable } from "./db.ts";

type Insertable<T> = {
  [K in keyof T]: T[K] extends ColumnType<unknown, infer I, unknown> ? I : T[K];
};

/** Rows per INSERT: 500 × 35 columns stays far below Postgres' limit of 65,535 bind parameters. */
export const INSERT_CHUNK = 500;

/** `items` in consecutive slices of at most `size`. */
export function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

/** A settlement row as stored. */
export function settlementToRow(row: SettlementRow): Insertable<SettlementsTable> {
  return {
    network: row.network,
    epoch: row.epoch,
    tx_hash: row.txHash,
    inner_hash: row.innerHash,
    ledger: row.ledger,
    tx_index: row.txIndex,
    closed_at: row.closedAt,
    scheme: row.scheme,
    rule_id: row.ruleId,
    rules_version: row.rulesVersion,
    registry_version: row.registryVersion,
    asset_contract: row.asset.contract,
    asset_code: row.asset.code,
    asset_issuer: row.asset.issuer,
    asset_verified: row.asset.verified,
    payer: row.payer,
    payer_kind: row.payerKind,
    pay_to: row.payTo,
    pay_to_muxed_id: row.payToMuxedId,
    amount: row.amount,
    max_amount: row.maxAmount,
    upto_contract: row.upto?.contract ?? null,
    upto_authority: row.upto?.authority ?? null,
    fee_bump: row.fee.bump,
    fee_payer: row.fee.payer,
    inner_source: row.fee.innerSource,
    op_source: row.fee.opSource,
    fee_charged: row.fee.chargedStroops,
    sponsored: row.fee.sponsored,
    tier: row.attribution.tier,
    facilitator_id: row.attribution.facilitatorId,
    evidence_url: row.attribution.evidenceUrl,
    shared_relayer: row.attribution.sharedRelayer,
    checks: [...row.checks],
  };
}

type StoredSettlement = {
  [K in keyof SettlementsTable]: SettlementsTable[K] extends ColumnType<infer S, unknown, unknown>
    ? S
    : SettlementsTable[K];
};

/** A stored settlement as the classifier's row type, for pages and the API. */
export function settlementFromRow(row: StoredSettlement): SettlementRow {
  return {
    network: row.network as IndexNetwork,
    epoch: row.epoch,
    ledger: Number(row.ledger),
    txIndex: row.tx_index,
    txHash: row.tx_hash,
    innerHash: row.inner_hash,
    closedAt: new Date(row.closed_at).toISOString(),
    scheme: row.scheme,
    ruleId: row.rule_id as SettlementRow["ruleId"],
    rulesVersion: row.rules_version,
    registryVersion: row.registry_version,
    asset: {
      contract: row.asset_contract,
      code: row.asset_code,
      issuer: row.asset_issuer,
      verified: row.asset_verified,
    },
    payer: row.payer,
    payerKind: row.payer_kind,
    payTo: row.pay_to,
    payToMuxedId: row.pay_to_muxed_id,
    amount: row.amount,
    maxAmount: row.max_amount,
    upto:
      row.upto_contract === null
        ? null
        : { contract: row.upto_contract, authority: row.upto_authority ?? "" },
    fee: {
      bump: row.fee_bump,
      payer: row.fee_payer,
      innerSource: row.inner_source,
      opSource: row.op_source,
      chargedStroops: row.fee_charged,
      sponsored: row.sponsored,
    },
    attribution: {
      tier: row.tier,
      facilitatorId: row.facilitator_id,
      evidenceUrl: row.evidence_url,
      sharedRelayer: row.shared_relayer,
    },
    checks: row.checks as SettlementRow["checks"],
  };
}

/** One candidate ledger, read, verified and classified, as one commit stores it. */
export interface LedgerCommit {
  readonly network: IndexNetwork;
  readonly epoch: string;
  readonly ledger: number;
  readonly hash: string;
  readonly previousHash: string;
  readonly closedAt: string;
  readonly source: "lake" | "rpc";
  readonly rows: readonly SettlementRow[];
  readonly failed: readonly FailedAttemptRow[];
  readonly excluded: Readonly<Partial<Record<ExclusionReason, number>>>;
  readonly versions: LedgerVersions;
  /** The ledger's hash as an independent source confirmed it before this commit. */
  readonly anchor?: CheckedAnchor;
}

/** A ledger hash an independent source confirmed, recorded with the rows it vouches for. */
export interface CheckedAnchor {
  readonly ledger: number;
  readonly hash: string;
  /** The anchor source's name, e.g. horizon:horizon.stellar.org. */
  readonly source: string;
}

/** The rules and registry a ledger's rows were produced with. */
export interface LedgerVersions {
  readonly rules: string;
  readonly registry: string;
  /** `classificationFingerprint()` of that registry. */
  readonly classification: string;
}

/** What `reconcileRegistry` did. */
export interface Reconciled {
  /** Ledgers whose rows were re-attributed in place. */
  readonly reattributed: number;
  /** Ledgers reset to be read and classified again (the rules or the upto contracts changed). */
  readonly reset: number;
}

/** A discovery route as stored, with its checkpoint. */
export interface StoredRoute {
  readonly kind: RouteKind;
  readonly address: string;
  readonly from: number;
  readonly to: number | null;
  /** The last ledger discovery covered, or null before the first completed window. */
  readonly scannedThrough: number | null;
  readonly generation: string | null;
  readonly decoderVersion: string | null;
  readonly snapshotLedger: number | null;
}

/** The discovery source's read view a page was read under. */
export interface DiscoveryReadView {
  readonly generation: string;
  readonly decoderVersion: string;
  readonly snapshotLedger: number;
}

/**
 * One page of a route's discovery walk: the candidate ledgers it found and the checkpoint it vouches
 * for (null when the page moves none; see `WalkStep`).
 */
export interface DiscoveryWindow {
  readonly network: IndexNetwork;
  readonly epoch: string;
  readonly kind: RouteKind;
  readonly address: string;
  readonly ledgers: readonly number[];
  readonly scannedThrough: number | null;
  readonly readView: DiscoveryReadView;
}

/** What storing a discovery page changed. */
export interface RecordedWindow {
  /** The route's checkpoint moved forward. */
  readonly moved: boolean;
  /** Candidate ledgers this page added that the route had not listed before. */
  readonly added: number;
}

/** A stored route row as a `StoredRoute`. */
export const storedRoute = (row: {
  kind: RouteKind;
  address: string;
  from_ledger: string;
  to_ledger: string | null;
  scanned_through: string | null;
  generation: string | null;
  decoder_version: string | null;
  snapshot_ledger: string | null;
}): StoredRoute => ({
  kind: row.kind,
  address: row.address,
  from: Number(row.from_ledger),
  to: row.to_ledger === null ? null : Number(row.to_ledger),
  scannedThrough: row.scanned_through === null ? null : Number(row.scanned_through),
  generation: row.generation,
  decoderVersion: row.decoder_version,
  snapshotLedger: row.snapshot_ledger === null ? null : Number(row.snapshot_ledger),
});

/**
 * The last ledger every route has walked through: a closed route walked to its end does not hold the
 * others back. Null before any route has completed a window.
 */
export function discoveredThrough(routes: readonly StoredRoute[], to?: number): number | null {
  if (routes.length === 0) return null;
  let through = Infinity;
  let closedEnd = 0;
  for (const route of routes) {
    const end = route.to === null ? to : to === undefined ? route.to : Math.min(route.to, to);
    const scanned = route.scannedThrough ?? route.from - 1;
    if (end !== undefined && scanned >= end) {
      closedEnd = Math.max(closedEnd, end);
      continue;
    }
    through = Math.min(through, scanned);
  }
  const result = through === Infinity ? closedEnd : through;
  const first = Math.min(...routes.map((route) => route.from));
  return result < first ? null : result;
}

/**
 * The indexer's writes. Every write is idempotent: settlement rows are keyed by (network, epoch,
 * tx_hash), candidates by (ledger, route), and each checkpoint moves in the same transaction as what it
 * vouches for.
 */
export class ExplorerStore {
  readonly db: Kysely<ExplorerDatabase>;

  constructor(db: Kysely<ExplorerDatabase>) {
    this.db = db;
  }

  /** Replaces the network's registry tables with `registry`, in one transaction. */
  async loadRegistry(registry: RegistrySnapshot): Promise<void> {
    const network = registry.network;
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom("facilitators").where("network", "=", network).execute();
      await trx.deleteFrom("upto_contracts").where("network", "=", network).execute();
      for (const facilitator of registry.document.facilitators) {
        await trx
          .insertInto("facilitators")
          .values({
            network,
            id: facilitator.id,
            name: facilitator.name,
            tier: facilitator.tier,
            shared_relayer: facilitator.sharedRelayer,
            registry_version: registry.registryVersion,
          })
          .execute();
        for (const account of facilitator.accounts) {
          const [evidence] = account.evidence;
          await trx
            .insertInto("facilitator_accounts")
            .values({
              network,
              facilitator_id: facilitator.id,
              address: account.address,
              role: account.role,
              epoch: account.epoch,
              valid_from: account.validFromLedger,
              valid_to: account.validToLedger,
              evidence_url: evidence?.url ?? "",
              evidence_sha256: evidence?.sha256 ?? "",
            })
            .execute();
        }
      }
      for (const entry of registry.document.uptoContracts) {
        await trx
          .insertInto("upto_contracts")
          .values({
            network,
            contract: entry.contract,
            wasm_sha256: entry.wasmSha256,
            epoch: entry.epoch,
            valid_from: entry.validFromLedger,
            valid_to: entry.validToLedger,
            rule: entry.rule,
            facilitator_id: entry.facilitatorId ?? null,
          })
          .execute();
      }
    });
  }

  /**
   * Makes the stored routes the given plan (registry bounds, never a bounded run's last ledger): new
   * routes start unwalked; a route whose first ledger moved earlier is walked again from its new start; a
   * route whose last ledger moved before its checkpoint keeps the checkpoint at that last ledger, so a
   * later widening walks the ledgers after it again; candidates outside a route's new bounds are dropped;
   * routes no longer in the plan are removed with their candidates. Ledgers no route lists any more are
   * removed with their rows, and the totals they touched are recomputed. Returns the number of ledgers
   * removed.
   */
  async syncRoutes(
    network: IndexNetwork,
    epoch: string,
    plan: readonly { kind: RouteKind; address: string; from: number; to: number | null }[],
  ): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      const stored = await trx
        .selectFrom("discovery_routes")
        .selectAll()
        .where("network", "=", network)
        .where("epoch", "=", epoch)
        .forUpdate()
        .execute();
      const planned = new Map(plan.map((route) => [`${route.kind}:${route.address}`, route]));
      for (const row of stored) {
        const route = planned.get(`${row.kind}:${row.address}`);
        const where = trx
          .deleteFrom("candidate_ledgers")
          .where("network", "=", network)
          .where("epoch", "=", epoch)
          .where("kind", "=", row.kind)
          .where("address", "=", row.address);
        if (route === undefined) {
          await trx
            .deleteFrom("discovery_routes")
            .where("network", "=", network)
            .where("epoch", "=", epoch)
            .where("kind", "=", row.kind)
            .where("address", "=", row.address)
            .execute();
          continue;
        }
        const from = Number(row.from_ledger);
        await where.where("ledger", "<", String(route.from)).execute();
        if (route.to !== null) await where.where("ledger", ">", String(route.to)).execute();
        const scanned = row.scanned_through === null ? null : Number(row.scanned_through);
        await trx
          .updateTable("discovery_routes")
          .set({
            from_ledger: route.from,
            to_ledger: route.to,
            // Walked from a later start: walk again from the new one (candidates are upserts). Walked past
            // a new end: the checkpoint is that end, so nothing after it counts as walked.
            scanned_through:
              route.from < from || scanned === null
                ? null
                : route.to !== null && scanned > route.to
                  ? route.to
                  : scanned,
            updated_at: sql<Date>`now()`,
          })
          .where("network", "=", network)
          .where("epoch", "=", epoch)
          .where("kind", "=", row.kind)
          .where("address", "=", row.address)
          .execute();
        planned.delete(`${row.kind}:${row.address}`);
      }
      for (const route of planned.values()) {
        await trx
          .insertInto("discovery_routes")
          .values({
            network,
            epoch,
            kind: route.kind,
            address: route.address,
            from_ledger: route.from,
            to_ledger: route.to,
            generation: null,
            decoder_version: null,
          })
          .execute();
      }
      return this.#prune(trx, network, epoch);
    });
  }

  async routes(network: string, epoch: string): Promise<StoredRoute[]> {
    const rows = await this.db
      .selectFrom("discovery_routes")
      .selectAll()
      .where("network", "=", network)
      .where("epoch", "=", epoch)
      .orderBy("kind")
      .orderBy("address")
      .execute();
    return rows.map(storedRoute);
  }

  /**
   * Stores one discovery page: its candidate ledgers (pending until read) and, when it vouches for one
   * past the stored checkpoint, the route's new checkpoint and read view, in one transaction. Candidates
   * are upserts, so a page read again (after a restart) adds nothing twice; the checkpoint only moves
   * forward.
   */
  async recordWindow(window: DiscoveryWindow): Promise<RecordedWindow> {
    return this.db.transaction().execute(async (trx) => {
      const route = await trx
        .selectFrom("discovery_routes")
        .select(["scanned_through", "from_ledger", "to_ledger"])
        .where("network", "=", window.network)
        .where("epoch", "=", window.epoch)
        .where("kind", "=", window.kind)
        .where("address", "=", window.address)
        .forUpdate()
        .executeTakeFirst();
      if (route === undefined) return { moved: false, added: 0 };
      const from = Number(route.from_ledger);
      const to = route.to_ledger === null ? Infinity : Number(route.to_ledger);
      const ledgers = [...new Set(window.ledgers)].filter((ledger) => ledger >= from && ledger <= to);
      let added = 0;
      for (const slice of chunks(ledgers, INSERT_CHUNK)) {
        await trx
          .insertInto("indexed_ledgers")
          .values(
            slice.map((ledger) => ({
              network: window.network,
              epoch: window.epoch,
              ledger,
              status: "pending" as const,
            })),
          )
          .onConflict((conflict) => conflict.columns(["network", "epoch", "ledger"]).doNothing())
          .execute();
        const inserted = await trx
          .insertInto("candidate_ledgers")
          .values(
            slice.map((ledger) => ({
              network: window.network,
              epoch: window.epoch,
              ledger,
              kind: window.kind,
              address: window.address,
            })),
          )
          .onConflict((conflict) => conflict.doNothing())
          .executeTakeFirst();
        added += Number(inserted.numInsertedOrUpdatedRows ?? 0);
      }
      const stored = route.scanned_through === null ? null : Number(route.scanned_through);
      const moved =
        window.scannedThrough !== null &&
        (stored === null || window.scannedThrough > stored) &&
        window.scannedThrough >= from - 1;
      await trx
        .updateTable("discovery_routes")
        .set({
          ...(moved ? { scanned_through: Math.min(window.scannedThrough, to) } : {}),
          generation: window.readView.generation,
          decoder_version: window.readView.decoderVersion,
          snapshot_ledger: window.readView.snapshotLedger,
          updated_at: sql<Date>`now()`,
        })
        .where("network", "=", window.network)
        .where("epoch", "=", window.epoch)
        .where("kind", "=", window.kind)
        .where("address", "=", window.address)
        .execute();
      return { moved, added };
    });
  }

  /**
   * Starts a route's discovery again from its first ledger under a new read view (the discovery source
   * rebuilt its index or changed its decoder, which may add or correct records for ranges already
   * walked). Its candidates stay: they are ledgers it listed, and the new walk adds any it missed.
   */
  async restartRoute(
    network: string,
    epoch: string,
    route: { readonly kind: RouteKind; readonly address: string },
    readView: DiscoveryReadView,
  ): Promise<void> {
    await this.db
      .updateTable("discovery_routes")
      .set({
        scanned_through: null,
        generation: readView.generation,
        decoder_version: readView.decoderVersion,
        snapshot_ledger: readView.snapshotLedger,
        updated_at: sql<Date>`now()`,
      })
      .where("network", "=", network)
      .where("epoch", "=", epoch)
      .where("kind", "=", route.kind)
      .where("address", "=", route.address)
      .execute();
  }

  /**
   * A candidate whose bytes or anchor are not available yet waits before it is tried again
   * (`baseSeconds`, doubling per attempt, at most an hour), so it never holds back newer candidates; the
   * report still stops before it.
   */
  async deferLedger(network: string, epoch: string, ledger: number, baseSeconds = 15): Promise<void> {
    await this.db
      .updateTable("indexed_ledgers")
      .set({
        attempts: sql<number>`attempts + 1`,
        retry_at: sql<Date>`now() + least(interval '1 hour', make_interval(secs => ${baseSeconds}::double precision * power(2, least(attempts, 8))))`,
        updated_at: sql<Date>`now()`,
      })
      .where("network", "=", network)
      .where("epoch", "=", epoch)
      .where("ledger", "=", String(ledger))
      .where("status", "=", "pending")
      .execute();
  }

  /** Candidate ledgers waiting to be read and not deferred, oldest first. */
  async pendingLedgers(network: string, epoch: string, limit: number): Promise<number[]> {
    const rows = await this.db
      .selectFrom("indexed_ledgers")
      .select("ledger")
      .where("network", "=", network)
      .where("epoch", "=", epoch)
      .where("status", "=", "pending")
      .where((eb) => eb.or([eb("retry_at", "is", null), eb("retry_at", "<=", sql<Date>`now()`)]))
      .orderBy("ledger")
      .limit(limit)
      .execute();
    return rows.map((row) => Number(row.ledger));
  }

  /** The newest candidate ledger, or null when there is none. */
  async newestCandidate(network: string, epoch: string): Promise<number | null> {
    const row = await this.db
      .selectFrom("indexed_ledgers")
      .select(sql<string | null>`max(ledger)`.as("ledger"))
      .where("network", "=", network)
      .where("epoch", "=", epoch)
      .executeTakeFirst();
    return row?.ledger === null || row?.ledger === undefined ? null : Number(row.ledger);
  }

  /** Counts of candidate ledgers by status. */
  async ledgerCounts(
    network: string,
    epoch: string,
  ): Promise<Record<"pending" | "indexed" | "failed", number>> {
    const rows = await this.db
      .selectFrom("indexed_ledgers")
      .select(["status", sql<string>`count(*)`.as("count")])
      .where("network", "=", network)
      .where("epoch", "=", epoch)
      .groupBy("status")
      .execute();
    const counts = { pending: 0, indexed: 0, failed: 0 };
    for (const row of rows) counts[row.status] = Number(row.count);
    return counts;
  }

  /**
   * Writes one verified, classified ledger: its rows, failed attempts, exclusion counts and anchor, and
   * marks it indexed, in one transaction. A ledger that is no longer pending (removed by a registry change,
   * or indexed by another worker) is left alone. Returns whether the ledger was written.
   */
  async commitLedger(entry: LedgerCommit): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const ledger = await trx
        .selectFrom("indexed_ledgers")
        .select("status")
        .where("network", "=", entry.network)
        .where("epoch", "=", entry.epoch)
        .where("ledger", "=", String(entry.ledger))
        .forUpdate()
        .executeTakeFirst();
      if (ledger?.status !== "pending") return false;
      await this.#upsert(trx, entry);
      if (entry.anchor !== undefined) {
        await trx
          .insertInto("anchors")
          .values({
            network: entry.network,
            epoch: entry.epoch,
            ledger: entry.anchor.ledger,
            hash: entry.anchor.hash,
            source: entry.anchor.source,
          })
          .onConflict((conflict) => conflict.columns(["network", "epoch", "ledger"]).doNothing())
          .execute();
      }
      await trx
        .updateTable("indexed_ledgers")
        .set({
          status: "indexed",
          hash: entry.hash,
          previous_hash: entry.previousHash,
          closed_at: entry.closedAt,
          source: entry.source,
          rows: entry.rows.length,
          attributed: entry.rows.filter((row) => row.attribution.tier !== "shaped").length,
          failed: entry.failed.length,
          attempts: 0,
          retry_at: null,
          rules_version: entry.versions.rules,
          registry_version: entry.versions.registry,
          classification_sha256: entry.versions.classification,
          error: null,
          updated_at: sql<Date>`now()`,
        })
        .where("network", "=", entry.network)
        .where("epoch", "=", entry.epoch)
        .where("ledger", "=", String(entry.ledger))
        .execute();
      return true;
    });
  }

  /** Marks a candidate ledger failed with its coded reason; the report stops before it. */
  async markFailed(network: string, epoch: string, ledger: number, error: string): Promise<void> {
    await this.db
      .updateTable("indexed_ledgers")
      .set({ status: "failed", error: error.slice(0, 1000), updated_at: sql<Date>`now()` })
      .where("network", "=", network)
      .where("epoch", "=", epoch)
      .where("ledger", "=", String(ledger))
      .where("status", "<>", "indexed")
      .execute();
  }

  /** Puts failed ledgers back in the queue (at start, so a restart retries them). Returns how many. */
  async retryFailed(network: string, epoch: string): Promise<number> {
    const result = await this.db
      .updateTable("indexed_ledgers")
      .set({ status: "pending", attempts: 0, retry_at: null, updated_at: sql<Date>`now()` })
      .where("network", "=", network)
      .where("epoch", "=", epoch)
      .where("status", "=", "failed")
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  async #upsert(trx: Transaction<ExplorerDatabase>, entry: LedgerCommit): Promise<void> {
    // One statement per chunk keeps every INSERT far below Postgres' 65,535 bind parameters.
    for (const values of chunks(entry.rows.map(settlementToRow), INSERT_CHUNK)) {
      await trx
        .insertInto("settlements")
        .values(values)
        .onConflict((conflict) =>
          conflict
            .columns(["network", "epoch", "tx_hash"])
            .doUpdateSet(
              Object.fromEntries(
                Object.keys(values[0] ?? {}).map((key) => [key, sql.raw(`EXCLUDED.${key}`)]),
              ),
            ),
        )
        .execute();
    }
    for (const failed of chunks(entry.failed, INSERT_CHUNK)) {
      await trx
        .insertInto("failed_attempts")
        .values(
          failed.map((row) => ({
            network: row.network,
            epoch: row.epoch,
            tx_hash: row.txHash,
            ledger: row.ledger,
            tx_index: row.txIndex,
            scheme: row.scheme,
            result_code: row.resultCode,
            fee_payer: row.feePayer,
            fee_charged: row.feeChargedStroops,
          })),
        )
        .onConflict((conflict) => conflict.columns(["network", "epoch", "tx_hash"]).doNothing())
        .execute();
    }
    await trx
      .deleteFrom("ledger_exclusions")
      .where("network", "=", entry.network)
      .where("epoch", "=", entry.epoch)
      .where("ledger", "=", String(entry.ledger))
      .execute();
    const exclusions = Object.entries(entry.excluded).filter(([, count]) => count > 0);
    if (exclusions.length > 0) {
      await trx
        .insertInto("ledger_exclusions")
        .values(
          exclusions.map(([reason, count]) => ({
            network: entry.network,
            epoch: entry.epoch,
            ledger: entry.ledger,
            reason,
            count,
          })),
        )
        .execute();
    }
    if (entry.rows.length === 0) return;
    const days = [...new Set(entry.rows.map((row) => row.closedAt.slice(0, 10)))];
    await lockTotals(trx, entry.network, entry.epoch);
    await refreshAggregates(trx, entry.network, entry.epoch, days);
    await refreshAccountTotals(trx, entry.network, entry.epoch, {
      payers: entry.rows.map((row) => row.payer),
      payees: entry.rows.map((row) => row.payTo),
    });
  }

  /**
   * Re-attributes every row produced under another registry version, in one transaction: tier,
   * facilitator, evidence and the shared-relayer flag are recomputed by `attributeSettlement` (the
   * classifier's own function) from the stored fee payer, sources, rule and upto contract; the registry
   * version is stamped on the rows and their ledgers, and the daily totals of the touched days are
   * recomputed. Returns the number of ledgers touched.
   */
  async reattribute(network: string, epoch: string, registry: RegistrySnapshot): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      const days = new Set<string>();
      let after = { ledger: 0, txIndex: -1 };
      for (;;) {
        const rows = await trx
          .selectFrom("settlements")
          .selectAll()
          .where("network", "=", network)
          .where("epoch", "=", epoch)
          .where("registry_version", "<>", registry.registryVersion)
          .where(sql<boolean>`(ledger, tx_index) > (${after.ledger}::bigint, ${after.txIndex}::integer)`)
          .orderBy("ledger")
          .orderBy("tx_index")
          .limit(1_000)
          .execute();
        for (const stored of rows) {
          const row = settlementFromRow(stored);
          const attribution = attributeSettlement(registry, row);
          await trx
            .updateTable("settlements")
            .set({
              tier: attribution.tier,
              facilitator_id: attribution.facilitatorId,
              evidence_url: attribution.evidenceUrl,
              shared_relayer: attribution.sharedRelayer,
              registry_version: registry.registryVersion,
            })
            .where("network", "=", network)
            .where("epoch", "=", epoch)
            .where("tx_hash", "=", stored.tx_hash)
            .execute();
          days.add(row.closedAt.slice(0, 10));
        }
        const last = rows.at(-1);
        if (rows.length < 1_000 || last === undefined) break;
        after = { ledger: Number(last.ledger), txIndex: last.tx_index };
      }
      // Attribution may move rows in or out of `shaped`: recount each ledger's attributed rows.
      const touched = await trx
        .updateTable("indexed_ledgers as l")
        .set({
          registry_version: registry.registryVersion,
          attributed: sql<number>`(SELECT count(*) FROM settlements s WHERE s.network = l.network
            AND s.epoch = l.epoch AND s.ledger = l.ledger AND s.tier <> 'shaped')`,
          updated_at: sql<Date>`now()`,
        })
        .where("l.network", "=", network)
        .where("l.epoch", "=", epoch)
        .where("l.status", "=", "indexed")
        .where("l.registry_version", "<>", registry.registryVersion)
        .executeTakeFirst();
      if (days.size > 0) {
        await lockTotals(trx, network, epoch);
        await refreshAggregates(trx, network, epoch, [...days]);
      }
      return Number(touched.numUpdatedRows);
    });
  }

  /**
   * Resets indexed ledgers whose rows were produced under other rules or another classification
   * fingerprint: their rows, failed attempts and exclusion counts are removed and they are read again.
   * Returns the number of ledgers reset.
   */
  async resetStale(network: string, epoch: string, versions: LedgerVersions): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      const stale = await trx
        .selectFrom("indexed_ledgers")
        .select("ledger")
        .where("network", "=", network)
        .where("epoch", "=", epoch)
        .where("status", "=", "indexed")
        .where((eb) =>
          eb.or([
            eb("rules_version", "is", null),
            eb("rules_version", "<>", versions.rules),
            eb("classification_sha256", "is", null),
            eb("classification_sha256", "<>", versions.classification),
          ]),
        )
        .execute();
      const ledgers = stale.map((row) => Number(row.ledger));
      if (ledgers.length === 0) return 0;
      await this.#removeRows(trx, network, epoch, ledgers);
      for (const slice of chunks(ledgers, INSERT_CHUNK)) {
        await trx
          .updateTable("indexed_ledgers")
          .set({
            status: "pending",
            hash: null,
            previous_hash: null,
            closed_at: null,
            source: null,
            rows: 0,
            attributed: 0,
            failed: 0,
            attempts: 0,
            retry_at: null,
            rules_version: null,
            registry_version: null,
            classification_sha256: null,
            error: null,
            updated_at: sql<Date>`now()`,
          })
          .where("network", "=", network)
          .where("epoch", "=", epoch)
          .where("ledger", "in", slice.map(String))
          .execute();
      }
      return ledgers.length;
    });
  }

  /** Removes ledgers no route lists any more, with their rows. Returns how many. */
  async #prune(trx: Transaction<ExplorerDatabase>, network: string, epoch: string): Promise<number> {
    const orphans = await trx
      .selectFrom("indexed_ledgers as l")
      .select("l.ledger")
      .where("l.network", "=", network)
      .where("l.epoch", "=", epoch)
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom("candidate_ledgers as c")
              .select("c.ledger")
              .whereRef("c.network", "=", "l.network")
              .whereRef("c.epoch", "=", "l.epoch")
              .whereRef("c.ledger", "=", "l.ledger"),
          ),
        ),
      )
      .execute();
    const ledgers = orphans.map((row) => Number(row.ledger));
    if (ledgers.length === 0) return 0;
    await this.#removeRows(trx, network, epoch, ledgers);
    for (const slice of chunks(ledgers, INSERT_CHUNK)) {
      await trx
        .deleteFrom("indexed_ledgers")
        .where("network", "=", network)
        .where("epoch", "=", epoch)
        .where("ledger", "in", slice.map(String))
        .execute();
      await trx
        .deleteFrom("anchors")
        .where("network", "=", network)
        .where("epoch", "=", epoch)
        .where("ledger", "in", slice.map(String))
        .execute();
    }
    return ledgers.length;
  }

  /** Removes the rows, failed attempts and exclusion counts of `ledgers`, and recomputes the totals they touched. */
  async #removeRows(
    trx: Transaction<ExplorerDatabase>,
    network: string,
    epoch: string,
    ledgers: readonly number[],
  ): Promise<void> {
    const days = new Set<string>();
    const payers = new Set<string>();
    const payees = new Set<string>();
    for (const slice of chunks(ledgers.map(String), INSERT_CHUNK)) {
      const touched = await trx
        .selectFrom("settlements")
        .select([
          "payer",
          "pay_to",
          sql<string>`to_char(closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')`.as("day"),
        ])
        .where("network", "=", network)
        .where("epoch", "=", epoch)
        .where("ledger", "in", slice)
        .execute();
      for (const row of touched) {
        days.add(row.day);
        payers.add(row.payer);
        payees.add(row.pay_to);
      }
      for (const table of ["settlements", "failed_attempts", "ledger_exclusions"] as const) {
        await trx
          .deleteFrom(table)
          .where("network", "=", network)
          .where("epoch", "=", epoch)
          .where("ledger", "in", slice)
          .execute();
      }
    }
    if (days.size === 0) return;
    await lockTotals(trx, network, epoch);
    await refreshAggregates(trx, network, epoch, [...days]);
    await refreshAccountTotals(trx, network, epoch, { payers: [...payers], payees: [...payees] });
  }
}

/**
 * Brings every indexed ledger of an epoch to the given rules and registry, deterministically: a ledger
 * whose rules version or classification fingerprint differs is reset and read again; rows that only
 * carry an older registry version are re-attributed in place by `attributeSettlement`, the function the
 * classifier uses, so the table equals a fresh index under the new registry. Failed ledgers go back to
 * the queue.
 */
export async function reconcileRegistry(
  store: ExplorerStore,
  network: IndexNetwork,
  epoch: string,
  registry: RegistrySnapshot,
  rules: string,
): Promise<Reconciled> {
  const versions: LedgerVersions = {
    rules,
    registry: registry.registryVersion,
    classification: classificationFingerprint(registry.document),
  };
  const reset = await store.resetStale(network, epoch, versions);
  const reattributed = await store.reattribute(network, epoch, registry);
  await store.retryFailed(network, epoch);
  return { reattributed, reset };
}

/**
 * Serialises the refresh of the totals tables between transactions on the same network and epoch.
 * Each refresh deletes and re-inserts the rows of the accounts and days it touched; two workers (or a
 * reset and a worker) refreshing a shared seller or day at the same time would otherwise both insert
 * the same key. The lock is held until the transaction ends, so the second refresh starts after the
 * first commit and recomputes from every committed row.
 */
async function lockTotals(trx: Transaction<ExplorerDatabase>, network: string, epoch: string) {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`rail402-explorer-totals:${network}:${epoch}`}, 0))`.execute(
    trx,
  );
}

/** Recomputes the per-asset totals of the given payers and sellers from the settlements table. */
async function refreshAccountTotals(
  trx: Transaction<ExplorerDatabase>,
  network: string,
  epoch: string,
  accounts: { readonly payers: readonly string[]; readonly payees: readonly string[] },
) {
  for (const [role, column, list] of [
    ["payer", "payer", accounts.payers],
    ["payTo", "pay_to", accounts.payees],
  ] as const) {
    const addresses = [...new Set(list)];
    if (addresses.length === 0) continue;
    for (const slice of chunks(addresses, INSERT_CHUNK)) {
      await sql`DELETE FROM account_totals WHERE network = ${network} AND epoch = ${epoch}
                  AND role = ${role} AND address = ANY(${slice}::text[])`.execute(trx);
      await sql`
        INSERT INTO account_totals (network, epoch, address, role, asset_contract, asset_code, asset_issuer,
                                    asset_verified, payments, volume, first_at, last_at)
        SELECT network, epoch, ${sql.ref(column)}, ${role}, asset_contract,
               max(asset_code) FILTER (WHERE asset_verified), max(asset_issuer) FILTER (WHERE asset_verified),
               bool_or(asset_verified), count(*), sum(amount), min(closed_at), max(closed_at)
          FROM settlements
         WHERE network = ${network} AND epoch = ${epoch} AND ${sql.ref(column)} = ANY(${slice}::text[])
         GROUP BY network, epoch, ${sql.ref(column)}, asset_contract`.execute(trx);
      if (role === "payTo") {
        await sql`DELETE FROM seller_summaries WHERE network = ${network} AND epoch = ${epoch}
                    AND pay_to = ANY(${slice}::text[])`.execute(trx);
        await sql`
          INSERT INTO seller_summaries (network, epoch, pay_to, exact, upto, payers)
          SELECT network, epoch, pay_to, count(*) FILTER (WHERE scheme = 'exact'),
                 count(*) FILTER (WHERE scheme = 'upto'), count(DISTINCT payer)
            FROM settlements
           WHERE network = ${network} AND epoch = ${epoch} AND pay_to = ANY(${slice}::text[])
           GROUP BY network, epoch, pay_to`.execute(trx);
      }
    }
  }
}

/** Recomputes the daily totals of `days` (YYYY-MM-DD, UTC) from the settlements table. */
async function refreshAggregates(
  trx: Transaction<ExplorerDatabase>,
  network: string,
  epoch: string,
  days: readonly string[],
) {
  await sql`DELETE FROM daily_aggregates WHERE network = ${network} AND epoch = ${epoch} AND day = ANY(${days}::date[])`.execute(
    trx,
  );
  await sql`
    INSERT INTO daily_aggregates
      (network, epoch, day, tier, facilitator_id, scheme, asset_contract, self_payment, payments, volume)
    SELECT network, epoch, (closed_at AT TIME ZONE 'UTC')::date, tier, coalesce(facilitator_id, ''), scheme,
           asset_contract, payer = pay_to, count(*), sum(amount)
      FROM settlements
     WHERE network = ${network} AND epoch = ${epoch} AND (closed_at AT TIME ZONE 'UTC')::date = ANY(${days}::date[])
     GROUP BY 1, 2, 3, 4, 5, 6, 7, 8`.execute(trx);
}
