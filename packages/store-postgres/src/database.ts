import { Kysely, PostgresDialect, type ColumnType } from "kysely";
import pg from "pg";
import type { SettleResponse } from "@x402/core/types";
import type { SettledBy, SettlementState } from "@rail402.dev/facilitator";
import type { CheckCandidate, ListingContent, SettledOption, ToolCallProposal } from "@rail402.dev/bazaar";

type Timestamp = ColumnType<Date, Date | string, Date | string>;

export interface SettlementsTable {
  id: string;
  network: string;
  payer: string;
  nonce: string;
  payload_hash: string;
  scheme: ColumnType<string, string | undefined, string>;
  amount: ColumnType<string | null, string | null | undefined, string | null>;
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
  request_hash: ColumnType<string | null, string | null | undefined, string | null>;
  fee_charged_stroops: ColumnType<string | null, string | null | undefined, string | null>;
  settled_by: ColumnType<SettledBy | null, SettledBy | null | undefined, SettledBy | null>;
  caller: ColumnType<string, string | undefined, string>;
  service_fee_usd: ColumnType<string, string | undefined, string>;
  reserved_fee_stroops: ColumnType<string | null, string | null | undefined, string | null>;
  broadcast_accepted: ColumnType<boolean | null, boolean | null | undefined, boolean | null>;
  sends_in_flight: ColumnType<string[], string[] | undefined, string[]>;
  settle_attempt: ColumnType<string | null, string | null | undefined, string | null>;
  channel_released: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: ColumnType<Date, Date | string | undefined, Date | string>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface ChannelsTable {
  network: string;
  address: string;
  leased_at: Timestamp | null;
  lease_expires_at: Timestamp | null;
  released_at: Timestamp | null;
  quarantined_until: Timestamp | null;
  conflict_streak: ColumnType<number, number | undefined, number>;
  quarantine_sequence: string | null;
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
  quota_charged_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  confirmed_example: ColumnType<string | null, string | null | undefined, string | null>;
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
  reason: ColumnType<string | null, string | null | undefined, string | null>;
  content: Json<ListingContent>;
}

export interface ListingObservationsTable {
  listing_id: string;
  transaction: string;
  payer: string;
  /**
   * The base account the settlement paid. Null only for a row an earlier release wrote whose payee
   * could not be inferred; such a row never counts as usage.
   */
  pay_to: string | null;
  asset: string;
  amount: string;
  observed_at: Timestamp;
}

export interface OriginChecksTable {
  listing_id: string;
  network: string;
  reason: "created" | "changed" | "owner_conflict";
  url: string;
  proposed_owners: ColumnType<string[], string[] | undefined, string[]>;
  settled_option: ColumnType<SettledOption | null, string | null | undefined, string | null>;
  probe: ColumnType<ToolCallProposal | null, string | null | undefined, string | null>;
  candidates: ColumnType<CheckCandidate[], string | undefined, string>;
  attempts: ColumnType<number, number | undefined, number>;
  due_at: ColumnType<Date, Date | string | undefined, Date | string>;
  claimed_until: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  retry_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
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

export interface SponsorSpendTable {
  id: ColumnType<string, never, never>;
  network: string;
  kind: string;
  fee_stroops: ColumnType<string, string, string>;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

export interface Database {
  sponsor_spend: SponsorSpendTable;
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
   * How long a query waits for a free pooled connection before it fails, in milliseconds; unset waits
   * indefinitely. With a bound, an exhausted pool fails fast (callers refuse with a code) instead of
   * queueing requests without end.
   */
  readonly acquireTimeoutMs?: number;
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
    ...(options.acquireTimeoutMs === undefined ? {} : { connectionTimeoutMillis: options.acquireTimeoutMs }),
    ...(options.schema === undefined ? {} : { options: `-c search_path=${options.schema}` }),
  });
  pool.on("error", (error) => {
    options.onIdleError?.(error);
  });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

export interface DatabaseProbeOptions {
  readonly connectionString: string;
  /**
   * How long a check waits to connect, and then for the answer, in milliseconds. A check that runs out
   * of time fails, and its connection is dropped, so a connection that stopped answering (a stalled
   * network path, a server that hangs) never answers the next check either.
   */
  readonly timeoutMs: number;
  /** Called when the probe's idle connection fails; the next check opens a new one. */
  readonly onIdleError?: (error: Error) => void;
}

/**
 * Asks whether the database answers a query, through one connection of its own: it never waits for a
 * connection another pool's load holds, and never reports an answer it did not get in time.
 */
export class DatabaseProbe {
  private readonly pool: pg.Pool;

  constructor(options: DatabaseProbeOptions) {
    this.pool = new pg.Pool({
      connectionString: options.connectionString,
      max: 1,
      connectionTimeoutMillis: options.timeoutMs,
      query_timeout: options.timeoutMs,
    });
    this.pool.on("error", (error) => {
      options.onIdleError?.(error);
    });
  }

  /** Resolves once `SELECT 1` answers in time; rejects otherwise. */
  async check(): Promise<void> {
    const client = await this.pool.connect();
    // A connection that fails while checked out rejects the query below; nothing else may see it.
    const ignore = () => undefined;
    client.on("error", ignore);
    try {
      await client.query("SELECT 1");
    } catch (error) {
      // Dropped, not returned: a later check opens a new connection.
      client.release(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
    client.removeListener("error", ignore);
    client.release();
  }

  /** Closes the probe's connection. */
  async close(): Promise<void> {
    await this.pool.end();
  }
}
