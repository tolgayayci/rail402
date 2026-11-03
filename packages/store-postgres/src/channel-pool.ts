import { sql, type Kysely } from "kysely";
import { MAX_QUARANTINE_FACTOR, type ChannelPool } from "@rail402.dev/facilitator";
import type { Database } from "./database.ts";

export interface ChannelPoolOptions {
  readonly network: string;
  readonly addresses: readonly string[];
  /**
   * A lease whose holder died before recording an envelope becomes free after this long. It must
   * exceed the settlement claim TTL. A channel referenced by a submitted settlement is never leased,
   * whether its lease expired or was released, unless the settlement gave it back because its bytes
   * can never apply (`SettlementLedger.releaseChannel`).
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
      .set({
        leased_at: null,
        lease_expires_at: null,
        released_at: sql`now()`,
        quarantined_until: null,
        conflict_streak: 0,
        quarantine_sequence: null,
      })
      .where("network", "=", this.network)
      .where("address", "=", address)
      .where("leased_at", "is not", null)
      .execute();
  }

  async quarantine(address: string, cooldownMs: number, sequence?: string): Promise<void> {
    // `conflict_streak` on the right-hand side is the value before this update: the first quarantine
    // in a row lasts the cooldown, each further one twice the previous, up to the maximum factor.
    const maxDoublings = Math.log2(MAX_QUARANTINE_FACTOR);
    await sql`
      UPDATE channels
      SET leased_at = NULL,
          lease_expires_at = NULL,
          released_at = now(),
          conflict_streak = conflict_streak + 1,
          quarantine_sequence = ${sequence ?? null}::text,
          quarantined_until = now() + make_interval(
            secs => ${cooldownMs / 1000}::double precision
              * power(2::double precision, least(conflict_streak, ${maxDoublings}::integer))
          )
      WHERE network = ${this.network} AND address = ${address} AND leased_at IS NOT NULL`.execute(this.db);
  }

  async takeQuarantineSequence(address: string): Promise<string | undefined> {
    const result = await sql<{ sequence: string | null }>`
      WITH previous AS (
        SELECT quarantine_sequence FROM channels
        WHERE network = ${this.network} AND address = ${address}
        FOR UPDATE
      )
      UPDATE channels c SET quarantine_sequence = NULL
      FROM previous
      WHERE c.network = ${this.network} AND c.address = ${address}
      RETURNING previous.quarantine_sequence AS sequence`.execute(this.db);
    return result.rows[0]?.sequence ?? undefined;
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
          AND (c.leased_at IS NULL OR c.lease_expires_at < now())
          AND (c.quarantined_until IS NULL OR c.quarantined_until <= now())
          -- A channel whose recorded settlement is still open is never leased again, free or
          -- expired: its bytes may yet apply, and a second settlement would share its sequence. One
          -- that gave its channel back can never apply (another transaction took its sequence number,
          -- or its own transaction was included and failed, which used it).
          AND NOT EXISTS (
            SELECT 1 FROM settlements s
            WHERE s.network = c.network AND s.channel = c.address AND s.state = 'submitted'
              AND NOT s.channel_released
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
