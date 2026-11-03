/**
 * The split between the role that owns the schema (migrations) and the role the service runs as
 * (rows only), as an operator sets it up. Needs Postgres (docker compose up -d postgres) and a test
 * user that may create roles.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import {
  PostgresChannelPool,
  PostgresRateLimiter,
  PostgresSettlementLedger,
  PostgresTaskLock,
  PostgresUsageMeter,
  RuntimeRoleError,
  assertRuntimeRole,
  createDatabase,
  migrate,
  pendingMigrations,
  roleCapabilities,
  type Database,
} from "@rail402.dev/store-postgres";

const URL_BASE =
  process.env["RAIL402_TEST_DATABASE_URL"] ?? "postgres://rail402:rail402@localhost:5432/rail402";
const suffix = randomBytes(4).toString("hex");
const schema = `roles_${suffix}`;
const owner = `rail402_owner_${suffix}`;
const app = `rail402_app_${suffix}`;
/** A row-only role that is also a member of a privileged role, as a careless grant leaves it. */
const member = `rail402_member_${suffix}`;
const password = randomBytes(12).toString("hex");

function urlFor(role: string): string {
  const url = new URL(URL_BASE);
  url.username = role;
  url.password = password;
  return url.toString();
}

describe("database roles", () => {
  let admin: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  let appDb: Kysely<Database>;
  let memberDb: Kysely<Database>;

  beforeAll(async () => {
    admin = createDatabase({ connectionString: URL_BASE, maxConnections: 1 });
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
    // What an operator's bootstrap does (see docs/operations.md, "Database roles"); never a migration.
    for (const statement of [
      sql`CREATE ROLE ${sql.id(owner)} LOGIN PASSWORD ${sql.lit(password)}`,
      sql`CREATE ROLE ${sql.id(app)} LOGIN PASSWORD ${sql.lit(password)}`,
      sql`CREATE ROLE ${sql.id(member)} LOGIN PASSWORD ${sql.lit(password)}`,
      sql`GRANT USAGE ON SCHEMA ${sql.id(schema)} TO ${sql.id(member)}`,
      sql`GRANT USAGE, CREATE ON SCHEMA ${sql.id(schema)} TO ${sql.id(owner)}`,
      sql`GRANT USAGE ON SCHEMA ${sql.id(schema)} TO ${sql.id(app)}`,
      sql`ALTER DEFAULT PRIVILEGES FOR ROLE ${sql.id(owner)} IN SCHEMA ${sql.id(schema)} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${sql.id(app)}`,
      sql`ALTER DEFAULT PRIVILEGES FOR ROLE ${sql.id(owner)} IN SCHEMA ${sql.id(schema)} GRANT USAGE, SELECT ON SEQUENCES TO ${sql.id(app)}`,
    ]) {
      await statement.execute(admin);
    }
    ownerDb = createDatabase({ connectionString: urlFor(owner), schema, maxConnections: 2 });
    appDb = createDatabase({ connectionString: urlFor(app), schema, maxConnections: 4 });
    memberDb = createDatabase({ connectionString: urlFor(member), schema, maxConnections: 1 });
  });

  afterAll(async () => {
    await appDb.destroy();
    await memberDb.destroy();
    await ownerDb.destroy();
    await sql`DROP SCHEMA IF EXISTS ${sql.id(schema)} CASCADE`.execute(admin);
    for (const role of [member, app, owner]) {
      await sql`DROP OWNED BY ${sql.id(role)}`.execute(admin);
      await sql`DROP ROLE IF EXISTS ${sql.id(role)}`.execute(admin);
    }
    await admin.destroy();
  });

  it("reports every shipped migration as pending on an empty schema", async () => {
    const pending = await pendingMigrations(appDb);
    expect(pending.length).toBeGreaterThan(10);
    expect(pending[0]).toBe("0001_settlement.sql");
  });

  it("refuses to start as a superuser on pubnet", async () => {
    const capabilities = await roleCapabilities(admin);
    expect(capabilities.superuser || capabilities.createRole).toBe(true);
    await expect(assertRuntimeRole(admin)).rejects.toBeInstanceOf(RuntimeRoleError);
    await expect(assertRuntimeRole(appDb)).resolves.toBeUndefined();
    await expect(assertRuntimeRole(ownerDb)).resolves.toBeUndefined();
  });

  it("migrates as the owner, then serves every store as a role without DDL rights", async () => {
    expect((await migrate(ownerDb)).length).toBeGreaterThan(10);
    expect(await pendingMigrations(appDb)).toEqual([]);

    const ledger = new PostgresSettlementLedger(appDb);
    const claim = await ledger.claim(
      { network: "stellar:testnet", payer: "GPAYER", nonce: "1" },
      { payloadHash: "p", requestHash: "r" },
      "owner",
      30_000,
    );
    expect(claim.kind).toBe("claimed");
    await ledger.recordEnvelope(claim.record.id, "owner", {
      channel: "GCHANNEL",
      transactionHash: "a".repeat(64),
      innerTransactionHash: "b".repeat(64),
      envelopeXdr: "AAAA",
      validUntil: 1,
      maxFeeStroops: "1000",
    });
    expect(await ledger.committedFeesSince("stellar:testnet", new Date(Date.now() - 60_000))).toBe(1_000n);
    expect(await new PostgresRateLimiter(appDb, 10).take("n:test|ip:1")).toBe(0);
    await new PostgresUsageMeter(appDb).record({
      subject: "public",
      network: "stellar:testnet",
      operation: "settle",
      outcome: "success",
      asset: "C",
      settledAmount: "1",
    });
    const pool = await PostgresChannelPool.open(appDb, {
      network: "stellar:testnet",
      addresses: ["GCHANNEL"],
    });
    expect(await pool.inUse()).toBe(0);
    expect(await new PostgresTaskLock(appDb).run("roles-test", () => Promise.resolve(1))).toBe(1);
  });

  it("refuses a role that is a member of a privileged role or owns the schema's tables", async () => {
    await expect(assertRuntimeRole(memberDb)).resolves.toBeUndefined();
    // Membership in a role that reaches the server's files is as good as the right itself.
    await sql`GRANT pg_write_server_files TO ${sql.id(member)}`.execute(admin);
    await expect(assertRuntimeRole(memberDb)).rejects.toThrow(/is a member of pg_write_server_files/);
    await sql`REVOKE pg_write_server_files FROM ${sql.id(member)}`.execute(admin);
    // So is membership in the role that owns the tables: it may alter or drop them.
    await sql`GRANT ${sql.id(owner)} TO ${sql.id(member)}`.execute(admin);
    const error = await assertRuntimeRole(memberDb).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RuntimeRoleError);
    expect((error as RuntimeRoleError).capabilities.owned).toContain("settlements");
    expect((error as RuntimeRoleError).message).toMatch(/owns .*DATABASE_MIGRATION_URL/);
    await sql`REVOKE ${sql.id(owner)} FROM ${sql.id(member)}`.execute(admin);
    await expect(assertRuntimeRole(memberDb)).resolves.toBeUndefined();
    // The owner itself, after migrating, owns every table: never a runtime role.
    await expect(assertRuntimeRole(ownerDb)).rejects.toThrow(/owns /);
    await expect(assertRuntimeRole(appDb)).resolves.toBeUndefined();
  });

  it("the runtime role cannot create tables or run server programs", async () => {
    await expect(sql`CREATE TABLE intruder (id int)`.execute(appDb)).rejects.toThrow(/permission denied/);
    await expect(sql`DROP TABLE settlements`.execute(appDb)).rejects.toThrow(
      /must be owner|permission denied/,
    );
    await expect(sql`COPY (SELECT 1) TO PROGRAM 'true'`.execute(appDb)).rejects.toThrow(
      /permission denied|must be superuser|pg_execute_server_program/,
    );
    await expect(sql`CREATE ROLE intruder`.execute(appDb)).rejects.toThrow(/permission denied/);
  });
});
