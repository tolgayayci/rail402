import { sql, type Kysely } from "kysely";
import type { Database } from "./database.ts";

/** Entries of the over-limit memory before expired ones are dropped. */
const OVER_LIMIT_PRUNE_FLOOR = 1_024;

/**
 * Fixed-window rate limiting shared by every replica: one atomic upsert per request. A client may
 * burst up to twice the limit across a window boundary; the limit is per client key per minute.
 *
 * A key this process has seen over its limit is refused from memory until its window ends, without
 * another write: past the limit every request of the window is refused anyway. Requests already in
 * flight when the first refusal comes back still write. The window's end is taken from the database
 * as the time left when the statement started, counted from a monotonic clock read before it was sent,
 * so the memory never outlasts the window, however long the statement waited.
 */
export class PostgresRateLimiter {
  private readonly db: Kysely<Database>;
  private readonly perMinute: number;
  /** When the window of each key (and limit) this process saw over its limit ends, on `now`'s clock. */
  private readonly overLimit = new Map<string, number>();
  private pruneAt = OVER_LIMIT_PRUNE_FLOOR;
  /** A monotonic clock in milliseconds. */
  private readonly now: () => number;

  constructor(db: Kysely<Database>, perMinute: number, now: () => number = () => performance.now()) {
    this.db = db;
    this.perMinute = perMinute;
    this.now = now;
  }

  get enabled(): boolean {
    return this.perMinute > 0;
  }

  /** Counts one request for `key`. Returns 0 when allowed, otherwise the seconds until the window resets. */
  async take(key: string): Promise<number> {
    if (!this.enabled) return 0;
    return this.takeLimit(key, this.perMinute);
  }

  /** `take` with the limit given per call, for buckets whose limit depends on the caller. */
  async takeLimit(key: string, perMinute: number): Promise<number> {
    const id = `${key}\u0000${String(perMinute)}`;
    const windowEnd = this.overLimit.get(id);
    if (windowEnd !== undefined) {
      const left = windowEnd - this.now();
      if (left > 0) return Math.max(1, Math.ceil(left / 1_000));
      this.overLimit.delete(id);
    }
    // Read before the statement is sent: the database's now() is when the statement started, never
    // earlier, so this clock plus the time left then never passes the window's end.
    const sent = this.now();
    const result = await sql<{ count: number; left_ms: number }>`
      INSERT INTO rate_limit_windows (key, window_start, count)
      VALUES (${key}, date_trunc('minute', now()), 1)
      ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limit_windows.count + 1
      RETURNING count,
        (extract(epoch FROM window_start + interval '1 minute' - now()) * 1000)::float8 AS left_ms`.execute(
      this.db,
    );
    const row = result.rows[0];
    if (row === undefined || row.count <= perMinute) return 0;
    const left = Math.max(0, row.left_ms);
    this.rememberOverLimit(id, sent + left);
    return Math.max(1, Math.ceil(left / 1_000));
  }

  private rememberOverLimit(id: string, windowEnd: number): void {
    this.overLimit.set(id, windowEnd);
    if (this.overLimit.size < this.pruneAt) return;
    const now = this.now();
    for (const [entry, end] of this.overLimit) if (end <= now) this.overLimit.delete(entry);
    this.pruneAt = Math.max(OVER_LIMIT_PRUNE_FLOOR, this.overLimit.size * 2);
  }

  /** Drops windows that can no longer affect a decision. */
  async sweep(): Promise<void> {
    await this.db
      .deleteFrom("rate_limit_windows")
      .where("window_start", "<", sql<Date>`now() - interval '2 minutes'`)
      .execute();
  }
}

export interface UsageEvent {
  readonly subject: string;
  readonly network: string;
  readonly operation: "verify" | "settle";
  readonly outcome: string;
  readonly asset: string;
  /** Base units moved by a successful settlement; "0" otherwise. */
  readonly settledAmount: string;
}

export interface UsageRow {
  readonly day: string;
  readonly network: string;
  readonly operation: string;
  readonly outcome: string;
  readonly asset: string;
  readonly requests: number;
  readonly settledAmount: string;
}

/** Daily usage counters per caller, the basis of metering and any per-settlement service fee. */
export class PostgresUsageMeter {
  private readonly db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.db = db;
  }

  async record(event: UsageEvent): Promise<void> {
    await this.db
      .insertInto("usage_daily")
      .values({
        subject: event.subject,
        day: sql<string>`current_date`,
        network: event.network,
        operation: event.operation,
        outcome: event.outcome,
        asset: event.asset,
        requests: 1,
        settled_amount: event.settledAmount,
      })
      .onConflict((conflict) =>
        conflict
          .columns(["subject", "day", "network", "operation", "outcome", "asset"])
          .doUpdateSet((eb) => ({
            requests: eb("usage_daily.requests", "+", 1),
            settled_amount: sql<string>`usage_daily.settled_amount + excluded.settled_amount`,
          })),
      )
      .execute();
  }

  /**
   * Successful settlements per subject, day, network and asset with the volume they moved, for the
   * days from `from` to `to` (inclusive, `YYYY-MM-DD`), of `subject` when given.
   */
  async settledBetween(
    from: string,
    to: string,
    subject?: string,
  ): Promise<(UsageRow & { readonly subject: string })[]> {
    let query = this.db
      .selectFrom("usage_daily")
      .select(sql<string>`to_char(day, 'YYYY-MM-DD')`.as("day"))
      .select(["subject", "network", "operation", "outcome", "asset", "requests", "settled_amount"])
      .where("operation", "=", "settle")
      .where("outcome", "=", "success")
      .where("day", ">=", sql<string>`${from}::date`)
      .where("day", "<=", sql<string>`${to}::date`);
    if (subject !== undefined) query = query.where("subject", "=", subject);
    const rows = await query.orderBy("day").orderBy("subject").orderBy("network").execute();
    return rows.map((row) => ({
      subject: row.subject,
      day: row.day,
      network: row.network,
      operation: row.operation,
      outcome: row.outcome,
      asset: row.asset,
      requests: Number(row.requests),
      settledAmount: row.settled_amount,
    }));
  }

  async usage(subject: string, days: number): Promise<UsageRow[]> {
    const rows = await this.db
      .selectFrom("usage_daily")
      // node-postgres turns `date` into a local-time Date; format it in SQL to keep the calendar day.
      .select(sql<string>`to_char(day, 'YYYY-MM-DD')`.as("day"))
      .select(["network", "operation", "outcome", "asset", "requests", "settled_amount"])
      .where("subject", "=", subject)
      .where("day", ">=", sql<string>`current_date - ${days}::int`)
      .orderBy("day", "desc")
      .orderBy("network")
      .orderBy("operation")
      .orderBy("outcome")
      .execute();
    return rows.map((row) => ({
      day: row.day,
      network: row.network,
      operation: row.operation,
      outcome: row.outcome,
      asset: row.asset,
      requests: Number(row.requests),
      settledAmount: row.settled_amount,
    }));
  }
}
