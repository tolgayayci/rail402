import { randomUUID } from "node:crypto";
import { sql, type Kysely, type Selectable } from "kysely";
import type { SettleResponse } from "@x402/core/types";
import {
  ClaimLostError,
  ClaimRefusedError,
  DEFAULT_SCHEME,
  FIRST_SEND,
  PUBLIC_CALLER,
  SpendRefusedError,
  addUsd,
  type CallerUsage,
  emptyStateCounts,
  sameRequest,
  type Claim,
  type ClaimDetails,
  type FinalState,
  type Finished,
  type FinishDetails,
  type RequestFingerprint,
  type SettlementEnvelope,
  type SettlementKey,
  type SettlementLedger,
  type SettlementRecord,
  type SettlementState,
  type SpendLimit,
  type UnfinishedOptions,
} from "@rail402.dev/facilitator";
import type { Database, SettlementsTable } from "./database.ts";

/**
 * Settlement ledger in Postgres. Safe across any number of facilitator replicas: the unique key
 * (network, payer, nonce) serialises claims, and claim expiry is judged by the database clock.
 */
export class PostgresSettlementLedger implements SettlementLedger {
  private readonly db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.db = db;
  }

  async claim(
    key: SettlementKey,
    fingerprint: RequestFingerprint,
    owner: string,
    ttlMs: number,
    details: ClaimDetails = {},
  ): Promise<Claim> {
    const expiry = sql<Date>`now() + make_interval(secs => ${ttlMs / 1000})`;
    const caller = details.caller ?? PUBLIC_CALLER;
    const reserve = details.reserveFeeStroops ?? 0n;
    return this.db.transaction().execute(async (trx) => {
      const limits = details.limits ?? [];
      if (limits.length > 0) {
        // Admissions on one network take turns, so the committed fees each one reads include every
        // claim admitted before it, on any replica: the check and the insert are one step.
        await sql`SELECT pg_advisory_xact_lock(${BUDGET_LOCK_ID}, hashtext(${key.network}))`.execute(trx);
        const held = await trx
          .selectFrom("settlements")
          .select("id")
          .where("network", "=", key.network)
          .where("payer", "=", key.payer)
          .where("nonce", "=", key.nonce)
          .executeTakeFirst();
        if (held === undefined) {
          for (const limit of limits) {
            const committed = await committedIn(
              trx,
              key.network,
              limit.since,
              limit.scope === "caller" ? caller : undefined,
            );
            if (committed + reserve > limit.capStroops) throw new ClaimRefusedError(limit);
          }
        }
      }
      const inserted = await trx
        .insertInto("settlements")
        .values({
          id: randomUUID(),
          network: key.network,
          payer: key.payer,
          nonce: key.nonce,
          payload_hash: fingerprint.payloadHash,
          request_hash: fingerprint.requestHash,
          scheme: details.scheme ?? DEFAULT_SCHEME,
          amount: details.amount ?? null,
          caller,
          service_fee_usd: details.serviceFeeUsd ?? "0",
          reserved_fee_stroops: reserve > 0n ? reserve.toString() : null,
          // Written only when there is one: a claim without an id needs no column added since.
          ...(details.attempt === undefined ? {} : { settle_attempt: details.attempt }),
          state: "claimed",
          owner,
          claim_expires_at: expiry,
        })
        .onConflict((conflict) => conflict.columns(["network", "payer", "nonce"]).doNothing())
        .returningAll()
        .executeTakeFirst();
      if (inserted !== undefined) return { kind: "claimed", record: toRecord(inserted) };

      const existing = await trx
        .selectFrom("settlements")
        .selectAll()
        .select(sql<boolean>`claim_expires_at <= now()`.as("stale"))
        .where("network", "=", key.network)
        .where("payer", "=", key.payer)
        .where("nonce", "=", key.nonce)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (!sameRequest(toRecord(existing), fingerprint))
        return { kind: "conflict", record: toRecord(existing) };
      if (existing.state !== "claimed" || !existing.stale)
        return { kind: "existing", record: toRecord(existing) };

      // The request that takes a stale claim over is the one that settles it: its attempt id, or none,
      // is what repeats echo, never that of the request that gave up.
      const taken = await trx
        .updateTable("settlements")
        .set({
          owner,
          claim_expires_at: expiry,
          settle_attempt: details.attempt ?? null,
          updated_at: sql`now()`,
        })
        .where("id", "=", existing.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { kind: "claimed", record: toRecord(taken) };
    });
  }

  async recordEnvelope(id: string, owner: string, envelope: SettlementEnvelope): Promise<void> {
    const result = await this.db
      .updateTable("settlements")
      .set({
        state: "submitted",
        channel: envelope.channel,
        transaction_hash: envelope.transactionHash,
        inner_transaction_hash: envelope.innerTransactionHash,
        envelope_xdr: envelope.envelopeXdr,
        valid_until: envelope.validUntil,
        max_fee_stroops: envelope.maxFeeStroops,
        broadcast_accepted: false,
        sends_in_flight: [FIRST_SEND],
        updated_at: sql`now()`,
      })
      .where("id", "=", id)
      .where("owner", "=", owner)
      .where("state", "=", "claimed")
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) throw new ClaimLostError(id);
  }

  // Sends leave updated_at alone: it times the reconciler's idle window, which its own rebroadcasts
  // must not keep extending.
  async beginSend(id: string, send: string): Promise<void> {
    const result = await sql`
      UPDATE settlements SET sends_in_flight = array_append(sends_in_flight, ${send}::text)
      WHERE id = ${id}`.execute(this.db);
    if (result.numAffectedRows !== 1n) throw new Error(`unknown settlement ${id}`);
  }

  async endSend(id: string, send: string, accepted: boolean): Promise<void> {
    // A record written before sends were tracked (NULL) stays accepted.
    await sql`
      UPDATE settlements
      SET sends_in_flight = array_remove(sends_in_flight, ${send}::text),
          broadcast_accepted = CASE WHEN ${accepted}::boolean THEN true ELSE broadcast_accepted END
      WHERE id = ${id}`.execute(this.db);
  }

  async releaseChannel(id: string): Promise<boolean> {
    // Like sends, it leaves updated_at alone: that times the reconciler's idle window.
    const result = await this.db
      .updateTable("settlements")
      .set({ channel_released: true })
      .where("id", "=", id)
      .where("state", "=", "submitted")
      .where("channel_released", "=", false)
      .executeTakeFirst();
    return result.numUpdatedRows === 1n;
  }

  async finish(
    id: string,
    state: FinalState,
    response: SettleResponse,
    details: FinishDetails = {},
  ): Promise<Finished> {
    let update = this.db
      .updateTable("settlements")
      .set({
        state,
        response: JSON.stringify(response),
        settled_by: details.settledBy ?? "rail402",
        fee_charged_stroops: details.feeChargedStroops?.toString() ?? null,
        updated_at: sql`now()`,
      })
      .where("id", "=", id);
    update =
      details.claimedBy === undefined
        ? update.where("state", "in", ["claimed", "submitted"])
        : update.where("state", "=", "claimed").where("owner", "=", details.claimedBy);
    const updated = await update.returningAll().executeTakeFirst();
    if (updated !== undefined) return { record: toRecord(updated), transitioned: true };
    const current = await this.get(id);
    if (current === undefined) throw new Error(`unknown settlement ${id}`);
    return { record: current, transitioned: false };
  }

  async abandon(id: string, owner: string): Promise<void> {
    await this.db
      .deleteFrom("settlements")
      .where("id", "=", id)
      .where("owner", "=", owner)
      .where("state", "=", "claimed")
      .execute();
  }

  async get(id: string): Promise<SettlementRecord | undefined> {
    const row = await this.db.selectFrom("settlements").selectAll().where("id", "=", id).executeTakeFirst();
    return row === undefined ? undefined : toRecord(row);
  }

  async find(key: SettlementKey): Promise<SettlementRecord | undefined> {
    const row = await this.db
      .selectFrom("settlements")
      .selectAll()
      .where("network", "=", key.network)
      .where("payer", "=", key.payer)
      .where("nonce", "=", key.nonce)
      .executeTakeFirst();
    return row === undefined ? undefined : toRecord(row);
  }

  async countByState(network: string, since: Date): Promise<Record<SettlementState, number>> {
    const rows = await this.db
      .selectFrom("settlements")
      .select(["state", sql<string>`count(*)`.as("count")])
      .where("network", "=", network)
      .where("created_at", ">=", since)
      .groupBy("state")
      .execute();
    const counts = emptyStateCounts();
    for (const row of rows) counts[row.state] = Number(row.count);
    return counts;
  }

  async committedFeesSince(network: string, since: Date, caller?: string): Promise<bigint> {
    return committedIn(this.db, network, since, caller);
  }

  async usageSince(caller: string | undefined, since: Date, until?: Date): Promise<CallerUsage[]> {
    let query = this.db
      .selectFrom("settlements")
      .select([
        "caller",
        "network",
        sql<string>`to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')`.as("day"),
        sql<string>`count(*) FILTER (WHERE state = 'succeeded' AND coalesce(settled_by, 'rail402') = 'rail402')`.as(
          "succeeded",
        ),
        sql<string>`coalesce(sum(fee_charged_stroops), 0)`.as("fees"),
        sql<string>`coalesce(sum(service_fee_usd) FILTER (WHERE state = 'succeeded' AND coalesce(settled_by, 'rail402') = 'rail402'), 0)`.as(
          "usd",
        ),
      ])
      .where("created_at", ">=", since);
    if (until !== undefined) query = query.where("created_at", "<", until);
    if (caller !== undefined) query = query.where("caller", "=", caller);
    const rows = await query.groupBy(["caller", "network", "day"]).orderBy("day").execute();
    return rows.map((row) => ({
      caller: row.caller,
      network: row.network,
      day: row.day,
      succeeded: Number(row.succeeded),
      sponsoredFeeStroops: BigInt(row.fees),
      serviceFeeUsd: addUsd([row.usd]),
    }));
  }

  async failuresSince(network: string, payer: string, since: Date): Promise<number> {
    const row = await this.db
      .selectFrom("settlements")
      .select(sql<string>`count(*)`.as("count"))
      .where("network", "=", network)
      .where("payer", "=", payer)
      .where("state", "=", "failed")
      // An included failure always charged a fee; a refused submission is finished with 0.
      .where("fee_charged_stroops", ">", "0")
      .where("updated_at", ">=", since)
      .executeTakeFirstOrThrow();
    return Number(row.count);
  }

  /** For the newest row of settlement_rewinds, the ledger recorded for `network`, without recording one. */
  async rewindAnchor(network: string): Promise<number | null | undefined> {
    const { rows } = await sql<{ ledger: string | null }>`
      SELECT l.ledger::text AS ledger
      FROM (SELECT max(id) AS id FROM settlement_rewinds) r
      LEFT JOIN settlement_rewind_ledgers l ON l.rewind_id = r.id AND l.network = ${network}
      WHERE r.id IS NOT NULL`.execute(this.db);
    const latest = rows[0];
    if (latest === undefined) return undefined;
    return latest.ledger === null ? null : Number(latest.ledger);
  }

  /**
   * For the newest row of settlement_rewinds (every restore writes one, see restore-dump.sh), the ledger
   * recorded for `network`, recording `ledger` first when there is none, and in place of one more than
   * `restartedBelow` above it (a network reset). Replicas that ask at the same moment agree on the one row
   * the primary key admits, and a replaced ledger is replaced only once.
   */
  async rewindLedger(network: string, ledger: number, restartedBelow?: number): Promise<number | undefined> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { rows } = await sql<{ id: string; ledger: string | null }>`
        SELECT r.id::text AS id, l.ledger::text AS ledger
        FROM (SELECT max(id) AS id FROM settlement_rewinds) r
        LEFT JOIN settlement_rewind_ledgers l ON l.rewind_id = r.id AND l.network = ${network}
        WHERE r.id IS NOT NULL`.execute(this.db);
      const latest = rows[0];
      if (latest === undefined) return undefined;
      if (latest.ledger === null) {
        await sql`
          INSERT INTO settlement_rewind_ledgers (rewind_id, network, ledger)
          VALUES (${latest.id}, ${network}, ${ledger})
          ON CONFLICT (rewind_id, network) DO NOTHING`.execute(this.db);
        continue;
      }
      const recorded = Number(latest.ledger);
      if (restartedBelow === undefined || recorded <= ledger + restartedBelow) return recorded;
      await sql`
        UPDATE settlement_rewind_ledgers SET ledger = ${ledger}
        WHERE rewind_id = ${latest.id} AND network = ${network} AND ledger = ${latest.ledger}`.execute(
        this.db,
      );
    }
    // Restores kept arriving between the reads: hold from the ledger read now, the latest possible start.
    return ledger;
  }

  async recordSponsorSpend(network: string, kind: string, feeStroops: bigint): Promise<void> {
    await this.db
      .insertInto("sponsor_spend")
      .values({ network, kind, fee_stroops: feeStroops.toString() })
      .execute();
  }

  async sponsorSpendSince(network: string, since: Date, kind?: string): Promise<bigint> {
    return spendIn(this.db, network, since, kind);
  }

  async reserveSponsorSpend(
    network: string,
    kind: string,
    maxFeeStroops: bigint,
    limits: readonly SpendLimit[],
  ): Promise<string> {
    return this.db.transaction().execute(async (trx) => {
      // The same lock as settlement claims: spend and claims are admitted one at a time per network.
      await sql`SELECT pg_advisory_xact_lock(${BUDGET_LOCK_ID}, hashtext(${network}))`.execute(trx);
      for (const limit of limits) {
        const committed =
          limit.scope === "network"
            ? await committedIn(trx, network, limit.since, undefined)
            : await spendIn(trx, network, limit.since, kind);
        if (committed + maxFeeStroops > limit.capStroops) throw new SpendRefusedError(limit, committed);
      }
      const row = await trx
        .insertInto("sponsor_spend")
        .values({ network, kind, fee_stroops: maxFeeStroops.toString() })
        .returning("id")
        .executeTakeFirstOrThrow();
      return row.id;
    });
  }

  async settleSponsorSpend(id: string, feeStroops: bigint): Promise<void> {
    if (!/^\d{1,19}$/.test(id)) return;
    await this.db
      .updateTable("sponsor_spend")
      .set({ fee_stroops: feeStroops.toString() })
      .where("id", "=", id)
      .execute();
  }

  async unfinished(network: string, options: UnfinishedOptions = {}): Promise<SettlementRecord[]> {
    let query = this.db
      .selectFrom("settlements")
      .selectAll()
      .where("network", "=", network)
      .where("state", "=", "submitted");
    const idleForMs = options.idleForMs ?? 0;
    if (idleForMs > 0) {
      // The database's clock, shared by every replica, decides how long a record has been idle.
      query = query.where("updated_at", "<=", sql<Date>`now() - make_interval(secs => ${idleForMs / 1_000})`);
    }
    const rows = await query.orderBy("updated_at").execute();
    return rows.map(toRecord);
  }
}

