/**
 * The committed role templates, applied to a scratch cluster setup: the reader can only read, neither
 * Explorer role can reach the facilitator's database, and the startup checks catch a wrong role.
 */
import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "@rail402.dev/store-postgres";
import { EXPLORER_MIGRATIONS, createExplorerDatabase } from "../src/db.ts";
import { migrateExplorer } from "../src/migrate.ts";
import { ExplorerRoleError, assertReaderRole, assertWriterRole } from "../src/roles.ts";
import { admin, statements, template, testNames, urlFor } from "./database.ts";

const names = testNames("roles");
const DATABASE = names.database;
const FACILITATOR = names.facilitator_database;
const password = randomBytes(12).toString("hex");
const user = (name: string) => ({ name, password });
let applied: string[] = [];

async function cleanup(): Promise<void> {
  await admin(async (client) => {
    await client.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    await client.query(`DROP DATABASE IF EXISTS ${FACILITATOR} WITH (FORCE)`);
    for (const role of [names.reader, names.writer, names.owner])
      await client.query(`DROP ROLE IF EXISTS ${role}`);
  });
}

beforeAll(async () => {
  await cleanup();
  await admin(async (client) => {
    await client.query(`CREATE DATABASE ${FACILITATOR}`);
    for (const statement of statements(template("roles.sql", names))) await client.query(statement);
    for (const role of [names.owner, names.writer, names.reader]) {
      await client.query(`ALTER ROLE ${role} PASSWORD '${password}'`);
    }
  });
  // The one-shot migrate role a deploy runs before the indexers start.
  applied = await migrateExplorer({ EXPLORER_MIGRATION_DATABASE_URL: urlFor(DATABASE, user(names.owner)) });
  await admin(async (client) => {
    await client.query(`SET ROLE ${names.owner}`);
    for (const statement of statements(template("grants.sql", names))) await client.query(statement);
  }, DATABASE);
});

afterAll(cleanup);

const connect = (name: string) => createExplorerDatabase({ connectionString: urlFor(DATABASE, user(name)) });

describe("Explorer database roles", () => {
  it("migrates as the owner in a one-shot step, and needs the owner's URL to do so", async () => {
    expect(applied.length).toBeGreaterThan(0);
    const owner = createExplorerDatabase({ connectionString: urlFor(DATABASE, user(names.owner)) });
    try {
      expect(await migrate(owner, EXPLORER_MIGRATIONS)).toEqual([]);
    } finally {
      await owner.destroy();
    }
    await expect(migrateExplorer({})).rejects.toMatchObject({ code: "config_database_missing" });
  });

  it("the reader role cannot write or read the facilitator database", async () => {
    const reader = connect(names.reader);
    try {
      await expect(assertReaderRole(reader, { facilitatorDatabase: FACILITATOR })).resolves.toBeUndefined();
      await expect(reader.selectFrom("settlements").select("tx_hash").execute()).resolves.toEqual([]);
      await expect(
        reader
          .insertInto("ledger_exclusions")
          .values({
            network: "stellar:testnet",
            epoch: "e",
            ledger: 1,
            reason: "malformed",
            count: 1,
          })
          .execute(),
      ).rejects.toThrow(/read-only transaction|permission denied/);
    } finally {
      await reader.destroy();
    }
    const client = new pg.Client({ connectionString: urlFor(FACILITATOR, user(names.reader)) });
    await expect(client.connect()).rejects.toThrow(/permission denied/);
  });

  it("the writer role writes the Explorer tables but cannot reach the facilitator database", async () => {
    const writer = connect(names.writer);
    try {
      await expect(assertWriterRole(writer, { facilitatorDatabase: FACILITATOR })).resolves.toBeUndefined();
      await writer
        .insertInto("ledger_exclusions")
        .values({ network: "stellar:testnet", epoch: "e", ledger: 1, reason: "malformed", count: 1 })
        .execute();
      await writer.deleteFrom("ledger_exclusions").execute();
      await expect(assertReaderRole(writer)).rejects.toBeInstanceOf(ExplorerRoleError);
    } finally {
      await writer.destroy();
    }
    const client = new pg.Client({ connectionString: urlFor(FACILITATOR, user(names.writer)) });
    await expect(client.connect()).rejects.toThrow(/permission denied/);
  });

  it("keeps the migration log out of the writer's reach", async () => {
    const writer = connect(names.writer);
    try {
      await expect(sql`DELETE FROM schema_migrations`.execute(writer)).rejects.toThrow(/permission denied/);
      await expect(sql`SELECT count(*) FROM schema_migrations`.execute(writer)).resolves.toBeDefined();
    } finally {
      await writer.destroy();
    }
    // A writer granted the migration log is refused at startup.
    await admin(async (client) => {
      await client.query(`GRANT DELETE ON schema_migrations TO ${names.writer}`);
    }, DATABASE);
    const granted = connect(names.writer);
    try {
      const error = await assertWriterRole(granted).catch((caught: unknown) => caught);
      expect((error as ExplorerRoleError).problems).toContain("it can modify schema_migrations");
    } finally {
      await granted.destroy();
      await admin(async (client) => {
        await client.query(`REVOKE DELETE ON schema_migrations FROM ${names.writer}`);
      }, DATABASE);
    }
  });

  it("cancels a reader statement that outlives the timeout, even after SET statement_timeout = 0", async () => {
    const reader = createExplorerDatabase({
      connectionString: urlFor(DATABASE, user(names.reader)),
      maxConnections: 1,
      statementTimeoutMs: 300,
    });
    try {
      await sql`SET statement_timeout = 0`.execute(reader);
      const started = Date.now();
      const error = await sql`SELECT pg_sleep(5)`.execute(reader).catch((caught: unknown) => caught);
      expect((error as { code?: string }).code).toBe("57014");
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      await reader.destroy();
    }
  });

  it("refuses to run as a superuser", async () => {
    const superuser = createExplorerDatabase({ connectionString: urlFor(DATABASE) });
    try {
      const error = await assertWriterRole(superuser).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ExplorerRoleError);
      expect((error as ExplorerRoleError).problems).toContain("it is a superuser");
    } finally {
      await superuser.destroy();
    }
  });
});
