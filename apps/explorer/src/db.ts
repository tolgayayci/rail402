import { fileURLToPath } from "node:url";
import { Kysely, PostgresDialect, type ColumnType, type Generated } from "kysely";
import pg from "pg";

/** The Explorer's SQL migrations, applied with `migrate()` from @rail402.dev/store-postgres. */
export const EXPLORER_MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.url));

type Timestamp = ColumnType<Date, Date | string, Date | string>;
/** bigint and numeric columns come back from pg as strings. */
type BigintText = ColumnType<string, string | number | bigint, string | number | bigint>;

export interface SettlementsTable {
  network: string;
  epoch: string;
  tx_hash: string;
  inner_hash: string | null;
  ledger: BigintText;
  tx_index: number;
  closed_at: Timestamp;
  scheme: "exact" | "upto";
  rule_id: string;
  rules_version: string;
  registry_version: string;
  asset_contract: string;
  asset_code: string | null;
  asset_issuer: string | null;
  asset_verified: boolean;
  payer: string;
  payer_kind: "G" | "C";
  pay_to: string;
  pay_to_muxed_id: string | null;
  amount: BigintText;
  max_amount: ColumnType<string | null, string | null, string | null>;
  upto_contract: string | null;
  upto_authority: string | null;
  fee_bump: boolean;
  fee_payer: string;
  inner_source: string;
  op_source: string;
  fee_charged: BigintText;
  sponsored: boolean;
  tier: "rail402" | "rail402-beta" | "facilitator" | "shaped";
  facilitator_id: string | null;
  evidence_url: string | null;
  shared_relayer: boolean;
  checks: string[];
}

export interface FailedAttemptsTable {
  network: string;
  epoch: string;
  tx_hash: string;
  ledger: BigintText;
  tx_index: number;
  scheme: "exact" | "upto";
  result_code: string;
  fee_payer: string;
  fee_charged: BigintText;
}

export type RouteKind = "account" | "contract" | "approvals";

export interface DiscoveryRoutesTable {
  network: string;
  epoch: string;
  kind: RouteKind;
  address: string;
  from_ledger: BigintText;
  to_ledger: ColumnType<string | null, number | null, number | null>;
  scanned_through: ColumnType<string | null, number | null | undefined, number | null>;
  generation: string | null;
  decoder_version: string | null;
  snapshot_ledger: ColumnType<string | null, number | null | undefined, number | null>;
  updated_at: Generated<Date>;
}

export interface CandidateLedgersTable {
  network: string;
  epoch: string;
  ledger: BigintText;
  kind: RouteKind;
  address: string;
}

export type LedgerStatus = "pending" | "indexed" | "failed";

export interface IndexedLedgersTable {
  network: string;
  epoch: string;
  ledger: BigintText;
  status: LedgerStatus;
  hash: string | null;
  previous_hash: string | null;
  closed_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  source: "lake" | "rpc" | null;
  rows: ColumnType<string, number | undefined, number>;
  attributed: ColumnType<string, number | undefined, number>;
  failed: ColumnType<string, number | undefined, number>;
  attempts: ColumnType<number, number | undefined, number>;
  retry_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  rules_version: string | null;
  registry_version: string | null;
  classification_sha256: string | null;
  error: string | null;
  updated_at: Generated<Date>;
}

export interface LedgerExclusionsTable {
  network: string;
  epoch: string;
  ledger: BigintText;
  reason: string;
  count: BigintText;
}

export interface FacilitatorsTable {
  network: string;
  id: string;
  name: string;
  tier: "rail402" | "rail402-beta" | "facilitator";
  shared_relayer: boolean;
  registry_version: string;
}

export interface FacilitatorAccountsTable {
  network: string;
  facilitator_id: string;
  address: string;
  role: string;
  epoch: string;
  valid_from: BigintText;
  valid_to: ColumnType<string | null, number | null, number | null>;
  evidence_url: string;
  evidence_sha256: string;
}

export interface UptoContractsTable {
  network: string;
  contract: string;
  wasm_sha256: string;
  epoch: string;
  valid_from: BigintText;
  valid_to: ColumnType<string | null, number | null, number | null>;
  rule: string;
  facilitator_id: string | null;
}

export interface DailyAggregatesTable {
  network: string;
  epoch: string;
  day: ColumnType<string, string, string>;
  tier: string;
  /** Empty for unattributed rows. */
  facilitator_id: string;
  scheme: string;
  asset_contract: string;
  self_payment: boolean;
  payments: BigintText;
  volume: BigintText;
}

