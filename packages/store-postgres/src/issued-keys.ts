import { sql, type Kysely } from "kysely";
import type { Database } from "./database.ts";

/** A key issued to a signed-in GitHub account, as stored: its digest, never the key. */
export interface IssuedKeyRow {
  readonly id: string;
  readonly githubUserId: string;
  readonly githubLogin: string;
  /** SHA-256 of the key, 64 lower-case hex characters. */
  readonly sha256: string;
  readonly networks: readonly string[];
  readonly requestsPerMinute: number;
  readonly sponsorBudgetStroopsPerHour: bigint;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  /** How many keys the account has been issued, the current one included. */
  readonly issuedCount: number;
  readonly revoked: boolean;
}

/** A key to issue: the account, the new key's digest and its limits. */
export interface IssueRequest {
  readonly id: string;
  readonly githubUserId: string;
  readonly githubLogin: string;
  readonly sha256: string;
  readonly networks: readonly string[];
  readonly requestsPerMinute: number;
  readonly sponsorBudgetStroopsPerHour: bigint;
  readonly lifetimeDays: number;
}

/** The limits issuing applies across replicas. */
export interface IssueLimits {
  /** New keys per hour across the service, replacements included. */
  readonly perHour: number;
  /** Shortest time between two keys of one account, in seconds. */
  readonly reissueSeconds: number;
}

export type IssueOutcome =
  | { readonly kind: "issued"; readonly row: IssuedKeyRow }
  /** The account had a key issued too recently; it may ask again after `retryAfterSeconds`. */
  | { readonly kind: "too_soon"; readonly retryAfterSeconds: number }
  /** The service issued `perHour` keys in the last hour. */
  | { readonly kind: "cap_reached" }
  /** The operator revoked the account's key; it is not issued another. */
  | { readonly kind: "revoked" };

/** Rows `list` returns at most: the newest unexpired keys. */
export const ISSUED_KEYS_LIST_MAX = 10_000;

/** Serialises issuing across replicas, so the hourly cap and the per-account interval hold. */
const ISSUE_LOCK = 0x72_34_30_32_6b_65_79n; // "r402key"

/**
 * Keys issued to signed-in GitHub accounts. One row per account: issuing again replaces the digest, so
 * the replaced key stops working everywhere once replicas reload. A revoked row stays and blocks the
 * account from being issued another key until the operator restores it.
 */
export class PostgresIssuedKeys {
  private readonly db: Kysely<Database>;

  constructor(db: Kysely<Database>) {
    this.db = db;
  }

  /** The unexpired keys, revoked ones included, newest first. */
  async list(now: Date = new Date()): Promise<IssuedKeyRow[]> {
    const rows = await this.db
      .selectFrom("issued_access_keys")
      .selectAll()
      .where("expires_at", ">", now)
      .orderBy("created_at", "desc")
      .limit(ISSUED_KEYS_LIST_MAX)
      .execute();
    return rows.map(toRow);
  }

  /** Every key, expired ones included, newest first: for the operator. */
  async all(): Promise<IssuedKeyRow[]> {
    const rows = await this.db
      .selectFrom("issued_access_keys")
      .selectAll()
      .orderBy("created_at", "desc")
      .execute();
    return rows.map(toRow);
  }

  /**
   * Issues a key to an account, replacing the one it has, unless the account is revoked, was issued a
   * key less than `reissueSeconds` ago, or the service issued `perHour` keys in the last hour.
   */
  async issue(request: IssueRequest, limits: IssueLimits): Promise<IssueOutcome> {
    return this.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(${ISSUE_LOCK.toString()}::bigint)`.execute(trx);
      const existing = await trx
        .selectFrom("issued_access_keys")
        .select(["revoked", "created_at"])
        .select(sql<number>`extract(epoch FROM now() - created_at)::float8`.as("age_seconds"))
        .where("github_user_id", "=", request.githubUserId)
        .executeTakeFirst();
      if (existing?.revoked === true) return { kind: "revoked" };
      if (existing !== undefined && existing.age_seconds < limits.reissueSeconds) {
        return {
          kind: "too_soon",
          retryAfterSeconds: Math.max(1, Math.ceil(limits.reissueSeconds - existing.age_seconds)),
        };
      }
      const recent = await trx
        .selectFrom("issued_access_keys")
        .select((eb) => eb.fn.countAll<string>().as("count"))
        .where("created_at", ">", sql<Date>`now() - interval '1 hour'`)
        .executeTakeFirstOrThrow();
      if (Number(recent.count) >= limits.perHour) return { kind: "cap_reached" };
      const row = await trx
        .insertInto("issued_access_keys")
        .values({
          id: request.id,
          github_user_id: request.githubUserId,
          github_login: request.githubLogin,
          sha256: request.sha256,
          networks: [...request.networks],
          requests_per_minute: request.requestsPerMinute,
          sponsor_budget_stroops_per_hour: request.sponsorBudgetStroopsPerHour.toString(),
          created_at: sql<Date>`now()`,
          expires_at: sql<Date>`now() + make_interval(days => ${request.lifetimeDays})`,
        })
        .onConflict((conflict) =>
          conflict.column("github_user_id").doUpdateSet((eb) => ({
            github_login: eb.ref("excluded.github_login"),
            sha256: eb.ref("excluded.sha256"),
            networks: eb.ref("excluded.networks"),
            requests_per_minute: eb.ref("excluded.requests_per_minute"),
            sponsor_budget_stroops_per_hour: eb.ref("excluded.sponsor_budget_stroops_per_hour"),
            created_at: eb.ref("excluded.created_at"),
            expires_at: eb.ref("excluded.expires_at"),
            issued_count: sql<number>`issued_access_keys.issued_count + 1`,
          })),
        )
        .returningAll()
        .executeTakeFirstOrThrow();
      return { kind: "issued", row: toRow(row) };
    });
  }

  /** Revokes (or restores) an account's key by key id or GitHub login. Returns whether a row changed. */
  async setRevoked(who: string, revoked: boolean): Promise<boolean> {
    const result = await this.db
      .updateTable("issued_access_keys")
      .set({ revoked })
      .where((eb) => eb.or([eb("id", "=", who), eb(sql`lower(github_login)`, "=", who.toLowerCase())]))
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }
}

function toRow(row: {
  id: string;
  github_user_id: string;
  github_login: string;
  sha256: string;
  networks: string[];
  requests_per_minute: number;
  sponsor_budget_stroops_per_hour: string;
  created_at: Date;
  expires_at: Date;
  issued_count: number;
  revoked: boolean;
}): IssuedKeyRow {
  return {
    id: row.id,
    githubUserId: row.github_user_id,
    githubLogin: row.github_login,
    sha256: row.sha256,
    networks: row.networks,
    requestsPerMinute: row.requests_per_minute,
    sponsorBudgetStroopsPerHour: BigInt(row.sponsor_budget_stroops_per_hour),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    issuedCount: row.issued_count,
    revoked: row.revoked,
  };
}