/** Lock namespace of fee admissions (with the network's hash as the second key). */
const BUDGET_LOCK_ID = 402_402_002;

/**
 * Fees committed on `network` since `since`; with `caller`, only that caller's settlements. A claim
 * counts its reservation and an unfinished envelope its maximum fee. A finished settlement counts what
 * was charged when that is known, nothing when it expired (never included, so never charged), and its
 * maximum fee otherwise. A submission the network refused is finished with a charge of 0, so payloads
 * that can never land stop holding budget once they are finished.
 */
async function committedIn(
  db: Kysely<Database>,
  network: string,
  since: Date,
  caller: string | undefined,
): Promise<bigint> {
  let query = db
    .selectFrom("settlements")
    .select(
      sql<string | null>`sum(CASE
        WHEN state IN ('claimed', 'submitted') THEN coalesce(max_fee_stroops, reserved_fee_stroops)
        WHEN fee_charged_stroops IS NOT NULL THEN fee_charged_stroops
        WHEN state = 'expired' THEN 0
        ELSE coalesce(max_fee_stroops, reserved_fee_stroops)
      END)`.as("total"),
    )
    .where("network", "=", network)
    .where("created_at", ">=", since);
  if (caller !== undefined) query = query.where("caller", "=", caller);
  const row = await query.executeTakeFirstOrThrow();
  const settlements = BigInt(row.total ?? "0");
  // What the sponsor paid outside settlements counts toward the network, not toward any caller.
  return caller === undefined ? settlements + (await spendIn(db, network, since)) : settlements;
}

