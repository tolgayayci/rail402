import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { X402Error } from "@rail402/errors";
import type {
  BackfillState,
  Confidence,
  CursorState,
  FacilitatorRow,
  PaymentRow,
  Scheme,
  SellerDirectoryRow,
  SellerMeta,
} from "./types.js";

/**
 * The explorer's system of record.
 *
 * Unlike the Bazaar catalog (memory-first, persistence-second), SQLite IS the store here: RPC
 * forgets after ~7 days and a testnet reset wipes Core, Horizon and RPC together, so these rows
 * are the only durable record of what settled (README: "DB must be system of record").
 *
 * Conventions carried over from apps/bazaar/src/catalog/persistence.ts:
 * - STRICT tables; amounts are TEXT decimal strings (i128-safe — SQLite INTEGER is only 64-bit).
 * - No composite keys through invisible separators; every key part is its own column.
 * - Synchronous driver, deliberately: rows arrive one ledger-poll at a time.
 * - The ExperimentalWarning `node:sqlite` prints is not suppressed.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS payments (
  network        TEXT NOT NULL,
  epoch          TEXT NOT NULL,
  ledger         INTEGER NOT NULL,
  tx_hash        TEXT NOT NULL,
  op_index       INTEGER NOT NULL DEFAULT 0,
  scheme         TEXT NOT NULL,
  buyer          TEXT NOT NULL,
  seller         TEXT NOT NULL,
  amount         TEXT NOT NULL,
  ceiling        TEXT,
  asset_contract TEXT NOT NULL,
  asset          TEXT,
  tx_source      TEXT NOT NULL,
  fee_source     TEXT,
  fee_charged    TEXT,
  facilitator_id TEXT,
  confidence     TEXT NOT NULL,
  sig_expiration_ledger INTEGER,
  memo           TEXT,
  muxed_id       TEXT,
  closed_at      TEXT NOT NULL,
  service_name   TEXT,
  resource       TEXT,
  raw_envelope   TEXT NOT NULL,
  ingested_at    TEXT NOT NULL,
  PRIMARY KEY (network, epoch, tx_hash, op_index)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_payments_feed    ON payments (network, closed_at, tx_hash);
CREATE INDEX IF NOT EXISTS idx_payments_seller  ON payments (seller);
CREATE INDEX IF NOT EXISTS idx_payments_buyer   ON payments (buyer);
CREATE INDEX IF NOT EXISTS idx_payments_facilitator ON payments (facilitator_id);
CREATE INDEX IF NOT EXISTS idx_payments_closed  ON payments (closed_at);

CREATE TABLE IF NOT EXISTS cursors (
  network     TEXT PRIMARY KEY,
  epoch       TEXT NOT NULL,
  cursor      TEXT,
  last_ledger INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS facilitators (
  id             TEXT PRIMARY KEY,
  base_url       TEXT NOT NULL UNIQUE,
  display_name   TEXT,
  verified       INTEGER NOT NULL DEFAULT 0,
  signers        TEXT NOT NULL DEFAULT '[]',
  upto_contracts TEXT NOT NULL DEFAULT '[]',
  networks       TEXT NOT NULL DEFAULT '[]',
  source         TEXT NOT NULL,
  last_seen_at   TEXT,
  last_error     TEXT,
  created_at     TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS sellers (
  network      TEXT NOT NULL,
  pay_to       TEXT NOT NULL,
  service_name TEXT,
  resource     TEXT,
  description  TEXT,
  registered   INTEGER NOT NULL DEFAULT 0,
  fetched_at   TEXT NOT NULL,
  PRIMARY KEY (network, pay_to)
) STRICT;

CREATE TABLE IF NOT EXISTS backfill (
  network       TEXT NOT NULL,
  epoch         TEXT NOT NULL,
  cursor        TEXT,
  target_ledger INTEGER NOT NULL,
  done          INTEGER NOT NULL DEFAULT 0,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (network, epoch)
) STRICT;

CREATE TABLE IF NOT EXISTS horizon_cursors (
  network    TEXT NOT NULL,
  account    TEXT NOT NULL,
  cursor     TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (network, account)
) STRICT;
`;

export interface FeedFilter {
  readonly network?: string;
  readonly scheme?: Scheme;
  readonly seller?: string;
  readonly buyer?: string;
  readonly facilitatorId?: string;
  readonly confidence?: Confidence;
  readonly limit?: number;
  /** Opaque keyset cursor from a previous page. */
  readonly cursor?: string;
}

export interface FeedPage {
  readonly items: readonly PaymentRow[];
  readonly nextCursor?: string;
}

export interface AssetTotal {
  readonly assetContract: string;
  readonly asset?: string;
  readonly count: number;
  /** BigInt sum as a decimal string — never summed in SQL, where i128 would overflow INTEGER. */
  readonly total: string;
}

export interface ExplorerStats {
  readonly totalPayments: number;
  readonly uniqueBuyers: number;
  readonly uniqueSellers: number;
  readonly byScheme: Readonly<Record<string, number>>;
  readonly byConfidence: Readonly<Record<string, number>>;
  readonly byAsset: readonly AssetTotal[];
  readonly lastPaymentAt?: string;
}

// ── Ecosystem analytics (the /ecosystem surface) ─────────────────────────────

