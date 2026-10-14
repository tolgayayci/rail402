import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue, type StatementSync } from "node:sqlite";
import { isStellarNetwork, type StellarNetwork } from "@rail402.dev/stellar";
import { isPaymentError, paymentError } from "../codes.ts";
export { defaultLedgerPath } from "../config.ts";
import type { ReleaseReason } from "../events.ts";
import {
  RELEASE_FROM,
  TRANSITIONS,
  UNFINISHED_STATES,
  checkReservation,
  idempotencyConflict,
  keyReusable,
  planWindow,
  usageOf,
  validateSpec,
  type BudgetWindow,
  type Reservation,
  type ReservationRequest,
  type ReservationState,
  type Settlement,
  type SignedProof,
  type SpendLedger,
  type WindowCaps,
  type WindowSpec,
  type WindowUsage,
} from "../policy/ledger.ts";
import type { SchemeName } from "../policy/policy.ts";

/**
 * A durable budget ledger in a SQLite file, shared safely by every process that pays with the same
 * key (a CLI run and an MCP server, say). Every check-and-reserve runs inside `BEGIN IMMEDIATE`, so
 * two processes can never both spend the last of a budget. The database holds amounts, recipients and
 * transaction hashes only: never keys, signatures, XDR, payment payloads or headers.
 */

/** How long a write waits for another process's lock before `payment_ledger_unavailable`. */
export const LEDGER_BUSY_TIMEOUT_MS = 5_000;

