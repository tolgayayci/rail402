import { sql, type Kysely } from "kysely";
import type { ChannelPool } from "@rail402.dev/facilitator";
import type { Database } from "./database.ts";

export interface ChannelPoolOptions {
  readonly network: string;
  readonly addresses: readonly string[];
  /**
   * A lease whose holder died before recording an envelope becomes free after this long. It must
   * exceed the settlement claim TTL. A channel referenced by a submitted settlement never expires.
   */
  readonly leaseTtlMs?: number;
  /** How often a waiting request retries while every channel is busy. */
  readonly retryIntervalMs?: number;
}

/**
 * Exclusive channel leases in Postgres (`FOR UPDATE SKIP LOCKED`), shared by every replica. The
 * least recently released channel is leased first, which spreads sequence usage evenly.
 */
export class PostgresChannelPool implements ChannelPool {
  readonly addresses: readonly string[];
  private readonly db: Kysely<Database>;
  private readonly network: string;
  private readonly leaseTtlMs: number;
  private readonly retryIntervalMs: number;

  private constructor(db: Kysely<Database>, options: ChannelPoolOptions) {
    this.db = db;
    this.network = options.network;
    this.addresses = [...options.addresses];
    this.leaseTtlMs = options.leaseTtlMs ?? 120_000;
    this.retryIntervalMs = options.retryIntervalMs ?? 100;
  }

  /** Registers the channels (idempotently) and returns a pool over them. */
  static async open(db: Kysely<Database>, options: ChannelPoolOptions): Promise<PostgresChannelPool> {
    if (options.addresses.length === 0) throw new Error("a channel pool needs at least one channel");
    if (new Set(options.addresses).size !== options.addresses.length)
      throw new Error("duplicate channel address");
    await db
      .insertInto("channels")
      .values(options.addresses.map((address) => ({ network: options.network, address })))
      .onConflict((conflict) => conflict.columns(["network", "address"]).doNothing())
      .execute();
    return new PostgresChannelPool(db, options);
  }

  async acquire(waitMs: number): Promise<string | undefined> {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const address = await this.tryAcquire();
      if (address !== undefined) return address;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return undefined;
      await new Promise((resolve) => setTimeout(resolve, Math.min(this.retryIntervalMs, remaining)));
    }
  }

  async release(address: string): Promise<void> {
    await this.db
      .updateTable("channels")
      .set({ leased_at: null, lease_expires_at: null, released_at: sql`now()` })
      .where("network", "=", this.network)
      .where("address", "=", address)
      .where("leased_at", "is not", null)
      .execute();
  }

  async inUse(): Promise<number> {
    const row = await this.db
      .selectFrom("channels")
      .select((eb) => eb.fn.countAll<string>().as("count"))
      .where("network", "=", this.network)
      .where("address", "in", this.addresses)
      .where("leased_at", "is not", null)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  private async tryAcquire(): Promise<string | undefined> {
    const result = await sql<{ address: string }>`
      WITH candidate AS (
        SELECT c.address
        FROM channels c
        WHERE c.network = ${this.network}
          AND c.address IN (${sql.join(this.addresses)})
          AND (
            c.leased_at IS NULL
            OR (
              c.lease_expires_at < now()
              AND NOT EXISTS (
                SELECT 1 FROM settlements s
                WHERE s.network = c.network AND s.channel = c.address AND s.state = 'submitted'
              )
            )
          )
        ORDER BY c.released_at NULLS FIRST
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE channels c
      SET leased_at = now(), lease_expires_at = now() + make_interval(secs => ${this.leaseTtlMs / 1000})
      FROM candidate
      WHERE c.network = ${this.network} AND c.address = candidate.address
      RETURNING c.address`.execute(this.db);
    return result.rows[0]?.address;
  }
}