export interface AccountTotalsTable {
  network: string;
  epoch: string;
  address: string;
  role: "payer" | "payTo";
  asset_contract: string;
  asset_code: string | null;
  asset_issuer: string | null;
  asset_verified: boolean;
  payments: BigintText;
  volume: BigintText;
  first_at: Timestamp;
  last_at: Timestamp;
}

export interface SellerSummariesTable {
  network: string;
  epoch: string;
  pay_to: string;
  exact: BigintText;
  upto: BigintText;
  payers: BigintText;
}

export interface NetworkWindowsTable {
  network: string;
  epoch: string;
  generated_at: Timestamp;
  from_ledger: BigintText;
  to_ledger: BigintText;
  /** The window's document as JSON. */
  document: string;
  /** manifest.json exactly as the rebuild command writes it for the window. */
  manifest: string;
}

export interface ReportsTable {
  network: string;
  epoch: string;
  generated_at: Timestamp;
  /** The report document as JSON. */
  document: string;
  /** manifest.json exactly as a rebuild writes it. */
  manifest: string;
  aggregates: string;
}

export interface AnchorsTable {
  network: string;
  epoch: string;
  ledger: BigintText;
  hash: string;
  /** The anchor source's name, e.g. horizon:horizon.stellar.org. */
  source: string;
  checked_at: Generated<Date>;
}

export interface ExplorerDatabase {
  settlements: SettlementsTable;
  failed_attempts: FailedAttemptsTable;
  discovery_routes: DiscoveryRoutesTable;
  candidate_ledgers: CandidateLedgersTable;
  indexed_ledgers: IndexedLedgersTable;
  ledger_exclusions: LedgerExclusionsTable;
  facilitators: FacilitatorsTable;
  facilitator_accounts: FacilitatorAccountsTable;
  upto_contracts: UptoContractsTable;
  daily_aggregates: DailyAggregatesTable;
  account_totals: AccountTotalsTable;
  seller_summaries: SellerSummariesTable;
  reports: ReportsTable;
  network_windows: NetworkWindowsTable;
  anchors: AnchorsTable;
}

export interface ExplorerDatabaseOptions {
  readonly connectionString: string;
  readonly maxConnections?: number;
  /** Longest wait for a free connection; then the query fails (the web role answers 503). */
  readonly acquireTimeoutMs?: number;
  /**
   * Enforced per statement from the client side: the statement is sent with this `statement_timeout`,
   * and when it runs longer anyway (a session that changed its own timeout) the client cancels it on
   * the server with `pg_cancel_backend`. A role setting alone can be overridden with `SET`.
   */
  readonly statementTimeoutMs?: number;
  readonly onIdleError?: (error: Error) => void;
}

/** Cancels the running statement of backend `pid`, from a separate connection as the same role. */
async function cancelBackend(connectionString: string, pid: number): Promise<void> {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 5_000 });
  try {
    await client.connect();
    await client.query("SELECT pg_cancel_backend($1)", [pid]);
  } catch {
    // The statement may have finished meanwhile; nothing else to do.
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** A pool on the Explorer database. Which role it connects as decides what it may do. */
export function createExplorerDatabase(options: ExplorerDatabaseOptions): Kysely<ExplorerDatabase> {
  const timeout = options.statementTimeoutMs;
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 5,
    ...(options.acquireTimeoutMs === undefined ? {} : { connectionTimeoutMillis: options.acquireTimeoutMs }),
    ...(timeout === undefined ? {} : { statement_timeout: timeout }),
  });
  pool.on("error", (error) => {
    options.onIdleError?.(error);
  });
  if (timeout !== undefined) {
    pool.on("connect", (client) => {
      const query = client.query.bind(client) as (...args: unknown[]) => unknown;
      (client as { query: unknown }).query = (...args: unknown[]) => {
        const result = query(...args);
        if (!(result instanceof Promise)) return result;
        const pid = (client as unknown as { processID?: number }).processID;
        const timer =
          pid === undefined
            ? undefined
            : setTimeout(() => {
                void cancelBackend(options.connectionString, pid);
              }, timeout + 250);
        return result.finally(() => {
          clearTimeout(timer);
        });
      };
    });
  }
  return new Kysely<ExplorerDatabase>({ dialect: new PostgresDialect({ pool }) });
}