const SCHEMA_VERSION = 2;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS windows (
  id TEXT PRIMARY KEY,
  network TEXT NOT NULL,
  payer TEXT NOT NULL,
  name TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ended_at INTEGER,
  caps TEXT NOT NULL,
  auto_renew INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX IF NOT EXISTS windows_open ON windows(network, payer, name) WHERE ended_at IS NULL;
CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  window_id TEXT NOT NULL REFERENCES windows(id),
  call_id TEXT NOT NULL,
  scheme TEXT NOT NULL,
  asset TEXT NOT NULL,
  pay_to TEXT NOT NULL,
  resource TEXT NOT NULL,
  amount TEXT NOT NULL,
  settled_amount TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('reserved','signed','transmitted','unresolved','settled','released')),
  release_reason TEXT,
  nonce TEXT,
  expiration_ledger INTEGER,
  signed_at_ledger INTEGER,
  tx_hash TEXT,
  idempotency_key TEXT,
  result TEXT,
  awaiting_proof INTEGER NOT NULL DEFAULT 0,
  unprovable INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS reservations_idem ON reservations(window_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS reservations_open ON reservations(state, expiration_ledger);
CREATE INDEX IF NOT EXISTS reservations_window ON reservations(window_id);
CREATE INDEX IF NOT EXISTS reservations_tx ON reservations(tx_hash) WHERE tx_hash IS NOT NULL;
`;

type Row = Record<string, SQLOutputValue>;

export class SqliteSpendLedger implements SpendLedger {
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();

  /**
   * Opens (and creates) the ledger. The directory is created with mode 0700 and the file with 0600.
   * Failure is `payment_ledger_unavailable`; there is no fallback store.
   */
  constructor(path: string) {
    this.path = path;
    try {
      if (path !== ":memory:") prepareFile(path);
      this.db = new DatabaseSync(path, { timeout: LEDGER_BUSY_TIMEOUT_MS });
      this.db.exec(`PRAGMA busy_timeout = ${LEDGER_BUSY_TIMEOUT_MS}`);
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
      this.db.exec("PRAGMA foreign_keys = ON");
      this.migrate();
      if (path !== ":memory:") restrictSidecars(path);
    } catch (error) {
      throw unavailable(error);
    }
  }

  window(spec: WindowSpec, now = Date.now()): BudgetWindow {
    validateSpec(spec);
    return this.write(() => this.currentWindow(spec, now));
  }

  startWindow(spec: WindowSpec, now = Date.now()): BudgetWindow {
    validateSpec(spec);
    return this.write(() => {
      const open = this.openWindow(spec);
      if (open !== undefined) this.run("UPDATE windows SET ended_at = ? WHERE id = ?", now, open.id);
      return this.createWindow(spec, now);
    });
  }

  endWindow(windowId: string, now = Date.now()): boolean {
    return this.write(
      () =>
        this.run("UPDATE windows SET ended_at = ? WHERE id = ? AND ended_at IS NULL", now, windowId) === 1,
    );
  }

  listWindows(network: StellarNetwork, payer: string): BudgetWindow[] {
    return this.read(() =>
      this.all(
        "SELECT * FROM windows WHERE network = ? AND payer = ? ORDER BY started_at DESC",
        network,
        payer,
      ).map(toWindow),
    );
  }

  reserve(spec: WindowSpec, request: ReservationRequest, now = Date.now()): Reservation {
    validateSpec(spec);
    return this.write(() => {
      const window = this.currentWindow(spec, now);
      const key = request.idempotencyKey;
      if (key !== undefined) {
        const existing = this.findByIdempotencyKey(window.id, key);
        if (existing !== undefined) {
          if (!keyReusable(existing)) throw idempotencyConflict(existing);
          this.run("UPDATE reservations SET idempotency_key = NULL WHERE id = ?", existing.id);
        }
      }
      checkReservation(window, spec, request, this.usage(window.id));
      const id = crypto.randomUUID();
      this.run(
        `INSERT INTO reservations (id, window_id, call_id, scheme, asset, pay_to, resource, amount, state,
           idempotency_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)`,
        id,
        window.id,
        request.callId,
        request.scheme,
        request.asset,
        request.payTo,
        request.resource,
        request.amount.toString(),
        key ?? null,
        now,
        now,
      );
      const created = this.get(id);
      if (created === undefined) throw new Error("reservation vanished after insert");
      return created;
    });
  }

  markSigned(id: string, proof: SignedProof, now = Date.now()): boolean {
    return this.transition(
      id,
      TRANSITIONS.markSigned,
      "state = 'signed', nonce = ?, expiration_ledger = ?, signed_at_ledger = ?",
      [proof.nonce.toString(), proof.expirationLedger, proof.signedAtLedger],
      now,
    );
  }

  markTransmitted(id: string, now = Date.now()): boolean {
    return this.transition(id, TRANSITIONS.markTransmitted, "state = 'transmitted'", [], now);
  }

  markUnresolved(id: string, now = Date.now()): boolean {
    return this.transition(id, TRANSITIONS.markUnresolved, "state = 'unresolved'", [], now);
  }

  settle(id: string, settlement: Settlement, now = Date.now()): boolean {
    // A claim never replaces a settlement the chain confirmed.
    return this.transition(
      id,
      TRANSITIONS.settle,
      `state = 'settled', settled_amount = ?, verified = MAX(verified, ?), tx_hash = COALESCE(?, tx_hash),
       awaiting_proof = 0`,
      [settlement.settledAmount.toString(), settlement.verified ? 1 : 0, settlement.transaction],
      now,
      settlement.verified ? " AND unprovable = 0" : " AND unprovable = 0 AND verified = 0",
    );
  }

  markUnprovable(id: string, now = Date.now()): boolean {
    return this.transition(
      id,
      TRANSITIONS.markUnprovable,
      "state = 'settled', settled_amount = amount, unprovable = 1, awaiting_proof = 0",
      [],
      now,
      " AND verified = 0",
    );
  }

  release(id: string, reason: ReleaseReason, now = Date.now()): boolean {
    // A settlement confirmed on chain is final, even for a forced release.
    const guard = reason === "forced" ? " AND NOT (state = 'settled' AND verified = 1)" : "";
    return this.transition(
      id,
      RELEASE_FROM[reason],
      "state = 'released', release_reason = ?, awaiting_proof = 0",
      [reason],
      now,
      guard,
    );
  }

  setAwaitingProof(id: string, awaiting: boolean, now = Date.now()): boolean {
    return this.write(
      () =>
        this.run(
          "UPDATE reservations SET awaiting_proof = ?, updated_at = ? WHERE id = ?",
          awaiting ? 1 : 0,
          now,
          id,
        ) === 1,
    );
  }

  storeResult(id: string, result: string, now = Date.now()): boolean {
    return this.write(
      () =>
        this.run("UPDATE reservations SET result = ?, updated_at = ? WHERE id = ?", result, now, id) === 1,
    );
  }

  get(id: string): Reservation | undefined {
    const row = this.one("SELECT * FROM reservations WHERE id = ?", id);
    return row === undefined ? undefined : toReservation(row);
  }

  findByIdempotencyKey(windowId: string, key: string): Reservation | undefined {
    const row = this.one(
      "SELECT * FROM reservations WHERE window_id = ? AND idempotency_key = ?",
      windowId,
      key,
    );
    return row === undefined ? undefined : toReservation(row);
  }

  unfinished(network: StellarNetwork, payer: string): Reservation[] {
    const states = UNFINISHED_STATES.map(() => "?").join(", ");
    return this.read(() =>
      this.all(
        `SELECT r.* FROM reservations r JOIN windows w ON w.id = r.window_id
         WHERE w.network = ? AND w.payer = ?
           AND (r.state IN (${states}) OR (r.state = 'settled' AND r.verified = 0 AND r.unprovable = 0))
         ORDER BY r.created_at`,
        network,
        payer,
        ...UNFINISHED_STATES,
      ).map(toReservation),
    );
  }

  usage(windowId: string): WindowUsage {
    const states = UNFINISHED_STATES.map(() => "?").join(", ");
    const carried = this.all(
      `SELECT r.* FROM reservations r
         JOIN windows w ON w.id = r.window_id
         JOIN windows current ON current.id = ?
       WHERE r.window_id <> current.id
         AND w.network = current.network AND w.payer = current.payer AND w.name = current.name
         AND w.started_at <= current.started_at
         AND (r.state IN (${states}) OR (r.state = 'settled' AND r.verified = 0))`,
      windowId,
      ...UNFINISHED_STATES,
    );
    return usageOf(
      this.all("SELECT * FROM reservations WHERE window_id = ?", windowId).map(toReservation),
      carried.map(toReservation),
    );
  }

  close(): void {
    this.statements.clear();
    if (this.db.isOpen) this.db.close();
  }

  private migrate(): void {
    this.write(() => {
      const version = optionalInt(this.one("PRAGMA user_version") ?? {}, "user_version") ?? 0;
      if (version > SCHEMA_VERSION) {
        throw new Error(`the ledger was written by a newer version (schema ${version})`);
      }
      if (version === 1) {
        // Version 2 counts expired payments that can no longer be proven as spent.
        this.db.exec("ALTER TABLE reservations ADD COLUMN unprovable INTEGER NOT NULL DEFAULT 0");
      }
      this.db.exec(SCHEMA);
      if (version < SCHEMA_VERSION) this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }

  private currentWindow(spec: WindowSpec, now: number): BudgetWindow {
    const plan = planWindow(this.openWindow(spec), spec, now);
    if (plan.action === "use") return plan.window;
    if (plan.end !== undefined) this.run("UPDATE windows SET ended_at = ? WHERE id = ?", now, plan.end.id);
    return this.createWindow(spec, now);
  }

  private openWindow(spec: WindowSpec): BudgetWindow | undefined {
    const row = this.one(
      "SELECT * FROM windows WHERE network = ? AND payer = ? AND name = ? AND ended_at IS NULL",
      spec.network,
      spec.payer,
      spec.name,
    );
    return row === undefined ? undefined : toWindow(row);
  }

  private createWindow(spec: WindowSpec, now: number): BudgetWindow {
    const id = crypto.randomUUID();
    this.run(
      `INSERT INTO windows (id, network, payer, name, started_at, expires_at, caps, auto_renew)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      spec.network,
      spec.payer,
      spec.name,
      now,
      now + spec.ttlMs,
      encodeCaps(spec.caps),
      spec.autoRenew ? 1 : 0,
    );
    return {
      id,
      network: spec.network,
      payer: spec.payer,
      name: spec.name,
      startedAt: now,
      expiresAt: now + spec.ttlMs,
      endedAt: undefined,
      caps: spec.caps,
      autoRenew: spec.autoRenew,
    };
  }

  private transition(
    id: string,
    from: readonly ReservationState[],
    assignments: string,
    values: SQLInputValue[],
    now: number,
    extra = "",
    extraValues: SQLInputValue[] = [],
  ): boolean {
    const states = from.map(() => "?").join(", ");
    return this.write(
      () =>
        this.run(
          `UPDATE reservations SET ${assignments}, updated_at = ? WHERE id = ? AND state IN (${states})${extra}`,
          ...values,
          now,
          id,
          ...from,
          ...extraValues,
        ) === 1,
    );
  }

  /** Runs `body` inside `BEGIN IMMEDIATE`: the write lock is taken before anything is read. */
  private write<T>(body: () => T): T {
    try {
      this.db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      throw unavailable(error);
    }
    try {
      const result = body();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // The transaction may already be rolled back by SQLite.
      }
      if (isPaymentError(error)) throw error;
      throw unavailable(error);
    }
  }

  private read<T>(body: () => T): T {
    try {
      return body();
    } catch (error) {
      throw unavailable(error);
    }
  }

  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (statement === undefined) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  private run(sql: string, ...values: SQLInputValue[]): number {
    return Number(this.statement(sql).run(...values).changes);
  }

  private one(sql: string, ...values: SQLInputValue[]): Row | undefined {
    return this.statement(sql).get(...values);
  }

  private all(sql: string, ...values: SQLInputValue[]): Row[] {
    return this.statement(sql).all(...values);
  }
}

