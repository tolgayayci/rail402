import { randomUUID } from "node:crypto";
import { sql, type Kysely, type Selectable } from "kysely";
import type { SettleResponse } from "@x402/core/types";
import {
  ClaimLostError,
  type Claim,
  type FinalState,
  type Finished,
  type SettlementEnvelope,
  type SettlementKey,
  type SettlementLedger,
  type SettlementRecord,
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

  async claim(key: SettlementKey, payloadHash: string, owner: string, ttlMs: number): Promise<Claim> {
    const expiry = sql<Date>`now() + make_interval(secs => ${ttlMs / 1000})`;
    return this.db.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto("settlements")
        .values({
          id: randomUUID(),
          network: key.network,
          payer: key.payer,
          nonce: key.nonce,
          payload_hash: payloadHash,
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
      if (existing.payload_hash !== payloadHash) return { kind: "conflict", record: toRecord(existing) };
      if (existing.state !== "claimed" || !existing.stale)
        return { kind: "existing", record: toRecord(existing) };

      const taken = await trx
        .updateTable("settlements")
        .set({ owner, claim_expires_at: expiry, updated_at: sql`now()` })
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
        updated_at: sql`now()`,
      })
      .where("id", "=", id)
      .where("owner", "=", owner)
      .where("state", "=", "claimed")
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) throw new ClaimLostError(id);
  }

  async finish(id: string, state: FinalState, response: SettleResponse): Promise<Finished> {
    const updated = await this.db
      .updateTable("settlements")
      .set({ state, response: JSON.stringify(response), updated_at: sql`now()` })
      .where("id", "=", id)
      .where("state", "in", ["claimed", "submitted"])
      .returningAll()
      .executeTakeFirst();
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

  async committedFeesSince(network: string, since: Date): Promise<bigint> {
    const row = await this.db
      .selectFrom("settlements")
      .select(sql<string | null>`sum(max_fee_stroops)`.as("total"))
      .where("network", "=", network)
      .where("created_at", ">=", since)
      .where("max_fee_stroops", "is not", null)
      .executeTakeFirstOrThrow();
    return BigInt(row.total ?? "0");
  }

  async unfinished(network: string): Promise<SettlementRecord[]> {
    const rows = await this.db
      .selectFrom("settlements")
      .selectAll()
      .where("network", "=", network)
      .where("state", "=", "submitted")
      .orderBy("updated_at")
      .execute();
    return rows.map(toRecord);
  }
}

function toRecord(row: Selectable<SettlementsTable>): SettlementRecord {
  return {
    id: row.id,
    key: { network: row.network, payer: row.payer, nonce: row.nonce },
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
  };
}
