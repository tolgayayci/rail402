/**
 * The service's database checks with pubnet enabled, against roles set up as an operator would
 * (docker compose up -d postgres; the test user must be allowed to create roles). The service's role
 * reads and writes rows only: it never owns the tables, so migrations never run through it.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import { PUBNET } from "@rail402.dev/stellar";
import { createDatabase, type Database } from "@rail402.dev/store-postgres";
import { ConfigError, checkConnectionBudget, prepareDatabase } from "@rail402.dev/service";
import { DATABASE_URL } from "./service-harness.ts";

const suffix = randomBytes(4).toString("hex");
const schema = `dbroles_${suffix}`;
const owner = `rail402_dbowner_${suffix}`;
const app = `rail402_dbapp_${suffix}`;
const password = randomBytes(12).toString("hex");

function urlFor(role: string): string {
  const url = new URL(DATABASE_URL);
  url.username = role;
  url.password = password;
  url.search = `?options=-c%20search_path%3D${schema}`;
  return url.toString();
}

const pubnet = (url?: string) => ({
  networks: [{ network: PUBNET }] as never,
  migrations: { onStart: true, url },
});

const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: unknown) => (error instanceof ConfigError ? error.code : String(error)),
  );

describe("pubnet database checks", () => {
  let admin: Kysely<Database>;
  let ownerDb: Kysely<Database>;
  let appDb: Kysely<Database>;

  beforeAll(async () => {
    admin = createDatabase({ connectionString: DATABASE_URL, maxConnections: 1 });
    await sql`CREATE SCHEMA ${sql.id(schema)}`.execute(admin);
    for (const statement of [
      sql`CREATE ROLE ${sql.id(owner)} LOGIN PASSWORD ${sql.lit(password)}`,
      sql`CREATE ROLE ${sql.id(app)} LOGIN PASSWORD ${sql.lit(password)}`,
      sql`GRANT USAGE, CREATE ON SCHEMA ${sql.id(schema)} TO ${sql.id(owner)}`,
      sql`GRANT USAGE ON SCHEMA ${sql.id(schema)} TO ${sql.id(app)}`,
      sql`ALTER DEFAULT PRIVILEGES FOR ROLE ${sql.id(owner)} IN SCHEMA ${sql.id(schema)} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${sql.id(app)}`,
      sql`ALTER DEFAULT PRIVILEGES FOR ROLE ${sql.id(owner)} IN SCHEMA ${sql.id(schema)} GRANT USAGE, SELECT ON SEQUENCES TO ${sql.id(app)}`,
    ]) {
      await statement.execute(admin);
    }
    ownerDb = createDatabase({ connectionString: urlFor(owner), maxConnections: 1 });
    appDb = createDatabase({ connectionString: urlFor(app), maxConnections: 1 });
  });

  afterAll(async () => {
    await appDb.destroy();
    await ownerDb.destroy();
    await sql`DROP SCHEMA IF EXISTS ${sql.id(schema)} CASCADE`.execute(admin);
    for (const role of [app, owner]) {
      await sql`DROP OWNED BY ${sql.id(role)}`.execute(admin);
      await sql`DROP ROLE IF EXISTS ${sql.id(role)}`.execute(admin);
    }
    await admin.destroy();
  });

  it("lets the preflight expect pending migrations, but never skips the role check", async () => {
    // A deploy that runs the migrate command next: the schema is behind, the role is still checked.
    const strict = { apply: false } as const;
    const pendingOk = { apply: false, pendingOk: true } as const;
    expect(await codeOf(prepareDatabase(appDb, pubnet(), strict))).toBe(
      "config_pubnet_migration_role_missing",
    );
    expect(await codeOf(prepareDatabase(appDb, pubnet(), pendingOk))).toBe("ok");
    const off = { networks: [{ network: PUBNET }] as never, migrations: { onStart: false, url: undefined } };
    expect(await codeOf(prepareDatabase(appDb, off, strict))).toBe("config_schema_outdated");
    expect(await codeOf(prepareDatabase(appDb, off, pendingOk))).toBe("ok");
    // pendingOk never applies anything, and means nothing when applying.
    expect(await codeOf(prepareDatabase(appDb, pubnet(), { apply: true, pendingOk: true }))).toBe(
      "config_pubnet_migration_role_missing",
    );
    // A role that owns a table is refused even while migrations are pending.
    await sql`CREATE TABLE ${sql.id(schema)}.owned_probe (id int)`.execute(ownerDb);
    try {
      expect(await codeOf(prepareDatabase(ownerDb, pubnet(), pendingOk))).toBe("config_database_superuser");
    } finally {
      await sql`DROP TABLE ${sql.id(schema)}.owned_probe`.execute(ownerDb);
    }
  });

  it("never migrates through the service's role, and refuses a role that owns the tables", async () => {
    // Migrating as the service's role would make it the tables' owner.
    expect(await codeOf(prepareDatabase(appDb, pubnet(), { apply: true }))).toBe(
      "config_pubnet_migration_role_missing",
    );
    // Through the schema owner's connection the migrations apply, and the service's role passes.
    const applied = await prepareDatabase(appDb, pubnet(urlFor(owner)), { apply: true });
    expect(applied).toContain("0001_settlement.sql");
    expect(await codeOf(prepareDatabase(appDb, pubnet(), { apply: true }))).toBe("ok");
    // The owner as the service's role is refused: it could alter or drop every table.
    expect(await codeOf(prepareDatabase(ownerDb, pubnet(), { apply: true }))).toBe(
      "config_database_superuser",
    );
  });

  it("refuses pubnet a role whose connection limit cannot hold one process's pools", async () => {
    // Testnet and pubnet with the Bazaar: shared 10, readiness 1, pubnet 5, two discovery pools of 5 and
    // the search index's 2.
    const both = {
      store: { kind: "postgres" },
      networks: [{ network: "stellar:testnet" }, { network: PUBNET }],
      bazaar: { enabled: true },
      discovery: { database: { poolSize: 5 } },
    } as never;
    const limit = async (value: number) => {
      await sql`ALTER ROLE ${sql.id(app)} CONNECTION LIMIT ${sql.raw(String(value))}`.execute(admin);
    };
    try {
      // Two replicas' pools and room for check-config and the CLI.
      await limit(66);
      expect(await checkConnectionBudget(appDb, both)).toEqual({
        connectionLimit: 66,
        perProcess: 28,
        replicas: 2,
      });
      // Anonymous load could hold every slot pubnet's pool and the readiness connection need.
      await limit(25);
      expect(await codeOf(checkConnectionBudget(appDb, both))).toBe("config_database_connections_low");
      // Testnet alone starts, and its log says the limit holds no whole process.
      const testnet = { ...(both as object), networks: [{ network: "stellar:testnet" }] } as never;
      expect(await checkConnectionBudget(appDb, testnet)).toMatchObject({ perProcess: 18, replicas: 1 });
      await limit(10);
      expect(await checkConnectionBudget(appDb, testnet)).toMatchObject({ replicas: 0 });
      // Without a role limit, the server's own limit, less its reserved slots, is what the role may hold.
      await limit(-1);
      const { rows } = await sql<{ left: number }>`
        SELECT current_setting('max_connections')::int
             - current_setting('superuser_reserved_connections')::int
             - coalesce(current_setting('reserved_connections', true), '0')::int AS left`.execute(admin);
      expect((await checkConnectionBudget(appDb, both))?.connectionLimit).toBe(rows[0]?.left);
    } finally {
      await limit(-1);
    }
  });
});