export type EcosystemWindowKey = "24h" | "7d" | "30d";

export interface EcosystemWindow {
  readonly payments: number;
  readonly uniqueBuyers: number;
  readonly uniqueSellers: number;
  /** Buyers whose first-ever observed payment falls inside this window. */
  readonly newBuyers: number;
  /** Sellers first paid inside this window. */
  readonly newSellers: number;
  readonly volume: readonly AssetTotal[];
}

export interface FacilitatorShareRow {
  /** null = structurally x402 but unattributed (the x402-shaped tier). */
  readonly facilitatorId: string | null;
  /** All-time payment count. */
  readonly payments: number;
  /** Per-window payment counts, for a market-share-over-time widget. */
  readonly windows: Readonly<Record<EcosystemWindowKey, number>>;
  readonly lastPaymentAt?: string;
}

export interface TopSellerRow {
  readonly network: string;
  readonly payTo: string;
  readonly payments: number;
  readonly uniqueBuyers: number;
  readonly volume: readonly AssetTotal[];
  readonly lastPaymentAt: string;
  readonly serviceName?: string;
}

export interface EcosystemSnapshot {
  readonly totals: ExplorerStats;
  readonly windows: Readonly<Record<EcosystemWindowKey, EcosystemWindow>>;
  /** All-time share per facilitator (null id = unattributed), largest first. */
  readonly facilitators: readonly FacilitatorShareRow[];
  /** Most-active sellers over the trailing 30 days. */
  readonly topSellers: readonly TopSellerRow[];
}

export interface TimeseriesPoint {
  /** Bucket key: "2026-08-15" (day) or "2026-08-15T10" (hour), UTC. */
  readonly bucket: string;
  /** Bucket start as a full ISO instant, for chart axes. */
  readonly start: string;
  readonly payments: number;
  readonly uniqueBuyers: number;
  readonly uniqueSellers: number;
  readonly byScheme: Readonly<Record<string, number>>;
  readonly volume: readonly AssetTotal[];
}

const FEED_MAX_LIMIT = 100;

/** Per-asset BigInt fold used by every analytics query — SQL must never sum an i128 amount. */
type VolumeAcc = Map<string, { asset?: string; count: number; total: bigint }>;

function addVolume(
  acc: VolumeAcc,
  assetContract: string,
  asset: string | null | undefined,
  amount: string,
): void {
  const entry = acc.get(assetContract) ?? {
    ...(asset != null ? { asset } : {}),
    count: 0,
    total: 0n,
  };
  entry.count += 1;
  entry.total += BigInt(amount);
  acc.set(assetContract, entry);
}

function finalizeVolume(acc: VolumeAcc): AssetTotal[] {
  return [...acc.entries()]
    .map(([assetContract, v]) => ({
      assetContract,
      ...(v.asset !== undefined ? { asset: v.asset } : {}),
      count: v.count,
      total: v.total.toString(),
    }))
    .sort((a, b) => b.count - a.count);
}

/** ISO instant at second precision, matching the ledger `closed_at` format ("…T10:24:17Z") so
 * string comparisons are boundary-exact rather than off by the milliseconds suffix. */
function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

// The cursor carries op_index too: the PK is (network, epoch, tx_hash, op_index), so a tx whose
// rows straddle a page boundary must be resumable at the exact op, or the remaining ops are
// skipped forever (a multi-op transfer tx does exist on testnet — fixtures/getevents-raw.json).
function encodeCursor(closedAt: string, txHash: string, opIndex: number): string {
  return Buffer.from(JSON.stringify([closedAt, txHash, opIndex]), "utf8").toString("base64url");
}

function decodeCursor(raw: string): { closedAt: string; txHash: string; opIndex: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    parsed = undefined;
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 3 ||
    typeof parsed[0] !== "string" ||
    typeof parsed[1] !== "string" ||
    typeof parsed[2] !== "number"
  ) {
    throw new X402Error("explorer_invalid_query", {
      reason: "The feed cursor is malformed; request the first page again without a cursor.",
      details: { parameter: "cursor" },
    });
  }
  return { closedAt: parsed[0], txHash: parsed[1], opIndex: parsed[2] };
}

/* eslint-disable @typescript-eslint/no-explicit-any -- node:sqlite rows are untyped */
function rowToPayment(r: any): PaymentRow {
  return {
    network: r.network,
    epoch: r.epoch,
    ledger: Number(r.ledger),
    txHash: r.tx_hash,
    opIndex: Number(r.op_index),
    scheme: r.scheme,
    buyer: r.buyer,
    seller: r.seller,
    amount: r.amount,
    ...(r.ceiling != null ? { ceiling: r.ceiling } : {}),
    assetContract: r.asset_contract,
    ...(r.asset != null ? { asset: r.asset } : {}),
    txSource: r.tx_source,
    ...(r.fee_source != null ? { feeSource: r.fee_source } : {}),
    ...(r.fee_charged != null ? { feeCharged: r.fee_charged } : {}),
    ...(r.facilitator_id != null ? { facilitatorId: r.facilitator_id } : {}),
    confidence: r.confidence,
    ...(r.sig_expiration_ledger != null
      ? { sigExpirationLedger: Number(r.sig_expiration_ledger) }
      : {}),
    ...(r.memo != null ? { memo: r.memo } : {}),
    ...(r.muxed_id != null ? { muxedId: r.muxed_id } : {}),
    closedAt: r.closed_at,
    ...(r.service_name != null ? { serviceName: r.service_name } : {}),
    ...(r.resource != null ? { resource: r.resource } : {}),
    // The feed query omits raw_envelope (it is large and projectPayment discards it); only
    // /tx/:hash selects it. Default to "" so the shared mapper works for both.
    rawEnvelope: r.raw_envelope ?? "",
    ingestedAt: r.ingested_at,
  };
}