async function spendIn(db: Kysely<Database>, network: string, since: Date, kind?: string): Promise<bigint> {
  let query = db
    .selectFrom("sponsor_spend")
    .select(sql<string | null>`sum(fee_stroops)`.as("total"))
    .where("network", "=", network)
    .where("created_at", ">=", since);
  if (kind !== undefined) query = query.where("kind", "=", kind);
  const row = await query.executeTakeFirstOrThrow();
  return BigInt(row.total ?? "0");
}

function toRecord(row: Selectable<SettlementsTable>): SettlementRecord {
  return {
    id: row.id,
    key: { network: row.network, payer: row.payer, nonce: row.nonce },
    caller: row.caller,
    serviceFeeUsd: addUsd([row.service_fee_usd]),
    scheme: row.scheme,
    ...(row.amount === null ? {} : { amount: row.amount }),
    payloadHash: row.payload_hash,
    state: row.state,
    owner: row.owner,
    claimExpiresAt: new Date(row.claim_expires_at).getTime(),
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
    ...(row.channel === null ? {} : { channel: row.channel }),
    ...(row.transaction_hash === null ? {} : { transactionHash: row.transaction_hash }),
    ...(row.inner_transaction_hash === null ? {} : { innerTransactionHash: row.inner_transaction_hash }),
    ...(row.envelope_xdr === null ? {} : { envelopeXdr: row.envelope_xdr }),
    ...(row.valid_until === null ? {} : { validUntil: Number(row.valid_until) }),
    ...(row.max_fee_stroops === null ? {} : { maxFeeStroops: row.max_fee_stroops }),
    ...(row.response === null ? {} : { response: row.response }),
    ...(row.request_hash === null ? {} : { requestHash: row.request_hash }),
    ...(row.fee_charged_stroops === null ? {} : { feeChargedStroops: row.fee_charged_stroops }),
    ...(row.settled_by === null ? {} : { settledBy: row.settled_by }),
    ...(row.broadcast_accepted === null ? {} : { broadcastAccepted: row.broadcast_accepted }),
    sendsInFlight: row.sends_in_flight,
    ...(row.settle_attempt === null ? {} : { attempt: row.settle_attempt }),
    ...(row.channel_released ? { channelReleased: true } : {}),
  };
}