function prepareFile(path: string): void {
  const directory = dirname(path);
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  closeSync(openSync(path, "a", 0o600));
  if (process.platform !== "win32") chmodSync(path, 0o600);
}

function restrictSidecars(path: string): void {
  if (process.platform === "win32") return;
  for (const suffix of ["-wal", "-shm"]) {
    try {
      chmodSync(path + suffix, 0o600);
    } catch {
      // Created lazily by SQLite; absent is fine.
    }
  }
}

function unavailable(error: unknown) {
  if (isPaymentError(error)) return error;
  const busy = error instanceof Error && /locked|busy/i.test(error.message);
  return paymentError("payment_ledger_unavailable", {
    reason: busy
      ? "The budget ledger stayed locked by another process; retry shortly."
      : "The budget ledger could not be opened or written; payments are disabled until it is available.",
  });
}

function encodeCaps(caps: WindowCaps): string {
  const encoded: Record<string, { perCall: string; total: string; decimals: number }> = {};
  for (const [asset, cap] of Object.entries(caps)) {
    encoded[asset] = { perCall: cap.perCall.toString(), total: cap.total.toString(), decimals: cap.decimals };
  }
  return JSON.stringify(encoded);
}

function decodeCaps(text: string): WindowCaps {
  const parsed = JSON.parse(text) as Record<string, { perCall: string; total: string; decimals: number }>;
  const caps: Record<string, { perCall: bigint; total: bigint; decimals: number }> = {};
  for (const [asset, cap] of Object.entries(parsed)) {
    caps[asset] = { perCall: BigInt(cap.perCall), total: BigInt(cap.total), decimals: cap.decimals };
  }
  return caps;
}