/** Columns the feed/entity endpoints need — everything except the multi-KB raw_envelope. */
const FEED_COLUMNS =
  "network, epoch, ledger, tx_hash, op_index, scheme, buyer, seller, amount, ceiling, " +
  "asset_contract, asset, tx_source, fee_source, fee_charged, facilitator_id, confidence, " +
  "sig_expiration_ledger, memo, muxed_id, closed_at, service_name, resource, ingested_at";

function rowToFacilitator(r: any): FacilitatorRow {
  return {
    id: r.id,
    baseUrl: r.base_url,
    ...(r.display_name != null ? { displayName: r.display_name } : {}),
    verified: r.verified === 1,
    signers: JSON.parse(r.signers),
    uptoContracts: JSON.parse(r.upto_contracts),
    networks: JSON.parse(r.networks),
    source: r.source,
    ...(r.last_seen_at != null ? { lastSeenAt: r.last_seen_at } : {}),
    ...(r.last_error != null ? { lastError: r.last_error } : {}),
    createdAt: r.created_at,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export class ExplorerStore {
  private readonly db: DatabaseSync;

  constructor(dbPath?: string) {
    if (dbPath && dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath ?? ":memory:");
    if (dbPath && dbPath !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL;");
    }
    this.migrate();
    this.db.exec(SCHEMA);
  }

  /**
   * Pre-schema migrations. The backfill table was originally keyed by `network` alone, which left
   * a stale row after a chain reset and opened a ledger gap (review M3). It only ever holds
   * resumable cursor state — safe to drop; dedupe makes the one re-walk free — so an old-shaped
   * table is dropped and recreated with the (network, epoch) key.
   */
  private migrate(): void {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const backfillCols: any[] = this.db.prepare("PRAGMA table_info(backfill)").all();
    if (backfillCols.length > 0 && !backfillCols.some(c => c.name === "epoch")) {
      this.db.exec("DROP TABLE backfill;");
    }
    // The sellers table gained a `registered` flag (Bazaar-catalog membership). Add it in place on
    // an existing DB — it holds enrichment/directory state only, so a plain ADD COLUMN is safe.
    const sellerCols: any[] = this.db.prepare("PRAGMA table_info(sellers)").all();
    if (sellerCols.length > 0 && !sellerCols.some(c => c.name === "registered")) {
      this.db.exec("ALTER TABLE sellers ADD COLUMN registered INTEGER NOT NULL DEFAULT 0;");
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }

  /** Insert a payment; returns false when the row already exists (dedup on the epoch-keyed PK). */
  insertPayment(p: PaymentRow): boolean {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO payments (
        network, epoch, ledger, tx_hash, op_index, scheme, buyer, seller, amount, ceiling,
        asset_contract, asset, tx_source, fee_source, fee_charged, facilitator_id, confidence,
        sig_expiration_ledger, memo, muxed_id, closed_at, service_name, resource, raw_envelope,
        ingested_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const result = stmt.run(
      p.network,
      p.epoch,
      p.ledger,
      p.txHash,
      p.opIndex,
      p.scheme,
      p.buyer,
      p.seller,
      p.amount,
      p.ceiling ?? null,
      p.assetContract,
      p.asset ?? null,
      p.txSource,
      p.feeSource ?? null,
      p.feeCharged ?? null,
      p.facilitatorId ?? null,
      p.confidence,
      p.sigExpirationLedger ?? null,
      p.memo ?? null,
      p.muxedId ?? null,
      p.closedAt,
      p.serviceName ?? null,
      p.resource ?? null,
      p.rawEnvelope,
      p.ingestedAt,
    );
    return result.changes > 0;
  }

  /** Look a payment up by hash, newest epoch first (hashes are unique per epoch, not across). */
  getPaymentByHash(txHash: string, network?: string): PaymentRow | undefined {
    const row = network
      ? this.db
          .prepare(
            "SELECT * FROM payments WHERE tx_hash = ? AND network = ? ORDER BY closed_at DESC, op_index ASC LIMIT 1",
          )
          .get(txHash, network)
      : this.db
          .prepare("SELECT * FROM payments WHERE tx_hash = ? ORDER BY closed_at DESC, op_index ASC LIMIT 1")
          .get(txHash);
    return row ? rowToPayment(row) : undefined;
  }

  /** All payments in one transaction — a tx can settle several ops (multi-payment). */
  getPaymentsByHash(txHash: string, network?: string): PaymentRow[] {
    const rows = network
      ? this.db
          .prepare(
            "SELECT * FROM payments WHERE tx_hash = ? AND network = ? ORDER BY op_index ASC",
          )
          .all(txHash, network)
      : this.db
          .prepare("SELECT * FROM payments WHERE tx_hash = ? ORDER BY op_index ASC")
          .all(txHash);
    return rows.map(rowToPayment);
  }

  /** Cheap row count for /health — never folds every amount the way stats() does. */
  countPayments(): number {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const r: any = this.db.prepare("SELECT COUNT(*) AS n FROM payments").get();
    return Number(r.n);
  }

  feed(filter: FeedFilter = {}): FeedPage {
    const limit = Math.min(Math.max(filter.limit ?? 25, 1), FEED_MAX_LIMIT);
    const where: string[] = [];
    const params: (string | number)[] = [];
    for (const [column, value] of [
      ["network", filter.network],
      ["scheme", filter.scheme],
      ["seller", filter.seller],
      ["buyer", filter.buyer],
      ["facilitator_id", filter.facilitatorId],
      ["confidence", filter.confidence],
    ] as const) {
      if (value !== undefined) {
        where.push(`${column} = ?`);
        params.push(value);
      }
    }
    if (filter.cursor !== undefined) {
      const { closedAt, txHash, opIndex } = decodeCursor(filter.cursor);
      // Three-way keyset over (closed_at DESC, tx_hash DESC, op_index DESC) so a tx's ops are
      // never skipped across a page boundary.
      where.push(
        "(closed_at < ? OR (closed_at = ? AND tx_hash < ?) OR (closed_at = ? AND tx_hash = ? AND op_index < ?))",
      );
      params.push(closedAt, closedAt, txHash, closedAt, txHash, opIndex);
    }
    const sql = `SELECT ${FEED_COLUMNS} FROM payments${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
      ORDER BY closed_at DESC, tx_hash DESC, op_index DESC LIMIT ?`;
    params.push(limit + 1);
    const rows = this.db.prepare(sql).all(...params);
    const items = rows.slice(0, limit).map(rowToPayment);
    const hasMore = rows.length > limit;
    const last = items[items.length - 1];
    return hasMore && last
      ? { items, nextCursor: encodeCursor(last.closedAt, last.txHash, last.opIndex) }
      : { items };
  }

  stats(filter: { network?: string; seller?: string; facilitatorId?: string } = {}): ExplorerStats {
    const clauses: string[] = [];
    const params: string[] = [];
    for (const [column, value] of [
      ["network", filter.network],
      ["seller", filter.seller],
      ["facilitator_id", filter.facilitatorId],
    ] as const) {
      if (value !== undefined) {
        clauses.push(`${column} = ?`);
        params.push(value);
      }
    }
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const head: any = this.db
      .prepare(
        `SELECT COUNT(*) AS n, COUNT(DISTINCT buyer) AS buyers, COUNT(DISTINCT seller) AS sellers,
                MAX(closed_at) AS last FROM payments${where}`,
      )
      .get(...params);
    const bySchemeRows: any[] = this.db
      .prepare(`SELECT scheme, COUNT(*) AS n FROM payments${where} GROUP BY scheme`)
      .all(...params);
    const byConfidenceRows: any[] = this.db
      .prepare(`SELECT confidence, COUNT(*) AS n FROM payments${where} GROUP BY confidence`)
      .all(...params);
    // Sums stay in BigInt on purpose: SQLite INTEGER is 64-bit and an i128 amount would overflow
    // silently in SQL. Row counts here are testnet-scale; revisit with materialized aggregates if
    // that ever changes.
    const amountRows: any[] = this.db
      .prepare(`SELECT asset_contract, asset, amount FROM payments${where}`)
      .all(...params);
    /* eslint-enable @typescript-eslint/no-explicit-any */
    const perAsset = new Map<string, { asset?: string; count: number; total: bigint }>();
    for (const r of amountRows) {
      const key = r.asset_contract as string;
      const entry = perAsset.get(key) ?? {
        ...(r.asset != null ? { asset: r.asset as string } : {}),
        count: 0,
        total: 0n,
      };
      entry.count += 1;
      entry.total += BigInt(r.amount as string);
      perAsset.set(key, entry);
    }
    return {
      totalPayments: Number(head.n),
      uniqueBuyers: Number(head.buyers),
      uniqueSellers: Number(head.sellers),
      byScheme: Object.fromEntries(bySchemeRows.map(r => [r.scheme, Number(r.n)])),
      byConfidence: Object.fromEntries(byConfidenceRows.map(r => [r.confidence, Number(r.n)])),
      byAsset: [...perAsset.entries()]
        .map(([assetContract, v]) => ({
          assetContract,
          ...(v.asset !== undefined ? { asset: v.asset } : {}),
          count: v.count,
          total: v.total.toString(),
        }))
        .sort((a, b) => b.count - a.count),
      ...(head.last != null ? { lastPaymentAt: head.last as string } : {}),
    };
  }

  /**
   * The /ecosystem snapshot: all-time totals plus trailing-window activity, facilitator share and
   * top sellers. ONE scan of the trailing 30 days feeds every window (24h ⊂ 7d ⊂ 30d), the
   * per-facilitator window counts and the top-seller fold; amounts fold in BigInt, never SQL
   * (i128 would overflow SQLite's 64-bit INTEGER). O(30d rows + distinct buyers/sellers) —
   * callers cache, like /stats.
   */
  ecosystem(filter: { network?: string } = {}, now: Date = new Date()): EcosystemSnapshot {
    const where = filter.network !== undefined ? " WHERE network = ?" : "";
    const params: string[] = filter.network !== undefined ? [filter.network] : [];
    const cutoffs: Record<EcosystemWindowKey, string> = {
      "24h": isoSeconds(new Date(now.getTime() - 24 * 3_600_000)),
      "7d": isoSeconds(new Date(now.getTime() - 7 * 24 * 3_600_000)),
      "30d": isoSeconds(new Date(now.getTime() - 30 * 24 * 3_600_000)),
    };
    const KEYS: readonly EcosystemWindowKey[] = ["24h", "7d", "30d"];

    /* eslint-disable @typescript-eslint/no-explicit-any */
    const scan: any[] = this.db
      .prepare(
        `SELECT network, closed_at, buyer, seller, facilitator_id, asset_contract, asset, amount
         FROM payments ${filter.network !== undefined ? "WHERE network = ? AND" : "WHERE"} closed_at >= ?`,
      )
      .all(...params, cutoffs["30d"]);
    const firstBuyer: any[] = this.db
      .prepare(`SELECT MIN(closed_at) AS f FROM payments${where} GROUP BY buyer`)
      .all(...params);
    const firstSeller: any[] = this.db
      .prepare(`SELECT MIN(closed_at) AS f FROM payments${where} GROUP BY seller`)
      .all(...params);
    const facAll: any[] = this.db
      .prepare(
        `SELECT facilitator_id, COUNT(*) AS n, MAX(closed_at) AS last
         FROM payments${where} GROUP BY facilitator_id ORDER BY n DESC`,
      )
      .all(...params);
    /* eslint-enable @typescript-eslint/no-explicit-any */

    interface WindowAcc {
      payments: number;
      buyers: Set<string>;
      sellers: Set<string>;
      volume: VolumeAcc;
    }
    const emptyWindow = (): WindowAcc => ({
      payments: 0,
      buyers: new Set(),
      sellers: new Set(),
      volume: new Map(),
    });
    const windowAcc: Record<EcosystemWindowKey, WindowAcc> = {
      "24h": emptyWindow(),
      "7d": emptyWindow(),
      "30d": emptyWindow(),
    };
    const facilitatorWindows = new Map<string | null, Record<EcosystemWindowKey, number>>();
    const sellerAcc = new Map<
      string,
      { network: string; payTo: string; payments: number; buyers: Set<string>; volume: VolumeAcc; last: string }
    >();

    for (const r of scan) {
      const fid = (r.facilitator_id ?? null) as string | null;
      for (const key of KEYS) {
        if ((r.closed_at as string) < cutoffs[key]) continue;
        const w = windowAcc[key];
        w.payments += 1;
        w.buyers.add(r.buyer as string);
        w.sellers.add(r.seller as string);
        addVolume(w.volume, r.asset_contract as string, r.asset as string | null, r.amount as string);
        let fw = facilitatorWindows.get(fid);
        if (!fw) {
          fw = { "24h": 0, "7d": 0, "30d": 0 };
          facilitatorWindows.set(fid, fw);
        }
        fw[key] += 1;
      }
      // Every scan row is inside 30d (the query bound), so the top-seller fold takes them all.
      const sKey = `${r.network as string} ${r.seller as string}`;
      let s = sellerAcc.get(sKey);
      if (!s) {
        s = {
          network: r.network as string,
          payTo: r.seller as string,
          payments: 0,
          buyers: new Set(),
          volume: new Map(),
          last: r.closed_at as string,
        };
        sellerAcc.set(sKey, s);
      }
      s.payments += 1;
      s.buyers.add(r.buyer as string);
      addVolume(s.volume, r.asset_contract as string, r.asset as string | null, r.amount as string);
      if ((r.closed_at as string) > s.last) s.last = r.closed_at as string;
    }

    const countNew = (rows: { f?: unknown }[], cutoff: string): number =>
      rows.filter(r => typeof r.f === "string" && r.f >= cutoff).length;

    const projectWindow = (key: EcosystemWindowKey): EcosystemWindow => ({
      payments: windowAcc[key].payments,
      uniqueBuyers: windowAcc[key].buyers.size,
      uniqueSellers: windowAcc[key].sellers.size,
      newBuyers: countNew(firstBuyer, cutoffs[key]),
      newSellers: countNew(firstSeller, cutoffs[key]),
      volume: finalizeVolume(windowAcc[key].volume),
    });
    const windows: Record<EcosystemWindowKey, EcosystemWindow> = {
      "24h": projectWindow("24h"),
      "7d": projectWindow("7d"),
      "30d": projectWindow("30d"),
    };

    const facilitators: FacilitatorShareRow[] = facAll.map(r => {
      const fid = (r.facilitator_id ?? null) as string | null;
      return {
        facilitatorId: fid,
        payments: Number(r.n),
        windows: facilitatorWindows.get(fid) ?? { "24h": 0, "7d": 0, "30d": 0 },
        ...(r.last != null ? { lastPaymentAt: r.last as string } : {}),
      };
    });

    const topSellers: TopSellerRow[] = [...sellerAcc.values()]
      .sort(
        (a, b) =>
          b.payments - a.payments || (a.payTo < b.payTo ? -1 : a.payTo > b.payTo ? 1 : 0),
      )
      .slice(0, 10)
      .map(s => {
        const meta = this.getSellerMeta(s.network, s.payTo);
        return {
          network: s.network,
          payTo: s.payTo,
          payments: s.payments,
          uniqueBuyers: s.buyers.size,
          volume: finalizeVolume(s.volume),
          lastPaymentAt: s.last,
          ...(meta?.serviceName !== undefined ? { serviceName: meta.serviceName } : {}),
        };
      });

    return { totals: this.stats(filter), windows, facilitators, topSellers };
  }

  /**
   * Bucketed activity series for charts. The scan is bounded by [from, to); buckets are
   * zero-filled so a chart axis is continuous. Bucket keys are UTC prefixes of `closed_at`
   * ("2026-08-15" / "2026-08-15T10"), which is exact because every stored instant is UTC ISO.
   */
  timeseries(opts: {
    network?: string;
    bucket: "day" | "hour";
    from: Date;
    to: Date;
  }): TimeseriesPoint[] {
    const keyLen = opts.bucket === "day" ? 10 : 13;
    const stepMs = opts.bucket === "day" ? 86_400_000 : 3_600_000;
    const fromIso = isoSeconds(opts.from);
    const toIso = isoSeconds(opts.to);
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const rows: any[] = this.db
      .prepare(
        `SELECT closed_at, scheme, buyer, seller, asset_contract, asset, amount FROM payments
         ${opts.network !== undefined ? "WHERE network = ? AND" : "WHERE"} closed_at >= ? AND closed_at < ?`,
      )
      .all(...(opts.network !== undefined ? [opts.network] : []), fromIso, toIso);
    /* eslint-enable @typescript-eslint/no-explicit-any */

    interface BucketAcc {
      payments: number;
      buyers: Set<string>;
      sellers: Set<string>;
      byScheme: Record<string, number>;
      volume: VolumeAcc;
    }
    const acc = new Map<string, BucketAcc>();
    for (const r of rows) {
      const key = (r.closed_at as string).slice(0, keyLen);
      let b = acc.get(key);
      if (!b) {
        b = { payments: 0, buyers: new Set(), sellers: new Set(), byScheme: {}, volume: new Map() };
        acc.set(key, b);
      }
      b.payments += 1;
      b.buyers.add(r.buyer as string);
      b.sellers.add(r.seller as string);
      b.byScheme[r.scheme as string] = (b.byScheme[r.scheme as string] ?? 0) + 1;
      addVolume(b.volume, r.asset_contract as string, r.asset as string | null, r.amount as string);
    }

    const points: TimeseriesPoint[] = [];
    const start = Math.floor(opts.from.getTime() / stepMs) * stepMs;
    // 2000-iteration backstop: the app layer bounds spans, this keeps a bad caller from spinning.
    for (let t = start, i = 0; t < opts.to.getTime() && i < 2_000; t += stepMs, i += 1) {
      const startIso = new Date(t).toISOString();
      const key = startIso.slice(0, keyLen);
      const b = acc.get(key);
      points.push({
        bucket: key,
        start: startIso,
        payments: b?.payments ?? 0,
        uniqueBuyers: b?.buyers.size ?? 0,
        uniqueSellers: b?.sellers.size ?? 0,
        byScheme: b?.byScheme ?? {},
        volume: b ? finalizeVolume(b.volume) : [],
      });
    }
    return points;
  }

  // ── Cursors ────────────────────────────────────────────────────────────────

  getCursor(network: string): CursorState | undefined {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const r: any = this.db.prepare("SELECT * FROM cursors WHERE network = ?").get(network);
    if (!r) return undefined;
    return {
      network: r.network,
      epoch: r.epoch,
      ...(r.cursor != null ? { cursor: r.cursor } : {}),
      lastLedger: Number(r.last_ledger),
      updatedAt: r.updated_at,
    };
  }

  setCursor(state: CursorState): void {
    this.db
      .prepare(
        `INSERT INTO cursors (network, epoch, cursor, last_ledger, updated_at)
         VALUES (?,?,?,?,?)
         ON CONFLICT(network) DO UPDATE SET
           epoch = excluded.epoch, cursor = excluded.cursor,
           last_ledger = excluded.last_ledger, updated_at = excluded.updated_at`,
      )
      .run(state.network, state.epoch, state.cursor ?? null, state.lastLedger, state.updatedAt);
  }

  // ── RPC deep-backfill state (Tier 1) ───────────────────────────────────────

  getBackfill(network: string, epoch: string): BackfillState | undefined {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const r: any = this.db
      .prepare("SELECT * FROM backfill WHERE network = ? AND epoch = ?")
      .get(network, epoch);
    if (!r) return undefined;
    return {
      network: r.network,
      epoch: r.epoch,
      ...(r.cursor != null ? { cursor: r.cursor } : {}),
      targetLedger: Number(r.target_ledger),
      done: r.done === 1,
      updatedAt: r.updated_at,
    };
  }

  setBackfill(state: BackfillState): void {
    this.db
      .prepare(
        `INSERT INTO backfill (network, epoch, cursor, target_ledger, done, updated_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(network, epoch) DO UPDATE SET
           cursor = excluded.cursor, target_ledger = excluded.target_ledger,
           done = excluded.done, updated_at = excluded.updated_at`,
      )
      .run(
        state.network,
        state.epoch,
        state.cursor ?? null,
        state.targetLedger,
        state.done ? 1 : 0,
        state.updatedAt,
      );
  }

  // ── Horizon per-account backfill cursors (Tier 2) ──────────────────────────

  getHorizonCursor(network: string, account: string): string | undefined {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const r: any = this.db
      .prepare("SELECT cursor FROM horizon_cursors WHERE network = ? AND account = ?")
      .get(network, account);
    return r?.cursor ?? undefined;
  }

  setHorizonCursor(network: string, account: string, cursor: string, updatedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO horizon_cursors (network, account, cursor, updated_at) VALUES (?,?,?,?)
         ON CONFLICT(network, account) DO UPDATE SET
           cursor = excluded.cursor, updated_at = excluded.updated_at`,
      )
      .run(network, account, cursor, updatedAt);
  }

  // ── Facilitator registry ───────────────────────────────────────────────────

  upsertFacilitator(row: FacilitatorRow): void {
    this.db
      .prepare(
        `INSERT INTO facilitators (
           id, base_url, display_name, verified, signers, upto_contracts, networks, source,
           last_seen_at, last_error, created_at
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           base_url = excluded.base_url, display_name = excluded.display_name,
           verified = excluded.verified, signers = excluded.signers,
           upto_contracts = excluded.upto_contracts, networks = excluded.networks,
           last_seen_at = excluded.last_seen_at, last_error = excluded.last_error`,
      )
      .run(
        row.id,
        row.baseUrl,
        row.displayName ?? null,
        row.verified ? 1 : 0,
        JSON.stringify(row.signers),
        JSON.stringify(row.uptoContracts),
        JSON.stringify(row.networks),
        row.source,
        row.lastSeenAt ?? null,
        row.lastError ?? null,
        row.createdAt,
      );
  }

  getFacilitator(id: string): FacilitatorRow | undefined {
    const r = this.db.prepare("SELECT * FROM facilitators WHERE id = ?").get(id);
    return r ? rowToFacilitator(r) : undefined;
  }

  getFacilitatorByUrl(baseUrl: string): FacilitatorRow | undefined {
    const r = this.db.prepare("SELECT * FROM facilitators WHERE base_url = ?").get(baseUrl);
    return r ? rowToFacilitator(r) : undefined;
  }

  listFacilitators(): FacilitatorRow[] {
    return this.db
      .prepare("SELECT * FROM facilitators ORDER BY created_at")
      .all()
      .map(rowToFacilitator);
  }

  /**
   * Retroactively attribute already-stored payments to a facilitator whose signers just became
   * known. Rows are classified at ingest time, so traffic ingested before a facilitator was
   * registered stays `x402-shaped` forever otherwise — this closes that gap (e.g. adding a
   * facilitator's API key attributes its whole observed history at once). Only touches
   * currently-unattributed rows whose tx source or fee source is one of the signers.
   */
  reattribute(facilitatorId: string, confidence: Confidence, signers: readonly string[]): number {
    if (signers.length === 0) return 0;
    const placeholders = signers.map(() => "?").join(",");
    const result = this.db
      .prepare(
        `UPDATE payments SET facilitator_id = ?, confidence = ?
         WHERE facilitator_id IS NULL
           AND (tx_source IN (${placeholders}) OR fee_source IN (${placeholders}))`,
      )
      .run(facilitatorId, confidence, ...signers, ...signers);
    return result.changes as number;
  }

  /**
   * signer address → facilitator id, for attribution. Verified facilitators only.
   *
   * FIRST-CLAIM-WINS (review C1): a signer already owned by another facilitator is NOT reassigned.
   * `/supported` bodies are self-reported, so without this an anonymous `/announce` could claim a
   * real facilitator's signer and hijack its attribution. Operator-configured `seed` facilitators
   * are processed before self-announced ones, so a seed can never be displaced by an announcement,
   * and among peers the earliest-registered wins. A collision is logged by the caller path, not
   * silently accepted as truth.
   */
  signerIndex(): Map<string, string> {
    const index = new Map<string, string>();
    const ordered = this.listFacilitators()
      .filter(f => f.verified)
      .sort((a, b) => {
        if (a.source !== b.source) return a.source === "seed" ? -1 : 1;
        return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
      });
    for (const f of ordered) {
      for (const signer of f.signers) {
        if (!index.has(signer)) index.set(signer, f.id);
      }
    }
    return index;
  }

  /** Every upto contract any verified facilitator advertises. */
  uptoContractIndex(): Set<string> {
    const set = new Set<string>();
    for (const f of this.listFacilitators()) {
      if (!f.verified) continue;
      for (const contract of f.uptoContracts) set.add(contract);
    }
    return set;
  }

  // ── Seller enrichment cache ────────────────────────────────────────────────

  getSellerMeta(network: string, payTo: string): SellerMeta | undefined {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const r: any = this.db
      .prepare("SELECT * FROM sellers WHERE network = ? AND pay_to = ?")
      .get(network, payTo);
    if (!r) return undefined;
    return {
      network: r.network,
      payTo: r.pay_to,
      ...(r.service_name != null ? { serviceName: r.service_name } : {}),
      ...(r.resource != null ? { resource: r.resource } : {}),
      ...(r.description != null ? { description: r.description } : {}),
      registered: r.registered === 1,
      fetchedAt: r.fetched_at,
    };
  }

  setSellerMeta(meta: SellerMeta): void {
    // Enrichment write: never touches `registered` (a Bazaar-catalog fact set elsewhere).
    this.db
      .prepare(
        `INSERT INTO sellers (network, pay_to, service_name, resource, description, fetched_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(network, pay_to) DO UPDATE SET
           service_name = excluded.service_name, resource = excluded.resource,
           description = excluded.description, fetched_at = excluded.fetched_at`,
      )
      .run(
        meta.network,
        meta.payTo,
        meta.serviceName ?? null,
        meta.resource ?? null,
        meta.description ?? null,
        meta.fetchedAt,
      );
  }

  /** Catalog-sync write: marks a seller as Bazaar-registered and refreshes its metadata. */
  markRegisteredSeller(meta: SellerMeta): void {
    this.db
      .prepare(
        `INSERT INTO sellers (network, pay_to, service_name, resource, description, registered, fetched_at)
         VALUES (?,?,?,?,?,1,?)
         ON CONFLICT(network, pay_to) DO UPDATE SET
           service_name = excluded.service_name, resource = excluded.resource,
           description = excluded.description, registered = 1, fetched_at = excluded.fetched_at`,
      )
      .run(
        meta.network,
        meta.payTo,
        meta.serviceName ?? null,
        meta.resource ?? null,
        meta.description ?? null,
        meta.fetchedAt,
      );
  }

  /**
   * The seller/API directory: on-chain sellers (with activity stats) UNION Bazaar-registered
   * sellers (guaranteed to appear even before their first settled payment). Ranked by activity,
   * then registration, then address. This is O(rows) like stats(); callers should cache it.
   */
  sellersDirectory(
    opts: { network?: string; registered?: boolean; limit?: number; offset?: number } = {},
  ): { items: SellerDirectoryRow[]; total: number } {
    const where = opts.network ? " WHERE network = ?" : "";
    const params = opts.network ? [opts.network] : [];
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const aggRows: any[] = this.db
      .prepare(
        `SELECT network, seller, COUNT(*) AS n, COUNT(DISTINCT buyer) AS buyers,
                MIN(closed_at) AS first_seen, MAX(closed_at) AS last_seen
         FROM payments${where} GROUP BY network, seller`,
      )
      .all(...params);
    const amountRows: any[] = this.db
      .prepare(`SELECT network, seller, asset_contract, asset, amount FROM payments${where}`)
      .all(...params);
    const metaRows: any[] = this.db.prepare(`SELECT * FROM sellers${where}`).all(...params);
    /* eslint-enable @typescript-eslint/no-explicit-any */

    const key = (network: string, payTo: string): string => `${network} ${payTo}`;
    const rows = new Map<
      string,
      { -readonly [K in keyof SellerDirectoryRow]: SellerDirectoryRow[K] } & {
        _volume: Map<string, { asset?: string; total: bigint }>;
      }
    >();
    const ensure = (network: string, payTo: string) => {
      const k = key(network, payTo);
      let row = rows.get(k);
      if (!row) {
        row = {
          network,
          payTo,
          registered: false,
          payments: 0,
          uniqueBuyers: 0,
          volume: [],
          _volume: new Map(),
        };
        rows.set(k, row);
      }
      return row;
    };

    for (const r of aggRows) {
      const row = ensure(r.network, r.seller);
      row.payments = Number(r.n);
      row.uniqueBuyers = Number(r.buyers);
      if (r.first_seen != null) (row as { firstSeenAt?: string }).firstSeenAt = r.first_seen;
      if (r.last_seen != null) (row as { lastSeenAt?: string }).lastSeenAt = r.last_seen;
    }
    for (const r of amountRows) {
      const row = ensure(r.network, r.seller);
      const entry = row._volume.get(r.asset_contract) ?? {
        ...(r.asset != null ? { asset: r.asset as string } : {}),
        total: 0n,
      };
      entry.total += BigInt(r.amount as string);
      row._volume.set(r.asset_contract, entry);
    }
    for (const r of metaRows) {
      // A registered-but-unpaid seller is created here; an already-seen one is annotated.
      const row = ensure(r.network, r.pay_to);
      if (r.registered === 1) row.registered = true;
      if (r.service_name != null) (row as { serviceName?: string }).serviceName = r.service_name;
      if (r.resource != null) (row as { resource?: string }).resource = r.resource;
      if (r.description != null) (row as { description?: string }).description = r.description;
    }

    let all = [...rows.values()].map(({ _volume, ...row }) => ({
      ...row,
      volume: [..._volume.entries()]
        .map(([assetContract, v]) => ({
          assetContract,
          ...(v.asset !== undefined ? { asset: v.asset } : {}),
          total: v.total.toString(),
        }))
        .sort((a, b) => (BigInt(a.total) < BigInt(b.total) ? 1 : -1)),
    }));
    if (opts.registered !== undefined) all = all.filter(r => r.registered === opts.registered);
    all.sort(
      (a, b) =>
        b.payments - a.payments ||
        Number(b.registered) - Number(a.registered) ||
        (a.payTo < b.payTo ? -1 : a.payTo > b.payTo ? 1 : 0),
    );
    const total = all.length;
    const offset = Math.max(opts.offset ?? 0, 0);
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
    return { items: all.slice(offset, offset + limit), total };
  }

  close(): void {
    this.db.close();
  }
}
