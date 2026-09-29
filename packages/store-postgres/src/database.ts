import { Kysely, PostgresDialect, type ColumnType } from "kysely";
import pg from "pg";
import type { SettleResponse } from "@x402/core/types";
import type { SettlementState } from "@rail402.dev/facilitator";
import type { ListingContent } from "@rail402.dev/bazaar";

type Timestamp = ColumnType<Date, Date | string, Date | string>;

export interface SettlementsTable {
  id: string;
  network: string;
  payer: string;
  nonce: string;
  payload_hash: string;
  state: SettlementState;
  owner: string;
  claim_expires_at: Timestamp;
  channel: string | null;
  transaction_hash: string | null;
  inner_transaction_hash: string | null;
  envelope_xdr: string | null;
  // bigint columns come back from pg as strings.
  valid_until: ColumnType<string | null, number | null, number | null>;
  max_fee_stroops: ColumnType<string | null, string | null, string | null>;
  response: ColumnType<SettleResponse | null, string | null, string | null>;
  created_at: ColumnType<Date, Date | string | undefined, Date | string>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface ChannelsTable {
  network: string;
  address: string;
  leased_at: Timestamp | null;
  lease_expires_at: Timestamp | null;
  released_at: Timestamp | null;
}

type Json<T> = ColumnType<T, string, string>;

export interface ListingsTable {
  id: string;
  sequence: ColumnType<string, never, never>;
  network: string;
  kind: "http" | "mcp";
  resource: string;
  method: string;
  tool_name: string;
  scope: string;
  owner: string;
  trust: "settled" | "origin_verified" | "domain_verified";
  state: "pending" | "published" | "quarantined";
  version: number;
  content: Json<ListingContent>;
  content_hash: string;
  first_cataloged_at: Timestamp;
  listed_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  facts: ColumnType<unknown, string | null | undefined, string | null>;
  facts_checked_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  last_updated: Timestamp;
  last_settled_at: Timestamp;
  settlements: ColumnType<string, number, number>;
}

export interface ListingOptionsTable {
  listing_id: string;
  position: number;
  scheme: string;
  network: string;
  asset: string;
  pay_to: string;
  pay_to_account: string;
  amount: string;
}

export interface ListingVersionsTable {
  listing_id: string;
  version: number;
  created_at: Timestamp;
  cause: string;
  transaction: string | null;
  owner: string;
  trust: string;
  state: string;
  content: Json<ListingContent>;
}

export interface ListingObservationsTable {
  listing_id: string;
  transaction: string;
  payer: string;
  asset: string;
  amount: string;
  observed_at: Timestamp;
}

export interface OriginChecksTable {
  listing_id: string;
  reason: "created" | "changed" | "owner_conflict";
  url: string;
  proposed_owner: string | null;
  attempts: ColumnType<number, number | undefined, number>;
  due_at: ColumnType<Date, Date | string | undefined, Date | string>;
  claimed_until: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  request_id: ColumnType<string, string | undefined, string>;
}

export interface CatalogOutboxTable {
  transaction: string;
  payment: ColumnType<unknown, string, string>;
  attempts: ColumnType<number, number | undefined, number>;
  due_at: ColumnType<Date, Date | string, Date | string>;
  claimed_until: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

export interface RateLimitWindowsTable {
  key: string;
  window_start: Timestamp;
  count: number;
}

export interface UsageDailyTable {
  subject: string;
  day: ColumnType<string, string, string>;
  network: string;
  operation: "verify" | "settle";
  outcome: string;
  asset: string;
  requests: ColumnType<string, number, number>;
  settled_amount: ColumnType<string, string, string>;
}

/** One row: the catalog revision, bumped by every catalog change inside its transaction. */
export interface CatalogStateTable {
  singleton: boolean;
  /** bigint, read as a string. */
  revision: string;
}

export interface Database {
  rate_limit_windows: RateLimitWindowsTable;
  usage_daily: UsageDailyTable;
  settlements: SettlementsTable;
  channels: ChannelsTable;
  listings: ListingsTable;
  listing_options: ListingOptionsTable;
  listing_versions: ListingVersionsTable;
  listing_observations: ListingObservationsTable;
  origin_checks: OriginChecksTable;
  catalog_outbox: CatalogOutboxTable;
  catalog_state: CatalogStateTable;
}

export interface DatabaseOptions {
  readonly connectionString: string;
  /** Postgres schema holding Rail402's tables. Defaults to the connection's search_path. */
  readonly schema?: string;
  readonly maxConnections?: number;
  /**
   * Called when an idle pooled connection fails, e.g. when the server restarts or fails over. The pool
   * drops that connection and opens a new one on the next query; without a listener, Node would treat
   * the pool's 'error' event as fatal and stop the process.
   */
  readonly onIdleError?: (error: Error) => void;
}

export function createDatabase(options: DatabaseOptions): Kysely<Database> {
  if (options.schema !== undefined && !/^[a-z_][a-z0-9_]*$/.test(options.schema)) {
    throw new Error(`invalid schema name "${options.schema}"`);
  }
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    ...(options.schema === undefined ? {} : { options: `-c search_path=${options.schema}` }),
  });
  pool.on("error", (error) => {
    options.onIdleError?.(error);
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
