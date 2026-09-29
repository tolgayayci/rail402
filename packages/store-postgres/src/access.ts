import { sql, type Kysely } from "kysely";
import type { Database } from "./database.ts";

/**
 * Fixed-window rate limiting shared by every replica: one atomic upsert per request. A client may
 * burst up to twice the limit across a window boundary; the limit is per client key per minute.
 */
export class PostgresRateLimiter {
  private readonly db: Kysely<Database>;
  private readonly perMinute: number;

  constructor(db: Kysely<Database>, perMinute: number) {
    this.db = db;
    this.perMinute = perMinute;
  }

  get enabled(): boolean {
    return this.perMinute > 0;
  }

  /** Counts one request for `key`. Returns 0 when allowed, otherwise the seconds until the window resets. */
  async take(key: string): Promise<number> {
    if (!this.enabled) return 0;
    const result = await sql<{ count: number; reset: number }>`
      INSERT INTO rate_limit_windows (key, window_start, count)
      VALUES (${key}, date_trunc('minute', now()), 1)
      ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limit_windows.count + 1
      RETURNING count, ceil(extract(epoch FROM window_start + interval '1 minute' - now()))::int AS reset`.execute(
      this.db,
    );
    const row = result.rows[0];
    if (row === undefined || row.count <= this.perMinute) return 0;
    return Math.max(1, row.reset);
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