function toWindow(row: Row): BudgetWindow {
  const network = text(row, "network");
  if (!isStellarNetwork(network)) throw new Error("ledger row has an unknown network");
  return {
    id: text(row, "id"),
    network,
    payer: text(row, "payer"),
    name: text(row, "name"),
    startedAt: int(row, "started_at"),
    expiresAt: int(row, "expires_at"),
    endedAt: optionalInt(row, "ended_at"),
    caps: decodeCaps(text(row, "caps")),
    autoRenew: int(row, "auto_renew") === 1,
  };
}

function toReservation(row: Row): Reservation {
  const optionalBigInt = (key: string) => {
    const value = optionalText(row, key);
    return value === undefined ? undefined : BigInt(value);
  };
  return {
    id: text(row, "id"),
    windowId: text(row, "window_id"),
    callId: text(row, "call_id"),
    scheme: text(row, "scheme") as SchemeName,
    asset: text(row, "asset"),
    payTo: text(row, "pay_to"),
    resource: text(row, "resource"),
    amount: BigInt(text(row, "amount")),
    settledAmount: optionalBigInt("settled_amount"),
    verified: int(row, "verified") === 1,
    state: text(row, "state") as ReservationState,
    releaseReason: optionalText(row, "release_reason") as ReleaseReason | undefined,
    nonce: optionalBigInt("nonce"),
    expirationLedger: optionalInt(row, "expiration_ledger"),
    signedAtLedger: optionalInt(row, "signed_at_ledger"),
    transaction: optionalText(row, "tx_hash"),
    idempotencyKey: optionalText(row, "idempotency_key"),
    result: optionalText(row, "result"),
    awaitingProof: int(row, "awaiting_proof") === 1,
    unprovable: int(row, "unprovable") === 1,
    createdAt: int(row, "created_at"),
    updatedAt: int(row, "updated_at"),
  };
}

function optionalText(row: Row, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return value.toString();
  throw new Error(`ledger column ${key} holds binary data`);
}

function text(row: Row, key: string): string {
  const value = optionalText(row, key);
  if (value === undefined) throw new Error(`ledger column ${key} is empty`);
  return value;
}

function optionalInt(row: Row, key: string): number | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new Error(`ledger column ${key} is not an integer`);
}

function int(row: Row, key: string): number {
  const value = optionalInt(row, key);
  if (value === undefined) throw new Error(`ledger column ${key} is empty`);
  return value;
}
